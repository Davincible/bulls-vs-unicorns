#!/usr/bin/env bun
// THE HOUSE TAKE, PROVEN ON CHAIN — the three claims that had never executed against a real
// validator before this script existed, run as one round on devnet.
//
// Until v6 the entry fee was charged to players and credited to nobody: `enter` subtracted
// `arena.fee_bps` from every stake and the difference simply ceased to exist (see `fees_collected`'s
// own doc comment in lib.rs for why it survived so long — there was no writable base-layer account in
// scope at the instant the fee was taken). `Round.fees_collected` records it, a `Treasury` PDA is
// where it accumulates, and `sweep_house_take` is the move between them. None of that had ever run.
//
// What this script proves, and refuses to pass without:
//
//   1. THE FEE LANDS. `Round.fees_collected` after two entries equals what `fee_bps` says it should,
//      computed here from the GROSS stakes with the program's own flooring rule — and one of the two
//      stakes is deliberately chosen so the floor is visible (1,234,567 × 20bps = 2,469.134). After
//      the sweep, `Treasury.fees_accrued` equals that same number. Both halves are asserted, because
//      a fee that is recorded and never swept is the same evaporation wearing a different hat.
//
//   2. THE AUTHORITY EARLY CLOSE WORKS, AND ONLY FOR THE AUTHORITY. The lobby is opened with a
//      10-minute window and closed while it is demonstrably still open (the script prints the
//      seconds remaining at the moment it closes). A non-authority signer is refused FIRST, against
//      the same still-open lobby, so the positive result cannot be confused with "the deadline had
//      quietly passed".
//
//   3. CONSERVATION HOLDS WITH BOTH HOUSE TAKES NON-ZERO. `players_hold + house_took ==
//      gross_deposits`, asserted with `fees_collected` AND `penalties_collected` both > 0 — the
//      latter forced by having one fighter extract early. The identity is weak on its own (the fee
//      term cancels; see the field's doc comment, which says so plainly), so the script asserts the
//      non-zero-ness separately rather than letting a passing identity imply it.
//
// Not proven here and deliberately not claimed: NO VALUE MOVES. This program holds no balances —
// `fees_collected`, `penalties_collected` and the `Treasury` are all RECORDS the off-chain treasury
// is settled against, and `sweep_house_take` increments counters rather than transferring lamports.
// The custody work in ARCHITECTURE-N-TEAM.md §4 is what turns these numbers into money.
//
//   cd er-demo && bun run scripts/verify-house-take.ts

import { assertDevnetUrl } from "../src/devnet-guard.ts";
import { BASE_RPC, PHASE_NAME, Phase, PROGRAM_ID, ROUTER_URL } from "../src/chain/constants.ts";
import { createProgram } from "../src/chain/program.ts";
import { sendTx } from "../src/chain/sendTx.ts";
import { createBurnerWallet, loadOrCreateBurnerKeypair } from "../src/chain/useSigner.ts";
import * as roundIx from "../src/chain/round.ts";
import { loadIdl } from "../src/chain/idl.ts";
import { NO_FRESH_VALIDATOR, pickValidator } from "./erValidator.ts";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { AnchorError } from "@coral-xyz/anchor";
import { ConnectionMagicRouter, DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s: string) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s: string) => console.log(`  ${c.d}${s}${c.x}`);
const warn = (s: string) => console.log(`  ${c.y}!${c.x} ${s}`);
const heading = (s: string) => console.log(`\n${c.b}${s}${c.x}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The program's `split_entry`, restated here so the expectation is computed INDEPENDENTLY of the
 *  chain rather than read back from it. Floors, because the house rounds down — asserting the
 *  direction is the point, so `Math.floor` is the whole content of this function. */
const feeOn = (grossStake: bigint, feeBps: bigint) => (grossStake * feeBps) / 10_000n;

/** Fail loudly with the two numbers side by side. A verification script whose assertions print only
 *  "expected true" is a script you cannot debug from its own transcript. */
function assertEq(actual: bigint, expected: bigint, what: string): void {
  if (actual !== expected) throw new Error(`${what}\n      expected ${expected}\n      actual   ${actual}`);
  ok(`${what} — ${actual}`);
}

/** Read the BASE layer until it reflects a write we have already watched confirm somewhere else.
 *
 *  NOT A SLEEP, AND NOT PARANOIA — this script's first run died here. `sendTx` confirms against the
 *  ROUTER (or an ER validator's own RPC); every assertion below reads a plain devnet node. Those are
 *  different machines. `init_treasury` landed in slot 482427306 and finalized, and the very next
 *  read of the account it had just created returned "Account does not exist or has no data" from the
 *  base RPC, which was simply behind. Raising the commitment would not fix it (the write is already
 *  confirmed; it is the READER that has to catch up) and a fixed sleep would only move the race.
 *
 *  `accept` covers the second, nastier shape of the same problem: an account that already exists and
 *  is returned with its PREVIOUS contents. Callers checking the effect of a write pass a predicate
 *  and get the post-write value or a loud failure — never a silently stale one.
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
  let sawAccount = false;
  for (;;) {
    let value: T | null = null;
    try {
      value = await read();
    } catch {
      value = null;                      // anchor throws rather than returning null on a missing account
    }
    if (value !== null) {
      sawAccount = true;
      if (accept(value)) return value;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `${what}: the base layer never caught up within ${timeoutMs}ms — ` +
        (sawAccount ? "the account is readable but still holds its pre-write contents" : "the account is still not readable"),
      );
    }
    await sleep(1000);
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
 *  A rejected instruction reaches the client two different ways and the negative tests below hit the
 *  second one. If the transaction is submitted and fails on chain, anchor's client decodes it into a
 *  typed `AnchorError`. But every send here is PRE-FLIGHT SIMULATED first, and a constraint that
 *  fails in simulation is thrown by web3.js as a `SendTransactionError` — a string and a log dump,
 *  with no decoded `errorCode` anywhere on it. Matching only the typed shape made three correct
 *  refusals (ConstraintHasOne, NotTheAuthority, AlreadySwept) look like unexpected failures.
 *
 *  So fall back to the logs, where anchor prints the code it would have decoded:
 *  `AnchorError ... Error Code: ConstraintHasOne. Error Number: 2001.`
 *
 *  AND THEN A THIRD SHAPE, which is the one the ER validator produces. Simulating on the rollup can
 *  fail with `transaction verification error: ... custom program error: 0x1783` and NO log messages
 *  at all — nothing to regex a name out of. `0x1783` is 6019, which is a program error INDEX, so the
 *  name is recovered by looking 6019 up in the IDL's own error table (`ERROR_NAMES`, populated at
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

/** Assert that `send` is REFUSED, and refused for the stated reason. The error code is checked rather
 *  than merely "it threw": a negative test that passes on the wrong error is a negative test that
 *  will keep passing after the constraint it guards is deleted. */
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

// Gross stakes. B is chosen so the fee does not divide evenly (1,234,567 × 20 / 10,000 = 2,469.134):
// a stake that floored to the same answer as it rounded would leave the rounding direction untested.
const STAKE_A = 1_000_000n;
const STAKE_B = 1_234_567n;
const LOBBY_SECONDS = 600;   // long, so "closed early" is a fact about the clock rather than a race

(async () => {
  console.log(`${c.d}HOUSE TAKE VERIFICATION — fee -> Round.fees_collected -> Treasury, authority early close, conservation. DEVNET${c.x}`);

  const router = new ConnectionMagicRouter(ROUTER_URL, "confirmed");
  const base = new Connection(BASE_RPC, "confirmed");

  const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
  const startBalance = await base.getBalance(forkPayer.publicKey);
  info(`fork-payer  ${forkPayer.publicKey.toBase58()}  ${(startBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  info(`program     ${PROGRAM_ID.toBase58()}`);

  // The error table the refusals below are matched against — see `anchorErrorCode`. Same IDL the
  // program answers to, so the numbers cannot drift apart from the names.
  for (const e of ((await loadIdl()) as { errors?: { code: number; name: string }[] }).errors ?? []) {
    ERROR_NAMES.set(e.code, e.name);
  }

  const authority = await createProgram(router, createBurnerWallet(forkPayer));
  const authorityBase = await createProgram(base, createBurnerWallet(forkPayer));

  const playerA = loadOrCreateBurnerKeypair();
  const playerB = loadOrCreateBurnerKeypair();
  const signatures: Record<string, string> = {};

  try {
    // ---- 0. the bytecode-cache preflight, BEFORE anything is spent ------------------------------
    // The trap this repo has paid for five times: an ER validator serving a previous build of this
    // program id. A fresh id has no clone anywhere yet, so the expected reading here is "no clone
    // yet" on every validator — not "CURRENT". Either is usable; a STALE one is not.
    heading("0. ER validator preflight — byte-compare each clone against the local build");
    const validator = await pickValidator(null);
    if (!validator) throw new Error(NO_FRESH_VALIDATOR);
    ok(`delegating to ${validator.fqdn} (${validator.identity.toBase58().slice(0, 8)}…)`);

    // ---- fund two distinct player wallets -------------------------------------------------------
    // Distinct identities are mandatory, not tidy: `enter` MERGES a repeat entry from the same wallet
    // on the same side into one fighter, which would silently make this a one-fighter round.
    heading("1. funding two distinct player wallets");
    {
      const FUND = 0.03 * LAMPORTS_PER_SOL;
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: playerA.publicKey, lamports: FUND }),
        SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: playerB.publicKey, lamports: FUND }),
      );
      const sig = await base.sendTransaction(tx, [forkPayer]);
      await base.confirmTransaction(sig, "confirmed");
      signatures.fundPlayers = sig;
      info(`player A ${playerA.publicKey.toBase58()}`);
      info(`player B ${playerB.publicKey.toBase58()}`);
    }
    const playerAProgram = await createProgram(router, createBurnerWallet(playerA));
    const playerBProgram = await createProgram(router, createBurnerWallet(playerB));

    const arenaPda = roundIx.arenaPda();
    const treasuryPda = roundIx.treasuryPda(arenaPda);

    // ---- 2. init_arena --------------------------------------------------------------------------
    heading("2. init_arena");
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
    const feeBps = BigInt(arena.feeBps);
    info(`arena ${arenaPda.toBase58()}  fee_bps=${feeBps}  authority=${arena.authority.toBase58()}`);

    // ---- 3. init_treasury -----------------------------------------------------------------------
    heading("3. init_treasury — the account the fee has never had");
    let treasury = await authorityBase.account.treasury.fetchNullable(treasuryPda);
    if (!treasury) {
      const { signature } = await sendTx(
        router,
        roundIx.initTreasury(authority, { arena: arenaPda, treasury: treasuryPda, authority: forkPayer.publicKey }),
        forkPayer,
        "init_treasury",
      );
      signatures.initTreasury = signature;
      treasury = await readSettled("treasury after init_treasury", () => authorityBase.account.treasury.fetchNullable(treasuryPda));
    } else {
      ok("treasury already initialised — reusing");
    }
    info(`treasury ${treasuryPda.toBase58()}`);
    const treasuryFeesBefore = BigInt(treasury.feesAccrued.toString());
    const treasuryPenaltiesBefore = BigInt(treasury.penaltiesAccrued.toString());
    const roundsSweptBefore = BigInt(treasury.roundsSwept.toString());
    info(`treasury before: fees_accrued=${treasuryFeesBefore} penalties_accrued=${treasuryPenaltiesBefore} rounds_swept=${roundsSweptBefore}`);

    // ---- 4. set_fee_bps -------------------------------------------------------------------------
    // THE RATE IS NOT MOVED. 20 bps is the operator's number and `set_fee_bps` is how it changes;
    // this script only has to show the instruction works and is gated. Re-setting the CURRENT value
    // does both — the transaction really executes and really emits FeeBpsChanged — while leaving the
    // arena exactly as it found it. The negative case below is the half that actually matters.
    heading("4. set_fee_bps — proven to work and to be gated, WITHOUT moving the rate");
    await expectRejection(
      "set_fee_bps signed by a non-authority",
      "ConstraintHasOne",
      () => sendTx(
        router,
        roundIx.setFeeBps(playerAProgram, { arena: arenaPda, authority: playerA.publicKey, feeBps: 500 }),
        playerA,
        "set_fee_bps (non-authority, must fail)",
      ),
    );
    {
      const { signature } = await sendTx(
        router,
        roundIx.setFeeBps(authority, { arena: arenaPda, authority: forkPayer.publicKey, feeBps: Number(feeBps) }),
        forkPayer,
        `set_fee_bps (authority, re-set to the same ${feeBps} bps)`,
      );
      signatures.setFeeBps = signature;
    }
    const arenaAfterSet = await readSettled("arena after set_fee_bps", () => authorityBase.account.arena.fetchNullable(arenaPda));
    assertEq(BigInt(arenaAfterSet.feeBps), feeBps, "fee_bps is unchanged by this run");

    // ---- 5. open_round --------------------------------------------------------------------------
    heading("5. open_round — a 10-minute lobby, so the early close is unambiguous");
    const roundNo = BigInt(arena.roundCounter.toString()) + 1n;
    const roundPda = roundIx.roundPdaForRoundNo(roundNo, arenaPda);
    info(`round #${roundNo}  pda ${roundPda.toBase58()}`);
    {
      const { signature } = await sendTx(
        router,
        roundIx.openRound(authority, {
          arena: arenaPda, round: roundPda, authority: forkPayer.publicKey,
          roundNo, seedCommit: crypto.getRandomValues(new Uint8Array(32)), lobbySeconds: LOBBY_SECONDS,
        }),
        forkPayer,
        `open_round #${roundNo} (${LOBBY_SECONDS}s lobby)`,
      );
      signatures.openRound = signature;
    }

    // ---- 6. delegate_round ----------------------------------------------------------------------
    heading("6. delegate_round — pinned to the validator the preflight cleared");
    {
      const { signature } = await sendTx(
        router,
        roundIx.delegateRound(authority, {
          arena: arenaPda, round: roundPda, authority: forkPayer.publicKey, roundNo,
          validator: validator.identity,
        }),
        forkPayer,
        "delegate_round",
      );
      signatures.delegateRound = signature;
    }
    {
      let acct;
      for (let i = 0; i < 10; i++) {
        acct = await base.getAccountInfo(roundPda);
        if (acct?.owner.equals(DELEGATION_PROGRAM_ID)) break;
        await sleep(1000);
      }
      if (!acct?.owner.equals(DELEGATION_PROGRAM_ID)) {
        throw new Error(`round did not delegate — owner is ${acct?.owner.toBase58() ?? "MISSING"}`);
      }
      ok("round is delegated — entries now execute inside the rollup");
    }

    // ---- 7. enter x2, and CHECK THE FEE ---------------------------------------------------------
    heading("7. enter — two fighters, and the fee they were actually charged");
    {
      const { signature } = await sendTx(
        router,
        roundIx.enter(playerAProgram, { arena: arenaPda, round: roundPda, player: playerA.publicKey, signer: playerA.publicKey, sessionToken: null, side: 0, stake: Number(STAKE_A) }),
        playerA,
        `enter side 0 (player A, gross stake ${STAKE_A})`,
      );
      signatures.enterA = signature;
    }
    {
      const { signature } = await sendTx(
        router,
        roundIx.enter(playerBProgram, { arena: arenaPda, round: roundPda, player: playerB.publicKey, signer: playerB.publicKey, sessionToken: null, side: 1, stake: Number(STAKE_B) }),
        playerB,
        `enter side 1 (player B, gross stake ${STAKE_B})`,
      );
      signatures.enterB = signature;
    }

    const feeA = feeOn(STAKE_A, feeBps);
    const feeB = feeOn(STAKE_B, feeBps);
    const expectedFees = feeA + feeB;
    const expectedPot = (STAKE_A - feeA) + (STAKE_B - feeB);
    const grossDeposits = STAKE_A + STAKE_B;
    info(`at ${feeBps} bps: ${STAKE_A} -> fee ${feeA}, net ${STAKE_A - feeA}`);
    info(`at ${feeBps} bps: ${STAKE_B} -> fee ${feeB}, net ${STAKE_B - feeB}   ${c.d}(exact quotient ${(Number(STAKE_B) * Number(feeBps) / 10_000).toFixed(3)} — floored, house rounds down)${c.x}`);

    const afterEntries = await authority.account.round.fetch(roundPda);
    assertEq(BigInt(afterEntries.feesCollected.toString()), expectedFees, "Round.fees_collected after both entries");
    assertEq(BigInt(afterEntries.pot.toString()), expectedPot, "Round.pot is the sum of NET stakes");
    assertEq(BigInt(afterEntries.pot.toString()) + BigInt(afterEntries.feesCollected.toString()), grossDeposits,
      "gross_deposits == pot + fees_collected (what players were actually charged)");
    if (expectedFees === 0n) throw new Error("fees_collected is zero — this run proves nothing about the fee");

    // ---- 8. the authority early close, and the refusal that gives it meaning ---------------------
    heading("8. close_lobby_and_draw — EARLY, by the authority");
    const delegationStatus = (await router.getDelegationStatus(roundPda)) as { isDelegated: boolean; fqdn?: string };
    const erFqdn = delegationStatus.fqdn;
    if (!erFqdn) throw new Error("getDelegationStatus(round) returned no fqdn — cannot resolve the ER validator");
    assertDevnetUrl(erFqdn, "ER validator");
    info(`round's ER validator: ${erFqdn}`);
    // Straight to the round's own validator, NOT the generic router: this instruction's writable set
    // includes the ephemeral VRF queue, and the multi-validator router refuses it outright with
    // "accounts delegated to different ER nodes". See chain/sendTx.ts's "SDK SURPRISE #2".

    const secondsLeft = Number(afterEntries.lobbyClosesAt.toString()) - Math.floor(Date.now() / 1000);
    if (secondsLeft <= 0) throw new Error(`the lobby has already expired (${secondsLeft}s) — an early close cannot be demonstrated`);
    ok(`the lobby is still OPEN — ${secondsLeft}s left on the deadline. A permissionless close would be refused right now.`);

    // The negative FIRST, against this same still-open lobby. Running it after a successful close
    // would prove nothing (the round would no longer be in Lobby, and the error would be NotInLobby).
    await expectRejection(
      "early close attempted by a NON-authority signer",
      "NotTheAuthority",
      () => sendTx(
        router,
        roundIx.closeLobbyAndDraw(playerAProgram, {
          payer: playerA.publicKey, round: roundPda, arena: arenaPda,
          clientSeed: crypto.getRandomValues(new Uint8Array(32)),
          authority: playerA.publicKey,
        }),
        playerA,
        "close_lobby_and_draw (non-authority, must fail)",
        { endpoint: erFqdn },
      ),
    );
    {
      const { signature } = await sendTx(
        router,
        roundIx.closeLobbyAndDraw(authority, {
          payer: forkPayer.publicKey, round: roundPda, arena: arenaPda,
          clientSeed: crypto.getRandomValues(new Uint8Array(32)),
          authority: forkPayer.publicKey,
        }),
        forkPayer,
        "close_lobby_and_draw (AUTHORITY, early)",
        { endpoint: erFqdn },
      );
      signatures.closeLobbyAndDraw = signature;
    }
    ok(`lobby closed ${secondsLeft}s BEFORE its deadline, by the arena authority`);

    // ---- 9. VRF callback ------------------------------------------------------------------------
    heading("9. waiting for the VRF callback (Drawing -> Fight)");
    let round = await authority.account.round.fetch(roundPda);
    const drawStart = Date.now();
    const DRAW_TIMEOUT_MS = 90_000;
    while (round.phase !== Phase.Fight) {
      if (Date.now() - drawStart > DRAW_TIMEOUT_MS) throw new Error(`VRF callback never landed — stuck in ${PHASE_NAME[round.phase]}`);
      if (round.phase !== Phase.Drawing) throw new Error(`round left Drawing for an unexpected phase: ${PHASE_NAME[round.phase]}`);
      await sleep(2000);
      round = await authority.account.round.fetch(roundPda);
    }
    ok(`PHASE IS NOW FIGHT (${((Date.now() - drawStart) / 1000).toFixed(1)}s for the VRF to land)`);
    info(`seed: ${Buffer.from(round.seed).toString("hex")}`);

    // ---- 10. extract — forces penalties_collected > 0 --------------------------------------------
    // Immediately, because the penalty decays with the fight cursor: the conservation check below is
    // only worth running with BOTH house takes non-zero, and a late extract can round to nothing.
    heading("10. extract — player A pulls out early, so the penalty is non-zero");
    {
      const { signature } = await sendTx(
        router,
        roundIx.extract(playerAProgram, { round: roundPda, player: playerA.publicKey, signer: playerA.publicKey, sessionToken: null }),
        playerA,
        "extract (player A)",
      );
      signatures.extract = signature;
    }

    // ---- 11. resolve ----------------------------------------------------------------------------
    heading("11. resolve — side 0 is empty, so the fight is genuinely over");
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { signature } = await sendTx(router, roundIx.resolve(authority, { payer: forkPayer.publicKey, round: roundPda }), forkPayer, "resolve");
        signatures.resolve = signature;
        break;
      } catch (e) {
        if (anchorErrorCode(e) === "FightNotOverYet" && attempt < 3) {
          warn(`resolve() too early (attempt ${attempt}) — waiting 3s`);
          await sleep(3000);
          continue;
        }
        throw e;
      }
    }

    // ---- 12. close_round + undelegate ------------------------------------------------------------
    heading("12. close_round — commit and hand the round back to the base layer");
    {
      const { signature } = await sendTx(router, roundIx.closeRound(authority, { payer: forkPayer.publicKey, round: roundPda }), forkPayer, "close_round");
      signatures.closeRound = signature;
    }
    let cameHome = false;
    for (let i = 0; i < 20; i++) {
      const acct = await base.getAccountInfo(roundPda);
      if (acct?.owner.equals(PROGRAM_ID)) { cameHome = true; break; }
      await sleep(3000);
    }
    if (!cameHome) throw new Error("round still owned by the Delegation Program after 60s — the undelegate commit did not finalize");
    ok("owner reverted to our program — sweep_house_take can now deserialise the round");

    // ---- 13. conservation, from the base layer ---------------------------------------------------
    heading("13. CONSERVATION — read from the base layer, both house takes non-zero");
    // Settled, not merely present: the round has just come back from the ER, and the commit that
    // carries the fight's final numbers is a separate write from the ownership change polled above.
    const final = await readSettled(
      "settled round on the base layer",
      () => authorityBase.account.round.fetchNullable(roundPda),
      (r) => r.phase === Phase.Settled,
    );
    const fees = BigInt(final.feesCollected.toString());
    const penalties = BigInt(final.penaltiesCollected.toString());
    let playersHold = 0n;
    for (let i = 0; i < final.fighterCount; i++) {
      const f = final.fighters[i]!;
      const tag = f.wallet.equals(playerA.publicKey) ? "player A" : f.wallet.equals(playerB.publicKey) ? "player B" : "?";
      info(`fighter[${i}] ${tag} side=${f.side} hp=${f.hp} banked=${f.banked} dead=${f.dead}`);
      playersHold += BigInt(f.hp.toString()) + BigInt(f.banked.toString());
    }
    const houseTook = penalties + fees;
    console.log(`
  players_hold    ${playersHold}   ${c.d}sum(hp + banked), still owed to fighters${c.x}
  house_took      ${houseTook}   ${c.d}penalties_collected ${penalties} + fees_collected ${fees}${c.x}
  gross_deposits  ${BigInt(final.pot.toString()) + fees}   ${c.d}pot ${final.pot} + fees_collected ${fees}${c.x}`);
    if (fees === 0n) throw new Error("fees_collected is zero — conservation would not be exercising the fee term");
    if (penalties === 0n) throw new Error("penalties_collected is zero — the brief requires BOTH takes non-zero");
    ok(`both house takes are non-zero (fees ${fees}, penalties ${penalties})`);
    assertEq(playersHold + houseTook, BigInt(final.pot.toString()) + fees, "players_hold + house_took == gross_deposits");
    assertEq(BigInt(final.pot.toString()) + fees, grossDeposits, "gross_deposits equals what the two players were charged at the door");
    assertEq(fees, expectedFees, "fees_collected survived the round unchanged");

    // ---- 14. sweep_house_take ---------------------------------------------------------------------
    heading("14. sweep_house_take — the take reaches the arena's books");
    if (final.houseSwept) throw new Error("round is already swept before this script swept it");
    {
      // Permissionless: signed by PLAYER B, who is neither the arena authority nor an account in the
      // instruction. That is the claim being tested, so a fork-payer signature here would prove less.
      const { signature } = await sendTx(
        router,
        roundIx.sweepHouseTake(playerBProgram, { arena: arenaPda, round: roundPda, treasury: treasuryPda, roundNo }),
        playerB,
        "sweep_house_take (signed by player B — permissionless)",
      );
      signatures.sweepHouseTake = signature;
    }
    // `accept` on rounds_swept, not just existence: the treasury was already readable with its
    // PRE-sweep contents, so a bare read here could assert against the numbers we started with and
    // "pass" by comparing zero to zero.
    const treasuryAfter = await readSettled(
      "treasury after sweep_house_take",
      () => authorityBase.account.treasury.fetchNullable(treasuryPda),
      (t) => BigInt(t.roundsSwept.toString()) === roundsSweptBefore + 1n,
    );
    assertEq(BigInt(treasuryAfter.feesAccrued.toString()), treasuryFeesBefore + fees, "Treasury.fees_accrued");
    assertEq(BigInt(treasuryAfter.penaltiesAccrued.toString()), treasuryPenaltiesBefore + penalties, "Treasury.penalties_accrued");
    assertEq(BigInt(treasuryAfter.roundsSwept.toString()), roundsSweptBefore + 1n, "Treasury.rounds_swept");
    await readSettled(
      "round.house_swept after sweep_house_take",
      () => authorityBase.account.round.fetchNullable(roundPda),
      (r) => r.houseSwept === true,
    );
    ok("Round.house_swept is now true");

    await expectRejection(
      "a SECOND sweep of the same round",
      "AlreadySwept",
      () => sendTx(
        router,
        roundIx.sweepHouseTake(playerBProgram, { arena: arenaPda, round: roundPda, treasury: treasuryPda, roundNo }),
        playerB,
        "sweep_house_take (second time, must fail)",
      ),
    );

    // ---- 15. the ledger, stated plainly ----------------------------------------------------------
    heading("15. what the house is owed for this round");
    console.log(`
  fee rate            ${feeBps} bps (unchanged by this run)
  gross deposits      ${grossDeposits}
  fees collected      ${fees}   ${c.d}= floor(${STAKE_A}x${feeBps}/10000) + floor(${STAKE_B}x${feeBps}/10000) = ${feeA} + ${feeB}${c.x}
  penalties collected ${penalties}
  house take          ${houseTook}
  treasury total      fees_accrued=${treasuryAfter.feesAccrued} penalties_accrued=${treasuryAfter.penaltiesAccrued} rounds_swept=${treasuryAfter.roundsSwept}`);
    warn("these are RECORDS, not custody — sweep_house_take moves no lamports (see this file's header)");

    const endBalance = await base.getBalance(forkPayer.publicKey);
    heading("16. cost");
    info(`fork-payer spent ${((startBalance - endBalance) / LAMPORTS_PER_SOL).toFixed(6)} SOL this run  (balance ${(endBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);

    heading("17. signatures");
    for (const [step, sig] of Object.entries(signatures)) info(`${step.padEnd(18)} ${sig}`);

    console.log(`\n${c.g}${c.b}HOUSE TAKE VERIFICATION COMPLETE${c.x} — the fee lands, the authority closes early and nobody else does, conservation holds with both takes non-zero.`);
    process.exit(0);
  } catch (e) {
    console.error(`\n${c.r}${c.b}VERIFICATION FAILED${c.x}`);
    console.error(`  ${c.r}${describeError(e)}${c.x}`);
    console.error(`  signatures collected before failure:`, signatures);
    process.exitCode = 1;
  }
})();
