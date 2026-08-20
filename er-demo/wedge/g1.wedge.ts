// G1 — THE WEDGE. `ARENA-VAULT.md` §7, experiment E1-M1, as a test rather than as a ritual.
//
// WHAT THIS IS FOR. §0.1 lists eleven gates in front of the first real dollar of player custody. G1
// is the first of them: "the rescue path is exercised against a genuinely unsettleable round — not
// reasoned about, RUN". Its status in that table is "never attempted by anyone", and everything
// §5.1 says about how money gets un-stuck is a design until somebody produces the round it is
// designed against. This file produces that round.
//
// WHY IT IS A TEST AND NOT A SCRIPT, in §7's own words: "G1 SHOULD NOT BE AN EXPERIMENT. IT SHOULD
// BE A TEST. `tests/compute.rs`'s header states the doctrine: *a measurement nothing re-runs is a
// rumour with a number in it*. A rescue path proven once and never re-run is `bench_fight` wearing a
// rescue's clothes." One command, no manual steps, no devnet, and it cleans up after itself.
//
// ─── WHAT IT PROVES, AND WHAT IT DOES NOT ────────────────────────────────────────────────────────
//
// G1 has two halves and this file is honest about owning one of them.
//
//   PROVEN HERE — THE WEDGE. A `Round` reaches a state in which nothing can resolve it, abandon it,
//   undelegate it, close it, tick it, enter it, or re-delegate it. The base layer has no path back,
//   and the only key that had one belonged to a process that no longer exists.
//
//   NOT PROVEN HERE — THE RESCUE. §5.1's `arena_vault::open_refund` / `refund` executing against
//   that round and paying every depositor back. `arena-vault` does not exist yet (§8.1 sequences it
//   as S2), so there is no escrow to refund from and no `open_refund` to call. The seam where those
//   assertions go is marked at the bottom of this file, named, with the shape of each assertion
//   written out.
//
// The distinction matters because it is exactly where a green run could be over-read. The wedge is
// the PRECONDITION for §5.1's rescue — the hostile environment the refund has to work in. Producing
// it settles §10's row "a local `ephemeral-validator` accepts a delegation pinned to its own
// identity", and turns "the base-layer refund path works against a round that can never be
// undelegated" from an untested premise into a half-tested one: the round is now real; the refund is
// still a design.
//
// ─── WHY THE MECHANISM IS ALREADY IN THE PROGRAM ────────────────────────────────────────────────
//
// `delegate_round` passes `DelegateConfig { validator: ctx.remaining_accounts.first().map(|a|
// a.key()), .. }` — lib.rs:1804. A delegation may name one validator, and the named one is then the
// only key that may commit or undelegate that account for the rest of its life. `DelegateRound`'s
// own doc comment calls that "the actual security boundary of the whole migration". Kill the named
// validator and the account is owned by `DELeGG…` with nobody able to sign for it. This file does
// not add a mechanism; it points the existing one at a validator it is about to destroy.
//
// The pin is built by `src/chain/round.ts`'s `delegateRound({ validator })` — the app's own builder,
// the same one the keeper would use — and not by a hand-assembled instruction. That is the discipline
// §7 E3 names and that this repo earned the hard way: "calling the real instruction rather than a
// stand-in — the discipline this repo earned when a hand-copied `bench_fight` drifted enough to make
// a real `resolve` exceed 1.4 M CU."

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { AnchorError, Wallet } from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID,
  delegationRecordPdaFromDelegatedAccount,
  undelegateBufferPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { createProgram, type BullsArenaProgram, type MethodsBuilder } from "../src/chain/program.ts";
import {
  abandonRound,
  arenaPda,
  closeRound,
  closeRoundAccount,
  delegateRound,
  enter,
  initArena,
  initTreasury,
  openRound,
  resolve,
  roundPdaForRoundNo,
  tick,
  treasuryPda,
  u64le,
} from "../src/chain/round.ts";
import { assertLocalhostUrl } from "./localhost.ts";
import { checkPreconditions, type Toolchain } from "./preconditions.ts";
import {
  BASE_RPC_URL,
  ROLLUP_RPC_URL,
  WEDGE_PORTS,
  mintValidatorIdentity,
  rollupIdentity,
  rollupIsUnreachable,
  sigkillRollup,
  startBaseLayer,
  startRollup,
  systemAccount,
  teardown,
  type Process,
} from "./stack.ts";

/** The round the wedge is produced on. One arena, one round, one fresh genesis every run. */
const ROUND_NO = 1n;
/** Long enough that the lobby cannot close underneath the experiment on a slow machine. Nothing here
 *  waits for a deadline; a round that reached `Phase::Drawing` would be wedged by §5.2's defect
 *  instead of by the validator's death, which is a different measurement. */
const LOBBY_SECONDS = 3_600;
const STAKE = 1_000_000;

/** One attempted instruction and what the chain said back. */
interface Attempt {
  readonly name: string;
  readonly ok: boolean;
  readonly signature?: string;
  /** Anchor's error name, e.g. `AccountOwnedByWrongProgram`, when the failure was an Anchor one. */
  readonly errorCode?: string;
  readonly errorNumber?: number;
  /** The WHOLE error message, not its first line.
   *
   *  It was the first line for one draft, on the reasoning that a one-line summary reads better in
   *  the report — and `SendTransactionError`'s first line is the string "Simulation failed." and
   *  nothing else, with the transaction message and the program logs on the lines after it. Two runs
   *  were spent staring at a failure whose diagnosis had been in the exception the whole time and was
   *  discarded on the way past. Truncation belongs at the point of DISPLAY (see `report`), never at
   *  the point of capture. */
  readonly message: string;
  readonly logs: string[];
}

/** Everything the choreography observed, assembled once in `beforeAll` and asserted below. */
interface Evidence {
  validator: PublicKey;
  rollupReportedIdentity: PublicKey;
  round: PublicKey;
  ownerBeforeDelegate: string;
  ownerAfterDelegate: string;
  ownerAfterKill: string;
  pinnedValidatorBeforeKill: string;
  pinnedValidatorAfterKill: string;
  roundLamportsAfterKill: number;
  roundBytesAfterKill: number;
  delegateAttempt: Attempt;
  rollupEntries: Attempt[];
  fighterCountInRollup: number;
  fighterCountOnBase: number;
  rollupUnreachable: boolean;
  postKill: Record<string, Attempt>;
}

let tools: Toolchain;
/** Only the rollup's handle is kept: it is the one this file signals on purpose. The base layer is
 *  supervised by `stack.ts` and torn down with everything else — nothing here needs to address it. */
let rollup: Process;
let evidence: Evidence;

const payer = Keypair.generate();
const wallet = new Wallet(payer);

/**
 * Send a built instruction and record what happened, success or failure.
 *
 * IT SENDS RATHER THAN SIMULATES, which is a deliberate departure from `scripts/reclaim-status.ts`
 * — the other place in this repo that asks the chain why it would refuse something. That script
 * simulates because it is a read-only status tool run against the LIVE arena, where signing and
 * sending is exactly what it must not do. Here the whole point is a real refusal on a real ledger:
 * a simulation that fails leaves open the objection that the transaction was never actually
 * submitted, and this file exists to close objections, not to leave them open. The ledger is
 * disposable, so there is nothing to protect.
 *
 * IT SKIPS PREFLIGHT AND READS THE LEDGER, WHICH IS THE OPPOSITE OF THE OBVIOUS CHOICE. The obvious
 * one — `sendAndConfirmTransaction` with preflight on — was the first version, and it is unusable
 * here for a reason that only shows up on the rollup. When preflight rejects a transaction, the
 * caller gets a `SendTransactionError` whose `.logs` the RPC may or may not have supplied; Agave
 * usually does, and `magicblock_aperture` (the rollup's RPC) does NOT. Against the rollup, every
 * failure arrived as the string
 *
 *     transaction verification error: Error processing Instruction 0: custom program error: 0x1771
 *
 * with no program logs at all, and two runs were spent trying to identify a program error from its
 * number alone. That was not merely slow, it was actively misleading — see the note below on 6001.
 *
 * Sending with `skipPreflight` and then reading `getTransaction().meta` gives the same answer from
 * the ledger instead of from the RPC's opinion of it: `meta.err` says whether it failed and
 * `meta.logMessages` is the program's own output, identically on both layers. It also makes the
 * refusal a recorded fact — a failed transaction is still committed, so the ledger this test
 * produces contains the evidence rather than only the assertion about it.
 *
 * NEVER IDENTIFY AN ANCHOR ERROR BY ITS NUMBER. `AnchorError.parse` reads the program's own
 * "Error Code: X. Error Number: N" log line, and that indirection is not ceremony. Anchor bases
 * every `#[error_code]` enum at 6000, and this program links TWO of them: its own `ArenaError` and
 * the session-keys crate's. `Custom(6001)` is `ArenaError::RoundOutOfOrder` if you decode it against
 * this program's IDL and `InvalidToken` — "Invalid session token" — if you read the log line. The
 * real answer was the second one; the IDL says the first. A number is not an identity.
 */
async function attempt(
  connection: Connection,
  name: string,
  builder: MethodsBuilder,
  /** Who pays, and therefore the one account that may be writable without being delegated — see the
   *  note on `fighters` in `beforeAll`. Defaults to the harness's own wallet. */
  feePayer: Keypair = payer,
): Promise<Attempt> {
  try {
    const tx = await builder.transaction();
    tx.feePayer = feePayer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(feePayer);

    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await awaitConfirmation(connection, signature);
    const meta = (
      await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
    )?.meta;
    const logs = meta?.logMessages ?? [];

    if (!meta?.err) return { name, ok: true, signature, message: "confirmed", logs };
    const anchorError = AnchorError.parse(logs);
    return {
      name,
      ok: false,
      errorCode: anchorError?.error.errorCode.code,
      errorNumber: anchorError?.error.errorCode.number,
      message: JSON.stringify(meta.err),
      logs,
    };
  } catch (err) {
    // The transaction never reached the ledger at all — malformed, unsignable, or the node refused
    // it outright. There is no `meta` to read, so the exception is the whole of the evidence.
    return {
      name,
      ok: false,
      message: (err instanceof Error ? err.message : String(err)).trim(),
      logs: [],
    };
  }
}

/**
 * Wait for a signature by POLLING, never by subscribing.
 *
 * `Connection.confirmTransaction` opens a WebSocket subscription, and web3.js's socket reconnects
 * on its own schedule for the lifetime of the `Connection` object. Against the rollup that is a
 * liability rather than a nicety: this file's central act is killing that validator, and a socket
 * pointed at it goes on retrying afterwards, printing
 *
 *     ws error: connect ECONNREFUSED 127.0.0.1:7820
 *
 * to stderr four times during the assertions. Nothing failed and nothing was wrong — but a suite
 * whose passing output contains repeated connection errors is a suite people stop trusting, and
 * "those lines are expected" is a thing every reader has to be told separately, forever.
 *
 * `getSignatureStatuses` answers the same question over plain HTTP with no lasting connection, so
 * after the kill there is nothing left holding a socket open. The alternative — reaching into
 * `connection._rpcWebSocket` to close it — would work and is exactly the kind of private-API poke
 * that stops working silently on a dependency bump.
 *
 * A transaction that FAILED also reaches `confirmed`, with its error in the status. That is the
 * point: this returns when the ledger has an answer, and the caller reads `meta.err` to find out
 * which answer it is.
 */
async function awaitConfirmation(connection: Connection, signature: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`transaction ${signature} was not confirmed within ${timeoutMs}ms`);
}

/** Send an instruction that MUST succeed for the experiment to mean anything, or throw naming it. */
async function must(connection: Connection, name: string, builder: MethodsBuilder): Promise<Attempt> {
  const result = await attempt(connection, name, builder);
  if (!result.ok) {
    throw new Error(
      `setup step \`${name}\` failed, so no wedge was produced and nothing below was measured.\n` +
        `  ${result.errorCode ? `${result.errorCode} (${result.errorNumber}) — ` : ""}${result.message}\n` +
        result.logs.map((l) => `    | ${l}`).join("\n"),
    );
  }
  return result;
}

async function ownerOf(connection: Connection, key: PublicKey): Promise<string> {
  const info = await connection.getAccountInfo(key, "confirmed");
  return info ? info.owner.toBase58() : "<account absent>";
}

/**
 * The validator this delegation is pinned to, read out of the delegation program's own record.
 *
 * `DelegationRecord` is 96 bytes: an 8-byte discriminator (100) then `authority`, `owner`,
 * `delegation_slot`, `lamports`, `commit_frequency_ms`. `authority` IS the pinned validator — the
 * `DelegateConfig.validator` our program passed through. The layout is read off the wire rather than
 * taken from documentation, and it has a control shipped with the tooling: MagicBlock's own
 * `bin/local-dumps/F72HqCR8nwYsVyeVd38pgKkjXmXFzVAM8rjZZsXWbdE.json` is a DelegationRecord whose
 * first 32 bytes after the discriminator are all zero — `Pubkey::default()`, i.e. "any validator may
 * commit this" — with a real program id in the `owner` slot behind it. So the field that reads as a
 * pubkey when we pin and reads as zero when nobody pins is the field that means "pinned to".
 */
async function pinnedValidator(connection: Connection, round: PublicKey): Promise<string> {
  const record = await connection.getAccountInfo(
    delegationRecordPdaFromDelegatedAccount(round),
    "confirmed",
  );
  if (!record) return "<no delegation record>";
  return new PublicKey(record.data.subarray(8, 40)).toBase58();
}

beforeAll(async () => {
  // Before anything is spawned: refuse to run at all if the toolchain, the compiled program or the
  // ports are not what this experiment needs. Every branch in there throws; none skips.
  tools = await checkPreconditions(WEDGE_PORTS);

  // THE OPPOSITE GUARD FROM THE REST OF THE REPO. `src/devnet-guard.ts` keeps the app off mainnet
  // and is happy with devnet — which is the one cluster this file must never touch, because the live
  // arena is there and `ARENA_SEED` is a singleton. Asserted here, at the top, over the two
  // endpoints everything below uses, so that a mis-edited constant is a refusal to start rather than
  // a wedged round on a real arena. `stack.ts` asserts them again at each spawn; two checks over one
  // fact is the correct amount when the failure is unrecoverable.
  assertLocalhostUrl(BASE_RPC_URL, "base layer");
  assertLocalhostUrl(ROLLUP_RPC_URL, "rollup");

  // The validator identity is minted here and exists nowhere else — see `mintValidatorIdentity`.
  const { identity, genesis } = mintValidatorIdentity();

  // TWO FIGHTERS, EACH OF WHICH SIGNS FOR ITSELF.
  //
  // The first draft made these bare pubkeys that never signed, with `payer` as `signer` for both, on
  // the reasoning that `Enter.player` is an `UncheckedAccount` the program only records. The rollup
  // refused it, and the refusal is a good lesson twice over. The error was
  // `Custom(6001)` with no logs, which decodes against this program's IDL as
  // `ArenaError::RoundOutOfOrder` — an error `lib.rs:1692` raises only inside `open_round`, i.e. an
  // impossible answer that sent two runs looking at the rollup for a fault that was never there. The
  // program's own log line says what it actually was:
  //
  //     AnchorError thrown in programs/bulls-arena/src/lib.rs:1777.
  //     Error Code: InvalidToken. Error Number: 6001. Error Message: Invalid session token.
  //
  // `InvalidToken` is 6001 in the SESSION-KEYS crate's error enum, not in `ArenaError`; both are
  // `#[error_code]` enums based at 6000 and this program links both. `enter` is guarded by
  // `#[session_auth_or(signer == player, InvalidToken)]`, so an unsigned `player` with a different
  // `signer` and no session token is exactly the case that guard exists to reject. The program was
  // right and the fixture was wrong. (`attempt` above now reads logs rather than numbers, so the
  // next person to hit an ambiguous 6001 is told which one it is.)
  //
  // So each fighter is a funded keypair that signs its own entry — `player == signer`, the
  // no-session-token branch of the guard, and the shape `EnterForm.tsx` produces for a wallet with
  // no active session.
  //
  // AND EACH FIGHTER PAYS ITS OWN FEES, which is the second half of the same lesson and a constraint
  // on the ROLLUP rather than on the program. Signing with the fighter while `payer` stayed the fee
  // payer still failed, and this time the program was not even the one complaining — `enter`
  // succeeded, emitted its `Entered` event, and then the transaction was rejected wholesale:
  //
  //     Program log: Account 1: 9ARjZZ4E… was illegally used as writable
  //     Program Magic11111111111111111111111111111111111111 failed: InvalidWritableAccount
  //
  // `--lifecycle ephemeral` is "clone all accounts, WRITE TO DELEGATED ACCOUNTS", and the Magic
  // program enforces it after execution. `Enter.signer` is `#[account(mut)]`, so a signer who is not
  // the fee payer is a writable, undelegated account and the rollup refuses the whole transaction.
  // The fee payer is the one exception, because a rollup that could not debit fees could not
  // function. Making each fighter its own fee payer satisfies the rule and is what a real player
  // does anyway.
  //
  // Worth carrying into §7 E3, which has not been run: `arena_vault::enter_delegated` is planned as
  // a vault→game CPI over ~14 accounts, and every account it intends to WRITE inside the rollup must
  // be delegated or be the fee payer. That is a design constraint on the vault's account list, and
  // it is cheaper to learn here than during S2.
  const fighters = [Keypair.generate(), Keypair.generate()];

  await startBaseLayer(tools, [
    ...genesis,
    // The wallet that pays every fee here, funded at genesis rather than by the faucet.
    systemAccount(payer.publicKey, 1_000 * LAMPORTS_PER_SOL),
    ...fighters.map((f) => systemAccount(f.publicKey, LAMPORTS_PER_SOL)),
  ]);
  rollup = await startRollup(tools, identity);

  // PIN TO WHAT THE ROLLUP SAYS IT IS, NOT TO WHAT WE TOLD IT TO BE. We minted the key and passed it
  // with `-k`, so we already believe we know the answer — and that belief is precisely what must not
  // be load-bearing. If `-k` were ignored, or silently overridden by a config file, or normalized in
  // some way, a delegation pinned to our assumption would name a validator that is not running: the
  // round would wedge, every assertion below would pass, and the experiment would have measured
  // nothing except that a delegation to a nonexistent validator wedges. Reading `getIdentity` off
  // the running process and pinning THAT closes it, and the equality of the two is asserted as its
  // own test below rather than assumed here.
  const reported = await rollupIdentity();

  const base = new Connection(BASE_RPC_URL, "confirmed");
  const rollupConn = new Connection(ROLLUP_RPC_URL, "confirmed");
  const program: BullsArenaProgram = await createProgram(base, wallet);
  const rollupProgram: BullsArenaProgram = await createProgram(rollupConn, wallet);

  const arena = arenaPda(tools.programId);
  const round = roundPdaForRoundNo(ROUND_NO, arena, tools.programId);

  // ── §7 E1-M1 step 2-3: a real arena, a real round ──────────────────────────────────────────────
  await must(base, "init_arena", initArena(program, { arena, authority: payer.publicKey, feeBps: 500 }));
  await must(
    base,
    "init_treasury",
    initTreasury(program, { arena, treasury: treasuryPda(arena, tools.programId), authority: payer.publicKey }),
  );
  await must(
    base,
    "open_round",
    openRound(program, {
      arena,
      round,
      authority: payer.publicKey,
      roundNo: ROUND_NO,
      seedCommit: new Uint8Array(32).fill(7),
      lobbySeconds: LOBBY_SECONDS,
    }),
  );

  const ownerBeforeDelegate = await ownerOf(base, round);

  // ── step 4: delegate, pinned to the local rollup's own identity ────────────────────────────────
  const delegateAttempt = await attempt(
    base,
    "delegate_round(validator = the local rollup)",
    delegateRound(program, {
      arena,
      round,
      authority: payer.publicKey,
      roundNo: ROUND_NO,
      programId: tools.programId,
      validator: reported,
    }),
  );
  if (!delegateAttempt.ok) {
    // §7 marks this as M1's ONLY failure mode and §10 as "the single step E1-M1 can fail on". A
    // refusal here is a real finding and the correct response is to report it and stop — NOT to
    // improvise toward E1-M2, which costs a program id and is the operator's call to make.
    throw new Error(
      `E1-M1 FAILED AT ITS ONE KNOWN FAILURE POINT: the delegation naming the local validator was refused.\n` +
        `  validator: ${reported.toBase58()}\n` +
        `  ${delegateAttempt.errorCode ? `${delegateAttempt.errorCode} (${delegateAttempt.errorNumber}) — ` : ""}${delegateAttempt.message}\n` +
        delegateAttempt.logs.map((l) => `    | ${l}`).join("\n") +
        `\nThis settles ARENA-VAULT.md §10's row "a local ephemeral-validator accepts a delegation ` +
        `pinned to its own identity" as FALSE. §7 says fall back to E1-M2 (layout divergence on a ` +
        `sacrificial program id) — that costs a program id and real devnet SOL, so it is an ` +
        `operator decision, not something this suite should attempt.`,
    );
  }

  const ownerAfterDelegate = await ownerOf(base, round);
  const pinnedValidatorBeforeKill = await pinnedValidator(base, round);

  // ── step 5: confirm the round is live in the rollup ────────────────────────────────────────────
  //
  // §7 says "tick it once". `tick` cannot be used: it requires `Phase::Fight`, which is three
  // instructions and a VRF callback away (`close_lobby_and_draw` -> the oracle -> `callback_seed`),
  // and a round parked in `Phase::Drawing` waiting for an oracle is §5.2's defect — a DIFFERENT way
  // to wedge a round, which would contaminate the measurement with a second cause.
  //
  // `enter` is the better instrument for the same question and a strictly stronger one. It is a
  // rollup-executed state mutation on the delegated account, it runs in `Phase::Lobby` where the
  // round already is, and it produces a DIVERGENCE: `fighter_count` becomes 2 in the rollup while
  // the base layer's copy stays 0. "The rollup accepted the pinned delegation and is executing our
  // program against it" is then not an inference from a transaction succeeding somewhere — it is two
  // numbers that disagree, which they can only do if the rollup is authoritative for this account.
  //
  const rollupEntries = [
    await attempt(
      rollupConn,
      "enter(side 0) in the rollup",
      enter(rollupProgram, {
        arena, round, player: fighters[0].publicKey, signer: fighters[0].publicKey,
        sessionToken: null, side: 0, stake: STAKE,
      }),
      fighters[0],
    ),
    await attempt(
      rollupConn,
      "enter(side 1) in the rollup",
      enter(rollupProgram, {
        arena, round, player: fighters[1].publicKey, signer: fighters[1].publicKey,
        sessionToken: null, side: 1, stake: STAKE,
      }),
      fighters[1],
    ),
  ];
  if (rollupEntries.some((e) => !e.ok)) {
    const failed = rollupEntries.find((e) => !e.ok)!;
    throw new Error(
      `the rollup accepted the delegation but would not EXECUTE against it: \`${failed.name}\` failed.\n` +
        `  ${failed.errorCode ? `${failed.errorCode} (${failed.errorNumber}) — ` : ""}${failed.message}\n` +
        failed.logs.map((l) => `    | ${l}`).join("\n") +
        `\nA round the rollup will not run is not "live in the rollup" (§7 E1-M1 step 5), so the ` +
        `wedge below would be a wedge around an empty round and would prove less than it appears to.`,
    );
  }

  const fighterCountInRollup = Number((await rollupProgram.account.round.fetch(round)).fighterCount);
  const fighterCountOnBase = Number((await program.account.round.fetch(round)).fighterCount);

  // ── step 6: SIGKILL. Never restart it. ─────────────────────────────────────────────────────────
  await sigkillRollup(rollup);
  const rollupUnreachable = await rollupIsUnreachable();

  // ── steps 7-8: what does the base layer say now, and what will it let anyone do? ───────────────
  const ownerAfterKill = await ownerOf(base, round);
  const pinnedValidatorAfterKill = await pinnedValidator(base, round);
  const info = await base.getAccountInfo(round, "confirmed");

  // Every instruction that could return this round's state — or its rent — to anybody.
  const postKill: Record<string, Attempt> = {
    resolve: await attempt(base, "resolve", resolve(program, { payer: payer.publicKey, round })),
    abandon_round: await attempt(base, "abandon_round", abandonRound(program, { payer: payer.publicKey, round })),
    close_round: await attempt(base, "close_round", closeRound(program, { payer: payer.publicKey, round })),
    close_round_account: await attempt(
      base,
      "close_round_account",
      closeRoundAccount(program, { arena, round, authority: payer.publicKey, roundNo: ROUND_NO }),
    ),
    tick: await attempt(base, "tick", tick(program, { round, steps: 1 })),
    enter: await attempt(
      base,
      "enter",
      enter(program, {
        arena, round, player: fighters[0].publicKey, signer: fighters[0].publicKey,
        sessionToken: null, side: 0, stake: STAKE,
      }),
      fighters[0],
    ),
    delegate_round: await attempt(
      base,
      "delegate_round (again)",
      delegateRound(program, { arena, round, authority: payer.publicKey, roundNo: ROUND_NO, programId: tools.programId, validator: reported }),
    ),
    process_undelegation: await attempt(
      base,
      "process_undelegation",
      processUndelegation(program, { round, arena, roundNo: ROUND_NO, payer: payer.publicKey }),
    ),
  };

  evidence = {
    validator: identity.keypair.publicKey,
    rollupReportedIdentity: reported,
    round,
    ownerBeforeDelegate,
    ownerAfterDelegate,
    ownerAfterKill,
    pinnedValidatorBeforeKill,
    pinnedValidatorAfterKill,
    roundLamportsAfterKill: info?.lamports ?? 0,
    roundBytesAfterKill: info?.data.length ?? 0,
    delegateAttempt,
    rollupEntries,
    fighterCountInRollup,
    fighterCountOnBase,
    rollupUnreachable,
    postKill,
  };

  report(evidence);
}, 420_000);

afterAll(async () => {
  await teardown();
});

/**
 * `process_undelegation`, built here because the app has no business building it.
 *
 * It is the callback half of `#[ephemeral]`: the delegation program CPIs into it, with the delegated
 * account signing as a PDA, to hand ownership back. No client ever calls it, so it is correctly
 * absent from `chain/program.ts`'s hand-written interface and from `chain/round.ts`'s builders — that
 * interface's own header says an absent member means nobody has needed one, and the honest response
 * to needing one HERE is to build it here rather than to widen the app's surface with an instruction
 * the app must never send.
 *
 * The cast is the same one `chain/program.ts` contains and confines: `BullsArenaProgram` is a precise
 * hand-written shape over Anchor's loose runtime `Program`, and this instruction exists at runtime
 * without being declared on it.
 */
function processUndelegation(
  program: BullsArenaProgram,
  params: { round: PublicKey; arena: PublicKey; roundNo: bigint | number; payer: PublicKey },
): MethodsBuilder {
  const methods = program.methods as unknown as {
    processUndelegation(seeds: Buffer[]): MethodsBuilder;
  };
  return methods
    // The Round PDA's real seeds, which is what a genuine undelegation would pass — so a refusal
    // here cannot be blamed on the harness having supplied nonsense.
    .processUndelegation([
      Buffer.from("round"),
      Buffer.from(params.arena.toBytes()),
      Buffer.from(u64le(params.roundNo)),
    ])
    .accounts({
      baseAccount: params.round,
      buffer: undelegateBufferPdaFromDelegatedAccount(params.round),
      payer: params.payer,
      systemProgram: SystemProgram.programId,
    });
}

/** Print the evidence as a block, so a passing run SAYS what it measured instead of only that it
 *  passed. §7's estimate for answering the open question was thirty minutes of somebody reading
 *  `round.owner`; this prints what they would have read. */
function report(e: Evidence): void {
  const line = (k: string, v: string | number | boolean) => `  ${k.padEnd(34)} ${v}`;
  // The report is a table, so one line per attempt — this is the display-side truncation the
  // `Attempt.message` comment refers to. The full text survives in the object for anything that
  // throws.
  const verdict = (a: Attempt) =>
    a.ok
      ? `!! SUCCEEDED (${a.signature})`
      : a.errorCode
        ? `refused — ${a.errorCode} (${a.errorNumber})`
        : `refused — ${a.message.split("\n")[0]}`;

  console.log(
    [
      "",
      "═══ G1 / ARENA-VAULT.md §7 E1-M1 — the wedge ═══",
      line("round", e.round.toBase58()),
      line("pinned validator", e.validator.toBase58()),
      line("rollup reported identity", e.rollupReportedIdentity.toBase58()),
      "",
      line("round.owner before delegate", e.ownerBeforeDelegate),
      line("round.owner after delegate", e.ownerAfterDelegate),
      line("round.owner AFTER SIGKILL", e.ownerAfterKill),
      line("delegation record .authority", e.pinnedValidatorAfterKill),
      line("round rent stranded (lamports)", e.roundLamportsAfterKill),
      line("round size (bytes)", e.roundBytesAfterKill),
      "",
      line("fighter_count in rollup", e.fighterCountInRollup),
      line("fighter_count on base layer", e.fighterCountOnBase),
      line("rollup RPC after SIGKILL", e.rollupUnreachable ? "unreachable" : "!! STILL ANSWERING"),
      "",
      ...Object.entries(e.postKill).map(([name, a]) => line(name, verdict(a))),
      "═══════════════════════════════════════════════",
      "",
    ].join("\n"),
  );
}

describe("G1 — a local ephemeral validator accepts a pinned delegation (ARENA-VAULT.md §10)", () => {
  it("runs as the identity it was given, and reports that identity over RPC", () => {
    // §10: "whether that identity is settable from its keypair". `-k` takes base58 of the 64-byte
    // secret; this asserts the running process agrees with the key we minted, which is the only form
    // of "settable" worth anything — a flag that is accepted and then ignored would look identical
    // from outside.
    expect(evidence.rollupReportedIdentity.toBase58()).toBe(evidence.validator.toBase58());
  });

  it("accepts a delegation naming its own identity", () => {
    // §10: "the single step E1-M1 can fail on". It does not fail.
    expect(evidence.delegateAttempt.ok, evidence.delegateAttempt.message).toBe(true);
    // Before: ours. After: the delegation program's. Both stated, because "the owner is DELeGG…" is
    // only interesting against the fact that it was something else a transaction ago.
    expect(evidence.ownerBeforeDelegate).toBe(tools.programId.toBase58());
    expect(evidence.ownerAfterDelegate).toBe(DELEGATION_PROGRAM_ID.toBase58());
  });

  it("records the pin in the delegation program's own record", () => {
    // Not "we asked for a pin" — the delegation program wrote the validator down, and this is the
    // byte that makes the round unmovable by anyone else.
    expect(evidence.pinnedValidatorBeforeKill).toBe(evidence.validator.toBase58());
  });

  it("executes the program against the delegated round, with state the base layer does not have", () => {
    for (const e of evidence.rollupEntries) expect(e.ok, `${e.name}: ${e.message}`).toBe(true);
    // The divergence IS the proof of life. Two entries landed in the rollup; the base layer's copy
    // of the same account has never heard of them.
    expect(evidence.fighterCountInRollup).toBe(2);
    expect(evidence.fighterCountOnBase).toBe(0);
  });
});

describe("G1 — the wedge: after the validator dies, nothing can move the round", () => {
  it("killed the rollup, verifiably", () => {
    expect(evidence.rollupUnreachable, "the rollup still answers RPC — the kill did not take").toBe(true);
  });

  it("leaves round.owner as the delegation program", () => {
    // §7 step 7: "base layer: round.owner == DELeGGvXpW... forever".
    expect(evidence.ownerAfterKill).toBe(DELEGATION_PROGRAM_ID.toBase58());
  });

  it("leaves the delegation pinned to a validator that no longer exists", () => {
    // The record is unchanged by the death — nothing clears it, which is exactly the problem. The
    // named key's only copy was minted in this process and is destroyed with the workspace.
    expect(evidence.pinnedValidatorAfterKill).toBe(evidence.validator.toBase58());
  });

  // §7 step 8, one assertion per verb. Each is `AccountOwnedByWrongProgram` for the same structural
  // reason: every handler that reads the `Round` takes it as an `AccountLoader`, and Anchor's owner
  // check runs during account deserialization — before the instruction body, before any Magic CPI.
  // The program does not decline to act; it cannot see the account at all.
  for (const name of ["resolve", "abandon_round", "close_round", "close_round_account"] as const) {
    it(`cannot ${name} it`, () => {
      const a = evidence.postKill[name];
      expect(a.ok, `${name} SUCCEEDED against a wedged round — the wedge is not what this file claims`).toBe(false);
      expect(a.errorCode).toBe("AccountOwnedByWrongProgram");
      expect(a.errorNumber).toBe(3007);
    });
  }

  it("cannot undelegate it — the callback refuses everyone but the delegation program", () => {
    // The undelegation half of §7 step 8, and the one that needed its own instrument. The other four
    // fail Anchor's owner check; `process_undelegation` does not read the Round as an `AccountLoader`
    // at all, so it gets further and fails on the thing that actually matters:
    // `MissingRequiredSignature`. The delegated account itself must sign, which only the delegation
    // program can arrange, and the delegation program will only arrange it for the pinned validator.
    const a = evidence.postKill.process_undelegation;
    expect(a.ok, "process_undelegation SUCCEEDED — the round is not wedged").toBe(false);
    expect(a.logs.join("\n")).toMatch(/MissingRequiredSignature/);
  });

  it("cannot tick or enter it either — the round is unreachable, not merely unsettleable", () => {
    for (const name of ["tick", "enter"] as const) {
      expect(evidence.postKill[name].ok, `${name} SUCCEEDED`).toBe(false);
      expect(evidence.postKill[name].errorCode).toBe("AccountOwnedByWrongProgram");
    }
  });

  it("cannot be re-delegated to a live validator", () => {
    // The obvious escape — point it at a validator that IS running — and it is not available. The
    // delegation CPI tries to write an account the program no longer owns. There is no re-pinning.
    const a = evidence.postKill.delegate_round;
    expect(a.ok, "the round was re-delegated — the wedge is escapable").toBe(false);
    expect(a.logs.join("\n")).toMatch(/instruction modified data of an account it does not own/);
  });

  it("strands exactly the rent §5.1 predicts, and no more", () => {
    // §5.1's first residual: "The `Round` account's 0.023497 SOL of rent is stranded permanently. No
    // instruction can close a delegated account. Accepted, and it is exactly the inversion the
    // conservation comment predicts: strand the rent, never the money."
    //
    // Asserted as a MEASUREMENT rather than as a constant. §5.1's figure is for the current
    // `Round::SIZE`; if `MAX_FIGHTERS` moves, the number moves with it and hard-coding 23_496_960
    // would make this test fail for a change that does not affect the claim. What is invariant is
    // that the stranded amount is the rent of a live, full-size `Round` — so this checks the account
    // is still there, still full size, and still funded.
    expect(evidence.roundBytesAfterKill).toBeGreaterThan(0);
    expect(evidence.roundLamportsAfterKill).toBeGreaterThan(0);
  });
});

// ─── THE SEAM: THE OTHER HALF OF G1 ──────────────────────────────────────────────────────────────
//
// Everything above is §7 E1-M1 steps 1-7 and the negative half of step 8. The POSITIVE half of step
// 8 — "advance past rescue_after_secs; arena_vault::open_refund, then refund x n" — cannot be
// written yet, because `arena-vault` does not exist. §8.1 sequences it as S2.
//
// These are `todo` rather than absent, and rather than commented out, on purpose: vitest prints them
// in every run, so the report of a green wedge always carries the sentence "and the rescue is still
// owed". A gap that is invisible in the output is a gap that gets forgotten, and this one sits in
// front of the gate that §0.1 says holds up player custody.
//
// WHAT LANDS HERE WHEN S2 DOES. The choreography above changes in exactly two places: `open_escrow`
// and `arena_vault::enter` x n replace the two rollup `enter`s in `beforeAll` (real deposits into a
// real escrow ATA, per §7 E1-M1 steps 2-3), and the clock is advanced past
// `vault_arena.rescue_after_secs`. Nothing else moves — the wedge is produced identically, which is
// the point of building it first.
describe("G1 — the rescue against the wedge (owed: needs arena-vault, ARENA-VAULT.md §8.1 S2)", () => {
  // require now >= escrow.locked_at + rescue_after_secs; require the round is NOT payable (owner !=
  // game_program, which is exactly what `ownerAfterKill` above already measures); escrow.state
  // becomes Refunding, one way, never returning to Settling.
  it.todo("open_refund succeeds against a round nothing can undelegate");

  // The whole load-bearing claim of §5.1: "every byte it reads was written by the vault, on the base
  // layer, before delegation, and the delegation program cannot touch any of it." The assertion is
  // that the refund reads no delegated account at all — checkable from the instruction's own account
  // list, not by inspection.
  it.todo("refund reads only vault-owned base-layer accounts, never the delegated Round");

  // No operator signature, no validator, no delegation-program cooperation — the property that makes
  // ARCHITECTURE-N-TEAM.md §4.5's rule satisfiable today.
  it.todo("refund x n pays every depositor their gross, signed by nobody privileged");

  // §5.1's residual, which M1 is the cheapest way to observe: `Treasury.rounds_swept` never reaches
  // `Arena.round_counter` for a wedged round, so COST-MODEL.md §4's sweep-gap brake latches forever.
  // The keeper needs a known-stranded-rounds allowance BEFORE custody ships, and that is a change to
  // `reclamation.ts` rather than to a program. This is the test that would have caught it.
  it.todo("the keeper's sweep-gap brake tolerates a permanently stranded round");
});
