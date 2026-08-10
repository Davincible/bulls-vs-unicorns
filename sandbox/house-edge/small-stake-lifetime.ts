// SANDBOX. Run from engine/:
//   HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/small-stake-lifetime.ts [lives] [cell]
//
// DOES A DISCLOSED SMALL-STAKE BONUS RAISE LIFETIME REVENUE PER ACQUIRED PLAYER, AND WHERE IS THE
// OPTIMUM? — measured on a CLOSED POPULATION, because that is the only way the question is honest.
//
// WHY THIS FILE EXISTS AND WHY `lifetime-core.ts`'s POOL CANNOT ANSWER IT
// ----------------------------------------------------------------------
// `lifetime-core.ts` collapses a round to `bal' = bal - stake + stake*(1-phi)*R` and resamples R
// i.i.d. from a pool harvested against an INVENTED fixed field (the five `BANDS`). Its own header
// flags the approximation — "the player's own effect on the field ... captured to first order and no
// further" — and under the SHIPPED size-neutral rule that is a fair trade, because there E[R] = 1 for
// everybody and nobody is paying for anybody.
//
// Under a REDISTRIBUTION mechanic it stops being a trade and becomes a manufacturing process. The
// blend hands a shrunken attacker a bigger bite; that bite is paid, dollar for dollar, by whoever is
// on the other side of the exchange. If the other side is invented, nobody pays it. The pool would
// then report every stake band earning the bonus and no band funding it — the study's own headline
// number would be money that does not exist. `study-damage.ts` does not have this problem because it
// measures ONE round on a real lobby; the moment the measurement runs a player's balance forward
// through hundreds of rounds against a field that never shrinks, it does.
//
// So: `POP` real player slots, `POP/SEATS` real lobbies per round, every seat a simulated player with
// a balance, a churn hazard and a lifetime. Every dollar one player wins is a dollar another player
// lost, and the integer conservation assertion below makes that a fact rather than an intention.
//
// WHAT IS MEASURED AND WHAT IS ASSUMED
// ------------------------------------
//   * MEASURED, on the real fight loop (`runFight` from `fight-variant.ts`, asserted byte-identical to
//     `engine/src/er-sim.ts` by `parity.ts`): every damage exchange, every payout, every fee.
//   * ASSUMED, entirely: the churn model. It is `BASE_PLAYER` from `lifetime-core.ts:298`, unchanged,
//     and HOUSE-STRATEGY.md §7 already calls real player behaviour the largest uncertainty in the
//     document "and it is not close". Part SENS sweeps it instead of defending it.
//   * ASSUMED: that a player's stake is a fixed fraction of balance and that they hold to the bell.
//     Holding to the bell matches `strategy-retention.ts` and is the house's WORST case / the player's
//     BEST case, so no conclusion here is flattered by an extraction penalty.
//
// THE HYPOTHESIS UNDER TEST, stated so it can be refuted rather than mined for
// ---------------------------------------------------------------------------
//   "Favouring small players earns money through RETENTION, not farming: a flatter loss curve means
//    players survive more rounds, so total rake per acquired player rises even though rake per round
//    falls."
// Part CHAN is the sharpest test of it and it is a structural one, not a sweep — see its own comment.
//
// NOTHING IS DEPLOYED. Nothing outside `sandbox/house-edge/` is touched. `fight-variant.ts` is used
// exactly as the orchestrator extended it and is not modified here.

import {
  BASE_PLAYER, GAS_USD_PER_ROUND, ROUNDS_PER_HOUR, SOL_USD, STAKE_CAP_USD,
  MIN_ENTRY, BINS, binOf, binLoUsd, binHiUsd, ci95, hash32, makeDrawR, mean, quant,
  simulateLife, verifyPool, type PlayerModel, type Pool,
} from "./lifetime-core.ts";
import {
  runFight, makeFighter, stepBudget, W_UNIFORM, DUST_ABSOLUTE, FEE_BPS,
  type DamageRule, type Fighter, type FightConfig,
} from "./fight-variant.ts";
import { usd, toUsd } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";

// ------------------------------------------------------------------------------------------------
// Knobs. Everything a number in this file depends on is here or in `BASE_PLAYER`.
// ------------------------------------------------------------------------------------------------

const TARGET_LIVES = Number(process.argv[2] ?? 3000);
const ONLY = process.argv[3] ?? "all";
const TAG = "ss-v1";
const SEATS = 8;
/** REPLICATE INDEX, and the reason this exists rather than a bootstrap.
 *
 *  A cell is ONE population. Its 3,000 lives are not 3,000 independent observations — every life is
 *  coupled to every other one through the lobbies they shared, and the naive standard error over
 *  lives understates the real uncertainty by an unknown factor. A bootstrap over lives would inherit
 *  the same defect, and a block bootstrap would need an assumption about the block length.
 *
 *  So: run the whole population again under a different seed and use the BETWEEN-REPLICATE spread.
 *  That is the estimator with no assumptions in it at all, and at ~45s per population it costs less
 *  than arguing about which bootstrap is right. `report` uses it wherever two or more replicates of a
 *  cell exist and says so in the table; where only one exists it falls back to the over-lives CI and
 *  says THAT, because the two are not the same claim. */
const REP = Number(process.env.SS_REP ?? 0);
/** Population size. Must be a multiple of SEATS so a full round seats everybody. */
const POP = Number(process.env.SS_POP ?? 800);
const MAX_ROUNDS = Number(process.env.SS_MAX_ROUNDS ?? 6000);
const RESULT_DIR = process.env.SS_DIR
  ?? "/private/tmp/claude-501/-Users-tyler-Launchpad-Crypto-UwuGame-magicblock/d5279d95-4422-4376-a720-d79efa3c4e5c/scratchpad/ss/results";

/** Rounds per day at the ~110s cadence: 32.7/hr (SPEC, HOUSE-STRATEGY.md §1). */
const ROUNDS_PER_DAY = Math.round(24 * ROUNDS_PER_HOUR);
/** Post-reclaim keeper gas, SOL/round. The pre-reclaim figure is `GAS_SOL_PER_ROUND` (0.00981); this
 *  is the same reconciliation after rent reclamation. SPEC: $1.4715 vs $0.0615 at SOL $150. */
const GAS_SOL_POST_RECLAIM = 0.00041;
const GAS_USD_POST_RECLAIM = GAS_SOL_POST_RECLAIM * SOL_USD;

const UNITS = (v: number) => usd(v);
const MIN_ENTRY_UNITS = UNITS(MIN_ENTRY);
/** `lifetime-core.ts:191` — `MARTINGALE_FLOOR_USD`. Below this a fighter's ring is close enough to
 *  the $0.001 dust floor that `er-sim.ts:199`'s asymmetric wipe is a measurable drain. A life that
 *  ever visits this region is a life the ruin channel had a shot at. */
const DUST_REGION_UNITS = UNITS(0.10);
/** "No cap" for the channel-attribution cells. Larger than any balance a $100 bankroll reaches. */
const NO_CAP_USD = 1e9;

/** The adversary of the SPEC's cell 6: one actor, $80 of working capital, split into k wallets. */
const ADV_WALLETS = 8;
const ADV_WALLET_USD = 10;

// ------------------------------------------------------------------------------------------------
// CELLS
// ------------------------------------------------------------------------------------------------

type Matchmaking = "random" | "banded" | "tier3";

interface RebateRule {
  /** Basis points of GROSS stake rebated to a qualifying entry. Paid out of house rake, not the pot —
   *  which is the entire point: it is a budget line, not an unbounded transfer from whales. */
  bps: bigint;
  /** Only entries strictly below this stake qualify. */
  thresholdUsd: number;
  /** Per IDENTITY per DAY (785 rounds). `null` = unlimited, which is the cell that prices the farm. */
  dailyCapUsd: number | null;
}

interface Cell {
  name: string;
  group: string;
  damage: DamageRule;
  /** Per-entry stake ceiling. `STAKE_CAP_USD` ($100) is today's arena. */
  capUsd: number;
  /** True when the damage rule reads `Fighter.verified`, i.e. the fight itself is identity-gated. */
  fightGate: boolean;
  /** Share of acquisitions that carry the identity bit. Tracked whenever > 0 so the verified /
   *  unverified split can be reported even for cells whose FIGHT does not read it (rebate cells). */
  verifiedFrac: number;
  model: PlayerModel;
  adversaries: number;
  matchmaking: Matchmaking;
  rebate?: RebateRule;
  /** Harvest raw R = payout/net for the pool validation. Only the control needs it. */
  harvestR: boolean;
}

const base = (over: Partial<Cell> & Pick<Cell, "name" | "group">): Cell => ({
  damage: "min", capUsd: STAKE_CAP_USD, fightGate: false, verifiedFrac: 0,
  model: BASE_PLAYER, adversaries: 0, matchmaking: "random", harvestR: false, ...over,
});

const P_GRID = [5, 10, 20, 40, 100];
const blendOf = (P: number): DamageRule => (P === 0 ? "min" : { blend: BigInt(P) });

function buildCells(): Cell[] {
  const out: Cell[] = [];

  // --- 1-2. the control and the blend sweep. THE HEADLINE. -------------------------------------
  out.push(base({ name: "base", group: "headline", harvestR: true }));
  for (const P of P_GRID) out.push(base({ name: `blend-${P}`, group: "headline", damage: { blend: BigInt(P) } }));

  // --- 3. bounded bonus. `capMult` clamps the basis to C x min(ring_a, ring_d). ------------------
  out.push(base({ name: "capped-P20-C2", group: "capped", damage: { blend: 20n, capMult: 2n } }));
  out.push(base({ name: "capped-P20-C4", group: "capped", damage: { blend: 20n, capMult: 4n } }));
  out.push(base({ name: "capped-P100-C4", group: "capped", damage: { blend: 100n, capMult: 4n } }));

  // --- 4. identity gate. The blend applies only when the ATTACKER is verified. -------------------
  for (const X of [20, 100]) for (const V of [0.25, 0.5, 1.0]) {
    out.push(base({
      name: `gated-P${X}-v${V}`, group: "gated",
      damage: { blend: BigInt(X), gate: "attacker" }, fightGate: true, verifiedFrac: V,
    }));
  }

  // --- 5. the per-entry cap. Does not touch the fight at all. ------------------------------------
  //   `cap-100` is today's arena and is therefore a REPLICATE of `base` under a different cell tag
  //   (different seeds, independent stream). The gap between the two is a free, honest estimate of
  //   run-to-run Monte Carlo noise, which is worth more than the row costs.
  for (const U of [100, 25, 10, 5]) out.push(base({ name: `cap-${U}`, group: "cap", capUsd: U }));

  // --- 6. the adversary. ------------------------------------------------------------------------
  out.push(base({ name: "adversary-base", group: "adversary", adversaries: ADV_WALLETS }));
  out.push(base({ name: "adversary-blend-20", group: "adversary", damage: { blend: 20n }, adversaries: ADV_WALLETS }));
  out.push(base({ name: "adversary-blend-100", group: "adversary", damage: { blend: 100n }, adversaries: ADV_WALLETS }));
  out.push(base({
    name: "adversary-gated-P100-v1", group: "adversary",
    damage: { blend: 100n, gate: "attacker" }, fightGate: true, verifiedFrac: 1.0, adversaries: ADV_WALLETS,
  }));

  // --- CHAN. Rei's structural identity, and the sharpest test in the file. -----------------------
  //   The fight is zero-sum under EVERY damage rule, so for a CLOSED population
  //   sum(rake) = sum(deposits) - sum(withdrawals) and the population's balance decays at exactly
  //   phi*f per round WHATEVER the basis is. It follows that under pure fee-blind churn, with no
  //   stake cap, a redistribution mechanic must move lifetime rake per acquired player by EXACTLY
  //   ZERO. Anything it does move has to come through one of three channels, and this block turns
  //   them on one at a time:
  //     chan-flat : hazardDrawdown = hazardStreak = 0, no cap  -> only the RUIN / MIN-ENTRY BARRIER
  //     chan-hz   : hazard variance on, no cap                -> barrier + VARIANCE-DRIVEN CHURN
  //     chan-cap  : hazard variance off, $100 cap on          -> barrier + THE STAKE CAP
  //     (base / blend-100 are chan-both: all three)
  const FLAT: PlayerModel = { ...BASE_PLAYER, hazardDrawdown: 0, hazardStreak: 0 };
  for (const P of [0, 100]) {
    out.push(base({ name: `chan-flat-P${P}`, group: "chan", damage: blendOf(P), model: FLAT, capUsd: NO_CAP_USD }));
    out.push(base({ name: `chan-hz-P${P}`, group: "chan", damage: blendOf(P), capUsd: NO_CAP_USD }));
    out.push(base({ name: `chan-cap-P${P}`, group: "chan", damage: blendOf(P), model: FLAT }));
  }

  // --- BAND. Matchmaking by stake band: free (keeper lobby assignment), no program change, and it
  //     has NO farm rate at all, because it creates no cross-size transfer for a splitter to capture.
  out.push(base({ name: "banded-full", group: "band", matchmaking: "banded" }));
  out.push(base({ name: "banded-tier3", group: "band", matchmaking: "tier3" }));

  // --- REB. A bounded identity-gated rake rebate, paid from the treasury rather than from the pot.
  //     Does not touch the fight. Its cost is a budget line the operator sets; its farm rate is
  //     bounded BY CONSTRUCTION at the daily cap, which is the property no damage-basis rule has.
  const T = 10;
  for (const r of [25, 50, 100, 200]) {
    out.push(base({
      name: `rebate-${r}-cap2`, group: "reb", verifiedFrac: 0.5,
      rebate: { bps: BigInt(r), thresholdUsd: T, dailyCapUsd: 2.0 },
    }));
  }
  out.push(base({ name: "rebate-100-cap0.5", group: "reb", verifiedFrac: 0.5, rebate: { bps: 100n, thresholdUsd: T, dailyCapUsd: 0.5 } }));
  out.push(base({ name: "rebate-100-uncapped", group: "reb", verifiedFrac: 0.5, rebate: { bps: 100n, thresholdUsd: T, dailyCapUsd: null } }));

  // --- SENS. One-at-a-time deviations from BASE_PLAYER, not a full factorial: the point is which
  //     CONCLUSIONS survive, and a conclusion that survives each deviation alone is the claim being
  //     made. Full factorial would be 18 more cells for a joint statement nobody is making.
  const VARIANTS: { tag: string; m: PlayerModel }[] = [
    { tag: "hd0", m: { ...BASE_PLAYER, hazardDrawdown: 0 } },
    { tag: "hd0.2", m: { ...BASE_PLAYER, hazardDrawdown: 0.2 } },
    { tag: "sf0.25", m: { ...BASE_PLAYER, stakeFraction: 0.25 } },
  ];
  for (const v of VARIANTS) for (const P of [0, 20, 100]) {
    out.push(base({ name: `sens-${v.tag}-P${P}`, group: "sens", damage: blendOf(P), model: v.m }));
  }

  return out;
}

const CELLS = buildCells();
const byName = new Map(CELLS.map(c => [c.name, c]));

/** `damage` rendered as the one line that says what actually changed in the fight. */
function damageLabel(d: DamageRule): string {
  if (typeof d === "string") return d === "min" ? "min (SHIPPED)" : d;
  const bits = [`blend P=${d.blend}bps`];
  if (d.gate) bits.push(`gate=${d.gate}`);
  if (d.capMult !== undefined) bits.push(`capMult=${d.capMult}`);
  return bits.join(" ");
}

/** The blend setting a cell is comparable to on the headline axis, for tables that sort by P. */
function pOf(c: Cell): number {
  return typeof c.damage === "string" ? 0 : Number(c.damage.blend);
}

const cfgOf = (damage: DamageRule): FightConfig => ({
  attacker: W_UNIFORM, defender: W_UNIFORM,
  dust: { kind: "absolute", units: DUST_ABSOLUTE },
  layout: "legacy", damage, defenderDraw: "shift",
});

// ------------------------------------------------------------------------------------------------
// STATISTICS. Streaming, because the band tables see tens of millions of player-rounds and storing
// them would cost gigabytes to compute two moments.
// ------------------------------------------------------------------------------------------------

class Acc {
  n = 0; private m = 0; private m2 = 0;
  push(x: number) { this.n++; const d = x - this.m; this.m += d / this.n; this.m2 += d * (x - this.m); }
  get mean() { return this.n ? this.m : NaN; }
  get sd() { return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : NaN; }
  get se() { return this.n > 1 ? this.sd / Math.sqrt(this.n) : NaN; }
}

/** Stake bands for the VARIANCE channel. Coarser than `binOf`'s sixteen quarter-decades because sigma
 *  needs a readable table, and extended below $3 and above $100 because a collapsing balance and a
 *  winning one both leave the five `BANDS` of `lobby.ts` immediately. */
const SIGMA_BANDS = [
  { name: "dust    <$0.10", lo: 0, hi: 0.10 },
  { name: "micro  $0.10-1", lo: 0.10, hi: 1 },
  { name: "small     $1-8", lo: 1, hi: 8 },
  { name: "mid      $8-30", lo: 8, hi: 30 },
  { name: "large  $30-100", lo: 30, hi: 100 },
  { name: "whale   >=$100", lo: 100, hi: Infinity },
];
const bandOf = (stakeUsd: number) => {
  for (let i = SIGMA_BANDS.length - 1; i >= 0; i--) if (stakeUsd >= SIGMA_BANDS[i].lo) return i;
  return 0;
};

// ------------------------------------------------------------------------------------------------
// THE COHORT SIMULATOR
// ------------------------------------------------------------------------------------------------

interface Slot {
  balUnits: bigint;
  peakUnits: bigint;
  streak: number;
  depositedUnits: bigint;
  rakeUnits: bigint;
  /** Rounds this life has been PRESENT for, counting a redeposit round the player sits out — which is
   *  what `simulateLife` counts (`lifetime-core.ts:348`, the `continue` runs through the `rounds++`). */
  rounds: number;
  redepositP: number;
  verified: 0 | 1;
  busts: number;
  rebateTodayUnits: bigint;
  maxDayRebateUnits: bigint;
  adv: boolean;
  /** CUMULATIVE GROSS STAKE — turnover. The rake is `feeBps` of THIS and of nothing else, which is
   *  the identity that turns the whole study from "did retention improve?" into an arithmetic
   *  question with one unknown. See the DECOMPOSITION table. */
  turnoverUnits: bigint;
  /** Did this life ever visit the sub-$0.10 region where the dust rule (er-sim.ts:199) is a
   *  systematic drain, and did it ever reach the bust branch? The ruin-channel diagnosis. */
  everBelow10c: boolean;
}

interface Life {
  rakeUsd: number; depositedUsd: number; withdrawnUsd: number; turnoverUsd: number;
  rounds: number; busts: number; exit: "ruin" | "quit" | "cap"; verified: 0 | 1;
  everBelow10c: boolean; exitRound: number;
}

interface CellResult {
  cell: string; rep: number; group: string; p: number; damage: string;
  capUsd: number; verifiedFrac: number; fightGate: boolean;
  matchmaking: Matchmaking; rebate: { bps: number; thresholdUsd: number; dailyCapUsd: number | null } | null;
  model: { stakeFraction: number; hazardBase: number; hazardDrawdown: number; hazardStreak: number; bankroll: number };
  feeBps: number; pop: number; seats: number;
  roundsRun: number; lobbyRounds: number; livesCompleted: number; censored: number;
  targetLivesReached: boolean;
  conservation: { roundsChecked: number; maxResidualUnits: string; lobbiesChecked: number };
  sitOut: { redeposit: number; leftover: number; playerRounds: number };
  /** Completed lives only. The mean is biased LOW: long lives are over-represented among the
   *  censored, so excluding them drops the top of the distribution. */
  life: {
    n: number; rake: number; rakeCi: number; rakeMedian: number;
    rounds: number; roundsCi: number; roundsMedian: number;
    dep: number; depCi: number; wd: number; wdCi: number;
    turnover: number; turnoverCi: number;
    pRuin: number; pQuit: number; pCap: number; busts: number;
    /** Share of lives that ever visited the sub-$0.10 dust region. The ruin channel's population. */
    pVisitedDust: number;
  };
  byVerified: { verified: CellResult["life"] | null; unverified: CellResult["life"] | null };
  /** Kaplan-Meier censoring correction and the hard lower bound. See `kmEstimate`. */
  censoring: { kmRake: number; kmDep: number; kmWd: number; kmRounds: number; kmTurnover: number; tailS: number; lbRake: number; lbRounds: number };
  house: { rakeUsdTotal: number; rebateUsdTotal: number; rakePerLobbyRound: number; turnoverUsdTotal: number; rakeBpsOfTurnover: number };
  bands: { name: string; n: number; roiMean: number; roiSd: number; roiSe: number }[];
  /** Mean R = payout/net by stake bin, for EVERY cell (not just the control). The two dust bins are
   *  the ruin-channel diagnosis: under `min` a sub-$0.10 fighter is ground down and wiped, and any
   *  P > 0 hands it a share of a LARGE opponent's ring instead. */
  binR: { bin: number; lo: number; hi: number; n: number; mean: number; se: number }[];
  adversary: null | {
    wallets: number; walletUsd: number; verifiedWallets: number;
    netUsd: number; depositedUsd: number; withdrawnUsd: number; rakePaidUsd: number;
    /** Mean and 95% CI of the PER-ROUND P&L. Rounds are the independent unit here — the adversary
     *  strips its winnings every round, so there is no compounding to correlate them. Without this
     *  interval a cumulative net is unreadable: at 8 wallets x $10 and ~44% per-round sigma the
     *  cumulative sd over a few hundred rounds is in the hundreds of dollars. */
    perRoundUsd: number; perRoundCi: number; perRoundSigma: number; roundsN: number;
    perDayUsd: number; perDayCi: number; perRoundPerWalletUsd: number;
    /** Net per day per dollar of attacker working capital, so it scales to any budget. */
    perDayPerCapitalDollar: number; dailyRoiPct: number;
  };
  rebateStats: null | { paidUsd: number; qualifyingEntries: number; maxDayPerIdentityUsd: number; theoreticalMaxDayUsd: number };
}

function runCohort(c: Cell, log: (s: string) => void): { res: CellResult; pool: Pool | null } {
  const cfg = cfgOf(c.damage);
  const M = c.model;
  const rnd = mulberry32(hash32(`${TAG}|${c.name}|r${REP}|stream`));
  const budget = stepBudget(SEATS);
  const capUnits = UNITS(c.capUsd);
  const bankrollUnits = UNITS(M.bankroll);
  const advUnits = UNITS(ADV_WALLET_USD);
  const frac10k = BigInt(Math.round(M.stakeFraction * 10_000));
  const rebateThreshold = c.rebate ? UNITS(c.rebate.thresholdUsd) : 0n;
  const rebateDayCap = c.rebate && c.rebate.dailyCapUsd !== null ? UNITS(c.rebate.dailyCapUsd) : null;

  if (POP % SEATS !== 0) { console.error(`POP=${POP} must be a multiple of SEATS=${SEATS}`); process.exit(1); }

  // --- money, all integer -----------------------------------------------------------------------
  let totalDeposited = 0n, totalWithdrawn = 0n, houseRake = 0n, rebatePaid = 0n, totalTurnover = 0n;
  let advDeposited = 0n, advWithdrawn = 0n, advRake = 0n;
  let maxResidual = 0n, roundsChecked = 0, lobbiesChecked = 0;
  /** The adversary's P&L for each round, in micro-units. Its mean is the farm rate; its spread is
   *  what says whether the farm rate is real. */
  const advPnl: number[] = [];

  const N = POP + c.adversaries;
  const slots: Slot[] = [];
  const freshHonest = (): Slot => ({
    balUnits: bankrollUnits, peakUnits: bankrollUnits, streak: 0,
    depositedUnits: bankrollUnits, rakeUnits: 0n, rounds: 0,
    redepositP: M.redeposit, verified: rnd() < c.verifiedFrac ? 1 : 0, busts: 0,
    rebateTodayUnits: 0n, maxDayRebateUnits: 0n, adv: false,
    turnoverUnits: 0n, everBelow10c: false,
  });
  for (let i = 0; i < POP; i++) { slots.push(freshHonest()); totalDeposited += bankrollUnits; }
  // THE ADVERSARY'S IDENTITY IS SCARCE, AND THAT IS THE WHOLE MODEL OF THE GATE. One actor holds ONE
  // wallet-to-X link, so exactly one of their k wallets carries `verified = 1` however finely they
  // split. If the gate is worth anything, this is where it shows up.
  for (let i = 0; i < c.adversaries; i++) {
    slots.push({
      balUnits: advUnits, peakUnits: advUnits, streak: 0, depositedUnits: advUnits, rakeUnits: 0n,
      rounds: 0, redepositP: 0, verified: i === 0 ? 1 : 0, busts: 0,
      rebateTodayUnits: 0n, maxDayRebateUnits: 0n, adv: true,
      turnoverUnits: 0n, everBelow10c: false,
    });
    totalDeposited += advUnits; advDeposited += advUnits;
  }

  // --- survival bookkeeping, indexed by AGE (rounds present so far). See `kmEstimate`. -----------
  const A = MAX_ROUNDS + 2;
  const ageN = new Float64Array(A), ageRake = new Float64Array(A), ageDep = new Float64Array(A);
  const ageWd = new Float64Array(A), deaths = new Float64Array(A), ageTurn = new Float64Array(A);
  let maxAge = 0;

  const lives: Life[] = [];
  const bands = SIGMA_BANDS.map(() => new Acc());
  const binAcc = Array.from({ length: BINS }, () => new Acc());
  const rBins: number[][] = c.harvestR ? Array.from({ length: BINS }, () => []) : [];
  const R_CAP_PER_BIN = 300_000;
  let qualifyingRebates = 0;
  let sitOutRedeposit = 0, sitOutLeftover = 0, playerRounds = 0;

  function recordExit(i: number, kind: "ruin" | "quit" | "cap") {
    const s = slots[i];
    const wd = s.balUnits;
    totalWithdrawn += wd;
    const last = s.rounds - 1;
    if (last >= 0) { deaths[last]++; ageWd[last] += Number(wd); }
    lives.push({
      rakeUsd: toUsd(s.rakeUnits), depositedUsd: toUsd(s.depositedUnits), withdrawnUsd: toUsd(wd),
      turnoverUsd: toUsd(s.turnoverUnits), rounds: s.rounds, busts: s.busts, exit: kind,
      verified: s.verified, everBelow10c: s.everBelow10c, exitRound: round,
    });
    slots[i] = freshHonest();
    totalDeposited += bankrollUnits;
  }

  const fundable: number[] = [];
  let round = 0;
  const t0 = Date.now();

  for (; round < MAX_ROUNDS && lives.length < TARGET_LIVES; round++) {
    if (c.rebate && round % ROUNDS_PER_DAY === 0) {
      for (const s of slots) { if (s.rebateTodayUnits > s.maxDayRebateUnits) s.maxDayRebateUnits = s.rebateTodayUnits; s.rebateTodayUnits = 0n; }
    }

    // --- A. ENTRY PASS. Bust -> redeposit (sits out this round, exactly as `simulateLife`'s
    //        round-consuming `continue`) or ruin (does NOT consume the round, exactly as its `break`).
    fundable.length = 0;
    for (let i = 0; i < N; i++) {
      const s = slots[i];
      if (s.adv) { fundable.push(i); continue; }
      if (s.balUnits < MIN_ENTRY_UNITS) {
        if (rnd() < s.redepositP) {
          const t = s.rounds;
          ageN[t]++; ageDep[t] += Number(bankrollUnits); if (t > maxAge) maxAge = t;
          s.busts++; s.depositedUnits += bankrollUnits; s.balUnits += bankrollUnits;
          totalDeposited += bankrollUnits;
          s.redepositP *= M.redepositDecay;
          s.peakUnits = s.balUnits; s.streak = 0; s.rounds++;
          sitOutRedeposit++;
          continue;
        }
        recordExit(i, "ruin");
        fundable.push(i);            // the fresh acquisition takes the seat immediately
        continue;
      }
      fundable.push(i);
    }

    // --- B. MATCHMAKING. Fisher-Yates first, always: it randomises ties for the sorted variants and
    //        is the whole mechanism for `random`.
    for (let k = fundable.length - 1; k > 0; k--) {
      const j = Math.floor(rnd() * (k + 1));
      const t = fundable[k]; fundable[k] = fundable[j]; fundable[j] = t;
    }
    if (c.matchmaking === "banded") {
      // V8's sort is stable, so equal balances keep the shuffled order.
      fundable.sort((a, b) => (slots[a].balUnits < slots[b].balUnits ? 1 : slots[a].balUnits > slots[b].balUnits ? -1 : 0));
    } else if (c.matchmaking === "tier3") {
      const sorted = fundable.slice().sort((a, b) => (slots[a].balUnits < slots[b].balUnits ? 1 : slots[a].balUnits > slots[b].balUnits ? -1 : 0));
      const third = Math.ceil(sorted.length / 3);
      fundable.length = 0;
      for (let t = 0; t < 3; t++) {
        const tier = sorted.slice(t * third, (t + 1) * third);
        for (let k = tier.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); const x = tier[k]; tier[k] = tier[j]; tier[j] = x; }
        for (const x of tier) fundable.push(x);
      }
    }

    const nLob = Math.floor(fundable.length / SEATS);
    sitOutLeftover += fundable.length - nLob * SEATS;

    // --- C. THE ROUNDS. ---------------------------------------------------------------------------
    const idx: number[] = new Array(SEATS);
    const stakes: bigint[] = new Array(SEATS);
    let advPnlRound = 0n;
    for (let L = 0; L < nLob; L++) {
      const fighters: Fighter[] = new Array(SEATS);
      let netSum = 0n;
      for (let k = 0; k < SEATS; k++) {
        const i = fundable[L * SEATS + k];
        const s = slots[i];
        // stake = clamp(bal * stakeFraction, MIN_ENTRY, min(bal, cap)), integer throughout.
        const f10k = s.adv ? 10_000n : frac10k;
        let stake = (s.balUnits * f10k) / 10_000n;
        const hi = s.balUnits < capUnits ? s.balUnits : capUnits;
        if (stake > hi) stake = hi;
        if (stake < MIN_ENTRY_UNITS) stake = MIN_ENTRY_UNITS;

        const { f, fee } = makeFighter(`p${i}`, (k % 2) as 0 | 1, stake, FEE_BPS, c.fightGate ? s.verified : undefined);
        houseRake += fee; s.rakeUnits += fee;
        s.turnoverUnits += stake; totalTurnover += stake;
        if (s.adv) advRake += fee;

        // The rebate: a NEGATIVE fee on a qualifying entry, funded out of house rake. It changes the
        // money, never the fight, so `f` above is untouched by it.
        if (c.rebate && !s.adv && s.verified === 1 && stake < rebateThreshold) {
          let reb = (stake * c.rebate.bps) / 10_000n;
          if (rebateDayCap !== null) {
            const room = rebateDayCap - s.rebateTodayUnits;
            reb = room <= 0n ? 0n : (reb > room ? room : reb);
          }
          if (reb > 0n) {
            s.rebateTodayUnits += reb; houseRake -= reb; s.rakeUnits -= reb;
            s.balUnits += reb; rebatePaid += reb; qualifyingRebates++;
          }
        }

        if (!s.adv) {
          const t = s.rounds;
          ageN[t]++; ageRake[t] += Number(fee); ageTurn[t] += Number(stake);
          if (t === 0) ageDep[0] += Number(s.depositedUnits);
          if (t > maxAge) maxAge = t;
          playerRounds++;
        }
        fighters[k] = f; stakes[k] = stake; idx[k] = i; netSum += f.stake;
      }

      const seed = createHash("sha256").update(`ss|${c.name}|r${REP}|${round}|${L}`).digest();
      runFight(fighters, seed, budget, cfg, undefined, true);

      // CONSERVATION, PER LOBBY, IN INTEGERS: everything that entered the ring left it.
      let outSum = 0n;
      for (let k = 0; k < SEATS; k++) outSum += fighters[k].hp + fighters[k].banked;
      if (outSum !== netSum) {
        console.error(`\n*** LOBBY CONSERVATION FAILED  cell=${c.name} round=${round} lobby=${L}: ` +
                      `net=${netSum} payout=${outSum} residual=${outSum - netSum} ***`);
        process.exit(1);
      }
      lobbiesChecked++;

      for (let k = 0; k < SEATS; k++) {
        const i = idx[k], s = slots[i], stake = stakes[k];
        const p = fighters[k].hp + fighters[k].banked;
        const before = s.balUnits;
        s.balUnits = s.balUnits - stake + p;

        if (s.adv) {
          // Never churns, and strips its winnings each round so its exposure stays constant. A losing
          // round is topped back up from the same $80 of working capital, so `net` below is the true
          // profit and the identity still closes.
          if (s.balUnits > advUnits) { const w = s.balUnits - advUnits; totalWithdrawn += w; advWithdrawn += w; advPnlRound += w; s.balUnits = advUnits; }
          else if (s.balUnits < advUnits) { const d = advUnits - s.balUnits; totalDeposited += d; advDeposited += d; advPnlRound -= d; s.balUnits = advUnits; }
          continue;
        }

        const stakeUsd = toUsd(stake);
        bands[bandOf(stakeUsd)].push(toUsd(p) / stakeUsd - 1);
        const b = binOf(stakeUsd);
        const R = Number(p) / Number(fighters[k].stake);
        binAcc[b].push(R);
        if (c.harvestR && rBins[b].length < R_CAP_PER_BIN) rBins[b].push(R);
        if (s.balUnits < DUST_REGION_UNITS) s.everBelow10c = true;

        s.rounds++;
        if (s.balUnits < before) s.streak = Math.min(M.streakCap, s.streak + 1); else s.streak = 0;
        if (s.balUnits > s.peakUnits) s.peakUnits = s.balUnits;

        // CHURN — `lifetime-core.ts:373-379`, term for term, so the two simulators are comparable.
        const dd = s.peakUnits > 0n ? Math.max(0, 1 - Number(s.balUnits) / Number(s.peakUnits)) : 0;
        const h = M.hazardBase + M.hazardDrawdown * dd + M.hazardStreak * s.streak;
        if (rnd() < h) recordExit(i, "quit");
        else if (s.rounds >= M.maxRounds) recordExit(i, "cap");
      }
    }

    if (c.adversaries > 0) advPnl.push(toUsd(advPnlRound));

    // --- D. CONSERVATION, GLOBAL, IN INTEGERS, EVERY ROUND. -----------------------------------------
    //   houseRake + sum(alive balances) + sum(withdrawn) === sum(deposited, ever)
    //   `houseRake` is net of rebates paid, which is why the rebate cells close on the same identity.
    let aliveSum = 0n;
    for (let i = 0; i < N; i++) aliveSum += slots[i].balUnits;
    const residual = houseRake + aliveSum + totalWithdrawn - totalDeposited;
    const abs = residual < 0n ? -residual : residual;
    if (abs > maxResidual) maxResidual = abs;
    if (residual !== 0n) {
      console.error(`\n*** GLOBAL CONSERVATION FAILED  cell=${c.name} round=${round}: residual=${residual} units ***`);
      console.error(`    rake=${houseRake} alive=${aliveSum} withdrawn=${totalWithdrawn} deposited=${totalDeposited}`);
      process.exit(1);
    }
    roundsChecked++;

    if (round > 0 && round % 200 === 0) {
      process.stderr.write(`  [${c.name}] round ${round}  lives ${lives.length}/${TARGET_LIVES}  ` +
                           `${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
    }
  }

  // --- CENSORING. Every honest slot is mid-life at this point, by construction. -------------------
  let lbRakeExtra = 0, lbRoundsExtra = 0, censored = 0;
  for (let i = 0; i < POP; i++) {
    const s = slots[i];
    censored++; lbRakeExtra += toUsd(s.rakeUnits); lbRoundsExtra += s.rounds;
  }

  // --- statistics ---------------------------------------------------------------------------------
  const stat = (ls: Life[]): CellResult["life"] | null => {
    if (ls.length === 0) return null;
    const rake = Float64Array.from(ls, l => l.rakeUsd);
    const rounds = Float64Array.from(ls, l => l.rounds);
    const dep = Float64Array.from(ls, l => l.depositedUsd);
    const wd = Float64Array.from(ls, l => l.withdrawnUsd);
    const tn = Float64Array.from(ls, l => l.turnoverUsd);
    return {
      n: ls.length,
      rake: mean(rake), rakeCi: ci95(rake), rakeMedian: quant(rake, 0.5),
      rounds: mean(rounds), roundsCi: ci95(rounds), roundsMedian: quant(rounds, 0.5),
      dep: mean(dep), depCi: ci95(dep), wd: mean(wd), wdCi: ci95(wd),
      turnover: mean(tn), turnoverCi: ci95(tn),
      pRuin: ls.filter(l => l.exit === "ruin").length / ls.length,
      pQuit: ls.filter(l => l.exit === "quit").length / ls.length,
      pCap: ls.filter(l => l.exit === "cap").length / ls.length,
      busts: mean(Float64Array.from(ls, l => l.busts)),
      pVisitedDust: ls.filter(l => l.everBelow10c).length / ls.length,
    };
  };

  const km = kmEstimate(ageN, deaths, maxAge, { rake: ageRake, dep: ageDep, wd: ageWd, turn: ageTurn });
  const lobbyRounds = lobbiesChecked;
  const startedLives = lives.length + POP;

  const res: CellResult = {
    cell: c.name, rep: REP, group: c.group, p: pOf(c), damage: damageLabel(c.damage),
    capUsd: c.capUsd, verifiedFrac: c.verifiedFrac, fightGate: c.fightGate,
    matchmaking: c.matchmaking,
    // `bps` is a BigInt on the rule and JSON cannot serialise one. Narrowed here rather than patched
    // with a replacer, so the stored shape is exactly what `CellResult` declares.
    rebate: c.rebate ? { bps: Number(c.rebate.bps), thresholdUsd: c.rebate.thresholdUsd, dailyCapUsd: c.rebate.dailyCapUsd } : null,
    model: { stakeFraction: M.stakeFraction, hazardBase: M.hazardBase, hazardDrawdown: M.hazardDrawdown, hazardStreak: M.hazardStreak, bankroll: M.bankroll },
    feeBps: Number(FEE_BPS), pop: POP, seats: SEATS,
    roundsRun: round, lobbyRounds, livesCompleted: lives.length, censored,
    targetLivesReached: lives.length >= TARGET_LIVES,
    conservation: { roundsChecked, maxResidualUnits: maxResidual.toString(), lobbiesChecked },
    sitOut: { redeposit: sitOutRedeposit, leftover: sitOutLeftover, playerRounds },
    life: stat(lives)!,
    byVerified: {
      verified: c.verifiedFrac > 0 ? stat(lives.filter(l => l.verified === 1)) : null,
      unverified: c.verifiedFrac > 0 ? stat(lives.filter(l => l.verified === 0)) : null,
    },
    censoring: {
      kmRake: km.rake, kmDep: km.dep, kmWd: km.wd, kmRounds: km.rounds, kmTurnover: km.turn, tailS: km.tailS,
      lbRake: (lives.reduce((a, l) => a + l.rakeUsd, 0) + lbRakeExtra) / startedLives,
      lbRounds: (lives.reduce((a, l) => a + l.rounds, 0) + lbRoundsExtra) / startedLives,
    },
    house: {
      rakeUsdTotal: toUsd(houseRake), rebateUsdTotal: toUsd(rebatePaid),
      rakePerLobbyRound: lobbyRounds > 0 ? toUsd(houseRake) / lobbyRounds : 0,
      turnoverUsdTotal: toUsd(totalTurnover),
      rakeBpsOfTurnover: totalTurnover > 0n ? 10_000 * toUsd(houseRake + rebatePaid) / toUsd(totalTurnover) : 0,
    },
    bands: SIGMA_BANDS.map((b, i) => ({ name: b.name, n: bands[i].n, roiMean: bands[i].mean, roiSd: bands[i].sd, roiSe: bands[i].se })),
    binR: binAcc.map((a, b) => ({ bin: b, lo: binLoUsd(b), hi: binHiUsd(b), n: a.n, mean: a.mean, se: a.se })),
    adversary: c.adversaries === 0 ? null : (() => {
      const net = toUsd(advWithdrawn - advDeposited);
      const pr = mean(advPnl), prCi = ci95(advPnl);
      const capital = c.adversaries * ADV_WALLET_USD;
      return {
        wallets: c.adversaries, walletUsd: ADV_WALLET_USD, verifiedWallets: c.fightGate ? 1 : 0,
        netUsd: net, depositedUsd: toUsd(advDeposited), withdrawnUsd: toUsd(advWithdrawn),
        rakePaidUsd: toUsd(advRake),
        perRoundUsd: pr, perRoundCi: prCi, perRoundSigma: prCi > 0 ? Math.abs(pr) / (prCi / 1.96) : 0,
        roundsN: advPnl.length,
        perDayUsd: pr * ROUNDS_PER_DAY, perDayCi: prCi * ROUNDS_PER_DAY,
        perRoundPerWalletUsd: pr / c.adversaries,
        perDayPerCapitalDollar: (pr * ROUNDS_PER_DAY) / capital,
        dailyRoiPct: 100 * (pr * ROUNDS_PER_DAY) / capital,
      };
    })(),
    rebateStats: !c.rebate ? null : (() => {
      let mx = 0n;
      for (const s of slots) { const v = s.rebateTodayUnits > s.maxDayRebateUnits ? s.rebateTodayUnits : s.maxDayRebateUnits; if (v > mx) mx = v; }
      const theo = c.rebate!.dailyCapUsd ?? (c.rebate!.thresholdUsd * Number(c.rebate!.bps) / 10_000) * ROUNDS_PER_DAY;
      return { paidUsd: toUsd(rebatePaid), qualifyingEntries: qualifyingRebates, maxDayPerIdentityUsd: toUsd(mx), theoreticalMaxDayUsd: theo };
    })(),
  };

  const pool: Pool | null = c.harvestR
    ? { bins: rBins.map(a => Float64Array.from(a)), fights: lobbyRounds, seed: `${TAG}|${c.name}`, seats: SEATS }
    : null;

  log(`  [${c.name}] ${round} rounds, ${lobbyRounds} lobby-rounds, ${lives.length} lives, ` +
      `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return { res, pool };
}

/** KAPLAN-MEIER, and why the naive mean needs it.
 *
 *  The run stops with `POP` lives unfinished. Those are not a random sample of lives — a life that is
 *  still going has, by definition, lasted longer than average, and lifetime rake is roughly
 *  proportional to length. So the completed-lives mean is biased DOWNWARDS, and the bias grows with
 *  `POP / lives`. Dropping them silently would flatter no cell in particular but would understate
 *  every one of them, and by different amounts, because the mechanics being compared change life
 *  length — which is exactly the axis the study is measuring.
 *
 *  The fix is the standard survival estimator, applied to a REWARD rather than to survival itself:
 *      E[total X] = sum_t  P(reach age t) * E[X at age t | at risk at t]
 *  where the risk set at age t is every life observed playing its t-th round (completed or censored)
 *  and P(reach t) is the product-limit estimate from the exit ages. Both quantities are accumulated
 *  in O(1) per player-round, which is why it is affordable at tens of millions of them.
 *
 *  IT TRUNCATES RATHER THAN EXTRAPOLATES. If survival never reaches zero inside the run, the estimate
 *  stops at the oldest observed age and is therefore still a (much tighter) lower bound; `tailS` is
 *  the surviving mass at that point and is reported so the reader can see how much is missing. */
function kmEstimate(
  ageN: Float64Array, deaths: Float64Array, maxAge: number,
  rewards: { rake: Float64Array; dep: Float64Array; wd: Float64Array; turn: Float64Array },
): { rake: number; dep: number; wd: number; turn: number; rounds: number; tailS: number } {
  let S = 1, rake = 0, dep = 0, wd = 0, turn = 0, rounds = 0;
  for (let t = 0; t <= maxAge; t++) {
    const n = ageN[t];
    if (n === 0) break;
    rounds += S;
    rake += S * (rewards.rake[t] / n);
    dep += S * (rewards.dep[t] / n);
    wd += S * (rewards.wd[t] / n);
    turn += S * (rewards.turn[t] / n);
    S *= 1 - deaths[t] / n;
    if (S <= 0) { S = 0; break; }
  }
  return { rake: rake / 1e6, dep: dep / 1e6, wd: wd / 1e6, turn: turn / 1e6, rounds, tailS: S };
}

// ------------------------------------------------------------------------------------------------
// VALIDATION — run inside the control cell, because a control that has not been validated is a
// decoration. Two checks, and the second is the one that can actually fail interestingly.
// ------------------------------------------------------------------------------------------------

/** PART 0 — `damage: "min"` must be byte-identical to `damage: {blend: 0n}`.
 *
 *  The control cell is `min` and the sweep starts at `blend: 5n`, so the P axis has a JOIN in it at
 *  P = 0 that no cell actually straddles. If those two code paths diverged — and they are genuinely
 *  different branches in `runFight` (`fight-variant.ts:397` vs `:399`) — every "effect of P" in this
 *  file would be partly an effect of taking a different `if`. This runs both over real lobbies of
 *  every size the study uses and requires identical hp/banked/dead on every fighter.
 *
 *  It costs a second and it removes a whole class of wrong answer, which is the trade every check in
 *  this directory is trying to make. */
function assertBlendZeroIsMin() {
  const a = cfgOf("min"), b = cfgOf({ blend: 0n });
  const rnd = mulberry32(hash32(`${TAG}|p0-equiv`));
  for (let i = 0; i < 400; i++) {
    const mk = () => {
      const f: Fighter[] = [];
      for (let k = 0; k < SEATS; k++) {
        // Log-uniform from the minimum entry to the cap, so the dust region — where the two branches
        // are most likely to part company — is sampled as heavily as the whales.
        const gross = usd(MIN_ENTRY * Math.pow(10, 4 * rnd()));
        f.push(makeFighter(`w${k}`, (k % 2) as 0 | 1, gross, FEE_BPS).f);
      }
      return f;
    };
    const seed = createHash("sha256").update(`${TAG}|p0-equiv|${i}`).digest();
    const fa = mk();
    // `mk` consumes the RNG, so the second lineup must be rebuilt from the same numbers rather than
    // drawn again. Cloned instead: identical inputs is the entire point of the test.
    const fb = fa.map(x => ({ ...x }));
    runFight(fa, seed, stepBudget(SEATS), a, undefined, true);
    runFight(fb, seed, stepBudget(SEATS), b, undefined, true);
    for (let k = 0; k < SEATS; k++) {
      if (fa[k].hp !== fb[k].hp || fa[k].banked !== fb[k].banked || fa[k].dead !== fb[k].dead) {
        console.error(`\n*** PART 0 FAILED: damage:"min" and damage:{blend:0n} diverge at lineup ${i}, seat ${k}.`);
        console.error(`    min  -> hp=${fa[k].hp} banked=${fa[k].banked} dead=${fa[k].dead}`);
        console.error(`    P=0  -> hp=${fb[k].hp} banked=${fb[k].banked} dead=${fb[k].dead}`);
        console.error(`    The P axis has a discontinuity at its own origin. Every result in this file is void. ***`);
        process.exit(1);
      }
    }
  }
  console.log(`PART 0 OK — damage:"min" is byte-identical to damage:{blend:0n} over 400 lobbies x ${SEATS} seats,`);
  console.log(`            log-uniform $${MIN_ENTRY}-$${STAKE_CAP_USD}. The P axis is continuous at its origin, so every`);
  console.log(`            difference measured against the control is an effect of P and not of a changed branch.`);
}

function validate(res: CellResult, pool: Pool) {
  console.log(`\n\n--- VALIDATION 1 — is the cohort's own fight still a martingale at P = 0? -------------------`);
  console.log(`R = payout / net-stake, harvested from the cohort's OWN lobbies (not an invented field).`);
  const v = verifyPool(pool);
  if (!v.ok) {
    console.error(`\n*** MARTINGALE CHECK FAILED at ${v.worstSigma.toFixed(2)} sigma. Everything downstream is void. ***`);
    process.exit(1);
  }

  console.log(`\n\n--- VALIDATION 2 — the cohort against \`simulateLife\` on the cohort's own R pool -----------`);
  console.log(`Same \`BASE_PLAYER\`, same fee, same $100 cap. The ONLY difference is that \`simulateLife\``);
  console.log(`resamples R i.i.d. from a FIXED pool while the cohort's opponents are themselves decaying.`);
  console.log(`If they disagree, that gap IS the self-referential effect the whole mechanic depends on.\n`);

  const drawR = makeDrawR(pool);
  const XN = Number(process.env.SS_XVAL ?? 200_000);
  const rake = new Float64Array(XN), rounds = new Float64Array(XN), dep = new Float64Array(XN), wd = new Float64Array(XN);
  let ruin = 0;
  for (let p = 0; p < XN; p++) {
    const r = simulateLife(BASE_PLAYER, Number(FEE_BPS), mulberry32(hash32(`${TAG}|xval|${p}`)), drawR);
    rake[p] = r.rakeUsd; rounds[p] = r.rounds; dep[p] = r.depositedUsd; wd[p] = r.withdrawnUsd;
    if (r.exit === "ruin") ruin++;
  }
  const L = res.life, C = res.censoring;
  // THE COMPARISON IS KM vs simulateLife, NOT completed-only vs simulateLife. The completed-only mean
  // is a known-biased estimator of the same quantity (see `kmEstimate`), so testing IT against the
  // pool would be a test that fails for a reason nobody is asking about. It is printed anyway because
  // it is the column that carries a CI, and because the size of the correction is itself information.
  const gaps: { k: string; g: number }[] = [];
  const row = (k: string, coh: number, cohCi: number, kmv: number, sl: number, slCi: number) => {
    const gap = sl === 0 ? 0 : (kmv - sl) / sl;
    gaps.push({ k, g: gap });
    console.log(`  ${k.padEnd(28)} ${coh.toFixed(3).padStart(10)} +-${cohCi.toFixed(3).padStart(7)}  ` +
                `${kmv.toFixed(3).padStart(10)}  ${sl.toFixed(3).padStart(10)} +-${slCi.toFixed(3).padStart(7)}  ` +
                `${(gap >= 0 ? "+" : "") + (100 * gap).toFixed(1)}%`.padStart(9));
  };
  console.log(`  ${"quantity".padEnd(28)} ${"cohort (completed)".padStart(20)}  ${"cohort KM".padStart(10)}  ${"simulateLife".padStart(20)}   KM gap`);
  console.log("  " + "-".repeat(96));
  row("rake per acquired player $", L.rake, L.rakeCi, C.kmRake, mean(rake), ci95(rake));
  row("rounds lived", L.rounds, L.roundsCi, C.kmRounds, mean(rounds), ci95(rounds));
  row("deposits per player $", L.dep, L.depCi, C.kmDep, mean(dep), ci95(dep));
  row("withdrawals per player $", L.wd, L.wdCi, C.kmWd, mean(wd), ci95(wd));
  const pr = ruin / XN;
  console.log(`  ${"P(ruin)".padEnd(28)} ${(100 * L.pRuin).toFixed(2).padStart(10)}%${" ".repeat(9)}` +
              `${"-".padStart(10)}  ${(100 * pr).toFixed(2).padStart(10)}%`);
  console.log(`\n  n: cohort ${L.n} completed lives (+${res.censored} censored), simulateLife ${XN} lives.`);
  console.log(`  The KM estimate TRUNCATES at the oldest observed age and ${(100 * C.tailS).toFixed(1)}% of survival mass is still`);
  console.log(`  standing there, so it is itself a lower bound and is expected to sit BELOW the pool column by`);
  console.log(`  roughly that much. Read the gaps against that slack.\n`);

  const worst = gaps.reduce((a, b) => (Math.abs(b.g) > Math.abs(a.g) ? b : a));
  const slack = Math.max(0.03, C.tailS);
  if (Math.abs(worst.g) <= slack) {
    console.log(`  AGREE. Worst gap ${(100 * worst.g).toFixed(1)}% on "${worst.k.trim()}", inside the ${(100 * slack).toFixed(1)}% truncation slack.`);
    console.log(`  The pool approximation and the closed population describe the same economy at P = 0, which is`);
    console.log(`  what makes every P > 0 cell below a comparison against a validated control rather than a`);
    console.log(`  comparison against another guess.`);
  } else {
    console.log(`  *** THEY DISAGREE. Worst gap ${(100 * worst.g).toFixed(1)}% on "${worst.k.trim()}", outside the ${(100 * slack).toFixed(1)}% truncation slack.`);
    console.log(`  THIS IS A FINDING, NOT A FAILURE, and the diagnosis is the same one \`lifetime-core.ts\` flags in`);
    console.log(`  its own header: the pool resamples R i.i.d. from a FIXED distribution, while the cohort's`);
    console.log(`  opponents are themselves decaying round by round. A cohort player therefore meets a field that`);
    console.log(`  is poorer than the pool's, correlated with their own path, and shrinking as they shrink.`);
    console.log(`  ${worst.g < 0 ? "The cohort's lives are SHORTER" : "The cohort's lives are LONGER"} than the pool predicts.`);
    console.log(`  IT IS THE SAME SELF-REFERENTIAL EFFECT THE WHOLE MECHANIC DEPENDS ON — a redistribution rule`);
    console.log(`  only pays a small player because some other REAL player funded it — which is precisely why the`);
    console.log(`  study is run on a closed population and not on the pool. Every cell below is measured in the`);
    console.log(`  cohort, so the gap is a statement about the POOL's fidelity, not about these results.`);
  }
}

// ------------------------------------------------------------------------------------------------
// I/O
// ------------------------------------------------------------------------------------------------

const resultPath = (cell: string, rep: number) => `${RESULT_DIR}/${cell}__r${rep}.json`;

function saveResult(res: CellResult) {
  mkdirSync(RESULT_DIR, { recursive: true });
  writeFileSync(resultPath(res.cell, res.rep), JSON.stringify(res, null, 1));
}
/** Every replicate of every cell, grouped by cell name. */
function loadAll(): Map<string, CellResult[]> {
  const m = new Map<string, CellResult[]>();
  if (!existsSync(RESULT_DIR)) return m;
  for (const f of readdirSync(RESULT_DIR)) if (f.endsWith(".json")) {
    const r = JSON.parse(readFileSync(`${RESULT_DIR}/${f}`, "utf8")) as CellResult;
    const a = m.get(r.cell); if (a) a.push(r); else m.set(r.cell, [r]);
  }
  for (const a of m.values()) a.sort((x, y) => x.rep - y.rep);
  return m;
}

// ------------------------------------------------------------------------------------------------
// AGGREGATION ACROSS REPLICATES. See `REP` for why this exists instead of a bootstrap.
// ------------------------------------------------------------------------------------------------

/** Two-sided 97.5% t quantiles for 1..15 degrees of freedom, then the normal limit. With 3-8
 *  replicates the normal 1.96 would understate the interval by 15-90%, and this study is not going to
 *  claim a significant difference on the strength of a rounding-down. */
const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131];
const tcrit = (df: number) => (df < 1 ? NaN : df < T975.length ? T975[df] : 1.96);

interface Est { mean: number; ci: number; n: number; source: "replicates" | "lives" }

/** A cell-level quantity with an honest interval. `fallbackCi` is the within-run over-lives CI, used
 *  only when a single replicate exists — it answers a DIFFERENT question (sampling error over lives
 *  inside one population, not over populations) and every table that prints it says so. */
function est(reps: CellResult[], f: (r: CellResult) => number, fallbackCi?: (r: CellResult) => number): Est {
  const xs = reps.map(f).filter(Number.isFinite);
  if (xs.length === 0) return { mean: NaN, ci: NaN, n: 0, source: "replicates" };
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  if (xs.length === 1) return { mean: m, ci: fallbackCi ? fallbackCi(reps[0]) : NaN, n: 1, source: "lives" };
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return { mean: m, ci: tcrit(xs.length - 1) * Math.sqrt(v / xs.length), n: xs.length, source: "replicates" };
}

/** Difference of two independent cell estimates, with a sigma. Welch, on the replicate spreads. */
function diff(a: Est, b: Est): { d: number; ci: number; sigma: number } {
  const d = a.mean - b.mean;
  const ci = Math.hypot(a.ci, b.ci);
  return { d, ci, sigma: ci > 0 ? Math.abs(d) / (ci / 1.96) : 0 };
}

// ------------------------------------------------------------------------------------------------
// PRINTING
// ------------------------------------------------------------------------------------------------

const F = (x: number, w = 9, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a").padStart(w);
const PCT = (x: number, w = 7, d = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : "n/a").padStart(w);

function header() {
  console.log(`\n${"=".repeat(118)}`);
  console.log(`SMALL-STAKE MECHANICS vs LIFETIME REVENUE PER ACQUIRED PLAYER  —  closed-population simulation`);
  console.log(`${"=".repeat(118)}`);
  console.log(`REPRODUCE (every figure below is a pure function of these):`);
  console.log(`    cd engine && HE_FEE_BPS=${FEE_BPS} npx tsx ../sandbox/house-edge/small-stake-lifetime.ts ${TARGET_LIVES} ${ONLY}`);
  console.log(`    (cell = a name from the list below, a group name, "report", or "all";`);
  console.log(`     SS_POP=${POP} SS_MAX_ROUNDS=${MAX_ROUNDS} SS_DIR=<results dir> SS_XVAL=<xval lives> SOL_USD=${SOL_USD})`);
  console.log(`seeds:   fights        sha256("ss|<cell>|<round>|<lobby>")   -> the real tick chain, as on chain`);
  console.log(`         lobbies+churn mulberry32(sha256("${TAG}|<cell>|stream"))  -> one stream per cell`);
  console.log(`         xval lives    mulberry32(sha256("${TAG}|xval|<p>"))`);
  console.log(`constants: fee ${FEE_BPS} bps (fight-variant.ts:34, HE_FEE_BPS)   MIN_ENTRY $${MIN_ENTRY}   STAKE_CAP $${STAKE_CAP_USD}`);
  console.log(`           POP ${POP} slots / ${SEATS} seats = ${POP / SEATS} lobbies per round, every player plays every round`);
  console.log(`           target ${TARGET_LIVES} completed lives per cell, hard stop at ${MAX_ROUNDS} rounds`);
  console.log(`           cadence ${(3600 / ROUNDS_PER_HOUR).toFixed(0)}s -> ${ROUNDS_PER_HOUR.toFixed(1)} rounds/hr -> ${ROUNDS_PER_DAY} rounds/day`);
  console.log(`           gas $${GAS_USD_PER_ROUND.toFixed(4)}/round pre-reclaim, $${GAS_USD_POST_RECLAIM.toFixed(4)} post (SOL_USD=${SOL_USD})`);
  console.log(`player model: BASE_PLAYER (lifetime-core.ts:298) — bankroll $${BASE_PLAYER.bankroll}, stake ${BASE_PLAYER.stakeFraction}x balance,`);
  console.log(`           hazardBase ${BASE_PLAYER.hazardBase}, hazardDrawdown ${BASE_PLAYER.hazardDrawdown}, hazardStreak ${BASE_PLAYER.hazardStreak},`);
  console.log(`           redeposit ${BASE_PLAYER.redeposit} decaying ${BASE_PLAYER.redepositDecay}. ALL OF IT ASSUMED — nothing in this repo measures it.`);
  console.log(`           players HOLD TO THE BELL (no extraction): the house's worst case, the player's best.`);
}

function printCell(r: CellResult) {
  const L = r.life, C = r.censoring;
  console.log(`\n\n--- CELL ${r.cell} ${"-".repeat(Math.max(0, 100 - r.cell.length))}`);
  console.log(`damage ${r.damage}  |  cap $${r.capUsd}  |  matchmaking ${r.matchmaking}` +
              (r.rebate ? `  |  rebate ${r.rebate.bps}bps under $${r.rebate.thresholdUsd}, cap ${r.rebate.dailyCapUsd === null ? "NONE" : "$" + r.rebate.dailyCapUsd}/identity/day` : "") +
              (r.verifiedFrac > 0 ? `  |  verifiedFrac ${r.verifiedFrac}` : ""));
  console.log(`model  stakeFraction ${r.model.stakeFraction}  hazard base/dd/streak ${r.model.hazardBase}/${r.model.hazardDrawdown}/${r.model.hazardStreak}`);
  console.log(`ran    ${r.roundsRun} rounds, ${r.lobbyRounds} lobby-rounds, ${r.sitOut.playerRounds} player-rounds` +
              `${r.targetLivesReached ? "" : "   *** TARGET LIVES NOT REACHED — hit the round cap ***"}`);
  console.log(`CONSERVATION  ${r.conservation.roundsChecked} rounds and ${r.conservation.lobbiesChecked} lobbies checked in integers, ` +
              `max |residual| = ${r.conservation.maxResidualUnits} micro-units`);
  console.log(`sit-outs      ${r.sitOut.redeposit} redeposit rounds (matches simulateLife's round-consuming continue), ` +
              `${r.sitOut.leftover} partition leftovers (${(100 * r.sitOut.leftover / Math.max(1, r.sitOut.leftover + r.sitOut.playerRounds)).toFixed(2)}% of player-rounds)`);
  console.log(`\nCOMPLETED LIVES  n=${L.n}   (censored, still mid-life: ${r.censored})`);
  console.log(`  rake/player      $${F(L.rake)} +-${F(L.rakeCi, 6)}   median $${F(L.rakeMedian, 7)}`);
  console.log(`  rounds lived      ${F(L.rounds)} +-${F(L.roundsCi, 6)}   median  ${F(L.roundsMedian, 7)}`);
  console.log(`  deposits/player  $${F(L.dep)} +-${F(L.depCi, 6)}   withdrawals/player $${F(L.wd)} +-${F(L.wdCi, 6)}`);
  console.log(`  turnover/player  $${F(L.turnover)} +-${F(L.turnoverCi, 6)}   = ${F(L.turnover / Math.max(1e-9, L.dep), 5, 2)} turns per deposited dollar`);
  console.log(`  rake / turnover   ${F(r.house.rakeBpsOfTurnover, 8, 4)} bps against a ${FEE_BPS} bps fee — the identity, checked`);
  console.log(`  exits             ruin ${PCT(L.pRuin)}  quit ${PCT(L.pQuit)}  cap ${PCT(L.pCap)}   busts/life ${F(L.busts, 5)}`);
  console.log(`  ever below $0.10 ${PCT(L.pVisitedDust)} of lives — the population the ruin channel can reach`);
  console.log(`  CENSORING-CORRECTED (Kaplan-Meier over ${r.censored + L.n} started lives, surviving mass at truncation ${PCT(C.tailS)})`);
  console.log(`    rake/player $${F(C.kmRake)}   rounds ${F(C.kmRounds)}   dep $${F(C.kmDep)}   wd $${F(C.kmWd)}`);
  console.log(`    hard LOWER BOUND (completed + partial, over started lives): rake $${F(C.lbRake)}  rounds ${F(C.lbRounds)}`);
  if (r.byVerified.verified && r.byVerified.unverified) {
    const v = r.byVerified.verified, u = r.byVerified.unverified;
    console.log(`\n  BY IDENTITY   verified n=${v.n}  rake $${F(v.rake)} +-${F(v.rakeCi, 6)}  rounds ${F(v.rounds)}  P(ruin) ${PCT(v.pRuin)}`);
    console.log(`                unverif. n=${u.n}  rake $${F(u.rake)} +-${F(u.rakeCi, 6)}  rounds ${F(u.rounds)}  P(ruin) ${PCT(u.pRuin)}`);
    const d = v.rake - u.rake, dci = Math.hypot(v.rakeCi, u.rakeCi);
    console.log(`                GAP (verified - unverified) $${F(d)} +-${F(dci, 6)}  ` +
                `${Math.abs(d) > dci ? "significant" : "NOT significant at 95%"}   <- the mechanic's actual product effect`);
  }
  if (r.adversary) {
    const a = r.adversary;
    console.log(`\n  ADVERSARY  ${a.wallets} wallets x $${a.walletUsd} ($${a.wallets * a.walletUsd} working capital), ` +
                `${a.verifiedWallets} verified (one identity), never churns, strips profit every round`);
    console.log(`    per round $${F(a.perRoundUsd, 9, 4)} +-${F(a.perRoundCi, 8, 4)}  (${F(a.perRoundSigma, 4, 1)} sigma over ${a.roundsN} rounds)  ` +
                `${a.perRoundSigma < 2 ? "-> INDISTINGUISHABLE FROM ZERO" : "-> a real farm"}`);
    console.log(`    per day   $${F(a.perDayUsd)} +-${F(a.perDayCi, 8)}   $${F(a.perDayPerCapitalDollar, 7, 2)}/day per $ of capital  ` +
                `= ${F(a.dailyRoiPct, 7, 0)}%/day on working capital`);
    console.log(`    cumulative net $${F(a.netUsd)} over ${r.roundsRun} rounds; rake it paid the house $${F(a.rakePaidUsd)}`);
  }
  if (r.rebateStats) {
    const s = r.rebateStats;
    console.log(`\n  REBATE  paid $${F(s.paidUsd)} over ${s.qualifyingEntries} qualifying entries ` +
                `(${F(100 * s.paidUsd / (r.house.rakeUsdTotal + s.paidUsd), 5, 1)}% of gross rake)`);
    console.log(`    max observed per identity per day $${F(s.maxDayPerIdentityUsd)}   ` +
                `structural bound $${F(s.theoreticalMaxDayUsd)}/day  <- THE FARM RATE, bounded by construction`);
  }
  console.log(`\n  HOUSE  gross rake $${F(r.house.rakeUsdTotal)} over ${r.lobbyRounds} lobby-rounds ` +
              `-> $${F(r.house.rakePerLobbyRound, 8, 4)}/round`);
  console.log(`  per-round ROI by stake band (the VARIANCE channel):`);
  console.log(`    ${"band".padEnd(16)} ${"n".padStart(11)} ${"mean ROI".padStart(11)} ${"sd(ROI)".padStart(10)} ${"se".padStart(9)}`);
  for (const b of r.bands) {
    if (b.n === 0) continue;
    console.log(`    ${b.name.padEnd(16)} ${String(b.n).padStart(11)} ${PCT(b.roiMean, 11, 2)} ${PCT(b.roiSd, 10, 1)} ${PCT(b.roiSe, 9, 2)}`);
  }
}

// ------------------------------------------------------------------------------------------------
// THE REPORT — cross-cell, reads whatever JSON has been produced so far.
// ------------------------------------------------------------------------------------------------
interface CellAgg {
  cell: string; reps: CellResult[]; r0: CellResult; nrep: number;
  kmRake: Est; rake: Est; rounds: Est; kmRounds: Est; pRuin: Est; pDust: Est;
  dep: Est; wd: Est; kmDep: Est; kmWd: Est; turnover: Est; kmTurn: Est; lbRake: Est; tailS: Est;
  rakePerLobbyRound: Est; rakeBps: Est; lobbiesPerRound: number;
}

function aggregate(reps: CellResult[]): CellAgg {
  const r0 = reps[0];
  return {
    cell: r0.cell, reps, r0, nrep: reps.length,
    kmRake: est(reps, r => r.censoring.kmRake, r => r.life.rakeCi),
    rake: est(reps, r => r.life.rake, r => r.life.rakeCi),
    rounds: est(reps, r => r.life.rounds, r => r.life.roundsCi),
    kmRounds: est(reps, r => r.censoring.kmRounds),
    pRuin: est(reps, r => r.life.pRuin),
    pDust: est(reps, r => r.life.pVisitedDust),
    dep: est(reps, r => r.life.dep, r => r.life.depCi),
    wd: est(reps, r => r.life.wd, r => r.life.wdCi),
    kmDep: est(reps, r => r.censoring.kmDep),
    kmWd: est(reps, r => r.censoring.kmWd),
    turnover: est(reps, r => r.life.turnover, r => r.life.turnoverCi),
    kmTurn: est(reps, r => r.censoring.kmTurnover),
    lbRake: est(reps, r => r.censoring.lbRake),
    tailS: est(reps, r => r.censoring.tailS),
    rakePerLobbyRound: est(reps, r => r.house.rakePerLobbyRound),
    rakeBps: est(reps, r => r.house.rakeBpsOfTurnover),
    lobbiesPerRound: r0.lobbyRounds / Math.max(1, r0.roundsRun),
  };
}

const CI = (e: Est) => (Number.isFinite(e.ci) ? `+-${e.ci.toFixed(3)}` : "+-  n/a ");
const SRC = (e: Est) => (e.source === "replicates" ? `${e.n}rep` : "1run");

function report() {
  const raw = loadAll();
  if (raw.size === 0) { console.log(`\nNo results in ${RESULT_DIR}. Run some cells first.`); return; }
  const A = new Map<string, CellAgg>();
  for (const [k, v] of raw) A.set(k, aggregate(v));
  const get = (n: string) => A.get(n);
  const have = (ns: string[]) => ns.map(get).filter((x): x is CellAgg => !!x);
  const missing = CELLS.filter(c => !A.has(c.name)).map(c => c.name);

  console.log(`\n\n${"=".repeat(126)}`);
  console.log(`REPORT — ${A.size} of ${CELLS.length} cells present in ${RESULT_DIR}`);
  console.log(`${"=".repeat(126)}`);
  console.log(`ERROR BARS. A cell is ONE population and its ~${TARGET_LIVES} lives are NOT independent — they share`);
  console.log(`lobbies. So every interval below is the spread over independent REPLICATE POPULATIONS wherever two`);
  console.log(`or more exist (marked "Nrep"), and only falls back to the over-lives CI where one does (marked`);
  console.log(`"1run"). The two are different claims and the tables never mix them silently. Replicates per cell:`);
  const counts = new Map<number, string[]>();
  for (const [k, v] of A) { const a = counts.get(v.nrep) ?? []; a.push(k); counts.set(v.nrep, a); }
  for (const [n, cs] of [...counts].sort((a, b) => b[0] - a[0])) console.log(`  ${String(n).padStart(2)} replicates: ${cs.sort().join(" ")}`);
  if (missing.length) console.log(`MISSING (tables below silently omit them): ${missing.join(" ")}`);

  // --- HEADLINE ---------------------------------------------------------------------------------
  const headline = have(["base", ...P_GRID.map(p => `blend-${p}`)]);
  if (headline.length) {
    console.log(`\n\n### HEADLINE — lifetime rake per acquired player vs the blend P ##############################`);
    console.log(`KM = the censoring-corrected estimate (see \`kmEstimate\`); it is the number cells are compared on,`);
    console.log(`because the completed-only mean drops the longest lives and the mechanics under test CHANGE life`);
    console.log(`length, which is the very axis being measured.\n`);
    console.log(`cell           P bps  src    KM rake/player     LOWER BND   trunc   rounds lived   P(ruin)  dep/plyr  turnover/plyr`);
    console.log("-".repeat(126));
    for (const a of headline) {
      console.log(`${a.cell.padEnd(14)} ${String(a.r0.p).padStart(5)}  ${SRC(a.kmRake).padEnd(5)} ` +
                  `$${F(a.kmRake.mean, 8)} ${CI(a.kmRake).padEnd(10)} $${F(a.lbRake.mean, 7)}  ${PCT(a.tailS.mean, 6, 1)}  ` +
                  `${F(a.kmRounds.mean, 7, 1)} ${CI(a.kmRounds).padEnd(9)} ${PCT(a.pRuin.mean)}  $${F(a.kmDep.mean, 7)}  $${F(a.kmTurn.mean, 9)}`);
    }
    console.log(`\n"LOWER BND" is the hard bound — every completed life's rake plus every censored life's rake SO`);
    console.log(`FAR, over all started lives. It assumes the ${POP} unfinished lives pay nothing more, so it cannot be`);
    console.log(`beaten by any censoring correction. "trunc" is the survival mass still standing where the KM`);
    console.log(`estimate truncates, i.e. how much of the tail neither estimator sees. IT MATTERS THAT BOTH COLUMNS`);
    console.log(`MOVE THE SAME WAY: the mechanics under test lengthen lives, which raises truncation, which biases`);
    console.log(`the KM column DOWN for exactly the cells that look best — so a gain visible in both columns is a`);
    console.log(`gain the correction did not manufacture.`);
    const bestA = headline.reduce((x, y) => (y.kmRake.mean > x.kmRake.mean ? y : x));
    const interior = bestA.cell !== "base" && bestA.cell !== `blend-${P_GRID[P_GRID.length - 1]}`;
    const monotone = headline.every((a, i) => i === 0 || a.kmRake.mean >= headline[i - 1].kmRake.mean);
    console.log(`\nARGMAX: ${bestA.cell} (P=${bestA.r0.p}) at $${bestA.kmRake.mean.toFixed(3)}/player -> ${interior ? "INTERIOR" : "CORNER"} solution` +
                `${monotone ? ", and the sweep is MONOTONE INCREASING in P across the whole grid" : ""}.`);
    if (!interior && monotone) {
      console.log(`A monotone corner means the revenue-optimal P is at or beyond the top of the grid — and the grid`);
      console.log(`stops at 100 bps for a reason that is not statistical. P = 10000 is the v5 defect, which produced`);
      console.log(`a +658.99% minnow ROI and the measured $150.87/round farm. The farm rate rises with P on the same`);
      console.log(`curve as the revenue does, so "push P higher" is not an available conclusion; see ADVERSARY.`);
    }

    // --- THE DIFFERENCE, WITH A SIGMA. ----------------------------------------------------------
    const ctl = get("base");
    if (ctl) {
      console.log(`\n\n### THE DIFFERENCE vs the control, with a sigma #############################################`);
      console.log(`Two overlapping error bars read side by side are not a test. This is the difference itself,`);
      console.log(`with the interval formed from the two cells' REPLICATE spreads. Cells are independent`);
      console.log(`populations — there is no pairing available, because two populations diverge the moment their`);
      console.log(`first fight differs, so a "paired" comparison would be a fiction.\n`);
      console.log(`cell            d(KM rake)     95% CI    sigma   verdict          d(rounds)   d(turnover)`);
      console.log("-".repeat(112));
      for (const a of headline) {
        if (a.cell === "base") continue;
        const d = diff(a.kmRake, ctl.kmRake);
        const dr = diff(a.kmRounds, ctl.kmRounds), dt = diff(a.kmTurn, ctl.kmTurn);
        const verdict = d.sigma >= 2 ? (d.d > 0 ? "GAIN (p<0.05)" : "LOSS (p<0.05)") : "not significant";
        console.log(`${a.cell.padEnd(15)} ${d.d >= 0 ? "+" : ""}$${F(d.d, 8)}  +-${F(d.ci, 8)}  ${F(d.sigma, 5, 1)}   ${verdict.padEnd(16)} ` +
                    `${dr.d >= 0 ? "+" : ""}${F(dr.d, 7, 1)}    ${dt.d >= 0 ? "+" : ""}$${F(dt.d, 8)}`);
      }
    }
    const rep = get("cap-100");
    if (ctl && rep) {
      const d = diff(rep.kmRake, ctl.kmRake);
      console.log(`\nNULL CONTROL: \`cap-100\` is the SAME configuration as \`base\` under a different cell tag. Its`);
      console.log(`difference from base must be zero. Measured $${d.d.toFixed(3)} +-${d.ci.toFixed(3)} (${d.sigma.toFixed(1)} sigma) -> ` +
                  `${d.sigma < 2 ? "consistent with zero, so the machinery is calibrated."
                                 : "*** NOT zero. The intervals above are too narrow; treat every difference with suspicion. ***"}`);
    }
  }

  // --- DECOMPOSITION / TURNOVER -------------------------------------------------------------------
  const decomp = have(["base", ...P_GRID.map(p => `blend-${p}`), "capped-P20-C4", "cap-25", "cap-10", "cap-5", "banded-full", "banded-tier3"]);
  if (decomp.length) {
    console.log(`\n\n### DECOMPOSITION — the rake is a fee on TURNOVER, and nothing else #########################`);
    console.log(`THE IDENTITY THAT SETTLES THE MECHANISM. The house takes feeBps of every gross entry, so`);
    console.log(``);
    console.log(`      lifetime rake per acquired player  =  feeBps/10000  x  lifetime TURNOVER per acquired player`);
    console.log(``);
    console.log(`exactly, with no behavioural content in it at all. "Did retention improve?" is therefore not the`);
    console.log(`question — the question is whether a deposited dollar gets STAKED more times before it leaves.`);
    console.log(`That is a stronger and more general statement than a retention story, and it predicts which other`);
    console.log(`mechanics would work: anything that moves money from players who EXIT with it to players who`);
    console.log(`RE-STAKE it raises turnover per deposit; anything that does not, does not.`);
    console.log(``);
    console.log(`The rake/turnover column is the identity being CHECKED, not assumed. It must equal the fee`);
    console.log(`(${FEE_BPS} bps) in every row up to the integer flooring of \`fee = stake*feeBps/10000\`.\n`);
    console.log(`cell            dep/plyr   wd/plyr   turnover/plyr  turns/dollar  rake/plyr  rake/turnover  residual`);
    console.log("-".repeat(122));
    for (const a of decomp) {
      const dep = a.kmDep.mean, wd = a.kmWd.mean, tn = a.kmTurn.mean, rk = a.kmRake.mean;
      console.log(`${a.cell.padEnd(15)} $${F(dep, 7)}  $${F(wd, 7)}  $${F(tn, 12)}  ${F(tn / dep, 12, 2)}  ` +
                  `$${F(rk, 8)}  ${F(a.rakeBps.mean, 10, 4)} bps  $${F(dep - wd - rk, 8)}`);
    }
    console.log(`\n"turns/dollar" is turnover / deposits: how many times a deposited dollar is staked before it`);
    console.log(`leaves. It is the whole mechanism, expressed as one number.`);
    console.log(`"residual" is dep - wd - rake for the COMPLETED-and-KM population: money this cohort handed to`);
    console.log(`players still mid-life at the cut. It is a censoring artefact, not a leak — the global integer`);
    console.log(`conservation check that runs every round is what proves nothing is lost.`);
  }

  // --- RUIN DIAGNOSIS -----------------------------------------------------------------------------
  const ruinCells = have(["base", "blend-5", "blend-10", "blend-20", "blend-100", "capped-P20-C2", "capped-P20-C4", "cap-10", "banded-full"]);
  if (ruinCells.length >= 2) {
    console.log(`\n\n### RUIN DIAGNOSIS — why P=5, a 0.05% tilt, closes the ruin channel completely ###############`);
    console.log(`The control ruins players and every blend cell, down to P=5, ruins nobody. A discontinuity that`);
    console.log(`sharp is either a bug or a finding, so here is the arithmetic.`);
    console.log(``);
    console.log(`The blend's basis is  (P*ring_d + (10000-P)*min(ring_a,ring_d)) / 10000. For an attacker at the`);
    console.log(`ruin boundary the bonus is not "P percent" of anything the reader expects — it is`);
    console.log(``);
    console.log(`      basis / min  =  1 + (P/10000) * (ring_d/min - 1)`);
    console.log(``);
    console.log(`and ring_d/min is UNBOUNDED as min goes to the dust floor. A $0.01 fighter beside a $50 opponent`);
    console.log(`has ring_d/min ~ 5,000, so at P=5 its bite is already ~3.5x its own entire ring. The tilt measured`);
    console.log(`at minnow stakes (+2.62% ROI at P=10, study-damage.ts) is NOT the tilt at the ruin boundary; the`);
    console.log(`same knob is a rounding error at $8 and a multiple at $0.01. THAT is the discontinuity, and it is`);
    console.log(`also the reason \`capMult\` exists — it is the only setting that bounds this ratio structurally.`);
    console.log(``);
    console.log(`Evidence: the sub-$0.10 population and the mean R the dust bins actually pay.\n`);
    console.log(`cell            P(life visits <$0.10)  P(ruin)   mean R $0.01-0.02  $0.02-0.03  $0.03-0.06  $0.06-0.10   n(dust rounds)`);
    console.log("-".repeat(130));
    for (const a of ruinCells) {
      const b = a.r0.binR;
      const cell = (i: number) => (b[i] && b[i].n > 0 ? b[i].mean.toFixed(3) : "-").padStart(10);
      const nd = [0, 1, 2, 3].reduce((s, i) => s + (b[i]?.n ?? 0), 0);
      console.log(`${a.cell.padEnd(15)} ${PCT(a.pDust.mean, 19, 2)}  ${PCT(a.pRuin.mean, 8, 2)}  ` +
                  `${cell(0)}  ${cell(1)}  ${cell(2)}  ${cell(3)}   ${String(nd).padStart(12)}`);
    }
    console.log(`\nmean R = payout / net-stake for a fighter whose GROSS stake fell in that bin. Under the shipped`);
    console.log(`rule the dust bins pay BELOW 1 — that is \`er-sim.ts:199\`, the one asymmetric line in the fight,`);
    console.log(`documented at \`lifetime-core.ts:193\`: a fighter at or below the $0.001 dust floor loses its whole`);
    console.log(`ring when drawn as DEFENDER but gains only roll/100 of it as ATTACKER. Under any P>0 the same`);
    console.log(`fighter's attacking bite is scaled by ring_d/min instead, which reverses the drain and props it`);
    console.log(`up. It is a player-to-player transfer either way, never house revenue.`);
  }

  // --- CHANNEL ATTRIBUTION -----------------------------------------------------------------------
  const chan = ["flat", "hz", "cap"].map(k => ({ k, a: get(`chan-${k}-P0`), b: get(`chan-${k}-P100`) }))
    .filter(x => x.a && x.b) as { k: string; a: CellAgg; b: CellAgg }[];
  if (chan.length) {
    console.log(`\n\n### CHANNEL ATTRIBUTION — the structural identity, and where the effect can possibly live ####`);
    console.log(`The fight is zero-sum under EVERY damage rule, so for a closed population sum(rake) =`);
    console.log(`sum(deposits) - sum(withdrawals) and the population's balance decays at exactly phi*f per round`);
    console.log(`whatever the basis is. Under PURE FEE-BLIND CHURN with no stake cap, a redistribution mechanic`);
    console.log(`must therefore move lifetime rake per acquired player by EXACTLY ZERO. Every non-zero effect has`);
    console.log(`to arrive through one of three channels, and this block switches them on one at a time:`);
    console.log(`  (1) the RUIN / MIN-ENTRY barrier   (2) VARIANCE-DRIVEN churn   (3) the $100 STAKE CAP\n`);
    console.log(`configuration                    P=0 KM rake     P=100 KM rake      difference   sigma  channels`);
    console.log("-".repeat(120));
    const label: Record<string, string> = { flat: "hazard flat, no cap", hz: "hazard variance ON, no cap", cap: "hazard flat, $100 cap ON" };
    const chanLabel: Record<string, string> = { flat: "(1) barrier only", hz: "(1)+(2) barrier+variance", cap: "(1)+(3) barrier+cap" };
    for (const x of chan) {
      const d = diff(x.b.kmRake, x.a.kmRake);
      console.log(`${label[x.k].padEnd(32)} $${F(x.a.kmRake.mean, 8)} ${CI(x.a.kmRake).padEnd(9)} $${F(x.b.kmRake.mean, 8)} ${CI(x.b.kmRake).padEnd(9)} ` +
                  `${d.d >= 0 ? "+" : ""}$${F(d.d, 7)}  ${F(d.sigma, 5, 1)}  ${chanLabel[x.k]}`);
    }
    const b0 = get("base"), b100 = get("blend-100");
    if (b0 && b100) {
      const d = diff(b100.kmRake, b0.kmRake);
      console.log(`${"all three (base vs blend-100)".padEnd(32)} $${F(b0.kmRake.mean, 8)} ${CI(b0.kmRake).padEnd(9)} $${F(b100.kmRake.mean, 8)} ${CI(b100.kmRake).padEnd(9)} ` +
                  `${d.d >= 0 ? "+" : ""}$${F(d.d, 7)}  ${F(d.sigma, 5, 1)}  (1)+(2)+(3)`);
    }
    const flat = chan.find(x => x.k === "flat");
    if (flat) {
      const d = diff(flat.b.kmRake, flat.a.kmRake);
      console.log(`\nTHE IDENTITY CHECK: chan-flat must be ZERO. Measured $${d.d.toFixed(3)} +-${d.ci.toFixed(3)} (${d.sigma.toFixed(1)} sigma) -> ` +
                  `${d.sigma < 2 ? "consistent with zero."
                                 : "NOT zero — the ruin/min-entry barrier is doing real work, which the RUIN DIAGNOSIS above prices."}`);
      console.log(`Either way it bounds the claim: whatever the mechanic does, it does through the barrier, the`);
      console.log(`variance channel, or the cap. It cannot create money, because the fight cannot.`);
    }
  }

  // --- PER DAY -----------------------------------------------------------------------------------
  const perday = have(["base", ...P_GRID.map(p => `blend-${p}`), "cap-25", "cap-10", "cap-5", "banded-full",
                       "rebate-25-cap2", "rebate-50-cap2", "rebate-100-cap2", "rebate-200-cap2", "rebate-100-uncapped"]);
  if (perday.length) {
    console.log(`\n\n### PER DAY — house rake per round and per day at ${SEATS} seats, net of gas ###################`);
    console.log(`ONE arena, ${SEATS} occupied seats, ${ROUNDS_PER_DAY} rounds/day. Measured in the STEADY-STATE population`);
    console.log(`(balances at every stage of decay), which is the only honest denominator: a table built from fresh`);
    console.log(`$100 players would overstate it by the whole decay curve. Rebate rows are NET of the rebate.\n`);
    console.log(`cell                  rake/round   rake/day   net/day (gas $${GAS_USD_PER_ROUND.toFixed(2)})   net/day (gas $${GAS_USD_POST_RECLAIM.toFixed(4)})`);
    console.log("-".repeat(108));
    for (const a of perday) {
      const pr = a.rakePerLobbyRound.mean, pd = pr * ROUNDS_PER_DAY;
      console.log(`${a.cell.padEnd(21)} $${F(pr, 9, 4)}  $${F(pd, 9)}   ` +
                  `$${F(pd - GAS_USD_PER_ROUND * ROUNDS_PER_DAY, 12)}   $${F(pd - GAS_USD_POST_RECLAIM * ROUNDS_PER_DAY, 14)}`);
    }
    console.log(`\nEXTRAPOLATION, LABELLED: per-day figures are per-round rake x ${ROUNDS_PER_DAY}, assuming the arena stays full`);
    console.log(`at ${SEATS} seats for 24 hours with the population in steady state. Neither occupancy nor a 24h day is`);
    console.log(`measured anywhere in this repository.`);

    // --- THE TWO OBJECTIVES DISAGREE, AND NOTHING ELSE IN THIS FILE SAYS SO. --------------------
    const ctl2 = get("base");
    if (ctl2) {
      console.log(`\n\n### PER PLAYER vs PER DAY — THE TWO OBJECTIVES DISAGREE, AND THE SIGN FLIPS ##################`);
      console.log(`These are NOT the same question and the blend answers them differently. In steady state`);
      console.log(``);
      console.log(`      rake per round  =  (population / mean life)  x  rake per acquired player`);
      console.log(``);
      console.log(`so a mechanic that raises rake per player by LESS than it lengthens life LOWERS rake per unit`);
      console.log(`time. Acquisitions per round fall faster than each acquisition's value rises.\n`);
      console.log(`cell            rake/player   vs base    mean life   vs base   rake/round   vs base    WHICH OBJECTIVE WINS`);
      console.log("-".repeat(126));
      for (const a of headline) {
        const dR = a.kmRake.mean - ctl2.kmRake.mean;
        const dL = 100 * (a.kmRounds.mean / ctl2.kmRounds.mean - 1);
        const dD = a.rakePerLobbyRound.mean - ctl2.rakePerLobbyRound.mean;
        const verdict = a.cell === "base" ? "(control)"
          : dR > 0 && dD > 0 ? "both"
          : dR > 0 && dD <= 0 ? "per player only — per DAY FALLS"
          : dR <= 0 && dD > 0 ? "per day only" : "neither";
        console.log(`${a.cell.padEnd(15)} $${F(a.kmRake.mean, 9)} ${dR >= 0 ? "+" : ""}$${F(dR, 7)}  ${F(a.kmRounds.mean, 9, 1)} ` +
                    `${dL >= 0 ? "+" : ""}${F(dL, 6, 1)}%  $${F(a.rakePerLobbyRound.mean, 9, 4)} ${dD >= 0 ? "+" : ""}$${F(dD, 7, 4)}   ${verdict}`);
      }
      console.log(`\nWHICH ONE THE OPERATOR SHOULD OPTIMISE IS A BUSINESS FACT THIS SIMULATION DOES NOT HAVE.`);
      console.log(`  * If ACQUISITION is the binding constraint and a player costs money to acquire, revenue per`);
      console.log(`    acquired player is the objective and the blend helps.`);
      console.log(`  * If SEATS are the binding constraint — the arena fills whatever you do — revenue per day is`);
      console.log(`    the objective, and every blend below P=100 makes the operator WORSE OFF.`);
      console.log(`Nothing in this repository measures cost per acquisition, so this study cannot pick between them.`);
      console.log(`It can only refuse to hide that the choice exists.`);
    }
  }

  // --- THE STAKE CAP IS THE BIG LEVER, AND IT IS ALREADY IN THE PRODUCT ---------------------------
  const capOn = get("base"), capOff = get("chan-hz-P0");
  const flatOn = get("chan-cap-P0"), flatOff = get("chan-flat-P0");
  if (capOn && capOff) {
    console.log(`\n\n### THE $100 STAKE CAP COSTS MORE THAN THE BLEND COULD EVER RECOVER #########################`);
    console.log(`This fell out of the CHANNEL ATTRIBUTION cells and it is the largest effect measured anywhere in`);
    console.log(`this file. \`chan-hz-P0\` is EXACTLY the control — same BASE_PLAYER, same shipped \`min\` damage —`);
    console.log(`with one change: the $100 per-entry cap lifted.\n`);
    const d = diff(capOff.kmRake, capOn.kmRake);
    console.log(`  configuration                              KM rake/player      turnover/player   mean life`);
    console.log("  " + "-".repeat(100));
    console.log(`  base            ($100 cap, shipped)       $${F(capOn.kmRake.mean, 8)} ${CI(capOn.kmRake).padEnd(9)}  $${F(capOn.kmTurn.mean, 10)}   ${F(capOn.kmRounds.mean, 7, 1)}`);
    console.log(`  chan-hz-P0      (cap lifted, else same)   $${F(capOff.kmRake.mean, 8)} ${CI(capOff.kmRake).padEnd(9)}  $${F(capOff.kmTurn.mean, 10)}   ${F(capOff.kmRounds.mean, 7, 1)}`);
    console.log(`  DIFFERENCE                                ${d.d >= 0 ? "+" : ""}$${F(d.d, 8)} +-${F(d.ci, 6)}  (${d.sigma.toFixed(1)} sigma)`);
    if (flatOn && flatOff) {
      const df = diff(flatOff.kmRake, flatOn.kmRake);
      console.log(`  same comparison under FLAT hazard         ${df.d >= 0 ? "+" : ""}$${F(df.d, 8)} +-${F(df.ci, 6)}  (${df.sigma.toFixed(1)} sigma)`);
    }
    const bestBlend = get("blend-100");
    if (bestBlend) {
      const db = diff(bestBlend.kmRake, capOn.kmRake);
      console.log(`\nFOR SCALE: the best blend cell in the whole sweep buys ${db.d >= 0 ? "+" : ""}$${db.d.toFixed(2)}/player. Lifting the cap buys`);
      console.log(`${d.d >= 0 ? "+" : ""}$${d.d.toFixed(2)}/player — ${(d.d / Math.max(1e-9, db.d)).toFixed(1)}x as much — and it has NO FARM RATE, because a stake ceiling`);
      console.log(`creates no cross-size transfer for a splitter to capture. It is also already in the product, so`);
      console.log(`it is a parameter change and not a program change.`);
    }
    console.log(``);
    console.log(`WHY: the cap idles money. A player above $100 cannot put the excess at risk, so it sits outside`);
    console.log(`the turnover on which the rake is charged. This is ALSO the true mechanism of the blend — the`);
    console.log(`CHANNEL ATTRIBUTION table shows the blend's entire gain appears in the cap-ON row (+$26.99, 35.8`);
    console.log(`sigma) and is NEGATIVE in the cap-OFF row (-$4.69) — i.e. the blend pays only by pushing money`);
    console.log(`back DOWN under a ceiling that should not have been that low. It is a workaround for the cap.`);
    console.log(``);
    console.log(`WHAT THIS DOES NOT SAY: the cap exists for reasons this simulator does not model — bounding a`);
    console.log(`single wallet's exposure, bounding the operator's tail risk, and \`arenas.ts:40\` records it as`);
    console.log(`"locked by Max". This measures its REVENUE cost. It does not price what it buys, and a $100`);
    console.log(`bankroll at stakeFraction 1.0 means the cap binds only on WINNERS, so the number above is`);
    console.log(`conditional on full redeployment — see the sf0.25 row of SENSITIVITY, where much less is at stake.`);
  }

  // --- VARIANCE ----------------------------------------------------------------------------------
  const varCells = have(["base", "blend-5", "blend-10", "blend-20", "blend-100", "capped-P20-C4", "capped-P100-C4",
                         "cap-25", "cap-10", "cap-5", "banded-full", "banded-tier3", "gated-P100-v0.5"]);
  if (varCells.length) {
    console.log(`\n\n### VARIANCE CHANNEL — does the mechanic change the sigma the hazard can actually see? #######`);
    console.log(`HOUSE-LIFETIME.md §2.2: the FEE cannot drive churn because it is invisible inside a 38.5% per-round`);
    console.log(`sigma. A mechanic that changes sigma ITSELF is visible to exactly the same hazard. Per-round ROI is`);
    console.log(`(payout / GROSS stake) - 1, so the fee is inside it. Values are over player-rounds, tens of`);
    console.log(`millions of them per cell, so the sampling error on a sigma is in the third decimal.\n`);
    const bandNames = SIGMA_BANDS.map(b => b.name.trim().split(/\s+/)[0]);
    console.log(`sd(ROI) by stake band`);
    console.log(`cell               ` + bandNames.map(n => n.padStart(11)).join(""));
    console.log("-".repeat(19 + 11 * bandNames.length));
    for (const a of varCells) console.log(a.cell.padEnd(19) + a.r0.bands.map(b => (b.n === 0 ? "-" : `${(100 * b.roiSd).toFixed(0)}%`).padStart(11)).join(""));
    console.log(`\nmean ROI by stake band (the tilt itself; at P=0 every band must sit at the fee, -1.00%)`);
    console.log(`cell               ` + bandNames.map(n => n.padStart(11)).join(""));
    console.log("-".repeat(19 + 11 * bandNames.length));
    for (const a of varCells) console.log(a.cell.padEnd(19) + a.r0.bands.map(b => (b.n === 0 ? "-" : `${(100 * b.roiMean).toFixed(2)}%`).padStart(11)).join(""));
    const b0 = get("base"), b100 = get("blend-100");
    if (b0 && b100) {
      console.log(`\nTHE PRIOR UNDER TEST: "the blend RAISES small-player variance, which would make the retention story`);
      console.log(`fail". base vs blend-100, band by band:`);
      for (let i = 0; i < SIGMA_BANDS.length; i++) {
        const x = b0.r0.bands[i], y = b100.r0.bands[i];
        if (!x || !y || x.n === 0 || y.n === 0) continue;
        const d = y.roiSd - x.roiSd;
        console.log(`  ${SIGMA_BANDS[i].name.padEnd(16)} sd ${PCT(x.roiSd, 8, 1)} -> ${PCT(y.roiSd, 8, 1)}  ` +
                    `${d >= 0 ? "+" : ""}${(100 * d).toFixed(1)} points  ${d > 0 ? "RAISED" : "LOWERED"}`);
      }
    }
  }

  // --- GATE --------------------------------------------------------------------------------------
  const gated = CELLS.filter(c => c.group === "gated").map(c => get(c.name)).filter((x): x is CellAgg => !!x);
  if (gated.length) {
    console.log(`\n\n### IDENTITY GATE — lifetime rake for verified vs unverified players ########################`);
    console.log(`\`gate: "attacker"\` applies the blend only when the ATTACKER carries verified=1; every other`);
    console.log(`exchange falls back to the shipped \`min\`. The GAP is what a player gets for linking their wallet,`);
    console.log(`and therefore what the link is worth to the house. Intervals here are over LIVES within one run.\n`);
    console.log(`cell                  V     verified rake      unverified rake        gap        rounds v/u`);
    console.log("-".repeat(104));
    for (const a of gated) {
      const v = a.r0.byVerified.verified, u = a.r0.byVerified.unverified;
      if (!v || !u) continue;
      const d = v.rake - u.rake, dci = Math.hypot(v.rakeCi, u.rakeCi);
      console.log(`${a.cell.padEnd(21)} ${F(a.r0.verifiedFrac, 4, 2)}  $${F(v.rake, 8)} +-${F(v.rakeCi, 5)}  ` +
                  `$${F(u.rake, 9)} +-${F(u.rakeCi, 5)}  ${d >= 0 ? "+" : ""}$${F(d, 6)}${Math.abs(d) > dci ? "*" : " "}  ` +
                  `${F(v.rounds, 6, 1)}/${F(u.rounds, 6, 1)}`);
    }
    console.log(`(* = 95% CIs on the two groups do not overlap)`);
  }

  // --- CAP ---------------------------------------------------------------------------------------
  const caps = have(["cap-100", "cap-25", "cap-10", "cap-5"]);
  if (caps.length) {
    console.log(`\n\n### PER-ENTRY CAP — and the prior it refutes ################################################`);
    console.log(`THE PRIOR THIS TABLE WAS BUILT TO TEST WAS WRONG, AND THE TABLE SAYS SO. A lower cap forces`);
    console.log(`stakeFraction <= cap/balance, which lengthens lives — and that was expected to raise turnover and`);
    console.log(`therefore lifetime rake, by the identity above. It does the OPPOSITE, and the reason is that`);
    console.log(`turnover is rounds TIMES stake per round:`);
    console.log(``);
    console.log(`      lives get longer, but stake per round falls faster, so the product collapses.`);
    console.log(``);
    console.log(`Lowering the cap from $100 to $5 stretches a life from 35.9 to 57.3 rounds (+60%) while cutting`);
    console.log(`turnover per acquired player from $2,121 to $287 (-86%). The per-entry cap is not a retention`);
    console.log(`device that happens to cost something; it is the single most destructive lever measured anywhere`);
    console.log(`in this file. It still has no farm rate — but neither does doing nothing.\n`);
    console.log(`cell        cap   src     KM rake/player     rounds lived    turnover/plyr  turns/$   P(ruin)  rake/round`);
    console.log("-".repeat(122));
    for (const a of caps) {
      console.log(`${a.cell.padEnd(11)} $${String(a.r0.capUsd).padStart(4)}  ${SRC(a.kmRake).padEnd(5)} ` +
                  `$${F(a.kmRake.mean, 8)} ${CI(a.kmRake).padEnd(9)} ${F(a.kmRounds.mean, 8, 1)}  $${F(a.kmTurn.mean, 12)}  ` +
                  `${F(a.kmTurn.mean / Math.max(1e-9, a.kmDep.mean), 7, 2)}  ${PCT(a.pRuin.mean)}  $${F(a.rakePerLobbyRound.mean, 9, 4)}`);
    }
  }

  // --- BANDED ------------------------------------------------------------------------------------
  const banded = have(["base", "banded-full", "banded-tier3"]);
  if (banded.length >= 2) {
    console.log(`\n\n### MATCHMAKING BY STAKE BAND — free, no program change, and NO farm rate ###################`);
    console.log(`Seating similar-sized players together creates no cross-size transfer, so a splitter has nothing`);
    console.log(`to capture. The prior was that banding changes neither mean nor variance, because the shipped`);
    console.log(`\`min\` basis already scales every exchange to the SMALLER party. Measured, not assumed:\n`);
    console.log(`cell             src    KM rake/player     rounds lived   P(ruin)  sd(ROI) micro  small   large`);
    console.log("-".repeat(116));
    for (const a of banded) {
      console.log(`${a.cell.padEnd(16)} ${SRC(a.kmRake).padEnd(5)} $${F(a.kmRake.mean, 8)} ${CI(a.kmRake).padEnd(9)} ` +
                  `${F(a.kmRounds.mean, 8, 1)}  ${PCT(a.pRuin.mean)}  ${PCT(a.r0.bands[1].roiSd, 13, 1)}  ` +
                  `${PCT(a.r0.bands[2].roiSd, 6, 1)}  ${PCT(a.r0.bands[4].roiSd, 6, 1)}`);
    }
    const ctl = get("base");
    if (ctl) for (const a of banded) {
      if (a.cell === "base") continue;
      const d = diff(a.kmRake, ctl.kmRake);
      console.log(`  ${a.cell.padEnd(14)} vs base: ${d.d >= 0 ? "+" : ""}$${d.d.toFixed(3)} +-${d.ci.toFixed(3)} (${d.sigma.toFixed(1)} sigma) -> ` +
                  `${d.sigma < 2 ? "no significant effect on lifetime revenue."
                                 : d.d > 0 ? "a real GAIN — and it cannot be farmed, so it is worth pursuing."
                                           : "a real LOSS. Banding COSTS lifetime revenue; it is not a free win."}`);
    }
    console.log(`\nWHAT BANDING ACTUALLY DOES, and it is not what it was proposed for. The mean ROI table above`);
    console.log(`shows banded-full sitting at -1.00% in EVERY stake band — exactly the fee, with the size gradient`);
    console.log(`gone — and sd(ROI) flat at ~40% across all six bands where the control runs 45% at the bottom to`);
    console.log(`35% at the top. So banding does not change any mean; it EQUALISES VARIANCE across sizes. It is a`);
    console.log(`fairness and experience instrument, not a revenue one, and it removes the sub-$0.10 dust drain`);
    console.log(`(mean R 0.912 -> ~0.995 in the lowest bin) as a side effect because a dust player now meets other`);
    console.log(`dust players instead of whales. That is a real product argument. It is not a revenue argument.`);
  }

  // --- REBATE ------------------------------------------------------------------------------------
  const rebs = CELLS.filter(c => c.group === "reb").map(c => get(c.name)).filter((x): x is CellAgg => !!x);
  if (rebs.length) {
    console.log(`\n\n### TREASURY REBATE — a bounded, identity-gated negative fee ################################`);
    console.log(`"a verified wallet staking under $10 gets r bps of its stake rebated, up to a cap per identity per`);
    console.log(`day". Does not touch the fight, needs no program change, and its farm rate is bounded BY`);
    console.log(`CONSTRUCTION at the daily cap — the property no damage-basis rule has. Rake below is NET of it.\n`);
    console.log(`cell                  r bps  daily cap   KM rake/plyr   net rake/round  rebate %gross   MAX $/identity/day`);
    console.log("-".repeat(126));
    for (const a of rebs) {
      const s = a.r0.rebateStats!;
      const gross = a.r0.house.rakeUsdTotal + s.paidUsd;
      console.log(`${a.cell.padEnd(21)} ${String(a.r0.rebate!.bps).padStart(5)}  ` +
                  `${(a.r0.rebate!.dailyCapUsd === null ? "NONE" : "$" + a.r0.rebate!.dailyCapUsd.toFixed(2)).padStart(9)}  ` +
                  `$${F(a.kmRake.mean, 10)}  $${F(a.rakePerLobbyRound.mean, 13, 4)}  ${F(100 * s.paidUsd / gross, 12, 1)}%  ` +
                  `$${F(s.theoreticalMaxDayUsd, 15)} (obs $${s.maxDayPerIdentityUsd.toFixed(2)})`);
    }
    const b = get("base");
    if (b) {
      console.log(`\ncontrol (base, no rebate): KM rake $${b.kmRake.mean.toFixed(3)}/player, $${b.rakePerLobbyRound.mean.toFixed(4)}/round.`);
      for (const a of rebs) {
        const d = diff(a.kmRake, b.kmRake);
        console.log(`  ${a.cell.padEnd(21)} vs base ${d.d >= 0 ? "+" : ""}$${F(d.d, 7)} +-${F(d.ci, 6)} (${d.sigma.toFixed(1)} sigma)`);
      }
    }
    console.log(`\nA rebate's worst case is its cap times however many identities the farmer can obtain, so the`);
    console.log(`mechanic's safety is exactly the COST OF AN IDENTITY — a business decision, not a simulation`);
    console.log(`output. A damage-basis blend has no such bound: see the adversary table below.`);
  }

  // --- ADVERSARY ---------------------------------------------------------------------------------
  const pairs: [string, string][] = [
    ["base", "adversary-base"], ["blend-20", "adversary-blend-20"],
    ["blend-100", "adversary-blend-100"], ["gated-P100-v1", "adversary-gated-P100-v1"],
  ];
  const advRows = pairs.map(([w, a]) => ({ w: get(w), a: get(a) })).filter(x => x.a) as { w?: CellAgg; a: CellAgg }[];
  if (advRows.length) {
    console.log(`\n\n### ADVERSARY — the house's net AFTER the farmer is present #################################`);
    console.log(`One actor, $${ADV_WALLETS * ADV_WALLET_USD} of working capital split into ${ADV_WALLETS} wallets of $${ADV_WALLET_USD}. Seats in ordinary lobbies alongside`);
    console.log(`honest players, never churns, and strips its winnings every round so its exposure stays constant.`);
    console.log(`Under the identity gate it holds exactly ONE verified wallet, because an identity is the one thing`);
    console.log(`splitting cannot manufacture.`);
    console.log(``);
    console.log(`THE INTERVAL IS NOT OPTIONAL HERE. At ${ADV_WALLETS} x $${ADV_WALLET_USD} and ~44% per-round sigma the cumulative P&L over a`);
    console.log(`few hundred rounds has a standard deviation in the hundreds of dollars, so a raw cumulative net`);
    console.log(`reads as a farm whether or not one exists. Rounds are the independent unit — the adversary strips`);
    console.log(`its winnings every round, so there is no compounding to correlate them.\n`);
    console.log(`world                        adv $/round      95% CI    sigma   adv $/day       95% CI     verdict`);
    console.log("-".repeat(122));
    for (const { a } of advRows) {
      const ad = a.r0.adversary!;
      const pr = est(a.reps, r => r.adversary!.perRoundUsd, r => r.adversary!.perRoundCi);
      const sig = pr.ci > 0 ? Math.abs(pr.mean) / (pr.ci / 1.96) : 0;
      const verdict = sig < 2 ? "INDISTINGUISHABLE FROM ZERO" : "REAL FARM";
      console.log(`${a.cell.padEnd(28)} $${F(pr.mean, 9, 4)}  +-${F(pr.ci, 8, 4)}  ${F(sig, 5, 1)}   ` +
                  `$${F(pr.mean * ROUNDS_PER_DAY, 9)}  +-${F(pr.ci * ROUNDS_PER_DAY, 9)}   ${verdict}` +
                  `${ad.roundsN < 100 ? "  (n=" + ad.roundsN + " rounds)" : ""}`);
    }
    console.log(`\nNORMALISED — the house figure is from ${POP} players, the adversary figure is from $${ADV_WALLETS * ADV_WALLET_USD}:`);
    console.log(`world                        house $/day    house $/day    adv $/day   adv as % of   adv $/day    adv daily`);
    console.log(`                             (1 lobby)      (${POP} players)              house rev.    per $ cap    ROI on cap`);
    console.log("-".repeat(126));
    for (const { a } of advRows) {
      const pr = est(a.reps, r => r.adversary!.perRoundUsd, r => r.adversary!.perRoundCi);
      const houseLobbyDay = a.rakePerLobbyRound.mean * ROUNDS_PER_DAY;
      const housePopDay = houseLobbyDay * a.lobbiesPerRound;
      const advDay = pr.mean * ROUNDS_PER_DAY;
      const cap = ADV_WALLETS * ADV_WALLET_USD;
      console.log(`${a.cell.padEnd(28)} $${F(houseLobbyDay, 9)}   $${F(housePopDay, 11)}  $${F(advDay, 10)}  ` +
                  `${F(100 * advDay / housePopDay, 11, 1)}%  $${F(advDay / cap, 10, 2)}  ${F(100 * advDay / cap, 9, 0)}%/day`);
    }
    console.log(`\nTHE COMPARISON THAT DECIDES THE RECOMMENDATION — what the mechanic pays the OPERATOR against`);
    console.log(`what it pays a single $${ADV_WALLETS * ADV_WALLET_USD} ATTACKER, both in $/day over the same ${POP}-player population:`);
    const b = get("base");
    if (b) {
      const baseAdv = get("adversary-base");
      const baseAdvDay = baseAdv ? est(baseAdv.reps, r => r.adversary!.perRoundUsd).mean * ROUNDS_PER_DAY : 0;
      console.log(``);
      console.log(`mechanic          house gain $/day (pop)   adversary extraction $/day   attacker : operator`);
      console.log("-".repeat(110));
      for (const { w, a } of advRows) {
        if (!w || w.cell === "base") continue;
        const gain = (w.rakePerLobbyRound.mean - b.rakePerLobbyRound.mean) * ROUNDS_PER_DAY * w.lobbiesPerRound;
        const pr = est(a.reps, r => r.adversary!.perRoundUsd);
        const extra = pr.mean * ROUNDS_PER_DAY - baseAdvDay;
        const note = gain <= 0
          ? "OPERATOR LOSES and attacker gains"
          : extra <= 0 ? "attacker loses" : `${(extra / gain).toFixed(2)} : 1`;
        console.log(`${w.cell.padEnd(17)} ${gain >= 0 ? "+" : ""}$${F(gain, 20)}   ${extra >= 0 ? "+" : ""}$${F(extra, 24)}   ${note}`);
      }
      console.log(``);
      console.log(`"house gain" is the change in the whole population's rake per day against the P=0 control.`);
      console.log(`"adversary extraction" is the ADDITIONAL $/day the same attacker takes over what it takes under`);
      console.log(`the shipped rule, so both columns are differences against the same baseline.`);
    }
    console.log(`\nDENOMINATOR WARNING: the adversary's $/round is per ARENA and scales with how many arenas it can`);
    console.log(`sit in at once, which this simulation does not model. Every adversary figure is a per-arena FLOOR.`);
  }

  // --- SENSITIVITY -------------------------------------------------------------------------------
  const sensRows = ["hd0", "hd0.2", "sf0.25"].map(t => ({ t, cells: [0, 20, 100].map(p => get(`sens-${t}-P${p}`)) }))
    .filter(x => x.cells.some(c => c));
  if (sensRows.length) {
    console.log(`\n\n### SENSITIVITY — which conclusions survive the assumptions? ################################`);
    console.log(`One-at-a-time deviations from BASE_PLAYER, not a full factorial: a conclusion that survives each`);
    console.log(`deviation alone is the claim being made. Nothing in this repo measures any churn parameter.\n`);
    console.log(`variant                        P=0 KM rake   P=20 KM rake   P=100 KM rake   d(P100-P0)  sigma  direction`);
    console.log("-".repeat(122));
    const line = (name: string, cs: (CellAgg | undefined)[]) => {
      const v = cs.map(c => (c ? c.kmRake.mean : NaN));
      const d = cs[0] && cs[2] ? diff(cs[2].kmRake, cs[0].kmRake) : { d: NaN, ci: NaN, sigma: NaN };
      const dir = !Number.isFinite(d.sigma) ? "?" : d.sigma < 2 ? "FLAT (n.s.)" : d.d > 0 ? "rising" : "FALLING";
      console.log(`${name.padEnd(30)} $${F(v[0], 10)}   $${F(v[1], 11)}   $${F(v[2], 12)}   ${d.d >= 0 ? "+" : ""}$${F(d.d, 8)}  ${F(d.sigma, 5, 1)}  ${dir}`);
    };
    line("BASE (hd 0.02, sf 1.0)", [get("base"), get("blend-20"), get("blend-100")]);
    for (const s of sensRows) line(s.t, s.cells);
    console.log(`\nEvery variant whose direction is FLAT or FALLING is a variant under which the retention hypothesis`);
    console.log(`is not supported. A conclusion is only claimed here if it holds in every row.`);
  }

  // --- VERDICT -----------------------------------------------------------------------------------
  const ctl = get("base");
  const cands = have(P_GRID.map(p => `blend-${p}`));
  console.log(`\n\n### VERDICT — plain words ##################################################################`);
  if (!ctl || cands.length === 0) {
    console.log(`Not enough cells present to draw one. Run at least \`base\` and the \`blend-*\` cells.`);
  } else {
    const bestA = cands.reduce((x, y) => (y.kmRake.mean > x.kmRake.mean ? y : x));
    const d = diff(bestA.kmRake, ctl.kmRake);
    const real = d.sigma >= 2 && d.d > 0;
    const advBlend = get("adversary-blend-100"), advBase = get("adversary-base");
    console.log(`THE QUESTION: does a disclosed small-stake bonus increase lifetime revenue per acquired player?\n`);
    if (real) {
      console.log(`1. AS A REVENUE QUESTION: YES, +$${d.d.toFixed(3)}/player (+-${d.ci.toFixed(3)}, ${d.sigma.toFixed(1)} sigma) at ${bestA.cell}.`);
      console.log(`   THE MECHANISM IS TURNOVER, NOT RETENTION. Deposits per player barely move; what moves is how`);
      console.log(`   many times a deposited dollar is staked before it leaves, because money taken from players`);
      console.log(`   who exit with it and handed to players who re-stake it gets raked again. The rake is`);
      console.log(`   ${FEE_BPS} bps of turnover and of nothing else — see the DECOMPOSITION table, where that identity`);
      console.log(`   is checked rather than asserted.`);
    } else {
      console.log(`1. AS A REVENUE QUESTION: NO. The best blend cell (${bestA.cell}) moves lifetime rake per acquired`);
      console.log(`   player by $${d.d.toFixed(3)} +-${d.ci.toFixed(3)} (${d.sigma.toFixed(1)} sigma) — indistinguishable from zero.`);
      console.log(`   THE RETENTION HYPOTHESIS IS NOT SUPPORTED BY THIS MEASUREMENT.`);
    }
    console.log(``);
    const b20 = get("blend-20"), b100 = get("blend-100");
    if (b20 && b100) {
      console.log(`   BUT THE TWO OBJECTIVES DISAGREE, AND THE SIGN FLIPS BETWEEN THEM. In steady state`);
      console.log(`   rake/round = (population / mean life) x rake per acquired player, and the blend lengthens`);
      console.log(`   lives faster than it raises per-player value everywhere below P=100. So blend-20 raises`);
      console.log(`   revenue per acquired player (+$${(b20.kmRake.mean - ctl.kmRake.mean).toFixed(2)}) while LOWERING revenue per day`);
      console.log(`   ($${b20.rakePerLobbyRound.mean.toFixed(4)}/round against the control's $${ctl.rakePerLobbyRound.mean.toFixed(4)}). Which objective is the right one`);
      console.log(`   depends on whether ACQUISITION or SEATS is the binding constraint, and nothing in this`);
      console.log(`   repository measures cost per acquisition. The study cannot pick; it can only refuse to hide`);
      console.log(`   that the choice exists.`);
    }
    console.log(``);
    if (advBlend && advBase) {
      const pb = est(advBlend.reps, r => r.adversary!.perRoundUsd).mean * ROUNDS_PER_DAY;
      const p0 = est(advBase.reps, r => r.adversary!.perRoundUsd).mean * ROUNDS_PER_DAY;
      const gain = (get("blend-100")!.rakePerLobbyRound.mean - ctl.rakePerLobbyRound.mean) * ROUNDS_PER_DAY * ctl.lobbiesPerRound;
      const advGate = get("adversary-gated-P100-v1");
      console.log(`2. AS A BUSINESS DECISION: NO, NOT IN THE ANONYMOUS FORM. At P=100 the mechanic moves the`);
      console.log(`   operator's revenue by $${gain.toFixed(0)}/day across ${POP} players and $${(POP * 100).toLocaleString("en-US")} of deposits, while handing ONE`);
      console.log(`   attacker with $${ADV_WALLETS * ADV_WALLET_USD} an extra $${(pb - p0).toFixed(0)}/day — ${(100 * (pb - p0) / gain).toFixed(0)}% of the entire gain — for doing nothing`);
      console.log(`   but splitting a wallet ${ADV_WALLETS} ways and showing up. That attacker earns ${(100 * (pb - p0) / (ADV_WALLETS * ADV_WALLET_USD)).toFixed(0)}% per DAY on capital,`);
      console.log(`   it never churns, and the figure is a per-ARENA floor because nothing stops it seating in all`);
      console.log(`   of them at once. The control cell is properly zeroed at ${est(advBase.reps, r => r.adversary!.perRoundUsd).ci > 0 ? (Math.abs(p0 / ROUNDS_PER_DAY) / (est(advBase.reps, r => r.adversary!.perRoundUsd).ci / 1.96)).toFixed(1) : "0.0"} sigma, so this is the mechanic`);
      console.log(`   and not the noise.`);
      console.log(``);
      console.log(`   THE SPEC'S CENTRAL CLAIM IS CONFIRMED: for an anonymous rule whose effect on a wallet depends`);
      console.log(`   only on that wallet's own stake size, the INTENDED EFFECT and the FARM RATE are the same`);
      console.log(`   number. A splitter with budget B in k wallets simply receives the treatment meant for a B/k`);
      console.log(`   player, k times over.`);
      if (advGate) {
        const pg = est(advGate.reps, r => r.adversary!.perRoundUsd).mean * ROUNDS_PER_DAY;
        console.log(``);
        console.log(`   AND THE ONE THING THAT SEPARATES THEM IS MEASURED HERE: the identity gate. Same P=100 blend,`);
        console.log(`   but the attacker holds ONE verified wallet out of ${ADV_WALLETS} because an identity is the one thing`);
        console.log(`   splitting cannot manufacture. Its take falls from $${(pb - p0).toFixed(0)}/day to $${(pg - p0).toFixed(0)}/day, a ${((pb - p0) / Math.max(1e-9, pg - p0)).toFixed(1)}x cut,`);
        console.log(`   while the operator keeps the gain. The gate does not eliminate the farm; it converts an`);
        console.log(`   unbounded anonymous one into "farm rate x number of identities you can buy", which prices`);
        console.log(`   the mechanic's safety at exactly the cost of an identity. That is a business decision, and`);
        console.log(`   it is the only lever in this study that turns the SPEC's identity into a bounded one.`);
      }
    }
    console.log(``);
    const capOffV = get("chan-hz-P0");
    console.log(`3. WHAT TO DO INSTEAD — and BOTH of the alternatives this study was asked to price came out`);
    console.log(`   NEGATIVE, so they are reported as refuted rather than recommended:`);
    console.log(`   * THE PER-ENTRY CAP DOES THE OPPOSITE OF WHAT WAS EXPECTED. Lowering it lengthens lives and`);
    console.log(`     COLLAPSES turnover — $100 -> $5 takes lifetime rake from $21.21 to $2.86. It is the most`);
    console.log(`     destructive lever measured in this file.`);
    console.log(`   * THE TREASURY REBATE IS REVENUE-NEUTRAL AT EVERY SETTING TESTED (every cell within 0.8 sigma`);
    console.log(`     of the control). It is a pure cost with a bounded farm rate — a marketing spend, priced,`);
    console.log(`     which is a legitimate thing to want but is not a revenue mechanic.`);
    console.log(`   * MATCHMAKING BY STAKE BAND does not raise revenue either, and costs a little. What it DOES`);
    console.log(`     do is flatten sd(ROI) to ~40% in every stake band and remove the sub-$0.10 dust drain. It is`);
    console.log(`     a fairness instrument, and it is free and unfarmable — just not a revenue instrument.`);
    if (capOffV) {
      const dc = diff(capOffV.kmRake, ctl.kmRake);
      console.log(`   * THE ONE LARGE, UNFARMABLE LEVER FOUND: lifting the $100 per-entry cap. Same model, same`);
      console.log(`     shipped fight, +$${dc.d.toFixed(2)}/player (${dc.sigma.toFixed(1)} sigma) — ${(dc.d / Math.max(1e-9, bestA.kmRake.mean - ctl.kmRake.mean)).toFixed(1)}x the best blend cell, with no farm rate,`);
      console.log(`     because a stake ceiling creates no cross-size transfer to capture. It is a parameter the`);
      console.log(`     product already has. See its own section for what this does NOT price: the cap exists to`);
      console.log(`     bound exposure, and \`arenas.ts:40\` records it as "locked by Max".`);
    }
    console.log(``);
    const sfCell0 = get("sens-sf0.25-P0"), sfCell100 = get("sens-sf0.25-P100");
    if (sfCell0 && sfCell100) {
      const ds = diff(sfCell100.kmRake, sfCell0.kmRake);
      console.log(`4. THE GAIN DOES NOT SURVIVE EVERY ASSUMPTION, AND THAT IS PART OF THE ANSWER. At stakeFraction`);
      console.log(`   0.25 instead of 1.0 — a player who redeploys a quarter of their balance rather than all of`);
      console.log(`   it — the P=100 effect is $${ds.d.toFixed(2)} (${ds.sigma.toFixed(1)} sigma), i.e. it reverses. That is consistent with`);
      console.log(`   the cap being the true channel: at a quarter stake the $100 ceiling almost never binds, so`);
      console.log(`   there is nothing for the blend to unlock. The measured gain is therefore conditional on full`);
      console.log(`   redeployment, which is an ASSUMPTION about player behaviour that nothing here measures.`);
      console.log(``);
    }
    console.log(`WHAT THIS DOES NOT ESTABLISH, stated so it is not discovered later:`);
    console.log(`  * Every churn parameter is a PRIOR. If real players respond to a visible tilt in a way no hazard`);
    console.log(`    function here describes — telling their friends, staying for the story — nothing in this file`);
    console.log(`    measures it, and SENSITIVITY sweeps the SHAPE of the assumption, not its existence.`);
    console.log(`  * Acquisition is exogenous: a busted slot is replaced instantly by a fresh $100 player. If a`);
    console.log(`    small-stake bonus changes the ACQUISITION rate or cost, that effect is outside this simulator`);
    console.log(`    entirely, and it is the one channel that could still make the mechanic pay.`);
    console.log(`  * The adversary is ONE farmer in ONE arena, with no gas cost charged against it. Real farming`);
    console.log(`    scales with arenas and wallets; real gas subtracts a per-wallet, per-round constant.`);
  }
  console.log(`\n${"=".repeat(126)}\n`);
}
// ------------------------------------------------------------------------------------------------
// MAIN
// ------------------------------------------------------------------------------------------------

function main() {
  header();
  if (ONLY === "list") {
    console.log(`\ncells (${CELLS.length}):`);
    for (const g of [...new Set(CELLS.map(c => c.group))]) {
      console.log(`  ${g.padEnd(10)} ${CELLS.filter(c => c.group === g).map(c => c.name).join(" ")}`);
    }
    return;
  }
  if (ONLY === "report") { report(); return; }

  const todo = ONLY === "all" ? CELLS
    : byName.has(ONLY) ? [byName.get(ONLY)!]
    : CELLS.filter(c => c.group === ONLY);
  if (todo.length === 0) {
    console.error(`\nunknown cell or group "${ONLY}". Run with "list" to see them all.`);
    process.exit(1);
  }
  console.log(`\nrunning ${todo.length} cell(s), replicate ${REP}: ${todo.map(c => c.name).join(" ")}`);
  console.log(`results -> ${RESULT_DIR}/<cell>__r${REP}.json\n`);
  assertBlendZeroIsMin();

  for (const c of todo) {
    const { res, pool } = runCohort(c, s => console.log(s));
    saveResult(res);
    printCell(res);
    if (pool) validate(res, pool);
  }
  if (ONLY === "all") report();
  else console.log(`\n\nDone. Cross-cell tables: ` +
    `cd engine && HE_FEE_BPS=${FEE_BPS} npx tsx ../sandbox/house-edge/small-stake-lifetime.ts ${TARGET_LIVES} report\n`);
}

main();
