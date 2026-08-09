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
export const MAX_FIGHTERS = 16;
export const DUST_ABSOLUTE = 1_000n;      // the deployed constant
export const UNITS_PER_USD = 1_000_000n;  // er-demo/src/v2/contract.ts
export const FEE_BPS = 20n;               // the deployed arena fee, 0.2%

/** Deployed pacing: `canonical_cursor` = elapsed × 2 × fighter_count, saturating at MAX_STEPS. */
export const MAX_STEPS = 4_000;
export const FIGHT_TIMEOUT_SECONDS = 120;
export const STEPS_PER_FIGHTER_PER_SECOND = 2;
export const stepBudget = (n: number) =>
  Math.min(MAX_STEPS, FIGHT_TIMEOUT_SECONDS * STEPS_PER_FIGHTER_PER_SECOND * n);

export interface Fighter {
  wallet: string;
  side: 0 | 1;
  dead: 0 | 1;
  stake: bigint;   // net of fee — what they put in, and their starting hp
  hp: bigint;      // value still in the ring
  banked: bigint;  // value raided off someone else; never at risk again
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

export function dustFloor(rule: DustRule, f: Fighter): bigint {
  if (rule.kind === "absolute") return rule.units;
  const d = (f.stake * rule.bps) / BPS;
  return d > 0n ? d : 1n;
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
   *  bytes drive the draws, and no change to `MAX_STEPS`. This is the mechanism the compute budget
   *  can actually afford. */
  | { blend: bigint };

export interface FightConfig {
  attacker: WeightSpec;
  defender: WeightSpec;
  dust: DustRule;
  layout: ByteLayout;
  damage?: DamageRule;
}

export const BASELINE: FightConfig = {
  attacker: W_UNIFORM, defender: W_UNIFORM,
  dust: { kind: "absolute", units: DUST_ABSOLUTE }, layout: "legacy",
};

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
export function runFight(f: Fighter[], seed: Buffer, steps: number, cfg: FightConfig, hashes?: (Buffer | undefined)[], stopWhenOver = false): FightStats {
  const n = f.length;
  const st: FightStats = { steps: 0, exchanges: 0, endedAt: steps, weightPasses: 0 };
  if (n < 2) return st;

  const wa: bigint[] = new Array(n).fill(0n);
  const wd: bigint[] = new Array(n).fill(0n);
  const needA = cfg.attacker.kind !== "uniform";
  const needD = cfg.defender.kind !== "uniform";
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

    let a: number, d: number;
    if (cfg.layout === "legacy") {
      a = h.readUInt32LE(0) % n;
      d = h.readUInt32LE(4) % n;
    } else {
      const ra = h.readBigUInt64LE(0), rd = h.readBigUInt64LE(8);
      if (rebuildA) { Wa = fillWeights(cfg.attacker, f, n, wa); st.weightPasses++; }
      if (rebuildD) { Wd = fillWeights(cfg.defender, f, n, wd); st.weightPasses++; }
      if (Wa === 0n || Wd === 0n) continue;   // nobody left with any weight
      a = needA ? pick(wa, n, ra % Wa) : Number(ra % BigInt(n));
      d = needD ? pick(wd, n, rd % Wd) : Number(rd % BigInt(n));
    }
    if (d === a) d = (d + 1) % n;

    const A = f[a], D = f[d];
    if (A.side === D.side) continue;
    if (A.wallet === D.wallet) continue;
    if (A.dead === 1 || D.dead === 1) continue;

    const roll = BigInt(h[cfg.layout === "legacy" ? 8 : 16] % 24) + 4n;
    let basis: bigint;
    if (cfg.damage === "min") basis = A.hp < D.hp ? A.hp : D.hp;
    else if (cfg.damage === "geo") basis = isqrt(A.hp * D.hp);
    else if (cfg.damage && typeof cfg.damage === "object") {
      const P = cfg.damage.blend, lo = A.hp < D.hp ? A.hp : D.hp;
      basis = (P * D.hp + (BPS - P) * lo) / BPS;
    } else basis = D.hp;
    let dmg = (basis * roll) / 100n;
    if (dmg > D.hp) dmg = D.hp;   // never take more than is there; a no-op for the deployed rule
    const floorD = dustFloor(cfg.dust, D);
    if (D.hp <= floorD || dmg === 0n) dmg = D.hp;
    if (dmg === 0n) continue;

    D.hp = sat(D.hp, dmg);
    A.banked += dmg;
    st.exchanges++;
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
export function makeFighter(wallet: string, side: 0 | 1, gross: bigint, feeBps = FEE_BPS): { f: Fighter; fee: bigint } {
  const fee = (gross * feeBps) / BPS;
  const net = gross - fee;
  return { f: { wallet, side, dead: 0, stake: net, hp: net, banked: 0n }, fee };
}
