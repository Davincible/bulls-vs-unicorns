// SANDBOX. Shared core for the LIFETIME studies. Nothing imports this outside sandbox/house-edge/.
//
// WHY THIS FILE EXISTS
// -------------------
// Every measurement in HOUSE-EDGE-STUDY.md and HOUSE-STRATEGY.md is denominated PER ROUND. The
// operator's actual objective is revenue per ACQUIRED PLAYER over their whole life on the platform,
// and those two quantities diverge violently: HOUSE-STRATEGY.md §5 shows a full-redeployment player
// with a median terminal balance of $0.01 after 200 rounds. A dead player pays no more rake.
//
// Measuring that directly means simulating tens of millions of player-rounds across a fee sweep,
// which at 462 fights/sec (measured, 8 seats, 1,920-step budget) is not going to happen.
//
// THE TRICK, AND WHY IT IS LEGITIMATE RATHER THAN A SHORTCUT
// ---------------------------------------------------------
// A round does exactly two things to a player's money:
//   1. the fee removes `stake * feeBps / 10_000` on the way in;
//   2. the fight multiplies whatever entered the ring by a random factor R = payout / net_stake.
//
// So `balance' = balance - stake + stake * (1 - fee) * R`, and the ENTIRE round is summarised by one
// scalar R. If the distribution of R is independent of the fee and depends on the player's stake only
// through where that stake sits relative to the field, then a pool of R draws harvested once can be
// resampled for every fee level, every cadence and every churn model — turning a 5-minute simulation
// into a 5-millisecond one, and making million-path Monte Carlo affordable.
//
// BOTH CONDITIONS ARE ALREADY MEASURED FACTS, NOT ASSUMPTIONS:
//   * fee-independence — HOUSE-EDGE-STUDY.md §11.4: every stake band moved by -0.798% to -0.803%
//     against a theoretical -0.800% when the rate went 20 -> 100 bps. The rake is exactly
//     proportional and does not touch the fight.
//   * the fight is a martingale in `hp + banked` — §11.5, because `basis = min(attacker.hp,
//     defender.hp)` is symmetric. So E[R] = 1 up to integer flooring.
// `verifyPool()` below re-checks both against the pool it just built rather than taking the study's
// word for it, and `strategy-lifetime.ts` cross-checks the whole approximation against a full-fight
// simulation. If either check fails, every number downstream is void.
//
// WHAT THE POOL DOES NOT CAPTURE, STATED HERE SO IT IS NOT DISCOVERED LATER
// ------------------------------------------------------------------------
//   * Round-to-round independence. A real player meets a correlated field (the same whales, the same
//     house bots) round after round; the pool resamples i.i.d. That understates the tails of a
//     player's balance path in both directions. Flagged, not fixed.
//   * The player's own effect on the field. A player whose balance has collapsed to $0.40 changes the
//     lobby they are in. The pool bins on the player's own stake against a field drawn from the
//     standard invented BANDS distribution, so this is captured to first order and no further.
//   * The extract penalty. R here is a HOLD-TO-THE-BELL multiplier. Extraction is priced separately
//     in `strategy-penalty.ts`, because it is a decision and not a draw.

import { newRound, enter, tick, settle } from "../../engine/src/er-sim.ts";
import { stepBudget } from "./fight-variant.ts";
import { BANDS, usd, toUsd } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ------------------------------------------------------------------------------------------------
// The economy's own constants, imported rather than retyped so they cannot drift away from the app.
// `engine/src/arenas.ts:40` — "Economy constants (locked by Max)".
// ------------------------------------------------------------------------------------------------
export { FEE as ENGINE_FEE, CAP as STAKE_CAP_USD, CONVERT_FEE, MIN_ENTRY } from "../../engine/src/arenas.ts";
import { CAP as STAKE_CAP_USD, MIN_ENTRY } from "../../engine/src/arenas.ts";

/** Rounds per hour at the ~110s cadence HOUSE-STRATEGY.md §1 uses throughout. */
export const ROUNDS_PER_HOUR = 3600 / 110;
/** Keeper gas + unreclaimed rent, all-in, reconciled across 28 real rounds. HOUSE-STRATEGY.md §1. */
export const GAS_SOL_PER_ROUND = 0.00981;
export const SOL_USD = Number(process.env.SOL_USD ?? 150);
export const GAS_USD_PER_ROUND = GAS_SOL_PER_ROUND * SOL_USD;

// ------------------------------------------------------------------------------------------------
// BINS. Four per decade over the four decades from the minimum entry ($0.01) to the per-stake cap
// ($100). A player's R depends on how big they are RELATIVE TO THE FIELD, and a busted player at
// $0.03 among $50 whales is a completely different draw from a $50 player among the same — that is
// the whole reason the lifetime distribution is not the closed form (1 - fee)^N.
// ------------------------------------------------------------------------------------------------
export const BINS = 16;
export const BIN_LO_USD = 0.01;
export const binOf = (stakeUsd: number): number =>
  Math.min(BINS - 1, Math.max(0, Math.floor(4 * Math.log10(Math.max(stakeUsd, BIN_LO_USD) / BIN_LO_USD))));
export const binLoUsd = (b: number) => BIN_LO_USD * Math.pow(10, b / 4);
export const binHiUsd = (b: number) => BIN_LO_USD * Math.pow(10, (b + 1) / 4);

export interface Pool {
  /** R = payout / net-stake, one array per stake bin. */
  bins: Float64Array[];
  fights: number;
  seed: string;
  seats: number;
}

// ------------------------------------------------------------------------------------------------
// POOL CONSTRUCTION
// ------------------------------------------------------------------------------------------------

/** Build the R pool by playing real fights on `engine/src/er-sim.ts`.
 *
 *  Each fight seats one TRACKED fighter whose stake is log-uniform over the whole $0.01-$100 range
 *  (so every bin fills at the same rate) against `seats - 1` opponents drawn from the standard
 *  invented BANDS distribution. Every seat is harvested, not just the tracked one: the BANDS seats
 *  face a field of (seats - 2) BANDS members plus one log-uniform seat, which is the same field to
 *  within one usually-tiny fighter, and they enrich the $3-$100 bins where almost all real play sits
 *  by roughly seven to one. `verifyPool` reports the tracked-only and all-seats means separately so
 *  that approximation is visible rather than assumed.
 *
 *  THE POOL IS BUILT AT ZERO FEE ON PURPOSE. R is then the pure fight multiplier on whatever entered
 *  the ring, and the fee is applied analytically downstream. That removes the fee from the pool
 *  entirely instead of relying on it cancelling. */
export function buildPool(fights: number, seedTag: string, seats = 8): Pool {
  const bins: number[][] = Array.from({ length: BINS }, () => []);
  const rnd = mulberry32(hash32(`${seedTag}|pool`));
  const budget = stepBudget(seats);

  for (let i = 0; i < fights; i++) {
    const round = newRound(createHash("sha256").update(`lt|${seedTag}|${i}`).digest());
    const stakes: number[] = [];
    // seat 0 is the tracked seat: log-uniform across the full range, so bins fill evenly.
    const tracked = BIN_LO_USD * Math.pow(10, 4 * rnd());
    stakes.push(tracked);
    for (let k = 1; k < seats; k++) {
      const b = BANDS[Math.floor(rnd() * BANDS.length)];
      stakes.push(b.lo + rnd() * (b.hi - b.lo));
    }
    const nets: bigint[] = [];
    for (let k = 0; k < seats; k++) {
      const g = usd(stakes[k]);
      if (g <= 0n) { nets.push(0n); continue; }
      enter(round, `w${k}`, (k % 2) as 0 | 1, g, 0n);   // zero fee: R is the pure fight multiplier
      nets.push(g);
    }
    if (round.fighters.length < 2) continue;
    tick(round, budget);
    settle(round);
    for (let k = 0; k < round.fighters.length; k++) {
      const f = round.fighters[k];
      const net = nets[k];
      if (net <= 0n) continue;
      bins[binOf(stakes[k])].push(Number(f.hp + f.banked) / Number(net));
    }
  }
  return { bins: bins.map(a => Float64Array.from(a)), fights, seed: seedTag, seats };
}

// ------------------------------------------------------------------------------------------------
// CACHE. The pool takes minutes; the sweeps take milliseconds. Cached OUTSIDE the repo by default so
// nothing large lands in git. Delete the file to force a rebuild; the tag encodes every input, so a
// changed parameter can never silently reuse a stale pool.
// ------------------------------------------------------------------------------------------------
export function poolPath(fights: number, seedTag: string, seats: number): string {
  const dir = process.env.HE_POOL_DIR
    ?? "/private/tmp/claude-501/-Users-tyler-Launchpad-Crypto-UwuGame-magicblock/d5279d95-4422-4376-a720-d79efa3c4e5c/scratchpad";
  return `${dir}/pool-${seedTag}-${fights}-${seats}.json`;
}

export function loadOrBuildPool(fights: number, seedTag: string, seats = 8, quiet = false): Pool {
  const p = poolPath(fights, seedTag, seats);
  if (existsSync(p)) {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (!quiet) console.log(`payoff pool: ${fights} fights x ${seats} seats, cached at ${p}`);
    return { bins: raw.bins.map((a: number[]) => Float64Array.from(a)), fights, seed: seedTag, seats };
  }
  if (!quiet) console.log(`payoff pool: building ${fights} fights x ${seats} seats on er-sim.ts (~${(fights / 462 / 60).toFixed(1)} min)...`);
  const t0 = Date.now();
  const pool = buildPool(fights, seedTag, seats);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ bins: pool.bins.map(a => Array.from(a)) }));
  if (!quiet) console.log(`payoff pool: built in ${((Date.now() - t0) / 1000).toFixed(0)}s, cached at ${p}`);
  return pool;
}

// ------------------------------------------------------------------------------------------------
// VALIDATION. Run before trusting anything the pool produces.
// ------------------------------------------------------------------------------------------------

export interface BinStat { bin: number; lo: number; hi: number; n: number; mean: number; se: number; sd: number; pZero: number; }

export function poolStats(pool: Pool): BinStat[] {
  return pool.bins.map((xs, b) => {
    const n = xs.length;
    if (n === 0) return { bin: b, lo: binLoUsd(b), hi: binHiUsd(b), n: 0, mean: NaN, se: NaN, sd: NaN, pZero: NaN };
    let s = 0; for (const x of xs) s += x;
    const m = s / n;
    let v = 0; for (const x of xs) v += (x - m) * (x - m);
    const sd = Math.sqrt(v / Math.max(1, n - 1));
    let z = 0; for (const x of xs) if (x === 0) z++;
    return { bin: b, lo: binLoUsd(b), hi: binHiUsd(b), n, mean: m, se: sd / Math.sqrt(n), sd, pZero: z / n };
  });
}

/** THE DUST FLOOR, in USD. `engine/src/er-sim.ts:68` — `DUST = 1_000n` micro-units. */
export const DUST_USD = 0.001;
/** Below this stake the martingale does not hold and the pool must not be asked to prove that it
 *  does. Measured, not chosen: see `verifyPool`. */
export const MARTINGALE_FLOOR_USD = 0.10;

/** E[R] must be 1, because the fight is a martingale in `hp + banked` (HOUSE-EDGE-STUDY.md §11.5).
 *
 *  IT IS NOT A MARTINGALE ALL THE WAY DOWN, AND THIS FUNCTION IS WHERE THAT WAS FOUND. There is
 *  exactly one asymmetric line in `tick`:
 *
 *      if (D.hp <= DUST) dmg = D.hp;        // er-sim.ts:199, "keys on the DEFENDER's ring alone"
 *
 *  Every other term reads `min(attacker.hp, defender.hp)` and is therefore symmetric between the two
 *  directions of an exchange. This one is not: a fighter at or below the dust floor loses their
 *  ENTIRE remaining ring when drawn as defender, but gains only `roll/100` (4-27%, mean 15.2%) of it
 *  when drawn as attacker. Over the ~equal odds of being drawn either way that is a systematic drain,
 *  and its size is bounded by the dust floor itself.
 *
 *  So the drain is an ABSOLUTE loss of order `DUST`, not a percentage edge. Measured over the pool it
 *  is a flat ~-$0.0008 per fight in every bin below a dollar — which is -5.6% of a $0.013 stake, -1.0%
 *  of a $0.075 stake, and statistically invisible above $0.10. That is why this function tests the
 *  martingale in DOLLARS above `MARTINGALE_FLOOR_USD` and reports the dust drain separately instead
 *  of failing the pool over it.
 *
 *  THIS IS NOT HOUSE REVENUE. The wiped ring goes to the attacking FIGHTER, not to the treasury. It
 *  is a player-to-player transfer that happens to run downhill, so it belongs in this study as a
 *  lifetime effect on a collapsing balance and NOT as a revenue stream. */
export function verifyPool(pool: Pool, log = console.log): { worstSigma: number; ok: boolean; dustDriftUsd: number } {
  const st = poolStats(pool);
  log(`\n--- POOL VALIDATION -------------------------------------------------------------------`);
  log(`E[R] = 1 is required above $${MARTINGALE_FLOOR_USD.toFixed(2)} (the fight is a martingale, §11.5).`);
  log(`Below it the DUST rule (er-sim.ts:199) drains a fixed ~$${DUST_USD.toFixed(3)}-scale amount per fight.\n`);
  log(`stake bin                 n        mean R      se       sigma     ABSOLUTE drift $   sd(R)`);
  log("-".repeat(98));
  let worst = 0;
  let dustSum = 0, dustN = 0;
  for (const s of st) {
    if (s.n === 0) { log(`  bin ${String(s.bin).padStart(2)} EMPTY`); continue; }
    const mid = Math.sqrt(s.lo * s.hi);
    const abs = (s.mean - 1) * mid;
    const sig = Math.abs(s.mean - 1) / s.se;
    const graded = mid >= MARTINGALE_FLOOR_USD;
    if (graded) worst = Math.max(worst, sig); else { dustSum += abs; dustN++; }
    log(`$${s.lo.toFixed(3).padStart(7)}-$${s.hi.toFixed(2).padStart(7)}  ${String(s.n).padStart(8)}   ` +
        `${s.mean.toFixed(5)}  ${s.se.toFixed(5)}  ${(graded ? sig.toFixed(2) : "  dust").padStart(7)}   ` +
        `${abs.toFixed(6).padStart(12)}   ${s.sd.toFixed(4)}`);
  }
  const dustDrift = dustN > 0 ? dustSum / dustN : 0;
  const ok = worst < 4.5;
  log(`\nworst deviation from E[R] = 1 above $${MARTINGALE_FLOOR_USD.toFixed(2)}: ${worst.toFixed(2)} sigma  ->  ` +
      `${ok ? "POOL OK" : "POOL FAILED - discard everything downstream"}`);
  log(`mean absolute dust drift below $${MARTINGALE_FLOOR_USD.toFixed(2)}: $${dustDrift.toFixed(6)} per fight ` +
      `(one dust floor is $${DUST_USD.toFixed(3)}) -- a player-to-player transfer, NOT house revenue.`);
  return { worstSigma: worst, ok, dustDriftUsd: dustDrift };
}

// ------------------------------------------------------------------------------------------------
// THE PLAYER MODEL. Every behavioural assumption in this study lives in this one struct, so that the
// sensitivity analysis has exactly one place to sweep and the write-up has exactly one place to
// declare. NOTHING IN THIS REPOSITORY MEASURES ANY OF IT (HOUSE-STRATEGY.md §7) — these are priors.
// ------------------------------------------------------------------------------------------------

export interface PlayerModel {
  /** Opening deposit, USD. */
  bankroll: number;
  /** Fraction of current balance staked per round, before the $100 cap and $0.01 floor. */
  stakeFraction: number;
  /** Hard ceiling on rounds simulated. Not a behavioural assumption — a compute bound. */
  maxRounds: number;

  // --- churn. A player leaves for one of four reasons, and which one dominates decides the answer. -
  /** Per-round probability of quitting for reasons unrelated to money: bored, busy, gone. */
  hazardBase: number;
  /** Extra per-round quit probability per unit of drawdown from peak balance. `hazardDrawdown = 2.0`
   *  means a player 50% below their high-water mark quits with an extra 1.0 probability per round,
   *  i.e. essentially at once. This is THE term that creates an interior optimum in the fee; with it
   *  set to zero the answer is a corner solution and the study says so. */
  hazardDrawdown: number;
  /** Extra per-round quit probability per consecutive losing round, capped at `streakCap`. */
  hazardStreak: number;
  streakCap: number;
  /** Probability that a player who has busted out deposits again, per bust, decaying by
   *  `redepositDecay` each time they do it. */
  redeposit: number;
  redepositDecay: number;

  // --- ADDITIVE (strategy-lifetime.ts). Both OPTIONAL: omitted, `simulateLife` behaves exactly as ---
  // --- it did before they existed, so nothing already written against this struct changes.        ---

  /** A HARD stop at a drawdown from the high-water mark, as a percent. `50` means "walk away the
   *  moment the balance is half of its peak". Undefined or null means no stop, which is the
   *  pre-existing behaviour.
   *
   *  THIS IS NOT THE SHIPPED AUTO-DEPLOY RULE, and conflating the two would be wrong in the direction
   *  that flatters the house. `er-demo/src/v2/data/autoPolicy.ts` measures its 50% stop against the
   *  COMMITTED BUDGET's realised P&L, not against a peak, and it is dominated by a second limit
   *  (`budget-spent`, on CUMULATIVE GROSS STAKE) that has no analogue here. The code-exact rule is
   *  modelled by `simulateAutoDeployLife` in `strategy-lifetime.ts`. This field is the softer
   *  BEHAVIOURAL stop — the discipline a human might actually keep — and it is a deterministic
   *  counterpart to `hazardDrawdown`'s probabilistic one. */
  drawdownStopPct?: number | null;

  /** Per-stake ceiling in USD. Defaults to the arena's own `STAKE_CAP_USD` ($100) when omitted, which
   *  is the pre-existing behaviour. Exists only so the sensitivity table can price the CAP ITSELF: a
   *  $1,000 bankroll under a $100 cap is forced to `stakeFraction <= 0.1` whatever the player intended,
   *  and by `(1 - phi*f)^N` that is a 10x life extension. The cap is therefore a lifetime-extending
   *  device already in the product, and measuring it requires being able to turn it off. */
  stakeCapUsd?: number;
}

export const BASE_PLAYER: PlayerModel = {
  bankroll: 100,
  stakeFraction: 1.0,
  maxRounds: 20_000,
  hazardBase: 0.004,        // ~1 in 250 rounds -> a median life of ~173 rounds ~ 5.3 hours of play
  hazardDrawdown: 0.02,
  hazardStreak: 0.01,
  streakCap: 8,
  redeposit: 0.25,
  redepositDecay: 0.5,
};

export interface LifeResult {
  /** THE DELIVERABLE. Total fee + penalty the house took from this player over their whole life. */
  rakeUsd: number;
  /** Total the player ever deposited (opening bankroll plus redeposits). */
  depositedUsd: number;
  /** What they walked away with. deposited - withdrawn - rake = net won from OTHER players. */
  withdrawnUsd: number;
  rounds: number;
  busts: number;
  /** Why they stopped: "ruin" (busted with no redeposit left), "quit" (walked with money), "cap". */
  exit: "ruin" | "quit" | "cap";
}

/** Simulate one player's entire life. `feeBps` is the entry rake; `drawR` supplies the fight.
 *
 *  The accounting identity asserted by the caller: for a POPULATION, sum(rake) must equal
 *  sum(deposited) - sum(withdrawn), because the fight itself is zero-sum. It does NOT hold for one
 *  player, who can win or lose against the rest of the lobby. */
export function simulateLife(
  m: PlayerModel,
  feeBps: number,
  rnd: () => number,
  drawR: (bin: number, rnd: () => number) => number,
): LifeResult {
  const phi = feeBps / 10_000;
  let bal = m.bankroll;
  let deposited = m.bankroll;
  let rake = 0;
  let peak = bal;
  let streak = 0;
  let busts = 0;
  let redepositP = m.redeposit;
  let rounds = 0;
  let exit: "ruin" | "quit" | "cap" = "cap";

  for (; rounds < m.maxRounds; rounds++) {
    if (bal < MIN_ENTRY) {
      // Busted. Deposit again, or leave for good.
      if (rnd() < redepositP) {
        busts++;
        deposited += m.bankroll;
        bal += m.bankroll;
        redepositP *= m.redepositDecay;
        peak = bal; streak = 0;
        continue;
      }
      exit = "ruin";
      break;
    }
    const cap = m.stakeCapUsd ?? STAKE_CAP_USD;
    const stake = Math.min(Math.max(bal * m.stakeFraction, MIN_ENTRY), Math.min(bal, cap));
    const fee = stake * phi;
    const R = drawR(binOf(stake), rnd);
    const before = bal;
    bal = bal - stake + (stake - fee) * R;
    rake += fee;

    if (bal < before) streak = Math.min(m.streakCap, streak + 1); else streak = 0;
    if (bal > peak) peak = bal;

    // Churn. Drawdown is measured against the high-water mark of the CURRENT deposit cycle, which is
    // the quantity a player actually watches; absolute loss against lifetime deposits is what a
    // ledger would show, and the two differ for anyone who ran up a win first.
    const dd = peak > 0 ? Math.max(0, 1 - bal / peak) : 0;
    // The HARD stop is tested before the hazard, and the order matters for nothing except which of
    // two identical outcomes gets the credit: both book "quit". Tested first because a player who set
    // a stop and hit it did not leave for a reason a hazard describes.
    if (m.drawdownStopPct != null && dd >= m.drawdownStopPct / 100) { exit = "quit"; rounds++; break; }
    const h = m.hazardBase + m.hazardDrawdown * dd + m.hazardStreak * streak;
    if (rnd() < h) { exit = "quit"; rounds++; break; }
  }
  return { rakeUsd: rake, depositedUsd: deposited, withdrawnUsd: Math.max(0, bal), rounds, busts, exit };
}

// ------------------------------------------------------------------------------------------------
// Sampling + statistics helpers shared by the sweep scripts.
// ------------------------------------------------------------------------------------------------

/** Resample R from the pool. Falls back to the nearest non-empty bin so a sparse tail bin cannot
 *  silently return NaN and poison a whole path. */
export function makeDrawR(pool: Pool): (bin: number, rnd: () => number) => number {
  const bins = pool.bins;
  const fallback: number[] = [];
  for (let b = 0; b < BINS; b++) {
    let j = b;
    while (j < BINS && bins[j].length === 0) j++;
    if (j === BINS) { j = b; while (j >= 0 && bins[j].length === 0) j--; }
    fallback.push(j);
  }
  return (bin: number, rnd: () => number) => {
    const xs = bins[fallback[Math.min(BINS - 1, Math.max(0, bin))]];
    return xs[Math.min(xs.length - 1, Math.floor(rnd() * xs.length))];
  };
}

export const mean = (xs: ArrayLike<number>) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]; return s / xs.length; };
export const sd = (xs: ArrayLike<number>) => { const m = mean(xs); let v = 0; for (let i = 0; i < xs.length; i++) v += (xs[i] - m) ** 2; return Math.sqrt(v / Math.max(1, xs.length - 1)); };
export const sem = (xs: ArrayLike<number>) => sd(xs) / Math.sqrt(xs.length);
export const quant = (xs: ArrayLike<number>, p: number) => { const s = Array.from(xs).sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
/** 95% CI half-width on a mean. Normal approximation; n is in the thousands throughout. */
export const ci95 = (xs: ArrayLike<number>) => 1.96 * sem(xs);

export function hash32(s: string): number {
  return createHash("sha256").update(s).digest().readUInt32LE(0);
}

export { toUsd, usd, BANDS };
