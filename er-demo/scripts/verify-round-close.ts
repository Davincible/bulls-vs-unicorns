#!/usr/bin/env bun
// ROUND-ACCOUNT CLOSURE, PROVEN ON CHAIN — the first instruction in this program that destroys
// anything, with all three of its own refusals and Anchor's fourth exercised against a real
// validator before the one successful close is allowed to run.
//
// A `Round` is 1,102 bytes and its rent-exempt deposit is ~0.008561 SOL — 95.4% of the ~0.008971 a
// whole round costs to run — and until v7 nothing reclaimed a lamport of it, because there was no
// instruction that closed a `Round`. `close_round_account` hands that deposit back to the authority
// that paid it at `open_round`. Being irreversible, the conditions under which it must NOT run
// matter at least as much as the reclaim, which is why four of the five claims below are refusals.
//
// What this script proves, and refuses to pass without:
//
//   1. THE RENT COMES BACK, AND THE ARITHMETIC RECONCILES TO THE LAMPORT. A settled-or-abandoned,
//      swept round older than the retention window is closed: its account exists before and reads
//      back `null` after, and the authority's balance rises by exactly the account's pre-close
//      lamports MINUS the transaction fee. Both sides come from the ledger's own record of that
//      transaction (see `closeAndReconcile` for why a `getBalance` pair straddling the send is the
//      wrong instrument). The `RoundAccountClosed` event is decoded out of the logs and its
//      `lamports_returned` asserted equal to the same figure — an event nobody checks is an event
//      that can start lying without anyone noticing.
//
//   2. A ROUND INSIDE THE RETENTION WINDOW IS REFUSED WITH `RoundTooRecent`, and the round used is
//      terminal AND already swept — so the window is the ONLY condition it fails. A refusal against
//      a round that was merely unfinished would fire on the phase guard and prove nothing about the
//      window, which is the guarantee `useHistory` actually leans on.
//
//   3. AN UNSWEPT ROUND IS REFUSED WITH `RoundNotSwept`. Terminal, and old enough that the window
//      would release it — it differs from case 1 in the sweep and in nothing else. This is the
//      ordering that stops a round's `fees_collected` being deleted before it is aggregated, and it
//      is only worth anything if the flag alone can cause the refusal.
//
//   4. A NON-AUTHORITY IS REFUSED. A freshly generated burner signs a close of the very round case 1
//      goes on to close successfully, so the refusal cannot be explained by the round being
//      ineligible. The error is Anchor's `ConstraintHasOne` (2001), NOT a custom one — see the call
//      site for why, and do not "fix" it to `NotTheAuthority`.
//
//   5. THE FREED ADDRESS STAYS DEAD. Immediately after case 1 succeeds, `open_round` is aimed at the
//      closed round's own PDA and must be refused with `RoundOutOfOrder`. `CloseRoundAccount`'s doc
//      comment names this as the property that makes deletion safe rather than merely tidy — a
//      resurrectable address would let a round number come back holding different numbers — and it
//      costs one preflight-rejected transaction to stop taking it on faith.
//
// Not proven here and deliberately not claimed:
//
//   `RoundNotTerminal`, the remaining condition in `check_close_permitted`, is not exercised.
//   Reaching it needs a non-terminal round the program still owns, which on the base layer means one
//   that was never delegated — and such a round is unswept and inside the window as well, so a
//   refusal would not say WHICH guard fired. Isolating it is exactly what a native test can do and
//   this cannot; `check_close_permitted`'s own tests in lib.rs vary one condition at a time.
//
//   NO `Settled` ROUND IS CLOSED HERE. All three worked rounds reach a terminal phase through
//   `abandon_round`, so what is proven is the `Phase::Abandoned` arm of the phase guard. The other
//   arm is the same `require!` — one boolean, both halves on one line — and a real fight driven to
//   `Settled` and swept is already what scripts/verify-house-take.ts does. Paying a VRF round trip
//   and two fighters' stakes to re-prove that here would buy nothing.
//
//   NOTHING IS READ BACK THROUGH THE UI. That the newest `MIN_RETAINED_ROUNDS` rounds stay fetchable
//   is a property of the guard in case 2, not of `useHistory`; this script asserts the guard.
//
//   cd er-demo && bun run scripts/verify-round-close.ts

// Importing chain/constants.ts is what runs this repo's `assertDevnetUrl` guards — the router URL and
// the base RPC are asserted devnet at module load, before a line of this file executes, so a mainnet
// endpoint fails the import rather than reaching an instruction that deletes accounts.
import {
  BASE_RPC, MIN_LOBBY_SECONDS, MIN_RETAINED_ROUNDS, PHASE_NAME, Phase, PROGRAM_ID, ROUTER_URL,
} from "../src/chain/constants.ts";
import { createProgram } from "../src/chain/program.ts";
import { sendTx } from "../src/chain/sendTx.ts";
import { createBurnerWallet } from "../src/chain/useSigner.ts";
import * as roundIx from "../src/chain/round.ts";
import { loadIdl } from "../src/chain/idl.ts";
import { NO_FRESH_VALIDATOR, pickValidator } from "./erValidator.ts";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from "@solana/web3.js";
import { AnchorError, BorshCoder, EventParser } from "@coral-xyz/anchor";
import { ConnectionMagicRouter, DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s: string) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s: string) => console.log(`  ${c.d}${s}${c.x}`);
const warn = (s: string) => console.log(`  ${c.y}!${c.x} ${s}`);
const heading = (s: string) => console.log(`\n${c.b}${s}${c.x}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports: bigint | number) => `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`;

/** Fail loudly with the two numbers side by side. A verification script whose assertions print only
 *  "expected true" is a script you cannot debug from its own transcript. */
function assertEq(actual: bigint, expected: bigint, what: string): void {
  if (actual !== expected) throw new Error(`${what}\n      expected ${expected}\n      actual   ${actual}`);
  ok(`${what} — ${actual}`);
}

/** Read the BASE layer until it reflects a write we have already watched confirm somewhere else.
 *
 *  NOT A SLEEP, AND NOT PARANOIA — `sendTx` confirms against the ROUTER (or an ER validator's own
 *  RPC); every assertion below reads a plain devnet node, and those are different machines. The
 *  house-take script died on exactly this: an account created and finalised in one slot, then read
 *  back as "does not exist" from a base RPC that was simply behind. Raising the commitment does not
 *  fix it (the write is already confirmed; it is the READER that has to catch up) and a fixed sleep
 *  only moves the race.
 *
 *  `accept` covers the second, nastier shape: an account that already exists and comes back with its
 *  PREVIOUS contents. Callers checking the effect of a write pass a predicate and get the post-write
 *  value or a loud failure — never a silently stale one.
 *
 *  Times out rather than looping forever, so a write that genuinely never landed is reported as such
 *  instead of hanging the run. */
async function readSettled<T>(
  what: string,
  read: () => Promise<T | null>,
  accept: (value: T) => boolean = () => true,
  timeoutMs = 30_000,
): Promise<T> {
  const started = Date.now();
  let sawValue = false;
  for (;;) {
    let value: T | null = null;
    try {
      value = await read();
    } catch {
      value = null;                      // anchor throws rather than returning null on a missing account
    }
    if (value !== null) {
      sawValue = true;
      if (accept(value)) return value;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `${what}: the base layer never caught up within ${timeoutMs}ms — ` +
        (sawValue ? "it is readable but still holds its pre-write contents" : "it is still not readable"),
      );
    }
    await sleep(1000);
  }
}

/** `readSettled`'s cousin for conditions that produce no value — the ones where what you are waiting
 *  for is an account CHANGING HANDS or CEASING TO EXIST.
 *
 *  Three things in this run land asynchronously relative to the transaction that caused them, and all
 *  three gate a later step: delegation (`abandon_round` only runs in the rollup), undelegation
 *  (`sweep_house_take` and `close_round_account` both fail `Account<Round>`'s owner check while the
 *  Delegation Program holds it), and the disappearance of a closed account.
 *
 *  `check` returns `null` once the condition holds and otherwise the reason it does not, so a timeout
 *  reports what it last saw instead of shrugging. That distinction is the whole reason this takes a
 *  callback rather than a boolean: "owner is still DeLeGAT…" is a diagnosis; "timed out" is not. */
async function waitFor(what: string, check: () => Promise<string | null>, timeoutMs = 90_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const why = await check();
    if (why === null) return;
    if (Date.now() - started > timeoutMs) throw new Error(`${what}: gave up after ${timeoutMs / 1000}s — ${why}`);
    await sleep(2000);
  }
}

function describeError(e: unknown): string {
  if (e instanceof AnchorError) return `${e.error.errorCode.code} (${e.error.errorCode.number}): ${e.error.errorMessage}`;
  const withLogs = e as { logs?: string[]; message?: string };
  if (withLogs?.logs) return `${withLogs.message}\n${withLogs.logs.slice(-12).map((l) => "      " + l).join("\n")}`;
  return e instanceof Error ? e.message : String(e);
}

/** The anchor error code behind a failure, WHICHEVER SHAPE IT ARRIVES IN.
 *
 *  A rejected instruction reaches the client three different ways and the refusals below hit more
 *  than one of them. A transaction that is submitted and fails on chain decodes into a typed
 *  `AnchorError`; but every send here is PRE-FLIGHT SIMULATED first, and a constraint that fails in
 *  simulation is thrown by web3.js as a `SendTransactionError` — a string and a log dump, with no
 *  decoded `errorCode` anywhere on it. So fall back to the logs, where anchor prints the code it
 *  would have decoded: `AnchorError ... Error Code: ConstraintHasOne. Error Number: 2001.`
 *
 *  AND THEN A THIRD SHAPE, produced by the ER validator: `transaction verification error: ... custom
 *  program error: 0x1783` with no log messages at all. `0x1783` is 6019, a program error INDEX, so
 *  the name is recovered by looking it up in the IDL's own error table (`ERROR_NAMES`, populated at
 *  startup from the same IDL the program answers to). Derived rather than hardcoded: a renumbered
 *  error changes both sides together, and a stale table cannot make a negative test pass. */
const ERROR_NAMES = new Map<number, string>();

function anchorErrorCode(e: unknown): string | null {
  if (e instanceof AnchorError) return e.error.errorCode.code;
  const withLogs = e as { logs?: string[]; message?: string };
  const haystack = [...(withLogs?.logs ?? []), withLogs?.message ?? ""].join("\n");
  const byName = /Error Code: (\w+)\./.exec(haystack)?.[1];
  if (byName) return byName;
  const byNumber = /custom program error: 0x([0-9a-fA-F]+)/.exec(haystack)?.[1];
  return byNumber ? ERROR_NAMES.get(parseInt(byNumber, 16)) ?? null : null;
}

/** Assert that `send` is REFUSED, and refused for the stated reason. The code is checked rather than
 *  merely "it threw": a negative test that passes on the wrong error is a negative test that will
 *  keep passing after the constraint it guards is deleted — and every one of these guards an
 *  irreversible instruction. */
async function expectRejection(what: string, expectedCode: string, send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (e) {
    const code = anchorErrorCode(e);
    if (code === expectedCode) return void ok(`${what} — refused with ${expectedCode}, as it must be`);
    throw new Error(`${what}: expected ${expectedCode}, got ${code ?? "an error carrying no anchor code"}\n    ${describeError(e)}`);
  }
  throw new Error(`${what}: THE TRANSACTION SUCCEEDED. Expected it to be refused with ${expectedCode}.`);
}

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

/** How many rounds this run has to open, DERIVED from the window rather than written as 22.
 *
 *  The guard is `round_no + MIN_RETAINED_ROUNDS <= arena.round_counter`. The oldest round of the
 *  batch is `S+1` and the newest is `S+ROUNDS_TO_OPEN`; case 3's round is the second-oldest, `S+2`,
 *  and it has to be genuinely outside the window so that its missing sweep is the only thing wrong
 *  with it. `S+2 + 20 <= S+22` is therefore the binding constraint, and the batch is the window plus
 *  two. Written this way because if `MIN_RETAINED_ROUNDS` ever moves, a literal 22 would quietly
 *  stop testing what this file says it tests. */
const ROUNDS_TO_OPEN = MIN_RETAINED_ROUNDS + 2;

/** `Round::SIZE` from lib.rs, discriminator included — used ONLY to ask the chain what that many
 *  bytes cost to keep, for the up-front affordability check. Nothing is asserted against it: the
 *  rent the reclaim is reconciled against is read off the real account. */
const ROUND_ACCOUNT_BYTES = 1_102;

/** Enough for the burner in case 4 to be a valid fee payer and nothing more. It has to be funded at
 *  all because an unfunded fee payer fails preflight before the program runs, and "no record of a
 *  prior credit" is not the refusal this script is trying to observe. */
const BURNER_FUNDING = 2_000_000;

/** Room for ~40 transaction fees on top of the rent, so the affordability check fails on a balance
 *  that would have run out mid-batch rather than on one that would merely have been tight. */
const FEE_HEADROOM = 500_000;

/** `abandon_round` compares a deadline the BASE layer stamped at `open_round` against the ROLLUP's
 *  clock. The two agree to well under a second in practice, but a few seconds of slack costs nothing
 *  and removes the only timing question in the run; the retry in section 7 covers the remainder. */
const DEADLINE_MARGIN_SECONDS = 3;

(async () => {
  console.log(`${c.d}ROUND CLOSE VERIFICATION — rent reclaimed, and the four refusals that make that safe. DEVNET${c.x}`);

  const router = new ConnectionMagicRouter(ROUTER_URL, "confirmed");
  const base = new Connection(BASE_RPC, "confirmed");

  const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
  const startBalance = await base.getBalance(forkPayer.publicKey);
  info(`fork-payer  ${forkPayer.publicKey.toBase58()}  ${sol(startBalance)}`);
  info(`program     ${PROGRAM_ID.toBase58()}`);

  const idl = await loadIdl();
  // The error table the refusals are matched against — see `anchorErrorCode`. Same IDL the program
  // answers to, so the numbers cannot drift apart from the names.
  for (const e of (idl as { errors?: { code: number; name: string }[] }).errors ?? []) {
    ERROR_NAMES.set(e.code, e.name);
  }

  const authority = await createProgram(router, createBurnerWallet(forkPayer));
  const authorityBase = await createProgram(base, createBurnerWallet(forkPayer));
  const signatures: Record<string, string> = {};

  const waitForOwner = (pda: PublicKey, expected: PublicKey, what: string) => waitFor(what, async () => {
    const acct = await base.getAccountInfo(pda);
    return acct?.owner.equals(expected)
      ? null
      : `owner is ${acct?.owner.toBase58() ?? "MISSING"}, expected ${expected.toBase58()}`;
  });

  /** The successful close, and the ledger arithmetic that proves the rent actually moved.
   *
   *  BOTH BALANCES COME FROM THE TRANSACTION'S OWN `preBalances`/`postBalances`, not from a
   *  `getBalance` before the send and another after. The pair-of-reads version carries a race that
   *  has nothing to do with the instruction under test: the base RPC can serve a "before" balance
   *  that predates an earlier step's transaction, and the reconciliation then fails by one
   *  5,000-lamport fee for a reason no reader would guess. `meta` is the ledger's own record of the
   *  balance immediately before and immediately after THIS transaction — which is precisely the
   *  quantity the claim is about, and cannot be stale.
   *
   *  The round's pre-close lamports are read twice from independent places — `getAccountInfo` before
   *  the send, and the round's own slot in `preBalances` — and required to agree, so the figure the
   *  reclaim is checked against is not one this script chose for itself. */
  async function closeAndReconcile(round: PublicKey, roundNo: bigint, arena: PublicKey): Promise<bigint> {
    const before = await base.getAccountInfo(round);
    if (!before) throw new Error(`round #${roundNo} does not exist on the base layer — there is nothing to close`);
    const rent = BigInt(before.lamports);
    info(`round #${roundNo} holds ${sol(rent)} of rent across ${before.data.length} bytes`);

    const { signature } = await sendTx(
      router,
      roundIx.closeRoundAccount(authority, { arena, round, authority: forkPayer.publicKey, roundNo }),
      forkPayer,
      `close_round_account #${roundNo} (AUTHORITY)`,
    );
    signatures.closeRoundAccount = signature;

    // Gone, not merely changed: `close = authority` drains the lamports and stamps the closed-account
    // discriminator, and the runtime reaps a zero-lamport account at the end of the transaction.
    await waitFor(
      `round #${roundNo}'s account after close_round_account confirmed`,
      async () => (await base.getAccountInfo(round)) === null ? null : "it still exists on the base layer",
      30_000,
    );
    ok(`round #${roundNo}'s account is GONE — getAccountInfo returns null`);

    const tx = await readSettled(
      "the close transaction on the base layer",
      () => base.getTransaction(signature, { commitment: "confirmed" }),
      (t) => t.meta !== null,
      60_000,
    );
    const meta = tx.meta;
    if (!meta) throw new Error("the close transaction has no metadata — its fee and balances are unreadable");
    if (meta.err) throw new Error(`the close transaction failed on chain: ${JSON.stringify(meta.err)}`);

    const keys = tx.transaction.message.accountKeys;
    const authorityIndex = keys.findIndex((k) => k.equals(forkPayer.publicKey));
    const roundIndex = keys.findIndex((k) => k.equals(round));
    if (authorityIndex < 0 || roundIndex < 0) {
      throw new Error("the close transaction does not name both the authority and the round — cannot reconcile");
    }

    const fee = BigInt(meta.fee);
    const authorityPre = BigInt(meta.preBalances[authorityIndex]);
    const authorityPost = BigInt(meta.postBalances[authorityIndex]);
    info(`authority ${sol(authorityPre)} -> ${sol(authorityPost)}, fee ${fee} lamports`);

    assertEq(BigInt(meta.preBalances[roundIndex]), rent, "the round's lamports as the ledger saw them going in");
    assertEq(BigInt(meta.postBalances[roundIndex]), 0n, "the round's lamports after the close");
    assertEq(authorityPost - authorityPre, rent - fee, "the authority's balance rose by the rent MINUS the fee");

    // THE EVENT, DECODED. The only reason `RoundAccountClosed` carries `lamports_returned` is so an
    // operator can account for a reclaim from logs alone; an event nobody ever checks is an event
    // that can start lying silently. The coder is built from the RAW idl `loadIdl` returns, so the
    // names here are the Rust ones — anchor's camel-casing happens inside `new Program`, not in
    // `BorshCoder`.
    const parser = new EventParser(PROGRAM_ID, new BorshCoder(idl));
    let closed: { round_no: { toString(): string }; lamports_returned: { toString(): string } } | null = null;
    for (const event of parser.parseLogs(meta.logMessages ?? [])) {
      if (event.name === "RoundAccountClosed") closed = event.data;
    }
    if (!closed) {
      throw new Error(
        "no RoundAccountClosed event in the transaction logs — the account closed but emitted nothing. " +
        `Last logs: ${(meta.logMessages ?? []).slice(-8).join(" | ")}`,
      );
    }
    assertEq(BigInt(closed.round_no.toString()), roundNo, "RoundAccountClosed.round_no");
    assertEq(BigInt(closed.lamports_returned.toString()), rent, "RoundAccountClosed.lamports_returned");
    return rent - fee;
  }

  try {
    // ---- 0. the bytecode-cache preflight, BEFORE anything is spent ------------------------------
    // The trap this repo has paid for seven times: an ER validator serving a previous build of this
    // program id. Three rounds have to execute `abandon_round` inside the rollup, so a stale clone
    // would surface as a baffling failure two minutes and 0.19 SOL into the run. A fresh program id
    // has no clone anywhere yet, so "no clone yet" on every validator is the expected reading right
    // after a deploy — either that or CURRENT is usable; STALE is not.
    heading("0. ER validator preflight — byte-compare each clone against the local build");
    const validator = await pickValidator(null);
    if (!validator) throw new Error(NO_FRESH_VALIDATOR);
    ok(`delegating to ${validator.fqdn} (${validator.identity.toBase58().slice(0, 8)}…)`);

    // ---- 1. can the payer afford the batch at all? ----------------------------------------------
    // Asked up front because the failure it prevents is the expensive one: running dry at round #17
    // leaves sixteen rounds of rent spent, sixteen round numbers permanently consumed, and not one
    // claim proven.
    heading("1. affordability — this run opens rounds, which is where the money goes");
    const roundRent = await base.getMinimumBalanceForRentExemption(ROUND_ACCOUNT_BYTES);
    const budget = ROUNDS_TO_OPEN * roundRent + BURNER_FUNDING + FEE_HEADROOM;
    info(`${ROUNDS_TO_OPEN} rounds x ${sol(roundRent)} rent, plus ${sol(BURNER_FUNDING + FEE_HEADROOM)} of fees and burner funding = ${sol(budget)}`);
    if (startBalance < budget) {
      throw new Error(`fork-payer holds ${sol(startBalance)} but this run needs ${sol(budget)} — top it up first`);
    }
    ok(`fork-payer can cover the run (${sol(startBalance)} available)`);

    const arenaPda = roundIx.arenaPda();
    const treasuryPda = roundIx.treasuryPda(arenaPda);

    // ---- 2. init_arena / init_treasury, both skippable -------------------------------------------
    // Re-runnable by construction: this script must be safe to run twice, and both of these are
    // one-time `init`s that fail with "already in use" rather than no-op.
    heading("2. init_arena / init_treasury — created only if they are not already there");
    let arena = await authorityBase.account.arena.fetchNullable(arenaPda);
    if (!arena) {
      const { signature } = await sendTx(
        router,
        roundIx.initArena(authority, { arena: arenaPda, authority: forkPayer.publicKey, feeBps: 20 }),
        forkPayer,
        "init_arena (fee_bps=20)",
      );
      signatures.initArena = signature;
      arena = await readSettled("arena after init_arena", () => authorityBase.account.arena.fetchNullable(arenaPda));
    } else {
      ok(`arena already initialised — reusing (round_counter=${arena.roundCounter})`);
    }
    info(`arena ${arenaPda.toBase58()}  authority=${arena.authority.toBase58()}`);
    // Checked rather than assumed: `open_round` and `close_round_account` are both `has_one =
    // authority`, so an arena belonging to someone else would fail on the very first spend with an
    // error about a constraint rather than about the wallet.
    if (!arena.authority.equals(forkPayer.publicKey)) {
      throw new Error(`the arena's authority is ${arena.authority.toBase58()}, not the fork-payer — this run cannot open or close rounds here`);
    }

    if (!(await authorityBase.account.treasury.fetchNullable(treasuryPda))) {
      const { signature } = await sendTx(
        router,
        roundIx.initTreasury(authority, { arena: arenaPda, treasury: treasuryPda, authority: forkPayer.publicKey }),
        forkPayer,
        "init_treasury",
      );
      signatures.initTreasury = signature;
      await readSettled("treasury after init_treasury", () => authorityBase.account.treasury.fetchNullable(treasuryPda));
    } else {
      ok("treasury already initialised — reusing");
    }
    info(`treasury ${treasuryPda.toBase58()}`);

    // ---- 3. the cast ------------------------------------------------------------------------------
    // Round numbers come from the arena's OWN counter, never from 1: `open_round` requires
    // `round_no == round_counter + 1` and answers `RoundOutOfOrder` otherwise, so a second run of
    // this script against the same arena has to start where the first one stopped.
    heading("3. the three rounds that matter, and the rest that only have to exist");
    const startCounter = BigInt(arena.roundCounter.toString());
    const roundNos = Array.from({ length: ROUNDS_TO_OPEN }, (_, i) => startCounter + BigInt(i + 1));
    const reclaimable = roundNos[0]!;                    // case 1: swept, and 21 rounds behind the final counter
    const unswept = roundNos[1]!;                        // case 3: everything but the sweep
    const tooRecent = roundNos[ROUNDS_TO_OPEN - 1]!;     // case 2: swept and terminal, but it IS the counter
    const worked = [reclaimable, unswept, tooRecent];
    const pdaFor = (roundNo: bigint) => roundIx.roundPdaForRoundNo(roundNo, arenaPda);

    info(`arena.round_counter is ${startCounter}, so this run opens #${reclaimable} .. #${tooRecent}`);
    info(`  #${reclaimable}  case 1 — abandoned, swept, ${MIN_RETAINED_ROUNDS + 1} rounds behind the final counter: CLOSES`);
    info(`  #${unswept}  case 3 — abandoned, exactly ${MIN_RETAINED_ROUNDS} behind, NOT swept: RoundNotSwept`);
    info(`  #${tooRecent}  case 2 — abandoned and swept, but it IS the newest round: RoundTooRecent`);

    // ---- 4. open every round ---------------------------------------------------------------------
    // ALL BUT THREE OF THESE ARE NEVER TOUCHED AGAIN, AND THAT IS THE POINT RATHER THAN LAZINESS.
    // `open_round` is the only instruction that moves `arena.round_counter`, and the retention window
    // is nothing but a comparison against that counter — so the only way to age case 1's round out of
    // the window is to open rounds on top of it, and the cheapest round to open is one that is then
    // left sitting in `Lobby`. Delegating or fighting the filler would cost transactions and minutes
    // and change nothing the guard can see.
    //
    // They get the minimum lobby window for the same reason: it leaves them already expired, so their
    // rent stays recoverable later by anyone willing to run delegate -> abandon -> sweep -> close,
    // rather than first having to wait out a window nobody wanted.
    heading(`4. open_round x${ROUNDS_TO_OPEN} — ${ROUNDS_TO_OPEN - 3} of them exist purely to advance round_counter`);
    for (const roundNo of roundNos) {
      const { signature } = await sendTx(
        router,
        roundIx.openRound(authority, {
          arena: arenaPda, round: pdaFor(roundNo), authority: forkPayer.publicKey,
          roundNo, seedCommit: crypto.getRandomValues(new Uint8Array(32)), lobbySeconds: MIN_LOBBY_SECONDS,
        }),
        forkPayer,
        `open_round #${roundNo}${worked.includes(roundNo) ? "   <- worked" : ""}`,
      );
      if (worked.includes(roundNo)) signatures[`openRound_${roundNo}`] = signature;
    }

    // The predicate IS the assertion here: `readSettled` fails loudly if the counter never reaches
    // what twenty-two successful `open_round`s must have made it, so a separate equality check
    // afterwards would only be comparing the number to itself.
    const counterAfter = await readSettled(
      "arena.round_counter after the batch",
      () => authorityBase.account.arena.fetchNullable(arenaPda),
      (a) => BigInt(a.roundCounter.toString()) === tooRecent,
    );
    const counter = BigInt(counterAfter.roundCounter.toString());
    ok(`arena.round_counter reached ${counter}`);

    // The window arithmetic, restated against the counter the CHAIN just reported. The three roles
    // above are only meaningful if the relationship each one assumes actually holds on this arena;
    // getting that wrong would turn case 3 into a second, silent copy of case 2.
    for (const [role, roundNo, mustBeOutside] of [
      ["case 1", reclaimable, true], ["case 3", unswept, true], ["case 2", tooRecent, false],
    ] as const) {
      const outside = roundNo + BigInt(MIN_RETAINED_ROUNDS) <= counter;
      if (outside !== mustBeOutside) {
        throw new Error(`${role}: round #${roundNo} is ${outside ? "outside" : "inside"} the retention window, and this run needs the opposite`);
      }
      ok(`${role} — #${roundNo} + ${MIN_RETAINED_ROUNDS} ${outside ? "<=" : ">"} round_counter ${counter}, so the window ${outside ? "releases" : "holds"} it`);
    }

    // Read the deadlines while the rounds are still ours to read: one step from here they belong to
    // the Delegation Program and `Account<Round>` stops deserialising them.
    const deadlines: number[] = [];
    for (const roundNo of worked) {
      const r = await readSettled(`round #${roundNo} after open_round`, () => authorityBase.account.round.fetchNullable(pdaFor(roundNo)));
      deadlines.push(Number(r.lobbyClosesAt.toString()));
    }

    // ---- 5. delegate the three worked rounds ------------------------------------------------------
    // ALL THREE FIRST, THEN ONE WAIT. `abandon_round` runs inside the rollup — it is the call that
    // commits and undelegates — so each of these has to be delegated before its lobby can be ended.
    // Doing that up front means the 20-second deadline is waited out once for all three instead of
    // three times.
    heading("5. delegate_round x3 — pinned to the validator the preflight cleared");
    for (const roundNo of worked) {
      const { signature } = await sendTx(
        router,
        roundIx.delegateRound(authority, {
          arena: arenaPda, round: pdaFor(roundNo), authority: forkPayer.publicKey, roundNo,
          validator: validator.identity,
        }),
        forkPayer,
        `delegate_round #${roundNo}`,
      );
      signatures[`delegateRound_${roundNo}`] = signature;
    }
    for (const roundNo of worked) {
      await waitForOwner(pdaFor(roundNo), DELEGATION_PROGRAM_ID, `round #${roundNo} never delegated`);
    }
    ok("all three rounds are delegated — abandon_round can now run on them");

    // ---- 6. one wait, for the latest of the three deadlines ---------------------------------------
    heading("6. waiting out the lobby deadline (once, for all three)");
    const lastDeadline = Math.max(...deadlines);
    for (;;) {
      const remaining = lastDeadline + DEADLINE_MARGIN_SECONDS - Math.floor(Date.now() / 1000);
      if (remaining <= 0) break;
      info(`${remaining}s until the newest lobby is abandonable`);
      await sleep(Math.min(remaining, 5) * 1000);
    }
    ok("every worked lobby is past its deadline holding 0 fighters — abandon_round's precondition holds");

    // ---- 7. abandon all three ---------------------------------------------------------------------
    // ABANDONMENT RATHER THAN A FIGHT, DELIBERATELY. `check_close_permitted` accepts `Settled` and
    // `Abandoned` through one `require!`, and an abandoned lobby reaches a terminal phase with no
    // fighters, no stakes, no VRF round trip and no ticking — and `abandon_round` commits AND
    // undelegates in a single call. A real fight would cost two funded wallets and ninety seconds of
    // oracle latency to arrive at the same place through the other arm of the same boolean.
    heading("7. abandon_round x3 — terminal phase, no fighters, committed and undelegated in one call");
    for (const roundNo of worked) {
      // Retried on `LobbyNotAbandonable` and nothing else. The deadline was stamped by the base layer
      // at `open_round` and is evaluated against the ROLLUP's clock; a second of skew between them is
      // the one thing that can make a correct call arrive early. Every other error is real.
      for (let attempt = 1; ; attempt++) {
        try {
          const { signature } = await sendTx(
            router,
            roundIx.abandonRound(authority, { payer: forkPayer.publicKey, round: pdaFor(roundNo) }),
            forkPayer,
            `abandon_round #${roundNo}`,
          );
          signatures[`abandonRound_${roundNo}`] = signature;
          break;
        } catch (e) {
          if (anchorErrorCode(e) !== "LobbyNotAbandonable" || attempt >= 4) throw e;
          warn(`abandon_round #${roundNo} was early by the rollup's clock (attempt ${attempt}) — waiting 3s`);
          await sleep(3000);
        }
      }
    }
    for (const roundNo of worked) {
      await waitForOwner(pdaFor(roundNo), PROGRAM_ID, `round #${roundNo} never came home from the rollup`);
    }
    ok("all three rounds are back on the base layer — sweep and close can deserialise them again");

    // Phase asserted from the SETTLED base-layer copy: the ownership change polled above and the
    // commit that carries `Phase::Abandoned` are two separate writes, so a round can be home and
    // still read `Lobby` for a moment.
    for (const roundNo of worked) {
      const r = await readSettled(
        `round #${roundNo} to read as Abandoned on the base layer`,
        () => authorityBase.account.round.fetchNullable(pdaFor(roundNo)),
        (v) => v.phase === Phase.Abandoned,
      );
      info(`round #${roundNo}  phase=${PHASE_NAME[r.phase]}  fighters=${r.fighterCount}  house_swept=${r.houseSwept ?? false}`);
    }

    // ---- 8. sweep two of the three -----------------------------------------------------------------
    heading("8. sweep_house_take — on case 1's and case 2's rounds only");
    for (const roundNo of [reclaimable, tooRecent]) {
      const { signature } = await sendTx(
        router,
        roundIx.sweepHouseTake(authority, { arena: arenaPda, round: pdaFor(roundNo), treasury: treasuryPda, roundNo }),
        forkPayer,
        `sweep_house_take #${roundNo}`,
      );
      signatures[`sweepHouseTake_${roundNo}`] = signature;
      await readSettled(
        `round #${roundNo}.house_swept after the sweep`,
        () => authorityBase.account.round.fetchNullable(pdaFor(roundNo)),
        (r) => r.houseSwept === true,
      );
      ok(`round #${roundNo} is swept`);
    }
    // Case 3's round is left unswept ON PURPOSE, and that is worth asserting rather than trusting to
    // the loop above having skipped it: if something else swept it, claim 3 would fail for a reason
    // that has nothing to do with the guard it is testing.
    const forClaim3 = await readSettled(`round #${unswept} before claim 3`, () => authorityBase.account.round.fetchNullable(pdaFor(unswept)));
    if (forClaim3.houseSwept) throw new Error(`round #${unswept} has been swept — case 3 would prove nothing`);
    ok(`round #${unswept} is deliberately NOT swept`);

    // ---- 9. CLAIM 4 — a non-authority is refused ---------------------------------------------------
    // Aimed at the round case 1 goes on to close SUCCESSFULLY, and fired before it does, so the
    // refusal cannot be explained away by the round being ineligible: at this instant it is terminal,
    // swept and outside the window, and the signer is the only thing wrong with the transaction.
    heading("9. CLAIM 4 — close_round_account signed by someone who is not the authority");
    const burner = Keypair.generate();
    {
      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: forkPayer.publicKey, toPubkey: burner.publicKey, lamports: BURNER_FUNDING,
      }));
      const sig = await base.sendTransaction(tx, [forkPayer]);
      await base.confirmTransaction(sig, "confirmed");
      signatures.fundBurner = sig;
      info(`burner ${burner.publicKey.toBase58()} funded with ${sol(BURNER_FUNDING)}`);
    }
    const burnerProgram = await createProgram(router, createBurnerWallet(burner));
    // `ConstraintHasOne` (2001), NOT `NotTheAuthority`, and this is correct rather than a loose
    // assertion. The authority check on `CloseRoundAccount` is `has_one = authority` on the arena
    // account, which Anchor enforces during account validation and reports with its OWN error code —
    // unlike `close_lobby_and_draw`, where the authority arrives as an optional account and is
    // compared inside the handler, so the program raises its custom `NotTheAuthority`. Two different
    // mechanisms, two different codes. Do not "fix" this one.
    await expectRejection(
      `close_round_account #${reclaimable} signed by a fresh burner`,
      "ConstraintHasOne",
      () => sendTx(
        router,
        roundIx.closeRoundAccount(burnerProgram, {
          arena: arenaPda, round: pdaFor(reclaimable), authority: burner.publicKey, roundNo: reclaimable,
        }),
        burner,
        `close_round_account #${reclaimable} (non-authority, must fail)`,
      ),
    );

    // ---- 10. CLAIM 2 — inside the retention window --------------------------------------------------
    heading("10. CLAIM 2 — a round inside the retention window, terminal and swept");
    info(`#${tooRecent} + ${MIN_RETAINED_ROUNDS} = ${tooRecent + BigInt(MIN_RETAINED_ROUNDS)}, which round_counter ${counter} has not reached`);
    await expectRejection(
      `close_round_account #${tooRecent} (abandoned and swept, but it is the newest round)`,
      "RoundTooRecent",
      () => sendTx(
        router,
        roundIx.closeRoundAccount(authority, {
          arena: arenaPda, round: pdaFor(tooRecent), authority: forkPayer.publicKey, roundNo: tooRecent,
        }),
        forkPayer,
        `close_round_account #${tooRecent} (too recent, must fail)`,
      ),
    );

    // ---- 11. CLAIM 3 — swept-first is not advisory ---------------------------------------------------
    heading("11. CLAIM 3 — a round old enough to close, whose house take was never swept");
    info(`#${unswept} + ${MIN_RETAINED_ROUNDS} = ${unswept + BigInt(MIN_RETAINED_ROUNDS)}, which round_counter ${counter} HAS reached — only the sweep is missing`);
    await expectRejection(
      `close_round_account #${unswept} (abandoned and old enough, never swept)`,
      "RoundNotSwept",
      () => sendTx(
        router,
        roundIx.closeRoundAccount(authority, {
          arena: arenaPda, round: pdaFor(unswept), authority: forkPayer.publicKey, roundNo: unswept,
        }),
        forkPayer,
        `close_round_account #${unswept} (unswept, must fail)`,
      ),
    );

    // ---- 12. CLAIM 1 — the rent comes back ------------------------------------------------------------
    heading("12. CLAIM 1 — the close that is supposed to work, reconciled to the lamport");
    const reclaimed = await closeAndReconcile(pdaFor(reclaimable), reclaimable, arenaPda);

    // ---- 13. CLAIM 5 — the freed address stays dead -----------------------------------------------------
    // The safety argument for deleting anything at all is that the address cannot come back: the PDA
    // is seeded by `round_no`, and `open_round` only ever accepts `round_counter + 1` against a
    // counter that only increases. Asserted rather than reasoned about, at the cost of one
    // preflight-rejected transaction.
    heading("13. CLAIM 5 — the closed round's address cannot be reopened");
    await expectRejection(
      `open_round #${reclaimable} again, at the address that was just freed`,
      "RoundOutOfOrder",
      () => sendTx(
        router,
        roundIx.openRound(authority, {
          arena: arenaPda, round: pdaFor(reclaimable), authority: forkPayer.publicKey,
          roundNo: reclaimable, seedCommit: crypto.getRandomValues(new Uint8Array(32)),
          lobbySeconds: MIN_LOBBY_SECONDS,
        }),
        forkPayer,
        `open_round #${reclaimable} (round number already used, must fail)`,
      ),
    );

    // ---- 14. the ledger for this run -------------------------------------------------------------------
    heading("14. what this run cost and what came back");
    const endBalance = await base.getBalance(forkPayer.publicKey);
    const idleRent = BigInt(ROUNDS_TO_OPEN - 3) * BigInt(roundRent);
    console.log(`
  rounds opened       ${ROUNDS_TO_OPEN}   ${c.d}#${reclaimable} .. #${tooRecent}, at ${sol(roundRent)} of rent each${c.x}
  net spent           ${sol(BigInt(startBalance - endBalance))}   ${c.d}rent + fees + ${sol(BURNER_FUNDING)} to the burner, less the reclaim${c.x}
  reclaimed           ${sol(reclaimed)}   ${c.d}round #${reclaimable}'s rent, less that transaction's own fee${c.x}
  balance now         ${sol(endBalance)}`);
    warn(
      `${ROUNDS_TO_OPEN - 3} rounds are left in Lobby holding ~${sol(idleRent)} of rent. They exist only to move ` +
      "round_counter and they are not stranded — delegate -> abandon -> sweep -> close reclaims each of them once " +
      `the counter is another ${MIN_RETAINED_ROUNDS} rounds ahead.`,
    );

    heading("15. signatures");
    for (const [step, sig] of Object.entries(signatures)) info(`${step.padEnd(24)} ${sig}`);

    console.log(`
${c.g}${c.b}ROUND CLOSE VERIFICATION COMPLETE${c.x}
  the rent came back to the lamport and RoundAccountClosed agreed;
  a round inside the window, an unswept round and a stranger were each refused for their own reason;
  and the freed address cannot be reopened.`);
    process.exit(0);
  } catch (e) {
    console.error(`\n${c.r}${c.b}VERIFICATION FAILED${c.x}`);
    console.error(`  ${c.r}${describeError(e)}${c.x}`);
    console.error(`  signatures collected before failure:`, signatures);
    process.exitCode = 1;
  }
})();
