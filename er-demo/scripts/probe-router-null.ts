#!/usr/bin/env bun
// DOES A ROUND THAT STILL EXISTS EVER READ AS `null` THROUGH THE MAGIC ROUTER?
//
//   cd er-demo && bun run scripts/probe-router-null.ts
//
// ── THE HYPOTHESIS THIS FILE EXISTS TO SETTLE ────────────────────────────────────────────────────
//
// `closeOneFinishedRound` (scripts/keeper/keeper.ts) reaches its round with `fetchRound`, and
// `fetchRound` goes THROUGH THE ROUTER — chainClient.ts:350, "a delegated round comes back as the ER
// sees it". When it answers `null` the keeper files the round as ALREADY CLOSED: it records nothing
// in the stranded ledger, it steps the cursor past, and it never looks at that round again.
//
// But `isDelegated` reads the BASE LAYER (chainClient.ts:345), and chainClient.ts:122 states the
// governing rule in as many words: EXISTENCE IS A BASE-LAYER FACT. `close_round_account` runs on the
// base layer, a delegated round still HAS its account there (owned by the Delegation Program), and a
// closed one is gone from there. So "does this round exist" and "what does the router say about this
// round" are two different questions, and only one of them is the one being asked.
//
// The failure that would follow, if the router can answer `null` for a delegated round that exists:
//
//   1. the round is filed as already-closed and drops out of `closer.stranded.stillDelegated`;
//   2. the close cursor walks on past the retention boundary, which sets `closeCursorCaughtUp`;
//   3. that latch is what lets `strandedLedgerIsComplete` go true, which withdraws the PROVISIONAL
//      whole-cap allowance and replaces it with the ledger's own (now short) count;
//   4. `sweepGapStop` then compares the RAW `round_counter - rounds_swept` gap — which still counts
//      every mis-read round, because the chain's bookkeeping is not fooled — against an allowance
//      that is short by however many rounds were mis-read;
//   5. and the error is UNBOUNDED BY THE CAP, because the cap bounds what the ledger may excuse, not
//      how wrong the ledger may be. `/reclamation.json` publishes `ledgerComplete: true` beside it.
//
// `closeCursor.ts:329` already refuses to read a non-answer as "closed" for exactly this reason —
// "treating it as a failed read rather than as N closed rounds". The per-round path has no such
// guard, and skips the base-layer read that would contradict it, for the price of one
// `getAccountInfo`.
//
// ── WHAT WOULD CONFIRM IT, AND WHAT WOULD DISPROVE IT ────────────────────────────────────────────
//
// CONFIRMED if a round that the BASE LAYER says exists reads as `null` through the router's path.
// DISPROVEN if the router, for every such round, either returns the account or REJECTS the read —
// an error is a safe answer here, because `withReadRetry` rethrows it and the round is retried on a
// later pass rather than filed as closed. Only a confident `null` is dangerous.
//
// ROUND #295 IS THE CENTREPIECE and is pinned by number rather than discovered. It is permanently
// stuck DELEGATED — the class of account the whole hypothesis is about — and no other round on this
// arena is reliably in that state, so a probe that only sampled recent history could run green for
// months and prove nothing. See `PINNED_ROUNDS`.
//
// ── THE MECHANISM ARM, WHICH IS WHY THIS IS NOT JUST TWO READS ───────────────────────────────────
//
// A bare `router says X, base says Y` table would establish the fact and explain none of it, and the
// explanation is what tells the next reader whether the answer can change. So for every delegated
// round this also asks the router `getDelegationStatus` and then reads THE ER VALIDATOR DIRECTLY at
// the fqdn that comes back. Three readings, and the triple separates cases a pair cannot:
//
//   * ER serves ROLLUP STATE, router serves it too   — routing works, nothing to see.
//   * ER serves the BASE LAYER'S COPY                — the ER does not hold the round and did not say
//                                                      so. The hypothesis's trigger does not exist.
//   * ER answers NOT FOUND, router answers null      — CONFIRMED, and the mechanism is named.
//   * ER unreachable, router answers null            — CONFIRMED, and worse: the trigger is any
//                                                      validator outage, not a rare ER reset.
//
// THE OWNER BYTE IS WHAT TELLS THE FIRST TWO APART, and it needs no cooperation from the validator.
// A delegated round is owned by `bulls-arena` INSIDE the rollup — that is what makes it mutable
// there — and by the DELEGATION PROGRAM on the base layer, which is the fact `isDelegated` reads.
// So one endpoint returning both owners for two different rounds, on one run, is the whole proof.
// See `heldByEr`, and the fallback arm that follows it with a positive and a negative control.
//
// EXIT CODE SAYS "IS THIS RUN BELIEVABLE", NOT "IS THE NEWS GOOD" — the same convention
// `probe-forced-undelegation.ts` follows. Confirmed and disproven both exit 0, because both are
// results. A failed control or a self-contradictory reading exits 1, because neither is.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────────────────────────
//
// READ-ONLY AND SAFE BESIDE THE RUNNING KEEPER — the same property, for the same reasons, as
// `reclaim-status.ts` and `probe-forced-undelegation.ts`. It signs nothing and sends nothing. Every
// call is `getAccountInfo`, `getMultipleAccountsInfo` or `getDelegationStatus`. NO KEY IS LOADED
// FROM `.devnet/`: Anchor's provider needs a wallet to construct, so it gets a `Keypair.generate()`
// that exists for the lifetime of the process, never signs, and is never funded — the provider
// wallet is only consulted by the account resolver when BUILDING transactions, and this file builds
// none. Every endpoint passes `assertDevnetUrl`, including the ER fqdn that arrives from the router
// and is therefore from off this machine.
//
// The read volume is deliberately tiny — one batched existence read plus a handful of per-round
// reads — because the base RPC's rate limit is the constraint that shapes the keeper process, and a
// probe that got the keeper 429'd while proving a point about the keeper would be a poor trade.
//
// ── REJECTED ALTERNATIVES ───────────────────────────────────────────────────────────────────────
//
// REJECTED: reproducing the read by hand as `router.getAccountInfo(pda)` alone. `fetchRound` calls
// Anchor's `account.round.fetchNullable`, and in @coral-xyz/anchor 0.32.1 that returns null for BOTH
// a missing account AND an account with zero-length data, and does NOT check the owner
// (`fetchNullableAndContext` in account.js). Those are different behaviours from a bare
// `getAccountInfo` and the difference is exactly the kind of detail this probe must not paper over.
// So BOTH are run: the raw router read says what the router sent, and the Anchor read says what the
// keeper would have concluded from it.
//
// REJECTED: forcing the condition by delegating a round to a validator and resetting it. That is the
// clean experiment and it is not available — we do not operate MagicBlock's validators, and the one
// account already in the target state (#295) is on the LIVE arena, where the keeper is running. This
// probe observes; it does not arrange.
//
// REJECTED: deciding it from the SDK source instead of the network. `ConnectionMagicRouter` extends
// `Connection` and adds no `getAccountInfo` override (node_modules/@magicblock-labs/
// ephemeral-rollups-sdk/lib/magic-router.js) — every routing decision is made SERVER-SIDE by
// `devnet-router.magicblock.app`. There is no local code to read that could answer this, which is
// precisely why it needed a probe against the live router and not a code review.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ConnectionMagicRouter, DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

import { assertDevnetUrl } from "../src/devnet-guard.ts";
import { BASE_RPC, PHASE_NAME, PROGRAM_ID, ROUTER_URL } from "../src/chain/constants.ts";
import { createProgram, type BullsArenaProgram } from "../src/chain/program.ts";
import { createBurnerWallet } from "../src/chain/useSigner.ts";
import { arenaPda as deriveArenaPda, roundPdaForRoundNo } from "../src/chain/round.ts";

// The guards run at `constants.ts` import time already. Repeated here for the reason
// `probe-forced-undelegation.ts` repeats them: it puts the refusal IN THIS FILE, so a future edit
// that swaps either constant for a literal or an env read cannot quietly drop the assertion along
// with the import.
assertDevnetUrl(BASE_RPC, "base devnet RPC");
assertDevnetUrl(ROUTER_URL, "Magic Router");

/** Rounds named rather than discovered, because the interesting states are not the common ones.
 *
 *  #295 IS THE PROBE. It is permanently stuck DELEGATED on the live arena — the exact class of
 *  account the hypothesis is about, and the only one of its kind here. Discovery cannot be trusted
 *  to find it: a scan for "delegated and old" would come up empty on any arena where the keeper has
 *  been healthy, and a probe that silently degrades to proving nothing is worse than one that fails
 *  loudly. If this round is ever closed or rescued, this constant is the line to change, and the run
 *  will say so rather than quietly sampling something else. */
const PINNED_ROUNDS = [295n];

/** How far back to reach for a "genuinely closed" round. The first null in #1..#N is one the chain
 *  itself says is gone, which is the control the confirmed case has to be distinguished FROM: if a
 *  closed round did not read null through the router, the keeper's already-closed branch would never
 *  fire at all and the finding would be moot for a different reason. */
const CLOSED_SEARCH_DEPTH = 100;

/** A round number no arena will reach in the life of this demo. The negative control: BOTH layers
 *  must answer null, or "null" is not even a value this probe can observe and no verdict below
 *  means anything. */
const IMPOSSIBLE_ROUND = 9_999_999n;

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const heading = (s: string) => console.log(`\n${c.b}${s}${c.x}`);
const info = (s: string) => console.log(`  ${c.d}${s}${c.x}`);
const ok = (s: string) => console.log(`  ${c.g}✓${c.x} ${s}`);
const bad = (s: string) => console.log(`  ${c.r}✗${c.x} ${s}`);
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

const base = new Connection(BASE_RPC, "confirmed");
const router = new ConnectionMagicRouter(ROUTER_URL, "confirmed");

/** The owner, said in words. `SystemProgram` never appears for a round and is listed anyway: a round
 *  PDA owned by nobody would mean the derivation is wrong, and a table of raw base58 would hide that
 *  behind a string nobody reads twice. */
function ownerName(owner: PublicKey): string {
  if (owner.equals(PROGRAM_ID)) return "bulls-arena";
  if (owner.equals(DELEGATION_PROGRAM_ID)) return "DELEGATION PROGRAM";
  if (owner.equals(PublicKey.default)) return "system";
  return owner.toBase58();
}

/** Everything one round has to say, from every layer that has an opinion about it. */
interface RoundReading {
  roundNo: bigint;
  pda: PublicKey;
  label: string;
  /** THE BASE LAYER'S ANSWER, which is the one that decides whether the round EXISTS. */
  baseExists: boolean;
  baseOwner: string | null;
  baseDataLen: number | null;
  /** THE ROUTER'S RAW ANSWER — what the router actually sent, before Anchor interpreted it. */
  routerRaw: { kind: "account"; owner: string; dataLen: number } | { kind: "null" } | { kind: "error"; message: string };
  /** WHAT `fetchRound` WOULD HAVE RETURNED, which is what the keeper acts on. `null` here beside a
   *  `baseExists: true` above is the whole finding. */
  fetchRound: { kind: "decoded"; phase: number } | { kind: "null" } | { kind: "error"; message: string };
  /** The router's own view of delegation, which is a separate service from account routing —
   *  `getDelegationStatus` is a bespoke POST route, not a JSON-RPC method (magic-router.js). */
  delegation: { isDelegated: boolean; fqdn: string | null } | { error: string };
}

async function readRound(program: BullsArenaProgram, arena: PublicKey, roundNo: bigint, label: string): Promise<RoundReading> {
  const pda = roundPdaForRoundNo(roundNo, arena);

  const baseInfo = await base.getAccountInfo(pda);

  let routerRaw: RoundReading["routerRaw"];
  try {
    const acct = await router.getAccountInfo(pda);
    routerRaw = acct === null
      ? { kind: "null" }
      : { kind: "account", owner: ownerName(acct.owner), dataLen: acct.data.length };
  } catch (e) {
    routerRaw = { kind: "error", message: describe(e) };
  }

  // THE KEEPER'S OWN CALL, not an approximation of it. Same router-bound `program`, same
  // `fetchNullable`, same decoder — `fetchRound` in chainClient.ts is these two lines.
  let fetched: RoundReading["fetchRound"];
  try {
    const round = await program.account.round.fetchNullable(pda);
    fetched = round === null ? { kind: "null" } : { kind: "decoded", phase: round.phase };
  } catch (e) {
    fetched = { kind: "error", message: describe(e) };
  }

  let delegation: RoundReading["delegation"];
  try {
    const status = await router.getDelegationStatus(pda) as { isDelegated?: boolean; fqdn?: string } | null;
    delegation = { isDelegated: status?.isDelegated === true, fqdn: status?.fqdn ?? null };
  } catch (e) {
    delegation = { error: describe(e) };
  }

  return {
    roundNo,
    pda,
    label,
    baseExists: baseInfo !== null,
    baseOwner: baseInfo === null ? null : ownerName(baseInfo.owner),
    baseDataLen: baseInfo === null ? null : baseInfo.data.length,
    routerRaw,
    fetchRound: fetched,
    delegation,
  };
}

function renderReading(r: RoundReading): void {
  const baseLine = r.baseExists
    ? `${c.g}EXISTS${c.x}  owner ${r.baseOwner}, ${r.baseDataLen} bytes`
    : `${c.d}absent${c.x}`;
  const routerLine = r.routerRaw.kind === "account"
    ? `${c.g}account${c.x}  owner ${r.routerRaw.owner}, ${r.routerRaw.dataLen} bytes`
    : r.routerRaw.kind === "null"
      ? `${c.y}null${c.x}`
      : `${c.r}ERROR${c.x}  ${r.routerRaw.message}`;
  const fetchLine = r.fetchRound.kind === "decoded"
    ? `${c.g}${PHASE_NAME[r.fetchRound.phase] ?? `phase ${r.fetchRound.phase}`}${c.x}`
    : r.fetchRound.kind === "null"
      ? `${c.y}null  → the keeper would file this round as ALREADY CLOSED${c.x}`
      : `${c.r}ERROR${c.x}  ${r.fetchRound.message}`;
  const delegationLine = "error" in r.delegation
    ? `${c.r}ERROR${c.x}  ${r.delegation.error}`
    : `${r.delegation.isDelegated ? `${c.y}DELEGATED${c.x}` : "not delegated"}${r.delegation.fqdn ? `  → ${r.delegation.fqdn}` : ""}`;

  console.log(`\n  ${c.b}round #${r.roundNo}${c.x}  ${c.d}${r.label}${c.x}`);
  info(`pda                 ${r.pda.toBase58()}`);
  console.log(`    base layer          ${baseLine}`);
  console.log(`    router getAccountInfo ${routerLine}`);
  console.log(`    fetchRound (Anchor) ${fetchLine}`);
  console.log(`    getDelegationStatus ${delegationLine}`);
}

// ── the arena, and which rounds to look at ───────────────────────────────────────────────────────

heading("the arena");

// The wallet exists so `AnchorProvider` can be constructed. It never signs — see this file's SAFETY
// note. Generated rather than read from `.devnet/`, so the probe cannot be the thing that leaks a key
// into a log, and so it runs for anybody with the repo and no operator keypair.
const program = await createProgram(router, createBurnerWallet(Keypair.generate()));
const programBase = await createProgram(base, createBurnerWallet(Keypair.generate()));
const arena = deriveArenaPda();

// From the BASE layer: the arena is never delegated, so the router would be a hop that decides
// nothing — and reading the round counter through the thing under investigation would be a poor
// start. This mirrors `readChainState`.
const arenaAccount = await programBase.account.arena.fetchNullable(arena);
if (!arenaAccount) throw new Error(`no arena at ${arena.toBase58()} for program ${PROGRAM_ID.toBase58()} — nothing below can run`);
const roundCounter = BigInt(arenaAccount.roundCounter.toString());

info(`program        ${PROGRAM_ID.toBase58()}`);
info(`arena          ${arena.toBase58()}`);
info(`round_counter  ${roundCounter}  ${c.d}(the live round)${c.x}`);
info(`base rpc       ${BASE_RPC}`);
info(`router         ${ROUTER_URL}`);

// A genuinely closed round, found rather than assumed. One batched existence read from the base
// layer, which is the same `getMultipleAccountsInfo` + zero-length `dataSlice` shape `roundsExist`
// uses — see chainClient.ts:104 for why existence is asked this way and not one account at a time.
const searchDepth = Number(roundCounter < BigInt(CLOSED_SEARCH_DEPTH) ? roundCounter : BigInt(CLOSED_SEARCH_DEPTH));
const earlyNos = Array.from({ length: searchDepth }, (_, i) => BigInt(i + 1));
const earlyInfos = await base.getMultipleAccountsInfo(
  earlyNos.map((n) => roundPdaForRoundNo(n, arena)),
  { commitment: "confirmed", dataSlice: { offset: 0, length: 0 } },
);
const closedIndex = earlyInfos.findIndex((i) => i === null);
const closedRound = closedIndex >= 0 ? earlyNos[closedIndex]! : null;
info(`closed control ${closedRound === null
  ? `${c.y}none found in #1-#${searchDepth} — the closed-round control is UNAVAILABLE on this arena${c.x}`
  : `#${closedRound}  (first round in #1-#${searchDepth} the base layer says is gone)`}`);

/** Every round this run will read, each with the reason it is in the list. Ordered oldest first so
 *  the table reads as history. Deduplicated because on a young arena the pinned round and a
 *  mid-history pick can collide, and reading one round twice would put two rows in the verdict for
 *  one fact. */
const targets = new Map<bigint, string>();
const want = (roundNo: bigint, label: string) => {
  if (roundNo >= 1n && roundNo <= roundCounter && !targets.has(roundNo)) targets.set(roundNo, label);
};

if (closedRound !== null) want(closedRound, "control — genuinely closed, the chain says gone");
for (const pinned of PINNED_ROUNDS) {
  if (pinned > roundCounter) {
    bad(`pinned round #${pinned} is past round_counter ${roundCounter} — this arena is not the one PINNED_ROUNDS was written for`);
  } else {
    want(pinned, "THE CASE — permanently stuck DELEGATED");
  }
}
want(roundCounter / 4n, "mid-history");
want(roundCounter / 2n, "mid-history");
want((roundCounter * 3n) / 4n, "mid-history");
want(roundCounter - 5n, "recent history");
want(roundCounter - 1n, "the previous round");
want(roundCounter, "THE LIVE ROUND");

const ordered = [...targets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

// ── the readings ─────────────────────────────────────────────────────────────────────────────────

heading("what each layer says about each round");

const readings: RoundReading[] = [];
for (const [roundNo, label] of ordered) {
  const reading = await readRound(program, arena, roundNo, label);
  readings.push(reading);
  renderReading(reading);
}

// ── the negative control ─────────────────────────────────────────────────────────────────────────

heading("negative control — a round that has never existed");

const impossible = await readRound(program, arena, IMPOSSIBLE_ROUND, "control — never opened");
renderReading(impossible);
const controlHolds = !impossible.baseExists && impossible.fetchRound.kind === "null";
(controlHolds ? ok : bad)(
  controlHolds
    ? "both layers answer null for an account that does not exist — 'null' is a value this probe can observe"
    : "the never-opened round did NOT read null on both layers. Nothing below means anything: this probe cannot tell null from anything else.",
);

// ── the mechanism arm ────────────────────────────────────────────────────────────────────────────

heading("mechanism — asking each delegated round's own ER validator directly");

/** The delegated rounds, as the ROUTER classifies them. Deliberately the router's opinion and not
 *  the base-layer owner: the question in this arm is what the ROUTER does with an account it
 *  believes is delegated, so its own belief is the right selector. Where the two disagree, the table
 *  above already shows both. */
const delegatedReadings = readings.filter((r) => !("error" in r.delegation) && r.delegation.isDelegated);
if (delegatedReadings.length === 0) {
  info("no round in this sample is delegated — the mechanism arm has nothing to ask.");
  info("That is NOT a disproof; it means this run sampled no account in the state that matters.");
}

/** WHOSE COPY DID THE ER JUST HAND BACK — and the OWNER is what answers it, which is the whole trick
 *  of this arm.
 *
 *  A delegated account lives in the rollup owned by the PROGRAM, because that is the point of
 *  delegating it: the ER has to be able to mutate it. On the base layer the same account is owned by
 *  the DELEGATION PROGRAM, which is what `isDelegated` reads. So the owner byte says which of the
 *  two an answer came from, and it says it without needing the validator to admit anything:
 *
 *    owner bulls-arena        — live rollup state. The ER really holds this round.
 *    owner DELEGATION PROGRAM — the BASE LAYER's copy. The ER does not hold this round and answered
 *                               from the base layer instead of saying "not found".
 *
 *  That second row is the one the hypothesis said was impossible, and it is not a subtle reading —
 *  the two live delegated rounds below come back with DIFFERENT owners from the SAME endpoint. */
function heldByEr(owner: PublicKey): boolean {
  return owner.equals(PROGRAM_ID);
}

interface ErReading { roundNo: bigint; fqdn: string; result: "rollup-state" | "base-layer-copy" | "null" | "unreachable"; detail: string }
const erReadings: ErReading[] = [];

for (const r of delegatedReadings) {
  const fqdn = "error" in r.delegation ? null : r.delegation.fqdn;
  if (fqdn === null) {
    info(`round #${r.roundNo} — the router reports it delegated but names no fqdn; nothing to ask`);
    continue;
  }
  // The fqdn came from the router, which is to say from off this machine. `acceptsWrites` in
  // chainClient.ts makes the same assertion for the same reason: a claim that this file only ever
  // talks to devnet must be true by inspection, not by trusting a remote service's string.
  assertDevnetUrl(fqdn, "ER validator");
  const er = new Connection(fqdn, "confirmed");
  try {
    const acct = await er.getAccountInfo(r.pda);
    erReadings.push(acct === null
      ? { roundNo: r.roundNo, fqdn, result: "null", detail: "the ER answered ACCOUNT NOT FOUND" }
      : heldByEr(acct.owner)
        ? { roundNo: r.roundNo, fqdn, result: "rollup-state", detail: `live in the rollup — owner ${ownerName(acct.owner)}, ${acct.data.length} bytes` }
        : { roundNo: r.roundNo, fqdn, result: "base-layer-copy", detail: `NOT in the rollup — owner ${ownerName(acct.owner)}, so this is the base layer's copy` });
  } catch (e) {
    erReadings.push({ roundNo: r.roundNo, fqdn, result: "unreachable", detail: describe(e) });
  }
}

for (const er of erReadings) {
  const mark = er.result === "rollup-state" ? c.g : er.result === "base-layer-copy" ? c.y : c.r;
  console.log(`  round #${er.roundNo}  ${c.d}${er.fqdn}${c.x}  ${mark}${er.result}${c.x}  ${c.d}${er.detail}${c.x}`);
}

// ── the fallback arm, and its two controls ───────────────────────────────────────────────────────

heading("does the ER validator FALL BACK to the base layer, or can it answer 'not found'?");

info("THE QUESTION THE HYPOTHESIS RESTS ON. It assumes an ER that no longer holds a round answers");
info("'account not found'. If instead the ER serves the base layer's copy, an existing round can");
info("never read as null through it, and the finding has no trigger. Two controls settle it:");
info("");
info("  POSITIVE — the ARENA pda, which is never delegated and lives only on the base layer. If the");
info("             ER returns it, the ER is answering for accounts it does not hold.");
info("  NEGATIVE — the never-opened pda from the control above. The ER MUST answer null for it, or");
info("             'not found' is not a thing this endpoint says at all and the positive proves");
info("             nothing.");

/** Each distinct validator seen above, asked once. Distinct rather than once per round because the
 *  answer is a property of the ENDPOINT, and asking the same one twice would read as two results. */
const fqdns = [...new Set(erReadings.map((e) => e.fqdn))];
if (fqdns.length === 0) info("\n  no ER validator was named by this run — nothing to ask.");

let fallbackObserved = false;
let erCanSayNull = false;
for (const fqdn of fqdns) {
  assertDevnetUrl(fqdn, "ER validator");
  const er = new Connection(fqdn, "confirmed");
  console.log(`\n  ${c.b}${fqdn}${c.x}`);
  try {
    const arenaFromEr = await er.getAccountInfo(arena);
    const served = arenaFromEr !== null;
    fallbackObserved ||= served;
    (served ? ok : info)(served
      ? `positive — it served the arena account (owner ${ownerName(arenaFromEr.owner)}, ${arenaFromEr.data.length} bytes). ${c.b}IT FALLS BACK TO THE BASE LAYER.${c.x}`
      : "positive — it answered null for the arena, so it serves ONLY its own rollup state");
  } catch (e) {
    bad(`positive control unreadable: ${describe(e)}`);
  }
  try {
    const nothingFromEr = await er.getAccountInfo(impossible.pda);
    erCanSayNull ||= nothingFromEr === null;
    (nothingFromEr === null ? ok : bad)(nothingFromEr === null
      ? "negative — it answered null for an account that exists nowhere, so 'not found' IS a value it returns"
      : "negative — it returned an account for a pda that has never existed. This endpoint's answers cannot be interpreted.");
  } catch (e) {
    bad(`negative control unreadable: ${describe(e)}`);
  }
}

// ── VERDICT ──────────────────────────────────────────────────────────────────────────────────────

heading("VERDICT");

/** The finding, stated as a predicate over one round: the BASE LAYER says the account is there, and
 *  `fetchRound` — the call `closeOneFinishedRound` actually makes — answered `null`. An ERROR from
 *  `fetchRound` is deliberately NOT in this set: `withReadRetry` rethrows it, the pass aborts, and
 *  the round is examined again next pass. Only a confident null files the round as closed. */
const misread = readings.filter((r) => r.baseExists && r.fetchRound.kind === "null");

/** The same predicate on the RAW router read. Separated because the two would be fixed in different
 *  places: a raw null is the router's behaviour, whereas a raw account that Anchor turned into null
 *  would be a decode/zero-length case belonging to `program.ts`. */
const rawMisread = readings.filter((r) => r.baseExists && r.routerRaw.kind === "null");

if (!controlHolds) {
  console.log(`\n${c.r}${c.b}  NO VERDICT — THE NEGATIVE CONTROL FAILED.${c.x}`);
  console.log(`  ${c.d}Do not record a result from this run. Read the control block above first.${c.x}\n`);
  process.exit(1);
}

if (misread.length > 0) {
  console.log(`\n${c.r}${c.b}  ████  CONFIRMED — A ROUND THAT EXISTS READS AS null THROUGH THE ROUTER.  ████${c.x}\n`);
  for (const r of misread) {
    console.log(`  round #${r.roundNo}  ${c.d}${r.label}${c.x}`);
    console.log(`    base layer says: EXISTS, owner ${r.baseOwner}, ${r.baseDataLen} bytes`);
    console.log(`    fetchRound says: null — closeOneFinishedRound files it as already-closed and steps past`);
  }
  console.log(
    `\n  ${c.b}WHAT THIS COSTS.${c.x} Each round above is dropped from the stranded ledger permanently while\n` +
    `  remaining in the raw ${c.d}round_counter - rounds_swept${c.x} gap forever. Once the cursor passes the\n` +
    `  retention boundary the ledger latches complete, the provisional whole-cap allowance is\n` +
    `  withdrawn, and \`sweepGapStop\` compares the raw gap against a ledger short by this many rounds —\n` +
    `  an error the allowance cap does not bound — with \`ledgerComplete: true\` published beside it.\n\n` +
    `  ${c.b}THE FIX${c.x} is the guard \`closeCursor.ts:329\` already applies one layer up: on the null branch,\n` +
    `  one base-layer \`getAccountInfo\`, and refuse to file the round as already-closed when the base\n` +
    `  layer disagrees. On the null branch only, so the healthy path costs nothing.`,
  );
  process.exit(0);
}

if (rawMisread.length > 0) {
  console.log(`\n${c.y}${c.b}  PARTIAL — the router returned null for an existing round, but Anchor did not.${c.x}`);
  console.log(`  ${c.d}That combination should not be reachable: fetchNullable returns null for exactly the\n` +
    `  cases getAccountInfo returns null or empty data. Re-run before recording anything — the most\n` +
    `  likely explanation is that the two reads landed either side of a state change.${c.x}\n`);
  process.exit(1);
}

console.log(`\n${c.g}${c.b}  DISPROVEN ON THIS RUN — no round that exists read as null through the router.${c.x}\n`);
console.log(
  `  Every round the base layer says exists came back from \`fetchRound\` as an account or as an\n` +
  `  ERROR, and an error is safe: \`withReadRetry\` rethrows it, the pass aborts, and the round is\n` +
  `  examined again on the next one. Only a confident null files a round as already-closed.\n`,
);
if (delegatedReadings.length === 0) {
  console.log(
    `  ${c.y}${c.b}READ THIS BEFORE CLOSING THE QUESTION:${c.x} this run sampled ${c.b}no delegated round${c.x}, which is the\n` +
    `  only state the hypothesis is about. It is evidence that the ordinary path is sound and it is\n` +
    `  NOT evidence about the ER-reset case. Re-run when a round is delegated — \`PINNED_ROUNDS\` names\n` +
    `  #295 for exactly this reason.\n`,
  );
  process.exit(0);
}

const strayed = erReadings.filter((e) => e.result === "base-layer-copy");
console.log(`  ${delegatedReadings.length} delegated round(s) were in the sample, so the state that matters WAS observed.\n`);

if (strayed.length > 0 && fallbackObserved && erCanSayNull) {
  // THE STRONG FORM. Not "it did not happen" but "here is the reason it cannot", which is the only
  // kind of negative result worth recording — the other kind expires the first time the sample
  // changes.
  console.log(
    `  ${c.b}AND THE MECHANISM IS NAMED, WHICH IS WHY THIS IS A RESULT AND NOT JUST A QUIET RUN:${c.x}\n\n` +
    `   1. ${strayed.map((e) => `#${e.roundNo}`).join(", ")} — asked of ${strayed.length === 1 ? "its own ER validator" : "their own ER validators"}, came back owned by the\n` +
    `      DELEGATION PROGRAM. A round the ER genuinely holds is owned by ${c.b}bulls-arena${c.x} there — that is\n` +
    `      what makes it mutable in the rollup, and it is exactly what the live round returned from\n` +
    `      the SAME endpoint on this run. So the ER does not hold ${strayed.length === 1 ? "that round" : "those rounds"}, and it did not say\n` +
    `      so: it served the base layer's copy.\n` +
    `   2. The positive control confirms that directly — the ER served the ARENA account, which is\n` +
    `      never delegated and exists only on the base layer.\n` +
    `   3. The negative control rules out the boring explanation: the ER DOES answer null, for a pda\n` +
    `      that exists nowhere. It is choosing to fall back, not incapable of refusing.\n\n` +
    `  ${c.b}SO THE HYPOTHESIS'S PREMISE IS FALSE ON THIS PLATFORM.${c.x} "An ER that has been reset answers\n` +
    `  'account not found'" is the trigger the whole finding needs, and this ER answers with the\n` +
    `  base-layer account instead. A round that exists on the base layer cannot read as null through\n` +
    `  either hop, because both hops END AT the base layer.\n\n` +
    `  ${c.y}${c.b}WHAT WOULD REOPEN IT.${c.x} This is MagicBlock's behaviour, not this repo's, and no contract we\n` +
    `  hold obliges them to keep it. If a future validator or router serves only its own rollup\n` +
    `  state, the finding becomes live again with nothing in this codebase having changed. That is\n` +
    `  the residual, and it is why this file is committed rather than the answer just written down:\n` +
    `  ${c.b}re-run it after any MagicBlock platform upgrade.${c.x}\n`,
  );
} else {
  console.log(
    `  ${c.y}But the hard question was never asked.${c.x} Every delegated round in the sample was live in its\n` +
    `  own ER's rollup state, so nothing here exercised the "ER no longer holds it" case the finding\n` +
    `  is about. Treat this as the ordinary path working, not as the finding disproven, and re-run\n` +
    `  when a round is stuck delegated — \`PINNED_ROUNDS\` names #295 for exactly that.\n`,
  );
}
