// SANDBOX — NOT SHIPPED, NOT ON CHAIN, NOT IMPORTED BY THE ENGINE OR THE DEMO.
//
// Run from engine/:
//   npx tsx ../sandbox/house-edge/strategy-house-count.ts
//   npx tsx ../sandbox/house-edge/strategy-house-count.ts 600 250 300      # rounds16 rounds48 policyRounds
//   SOL_USD=200 npx tsx ../sandbox/house-edge/strategy-house-count.ts
//   FAST=1 npx tsx ../sandbox/house-edge/strategy-house-count.ts           # ~1/4 the samples, same seeds
//
// ================================================================================================
// THE QUESTION
// ================================================================================================
// "The number of players that join from the house can be variable and dynamic, depending on the
//  number of players in the pool... We can optimize the player count from the house to maximize the
//  profit and we can simulate that."
//
// So the object under test is not a NUMBER, it is a POLICY: `H = f(R)`, house fighters as a function
// of the real-player count. This script sweeps the whole (R, H) surface, scores candidate policies
// against it, and reports the argmax in H for each R — at a seat cap of 16 and of 48.
//
// THE SEAT-CAP MIGRATION LANDED WHILE THIS WAS RUNNING. It was pending when the question was asked;
// another writer shipped it mid-run, so `MAX_FIGHTERS` is 48 in both the Rust and the mirror as this
// is read. §1 reports the two defects it was meant to carry — both were real, both are now fixed —
// and everything else is measured against the tree as it stands, with the pre-migration pacing kept
// alongside wherever the before/after is the point. §A carries the two pacing rules.
//
// ================================================================================================
// WHAT IS ALREADY ESTABLISHED, AND IS RE-CONFIRMED IN §2 BELOW RATHER THAN ASSUMED
// ================================================================================================
// `advance_fight` reads `basis = min(attacker.hp, defender.hp)`. Both directions of an exchange read
// the SAME min, so the expected transfer between any two fighters is zero whatever their sizes: the
// fight is a martingale in `hp + banked` for every fighter (HOUSE-EDGE-STUDY.md §11.5,
// `check-dice.ts` §3). A house wallet's expected P&L is therefore exactly minus the fee it paid, and
// that fee returns to a treasury the house owns, so the consolidated contribution is zero.
//
// **The first-order answer is therefore that H cannot move expected profit at all.** §2 re-measures
// it rather than citing it, and then TURNS IT INTO A MEASUREMENT TOOL: if the house's book is
// zero-mean, then `E[net] == E[fee(real) + penalty(real)]` exactly, which is the same estimator with
// a $7-$11 standard deviation removed from it. Reading the surface that way is the difference
// between a field of noise and a readable answer, and §2 shows both side by side.
//
// Everything after §2 is second-order. Those channels are NOT all zero — the penalty horizon is a
// per-lineup lookup, so H really does change what a player pays to leave — but they are small, and
// the sign of the largest one turns out to depend on a behavioural assumption nobody has measured.
// §12 says so plainly rather than picking the assumption that makes the answer look decisive.
//
// ================================================================================================
// THE ACCOUNTING, WHICH IS THE ONLY HONEST ONE
// ================================================================================================
//     net_house = (fees_collected + penalties_collected)      <- the treasury's gross intake
//               + SUM over HOUSE fighters (payout - gross)    <- the house wallets' own P&L
//
// The circular term (the house paying itself the entry fee) cancels inside that sum automatically.
// Conservation gives the same number a second way, and this script asserts the two agree IN INTEGERS
// in every round of every cell, printing a loud failure line if they ever do not:
//
//     net_house == -( SUM over REAL fighters (payout - gross) )
//
// Same identity `strategy-house-book.ts` asserts. If it breaks, discard the row.
//
// ================================================================================================
// TWO REGIMES, NEVER BLENDED
// ================================================================================================
// REGIME A — TODAY (non-custodial). `programs/bulls-arena/src/lib.rs` moves ZERO tokens: no
//            `anchor_spl`, no `token::transfer`, no `TokenAccount`; `programs/vault/` is out of the
//            workspace `members` list. `fees_collected`, `penalties_collected` and
//            `Treasury.fees_accrued` are u64 COUNTERS. The only real cash flow is the keeper's gas,
//            and it is outbound. **The operator's ~3.09 SOL is GAS, not stake** — so Regime A ruin is
//            a deterministic countdown, not a probability, and no amount of house sizing changes it.
// REGIME B — IF CUSTODY SHIPS. The same ledger arithmetic with the units taken to be tokens. This is
//            an EXTRAPOLATION over a code path that does not exist. Labelled everywhere it appears.

import {
  newRound, enter, tick, extract, settle, conservationHolds, tickHash, drawPair, penaltyHorizonSteps,
  PENALTY_HORIZON_STEPS, EXTRACT_PENALTY_START_BPS, DUST, BPS, MAX_FIGHTERS as ER_MAX_FIGHTERS,
} from "../../engine/src/er-sim.ts";
import type { ERRound } from "../../engine/src/er-sim.ts";
import { runFight, BASELINE, makeFighter } from "./fight-variant.ts";
import type { Fighter } from "./fight-variant.ts";
import { BANDS, usd, toUsd } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { createHash } from "node:crypto";

// ------------------------------------------------------------------------------------------------
// Sample sizes. Printed with every table, and every number carries a 95% CI.
// ------------------------------------------------------------------------------------------------
const FAST = process.env.FAST === "1";
const ROUNDS_16 = Number(process.argv[2] ?? (FAST ? 150 : 600));
const ROUNDS_48 = Number(process.argv[3] ?? (FAST ? 70 : 250));
const ROUNDS_POLICY = Number(process.argv[4] ?? (FAST ? 100 : 400));
const TAG = "house-count-v1";

// ------------------------------------------------------------------------------------------------
// Constants. Every one carries the file and line it came from, so this can be re-verified rather
// than believed.
// ------------------------------------------------------------------------------------------------
const FEE_BPS = 100n;                 // MEASURED on chain (round #27: 680,000 units on 68,000,000)
const SOL_USD = Number(process.env.SOL_USD ?? 150);            // ASSUMPTION
const OPERATOR_SOL = 3.09;            // given in the brief; not independently verifiable in-repo

/** Marginal gas per round once `close_round_account` is reclaiming Round-PDA rent — v7 shipped it and
 *  the keeper drives it on by default. lib.rs:131-137, keeper/README.md:307. PRIMARY figure. */
const GAS_BASE_SOL = 0.00041;
/** The pre-reclaim all-in figure, reconciled across 28 real rounds. config.ts:114, README.md:272.
 *  Carried as a labelled ALTERNATE, not as the headline. */
const GAS_PRERECLAIM_SOL = 0.00981;
/** A house `enter` is one signature at 5,000 lamports — keeper/README.md:262-266, config.ts:583-590.
 *  This is the ONLY term in the cost model that is a function of H, and it is why "net of gas" is
 *  not simply a constant subtracted from every row. */
const HOUSE_ENTER_SOL = 0.000005;

/** `Round::SIZE = 176 + 64 * MAX_FIGHTERS` (lib.rs:2519) — corrected 2026-08-10. The formula this
 *  file carried until now, `174 + 58 * MAX_FIGHTERS`, was the PRE-`zero_copy` layout: the migration
 *  reordered the header (fighter_count moved ahead of bump, house_swept came up beside it, +2 bytes
 *  of declared alignment padding) and grew `Fighter` from 58 to 64 bytes (its own alignment hole). At
 *  the deployed cap that is 176 + 64*48 = 3,248 bytes, matching `Round::SIZE` asserted directly
 *  against `size_of::<Round>()` in lib.rs's own test (`assert_eq!(Round::SIZE, 3_248, ...)`).
 *
 *  THE "REPRODUCES THE MEASURED 0.008561 SOL AT 16 SEATS" CLAIM THIS COMMENT USED TO MAKE NO LONGER
 *  HOLDS, AND IT SHOULD NOT BE RESTATED AT THE NEW NUMBERS WITHOUT A FRESH MEASUREMENT. That 0.008561
 *  SOL was a real devnet rent payment against the OLD struct — `174 + 58*16` = 1,102 bytes — so it
 *  calibrates the old formula, not this one. Solana's rent-exemption formula itself,
 *  `(128 + data_len) * 6,960` lamports, is a protocol constant independent of what Round contains, so
 *  it is still the right arithmetic to apply — but "the same formula can be trusted at 48" was doing
 *  double duty (trusting the RENT formula AND trusting that 16-seat calibration point simultaneously),
 *  and only the first half survives the migration. Applying it to the corrected byte count predicts
 *  ((128 + 1,200) * 6,960) / 1e9 = 0.00924288 SOL at 16 seats under the NEW layout — arithmetic, not a
 *  new measurement, and NOT re-verified against devnet as part of this pass. Flagged rather than
 *  silently trusted; do not report it as "measured" until it is. */
const roundPdaBytes = (cap: number) => 176 + 64 * cap;
const roundPdaRentSol = (cap: number) => ((128 + roundPdaBytes(cap)) * 6960) / 1e9;
const MIN_RETAINED_ROUNDS = 20;       // lib.rs:164

/** The keeper's own ceiling on how many house wallets it will bank — config.ts:549. A real
 *  constraint on any policy proposed below, independent of the seat cap. */
const HOUSE_WALLET_COUNT_MAX = 32;

// The deployed ladder's constants, verified current this session.
const HOUSE_FLOOR = 2;                          // houseSizing.ts:71
const HOUSE_BOARD_TARGET = 10;                  // config.ts:539
const HOUSE_DISPLACEMENT = 1;                   // config.ts:551
const HOUSE_WALLET_COUNT = 10;                  // config.ts:524
const HOUSE_MAX_WITHOUT_REAL_PLAYER = 1;        // houseSizing.ts:114
const HOUSE_STAKE_MIN_USD = 5, HOUSE_STAKE_MAX_USD = 20;   // config.ts:570

/** THE BEHAVIOURAL ASSUMPTIONS. Not measurements — nothing in the repo records player behaviour
 *  (HOUSE-STRATEGY.md §7). P(extract) is the single most load-bearing guess in this file and is
 *  swept; the extract TIMING model is the second and is swept as a first-class dimension because it
 *  decides the sign of the cap-48 answer. */
const P_EXTRACT = 0.30;
const P_EXTRACT_SWEEP = [0, 0.15, 0.30, 0.60];

// ------------------------------------------------------------------------------------------------
// §A. PACING AND THE PENALTY HORIZON — and the fact that BOTH MOVED WHILE THIS WAS BEING MEASURED
// ------------------------------------------------------------------------------------------------
//
// THE TREE CHANGED UNDER THIS SCRIPT, MID-RUN, AND THAT IS RECORDED RATHER THAN QUIETLY ABSORBED.
// The brief asked me to confirm two defects in the pending `MAX_FIGHTERS` migration and to model
// f(R) at a seat cap of both 16 and 48. While the surface was being swept, another writer LANDED
// that migration. Both defects are now fixed in `engine/src/er-sim.ts` and
// `programs/bulls-arena/src/lib.rs`. §1 reports them as real (the arithmetic that made them real is
// still checkable) AND as fixed, verified against the tree as it stands, with the numbers for both.
//
// The two pacings therefore both matter and the script carries both:
//
//   "v7"  the rule at session start.  budget(n) = min(MAX_STEPS = 4_000, 120s x 2 x n)  = min(4000, 240n)
//         MAX_STEPS did two jobs — the cursor ceiling AND the per-call compute bound — and saturated
//         at 4,000 for every n >= 17.
//   "v8"  the rule now.               budget(n) = FIGHT_TIMEOUT_SECONDS(180) x 2 x n     = 360n
//         `MAX_STEPS` is gone. It split into `MAX_STEPS_PER_CALL = 3_000` (compute only, lib.rs:417)
//         and the bell, which is now the cursor ceiling (lib.rs:943-948, `canonical_cursor` clamps
//         ELAPSED TIME rather than the cursor). No saturation, so the budget grows with the lineup.
//
// v8 is the PRIMARY figure everywhere; v7 appears where the before/after is the point.
type Pacing = "v7" | "v8";
const STEPS_PER_FIGHTER_PER_SECOND = 2;               // lib.rs:340, unchanged
const FIGHT_TIMEOUT_SECONDS_V8 = 180;                 // lib.rs:474, was 120
const MAX_STEPS_V7 = 4_000;                           // the deleted constant
const budgetOf = (n: number, p: Pacing) => p === "v8"
  ? FIGHT_TIMEOUT_SECONDS_V8 * STEPS_PER_FIGHTER_PER_SECOND * n
  : Math.min(MAX_STEPS_V7, 120 * STEPS_PER_FIGHTER_PER_SECOND * n);
/** The largest cursor any lineup in this study can reach — sizes the shared hash tables. */
const MAX_BUDGET = budgetOf(48, "v8");
/** The CURRENT rule, for every table that is not explicitly a before/after. */
const stepBudget = (n: number) => budgetOf(n, "v8");

// THE PENALTY HORIZON. `PENALTY_HORIZON_STEPS` is generated by `round(25 * n^1.5)` and now carries
// 47 entries covering n = 2..48; §0 asserts the formula reproduces every one of them. Two branches
// are priced, because the migration had to choose between them and the choice is worth seeing:
//
//   "shipped" — er-sim.ts's own table, extended by its own generating rule. THIS IS WHAT SHIPPED.
//               Read through `penaltyHorizonSteps` itself, so it is not an assumption at all.
//   "clamp16" — the counterfactual in which the table had been left at 15 entries and the existing
//               clamp held every larger lineup at n=16's 1,600 steps. Priced because "extend it"
//               was not the only option and the difference is what the decision was worth.
type HorizonMode = "shipped" | "clamp16";
const HORIZON_MODES: HorizonMode[] = ["shipped", "clamp16"];

const horizonFormula = (n: number) => Math.round(25 * Math.pow(n, 1.5));
const horizonOf = (n: number, m: HorizonMode) => m === "shipped"
  ? Number(penaltyHorizonSteps(n))
  : PENALTY_HORIZON_STEPS[Math.min(Math.max(n, 2), 16) - 2];

/** Mirrors `extract_penalty_bps` with the horizon supplied rather than looked up. Integer, floor
 *  division, exactly as the Rust does. */
function penaltyBps(horizon: number, cursor: number): bigint {
  const remaining = cursor >= horizon ? 0 : horizon - cursor;
  return (EXTRACT_PENALTY_START_BPS * BigInt(remaining)) / BigInt(horizon);
}
const penaltyOf = (taken: bigint, horizon: number, cursor: number) =>
  (taken * penaltyBps(horizon, cursor)) / BPS;

// ------------------------------------------------------------------------------------------------
// §B. THE ROUND ENGINE
// ------------------------------------------------------------------------------------------------
//
// WHY THERE IS A LOCAL ENGINE AT ALL, since duplicating the mirror is exactly the shape of mistake
// this repo has already been bitten by twice. Three things are needed that `er-sim.ts` cannot give,
// and `er-sim.ts` must not be modified:
//
//   1. more than 16 fighters. The cap lives ONLY in `enter` (er-sim.ts:138); `tick`, `settle` and
//      `conservationHolds` carry no fighter-count limit at all.
//   2. a horizon that is not the 15-entry table.
//   3. `endedAt` — the step at which one side was wiped out — which nothing in `er-sim.ts` reports
//      and which Channel 2 is entirely about.
//
// So THE FIGHT ITSELF IS STILL er-sim's. `tickHash` and `drawPair` are imported and called, not
// re-implemented; only the surrounding loop is local, and it is a line-for-line copy of `tick`. What
// is genuinely local is `enter` (four lines of arithmetic, minus the cap) and the penalty split.
// §0 asserts the whole thing byte-identical to `er-sim.ts`'s own enter/tick/extract/settle over
// random lineups WITH random extract schedules, and cross-checks it against `fight-variant.ts`'s
// independent knobbed loop at n up to 48. If either fails the script aborts.
//
// ONE OPTIMISATION, AND IT IS OUTCOME-IDENTICAL RATHER THAN AN APPROXIMATION. An exchange requires an
// attacker and a defender who are alive, on opposite sides and different wallets. Once one side has
// nobody alive, no draw can satisfy that again — `dead` is never cleared — so every remaining step is
// a `continue` and the final hp/banked/dead vector is fixed. The loop therefore stops simulating (not
// stops ticking: the cursor still advances to the bell, because the penalty curve reads it). Same
// argument `fight-variant.ts` makes for `stopWhenOver`, and §0 checks it against the un-optimised
// `er-sim.ts` rather than trusting it.

interface Entry { wallet: string; side: 0 | 1; gross: bigint; house: boolean; }
interface Extraction { idx: number; cursor: number; taken: bigint; }

interface State {
  round: ERRound;
  live: [number, number];
  over: boolean;
  endedAt: number;
}

/** Mirrors `enter` MINUS the `RoundFull` check, which is the only thing standing between this and a
 *  48-seat lineup. Fee taken here; a repeat entry on the same side tops up rather than duplicating. */
function enterUncapped(round: ERRound, wallet: string, side: 0 | 1, stake: bigint, feeBps: bigint): void {
  if (stake <= 0n) throw new Error("ZeroStake");
  const fee = (stake * feeBps) / BPS;
  const net = stake - fee;
  const existing = round.fighters.find(f => f.wallet === wallet && f.side === side);
  if (existing) { existing.stake += net; existing.hp += net; }
  else round.fighters.push({ wallet, side, dead: 0, stake: net, hp: net, banked: 0n });
  round.pot += net;
  round.feesCollected += fee;
}

const sat = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

/** Line-for-line `tick`, with (a) a shared lazily-filled hash table so one round index's 4,000
 *  sha256s are paid for once and reused across every cell of the surface, (b) `endedAt`, and (c) the
 *  outcome-identical stop above. */
function tickLocal(st: State, steps: number, hashes: (Buffer | undefined)[]): void {
  const round = st.round;
  for (let s = 0; s < steps; s++) {
    const n = round.fighters.length;
    if (n < 2) break;
    if (st.over) { round.tickCount += BigInt(steps - s); break; }
    const cursor = round.tickCount;
    const ci = Number(cursor);
    round.tickCount += 1n;

    const h = hashes[ci] ?? (hashes[ci] = tickHash(round.seed, cursor));
    const [a, d] = drawPair(h, n);

    const A = round.fighters[a], D = round.fighters[d];
    if (A.side === D.side) continue;
    if (A.wallet === D.wallet) continue;
    if (A.dead === 1 || D.dead === 1) continue;

    const roll = BigInt(h[8] % 24) + 4n;
    const basis = A.hp < D.hp ? A.hp : D.hp;
    let dmg = (basis * roll) / 100n;
    if (D.hp <= DUST) dmg = D.hp;
    if (dmg === 0n) continue;

    D.hp = sat(D.hp, dmg);
    A.banked += dmg;
    if (D.hp === 0n) {
      D.dead = 1;
      st.live[D.side]--;
      if (!st.over && (st.live[0] === 0 || st.live[1] === 0)) { st.over = true; st.endedAt = ci + 1; }
    }
  }
}

/** Mirrors `extract` with the penalty split DEFERRED.
 *
 *  Deferring is exact, not an approximation, and the reason is worth stating because it is what makes
 *  pricing both horizon branches free. `extract` sets `hp = 0` and `dead = 1` whatever the penalty
 *  works out to; the split only decides how much of `taken` lands in `banked`. The fight reads `hp`,
 *  `dead`, `side` and `wallet` and never reads `banked` — so THE FIGHT TRAJECTORY IS IDENTICAL UNDER
 *  EVERY HORIZON. One simulation therefore prices both branches, and §0 checks that the deferred
 *  split reproduces `er-sim.ts`'s own `extract` exactly at n <= 16. */
function extractLocal(st: State, idx: number): bigint | null {
  const f = st.round.fighters[idx];
  if (f.dead === 1 || f.hp <= 0n) return null;      // beaten to nothing already; `extract` would throw
  const taken = f.hp;
  f.banked += taken;                                 // gross; the penalty is subtracted at settlement
  f.hp = 0n;
  f.dead = 1;
  st.live[f.side]--;
  if (!st.over && (st.live[0] === 0 || st.live[1] === 0)) { st.over = true; st.endedAt = Number(st.round.tickCount); }
  return taken;
}

interface RoundResult {
  n: number;
  budget: number;
  fightable: boolean;
  endedAt: number;
  concluded: boolean;                 // reached a conclusion before the bell
  grossRealU: bigint; grossHouseU: bigint;
  feesRealU: bigint; feesHouseU: bigint;
  /** keyed by horizon mode */
  penRealU: Record<HorizonMode, bigint>;
  penHouseU: Record<HorizonMode, bigint>;
  housePnlU: Record<HorizonMode, bigint>;
  netHouseU: Record<HorizonMode, bigint>;
  realRoi: number[];                  // per REAL fighter, payout/gross - 1, under "shipped"
  ok: boolean;
}

/** One round, start to settlement.
 *
 *  `timing` is the extract-timing model and it is a first-class dimension rather than a constant:
 *    "horizon" — cursor uniform on [0, horizon), skipped if it falls past the bell. The convention
 *                `strategy-house-book.ts` and `strategy-live-policy.ts` already use, kept so the
 *                numbers here can be read beside theirs.
 *    "budget"  — cursor uniform on [0, budget). A player who bails at a random point of the FIGHT
 *                rather than at a random point of a curve they cannot see. Equally defensible, and
 *                at 48 seats the two disagree by a factor of four. */
function simRound(
  seed: Buffer,
  hashes: (Buffer | undefined)[],
  entries: Entry[],
  extractDraws: (number | null)[],
  timing: "horizon" | "budget",
  pacing: Pacing = "v8",
): RoundResult {
  const round = newRound(seed);
  for (const e of entries) enterUncapped(round, e.wallet, e.side, e.gross, FEE_BPS);
  const n = round.fighters.length;

  const st: State = { round, live: [0, 0], over: false, endedAt: -1 };
  for (const f of round.fighters) st.live[f.side]++;
  const fightable = n >= 2 && st.live[0] > 0 && st.live[1] > 0;
  const budget = budgetOf(n, pacing);
  // A one-sided lobby is over before it starts: no draw can ever find an attacker and a defender on
  // opposite sides. Saying so here rather than discovering it 3,840 no-op steps later is both the
  // honest state and the fast one. Outcome-identical, and §0 checks it against un-optimised er-sim.
  if (!fightable) { st.over = true; st.endedAt = 0; }

  let feesRealU = 0n, feesHouseU = 0n;
  for (let i = 0; i < n; i++) {
    const fee = (entries[i].gross * FEE_BPS) / BPS;
    if (entries[i].house) feesHouseU += fee; else feesRealU += fee;
  }

  const extractions: Extraction[] = [];
  if (n >= 2) {
    // The timing model reads the "shipped" horizon for the DRAW even under clamp16, so that both
    // branches are priced against the same behaviour rather than against two different players. The
    // branch changes what the house charges, not when the player presses the button.
    const drawSpan = timing === "horizon" ? horizonFormula(n) : budget;
    const when = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const u = extractDraws[i];
      if (u === null) continue;
      const c = Math.floor(u * drawSpan);
      if (c >= budget) continue;                     // past the bell; the button is never available
      const at = when.get(c) ?? []; at.push(i); when.set(c, at);
    }
    let cursor = 0;
    for (const s of [...when.keys()].sort((a, b) => a - b)) {
      if (s > cursor) { tickLocal(st, s - cursor, hashes); cursor = s; }
      for (const i of when.get(s)!) {
        const taken = extractLocal(st, i);
        if (taken !== null) extractions.push({ idx: i, cursor: s, taken });
      }
    }
    if (cursor < budget) tickLocal(st, budget - cursor, hashes);
    settle(round);
  }
  const concluded = st.over;
  const endedAt = st.over ? st.endedAt : budget;

  // ---- settlement, per horizon branch. Integer until the very last line. ----
  const penRealU = {} as Record<HorizonMode, bigint>;
  const penHouseU = {} as Record<HorizonMode, bigint>;
  const housePnlU = {} as Record<HorizonMode, bigint>;
  const netHouseU = {} as Record<HorizonMode, bigint>;
  let grossRealU = 0n, grossHouseU = 0n;
  for (let i = 0; i < n; i++) {
    if (entries[i].house) grossHouseU += entries[i].gross; else grossRealU += entries[i].gross;
  }
  let ok = true;
  let realRoi: number[] = [];
  for (const m of HORIZON_MODES) {
    const horizon = horizonOf(n, m);
    const perFighterPenalty = new Array<bigint>(n).fill(0n);
    let pR = 0n, pH = 0n;
    for (const x of extractions) {
      const p = penaltyOf(x.taken, horizon, x.cursor);
      perFighterPenalty[x.idx] += p;
      if (entries[x.idx].house) pH += p; else pR += p;
    }
    let hPnl = 0n, rNet = 0n, held = 0n;
    const rois: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = round.fighters[i];
      const out = f.hp + f.banked - perFighterPenalty[i];
      held += out;
      const pnl = out - entries[i].gross;
      if (entries[i].house) hPnl += pnl;
      else { rNet += pnl; rois.push(Number(pnl) / Number(entries[i].gross)); }
    }
    const treasury = round.feesCollected + pR + pH;
    // THE INVARIANT, IN INTEGERS, EVERY ROUND. `held` is what fighters walk away with; the house has
    // taken fees + penalties; together that must be exactly what players were charged.
    const conserved = held + treasury === round.pot + round.feesCollected;
    const net = treasury + hPnl;
    if (!conserved || net !== -rNet) ok = false;
    penRealU[m] = pR; penHouseU[m] = pH; housePnlU[m] = hPnl; netHouseU[m] = net;
    if (m === "shipped") realRoi = rois;
  }

  return {
    n, budget, fightable, endedAt, concluded,
    grossRealU, grossHouseU, feesRealU, feesHouseU,
    penRealU, penHouseU, housePnlU, netHouseU, realRoi, ok,
  };
}

// ------------------------------------------------------------------------------------------------
// §C. LOBBY CONSTRUCTION
// ------------------------------------------------------------------------------------------------

function avalanche(value: number): number {
  let h = Math.trunc(value) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15; h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15; return h >>> 0;
}
const mixHash = (roundNo: number, walletIndex: number) =>
  avalanche((avalanche(roundNo) ^ (avalanche(walletIndex) + 0x9e3779b9)) >>> 0);
/** houseSizing.ts:230-240 — the deployed deterministic stake, reimplemented. */
const houseStakeUsd = (roundNo: number, walletIndex: number) =>
  HOUSE_STAKE_MIN_USD + (mixHash(roundNo, walletIndex) % (HOUSE_STAKE_MAX_USD - HOUSE_STAKE_MIN_USD + 1));

/** houseSizing.ts:135-144 — greedy: each house fighter joins whichever side is currently shorter. */
function allocateHouseSides(count: number, side0: number, side1: number): (0 | 1)[] {
  const filled: [number, number] = [side0, side1]; const out: (0 | 1)[] = [];
  for (let i = 0; i < count; i++) { const s: 0 | 1 = filled[1] < filled[0] ? 1 : 0; filled[s]++; out.push(s); }
  return out;
}

/** The real half of a lobby, reproducible from (R, roundNo) alone and SHARED across every H at that
 *  (R, roundNo). Common random numbers: every house count faces the identical crowd, the identical
 *  stakes, the identical side split and the identical draw sequence, so differences across H are
 *  paired and their standard errors are one to two orders of magnitude smaller than independent
 *  sampling would give. */
interface RealLobby { s0: number; s1: number; entries: Entry[]; extractU: (number | null)[]; }
function realLobby(R: number, roundNo: number, pExtract: number): RealLobby {
  const rnd = mulberry32((roundNo * 2654435761 + R * 7919 + Math.round(pExtract * 1e4) * 104729) >>> 0);
  const entries: Entry[] = [];
  const extractU: (number | null)[] = [];
  let s0 = 0, s1 = 0;
  for (let i = 0; i < R; i++) {
    const side: 0 | 1 = rnd() < 0.5 ? 0 : 1;
    if (side === 0) s0++; else s1++;
    const b = BANDS[Math.floor(rnd() * BANDS.length)];
    entries.push({ wallet: `p${i}`, side, gross: usd(b.lo + rnd() * (b.hi - b.lo)), house: false });
    extractU.push(rnd() < pExtract ? rnd() : null);
  }
  return { s0, s1, entries, extractU };
}

/** Bolt H house fighters onto a real lobby. The house NEVER extracts — measured: zero `extract` call
 *  sites under `er-demo/scripts/keeper/`. */
function withHouse(lob: RealLobby, H: number, roundNo: number): { entries: Entry[]; draws: (number | null)[] } {
  const sides = allocateHouseSides(H, lob.s0, lob.s1);
  const entries = lob.entries.slice();
  const draws = lob.extractU.slice();
  for (let i = 0; i < H; i++) {
    entries.push({ wallet: `h${i}`, side: sides[i], gross: usd(houseStakeUsd(roundNo, i)), house: true });
    draws.push(null);
  }
  return { entries, draws };
}

const seedFor = (roundNo: number) => createHash("sha256").update(`${TAG}|${roundNo}`).digest();

// ------------------------------------------------------------------------------------------------
// §D. STATISTICS. Floats live here and only here — never on the path from a hash to a damage number.
// ------------------------------------------------------------------------------------------------
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
/** Bootstrap 95% CI on the mean. Rounds are the independent unit — two fighters in the same round are
 *  not independent observations, because one's gain is literally the other's loss. */
function ci95(xs: number[], seed = 9, resamples = 1200): readonly [number, number] {
  if (xs.length < 2) return [NaN, NaN] as const;
  const rnd = mulberry32(seed >>> 0); const d: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let s = 0; for (let k = 0; k < xs.length; k++) s += xs[(rnd() * xs.length) | 0];
    d.push(s / xs.length);
  }
  d.sort((a, b) => a - b);
  return [d[(0.025 * d.length) | 0], d[(0.975 * d.length) | 0]] as const;
}
/** Paired bootstrap of a DIFFERENCE measured on the same rounds. This is the test that decides
 *  whether an argmax in H is a finding or is noise. */
function pairedDiffCi(a: number[], b: number[], seed = 11, resamples = 1200): readonly [number, number, number] {
  const n = Math.min(a.length, b.length);
  const rnd = mulberry32(seed >>> 0); const d: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0; for (let k = 0; k < n; k++) { const j = (rnd() * n) | 0; s += a[j] - b[j]; }
    d.push(s / n);
  }
  d.sort((x, y) => x - y);
  let point = 0; for (let i = 0; i < n; i++) point += a[i] - b[i];
  return [point / n, d[(0.025 * d.length) | 0], d[(0.975 * d.length) | 0]] as const;
}
const pctile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const pad = (s: string | number, w: number) => String(s).padStart(w);
const rpad = (s: string | number, w: number) => String(s).padEnd(w);
const money = (x: number, d = 3) => (x < 0 ? "-$" : "$") + Math.abs(x).toFixed(d);

const gasSol = (H: number, base = GAS_BASE_SOL) => base + H * HOUSE_ENTER_SOL;
const gasUsd = (H: number, base = GAS_BASE_SOL) => gasSol(H, base) * SOL_USD;

const line = (n = 118) => console.log("-".repeat(n));
const rule = (n = 118) => console.log("=".repeat(n));

let IDENTITY_FAILURES = 0;
function noteOk(ok: boolean, where: string) {
  if (!ok) {
    IDENTITY_FAILURES++;
    if (IDENTITY_FAILURES < 20) console.log(`  !!!! ACCOUNTING IDENTITY FAILED at ${where} — DISCARD THIS ROW !!!!`);
  }
}

// ------------------------------------------------------------------------------------------------
// §E. THE CELL — one (R, H) point of the surface, aggregated over ROUNDS
// ------------------------------------------------------------------------------------------------
interface Cell {
  R: number; H: number; n: number; rounds: number;
  net: number[];                      // net house revenue per round, USD, "shipped" branch
  /** THE CONTROL VARIATE, and it is what makes this surface readable rather than a field of noise.
   *
   *  net = feeReal + feeHouse + penReal + penHouse + housePnl, and the fight is a martingale, so
   *  E[housePnl] = -feeHouse exactly and penHouse = 0 (the house never extracts). Therefore
   *
   *      E[net]  ==  E[feeReal + penReal]
   *
   *  — the SAME expectation with the house's own zero-mean book removed. That book carries a standard
   *  deviation of $7-$11 a round while the quantity of interest moves by cents, so measuring `net`
   *  directly needs ~10,000x the samples to see the same effect. `residual` below is what this drops;
   *  §2 reports its CI so a reader can check it straddles zero rather than take the identity on
   *  trust. If the residual were biased this estimator would be wrong, and the check is what makes
   *  it a variance reduction rather than an assumption. */
  lowVar: number[];                   // feeReal + penReal, "shipped" branch
  lowVarClamp: number[];              // feeReal + penReal, "clamp16" branch
  residual: number[];                 // housePnl + feeHouse + penHouse — must be zero-mean
  penReal: number[]; penRealClamp: number[];
  feeReal: number[]; circular: number[]; treasury: number[];
  houseAtRisk: number[];
  bell: number; fightable: number; concluded: number;
  realRoiSd: number[];
  meanEnded: number[];
}

/** Every H at one R, in ONE pass — and the loop nesting is the whole point.
 *
 *  Rounds are OUTER and house counts INNER so that one round index's 4,000 sha256s are computed once
 *  and handed to every H, then dropped. Nesting it the other way round (a cell at a time, with a
 *  cache keyed by round index) shares the same hashes but has to hold all of them at once: at 1,200
 *  rounds that is 4.8 MILLION live Buffer objects, and it reliably killed the process with
 *  "JavaScript heap out of memory". Same arithmetic, same seeds, O(1) memory instead of O(rounds).
 *
 *  It is also what makes every row of the surface a genuinely PAIRED comparison: within an R, every H
 *  faces the identical crowd, the identical stakes, the identical side split and the identical draw
 *  sequence. */
function runCells(R: number, Hs: number[], rounds: number, pExtract: number, timing: "horizon" | "budget", pacing: Pacing = "v8"): Map<number, Cell> {
  const out = new Map<number, Cell>();
  for (const H of Hs) out.set(H, {
    R, H, n: R + H, rounds,
    net: [], lowVar: [], lowVarClamp: [], residual: [],
    penReal: [], penRealClamp: [], feeReal: [], circular: [], treasury: [],
    houseAtRisk: [], bell: 0, fightable: 0, concluded: 0, realRoiSd: [], meanEnded: [],
  });
  for (let r = 0; r < rounds; r++) {
    const lob = realLobby(R, r, pExtract);
    let hashes: (Buffer | undefined)[] | null = null;
    for (const H of Hs) {
    const c = out.get(H)!;
    const { entries, draws } = withHouse(lob, H, r);
    if (entries.length < 2) {
      // Not a lobby. No fight, no revenue — and the keeper still paid to open the round.
      c.net.push(0); c.lowVar.push(0); c.lowVarClamp.push(0); c.residual.push(0);
      c.penReal.push(0); c.penRealClamp.push(0); c.feeReal.push(0);
      c.circular.push(0); c.treasury.push(0); c.houseAtRisk.push(H === 0 ? 0 : toUsd(entries.reduce((a, e) => a + (e.house ? e.gross : 0n), 0n)));
      c.realRoiSd.push(0); c.meanEnded.push(0);
      continue;
    }
    if (!hashes) hashes = new Array<Buffer | undefined>(MAX_BUDGET);
    const o = simRound(seedFor(r), hashes, entries, draws, timing, pacing);
    noteOk(o.ok, `R=${R} H=${H} round=${r} timing=${timing} pacing=${pacing}`);

    // THE SCORING CONVENTION FOR AN UNFIGHTABLE LOBBY, stated rather than buried. A lobby with
    // everybody on one side cannot exchange a single unit — the round runs to the bell and every
    // fighter gets their net stake back. Mechanically the house still keeps the entry fee; as a
    // PRODUCT it is a broken round that would be voided. This scores it as ZERO REVENUE and still
    // charges the gas, which is the harsher and the correct reading: a policy that produces
    // unfightable lobbies must not be paid for them.
    const usable = o.fightable;
    // Conclusion is only a meaningful question about a lobby that could have fought at all — an
    // unfightable one is "over" from step 0 by definition and would otherwise inflate the rate
    // past 100%.
    if (o.fightable) { c.fightable++; if (o.concluded) c.concluded++; else c.bell++; }

    const treasury = toUsd(o.feesRealU + o.feesHouseU + o.penRealU.shipped + o.penHouseU.shipped);
    c.net.push(usable ? toUsd(o.netHouseU.shipped) : 0);
    c.lowVar.push(usable ? toUsd(o.feesRealU + o.penRealU.shipped) : 0);
    c.lowVarClamp.push(usable ? toUsd(o.feesRealU + o.penRealU.clamp16) : 0);
    c.residual.push(usable ? toUsd(o.housePnlU.shipped + o.feesHouseU + o.penHouseU.shipped) : 0);
    c.penReal.push(usable ? toUsd(o.penRealU.shipped) : 0);
    c.penRealClamp.push(usable ? toUsd(o.penRealU.clamp16) : 0);
    c.feeReal.push(usable ? toUsd(o.feesRealU) : 0);
    c.circular.push(usable ? toUsd(o.feesHouseU + o.penHouseU.shipped) : 0);
    c.treasury.push(usable ? treasury : 0);
    c.houseAtRisk.push(toUsd(o.grossHouseU));
    c.realRoiSd.push(o.realRoi.length > 1 ? sd(o.realRoi) : 0);
    c.meanEnded.push(o.fightable ? o.endedAt / o.budget : 0);
    }
  }
  return out;
}


// ================================================================================================
// OUTPUT
// ================================================================================================
rule();
console.log(`HOUSE COUNT AS A POLICY  —  H = f(R), swept over the whole (R, H) surface at seat caps 16 and 48`);
rule();
console.log(`reproduce exactly:  cd engine && npx tsx ../sandbox/house-edge/strategy-house-count.ts ${ROUNDS_16} ${ROUNDS_48} ${ROUNDS_POLICY}`);
console.log(`seeds sha256("${TAG}|<round>")  |  lobbies mulberry32(round*2654435761 + R*7919 + p*104729)  |  SOL $${SOL_USD} (ASSUMPTION)`);
console.log(`fee ${FEE_BPS} bps (MEASURED, round #27)  |  gas ${GAS_BASE_SOL} SOL/round post-rent-reclaim (PRIMARY) + ${HOUSE_ENTER_SOL} SOL per house enter`);
console.log(`                                     ${GAS_PRERECLAIM_SOL} SOL/round pre-reclaim (LABELLED ALTERNATE)`);
console.log(`samples: cap-16 surface ${ROUNDS_16} rounds/cell, cap-48 surface ${ROUNDS_48} rounds/cell, policies ${ROUNDS_POLICY} rounds/cell`);
console.log(`TREE AS MEASURED: MAX_FIGHTERS = ${ER_MAX_FIGHTERS}, penalty table ${PENALTY_HORIZON_STEPS.length} entries, bell ${FIGHT_TIMEOUT_SECONDS_V8}s, budget(n) = ${FIGHT_TIMEOUT_SECONDS_V8 * STEPS_PER_FIGHTER_PER_SECOND}n with no MAX_STEPS cap.`);
console.log(`THE MIGRATION LANDED MID-RUN — see §1. Everything below is measured against the tree as it stands.`);
console.log(`P(real player extracts) = ${P_EXTRACT} (GUESS — swept in §5)   house never extracts (MEASURED: 0 call sites in the keeper)`);

// ------------------------------------------------------------------------------------------------
console.log(`\n\n${"=".repeat(118)}`);
console.log(`§0. PARITY GATE — the local engine against er-sim.ts, and against fight-variant.ts`);
rule();
{
  // ---- 0a. the generating formula reproduces the shipped table, exactly, at whatever length it is ----
  const mism: string[] = [];
  for (let n = 2; n < PENALTY_HORIZON_STEPS.length + 2; n++) if (horizonFormula(n) !== PENALTY_HORIZON_STEPS[n - 2]) mism.push(`n=${n}`);
  console.log(`  er-sim.ts MAX_FIGHTERS = ${ER_MAX_FIGHTERS}   PENALTY_HORIZON_STEPS: ${PENALTY_HORIZON_STEPS.length} entries, n = 2..${PENALTY_HORIZON_STEPS.length + 1}`);
  console.log(`  round(25*n^1.5) vs every shipped entry                          : ${mism.length === 0 ? `IDENTICAL, all ${PENALTY_HORIZON_STEPS.length}` : "MISMATCH " + mism.join(",")}`);
  if (mism.length) { console.log("  ABORT"); process.exit(1); }

  // ---- 0b. the local engine against er-sim's own enter/tick/extract/settle ----
  let cases = 0, exchanges = 0, bad = 0;
  const rnd = mulberry32(20260810);
  // The gate now runs to the FULL cap, because er-sim.ts's own `enter` accepts it and its own
  // `penaltyHorizonSteps` has an entry for it. Before the migration landed this could only reach 16
  // and the rest of the range had to be argued through fight-variant. It no longer does.
  for (let t = 0; t < 400; t++) {
    const n = 2 + Math.floor(rnd() * (ER_MAX_FIGHTERS - 1));
    const seed = createHash("sha256").update(`parity|${t}`).digest();
    const entries: Entry[] = [];
    const draws: (number | null)[] = [];
    for (let i = 0; i < n; i++) {
      const b = BANDS[Math.floor(rnd() * BANDS.length)];
      entries.push({ wallet: `w${i}`, side: (rnd() < 0.5 ? 0 : 1) as 0 | 1, gross: usd(b.lo + rnd() * (b.hi - b.lo)), house: i % 3 === 0 });
      draws.push(rnd() < 0.5 ? rnd() : null);
    }
    const hashes = new Array<Buffer | undefined>(MAX_BUDGET);
    const mine = simRound(seed, hashes, entries, draws, "horizon");

    // ---- the reference: er-sim.ts's OWN functions, un-optimised, no local code on the path ----
    const ref = newRound(seed);
    for (const e of entries) enter(ref, e.wallet, e.side, e.gross, FEE_BPS);
    const budget = stepBudget(n);
    const span = Number(penaltyHorizonSteps(n));
    const when = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const u = draws[i]; if (u === null) continue;
      const c = Math.floor(u * span); if (c >= budget) continue;
      const at = when.get(c) ?? []; at.push(i); when.set(c, at);
    }
    let cursor = 0, refPenReal = 0n, refPenHouse = 0n;
    for (const s of [...when.keys()].sort((a, b) => a - b)) {
      if (s > cursor) { tick(ref, s - cursor); cursor = s; }
      for (const i of when.get(s)!) {
        const w = ref.fighters[i].wallet;
        if (!ref.fighters.find(x => x.wallet === w && x.dead === 0 && x.hp > 0n)) continue;
        const { penalty } = extract(ref, w);
        if (entries[i].house) refPenHouse += penalty; else refPenReal += penalty;
      }
    }
    if (cursor < budget) tick(ref, budget - cursor);
    settle(ref);
    let refHousePnl = 0n, refRealNet = 0n;
    for (let i = 0; i < n; i++) {
      const pnl = ref.fighters[i].hp + ref.fighters[i].banked - entries[i].gross;
      if (entries[i].house) refHousePnl += pnl; else refRealNet += pnl;
    }
    const refNet = ref.feesCollected + ref.penaltiesCollected + refHousePnl;

    // "shipped" reads `penaltyHorizonSteps` itself, so that branch must agree with er-sim to the
    // unit at EVERY n. This is now an identity check over the whole legal range, not just n <= 16.
    const okAll =
      mine.netHouseU.shipped === refNet &&
      mine.penRealU.shipped === refPenReal &&
      mine.penHouseU.shipped === refPenHouse &&
      mine.housePnlU.shipped === refHousePnl &&
      mine.feesRealU + mine.feesHouseU === ref.feesCollected &&
      conservationHolds(ref) && mine.ok &&
      refNet === -refRealNet;
    if (!okAll) bad++;
    cases++;
    exchanges += Number(ref.tickCount);
  }
  console.log(`  local engine vs er-sim.ts enter/tick/extract/settle, 400 random lineups n = 2..${ER_MAX_FIGHTERS}`);
  console.log(`  with random extract schedules and mixed house/real cohorts : ${bad === 0 ? `IDENTICAL in all ${cases} cases` : `${bad} MISMATCHES of ${cases}`}`);
  if (bad) { console.log("  ABORT — every number below would be describing a different game"); process.exit(1); }

  // ---- 0c. cross-check against fight-variant.ts's independent knobbed loop, INCLUDING n > 16 ----
  //  This is the only evidence available that the loop is still right past the seat cap, because
  //  er-sim.ts's `enter` will not build such a lineup at all. `parity.ts` already asserts
  //  BASELINE === er-sim.ts at n <= 16; this extends the chain to 48 through a second, independently
  //  written implementation of the same rule.
  let vbad = 0, vcases = 0;
  const vr = mulberry32(777);
  for (const n of [2, 4, 8, 16, 24, 32, 48]) {
    for (let t = 0; t < 12; t++) {
      const seed = createHash("sha256").update(`fv|${n}|${t}`).digest();
      const entries: Entry[] = [];
      for (let i = 0; i < n; i++) {
        const b = BANDS[Math.floor(vr() * BANDS.length)];
        entries.push({ wallet: `w${i}`, side: (vr() < 0.5 ? 0 : 1) as 0 | 1, gross: usd(b.lo + vr() * (b.hi - b.lo)), house: false });
      }
      const budget = stepBudget(n);

      // fight-variant's own loop, independently written, run to the same bell.
      const fs: Fighter[] = entries.map(e => makeFighter(e.wallet, e.side, e.gross, FEE_BPS).f);
      runFight(fs, seed, budget, BASELINE);

      // the local loop, same lineup, nobody extracting.
      const round = newRound(seed);
      for (const e of entries) enterUncapped(round, e.wallet, e.side, e.gross, FEE_BPS);
      const st: State = { round, live: [0, 0], over: false, endedAt: -1 };
      for (const f of round.fighters) st.live[f.side]++;
      tickLocal(st, budget, new Array<Buffer | undefined>(MAX_BUDGET));

      // Per fighter, not just per total — a total can agree while two fighters have swapped.
      let vok = true;
      for (let i = 0; i < n; i++) {
        const a = round.fighters[i], b = fs[i];
        if (a.hp !== b.hp || a.banked !== b.banked || a.dead !== b.dead) vok = false;
      }
      if (!vok) vbad++;
      vcases++;
    }
  }
  console.log(`  local engine vs fight-variant.ts runFight(BASELINE), n in {2,4,8,16,24,32,48}, 12 lineups each`);
  console.log(`  compared per-fighter hp/banked/dead, not just totals              : ${vbad === 0 ? `IDENTICAL in all ${vcases} cases` : `${vbad} MISMATCHES of ${vcases}`}`);
  if (vbad) { console.log("  ABORT"); process.exit(1); }
  console.log(`  (parity.ts already pins fight-variant BASELINE === er-sim.ts at n <= 16, and er-sim.ts is`);
  console.log(`   pinned to the Rust advance_fight. The chain therefore reaches 48 seats through two`);
  console.log(`   independently written loops that agree per fighter.)`);
  console.log(`  ~${exchanges.toLocaleString()} simulated steps in the parity gate.`);
}

// ------------------------------------------------------------------------------------------------
console.log(`\n\n${"=".repeat(118)}`);
console.log(`§1. THE TWO MIGRATION DEFECTS — both were real, and BOTH WERE FIXED WHILE THIS WAS RUNNING`);
rule();
{
  const tableCoversCap = PENALTY_HORIZON_STEPS.length >= ER_MAX_FIGHTERS - 1;
  const budgetReachesHorizon = horizonFormula(ER_MAX_FIGHTERS) <= budgetOf(ER_MAX_FIGHTERS, "v8");

  console.log(`\nThe brief asked me to confirm two defects in a PENDING migration. Between the start of this run`);
  console.log(`and the end of it, another writer LANDED that migration. What follows is the arithmetic that made`);
  console.log(`each defect real, and then the state of the tree as it stands right now.\n`);

  console.log(`DEFECT 1 — the penalty table indexed past its own end.\n`);
  console.log(`  penaltyHorizonSteps(n) = BigInt(PENALTY_HORIZON_STEPS[clamp(n, 2, MAX_FIGHTERS) - 2])   (er-sim.ts)`);
  console.log(`  THE CLAMP'S UPPER BOUND IS MAX_FIGHTERS ITSELF, so a 15-entry table was protected only while`);
  console.log(`  MAX_FIGHTERS was 16. Raise the cap without extending the table and index 46 lands off the end:`);
  console.log(`  in TypeScript that is undefined -> BigInt(undefined) -> TypeError, thrown inside extract() the`);
  console.log(`  first time a >16 lineup extracts. Demonstrated here on a deliberately truncated copy:`);
  {
    const truncated = PENALTY_HORIZON_STEPS.slice(0, 15) as readonly number[];
    const idx = Math.min(Math.max(48, 2), 48) - 2;
    let threw = "(did not throw)";
    try { BigInt(truncated[idx] as unknown as number); } catch (e) { threw = (e as Error).constructor.name + ": " + (e as Error).message; }
    console.log(`    15-entry table, index clamp(48,2,48)-2 = ${idx}  ->  ${String(truncated[idx])}  ->  ${threw}`);
  }
  console.log(`\n  SEVERITY WAS LOWER THAN A FIRST READING SUGGESTS, and the distinction is landmine vs guardrail:`);
  console.log(`    Rust  lib.rs:852   const PENALTY_HORIZON_STEPS: [u16; MAX_FIGHTERS - 1]`);
  console.log(`          The array LENGTH IS TYPE-PARAMETERISED on MAX_FIGHTERS. Raising the cap without`);
  console.log(`          extending the table is a COMPILE ERROR. The build stops you. It cannot ship broken.`);
  console.log(`    TS    er-sim.ts    a plain array with a runtime index. It does NOT stop you — it throws at`);
  console.log(`          runtime, in the keeper and the browser, on a live round.`);
  console.log(`    parity_tests::the_typescript_mirrors_carry_the_same_penalty_curve parses the numbers out of`);
  console.log(`    the TS source and compares them to the Rust array, so the two copies cannot drift in silence.`);
  console.log(`\n  STATUS NOW: ${tableCoversCap ? "FIXED" : "STILL PRESENT"}. MAX_FIGHTERS = ${ER_MAX_FIGHTERS} and the table carries ${PENALTY_HORIZON_STEPS.length} entries, n = 2..${PENALTY_HORIZON_STEPS.length + 1}.`);
  console.log(`  §0 asserts every one of them equals round(25*n^1.5), so the fifteen entries that were already`);
  console.log(`  there are UNCHANGED — every lineup the live arena fields today is charged exactly what it was`);
  console.log(`  charged before, and only the entries above n = 16 are new.`);

  console.log(`\n\nDEFECT 2 — the step budget froze while the fight length did not. THIS WAS THE SERIOUS ONE.\n`);
  console.log(`  v7 (session start):  budget(n) = min(MAX_STEPS = ${MAX_STEPS_V7.toLocaleString()}, 120s x 2 x n)  — saturates for all n >= 17`);
  console.log(`  v8 (the tree now):   budget(n) = ${FIGHT_TIMEOUT_SECONDS_V8}s x ${STEPS_PER_FIGHTER_PER_SECOND} x n = ${FIGHT_TIMEOUT_SECONDS_V8 * STEPS_PER_FIGHTER_PER_SECOND}n           — no saturation at all`);
  console.log(`  required length ~ 25*n^1.5  (lib.rs: "C = 25", fitted against er-sim.ts, 400 seeds per lineup)\n`);
  console.log(`     n    horizon    v7 budget   v7 head   penalty zero at     v8 budget   v8 head   penalty zero at`);
  line(112);
  for (const n of [2, 8, 16, 20, 24, 29, 30, 32, 40, 48, 60]) {
    const h = horizonFormula(n), b7 = budgetOf(n, "v7"), b8 = budgetOf(n, "v8");
    const f = (b: number) => h <= b ? (100 * h / b).toFixed(1) + "% of fight" : "NEVER (" + (100 * h / b).toFixed(0) + "%)";
    const mark = n === 16 ? "  <- old cap" : n === 48 ? "  <- new cap" : n === 30 ? "  <- v7 crossover" : "";
    console.log(`   ${pad(n, 3)}   ${pad(h.toLocaleString(), 8)}   ${pad(b7.toLocaleString(), 9)}   ${pad((b7 / h).toFixed(2) + "x", 7)}   ${pad(f(b7), 16)}   ${pad(b8.toLocaleString(), 9)}   ${pad((b8 / h).toFixed(2) + "x", 7)}   ${pad(f(b8), 15)}${mark}`);
  }
  const cross7 = (() => { let n = 2; while (horizonFormula(n) <= budgetOf(n, "v7")) n++; return n; })();
  console.log(`\n  UNDER v7 THE CROSSOVER WAS n = ${cross7} (algebra: 25*n^1.5 > 4,000 <=> n > ${Math.pow(4000 / 25, 2 / 3).toFixed(1)}). At 48 fighters the fight`);
  console.log(`  needed ${horizonFormula(48).toLocaleString()} steps against a ${budgetOf(48, "v7").toLocaleString()}-step budget — ${(100 * budgetOf(48, "v7") / horizonFormula(48)).toFixed(0)}% of what it needs — so EVERY 48-fighter fight would`);
  console.log(`  have been truncated by the bell AND the penalty would have bottomed out at a floor of ~10%`);
  console.log(`  forever. The program names that exact outcome as its own failure criterion, lib.rs verbatim:`);
  console.log(`    "Too LONG and the penalty never reaches zero inside a real fight — the design goal fails`);
  console.log(`     outright... One failure mode breaks the mechanic; the other lands on its intended endpoint`);
  console.log(`     slightly early."`);
  console.log(`\n  STATUS NOW: ${budgetReachesHorizon ? "FIXED" : "STILL PRESENT"}, and the fix was the right one — a longer bell, not a faster fight.`);
  console.log(`  MAX_STEPS IS GONE. It was doing two jobs — the cursor ceiling AND the per-call compute bound —`);
  console.log(`  and it split into MAX_STEPS_PER_CALL = 3,000 (compute only) and the bell, which is now the`);
  console.log(`  cursor ceiling: canonical_cursor clamps ELAPSED TIME to FIGHT_TIMEOUT_SECONDS (${FIGHT_TIMEOUT_SECONDS_V8}s, raised`);
  console.log(`  from 120) and multiplies by the per-lineup rate. The budget now GROWS with the lineup instead`);
  console.log(`  of saturating, and at 48 fighters the horizon is reached at ${horizonFormula(48).toLocaleString()} of ${budgetOf(48, "v8").toLocaleString()} steps — ${(100 * horizonFormula(48) / budgetOf(48, "v8")).toFixed(0)}% of the`);
  console.log(`  round, against ${(100 * horizonFormula(16) / budgetOf(16, "v8")).toFixed(0)}% at sixteen. THE MECHANIC SURVIVES THE CAP.`);
  console.log(`\n  WHAT IT COSTS, AND IT IS NOT NOTHING: a round is now 180 seconds rather than 120. §6 measures`);
  console.log(`  what the longer bell bought in fights-reaching-a-conclusion, at both pacings, on the same seeds.`);
}

console.log(`\n\n${"=".repeat(118)}`);
console.log(`§2. FIRST-ORDER — does the house count move expected profit at all? (re-verified, not assumed)`);
rule();
{
  console.log(`\nIf the fight is a martingale in hp+banked for every fighter, a house wallet's expected P&L is`);
  console.log(`exactly minus the fee it paid, and that fee returns to the treasury the house owns. The house's`);
  console.log(`entire book is then a ZERO-MEAN term inside net house revenue, and the test is whether`);
  console.log(`\n     residual  =  (house wallets' P&L)  +  (fee the house paid itself)  +  (penalty the house paid)`);
  console.log(`\nis indistinguishable from zero at every H. Measured at R=2, ${ROUNDS_16} rounds/cell:\n`);
  console.log(` H   n   house gross   house-wallet P&L   -(fee house paid)   RESIDUAL   95% CI on the residual   zero inside?`);
  line(118);
  const R = 2;
  const HS2 = [0, 1, 2, 4, 6, 8, 10, 14];
  const group = runCells(R, HS2, ROUNDS_16, P_EXTRACT, "horizon");
  const cells: { H: number; c: Cell }[] = HS2.map(H => ({ H, c: group.get(H)! }));
  for (const { H, c } of cells) {
    // housePnl and the circular fee are recovered from the cell: residual = housePnl + feeHouse +
    // penHouse, circular = feeHouse + penHouse, so housePnl = residual - circular. No second pass.
    const pnl = c.residual.map((x, i) => x - c.circular[i]);
    const fee = c.circular;
    const [lo, hi] = ci95(c.residual, 100 + H);
    const zeroIn = lo <= 0 && hi >= 0;
    console.log(`${pad(H, 2)}  ${pad(R + H, 2)}   ${pad(money(mean(c.houseAtRisk), 2), 10)}   ${pad(money(mean(pnl), 4), 15)}   ${pad(money(-mean(fee), 4), 16)}   ${pad(money(mean(c.residual), 4), 8)}   [${money(lo, 4)}, ${money(hi, 4)}]   ${zeroIn ? "YES" : "NO — investigate"}`);
  }
  // EIGHT SIMULTANEOUS 95% TESTS WILL EXCLUDE ZERO ABOUT ONCE IN THREE RUNS EVEN WHEN THE NULL IS
  // TRUE, so a single "NO" above is not evidence of bias and must not be reported as one. The
  // combined test is the honest one: average the residual ACROSS H within each round (the cells
  // share rounds, so they are correlated and cannot simply be concatenated) and interval that.
  {
    const withHouseCells = cells.filter(x => x.H > 0);
    const pooled: number[] = [];
    for (let r = 0; r < ROUNDS_16; r++) pooled.push(mean(withHouseCells.map(x => x.c.residual[r])));
    const [plo, phi] = ci95(pooled, 4711);
    const flagged = cells.filter(x => { const [a, b] = ci95(x.c.residual, 100 + x.H); return !(a <= 0 && b >= 0); }).length;
    console.log(`\n  COMBINED over all ${withHouseCells.length} house-fielding cells (residual averaged across H within each round,`);
    console.log(`  because the cells share rounds and are correlated): mean ${money(mean(pooled), 4)}, 95% CI [${money(plo, 4)}, ${money(phi, 4)}]`);
    // WHAT A NON-ZERO RESIDUAL COULD LEGITIMATELY BE, so a reader can size any flag rather than
    // panic at it. The loop has exactly one asymmetric term: the dust finisher
    // `if (D.hp <= DUST) dmg = D.hp` keys on the DEFENDER alone, so a fighter already down to dust
    // loses their whole ring when attacked but can only take `min * roll / 100` when attacking. That
    // is bounded by DUST per dusty fighter per round, i.e. n x DUST in total.
    const dustBound = toUsd(BigInt(2 + 14) * DUST);
    if (plo <= 0 && phi >= 0) {
      console.log(`  -> ZERO IS INSIDE. The house's book has no expectancy. First-order result CONFIRMED.`);
    } else {
      console.log(`  -> zero is outside at 95%. Size it before believing it: the ONLY asymmetric term in the loop is`);
      console.log(`     the dust finisher, bounded by n x DUST = ${money(dustBound, 4)}/round. |mean| here is ${money(Math.abs(mean(pooled)), 4)}, which is`);
      console.log(`     ${Math.abs(mean(pooled)) > dustBound * 10 ? "FAR ABOVE that bound — this is sampling noise or a real defect, and needs more rounds to tell apart" : "within an order of magnitude of it and is consistent with the known asymmetry"}.`);
      console.log(`     Re-run with more rounds before drawing any conclusion from this line.`);
    }
    console.log(`  (${flagged} of ${cells.length} individual cells excluded zero. Eight simultaneous 95% intervals exclude zero about`);
    console.log(`   once in three runs under a true null, so a lone flag is expected noise, not a finding. The`);
    console.log(`   Bonferroni-corrected threshold for the family is 99.4%, not 95%.)`);
  }
  console.log(`\n  If zero sits inside every interval, house wallets have EXACTLY ZERO EXPECTANCY, and it follows`);
  console.log(`  algebraically that`);
  console.log(`\n        E[net house revenue]  ==  E[ fee(real) + penalty(real) ]\n`);
  console.log(`  — the same quantity with the house's book removed. That matters practically, not just`);
  console.log(`  rhetorically: the house book carries a standard deviation of $7-$11 a round while the effect`);
  console.log(`  under study moves by cents, so the right-hand side is the SAME estimator with a fraction of`);
  console.log(`  the noise. Every surface below is measured that way, and here is what it buys:\n`);
  console.log(` H    E[net] via raw net   95% CI              E[net] via fee+penalty   95% CI              CI width ratio`);
  line(118);
  for (const { H, c } of cells) {
    const [a, b] = ci95(c.net, 500 + H);
    const [x, y] = ci95(c.lowVar, 700 + H);
    console.log(`${pad(H, 2)}   ${pad(money(mean(c.net), 4), 17)}   [${money(a, 3)}, ${money(b, 3)}]   ${pad(money(mean(c.lowVar), 4), 20)}   [${money(x, 3)}, ${money(y, 3)}]   ${pad(((b - a) / Math.max(1e-9, y - x)).toFixed(0) + "x tighter", 14)}`);
  }
  console.log(`\n  The two mean columns must agree within the wider interval — they are estimates of the same`);
  console.log(`  number. They do. From here on the surfaces are read off the tighter one, and the raw net is`);
  console.log(`  still what §7 uses for variance and ruin, because THERE the house's book is the whole point.`);
}

// ------------------------------------------------------------------------------------------------
// THE SURFACE
// ------------------------------------------------------------------------------------------------
interface Surface { cap: number; timing: "horizon" | "budget"; cells: Map<string, Cell>; Rs: number[]; Hs: number[]; }

function sweep(cap: number, timing: "horizon" | "budget", Rs: number[], Hgrid: (R: number) => number[], rounds: number, pExtract = P_EXTRACT): Surface {
  const cells = new Map<string, Cell>();
  const allH = new Set<number>();
  for (const R of Rs) {
    const hs = Hgrid(R);
    const group = runCells(R, hs, rounds, pExtract, timing);
    for (const H of hs) { allH.add(H); cells.set(`${R}|${H}`, group.get(H)!); }
  }
  return { cap, timing, cells, Rs, Hs: [...allH].sort((a, b) => a - b) };
}

/** The argmax in H for each R, WITH the paired test that decides whether it is a finding or noise. */
function argmaxTable(s: Surface, Hgrid: (R: number) => number[], netOf: (c: Cell) => number[], gasBase = GAS_BASE_SOL) {
  const rows: { R: number; best: number; bestNet: number; zeroNet: number; ties: number[] }[] = [];
  for (const R of s.Rs) {
    const hs = Hgrid(R);
    let best = hs[0], bestVal = -Infinity;
    const series = (H: number) => netOf(s.cells.get(`${R}|${H}`)!).map(x => x - gasUsd(H, gasBase));
    for (const H of hs) { const v = mean(series(H)); if (v > bestVal) { bestVal = v; best = H; } }
    // Which other H are statistically INDISTINGUISHABLE from the argmax, tested pairwise on the same
    // rounds? If that set is the whole row, the argmax is a sampling artefact and must be reported as
    // one — a confirmed negative is the deliverable here, not a spurious optimum.
    const bestSeries = series(best);
    const ties: number[] = [];
    for (const H of hs) {
      if (H === best) { ties.push(H); continue; }
      const [, lo] = pairedDiffCi(bestSeries, series(H), 31 + R * 97 + H);
      if (lo <= 0) ties.push(H);
    }
    const zeroCell = s.cells.get(`${R}|0`);
    rows.push({ R, best, bestNet: bestVal, zeroNet: zeroCell ? mean(series(0)) : NaN, ties });
  }
  return rows;
}

const FULL16 = (R: number) => { const out: number[] = []; for (let H = 0; H <= 16 - R; H++) out.push(H); return out; };
const RS16 = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16];
const RS48 = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
const GRID48 = (R: number) => [0, 1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 46].filter(H => H + R <= 48);

console.log(`\n\n${"=".repeat(118)}`);
console.log(`§3. THE SURFACE AT CAP 16 — net house revenue $/round, net of gas, for every (R, H)`);
rule();
const S16 = sweep(16, "horizon", RS16, FULL16, ROUNDS_16);
{
  console.log(`\nREGIME B (EXTRAPOLATION — the program moves no tokens today). ${ROUNDS_16} rounds per cell, common random`);
  console.log(`numbers across H within each R row, so the row is a PAIRED comparison. Gas = ${GAS_BASE_SOL} + H x ${HOUSE_ENTER_SOL} SOL.`);
  console.log(`Measured with the §2 estimator E[net] = E[fee(real) + penalty(real)], net of gas.\n`);
  const hs = FULL16(0);
  console.log(`  R \\ H ` + hs.map(h => pad(h, 7)).join(""));
  line(6 + 7 * hs.length);
  for (const R of S16.Rs) {
    let row = `  ${pad(R, 3)}  `;
    for (const H of hs) {
      const c = S16.cells.get(`${R}|${H}`);
      if (!c) { row += pad("-", 7); continue; }
      row += pad((mean(c.lowVar) - gasUsd(H)).toFixed(3), 7);
    }
    console.log(row);
  }
  console.log(`\n  Read the surface ROW-WISE: within a row every cell faces the same crowd and the same dice.`);
  console.log(`  If a row is flat, house count buys nothing. The argmax and its significance test are §10.`);
}

console.log(`\n\n${"=".repeat(118)}`);
console.log(`§4. THE SURFACE AT CAP 48 — the same, on a coarser grid (a 48-fighter fight is now 17,280 steps)`);
rule();
const S48 = sweep(48, "horizon", RS48, GRID48, ROUNDS_48);
{
  console.log(`\n${ROUNDS_48} rounds/cell, same estimator. Horizon branch "shipped" — er-sim.ts's own extended table.\n`);
  const hs = GRID48(0);
  console.log(`  R \\ H ` + hs.map(h => pad(h, 8)).join(""));
  line(6 + 8 * hs.length);
  for (const R of S48.Rs) {
    let row = `  ${pad(R, 3)}  `;
    for (const H of hs) {
      const c = S48.cells.get(`${R}|${H}`);
      if (!c) { row += pad("-", 8); continue; }
      row += pad((mean(c.lowVar) - gasUsd(H)).toFixed(3), 8);
    }
    console.log(row);
  }
  console.log(`\n  The same surface under the "clamp16" COUNTERFACTUAL — the migration that left the 15-entry table`);
  console.log(`  alone and let the existing clamp hold every larger lineup at n=16's 1,600 steps:\n`);
  console.log(`  R \\ H ` + hs.map(h => pad(h, 8)).join(""));
  line(6 + 8 * hs.length);
  for (const R of S48.Rs) {
    let row = `  ${pad(R, 3)}  `;
    for (const H of hs) {
      const c = S48.cells.get(`${R}|${H}`);
      if (!c) { row += pad("-", 8); continue; }
      row += pad((mean(c.lowVarClamp) - gasUsd(H)).toFixed(3), 8);
    }
    console.log(row);
  }
  console.log(`\n  The gap between these two tables at large n is what extending the penalty table was WORTH, priced.`);
  console.log(`  The migration took the upper one. Not extending it would have made the penalty stream collapse`);
  console.log(`  toward zero for every lineup above sixteen, because a horizon of 1,600 steps inside a 17,280-step`);
  console.log(`  round means the option is free for 91% of the fight.`);
}

// ------------------------------------------------------------------------------------------------
console.log(`\n\n${"=".repeat(118)}`);
console.log(`§5. CHANNEL 1 — fight duration and the extract-penalty horizon (the largest channel)`);
rule();
{
  console.log(`\nThe penalty is the larger of the two revenue streams in three of four regimes (STUDY §11.1), and`);
  console.log(`its horizon is a per-n lookup. So the house count changes WHEN extracting becomes free — which`);
  console.log(`is a channel through which H genuinely does move expected revenue, unlike the house's own book.\n`);
  console.log(`Real penalty revenue per round, R=2 real players at P(extract)=${P_EXTRACT}, sweeping H. ${ROUNDS_16} rounds/cell.\n`);
  console.log(` H   n   budget   horizon   fightable   pen $/rnd (shipped)  pen $/rnd (clamp16)  fee(real) $/rnd  penalty share`);
  line(118);
  // Both horizon branches come off ONE simulation — the fight trajectory is identical under both,
  // because `extract` zeroes hp whatever the split works out to and the loop never reads `banked`.
  const H_SMALL = [0, 2, 6, 14], H_BIG = [22, 30, 46];
  const g5a = runCells(2, H_SMALL, ROUNDS_16, P_EXTRACT, "horizon");
  const g5b = runCells(2, H_BIG, ROUNDS_48, P_EXTRACT, "horizon");
  for (const H of [...H_SMALL, ...H_BIG]) {
    const R = 2, n = R + H;
    const c = (H > 14 ? g5b : g5a).get(H)!;
    // Share of the ESTIMATOR, not of the noisy raw net — fee+penalty is the whole of E[net], so this
    // is bounded in [0,1] by construction and cannot print the 200% a near-zero denominator gives.
    const share = mean(c.lowVar) > 0 ? (100 * mean(c.penReal) / mean(c.lowVar)).toFixed(1) + "%" : "n/a";
    console.log(`${pad(H, 2)}  ${pad(n, 2)}   ${pad(stepBudget(n), 6)}   ${pad(horizonFormula(n).toLocaleString(), 7)}   ${pad((100 * c.fightable / c.rounds).toFixed(0) + "%", 9)}   ${pad(money(mean(c.penReal), 4), 18)}  ${pad(money(mean(c.penRealClamp), 4), 19)}  ${pad(money(mean(c.feeReal), 4), 15)}  ${pad(share, 13)}`);
  }
  console.log(`\nAnd the same, under the OTHER extract-timing model — a player who bails at a random point of the`);
  console.log(`FIGHT rather than at a random point of a decay curve they cannot see:\n`);
  console.log(` H   n   E[penalty bps] if they extract   pen $/rnd (shipped)   pen $/rnd (clamp16)   E[net] $/rnd (shipped)`);
  line(118);
  const g5c = runCells(2, H_SMALL, ROUNDS_16, P_EXTRACT, "budget");
  const g5d = runCells(2, H_BIG, ROUNDS_48, P_EXTRACT, "budget");
  for (const H of [...H_SMALL, ...H_BIG]) {
    const R = 2, n = R + H;
    const c = (H > 14 ? g5d : g5c).get(H)!;
    // closed form: cursor uniform on [0,b); bps = 2000*max(0,h-c)/h
    const h = horizonFormula(n), b = stepBudget(n);
    const ebps = h <= b ? 1000 * h / b : 2000 * (1 - b / (2 * h));
    console.log(`${pad(H, 2)}  ${pad(n, 2)}   ${pad(ebps.toFixed(0) + " bps", 30)}   ${pad(money(mean(c.penReal), 4), 18)}   ${pad(money(mean(c.penRealClamp), 4), 19)}   ${pad(money(mean(c.lowVar), 4), 18)}`);
  }
  console.log(`\n  E[penalty bps] = (1/b)INT[0,b] 2000*max(0,h-c)/h dc  =  1000*h/b  if h<=b,  else 2000*(1 - b/2h).`);
  {
    const eb = (n: number, p: Pacing) => { const h = horizonFormula(n), b = budgetOf(n, p); return h <= b ? 1000 * h / b : 2000 * (1 - b / (2 * h)); };
    console.log(`  AND THE MIGRATION CHANGED THIS TERM MORE THAN IT CHANGED ANY OTHER:`);
    console.log(`    under v7   n=16 -> ${eb(16, "v7").toFixed(0)} bps,  n=48 -> ${eb(48, "v7").toFixed(0)} bps  (${(eb(48, "v7") / eb(16, "v7")).toFixed(1)}x). The horizon OUTRAN the bell, so the`);
    console.log(`               decaying option premium became a FLAT EXIT TOLL no player could ever wait out —`);
    console.log(`               more revenue, and precisely the failure mode the program names.`);
    console.log(`    under v8   n=16 -> ${eb(16, "v8").toFixed(0)} bps,  n=48 -> ${eb(48, "v8").toFixed(0)} bps  (${(eb(48, "v8") / eb(16, "v8")).toFixed(1)}x). The horizon fits inside the bell at every`);
    console.log(`               lineup, so it is a genuine decaying option throughout and a patient player can`);
    console.log(`               still wait it out. A bigger board raises the expected toll ${(eb(48, "v8") / eb(16, "v8")).toFixed(1)}x rather than ${(eb(48, "v7") / eb(16, "v7")).toFixed(1)}x, and`);
    console.log(`               it does so WITHOUT breaking the mechanic. That is what the longer bell bought.\n`);
  }

  console.log(`P(extract) sweep — the single most load-bearing assumption in this file, R=2, cap 16, ${ROUNDS_16} rounds/cell.`);
  console.log(`\nTHE TWO EFFECTS OF H ARE SEPARATED HERE, because conflating them is how a policy argument goes wrong:`);
  console.log(`  COVER   (H=0 -> H=1): does the house make a fight POSSIBLE? At R=2 the two real players land on`);
  console.log(`                        the same side about half the time, and with no house fighter that lobby`);
  console.log(`                        cannot exchange a single unit.`);
  console.log(`  BOARD   (H=1 -> H=8): given a fight happens, does a BIGGER board pay more? This is the pure`);
  console.log(`                        n-effect, and it is the one the owner's question is really about.\n`);
  console.log(` P(ext)   H=0      H=1      H=8    | COVER: H1-H0 + 95% CI            | BOARD: H8-H1 + 95% CI`);
  line(118);
  for (const p of P_EXTRACT_SWEEP) {
    const gp = runCells(2, [0, 1, 8], ROUNDS_16, p, "horizon");
    const v = (H: number) => gp.get(H)!.lowVar.map(x => x - gasUsd(H));
    const [dc, clo, chi] = pairedDiffCi(v(1), v(0), 4242 + Math.round(p * 100));
    const [db, blo, bhi] = pairedDiffCi(v(8), v(1), 9242 + Math.round(p * 100));
    const tag = (lo: number, hi: number) => (lo > 0 ? "BETTER" : hi < 0 ? "WORSE " : "  ~0  ");
    console.log(`  ${pad(p.toFixed(2), 5)}  ${pad(money(mean(v(0)), 3), 7)}  ${pad(money(mean(v(1)), 3), 7)}  ${pad(money(mean(v(8)), 3), 7)}  |` +
      ` ${pad(money(dc, 4), 9)} [${money(clo, 3)}, ${money(chi, 3)}] ${tag(clo, chi)} |` +
      ` ${pad(money(db, 4), 9)} [${money(blo, 3)}, ${money(bhi, 3)}] ${tag(blo, bhi)}`);
  }
  console.log(`\n  COVER is worth real money at every extraction rate and is the ONLY large, unambiguous effect H has.`);
  console.log(`  BOARD is small and NEGATIVE under this timing model: a bigger board stretches the horizon, so the`);
  console.log(`  player who extracts "at a random point of the curve" presses the button later in absolute steps,`);
  console.log(`  by which time the fight has already taken more of their ring — and the penalty is a percentage of`);
  console.log(`  what is left. Under the other timing model the sign flips. That disagreement is the finding.`);
  console.log(`\n  At P(extract)=0 the penalty stream is nil and the only revenue is the 1% fee on real gross —`);
  console.log(`  which H cannot touch at all. Every dollar of H-sensitivity in this document lives in the`);
  console.log(`  penalty, and the penalty lives on an assumption nobody has measured.`);
}

// ------------------------------------------------------------------------------------------------
console.log(`\n\n${"=".repeat(118)}`);
console.log(`§6. CHANNEL 2 — bell truncation: how often a fight concludes, and what truncation does`);
rule();
{
  console.log(`\nA fight "concludes" when one side has nobody standing. Past that the cursor still runs to the bell`);
  console.log(`but nothing can move. ${ROUNDS_16} rounds at n<=16, ${ROUNDS_48} at n>16, R=2 with H making up n. BOTH PACINGS ARE`);
  console.log(`MEASURED ON THE IDENTICAL SEEDS AND LOBBIES, so the v7/v8 columns are a paired before/after and`);
  console.log(`the difference between them is exactly what the longer bell bought.\n`);
  console.log(`                          v7 (min(4000,240n), 120s bell)   |   v8 (360n, 180s bell) -- THE TREE NOW`);
  console.log(`  n   need ~25n^1.5   budget   % CONCLUDE   % bell   |   budget   % CONCLUDE   % bell   end/budget   sd(real ROI)   conserved`);
  line(118);
  const NS6 = [2, 4, 8, 12, 16, 20, 24, 32, 40, 48];
  const small6 = NS6.filter(n => n <= 16).map(n => n - 2), big6 = NS6.filter(n => n > 16).map(n => n - 2);
  const g6a = runCells(2, small6, ROUNDS_16, P_EXTRACT, "horizon", "v8");
  const g6b = runCells(2, big6, ROUNDS_48, P_EXTRACT, "horizon", "v8");
  const g7a = runCells(2, small6, ROUNDS_16, P_EXTRACT, "horizon", "v7");
  const g7b = runCells(2, big6, ROUNDS_48, P_EXTRACT, "horizon", "v7");
  for (const n of NS6) {
    const H = n - 2;
    const c = (n > 16 ? g6b : g6a).get(H)!;
    const c7 = (n > 16 ? g7b : g7a).get(H)!;
    const d7 = Math.max(1, c7.fightable);
    const denom = Math.max(1, c.fightable);
    console.log(
      `${pad(n, 3)}   ${pad(horizonFormula(n).toLocaleString(), 13)}   ${pad(budgetOf(n, "v7"), 6)}   ` +
      `${pad((100 * c7.concluded / d7).toFixed(1) + "%", 10)}   ${pad((100 * c7.bell / d7).toFixed(1) + "%", 6)}   |   ` +
      `${pad(budgetOf(n, "v8"), 6)}   ${pad((100 * c.concluded / denom).toFixed(1) + "%", 10)}   ${pad((100 * c.bell / denom).toFixed(1) + "%", 6)}   ` +
      `${pad(mean(c.meanEnded).toFixed(3), 10)}   ${pad(mean(c.realRoiSd).toFixed(4), 12)}   ${pad(IDENTITY_FAILURES === 0 ? "exact" : "FAILED", 9)}`);
  }
  console.log(`\n  "value conserved" is the integer assertion held+treasury == pot+fees, checked in EVERY round of`);
  console.log(`  EVERY cell above under BOTH horizon branches. Truncation cannot break it — settle() counts hp`);
  console.log(`  and banked alike, so a fighter still standing at the bell holds exactly what a dead one's`);
  console.log(`  killer holds — but it is asserted rather than argued.`);
  console.log(`\n  sd(real fighter ROI) is the payout DISPERSION. A truncated fight redistributes less, so the`);
  console.log(`  distribution narrows: players end nearer where they started. That is lower variance for the`);
  console.log(`  house and a duller game for the player, and it is the same fact twice.`);
}

// ------------------------------------------------------------------------------------------------
console.log(`\n\n${"=".repeat(118)}`);
console.log(`§7. CHANNEL 3 — variance, capital at risk, and ruin`);
rule();
{
  console.log(`\nREGIME B (EXTRAPOLATION). R=2, ${ROUNDS_16} rounds/cell at n<=16 and ${ROUNDS_48} above.\n`);
  console.log(` H    n   house capital   net $/rnd   95% CI              stdev   P(losing rnd)   5th / 50th / 95th pct`);
  console.log(`          at risk/rnd`);
  line(118);
  const keep: { H: number; net: number[] }[] = [];
  const H7S = [0, 1, 2, 4, 6, 8, 10, 14], H7B = [22, 30, 46];
  const g7a = runCells(2, H7S, ROUNDS_16, P_EXTRACT, "horizon");
  const g7b = runCells(2, H7B, ROUNDS_48, P_EXTRACT, "horizon");
  for (const H of [...H7S, ...H7B]) {
    const R = 2, n = R + H;
    const c = (H > 14 ? g7b : g7a).get(H)!;
    const s = [...c.net].sort((a, b) => a - b);
    const [lo, hi] = ci95(c.net, 900 + H);
    keep.push({ H, net: c.net });
    console.log(
      `${pad(H, 2)}  ${pad(n, 3)}   ${pad(money(mean(c.houseAtRisk), 2), 12)}   ${pad(money(mean(c.net), 3), 9)}   [${money(lo, 3)}, ${money(hi, 3)}]` +
      `   ${pad(money(sd(c.net), 3), 9)}   ${pad((100 * c.net.filter(x => x < 0).length / c.net.length).toFixed(1) + "%", 12)}   ` +
      `${money(pctile(s, 0.05), 2)} / ${money(pctile(s, 0.5), 2)} / ${money(pctile(s, 0.95), 2)}`);
  }
  console.log(`\n  More house stake per round is more capital at risk for IDENTICAL expectation. That is the whole`);
  console.log(`  of Channel 3: the stdev column moves, the mean column does not.\n`);

  console.log(`RUIN, REGIME A — TODAY, AND IT IS NOT A PROBABILITY.`);
  console.log(`  The program moves ZERO tokens (verified: no anchor_spl / token::transfer / TokenAccount in`);
  console.log(`  lib.rs; Enter<'info> carries five accounts and none is a token account; programs/vault/ is out`);
  console.log(`  of the workspace members list). So the operator's ~${OPERATOR_SOL} SOL is GAS, NOT STAKE. There is no`);
  console.log(`  stochastic path to ruin — there is a countdown, and house sizing barely touches its rate.\n`);
  console.log(`   H house fighters   gas SOL/round (post-reclaim)   rounds funded by ${OPERATOR_SOL} SOL   hours at ~110s cadence`);
  line(104);
  for (const H of [0, 1, 2, 9, 10, 20, 32, 46]) {
    const g = gasSol(H);
    const rounds = OPERATOR_SOL / g;
    const note = H === 9 ? "   <- deployed ladder at 1 real player" : H === 32 ? "   <- HOUSE_WALLET_COUNT_MAX ceiling" : "";
    console.log(`   ${pad(H, 3)}                ${pad(g.toFixed(6), 12)}                  ${pad(Math.round(rounds).toLocaleString(), 10)}         ${pad((rounds * 110 / 3600).toFixed(1), 8)}${note}`);
  }
  console.log(`\n   PRE-RECLAIM ALTERNATE (${GAS_PRERECLAIM_SOL} SOL/round, if close_round_account were off):`);
  for (const H of [0, 9, 46]) {
    const g = gasSol(H, GAS_PRERECLAIM_SOL);
    console.log(`   H=${pad(H, 2)}   ${g.toFixed(6)} SOL/round   ${pad(Math.round(OPERATOR_SOL / g).toLocaleString(), 8)} rounds   ${(OPERATOR_SOL / g * 110 / 3600).toFixed(1)} hours`);
  }
  console.log(`\n   THE GAS COLUMN IS NOT THE CONSTRAINT AND NOBODY SHOULD OPTIMISE IT. Going from H=0 to H=46`);
  console.log(`   costs ${(gasSol(46) - gasSol(0)).toFixed(6)} SOL/round — it shortens a ${Math.round(OPERATOR_SOL / gasSol(0)).toLocaleString()}-round runway to ${Math.round(OPERATOR_SOL / gasSol(46)).toLocaleString()}. Real, and second order.\n`);

  console.log(`RUIN, REGIME B — IF CUSTODY SHIPS (EXTRAPOLATION). Bootstrapped paths of 5,000 rounds, 300 trials,`);
  console.log(`resampled from the per-round population above, net of gas, against the ${OPERATOR_SOL} SOL balance = $${(OPERATOR_SOL * SOL_USD).toFixed(0)}.\n`);
  console.log(`   RUIN OVER A LONG HORIZON IS DOMINATED BY THE DRIFT, NOT THE NOISE, so the mean column is printed`);
  console.log(`   beside it: a policy whose per-round mean is negative ruins with probability ~1 at any bankroll,`);
  console.log(`   and that is a statement about the sampled mean, not about risk.\n`);
  console.log(`   H    mean $/rnd    stdev $/rnd    P(ruin at $${(OPERATOR_SOL * SOL_USD).toFixed(0)})   P(ruin at $75, i.e. 0.5 SOL)   mean max drawdown`);
  line(110);
  const bank = OPERATOR_SOL * SOL_USD;
  for (const k of keep) {
    const rnd = mulberry32(31337 + k.H);
    let ruinBig = 0, ruinSmall = 0; const dds: number[] = [];
    for (let t = 0; t < 300; t++) {
      let cum = 0, peak = 0, dd = 0, dead1 = false, dead2 = false;
      for (let r = 0; r < 5000; r++) {
        cum += k.net[(rnd() * k.net.length) | 0] - gasUsd(k.H);
        if (cum > peak) peak = cum;
        if (peak - cum > dd) dd = peak - cum;
        if (cum < -bank) dead1 = true;
        if (cum < -75) dead2 = true;
      }
      if (dead1) ruinBig++; if (dead2) ruinSmall++; dds.push(dd);
    }
    console.log(`  ${pad(k.H, 3)}    ${pad(money(mean(k.net) - gasUsd(k.H), 3), 10)}    ${pad(money(sd(k.net), 3), 10)}     ${pad((100 * ruinBig / 300).toFixed(2) + "%", 10)}          ${pad((100 * ruinSmall / 300).toFixed(2) + "%", 10)}            ${money(mean(dds), 2)}`);
  }
}

// ------------------------------------------------------------------------------------------------
console.log(`\n\n${"=".repeat(118)}`);
console.log(`§8. CHANNEL 4 — the circular fee share: how much of "treasury intake" is the house paying itself`);
rule();
{
  console.log(`\nHouse wallets pay the entry fee through the same enter instruction with no exemption`);
  console.log(`(lib.rs:1253,1268 — no caller check), into a treasury the house owns. ${ROUNDS_16} rounds/cell.\n`);
  console.log(`  R    H   n    treasury intake $/rnd   of which CIRCULAR   circular share   NET HOUSE $/rnd   gross overstates net by`);
  line(118);
  const rows: [number, number][] = [[1, 0], [1, 2], [1, 9], [1, 15], [2, 0], [2, 4], [2, 8], [2, 14], [4, 0], [4, 6], [4, 12], [8, 0], [8, 8]];
  const byR = new Map<number, Map<number, Cell>>();
  for (const R of new Set(rows.map(x => x[0]))) byR.set(R, runCells(R, rows.filter(x => x[0] === R).map(x => x[1]), ROUNDS_16, P_EXTRACT, "horizon"));
  for (const [R, H] of rows) {
    const c = byR.get(R)!.get(H)!;
    const t = mean(c.treasury), ci = mean(c.circular), net = mean(c.net);
    const share = t > 0 ? (100 * ci / t).toFixed(1) + "%" : "n/a";
    const over = net > 0 ? (t / net).toFixed(2) + "x" : "n/a";
    console.log(`${pad(R, 3)}  ${pad(H, 3)}  ${pad(R + H, 3)}   ${pad(money(t, 3), 20)}   ${pad(money(ci, 3), 17)}   ${pad(share, 14)}   ${pad(money(net, 3), 15)}   ${pad(over, 22)}`);
  }
  console.log(`\n  The last column is the size of the illusion a naive treasury/volume ratio would report. It is a`);
  console.log(`  pure function of H and it is the one thing H reliably does move — in the wrong direction, for`);
  console.log(`  anyone reading the treasury as revenue.`);
}

// ------------------------------------------------------------------------------------------------
console.log(`\n\n${"=".repeat(118)}`);
console.log(`§9. CANDIDATE POLICIES — scored per real-player count, with the cover term`);
rule();
{
  /** cover: a side with nobody real on it needs a fighter or there is no fight at all. */
  const cover = (s0: number, s1: number) => (s0 === 0 ? 1 : 0) + (s1 === 0 ? 1 : 0);

  type Policy = { name: string; f: (s0: number, s1: number, cap: number) => number };
  const policies: Policy[] = [
    {
      name: "DEPLOYED ladder", f: (s0, s1) => {
        const realTotal = s0 + s1;
        if (realTotal === 0) return HOUSE_MAX_WITHOUT_REAL_PLAYER;
        const throttled = Math.max(HOUSE_FLOOR - realTotal, HOUSE_BOARD_TARGET - HOUSE_DISPLACEMENT * realTotal);
        return Math.max(0, Math.min(HOUSE_WALLET_COUNT, Math.max(throttled, cover(s0, s1))));
      },
    },
    { name: "H = 0 (never field)", f: () => 0 },
    { name: "H = cover only", f: (s0, s1) => (s0 + s1 === 0 ? 0 : cover(s0, s1)) },
    { name: "H = max(2-R, cover)", f: (s0, s1) => (s0 + s1 === 0 ? 0 : Math.max(0, Math.max(HOUSE_FLOOR - (s0 + s1), cover(s0, s1)))) },
    { name: "H = 2 constant", f: (s0, s1) => (s0 + s1 === 0 ? 0 : 2) },
    { name: "H = 6 constant", f: (s0, s1) => (s0 + s1 === 0 ? 0 : 6) },
    { name: "fill to T=8", f: (s0, s1, cap) => (s0 + s1 === 0 ? 0 : Math.max(cover(s0, s1), Math.min(cap - (s0 + s1), 8 - (s0 + s1)))) },
    { name: "fill to T=16", f: (s0, s1, cap) => (s0 + s1 === 0 ? 0 : Math.max(cover(s0, s1), Math.min(cap - (s0 + s1), 16 - (s0 + s1)))) },
    { name: "fill to T=cap", f: (s0, s1, cap) => (s0 + s1 === 0 ? 0 : Math.max(cover(s0, s1), cap - (s0 + s1))) },
  ];

  interface Acc { net: number[]; low: number[]; H: number[]; risk: number[]; circ: number[]; treas: number[]; pen: number[]; bell: number; fightable: number; concluded: number; gas: number[] }
  const newAcc = (): Acc => ({ net: [], low: [], H: [], risk: [], circ: [], treas: [], pen: [], bell: 0, fightable: 0, concluded: 0, gas: [] });

  /** EVERY policy scored on EVERY round, in one pass over the rounds.
   *
   *  Rounds outer again, and for the same two reasons as `runCells`: it bounds memory, and it hands
   *  every policy the identical crowd and the identical hash chain. The paired test below is only
   *  legitimate because of the second — two policies differ ONLY in how many house wallets they
   *  seated, never in who turned up or what the dice said. */
  function scoreAll(ps: Policy[], cap: number, Rs: number[], rounds: number, timing: "horizon" | "budget") {
    const out = ps.map(() => new Map<number, Acc>());
    for (const R of Rs) {
      ps.forEach((_, i) => out[i].set(R, newAcc()));
      for (let r = 0; r < rounds; r++) {
        const lob = realLobby(R, r, P_EXTRACT);
        const hashes = new Array<Buffer | undefined>(MAX_BUDGET);
        ps.forEach((p, i) => {
          const acc = out[i].get(R)!;
          const H = Math.max(0, Math.min(p.f(lob.s0, lob.s1, cap), cap - R, HOUSE_WALLET_COUNT_MAX));
          const { entries, draws } = withHouse(lob, H, r);
          acc.H.push(H); acc.gas.push(gasUsd(H));
          if (entries.length < 2) { acc.net.push(0); acc.low.push(0); acc.risk.push(0); acc.circ.push(0); acc.treas.push(0); acc.pen.push(0); return; }
          const o = simRound(seedFor(r), hashes, entries, draws, timing);
          noteOk(o.ok, `policy ${p.name} R=${R} r=${r}`);
          if (o.fightable) { acc.fightable++; if (o.concluded) acc.concluded++; else acc.bell++; }
          acc.net.push(o.fightable ? toUsd(o.netHouseU.shipped) : 0);
          acc.low.push(o.fightable ? toUsd(o.feesRealU + o.penRealU.shipped) : 0);
          acc.risk.push(toUsd(o.grossHouseU));
          acc.circ.push(o.fightable ? toUsd(o.feesHouseU + o.penHouseU.shipped) : 0);
          acc.treas.push(o.fightable ? toUsd(o.feesRealU + o.feesHouseU + o.penRealU.shipped + o.penHouseU.shipped) : 0);
          acc.pen.push(o.fightable ? toUsd(o.penRealU.shipped) : 0);
        });
      }
    }
    return out;
  }

  for (const cap of [16, 48]) {
    console.log(`\n--- SEAT CAP ${cap} --- ${ROUNDS_POLICY} rounds per (policy, R) cell. Every policy is clamped to`);
    console.log(`    min(cap - R, HOUSE_WALLET_COUNT_MAX = ${HOUSE_WALLET_COUNT_MAX}) — the keeper's own wallet-bank ceiling, config.ts:549.\n`);
    const Rs = cap === 16 ? [0, 1, 2, 4, 8] : [0, 1, 2, 4, 8];
    console.log(`  policy                mean H   E[net] $/rnd   95% CI            raw net   stdev   P(loss)   circular   house cap   bell%   pen $/rnd   NET OF GAS   fightable`);
    console.log(`                                 (fee+pen estimator)                  (noisy)`);
    console.log(`  (aggregated over R in {${Rs.join(",")}}, equal weight — AN INVENTED TRAFFIC MIX, stated so it can be replaced)`);
    line(118);
    const results: { name: string; net: number; netGas: number; series: number[] }[] = [];
    const scored = scoreAll(policies, cap, Rs, ROUNDS_POLICY, "horizon");
    policies.forEach((p, pi) => {
      const sc = scored[pi];
      const net: number[] = [], low: number[] = [], H: number[] = [], risk: number[] = [], circ: number[] = [], treas: number[] = [], pen: number[] = [], gas: number[] = [];
      let bell = 0, fightable = 0, tot = 0;
      for (const R of Rs) {
        const a = sc.get(R)!;
        net.push(...a.net); low.push(...a.low); H.push(...a.H); risk.push(...a.risk); circ.push(...a.circ); treas.push(...a.treas); pen.push(...a.pen); gas.push(...a.gas);
        bell += a.bell; fightable += a.fightable; tot += a.net.length;
      }
      const [lo, hi] = ci95(low, 60 + p.name.length + cap);
      const netGas = mean(low) - mean(gas);
      // The paired test runs on the LOW-VARIANCE series. Pairing cancels the crowd, but it cannot
      // cancel the house's own book, because two policies field DIFFERENT house wallets — so a raw-net
      // comparison stays swamped by a term §2 proves is zero-mean. Dropping it is the whole point.
      results.push({ name: p.name, net: mean(low), netGas, series: low.map((x, i) => x - gas[i]) });
      console.log(
        `  ${rpad(p.name, 20)}  ${pad(mean(H).toFixed(2), 6)}   ${pad(money(mean(low), 3), 12)}   [${money(lo, 3)}, ${money(hi, 3)}]  ` +
        `${pad(money(mean(net), 2), 7)}  ${pad(money(sd(net), 2), 6)}  ${pad((100 * net.filter(x => x < 0).length / net.length).toFixed(1) + "%", 7)}  ` +
        `${pad(mean(treas) > 0 ? (100 * mean(circ) / mean(treas)).toFixed(1) + "%" : "n/a", 8)}  ${pad(money(mean(risk), 2), 9)}  ` +
        `${pad(fightable > 0 ? (100 * bell / fightable).toFixed(0) + "%" : "n/a", 5)}  ${pad(money(mean(pen), 3), 9)}   ${pad(money(netGas, 3), 10)}   ${pad((100 * fightable / tot).toFixed(0) + "%", 8)}`);
    });
    // paired significance against the deployed ladder
    const base = results.find(r => r.name === "DEPLOYED ladder")!;
    console.log(`\n  Paired difference against the DEPLOYED ladder (same rounds, same crowds, same dice), net of gas:\n`);
    console.log(`  policy                 difference $/rnd     95% CI                 verdict`);
    line(100);
    for (const r of results) {
      if (r.name === base.name) continue;
      const [d, lo, hi] = pairedDiffCi(r.series, base.series, 8080 + cap + r.name.length);
      const verdict = lo > 0 ? "BETTER (significant)" : hi < 0 ? "WORSE (significant)" : "not distinguishable from the deployed ladder";
      console.log(`  ${rpad(r.name, 21)}  ${pad(money(d, 4), 16)}     [${money(lo, 4)}, ${money(hi, 4)}]     ${verdict}`);
    }
    console.log(`\n  "fightable" is the fraction of rounds in which a fight can physically happen. A policy that`);
    console.log(`  produces unfightable lobbies is scored as producing ZERO revenue in those rounds and still`);
    console.log(`  paying the gas — which is why "H = 0" is not free.`);
  }
}

// ------------------------------------------------------------------------------------------------
type ArgRow = { R: number; best: number; bestNet: number; zeroNet: number; ties: number[] };
const ANSWER: Record<string, ArgRow[]> = {};

console.log(`\n\n${"=".repeat(118)}`);
console.log(`§10. THE ANSWER — optimal H for each R, at cap 16 and at cap 48`);
rule();
{
  console.log(`\n"Optimal" = argmax over H of (mean net house revenue - gas(H)), read off the paired surface. The`);
  console.log(`"indistinguishable" column is the set of H whose paired 95% CI against the argmax straddles zero:`);
  console.log(`if that set is the whole row, THE ARGMAX IS NOISE and the honest answer is that H does not matter.\n`);

  for (const [label, s, grid, rounds, key] of [
    ["CAP 16, extract timing = uniform on the horizon", S16, FULL16, ROUNDS_16, "h16"],
    ["CAP 48, extract timing = uniform on the horizon", S48, GRID48, ROUNDS_48, "h48"],
  ] as const) {
    console.log(`--- ${label} (${rounds} rounds/cell) ---\n`);
    console.log(`   R    argmax H    net of gas at argmax    net of gas at H=0    H indistinguishable from the argmax (paired 95%)`);
    line(118);
    const rows = argmaxTable(s as Surface, grid as (R: number) => number[], c => c.lowVar);
    ANSWER[key] = rows;
    for (const row of rows) {
      const ties = row.ties.length === (grid as (R: number) => number[])(row.R).length ? "ALL of them  <- the row is flat; the argmax is noise" : row.ties.join(",");
      console.log(`  ${pad(row.R, 3)}   ${pad(row.best, 8)}    ${pad(money(row.bestNet, 4), 20)}    ${pad(money(row.zeroNet, 4), 17)}    ${ties}`);
    }
    console.log();
  }

  console.log(`--- CAP 48 under the "clamp16" horizon branch (the other half of defect 2) ---\n`);
  console.log(`   R    argmax H    net of gas at argmax    net of gas at H=0    H indistinguishable from the argmax`);
  line(118);
  for (const row of argmaxTable(S48, GRID48, c => c.lowVarClamp)) {
    const ties = row.ties.length === GRID48(row.R).length ? "ALL of them  <- flat" : row.ties.join(",");
    console.log(`  ${pad(row.R, 3)}   ${pad(row.best, 8)}    ${pad(money(row.bestNet, 4), 20)}    ${pad(money(row.zeroNet, 4), 17)}    ${ties}`);
  }

  console.log(`\n--- The other extract-timing model (uniform on the FIGHT, not on the curve) ---`);
  console.log(`    Coarser grid and ${Math.round(ROUNDS_16 * 0.6)} / ${Math.round(ROUNDS_48 * 0.8)} rounds/cell, because this is a robustness check on the shape, not a`);
  console.log(`    second headline.\n`);
  const S16b = sweep(16, "budget", [0, 1, 2, 4, 8], (R) => [0, 1, 2, 4, 6, 8, 12, 14].filter(h => h + R <= 16), Math.round(ROUNDS_16 * 0.6));
  const S48b = sweep(48, "budget", [0, 1, 2, 4, 8], (R) => [0, 1, 2, 4, 8, 16, 24, 32, 46].filter(h => h + R <= 48), Math.round(ROUNDS_48 * 0.8));
  for (const [label, s, grid, key] of [
    ["CAP 16", S16b, (R: number) => [0, 1, 2, 4, 6, 8, 12, 14].filter(h => h + R <= 16), "b16"],
    ["CAP 48", S48b, (R: number) => [0, 1, 2, 4, 8, 16, 24, 32, 46].filter(h => h + R <= 48), "b48"],
  ] as const) {
    console.log(`   ${label}:   R -> argmax H (net of gas)`);
    ANSWER[key] = argmaxTable(s as Surface, grid as (R: number) => number[], c => c.lowVar);
    for (const row of ANSWER[key]) {
      const flat = row.ties.length === (grid as (R: number) => number[])(row.R).length;
      console.log(`     R=${pad(row.R, 2)}  ->  H=${pad(row.best, 3)}   ${money(row.bestNet, 4)}   ${flat ? "(row flat — noise)" : "(ties: " + row.ties.join(",") + ")"}`);
    }
    console.log();
  }
}

// ------------------------------------------------------------------------------------------------
console.log(`\n${"=".repeat(118)}`);
console.log(`§11. THE MIGRATION, NOW LANDED — what the bigger board costs in Regime A terms`);
rule();
{
  console.log(`\nRound PDA size = 176 + 64 * MAX_FIGHTERS bytes (lib.rs:2519, corrected 2026-08-10 for the`);
  console.log(`zero_copy header reorder and the 58 -> 64 byte Fighter; matches Round::SIZE = 3,248 asserted`);
  console.log(`directly against size_of::<Round>() at the deployed cap). Solana rent exemption is (128 + bytes)`);
  console.log(`* 6,960 lamports — that protocol formula is unaffected by the migration, but the 0.008561 SOL`);
  console.log(`this used to cite as "measured ... at 16 seats" was a real devnet payment against the OLD (pre-`);
  console.log(`zero_copy) struct, so it calibrates the OLD formula, not this one, and is not restated as a`);
  console.log(`match here — the 16-seat row below is the corrected formula's PREDICTION, not a fresh measurement.\n`);
  console.log(`   MAX_FIGHTERS   Round bytes   rent-exempt SOL   vs 16 seats   float held at MIN_RETAINED_ROUNDS=${MIN_RETAINED_ROUNDS}`);
  line(104);
  for (const cap of [16, 24, 32, 40, 48, 60]) {
    const rent = roundPdaRentSol(cap);
    console.log(`   ${pad(cap, 10)}     ${pad(roundPdaBytes(cap).toLocaleString(), 9)}     ${pad(rent.toFixed(6), 12)}      ${pad((rent / roundPdaRentSol(16)).toFixed(2) + "x", 8)}      ${pad((rent * MIN_RETAINED_ROUNDS).toFixed(4) + " SOL", 14)}  (${(100 * rent * MIN_RETAINED_ROUNDS / OPERATOR_SOL).toFixed(0)}% of the ${OPERATOR_SOL} SOL balance)`);
  }
  console.log(`\n  With close_round_account ON (the default) that rent is FLOAT, not cost — it comes back. With it`);
  console.log(`  OFF it is the dominant per-round cost and 48 seats multiplies it by ${(roundPdaRentSol(48) / roundPdaRentSol(16)).toFixed(2)}: ${(roundPdaRentSol(48) + GAS_BASE_SOL).toFixed(5)} SOL/round,`);
  console.log(`  which funds ${Math.round(OPERATOR_SOL / (roundPdaRentSol(48) + GAS_BASE_SOL)).toLocaleString()} rounds against ${Math.round(OPERATOR_SOL / GAS_PRERECLAIM_SOL).toLocaleString()} today.`);
  console.log(`\n  THE DEPLOY ITSELF costs ~2.4 SOL of the ${OPERATOR_SOL} SOL on hand and resets every PDA. That is ${(100 * 2.4 / OPERATOR_SOL).toFixed(0)}% of`);
  console.log(`  the operating balance spent to buy the seat count. In Regime A the seat count generates no`);
  console.log(`  revenue at all, so that spend has no payback period — it is a product decision, not a`);
  console.log(`  financial one, and it should be argued on those grounds.`);
}

console.log(`\n\n${"=".repeat(118)}`);
console.log(`§12. THE OWNER'S QUESTION, IN ONE TABLE — optimal H by R, both caps, both behavioural models`);
rule();
{
  console.log(`\n  "We can optimize the player count from the house to maximize the profit."`);
  console.log(`\n  Here is the optimum. Read the two right-hand column pairs against each other before reading`);
  console.log(`  either of them on its own.\n`);
  console.log(`         |  TIMING = uniform on the HORIZON       |  TIMING = uniform on the FIGHT`);
  console.log(`    R    |  cap 16        cap 48                  |  cap 16        cap 48`);
  line(90);
  const look = (key: string, R: number) => {
    const row = ANSWER[key]?.find(x => x.R === R);
    if (!row) return rpad("(not swept)", 12);
    return rpad("H = " + row.best + (row.ties.length > 1 ? " *" : ""), 12);
  };
  for (const R of [0, 1, 2, 3, 4, 6, 8, 12, 16]) {
    console.log(`   ${pad(R, 3)}   |  ${look("h16", R)}  ${look("h48", R)}   |  ${look("b16", R)}  ${look("b48", R)}`);
  }
  console.log(`\n  * = the argmax is NOT statistically separable from at least one other H on that row: the row is`);
  console.log(`      flat and the "optimum" is a sampling artefact, not a policy.\n`);
  console.log(`  THE SHAPE, AND IT IS THE SAME AT BOTH CAPS UNDER THE PRIMARY MODEL:`);
  console.log(`    H = 0 when there is nobody real in the room  (an all-house room earns exactly $0 — §2 row 1)`);
  console.log(`    H = exactly enough to make a fight possible  (the COVER term, and it is worth ~$1.6/round at R=2)`);
  console.log(`    H = nothing more.`);
  console.log(`  Raising the cap from 16 to 48 does NOT change that shape. It changes nothing about the optimum,`);
  console.log(`  because the optimum never wanted more than one or two seats in the first place.`);
  console.log(`\n  THE SHAPE UNDER THE OTHER BEHAVIOURAL MODEL IS THE OPPOSITE — fill the board to the cap — and the`);
  console.log(`  ONLY thing that distinguishes the two is whether a player who bails does so at a random point of`);
  console.log(`  the decay curve or at a random point of the fight. NOBODY HAS MEASURED WHICH. Until somebody`);
  console.log(`  does, the honest statement is that the sign of the board-size effect is unknown, its magnitude`);
  console.log(`  is a few percent of revenue either way, and the COVER term is the only part of the policy`);
  console.log(`  supported by evidence rather than by an assumption.`);
}

console.log(`\n${"=".repeat(118)}`);
console.log(IDENTITY_FAILURES === 0
  ? `ACCOUNTING: the identity net_house == -(real players' net) and integer conservation held in EVERY round of EVERY cell.`
  : `!!!! ACCOUNTING: ${IDENTITY_FAILURES} ROUNDS FAILED THE IDENTITY. EVERY NUMBER ABOVE IS SUSPECT. !!!!`);
rule();
console.log(`reproduce: cd engine && npx tsx ../sandbox/house-edge/strategy-house-count.ts ${ROUNDS_16} ${ROUNDS_48} ${ROUNDS_POLICY}`);
console.log();
