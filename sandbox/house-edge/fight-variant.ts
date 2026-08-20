// SANDBOX — NOT SHIPPED, NOT ON CHAIN, NOT IMPORTED BY THE ENGINE OR THE DEMO.
//
// A knobbed variant of the on-chain fight loop (`advance_fight` in
// programs/bulls-arena/src/lib.rs, mirrored by engine/src/er-sim.ts). It exists only so a house edge
// can be MEASURED before anyone argues about whether to ship one. Nothing here is deployed and
// nothing here is imported by anything that is.
//
// THE ONE RULE THIS FILE OBEYS: everything on the path from the tick hash to the damage number is
// integer arithmetic (BigInt / Number-as-u32), because the point of measuring it is to be able to
// port the winner into Rust byte-for-byte. Floats appear only in the *analysis* (study.ts), never in
// the mechanism. `isqrt` is Newton on BigInt for exactly this reason.
//
// PARITY IS ASSERTED, NOT ASSUMED. `parity.ts` runs config BASELINE against engine/src/er-sim.ts's
// own `tick()` over many random lineups and requires byte-identical hp/banked/dead. If that fails,
// every number this sandbox produces is describing a different game and is worthless.

import { createHash } from "node:crypto";

export const BPS = 10_000n;
export const MAX_FIGHTERS = 48;
export const DUST_ABSOLUTE = 1_000n;      // the deployed constant
export const UNITS_PER_USD = 1_000_000n;  // er-demo/src/v2/contract.ts
/** The arena entry fee, in basis points.
 *
 *  IT IS NO LONGER A CONSTANT ON CHAIN. `Arena.fee_bps` is a live account field with a setter
 *  (`set_fee_bps`, bounded by `MAX_FEE_BPS = 1_000`), and v7 moved it from 20 to **100**. This rig
 *  was written when 20 was the only rate that had ever existed and hardcoded it, which made every
 *  study number silently a statement about 20 bps.
 *
 *  THE DEFAULT IS STILL 20 ON PURPOSE. HOUSE-EDGE-STUDY.md §1-§10 were measured at 20 bps, and a rig
 *  that quietly re-based them would turn a published measurement into an unreproducible one. Set
 *  `HE_FEE_BPS=100` in the environment to measure the rate the arena actually charges today; leave it
 *  unset and every command in README.md reproduces the number it always printed. */
export const FEE_BPS = BigInt(process.env.HE_FEE_BPS ?? 20);

/** Deployed pacing: `canonical_cursor` = elapsed × 2 × fighter_count, saturating at the BELL — i.e.
 *  `final_cursor` = FIGHT_TIMEOUT_SECONDS × STEPS_PER_FIGHTER_PER_SECOND × fighter_count, PER LINEUP,
 *  with no flat ceiling layered on top.
 *
 *  180s, raised from 120s alongside the 16 -> 48 fighter cap (see FIGHT_TIMEOUT_SECONDS's mirror in
 *  er-demo/src/chain/constants.ts for the re-measurement behind the new number). */
export const FIGHT_TIMEOUT_SECONDS = 180;
export const STEPS_PER_FIGHTER_PER_SECOND = 2;

/** `stepBudget` IS `final_cursor` now, not a mirror of it with a cap bolted on. It used to read
 *  `Math.min(MAX_STEPS, FIGHT_TIMEOUT_SECONDS * STEPS_PER_FIGHTER_PER_SECOND * n)` — a flat 4,000-step
 *  ceiling ANDed onto the per-lineup bell. That `min` was exactly the conflation the on-chain migration
 *  removed: at sixteen fighters the bell (3,840 steps) sat under the cap (4,000) so the `min` was
 *  inert and nobody noticed it was doing anything; at forty-eight fighters the bell is 17,280 steps and
 *  the old cap would have silently truncated every study run in this directory to a quarter of a real
 *  fight. This rig has no analogue of `MAX_STEPS_PER_CALL` (the program's new per-transaction compute
 *  bound) because every caller here runs a whole fight to conclusion inside one process call, not one
 *  bounded on-chain transaction — so the budget is the bell alone, DERIVED rather than capped. */
export const stepBudget = (n: number) => FIGHT_TIMEOUT_SECONDS * STEPS_PER_FIGHTER_PER_SECOND * n;

export interface Fighter {
  wallet: string;
  side: 0 | 1;
  dead: 0 | 1;
  stake: bigint;   // net of fee — what they put in, and their starting hp
  hp: bigint;      // value still in the ring
  banked: bigint;  // value raided off someone else; never at risk again
  /** ADDITIVE, and only read by a damage rule that asks for it (`gate: "attacker"`). Undefined
   *  everywhere it is not set, which is everywhere that existed before the small-stake study — so no
   *  configuration written before this field existed can observe it. It models the wallet->X link
   *  built in TWITTER-CONNECT.md: a bit the chain could carry and the fight could read. */
  verified?: 0 | 1;
  /** THE MINT VECTOR (G12 / ADR-001). `ring[i]` is in-ring value BY ORIGIN MINT SLOT and `vbank[i]`
   *  is banked value by origin slot; `slot` is the fighter's OWN mint, fixed at entry by which side
   *  they joined. All three are undefined unless `cfg.vector` is set, and when they are set the
   *  loop maintains `sum(ring) === hp` and `sum(vbank) === banked` on every exchange — so the
   *  scalar fields stay authoritative for the dust rule, the death test and every existing study,
   *  and the vector is a partition of them rather than a second source of truth. */
  ring?: bigint[];
  vbank?: bigint[];
  slot?: number;
}

// ---------------------------------------------------------------------------------------------
// Weight functions. All integer. All defined on a fighter's CURRENT ring (hp), so a fighter that has
// been beaten down stops being a magnet — a self-limiting property `stake`-based weights would not
// have, and one worth having: it is the difference between "big stakes bleed faster" and "big stakes
// get executed".
// ---------------------------------------------------------------------------------------------

export type WeightKind =
  | "uniform"     // w = 1                      (the deployed rule)
  | "linear"      // w = v
  | "sqrt"        // w = isqrt(v)
  | "pow34"       // w = v^(3/4), integer       = isqrt(v * isqrt(v))
  | "cap2"        // w = min(v, 2 * mean_v)
  | "cap3"        // w = min(v, 3 * mean_v)
  /** THE DIAL. `w = M*v + mean_v`, one u64 knob M.
   *
   *  M = 0 is exactly uniform; M -> infinity is exactly linear; and the mix in between is
   *  `M/(M+1)` linear to `1/(M+1)` uniform, because the constant term is by construction the average
   *  of the variable one. That is what makes M a calibratable dial rather than a menu: the tilt is a
   *  smooth, monotone function of a single integer, so a target edge can be solved for instead of
   *  guessed at. Integer throughout; the only division is by the living count. */
  | "mix";

/** Which quantity the weight reads.
 *
 *  `ring` is live hp — it decays as a fighter is beaten down. `stake` is the entry size and NEVER
 *  MOVES, which is the whole reason it is offered: a static weight vector can have its cumulative
 *  sums built once per `advance_fight` call instead of once per step, and that is the difference
 *  between "O(n) per step" and "O(n) per call plus a 16-entry walk". See §compute in the study. */
export type WeightBasis = "ring" | "stake";

export interface WeightSpec { kind: WeightKind; basis: WeightBasis; m?: bigint; }
export const W_UNIFORM: WeightSpec = { kind: "uniform", basis: "ring" };
export const mix = (m: bigint, basis: WeightBasis = "stake"): WeightSpec => ({ kind: "mix", basis, m });

/** Integer square root, Newton. Exact floor(sqrt(x)) for all BigInt x >= 0. */
export function isqrt(x: bigint): bigint {
  if (x < 2n) return x;
  let r = x, s = (x >> 1n) + 1n;
  while (s < r) { r = s; s = (s + x / s) >> 1n; }
  return r;
}

/** w = floor(ring^(3/4)), via floor(sqrt(ring * floor(sqrt(ring)))).
 *
 *  Not exactly ring^0.75 (two floors compound) but monotone, integer, and within a fraction of a
 *  unit at the magnitudes we run at (ring is USD micro-units, so >= 10^6 for a $1 fighter). The
 *  Rust port is the same two lines. */
export function pow34(x: bigint): bigint {
  return isqrt(x * isqrt(x));
}

/** Fill `w[0..n)` for the given kind. Returns the total weight W.
 *
 *  DEAD FIGHTERS. Under every non-uniform kind a dead fighter has ring 0 and therefore weight 0, so
 *  it is never drawn — which is a real behavioural difference from the deployed rule, where a dead
 *  fighter still absorbs 1/n of the draw and the step is wasted on a `continue`. That shortens
 *  fights under weighting, and the study reports fight length so the effect is visible rather than
 *  hidden. Under `uniform` the weight is 1 for everyone, dead included, which reproduces the
 *  deployed wastage exactly. */
function fillWeights(spec: WeightSpec, f: Fighter[], n: number, w: bigint[]): bigint {
  const { kind, basis } = spec;
  let W = 0n;
  if (kind === "uniform") {
    for (let i = 0; i < n; i++) { w[i] = 1n; }
    return BigInt(n);
  }
  // `stake` weights count a DEAD fighter's stake, because stake does not die. A step that draws a
  // dead attacker is wasted on a `continue` — which is exactly what happens under the deployed
  // uniform rule too, so the wastage is unchanged rather than newly introduced.
  const val = basis === "ring" ? (g: Fighter) => g.hp : (g: Fighter) => g.stake;
  if (kind === "cap2" || kind === "cap3" || kind === "mix") {
    let total = 0n, live = 0n;
    for (let i = 0; i < n; i++) { const v = val(f[i]); if (v > 0n) { total += v; live++; } }
    if (live === 0n) return 0n;
    const mean = total / live;
    if (kind === "mix") {
      const M = spec.m ?? 0n;
      for (let i = 0; i < n; i++) { const v = M * val(f[i]) + mean; w[i] = v; W += v; }
      return W;
    }
    const cap = (kind === "cap2" ? 2n : 3n) * mean;
    for (let i = 0; i < n; i++) { const v = val(f[i]) < cap ? val(f[i]) : cap; w[i] = v; W += v; }
    return W;
  }
  for (let i = 0; i < n; i++) {
    const r = val(f[i]);
    const v = kind === "linear" ? r : kind === "sqrt" ? isqrt(r) : pow34(r);
    w[i] = v; W += v;
  }
  return W;
}

/** True when the weight vector cannot change during a fight — i.e. it can be built once per
 *  `advance_fight` call rather than once per step. This is the compute claim, made checkable. */
export const isStatic = (s: WeightSpec) => s.kind === "uniform" || s.basis === "stake";

/** Walk the cumulative weights until `x` is consumed. O(n), branchless-ish, integer only. */
function pick(w: bigint[], n: number, x: bigint): number {
  for (let i = 0; i < n; i++) { if (x < w[i]) return i; x -= w[i]; }
  return n - 1;   // unreachable when x < W; kept so the Rust port has a total function
}

// ---------------------------------------------------------------------------------------------
// Dust
// ---------------------------------------------------------------------------------------------

export type DustRule =
  | { kind: "absolute"; units: bigint }   // the deployed rule: DUST = 1,000 units = $0.001
  | { kind: "proportional"; bps: bigint }; // die at `bps` of your ENTRY stake, whatever your size

/** The smallest floor that still guarantees a fight ends.
 *
 *  A blow registers only if `basis * roll / 100 >= 1`, and `roll >= 4`, so any ring at or below 24
 *  units can be hit forever without losing anything. The dust branch is what breaks that loop — but
 *  only if the floor sits above 24, otherwise a fighter parks in the gap and never dies. That is the
 *  original "5,000 ticks, 0 deaths, everyone stuck at hp = 3" bug, and a proportional floor could
 *  walk straight back into it: this function used to bottom out at 1.
 *
 *  It did not bite while the fused clause `hp <= floor || dmg === 0n` was doing double duty, because
 *  the second disjunct finished the stuck fighter off. Splitting that clause — which the shipped
 *  rule required, see `runFight` — removed the accidental safety net, so the floor now has to carry
 *  the guarantee itself. No study in this directory goes below `bps: 100n` against million-unit
 *  stakes, so nothing measured was affected; this stops the next `bps: 0n` row from silently
 *  reporting infinite fights. */
export const MIN_TERMINATING_FLOOR = 25n;

export function dustFloor(rule: DustRule, f: Fighter): bigint {
  if (rule.kind === "absolute") return rule.units;
  const d = (f.stake * rule.bps) / BPS;
  return d > MIN_TERMINATING_FLOOR ? d : MIN_TERMINATING_FLOOR;
}

// ---------------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------------

export type ByteLayout =
  /** The deployed layout: h[0..4] attacker (u32), h[4..8] defender (u32), h[8] roll. Only large
   *  enough for a `% n` draw — a `% W` draw against a total weight of tens of billions of
   *  micro-units would be badly biased in 32 bits, so weighted kinds require `wide`. */
  | "legacy"
  /** h[0..8] attacker (u64 LE), h[8..16] defender (u64 LE), h[16] roll. Non-overlapping, so the two
   *  draws are independent, and 17 of the hash's 32 bytes are still unused. */
  | "wide";

/** How much value a hit moves. The deployed rule reads the DEFENDER only, which is the single line
 *  that makes the fight an equaliser: what an attacker collects has nothing to do with how much the
 *  attacker staked.
 *
 *  The alternatives are O(1) — no weight table, no cumulative walk, no `% W` — which is why they are
 *  here at all. Weighted selection costs O(n) per step against a documented 1.4M-CU ceiling; changing
 *  one multiplicand costs nothing. If one of these reproduces what weighting buys, it is strictly the
 *  better mechanism.
 *
 *    defender : dmg = ring_d * roll / 100                      (deployed)
 *    min      : dmg = min(ring_a, ring_d) * roll / 100         two integer compares
 *    geo      : dmg = isqrt(ring_a * ring_d) * roll / 100      the old physics sim's shape, in u64
 */
export type DamageRule =
  | "defender" | "min" | "geo"
  /** THE O(1) DIAL. `basis = (P*ring_d + (BPS-P)*min(ring_a, ring_d)) / BPS`, one u16 knob P in
   *  BASIS POINTS.
   *
   *  Basis points rather than percent because the response is steep: P = 1% already opens a 32-point
   *  ROI spread, so a percent knob has exactly one usable setting and then falls off a cliff. In bps
   *  the usable band is P = 10..60, which is a dial rather than a switch.
   *
   *  P = 0 is `min` — measured size-neutral. P = BPS is `defender` — the deployed equaliser. In
   *  between, the tilt toward small stakes grows monotonically. One multiply, one multiply, one add,
   *  one divide by a constant; no weight table, no cumulative walk, no `% W`, no change to which hash
   *  bytes drive the draws, and no change to `MAX_STEPS_PER_CALL`. This is the mechanism the compute
   *  budget can actually afford. */
  | {
      blend: bigint;
      /** IDENTITY GATE. `"attacker"` means the blend applies to an exchange only when the ATTACKER
       *  carries `verified === 1`; every other exchange falls back to `min`, i.e. to the shipped
       *  size-neutral rule. Undefined (the default) is the ungated blend every prior study measured,
       *  so no existing config changes meaning.
       *
       *  The attacker rather than the defender because the bonus is a bigger BITE, and a bite is
       *  taken, not suffered — gating on the defender would let an unverified splitter farm verified
       *  whales, which is the opposite of the intent. */
      gate?: "attacker";
      /** BOUNDED BONUS. When set, `basis` is clamped to `capMult * min(ring_a, ring_d)`, so the most
       *  any exchange can move is `capMult` times what the size-neutral rule would move. `capMult = 1`
       *  is exactly `min` whatever P is; large `capMult` is the unclamped blend. It exists because the
       *  unclamped blend's payoff to a splitter grows without bound as the split gets finer (the
       *  smaller the attacker, the larger `ring_d / min`), and a clamp is the only structural way to
       *  bound that without an identity. Integer: one compare, one multiply. */
      capMult?: bigint;
    };

/** What to do when the defender draw lands on the attacker.
 *
 *    bump  : `if (d === a) d = (d + 1) % n`  — the pre-fix rule. Slot `a+1` absorbs every collision,
 *            so it is targeted 2/n of the time, and slot `a` gains a bonus valid attack whenever
 *            that bump lands cross-side. Whether it does depends on how the sides are laid out
 *            across the array — i.e. on ENTRY ORDER. Measured at ~11 sigma; see
 *            `check-positional-bias.ts`.
 *    shift : draw a rank in `0..n-1` and shift past `a`. Uniform over the n-1 non-attackers for
 *            every `a`, so no slot can be favoured by where it sits. The shipped rule. */
export type DefenderDraw = "bump" | "shift";

// ---------------------------------------------------------------------------------------------
// VOLATILITY KNOBS. Added for `fight-volatility.ts`, which asks a question none of the earlier
// studies asked: not "who ends up with the money" but "how much does the SCOREBOARD move on the way
// there". Every knob below is optional and every default reproduces the shipped fight exactly, so
// `parity.ts` is unaffected and no configuration written before these existed can observe them.
// ---------------------------------------------------------------------------------------------

/** ROLL >100 IS THE ONE UNSAFE REGION, and it is unsafe for a reason worth writing down rather than
 *  remembering. `dmg = basis * roll / 100` with `basis = min(ring_a, ring_d)` is followed by
 *  `if (dmg > D.hp) dmg = D.hp`. While `roll <= 100` that clamp is DEAD CODE, because
 *  `basis <= D.hp` gives `basis * roll / 100 <= D.hp` identically. Above 100 it comes alive — but
 *  ASYMMETRICALLY: when `min == D.hp` the blow is clamped, and when `min == A.hp < D.hp` it is not.
 *  A small attacker can then take more than its own ring off a big defender while a big attacker
 *  facing a small defender cannot. That is the v5 seat-law defect in a different costume, and it is
 *  measured rather than asserted in `fight-volatility.ts` part 2. */
export const ROLL_CLAMP_FREE_MAX = 100n;

/** Where a non-legacy roll takes its entropy. `legacy` drives the whole step from `h[0..9]`; `wide`
 *  from `h[0..17]`. Bytes 20..28 are untouched by BOTH, so a knobbed roll costs no rearrangement of
 *  the deployed byte layout and cannot perturb the pair draw. */
const ROLL_BYTE_LO = 20;   // u32 LE at h[20..24] — the magnitude draw
const ROLL_BYTE_SEL = 24;  // u32 LE at h[24..28] — the spike selector

export type RollSpec =
  /** The deployed die: `h[8] % 24 + 4`, i.e. 4..27 with modulo bias (`check-dice.ts`). */
  | "legacy"
  /** Uniform on `[lo, hi]` inclusive, drawn from a u32 so the modulo bias is `2^32 % m / 2^32`
   *  (< 6e-8 for any m <= 256) rather than the byte's 1-in-24.
   *
   *  THE MEAN PINS THE SUPPORT. A uniform roll with the deployed mean of 15.25 cannot reach past
   *  `hi = 2*15.25 = 30.5`, because a uniform's mean is the midpoint of its range. So "widen the die
   *  without speeding the fight up" has exactly one maximal setting, `0..31`, worth 1.34x the
   *  deployed standard deviation and no more. Anything wider is either faster (a pacing change) or
   *  skewed (a `spike`). That is not a tuning detail, it is the reason the spike form exists. */
  | { kind: "uniform"; lo: number; hi: number }
  /** Heavy tail: with probability `1/pDen` the roll is `spike`, otherwise uniform on `[lo, hi]`.
   *  Because the mass is concentrated low and the tail is rare, the mean can be held at the deployed
   *  15.25 while the standard deviation goes up several-fold — which a uniform cannot do. */
  | { kind: "spike"; pDen: number; spike: number; lo: number; hi: number };

/** Domain separator for the surge-window bit. Step cursors are bounded by the bell, 17,280 at
 *  `MAX_FIGHTERS`, so the top bit of the u64 counter is never set by a step and a window hash can
 *  never collide with a step hash. Stated as a constant rather than as a comment because the whole
 *  fairness argument for `surgeWindow` rests on the window bit being independent of the pair draw. */
export const SURGE_DOMAIN = 0x8000_0000_0000_0000n;

/** A recorded money curve. `v0[k]` is side 0's total live value (`sum(hp + banked)` over side 0)
 *  immediately after the exchange at `step[k]`; between exchanges it does not move, so recording
 *  only the exchanges is lossless rather than a sample.
 *
 *  Float64 because the pot is at most `MAX_FIGHTERS * $100 = 4.8e9` micro-units, which is exactly
 *  representable — the analysis is allowed floats, the mechanism is not. `count` is a cursor into
 *  caller-owned arrays so a study can allocate once and reuse across thousands of fights. */
export interface FightTrace { step: Int32Array; v0: Float64Array; count: number; }

/** The damage roll for this step, before any comeback scaling and before `rollCap`.
 *
 *  Kept out of the loop body so the deployed expression stays legible as one line, and so the Rust
 *  port has an obvious single function to mirror. */
function rollOf(cfg: FightConfig, h: Buffer): bigint {
  const spec = cfg.roll ?? "legacy";
  let r: bigint;
  if (spec === "legacy") {
    r = BigInt(h[cfg.layout === "legacy" ? 8 : 16] % 24) + 4n;
  } else if (spec.kind === "uniform") {
    const m = spec.hi - spec.lo + 1;
    r = BigInt(spec.lo + (h.readUInt32LE(ROLL_BYTE_LO) % m));
  } else {
    if (h.readUInt32LE(ROLL_BYTE_SEL) % spec.pDen === 0) r = BigInt(spec.spike);
    else { const m = spec.hi - spec.lo + 1; r = BigInt(spec.lo + (h.readUInt32LE(ROLL_BYTE_LO) % m)); }
  }
  const mul = cfg.rollMul;
  return mul === undefined ? r : r * mul;
}

/** The exact mean of a `RollSpec`, as an exact rational reduced to a float. Reporting a measured
 *  mean when a closed form exists is how a pacing claim rots; this makes the claim checkable. */
export function rollMean(spec: RollSpec, layoutLegacyBias = true): number {
  if (spec === "legacy") return layoutLegacyBias ? 3904 / 256 : 15.5;
  if (spec.kind === "uniform") return (spec.lo + spec.hi) / 2;
  const p = 1 / spec.pDen;
  return p * spec.spike + (1 - p) * ((spec.lo + spec.hi) / 2);
}

/** The exact standard deviation of a `RollSpec`. */
export function rollSd(spec: RollSpec): number {
  const e2 = (() => {
    if (spec === "legacy") {
      let s = 0;
      for (let b = 0; b < 256; b++) { const r = (b % 24) + 4; s += r * r; }
      return s / 256;
    }
    const uni2 = (lo: number, hi: number) => {
      let s = 0; for (let k = lo; k <= hi; k++) s += k * k; return s / (hi - lo + 1);
    };
    if (spec.kind === "uniform") return uni2(spec.lo, spec.hi);
    const p = 1 / spec.pDen;
    return p * spec.spike * spec.spike + (1 - p) * uni2(spec.lo, spec.hi);
  })();
  const m = rollMean(spec);
  return Math.sqrt(Math.max(0, e2 - m * m));
}

/** The largest roll a spec can ever produce, after `rollMul`. Anything above `ROLL_CLAMP_FREE_MAX`
 *  wakes the asymmetric clamp; the study labels such configs rather than silently capping them. */
export function rollMax(cfg: FightConfig): bigint {
  const spec = cfg.roll ?? "legacy";
  const base = spec === "legacy" ? 27n
    : spec.kind === "uniform" ? BigInt(spec.hi)
    : BigInt(Math.max(spec.spike, spec.hi));
  const m = base * (cfg.rollMul ?? 1n);
  const cap = cfg.rollCap;
  return cap !== undefined && cap < m ? cap : m;
}

export interface FightConfig {
  attacker: WeightSpec;
  defender: WeightSpec;
  dust: DustRule;
  layout: ByteLayout;
  damage?: DamageRule;
  /** Defaults to `bump` so that every config literal written before the fix still describes the
   *  fight it was written to describe. The shipped rule sets it explicitly. */
  defenderDraw?: DefenderDraw;

  // --- volatility knobs. Every one of these is undefined in every config written before them. ---

  /** Which die. Undefined is the deployed `h[8] % 24 + 4`. O(1): one u32 load, one modulo, one add. */
  roll?: RollSpec;
  /** Multiply the drawn roll. Paired with a step budget divided by the same integer this is the
   *  "fewer, bigger exchanges" knob: expected total damage is unchanged, per-exchange size is `m`x,
   *  and the number of exchanges is `1/m`x — so the aggregate swing goes as `sqrt(m)` while the
   *  compute goes as `1/m`. Undefined is 1. */
  rollMul?: bigint;
  /** Ceiling applied to the roll AFTER `rollMul` and after any comeback scaling. Set it to
   *  `ROLL_CLAMP_FREE_MAX` on any rule whose multiplier could push the roll past 100, so that the
   *  rule under test is the rule under test and not an accidental re-run of the v5 clamp defect. */
  rollCap?: bigint;

  /** CORRELATION, the efficient lever. `L` consecutive steps share a SURGE SIDE drawn from
   *  `tickHash(seed, SURGE_DOMAIN | windowIndex)`; inside the window, if the drawn attacker is not
   *  on the surge side, attacker and defender swap roles.
   *
   *  WHY IT LOOKED FREE. The surge side is a fair coin independent of the pair draw, so for any
   *  ordered pair `(i, j)` the post-swap probability is
   *  `P(sigma = side_i) * P(a=i,d=j)  +  P(sigma = side_i) * P(a=j,d=i)  =  1/2 (u + u) = u`
   *  — the MARGINAL ordered-pair distribution is not merely symmetric, it is byte-for-byte the
   *  baseline's. Only the JOINT distribution across steps changes.
   *
   *  WHY THAT IS NOT ENOUGH, and this is the finding, not a caveat. The martingale needs
   *  `E[dV_i | state] = 0` at each step, and once a window has begun its surge side is part of the
   *  state. Inside a window one side always takes, and taking and giving are not symmetric under
   *  `min`: an attacker BANKS what it wins, so its ring — and therefore its basis — does not move,
   *  while a defender's ring decays geometrically. A run of length L gains a fighter about
   *  `L * 0.1525 * ring` and costs it only `(1 - 0.8475^L) * ring`. Convexity, and it points at
   *  whoever has the smaller ring. `fight-volatility.ts` measures the resulting band spread rather
   *  than trusting either argument. Undefined or <= 1 is off. */
  surgeWindow?: number;

  /** THE RATCHET, made adjustable. Deployed, an attacker's winnings go to `banked`, which is safe
   *  forever — so every exchange moves value permanently out of the at-risk pool, the basis
   *  `min(ring_a, ring_d)` shrinks monotonically, and the scoreboard freezes long before the fight
   *  ends. `retainBps` credits that share of a hit to the attacker's RING instead.
   *
   *  It is the only knob here that keeps the fight an EXACT martingale: the basis is still
   *  `min(ring_a, ring_d)` (symmetric) and the ordered-pair draw is still uniform, so every step is
   *  still zero-mean conditional on the state — the knob changes only WHERE the winnings sit.
   *  Conservation is exact in integers: the split is `toRing = dmg * retainBps / BPS` and the
   *  remainder, including the truncated unit, goes to `banked`. Undefined is 0 = the shipped ratchet. */
  retainBps?: bigint;

  /** THE CEILING ON THAT RING, and it is what makes `retainBps` shippable rather than merely
   *  interesting. Unbounded, a high `retainBps` stops fights ENDING: rings are replenished as fast
   *  as they are drained, almost nobody reaches the dust floor, and every round runs to the bell to
   *  be settled on who was ahead. `"stake"` caps the repair at the fighter's own entry — winnings
   *  mend your ring first and only the overflow is banked — so:
   *    * total hp is still monotonically non-increasing, because the overflow always banks, and a
   *      fight therefore still terminates;
   *    * the knob self-limits, degenerating to exactly the shipped ratchet once everyone is whole;
   *    * the martingale is untouched, because none of this changes the transfer, only where the
   *      winner puts it.
   *  One compare and one min per exchange. Undefined is no ceiling. */
  retainCap?: "stake";

  /** MEAN REVERSION IN THE LEAD. The roll is scaled by `1 + k * (V_other - V_mine) / pot`, where the
   *  V's are the two sides' totals of `hp + banked` — so the side that is behind hits harder and the
   *  side that is ahead hits softer, which is the only rule here that produces a genuine see-saw
   *  rather than a wider wander.
   *
   *  It reads SIDES and never stakes, so it cannot express a size preference — but side is a free
   *  choice at entry, and a rule that pays the trailing side pays whoever joins the lighter side.
   *  That is a NEW positional edge of exactly the class §11.3 removed, and it is the test that
   *  decides this candidate (`fight-volatility.ts` part 4). O(1) per step: the two side totals are
   *  summed once per call and then moved by `+-dmg`, the same shape as a static stake weight.
   *  `k` is in bps; undefined is 0 = off. */
  comebackBps?: bigint;

  /** THE MINT VECTOR. Undefined is the single-scalar fight every measurement in this repository
   *  was taken against. Set it and the basis is read from, and the transfer applied to, the
   *  per-slot holdings vector instead. See `VectorSpec`. */
  vector?: VectorSpec;
}

/** THE SHIPPED RULE, as of the variance change. `parity.ts` asserts this is byte-identical to
 *  `engine/src/er-sim.ts`, which is itself asserted byte-identical to the Rust.
 *
 *  WHAT MOVED: the die. It was a flat 4..27 out of one byte (`h[8] % 24 + 4`); it is now a body of
 *  1..22 out of `h[20..24]` plus a spike of 90 one time in 32 out of `h[24..28]`. The reason is the
 *  operator's — "the total sum of who is winning is relatively very stable and that's a bit boring"
 *  — and the measurement is `check-variance-bell.ts`: at 48 seats over 400 seeds the standard
 *  deviation of the FINAL side-vs-side split goes from 4.19 to 5.64 points of the pot (1.34x) while
 *  the share of fights concluding before the bell goes UP, 76.3% to 77.8%.
 *
 *  The spike is 90 and not 100, and that is the whole reason this die shipped where the study's own
 *  recommendation did not: at exactly 100 `dmg = min(ring_a, ring_d)` is the defender's whole ring,
 *  i.e. a guaranteed kill, and a lineup of `n` then dies in ~`n` crits however large `n` is — while
 *  `PENALTY_HORIZON_STEPS` grows as `n^1.5`. Measured at the worst (lineup, stake) cell, median fight
 *  over horizon: shipped 1.22x, this die 1.13x, a mean-matched 1-in-16 crit of 100 **0.23x**. See
 *  `roll_of` in lib.rs for the full derivation. */
export const BASELINE: FightConfig = {
  attacker: W_UNIFORM, defender: W_UNIFORM,
  dust: { kind: "absolute", units: DUST_ABSOLUTE }, layout: "legacy",
  damage: "min", defenderDraw: "shift",
  roll: { kind: "spike", pDen: 32, spike: 90, lo: 1, hi: 22 },
};

/** THE RULE AS DEPLOYED IN v6 — everything the seat-law fix shipped, with the ORIGINAL flat 4..27
 *  die. Kept for exactly the reason `DEPLOYED_V5` is kept one paragraph down: every "before" column
 *  in HOUSE-EDGE-STUDY.md, HOUSE-STRATEGY.md, HOUSE-LIFETIME.md and HOUSE-SMALL-STAKE.md was measured
 *  against this rule, and a study whose baseline is a QUOTATION rather than a runnable configuration
 *  cannot be re-checked. `parity.ts` pins it against the golden vector that was the committed
 *  on-chain parity fixture immediately before the die changed, so it cannot rot in silence.
 *
 *  Note which knob is absent rather than which is present: `roll` is undefined, and `rollOf` reads
 *  `cfg.roll ?? "legacy"` — so this config gets `h[8] % 24 + 4`, modulo bias and all. That bias is
 *  part of what it is reproducing: the deployed die's true mean was 15.25, not the 15.5 a genuinely
 *  uniform 4..27 would give, because 256 is not a multiple of 24 (`check-dice.ts` §3). */
export const DEPLOYED_V6: FightConfig = {
  attacker: W_UNIFORM, defender: W_UNIFORM,
  dust: { kind: "absolute", units: DUST_ABSOLUTE }, layout: "legacy",
  damage: "min", defenderDraw: "shift",
};

/** THE RULE AS DEPLOYED IN v5, kept so the study's "before" column stays reproducible rather than
 *  becoming a quotation. `parity.ts` pins it against the golden vector that was the committed
 *  on-chain parity fixture before the fix, so it cannot rot silently either. */
export const DEPLOYED_V5: FightConfig = {
  attacker: W_UNIFORM, defender: W_UNIFORM,
  dust: { kind: "absolute", units: DUST_ABSOLUTE }, layout: "legacy",
  damage: "defender", defenderDraw: "bump",
};

// ---------------------------------------------------------------------------------------------
// THE MINT VECTOR. Added for G12 (ADR-001-two-mints.md), which retired every measurement in this
// directory by changing what `basis` reads.
//
// Every field below is OPTIONAL and undefined in every config written before it, so `parity.ts`
// is unaffected and no earlier configuration can observe any of this — the same convention the
// volatility knobs above follow. `cfg.vector === undefined` is the single-scalar fight, unchanged.
//
// THE MODEL, from ARCHITECTURE-N-TEAM.md §3.1: a fighter's holdings are a vector INDEXED BY ORIGIN
// MINT SLOT and denominated in VALUE UNITS (USD micro-units), not in raw token base units. A
// deposit of `amt` of mint m credits `units = amt * price[m]`; a raid moves units between fighters
// PRESERVING THE SLOT INDEX; settlement pays slot i back out as `units_i / price[i]` of mint i.
// Per-mint solvency is therefore exact by construction and the vector is a PARTITION OF A SCALAR:
// `sum(ring) === hp` and `sum(vbank) === banked` are maintained here as invariants, not as hopes.
// ---------------------------------------------------------------------------------------------

/** ARCHITECTURE-N-TEAM.md §3.2. Two is what ADR-001 buys; three is the widest arena in the spec. */
export const MAX_TOKENS = 3;

/** Fixed point for `price[i]`, in units (USD micro-units) per token BASE unit.
 *
 *  §3.1 writes the conversion as a plain `units = amt * price[m]`, which silently assumes every
 *  token's base unit is worth at least one micro-USD. It is not: UWU at $0.0033 with 6 decimals
 *  makes one base unit worth 0.0033 micro-USD, so a plain integer multiply would price the entire
 *  UWU side at zero. The scale is therefore explicit here — `units = amt * price / PRICE_SCALE` —
 *  and it is the reason ADR-001 §3's "rounding stops being free" is true: this division and its
 *  inverse at claim are the two new floors in the money path. */
export const PRICE_SCALE = 1_000_000_000_000n;

/** What a hit reads. The whole G12 question is which of these preserves the martingale. */
export type VectorBasis =
  /** `basis = min(sum(A.ring), sum(D.ring))` — the scalar rule read over the vector's TOTAL.
   *  Identically equal to `min(A.hp, D.hp)` because the vector is a partition of that scalar. */
  | "value-min"
  /** `dmg_i = min(A.ring[i], D.ring[i]) * roll / 100`, each slot settled independently. The
   *  "obvious" vector generalisation, and see `check-vector.ts` part 1 for what it does. */
  | "slot-min"
  /** `basis = min(rawA, rawD)` over RAW TOKEN BASE UNITS, price ignored — i.e. the rule you get if
   *  the holdings vector stores tokens instead of value. §3.1's "100 raw ANSEM against 100 raw UWU
   *  is not a fight, it is a mugging", made measurable. */
  | "token-min";

/** Which of the defender's slots a raid empties first, once the amount is known.
 *
 *  It cannot change HOW MUCH value moves — only its composition — so it cannot touch conservation
 *  or the martingale. It decides what the winner is holding at the bell, which is a product
 *  question and a claim-dust question, and in the EXTRACTION economy it decides nothing at all
 *  because the defender's ring is mono-slot. */
export type TakeOrder =
  /** ARCHITECTURE-N-TEAM.md §3.4(b): slots except the defender's own, by ring DESCENDING, stably
   *  (ties keep ascending slot index), then the defender's own slot last. */
  | "stolen-first"
  /** The defender's own slot first, then the rest descending. */
  | "own-first"
  /** `take_i = floor(dmg * ring_i / total)`, remainder walked off in `stolen-first` order so that
   *  exactly `dmg` moves. Costs one division PER SLOT PER EXCHANGE, which is the compute argument
   *  against it. */
  | "proportional";

export interface VectorSpec {
  /** How many mint slots exist. ADR-001 is 2. */
  mints: number;
  basis: VectorBasis;
  take: TakeOrder;
  /** `extraction` (the deployed economy — winnings go to `banked`, safe forever) or `mayhem`
   *  (winnings land in the attacker's RING and are re-raidable). ARCHITECTURE-N-TEAM.md §3.4(c).
   *  Undefined is `extraction`, which is what the live arena already is. */
  economy?: "extraction" | "mayhem";
  /** Units per token base unit, fixed point at `PRICE_SCALE`. Read ONLY by `token-min`; every
   *  other basis works in units, where the price has already been applied at credit. */
  price?: bigint[];
}

/** `sum(v)`, the total the scalar `hp`/`banked` fields mirror. */
export const vsum = (v: bigint[]): bigint => { let t = 0n; for (const x of v) t += x; return t; };

/** The order in which `take` empties the defender's slots. Returns slot indices.
 *
 *  STABILITY IS NOT PEDANTRY — §3.4(b) says so and it is right: with integer units and equal
 *  stakes, two stolen pots being exactly equal is common, not rare, so an unstable sort diverges
 *  between the mirror and the Rust on ordinary lineups rather than on contrived ones. This uses
 *  an explicit index tie-break rather than relying on `Array.prototype.sort` being stable. */
export function takeSlots(ring: bigint[], own: number, order: TakeOrder): number[] {
  const n = ring.length;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (i !== own) idx.push(i);
  idx.sort((x, y) => (ring[y] > ring[x] ? 1 : ring[y] < ring[x] ? -1 : x - y));
  return order === "own-first" ? [own, ...idx] : [...idx, own];
}

/** Move exactly `dmg` units out of `ring`, slot-preserving, writing what left into `out`.
 *
 *  Returns the amount actually moved, which is `min(dmg, sum(ring))` — the caller has already
 *  clamped, so under every rule measured here it is `dmg`. `out` is zeroed by the caller. */
/** A holdings vector's worth in RAW TOKEN BASE UNITS. Only `token-min` needs this, and needing it
 *  is the tell: it is the one rule that reaches back through the price conversion the credit step
 *  already did. */
export function rawOf(ring: bigint[], price: bigint[]): bigint {
  let t = 0n;
  for (let i = 0; i < ring.length; i++) if (ring[i] !== 0n) t += (ring[i] * PRICE_SCALE) / price[i];
  return t;
}

/** The scalar `basis` a vector rule reads, before `roll` and before any clamp. */
export function vectorBasis(vec: VectorSpec, A: Fighter, D: Fighter): bigint {
  if (vec.basis === "value-min") return A.hp < D.hp ? A.hp : D.hp;
  if (vec.basis === "slot-min") {
    let t = 0n;
    const ar = A.ring!, dr = D.ring!;
    for (let i = 0; i < vec.mints; i++) t += ar[i] < dr[i] ? ar[i] : dr[i];
    return t;
  }
  // token-min: the smaller RAW pile decides, then it is valued at the defender's own composition.
  const p = vec.price!;
  const rawA = rawOf(A.ring!, p), rawD = rawOf(D.ring!, p);
  if (rawD === 0n) return 0n;
  const lo = rawA < rawD ? rawA : rawD;
  return (D.hp * lo) / rawD;
}

function drainRing(ring: bigint[], own: number, dmg: bigint, order: TakeOrder, out: bigint[]): bigint {
  const total = vsum(ring);
  if (total === 0n || dmg <= 0n) return 0n;
  let want = dmg > total ? total : dmg;
  const slots = takeSlots(ring, own, order);
  if (order === "proportional") {
    // Floor per slot, then walk the remainder off in the same order, so exactly `want` moves and
    // no unit is created or destroyed. The unremaindered form loses up to `mints - 1` units per
    // exchange, which is a SLOW fight rather than a broken one — but it is still a rule whose
    // damage is not the damage it computed, so it is not offered.
    let moved = 0n;
    for (const s of slots) {
      const t = (want * ring[s]) / total;
      out[s] = t; ring[s] -= t; moved += t;
    }
    let rem = want - moved;
    for (const s of slots) {
      if (rem === 0n) break;
      const room = ring[s];
      const t = rem < room ? rem : room;
      out[s] += t; ring[s] -= t; rem -= t;
    }
    return want - rem;
  }
  let moved = 0n;
  for (const s of slots) {
    if (want === 0n) break;
    const room = ring[s];
    if (room === 0n) continue;
    const t = want < room ? want : room;
    out[s] = t; ring[s] -= t; want -= t; moved += t;
  }
  return moved;
}

export function tickHash(seed: Buffer, cursor: bigint): Buffer {
  const pre = Buffer.alloc(40);
  seed.copy(pre, 0, 0, 32);
  pre.writeBigUInt64LE(cursor, 32);
  return createHash("sha256").update(pre).digest();
}

const sat = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

export interface FightStats {
  steps: number;        // steps actually executed
  exchanges: number;    // steps that moved value
  endedAt: number;      // first step at which one side had nobody standing (or `steps`)
  weightPasses: number; // O(n) weight rebuilds performed — the CU story
}

/** Run `steps` steps of the fight from cursor 0. Mutates `f` in place.
 *
 *  Structure is deliberately the deployed one: same hash chain, same `d == a` bump, same three
 *  skips (same side / same wallet / either dead), same `hp * roll / 100`, same dust-finish. The only
 *  things that vary are WHO gets drawn and WHERE the dust floor sits. */
/** `stopWhenOver` is an OUTCOME-IDENTICAL optimisation, not an approximation, and the reason it is
 *  safe is worth stating because it looks like a shortcut. An exchange requires an attacker and a
 *  defender who are alive, on opposite sides, and different wallets. Once one side has nobody alive,
 *  no draw can ever satisfy that again — `dead` is never cleared — so every remaining step is a
 *  `continue` and the final hp/banked/dead vector is fixed. The chain still runs to the bell on
 *  chain; this only stops SIMULATING it. `st.steps` and `st.weightPasses` are therefore truncated
 *  when it is set, which is why the compute table in study-weights.ts runs with it OFF. */
export function runFight(f: Fighter[], seed: Buffer, steps: number, cfg: FightConfig, hashes?: (Buffer | undefined)[], stopWhenOver = false, trace?: FightTrace): FightStats {
  const n = f.length;
  const st: FightStats = { steps: 0, exchanges: 0, endedAt: steps, weightPasses: 0 };
  if (n < 2) return st;

  // Side totals of `hp + banked`, maintained incrementally. Summed once here (O(n), the same once-
  // per-call cost a static stake weight pays) and then moved by +-dmg on each exchange, so reading
  // "who is winning" costs nothing per step. `comebackBps` needs them; `trace` records them; every
  // other configuration pays two adds per exchange for them and is otherwise unaffected.
  let v0 = 0n, v1 = 0n;
  for (const g of f) { if (g.side === 0) v0 += g.hp + g.banked; else v1 += g.hp + g.banked; }
  const pot = v0 + v1;
  const comeback = cfg.comebackBps ?? 0n;
  const retain = cfg.retainBps ?? 0n;
  const retainToStake = cfg.retainCap === "stake";
  const rollCap = cfg.rollCap;
  const vec = cfg.vector;
  // Scratch for one exchange's per-slot take, allocated once per fight rather than per step.
  const take: bigint[] = vec ? new Array(vec.mints).fill(0n) : [];
  if (vec) {
    // The vector maintains `hp`/`banked` itself; a second rule that also writes them would make the
    // partition invariant a coincidence. Refuse rather than silently measure a third thing — this
    // is the same objection the `legacy` + weighted-draw guard above makes.
    if (retain !== 0n) throw new Error("cfg.vector and cfg.retainBps both move the same value — pick one");
    if (vec.basis === "token-min" && !vec.price) throw new Error("cfg.vector.basis 'token-min' needs cfg.vector.price");
    for (const g of f) {
      if (!g.ring || !g.vbank || g.slot === undefined) throw new Error(`fighter ${g.wallet} has no mint vector — use makeVFighter`);
      if (vsum(g.ring) !== g.hp || vsum(g.vbank) !== g.banked) throw new Error(`fighter ${g.wallet} enters with a vector that does not sum to its scalar`);
    }
  }
  const L = cfg.surgeWindow ?? 0;
  const surging = L > 1;
  let surgeWindowIdx = -1, surgeSide: 0 | 1 = 0;
  if (trace) trace.count = 0;

  const wa: bigint[] = new Array(n).fill(0n);
  const wd: bigint[] = new Array(n).fill(0n);
  const needA = cfg.attacker.kind !== "uniform";
  const needD = cfg.defender.kind !== "uniform";
  // The `legacy` layout reads 32-bit windows sized for a `% n` draw, so it cannot express a weighted
  // `% W` selection — the doc on `ByteLayout` says so, and this makes it true rather than said.
  // Left unenforced, `legacy` + a weighted defender + `shift` silently produces a THIRD thing:
  // a rank drawn mod n-1 and then bumped, which is neither the weighted distribution nor the shift.
  // Nothing measured is affected (every legacy config in this directory is uniform/uniform) and
  // that is exactly why it would have gone unnoticed.
  if (cfg.layout === "legacy" && (needA || needD)) {
    throw new Error("legacy layout cannot carry a weighted draw — use layout: 'wide'");
  }
  // A uniform side needs no table at all. A STAKE-based one is built once, here. A RING-based one
  // must be rebuilt every step, because ring moves every step. That three-way split is the whole
  // compute argument, and `weightPasses` counts it so the study can report it rather than assert it.
  const rebuildA = needA && !isStatic(cfg.attacker);
  const rebuildD = needD && !isStatic(cfg.defender);
  let Wa = BigInt(n), Wd = BigInt(n);
  if (!needA) fillWeights(W_UNIFORM, f, n, wa); else if (!rebuildA) { Wa = fillWeights(cfg.attacker, f, n, wa); st.weightPasses++; }
  if (!needD) fillWeights(W_UNIFORM, f, n, wd); else if (!rebuildD) { Wd = fillWeights(cfg.defender, f, n, wd); st.weightPasses++; }

  let over = false;
  for (let step = 0; step < steps; step++) {
    st.steps++;
    // The hash chain depends only on (seed, step), never on the config — so the study precomputes it
    // once per round and hands the same table to every config. That is not an optimisation for its
    // own sake: it makes every configuration face the SAME sequence of draws on the SAME lobbies,
    // which is what turns a noisy A/B into a paired comparison.
    let h: Buffer;
    if (hashes) { h = hashes[step] ?? (hashes[step] = tickHash(seed, BigInt(step))); }
    else h = tickHash(seed, BigInt(step));

    // `shift` draws the defender's rank among the n-1 fighters who are NOT the attacker, so the
    // collision it is avoiding never arises. It therefore replaces the draw itself, not just the
    // bump — which is why it is applied here rather than after.
    const shift = (cfg.defenderDraw ?? "bump") === "shift";
    let a: number, d: number;
    if (cfg.layout === "legacy") {
      a = h.readUInt32LE(0) % n;
      d = h.readUInt32LE(4) % (shift ? n - 1 : n);
    } else {
      const ra = h.readBigUInt64LE(0), rd = h.readBigUInt64LE(8);
      if (rebuildA) { Wa = fillWeights(cfg.attacker, f, n, wa); st.weightPasses++; }
      if (rebuildD) { Wd = fillWeights(cfg.defender, f, n, wd); st.weightPasses++; }
      if (Wa === 0n || Wd === 0n) continue;   // nobody left with any weight
      a = needA ? pick(wa, n, ra % Wa) : Number(ra % BigInt(n));
      // A WEIGHTED defender draw cannot use the shift: the ranks are not interchangeable, so
      // skipping one changes the distribution. It keeps the bump, and the study reports weighted
      // configs as carrying the positional bias they carry.
      d = needD ? pick(wd, n, rd % Wd) : Number(rd % BigInt(shift ? n - 1 : n));
    }
    if (shift && !needD) { if (d >= a) d += 1; }
    else if (d === a) d = (d + 1) % n;

    // SURGE. Applied to the RAW ordered pair, before any skip, because the fairness argument is
    // about the distribution of the ordered pair itself and would not survive being applied to a
    // filtered subset.
    if (surging) {
      const w = (step / L) | 0;
      if (w !== surgeWindowIdx) {
        surgeWindowIdx = w;
        surgeSide = (tickHash(seed, SURGE_DOMAIN | BigInt(w))[0] & 1) as 0 | 1;
      }
      if (f[a].side !== surgeSide) { const t = a; a = d; d = t; }
    }

    const A = f[a], D = f[d];
    if (A.side === D.side) continue;
    if (A.wallet === D.wallet) continue;
    if (A.dead === 1 || D.dead === 1) continue;

    let roll = rollOf(cfg, h);
    if (comeback !== 0n && pot > 0n) {
      // Signed: the trailing side hits harder AND the leading side hits softer, so the total damage
      // per exchange is unchanged to first order and the knob is a see-saw rather than an
      // accelerator. Floored at zero — a side ahead by the whole pot has already won.
      const mine = A.side === 0 ? v0 : v1;
      const other = A.side === 0 ? v1 : v0;
      let mult = BPS + (comeback * (other - mine)) / pot;
      if (mult < 0n) mult = 0n;
      roll = (roll * mult) / BPS;
    }
    if (rollCap !== undefined && roll > rollCap) roll = rollCap;
    let basis: bigint;
    if (vec) basis = vectorBasis(vec, A, D);
    else if (cfg.damage === "min") basis = A.hp < D.hp ? A.hp : D.hp;
    else if (cfg.damage === "geo") basis = isqrt(A.hp * D.hp);
    else if (cfg.damage && typeof cfg.damage === "object") {
      const lo = A.hp < D.hp ? A.hp : D.hp;
      // The gate is checked BEFORE the blend is computed, so an ungated exchange is arithmetically
      // identical to `damage: "min"` rather than to a blend with P forced to zero. The two agree, but
      // only one of them is obviously the shipped rule when read.
      if (cfg.damage.gate === "attacker" && A.verified !== 1) basis = lo;
      else {
        const P = cfg.damage.blend;
        basis = (P * D.hp + (BPS - P) * lo) / BPS;
        const cm = cfg.damage.capMult;
        if (cm !== undefined) { const ceil = cm * lo; if (basis > ceil) basis = ceil; }
      }
    } else basis = D.hp;
    let dmg = (basis * roll) / 100n;
    // Never take more than is there. A NO-OP under the shipped rule, and it is worth knowing exactly
    // when it stops being one: for `geo`, and for any roll above 100 — see `ROLL_CLAMP_FREE_MAX`,
    // where the asymmetry this clamp introduces is written out.
    if (dmg > D.hp) dmg = D.hp;
    const floorD = dustFloor(cfg.dust, D);
    // TERMINATION, and it keys on the DEFENDER's ring alone.
    //
    // THIS USED TO READ `if (D.hp <= floorD || dmg === 0n) dmg = D.hp;` — one branch, two meanings —
    // and that was safe only while `basis` was the defender's ring, where `dmg === 0n` could only
    // mean "the defender has almost nothing left". Under any basis that reads the ATTACKER (`min`,
    // `geo`, or the blend at small P) `dmg === 0n` ALSO means "the attacker has almost nothing
    // left", and the old branch then handed that spent attacker the defender's ENTIRE ring. A
    // 3-unit fighter — `enter` requires only `stake > 0` — one-shot a $100 whale for a 33,000,000x
    // return. The study's §2 recommendation carries this bug; the shipped rule does not.
    if (D.hp <= floorD) dmg = D.hp;
    if (dmg === 0n) continue;     // a blow too small to register moves nothing, and kills nobody

    // THE VECTOR PATH. `dmg` is already clamped to `D.hp` and to the dust floor above, so the only
    // thing left to decide is WHICH SLOTS it comes out of — except under `slot-min`, where the
    // per-slot minima ARE the damage and the scalar `dmg` was only ever their sum.
    if (vec) {
      const Dr = D.ring!, Ar = A.ring!, Ab = A.vbank!;
      for (let i = 0; i < vec.mints; i++) take[i] = 0n;
      let moved: bigint;
      if (vec.basis === "slot-min" && D.hp > floorD) {
        moved = 0n;
        for (let i = 0; i < vec.mints; i++) {
          const lo = Ar[i] < Dr[i] ? Ar[i] : Dr[i];
          const t = (lo * roll) / 100n;
          if (t === 0n) continue;
          take[i] = t; Dr[i] -= t; moved += t;
        }
      } else {
        moved = drainRing(Dr, D.slot!, dmg, vec.take, take);
      }
      // A rule can compute a blow and then find no slot to take it from — `slot-min` does this on
      // every exchange of a two-mint arena. It is a `continue`, exactly as `dmg === 0n` is, and NOT
      // a kill: the fighter is untouched and the step is spent.
      if (moved === 0n) continue;
      dmg = moved;
      D.hp -= dmg;
      if (vec.economy === "mayhem") { for (let i = 0; i < vec.mints; i++) Ar[i] += take[i]; A.hp += dmg; }
      else { for (let i = 0; i < vec.mints; i++) Ab[i] += take[i]; A.banked += dmg; }
      if (A.side === 0) { v0 += dmg; v1 -= dmg; } else { v1 += dmg; v0 -= dmg; }
      st.exchanges++;
      if (trace) { trace.step[trace.count] = step; trace.v0[trace.count] = Number(v0); trace.count++; }
      if (D.hp === 0n) {
        D.dead = 1;
        if (!over) {
          let a0 = 0, b0 = 0;
          for (const g of f) if (g.dead === 0) { if (g.side === 0) a0++; else b0++; }
          if (a0 === 0 || b0 === 0) { st.endedAt = step + 1; over = true; if (stopWhenOver) break; }
        }
      }
      continue;
    }

    D.hp = sat(D.hp, dmg);
    // THE RATCHET, or not. `retain` of the hit lands back in the attacker's ring, where it is at
    // risk again; the rest — including the unit lost to integer truncation — is banked. The sum is
    // exactly `dmg`, so conservation is unchanged by construction rather than by measurement.
    if (retain === 0n) A.banked += dmg;
    else {
      let toRing = (dmg * retain) / BPS;
      if (retainToStake) { const room = A.stake > A.hp ? A.stake - A.hp : 0n; if (toRing > room) toRing = room; }
      A.hp += toRing; A.banked += dmg - toRing;
    }
    if (A.side === 0) { v0 += dmg; v1 -= dmg; } else { v1 += dmg; v0 -= dmg; }
    st.exchanges++;
    if (trace) { trace.step[trace.count] = step; trace.v0[trace.count] = Number(v0); trace.count++; }
    if (D.hp === 0n) {
      D.dead = 1;
      if (!over) {
        let a0 = 0, b0 = 0;
        for (const g of f) if (g.dead === 0) { if (g.side === 0) a0++; else b0++; }
        if (a0 === 0 || b0 === 0) { st.endedAt = step + 1; over = true; if (stopWhenOver) break; }
      }
    }
  }
  return st;
}

/** Per-fighter settlement, per ARCHITECTURE-N-TEAM.md §3.4: "Winner remains a badge. No payout
 *  depends on it — settlement is per-fighter ring + banked". */
export const payout = (f: Fighter) => f.hp + f.banked;

/** Mirrors `settle_sides` — the badge, measured but never paid on. */
export function winnerSide(f: Fighter[]): 0 | 1 {
  let a = 0n, b = 0n;
  for (const g of f) { const v = g.hp + g.banked; if (g.side === 0) a += v; else b += v; }
  return a >= b ? 0 : 1;
}

/** `enter` with the deployed fee split: gross in, net staked, fee to the house. */
export function makeFighter(wallet: string, side: 0 | 1, gross: bigint, feeBps = FEE_BPS, verified?: 0 | 1): { f: Fighter; fee: bigint } {
  const fee = (gross * feeBps) / BPS;
  const net = gross - fee;
  return { f: { wallet, side, dead: 0, stake: net, hp: net, banked: 0n, verified }, fee };
}

/** THE CREDIT FLOOR. `amt` base units of mint `slot` become this many value units. One of the two
 *  new floor divisions ADR-001 §3 says stop being free. */
export const creditUnits = (amt: bigint, price: bigint) => (amt * price) / PRICE_SCALE;

/** THE CLAIM FLOOR, and its inverse. `units` of slot `i` redeem for this many base units of mint
 *  `i`, at the SAME frozen price the credit used — which is §3.1's whole solvency argument.
 *
 *  IT FLOORS, AND THE RESIDUE STAYS IN THE ESCROW. That is a direction change from the single-mint
 *  arena, where §11.1 measured the one rounding in the money path going the PLAYER's way. Here it
 *  goes the house's way, bounded by one base unit per occupied slot per fighter. `check-vector.ts`
 *  part 5 prices that bound instead of asserting it is small. */
export const claimTokens = (units: bigint, price: bigint) => (units * PRICE_SCALE) / price;

/** `enter` into a two-mint arena: a player sends `amtTokens` base units of the mint their SIDE
 *  settles in, the fee is taken in TOKENS (so it is mint-neutral by construction, which is the
 *  thing part 3 has to check rather than assume), and the remainder is credited into slot `slot`
 *  of a holdings vector at the round's frozen price.
 *
 *  Returns the fee in tokens as well as in units, because "the house takes 1% of gross" is a claim
 *  about tokens once there are two of them and only incidentally a claim about units. */
export function makeVFighter(
  wallet: string, side: 0 | 1, amtTokens: bigint, slot: number, price: bigint[], mints: number, feeBps = FEE_BPS,
): { f: Fighter; feeTokens: bigint; feeUnits: bigint; grossUnits: bigint } {
  const feeTokens = (amtTokens * feeBps) / BPS;
  const netTokens = amtTokens - feeTokens;
  const net = creditUnits(netTokens, price[slot]);
  const ring = new Array(mints).fill(0n); ring[slot] = net;
  const vbank = new Array(mints).fill(0n);
  return {
    f: { wallet, side, dead: 0, stake: net, hp: net, banked: 0n, ring, vbank, slot },
    feeTokens,
    feeUnits: creditUnits(feeTokens, price[slot]),
    grossUnits: creditUnits(amtTokens, price[slot]),
  };
}

/** What a fighter actually walks away with, PER MINT, in token base units — the number that decides
 *  whether the game was fair to them, because it is the only one they can spend.
 *
 *  `ring + banked` per slot, then one floor division per slot. Value that never left their own slot
 *  redeems in their own token; value they raided redeems in whoever's token they took it from. */
export function claimOf(f: Fighter, price: bigint[]): bigint[] {
  const out: bigint[] = [];
  for (let i = 0; i < f.ring!.length; i++) out.push(claimTokens(f.ring![i] + f.vbank![i], price[i]));
  return out;
}
