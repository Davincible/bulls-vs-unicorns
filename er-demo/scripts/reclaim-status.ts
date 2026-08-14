#!/usr/bin/env bun
// RENT RECLAMATION, AS IT STANDS RIGHT NOW — the instrument COST-MODEL.md §4 names.
//
//   cd er-demo && bun run scripts/reclaim-status.ts
//
// WHY THIS EXISTS. §4 of COST-MODEL.md is the only section that matters, and it ends with an
// instruction: "Watch `Treasury.rounds_swept` against `Arena.round_counter` for the first day of
// continuous running. If the gap grows, the burn is 330× the headline and the balance is gone in a
// day and a half." That sentence had no tool behind it. This is the tool.
//
// At 424 rounds/day a reclamation outage costs ~9.96 SOL/day, and it does not announce itself: rounds
// keep opening, fights keep resolving, the front end keeps working. The only visible symptom is a
// number going up that should stay flat. Hence a command whose entire job is to print that number.
//
// SAFE TO RUN BESIDE THE LIVE KEEPER, which is the property that makes it usable in the situation it
// is for. It signs nothing and sends nothing: every verdict comes from `simulateTransaction`, which
// executes against a snapshot and cannot alter state. Contrast `verify-round-close.ts`, which proves
// the same instruction far more thoroughly but does so by OPENING 22 ROUNDS against the live arena —
// a second writer to `arena.round_counter`, i.e. the two-keeper failure that `extendHouseBank.ts`
// opens by warning about. This script is the one you can reach for without stopping production.
//
// WHAT THE VERDICTS MEAN:
//
//   WOULD SUCCEED     past the retention window, terminal, swept, undelegated. The keeper's
//                     `closeOneFinishedRound` will reclaim this round's rent on a coming pass. If
//                     these accumulate while the keeper is up, closing is broken — that is the alarm.
//   RoundTooRecent    inside MIN_RETAINED_ROUNDS. Correct and expected for the newest 20 rounds;
//                     this is float, not loss (COST-MODEL.md §3).
//   AccountOwnedBy…   still delegated — the Delegation Program owns it. Normal for the live round,
//     WrongProgram    and a stranded-rent risk only if it persists after the round is settled (§4.3).
//   RoundNotSwept /   terminal but unswept: the keeper fixes this itself by sweeping first.
//     phase=0 forever a round stuck in Lobby can NEVER be closed and its rent is gone (§4.2).
//
// The refusal is printed verbatim from the program's own logs rather than being re-described here,
// because the failure this is guarding against is precisely "the reason changed and nobody noticed".

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import * as roundIx from "../src/chain/round.ts";
import { createProgram } from "../src/chain/program.ts";
import { BASE_RPC, MIN_RETAINED_ROUNDS } from "../src/chain/constants.ts";

/** The arena authority. Read-only here — it is the `authority` an eventual close would pay out to and
 *  must be the fee payer for the simulation to reflect the real transaction, but nothing signs. */
const OPERATOR = new PublicKey("9BAjpGZfJm8sfnqNr1vj1K9X3fY8fjk4LE2KRtSTRCaj");

const conn = new Connection(BASE_RPC, "confirmed");

// Anchor requires a wallet to build instructions. This one cannot sign: the signing methods hand back
// the transaction untouched, so an accidental `.rpc()` anywhere below would fail rather than send.
const wallet = {
  publicKey: OPERATOR,
  signTransaction: async (t: unknown) => t,
  signAllTransactions: async (t: unknown) => t,
} as never;

const program = (await createProgram(conn, wallet)) as never as {
  programId: PublicKey;
  account: Record<string, { fetch(k: PublicKey): Promise<Record<string, { toString(): string }>>; fetchNullable(k: PublicKey): Promise<Record<string, unknown> | null> }>;
};

const arenaPda = roundIx.arenaPda();
const arena = await program.account.arena.fetch(arenaPda);
const counter = BigInt(arena.roundCounter.toString());

const treasury = (await program.account.treasury.fetchNullable(roundIx.treasuryPda(arenaPda))) as
  | { roundsSwept: { toString(): string } }
  | null;
const swept = treasury ? BigInt(treasury.roundsSwept.toString()) : -1n;

console.log(`program          ${program.programId.toBase58()}`);
console.log(`round_counter    ${counter}`);
console.log(`rounds_swept     ${swept}`);
// The gap is the headline. One is healthy — the live round is not swept until it settles. A gap that
// climbs past the retention window is the 9.96 SOL/day failure in progress.
console.log(`SWEEP GAP        ${counter - swept}   (1 is healthy: the live round is unswept until it settles)`);
console.log(`retention        ${MIN_RETAINED_ROUNDS} rounds\n`);

let held = 0;
let closeable = 0;
let stranded = 0;

for (let n = 1n; n <= counter; n++) {
  const pda = roundIx.roundPdaForRoundNo(n, arenaPda);
  const info = await conn.getAccountInfo(pda);
  if (!info) {
    console.log(`round #${n}  CLOSED — rent already reclaimed`);
    continue;
  }
  held += info.lamports;

  const round = (await program.account.round.fetchNullable(pda).catch(() => null)) as
    | { phase: number; houseSwept?: number }
    | null;
  const delegated = info.owner.toBase58() !== program.programId.toBase58();

  let verdict: string;
  try {
    const tx = new Transaction().add(
      await roundIx
        .closeRoundAccount(program as never, { arena: arenaPda, round: pda, authority: OPERATOR, roundNo: n })
        .instruction(),
    );
    tx.feePayer = OPERATOR;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) {
      // The program's own words, not a re-description. `.slice(-2)` keeps the AnchorError line and
      // the failure line and drops the compute-units noise after them.
      const why = (sim.value.logs ?? []).filter((l) => /Error|custom|constraint|require/i.test(l)).slice(-2).join("\n           ");
      verdict = `REFUSED\n           ${why}`;
      if (round?.phase === 0 && n + BigInt(MIN_RETAINED_ROUNDS) <= counter) stranded += info.lamports;
    } else {
      verdict = `WOULD SUCCEED — ${(info.lamports / 1e9).toFixed(6)} SOL waiting to come back`;
      closeable += 1;
    }
  } catch (e) {
    verdict = `BUILD FAILED  ${(e as Error).message?.slice(0, 120)}`;
  }

  console.log(
    `round #${n}  size=${info.data.length}b rent=${(info.lamports / 1e9).toFixed(6)} phase=${round?.phase ?? "?"} swept=${(round?.houseSwept ?? 0) !== 0} delegated=${delegated}\n           ${verdict}`,
  );
}

console.log(`\nrent held by open round accounts   ${(held / 1e9).toFixed(6)} SOL`);
console.log(`rounds the keeper could close now  ${closeable}${closeable > 3 ? "   <-- the keeper is not closing. Check it." : ""}`);
if (stranded > 0) console.log(`UNRECOVERABLE (stuck in Lobby)     ${(stranded / 1e9).toFixed(6)} SOL   see COST-MODEL.md §4.2`);
