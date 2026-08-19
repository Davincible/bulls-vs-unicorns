// THE KEEPER'S VIEW OF THE CHAIN — connections, the clock, one fresh read of the whole world, and
// one place transactions are sent from.
//
// It composes rather than reimplements. Every instruction comes from `src/chain/round.ts`, every send
// goes through `src/chain/sendTx.ts` (whose two "SDK SURPRISE" comments are load-bearing and are NOT
// re-derived here), the validator freshness check comes from `scripts/erValidator.ts`, and every
// endpoint passes `assertDevnetUrl`. Nothing about how to talk to this program is invented in
// scripts/keeper/.
//
// THE CLOCK IS PART OF THE CHAIN STATE HERE, and that is the correction this module is most careful
// about. Every branch of the phase machine compares a chain-stamped timestamp against "now", so a
// host clock that disagrees with the chain is not a cosmetic problem — it is a wrong input to every
// decision, and the failure it produces (declaring healthy VRF requests wedged, forever) is
// indistinguishable in the log from the thing it is supposed to detect. `nowSec()` therefore returns
// the chain's clock, measured against this host's at boot and re-measured on an interval. See
// `CLOCK_RESYNC_SECONDS` in config.ts for the trace of what an uncorrected clock does.
//
// READS ARE RETRIED. SENDS ARE NOT. This asymmetry is the one place this module departs from the
// obvious "wrap everything in withRetry", and it is a correctness argument rather than a preference:
// a transaction whose CONFIRMATION times out may still have landed, so a blind retry can double-send
// it. For `enter` that means a house fighter with twice the intended stake — `enter` keyed on
// (wallet, side) TOPS UP an existing fighter rather than failing. The main loop is a strictly better
// retry for sends than any wrapper could be, because it re-reads what the chain says happened before
// it decides what to do next: a send that actually landed shows up as progress and is not repeated,
// and a send that did not shows up as the same pending work and is retried a second later. That is
// the whole reason the loop re-derives everything, and adding send retries here would quietly trade
// it away.

import { Connection, type Keypair, PublicKey } from "@solana/web3.js";
import { ConnectionMagicRouter, DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

import { assertDevnetUrl } from "../../src/devnet-guard.ts";
import { Phase, PROGRAM_ID } from "../../src/chain/constants.ts";
import {
  createProgram,
  type BullsArenaProgram,
  type RawArenaAccount,
  type RawRoundAccount,
  type RawTreasuryAccount,
} from "../../src/chain/program.ts";
import { createBurnerWallet } from "../../src/chain/useSigner.ts";
import { sendTx, type SendRouting, type TransactionBuilder, type TxSigner } from "../../src/chain/sendTx.ts";
import { arenaPda as deriveArenaPda, roundPdaForRoundNo, treasuryPda } from "../../src/chain/round.ts";
import { NO_FRESH_VALIDATOR, pickValidator, routerValidators, type ErValidator } from "../erValidator.ts";

import {
  CLOCK_OFFSET_WARN_SECONDS, CLOCK_RESYNC_SECONDS, READ_RETRY_DELAYS_MS, VALIDATOR_PROBE_TIMEOUT_MS,
} from "./config.ts";
import { BASE_RPC_ENDPOINT, ROUTER_ENDPOINT } from "./endpoints.ts";
import { c, hostNowSeconds, info, ok, sleep, warn } from "./log.ts";

export type { ErValidator };

/** The signature reported for a transaction that was never sent, so a `--dry-run` log is never
 *  mistakable for a real one. */
export const DRY_RUN_SIGNATURE = "(dry-run — not sent)";

export interface SendOutcome {
  signature: string;
  /** False in `--dry-run`. Callers that would otherwise wait on an on-chain effect check this rather
   *  than checking a global, so the dry-run path is visible at the point it changes behaviour. */
  sent: boolean;
}

/** EVERYTHING THE PHASE MACHINE IS ALLOWED TO DECIDE FROM. Produced fresh on every pass of the main
 *  loop; never cached, never merged with a previous one. */
export interface KeeperChainState {
  /** The CHAIN's clock in unix seconds, not this host's — see this file's header. Sampled once per
   *  pass so every comparison within one pass agrees with every other. */
  nowSec: number;
  /** Null when `init_arena` has never run against this program id. */
  arena: RawArenaAccount | null;
  /** `arena.round_counter` — the NEWEST round that has been opened. 0 when none has. The next round
   *  to open is always this plus one, and it is read here rather than remembered. */
  roundCounter: bigint;
  roundPda: PublicKey | null;
  round: RawRoundAccount | null;
  /** Whether the round PDA is owned by the Delegation Program on the base layer.
   *
   *  NULL MEANS "NOT ASKED", not "unknown/false". It is fetched only in the phases where it decides
   *  something — `Lobby` (can anyone enter yet? can `abandon_round`'s CPI work?) and `Settled` (does
   *  `close_round` still have anything to undelegate?). During `Drawing` and `Fight` the round is
   *  delegated by construction, and spending an RPC round-trip per second to re-confirm a fact the
   *  phase already implies is cost with no decision behind it. */
  roundDelegated: boolean | null;
}

export interface ChainClient {
  router: ConnectionMagicRouter;
  base: Connection;
  /** Router-bound. Reads route per account, so a delegated round comes back as the ER sees it. */
  program: BullsArenaProgram;
  /** Base-layer-bound. The arena is never delegated, and a settled round that has come home is here. */
  programBase: BullsArenaProgram;
  arenaPda: PublicKey;
  /** The CHAIN's clock in unix seconds. Everything the phase machine compares must come from here. */
  nowSec(): number;
  /** The measured host-versus-chain offset in seconds, for the boot banner. */
  clockOffsetSeconds(): number;
  readChainState(): Promise<KeeperChainState>;
  /** Any round by number, through the router. Used by the phase machine for the live round and by
   *  the stranded-round sweeper for older ones. */
  fetchRound(roundNo: bigint): Promise<RawRoundAccount | null>;
  /** DOES EACH OF THESE ROUNDS STILL HAVE AN ACCOUNT? One `getMultipleAccountsInfo`, answers in the
   *  order asked, at most `CLOSE_CURSOR_PROBE_BATCH` (100) per call — the JSON-RPC's own ceiling, and
   *  a longer list is REFUSED rather than truncated or silently chunked, because a probe that
   *  quietly dropped its tail would report closed rounds the chain never spoke about. `closeCursor.ts`
   *  owns the chunking and the reason both halves of that rule are written out.
   *
   *  ONE READ FOR A HUNDRED ROUNDS RATHER THAN A HUNDRED READS. `fundHouseBank` and the boot banner
   *  were both rewritten onto this same endpoint after a `getBalance` per item earned
   *  `429 Connection rate limits exceeded` at 48 wallets and killed the process before the HTTP
   *  server bound; this is the third caller and it walks HUNDREDS of accounts, not dozens. See
   *  `closeCursor.ts` for what the per-round version of this cost on the live arena.
   *
   *  EXISTENCE, NOT CONTENTS, AND THE DIFFERENCE IS PAID FOR IN BYTES. `dataSlice` of length zero
   *  asks the RPC to send no account data at all: a `Round` is 3,248 bytes, so a hundred of them
   *  would be a ~325KB reply per read for a question answered entirely by whether the entry is null.
   *  Nothing here decodes, so nothing here needs the runtime IDL either — the same argument
   *  `accountExists` makes against going through Anchor, at a hundred accounts a time.
   *
   *  FROM THE BASE LAYER, like `isDelegated` and for its reason. Existence is a base-layer fact:
   *  `close_round_account` runs there, a delegated round still HAS its account there (owned by the
   *  Delegation Program), and a closed one is gone from there. The router routes per account and
   *  would have to be asked one at a time, which is the whole thing this is replacing. */
  roundsExist(roundNos: readonly bigint[]): Promise<boolean[]>;
  send(builder: TransactionBuilder, signer: TxSigner, label: string, routing?: SendRouting): Promise<SendOutcome>;
  balance(pubkey: PublicKey): Promise<number>;
  /** Does this base-layer account exist at all? Asked of the arena's `Treasury`, which is created
   *  once per arena by `init_treasury` and is a precondition of every sweep.
   *
   *  Deliberately a raw `getAccountInfo` rather than `program.account.treasury.fetchNullable`: the
   *  question is existence, not contents, and going through Anchor's decoder would make it depend on
   *  the runtime IDL carrying a `Treasury` type — so against an IDL that predates the treasury this
   *  would throw where it should simply answer "no". */
  accountExists(pubkey: PublicKey): Promise<boolean>;
  /** The arena's `Treasury`, decoded, or null when there is not one to read. `rounds_swept` held
   *  against `Arena.round_counter` is the gap COST-MODEL §4 names as the thing to watch for the first
   *  day of continuous running.
   *
   *  IT CANNOT REUSE `accountExists` DIRECTLY ABOVE, and the difference is the whole reason both
   *  exist. That one asks EXISTENCE, and answers it with a raw `getAccountInfo` precisely so an IDL
   *  that predates the treasury cannot make it throw. This one needs the CONTENTS, so it has to go
   *  through Anchor's decoder — and therefore has to survive the same case on its own. It answers null
   *  there rather than throwing: a program whose IDL has never heard of a treasury has no
   *  `rounds_swept` to report, and `reclamation.ts` already distinguishes "not read" from "caught up",
   *  so null is a state its report can say out loud. */
  fetchTreasury(): Promise<RawTreasuryAccount | null>;
  isDelegated(roundPda: PublicKey): Promise<boolean>;
  /** The fqdn of the ER validator THIS round is delegated to — required by `close_lobby_and_draw`. */
  roundValidatorFqdn(roundPda: PublicKey): Promise<string>;
  /** What the ROUTER believes about a round's delegation. Slower to go stale than the base-layer
   *  owner, which is why it is the tiebreaker before re-sending `delegate_round`. */
  routerSaysDelegated(roundPda: PublicKey): Promise<boolean>;
  waitForDelegation(roundPda: PublicKey, seconds: number): Promise<boolean>;
  waitForUndelegation(roundPda: PublicKey, seconds: number): Promise<boolean>;
  /** Labels of the transactions a `--dry-run` declined to send, in order. Always empty in a real run.
   *  It exists so a dry run can report what it WOULD have done even when the answer is "nothing" —
   *  a silent pass is the most likely outcome (most passes of a lobby or a hold send nothing at all)
   *  and is indistinguishable from a broken one unless it is stated. */
  dryRunPlan: string[];
}

/** One attempt plus `READ_RETRY_DELAYS_MS.length` retries. Reads only — see this file's header. */
export async function withReadRetry<T>(label: string, read: () => Promise<T>): Promise<T> {
  const attempts = READ_RETRY_DELAYS_MS.length + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await read();
    } catch (e) {
      lastError = e;
      if (attempt < attempts) {
        const waitMs = READ_RETRY_DELAYS_MS[attempt - 1]!;
        warn(`read "${label}" failed (attempt ${attempt}/${attempts}), retrying in ${waitMs}ms: ${e instanceof Error ? e.message : String(e)}`);
        await sleep(waitMs);
      }
    }
  }
  throw lastError;
}

/** Will this ER validator accept a transaction at all?
 *
 *  NOT A GIVEN, and `pickValidator` cannot tell you: it checks whether a validator is serving the
 *  CURRENT bytecode, which is a different question. `devnet-tee.magicblock.app` answers reads happily
 *  and returns HTTP 401 "Missing token query param" on `sendTransaction` (confirmed against all four
 *  routes while writing this), so a keeper that pinned it would delegate every round to a validator it
 *  can never send to — and the failure would surface somewhere confusing, several instructions later,
 *  as an error about the round rather than about the route.
 *
 *  The probe is the one `verify-session-real.mjs`'s `probeValidator` already proved: a deliberately
 *  malformed `sendTransaction` with no params. It can never do anything, and the two outcomes are
 *  unambiguous — HTTP 401 means the endpoint is gated, a JSON-RPC "invalid params" means it is open
 *  for business. Reused rather than reinvented; the only thing new here is layering it on top of
 *  `pickValidator` instead of alongside it.
 *
 *  TIMED OUT, because this runs before the heartbeat exists. An endpoint that accepts the connection
 *  and never answers would hang boot indefinitely with no status file and no log line after "choosing
 *  an ER validator" — a silent hang is the worst possible way for a keeper to fail to start. */
async function acceptsWrites(fqdn: string): Promise<boolean> {
  try {
    // The fqdn came from the ROUTER, which is to say from off this machine. Nothing can happen
    // through this probe — the body is a deliberately malformed `sendTransaction` with no params —
    // but this file's header claims every endpoint passes `assertDevnetUrl`, and a claim that holds
    // only because the payload is harmless is a claim that stops holding when somebody changes the
    // payload. One line makes it true by inspection instead.
    assertDevnetUrl(fqdn, "ER validator");
    const res = await fetch(fqdn, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [] }),
      signal: AbortSignal.timeout(VALIDATOR_PROBE_TIMEOUT_MS),
    });
    return res.status !== 401;
  } catch (e) {
    warn(`    write probe of ${fqdn} failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Choose an ER validator that is BOTH serving the current bytecode AND accepting writes, and say
 *  plainly why each candidate was accepted or rejected.
 *
 *  `pickValidator(null)` answers the freshness half and returns the first fresh validator; the common
 *  case is one call and one write probe. Only when that one is gated does this walk the router's other
 *  routes — and it probes WRITABILITY first there, because that is a single small HTTP request,
 *  whereas each `pickValidator` call re-downloads every validator's cloned program account. Ordering
 *  the cheap test first keeps the fallback from turning boot into a dozen multi-megabyte reads.
 *
 *  Returns null when nothing qualifies. That is an infrastructure fault a keeper cannot work around,
 *  and the caller is expected to print `NO_FRESH_VALIDATOR` and exit non-zero rather than open rounds
 *  nobody can play. */
export async function selectWritableValidator(): Promise<ErValidator | null> {
  // The keeper's OWN base RPC, not the public default. Without a local `target/deploy/bulls_arena.so`
  // — which no container has — `pickValidator` reads the deployed bytecode from the base layer, and an
  // operator who moved to a paid endpoint to escape rate limits should not have boot silently fall
  // back to the endpoint they were escaping. See `referenceBytecode` in erValidator.ts.
  const first = await pickValidator(null, BASE_RPC_ENDPOINT.url, ROUTER_ENDPOINT.url);
  if (!first) return null;
  if (await acceptsWrites(first.fqdn)) {
    ok(`ER validator ${first.fqdn} — current bytecode, writes open`);
    return first;
  }
  warn(`ER validator ${first.fqdn} serves the current bytecode but GATES WRITES (HTTP 401) — looking for another`);

  for (const candidate of await routerValidators(ROUTER_ENDPOINT.url)) {
    if (candidate.identity.equals(first.identity)) continue;
    if (!(await acceptsWrites(candidate.fqdn))) {
      warn(`ER validator ${candidate.fqdn} rejected — writes gated or unreachable`);
      continue;
    }
    try {
      const fresh = await pickValidator(candidate.identity, BASE_RPC_ENDPOINT.url, ROUTER_ENDPOINT.url);
      if (fresh) {
        ok(`ER validator ${fresh.fqdn} — current bytecode, writes open`);
        return fresh;
      }
    } catch {
      warn(`ER validator ${candidate.fqdn} rejected — not serving the current build`);
    }
  }
  return null;
}

export { NO_FRESH_VALIDATOR };

export interface ChainClientOptions {
  /** The arena authority. Used to bind Anchor's provider wallet; every transaction names its own
   *  signer explicitly at send time. */
  operator: Keypair;
  /** When true, `send` logs what it would have done and returns without touching the network. */
  dryRun: boolean;
  /** Aborted on SIGINT/SIGTERM. Every wait in here returns promptly once it fires. */
  stopSignal?: AbortSignal;
}

export async function createChainClient({ operator, dryRun, stopSignal }: ChainClientOptions): Promise<ChainClient> {
  // `endpoints.ts` already asserts both of these at module load — and it is the module that made them
  // env-configurable, so that is where the guard has to be. Repeated here so this file's own contract
  // ("every endpoint through assertDevnetUrl") is true by inspection rather than by knowing what
  // another module did on import. Cheap, and it is the assertion standing between a Fly secret and a
  // mainnet connection.
  assertDevnetUrl(ROUTER_ENDPOINT.url, "Magic Router");
  assertDevnetUrl(BASE_RPC_ENDPOINT.url, "base devnet RPC");

  const router = new ConnectionMagicRouter(ROUTER_ENDPOINT.url, "confirmed");
  const base = new Connection(BASE_RPC_ENDPOINT.url, "confirmed");

  // ONE PROGRAM PER CONNECTION, not one per signer — including for the house wallets' `enter` calls.
  // The provider's wallet is only consulted by Anchor's account resolver to fill accounts a caller
  // left unspecified, and every builder in src/chain/round.ts names all of its accounts (`enter`
  // names arena, round, player, sessionToken and signer, the last two REQUIRED explicitly for the
  // Option<SessionToken> resolver — see MethodsBuilder's doc comment in chain/program.ts). The
  // signature itself is applied by `sendTx` from the keypair it is handed, never by the provider. So
  // six house wallets do not need six Programs, and six Programs would mean six IDL-bound decoders
  // that must be kept in step for no benefit.
  const wallet = createBurnerWallet(operator);
  const program = await createProgram(router, wallet);
  const programBase = await createProgram(base, wallet);
  const arenaPda = deriveArenaPda();
  const dryRunPlan: string[] = [];

  // ---- the clock ------------------------------------------------------------------------------

  let clockOffsetSec = 0;
  let clockMeasuredAtMs = 0;

  /** The chain's own unix timestamp — the same quantity the program reads as `Clock::unix_timestamp`,
   *  because both are the slot's recorded time. Walks back a few slots because a slot that was skipped
   *  has no block and therefore no time. */
  async function readChainClock(): Promise<number> {
    const slot = await base.getSlot("confirmed");
    for (let back = 0; back < 5; back++) {
      const at = await base.getBlockTime(slot - back);
      if (at !== null) return at;
    }
    throw new Error(`no block time on the last 5 confirmed slots (newest ${slot}) — cannot establish the chain's clock`);
  }

  async function syncClock(): Promise<void> {
    const before = Date.now();
    const chainNow = await withReadRetry("chain clock", readChainClock);
    const after = Date.now();
    // The answer describes some instant inside the round trip, so it is anchored to the MIDPOINT of
    // that trip rather than to either end. On a 400ms round trip that is the difference between a
    // correct offset and one that is systematically 0.4s low.
    const hostAtMidpoint = Math.floor((before + after) / 2_000);
    clockOffsetSec = chainNow - hostAtMidpoint;
    clockMeasuredAtMs = after;
  }

  await syncClock();
  const offsetLine = `host clock is ${clockOffsetSec === 0 ? "in step with" : `${Math.abs(clockOffsetSec)}s ${clockOffsetSec > 0 ? "BEHIND" : "AHEAD OF"}`} the chain`;
  if (Math.abs(clockOffsetSec) > CLOCK_OFFSET_WARN_SECONDS) {
    warn(`${offsetLine} — correcting for it, but a host this far out has something wrong with it (NTP?)`);
  } else {
    info(offsetLine);
  }

  const nowSec = () => hostNowSeconds() + clockOffsetSec;

  // ---- reads ------------------------------------------------------------------------------------

  async function isDelegated(roundPda: PublicKey): Promise<boolean> {
    const acct = await withReadRetry("round owner", () => base.getAccountInfo(roundPda));
    return acct?.owner.equals(DELEGATION_PROGRAM_ID) ?? false;
  }

  async function fetchRound(roundNo: bigint): Promise<RawRoundAccount | null> {
    // THROUGH THE ROUTER, always. It routes per account, so a delegated round comes back as the ER
    // sees it — which for a live lobby or a live fight is every field that decides anything. Reading
    // it from the base layer would return the state the round had when it was delegated.
    const pda = roundPdaForRoundNo(roundNo, arenaPda);
    return withReadRetry(`round #${roundNo}`, () => program.account.round.fetchNullable(pda));
  }

  async function readChainState(): Promise<KeeperChainState> {
    if (Date.now() - clockMeasuredAtMs > CLOCK_RESYNC_SECONDS * 1_000) await syncClock();
    const at = nowSec();

    // The arena is a base-layer account that is never delegated, so it is read from the base layer
    // directly rather than through the router — one less hop, and one less thing that has to be right.
    const arena = await withReadRetry("arena", () => programBase.account.arena.fetchNullable(arenaPda));
    if (!arena) {
      return { nowSec: at, arena: null, roundCounter: 0n, roundPda: null, round: null, roundDelegated: null };
    }

    const roundCounter = BigInt(arena.roundCounter.toString());
    if (roundCounter === 0n) {
      return { nowSec: at, arena, roundCounter, roundPda: null, round: null, roundDelegated: null };
    }

    const roundPda = roundPdaForRoundNo(roundCounter, arenaPda);
    const round = await fetchRound(roundCounter);

    // Named phases rather than the numbers they happen to be: the coupling this module has to the
    // phase machine is exactly "these phases need the owner", and writing 0, 3 and 4 would hide that
    // behind three literals nobody would think to update. See `roundDelegated`'s own comment for why
    // only these ask the question.
    //
    // `Abandoned` joined the list when the house sweep did. `sweep_house_take` deserialises the round
    // as `Account<'info, Round>`, which checks the base-layer owner before anything else, so a round
    // that has not come home yet cannot be swept at all — and an abandoned round can still owe a fee
    // from its single entrant. Without asking here the keeper would send that sweep into an
    // owner-mismatch error, once per abandoned round, saying nothing about delegation.
    const delegationDecidesSomething = round !== null
      && (round.phase === Phase.Lobby || round.phase === Phase.Settled || round.phase === Phase.Abandoned);
    const roundDelegated = delegationDecidesSomething ? await isDelegated(roundPda) : null;

    return { nowSec: at, arena, roundCounter, roundPda, round, roundDelegated };
  }

  async function send(
    builder: TransactionBuilder,
    signer: TxSigner,
    label: string,
    routing: SendRouting = {},
  ): Promise<SendOutcome> {
    if (dryRun) {
      info(`${c.y}DRY RUN${c.x} — would send ${label}${routing.endpoint ? ` (direct to ${routing.endpoint})` : ""}`);
      dryRunPlan.push(label);
      return { signature: DRY_RUN_SIGNATURE, sent: false };
    }
    const { signature, elapsedMs } = await sendTx(router, builder, signer, label, routing);
    ok(`${label} landed in ${elapsedMs}ms  ${c.d}${signature}${c.x}`);
    return { signature, sent: true };
  }

  async function delegationStatus(roundPda: PublicKey): Promise<{ isDelegated?: boolean; fqdn?: string } | null> {
    return withReadRetry(
      "delegation status",
      () => router.getDelegationStatus(roundPda) as Promise<{ isDelegated?: boolean; fqdn?: string } | null>,
    );
  }

  async function roundValidatorFqdn(roundPda: PublicKey): Promise<string> {
    // `close_lobby_and_draw` MUST go here rather than through the generic router: its writable set
    // includes the ephemeral VRF queue, whose own delegation record names the SYSTEM PROGRAM as its
    // authority, which the multi-validator router cannot place — it refuses the transaction outright
    // with "accounts delegated to different ER nodes". The round's own validator hosts the ER the
    // round lives on and already knows the well-known queue singleton. Full account in
    // src/chain/sendTx.ts, "SDK SURPRISE #2".
    const fqdn = (await delegationStatus(roundPda))?.fqdn;
    if (!fqdn) throw new Error(`getDelegationStatus(${roundPda.toBase58()}) returned no fqdn — cannot resolve this round's ER validator`);
    assertDevnetUrl(fqdn, "ER validator");
    return fqdn;
  }

  /** Poll for the round PDA's base-layer owner to become `want`, bounded by WALL-CLOCK seconds.
   *
   *  A deadline rather than an iteration count, because each iteration is a sleep PLUS a confirmed
   *  RPC round trip — so a "30 iteration" wait was really 40-50 seconds of blocked main loop, and
   *  every number reasoned about in config.ts assumed it was a wall-clock bound. It also returns
   *  promptly on shutdown: this is the longest wait in the keeper and the one most likely to be
   *  holding a SIGTERM. */
  async function waitForOwner(roundPda: PublicKey, seconds: number, want: PublicKey, what: string): Promise<boolean> {
    const deadline = Date.now() + seconds * 1_000;
    while (Date.now() < deadline && !stopSignal?.aborted) {
      // Retried like every other read in this module. Without it, one transient `getAccountInfo`
      // failure threw out of `driveSettled` AFTER `close_round` had already landed — leaving a red
      // error in the status file, and no summary, for a round that had settled perfectly.
      const acct = await withReadRetry("round owner", () => base.getAccountInfo(roundPda));
      if (acct?.owner.equals(want)) return true;
      await sleep(1_000, stopSignal);
    }
    if (!stopSignal?.aborted) warn(`${what} did not show up on the base layer within ${seconds}s`);
    return false;
  }

  return {
    router,
    base,
    program,
    programBase,
    arenaPda,
    nowSec,
    clockOffsetSeconds: () => clockOffsetSec,
    readChainState,
    fetchRound,
    roundsExist: async (roundNos) => {
      if (roundNos.length === 0) return [];
      // THE ASSERTION AND THE CHUNK SIZE ARE DELIBERATELY TWO NUMBERS. `closeCursor.ts` owns
      // `CLOSE_CURSOR_PROBE_BATCH`; this is the guard that the chunker got it right, and a guard that
      // imports its bound from the thing it is guarding checks only that a constant equals itself.
      // The RPC's own answer to a longer list is `-32602 Too many inputs provided`, which arrives as
      // a read failure naming nothing about round numbers.
      if (roundNos.length > 100) {
        throw new Error(
          `roundsExist was asked about ${roundNos.length} rounds; getMultipleAccounts takes at most 100 ` +
          `per call. Chunk the call — see CLOSE_CURSOR_PROBE_BATCH in closeCursor.ts — rather than ` +
          `raising this, which would only move the failure into the RPC as a -32602.`,
        );
      }
      const infos = await withReadRetry(`existence of ${roundNos.length} round(s) from #${roundNos[0]}`, () =>
        base.getMultipleAccountsInfo(
          roundNos.map((roundNo) => roundPdaForRoundNo(roundNo, arenaPda)),
          // `dataSlice` of nothing: the question is null-or-not, and a `Round` is 3,248 bytes.
          { commitment: "confirmed", dataSlice: { offset: 0, length: 0 } },
        ));
      return infos.map((info) => info !== null);
    },
    send,
    balance: (pubkey: PublicKey) => withReadRetry("balance", () => base.getBalance(pubkey)),
    accountExists: async (pubkey: PublicKey) =>
      (await withReadRetry("account exists", () => base.getAccountInfo(pubkey))) !== null,
    // Through `withReadRetry` like every other read here, and from the BASE layer: the treasury is
    // never delegated, so the router would be a hop that decides nothing.
    fetchTreasury: () => withReadRetry("treasury", () => {
      // `BullsArenaProgram` is HAND-WRITTEN against lib.rs; Anchor builds `account` from the IDL
      // FETCHED AT RUNTIME. That is the same skew `program.ts` documents for `methods`, arriving on
      // the account namespace instead: against an IDL with no `Treasury` type there is no decoder at
      // all, and `fetchNullable` on `undefined` throws a `TypeError` that says nothing about
      // treasuries. The type says it is always there; the runtime does not, and here the runtime is
      // the one to believe. Asked as a question rather than caught as an exception, because a `catch`
      // around the fetch would also swallow the RPC failures the retry exists to survive.
      const treasury = programBase.account.treasury as
        BullsArenaProgram["account"]["treasury"] | undefined;
      if (!treasury) return Promise.resolve(null);
      return treasury.fetchNullable(treasuryPda(arenaPda));
    }),
    isDelegated,
    roundValidatorFqdn,
    routerSaysDelegated: async (roundPda) => (await delegationStatus(roundPda))?.isDelegated === true,
    waitForDelegation: (roundPda, seconds) =>
      waitForOwner(roundPda, seconds, DELEGATION_PROGRAM_ID, "delegation"),
    waitForUndelegation: (roundPda, seconds) =>
      waitForOwner(roundPda, seconds, PROGRAM_ID, "undelegation"),
    dryRunPlan,
  };
}
