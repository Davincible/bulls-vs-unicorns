// Reference implementation of the ON-CHAIN round algorithm, in TypeScript.
//
// This is a line-for-line mirror of `programs/bulls-arena/src/lib.rs` — the same hash chain, the
// same attacker/defender selection, the same damage roll, the same settlement rule.
//
// WHY IT EXISTS. The Rust program cannot be compiled on this machine (see MEGA_QUEUE.md ER-010: no
// Windows SDK, no admin), so it has never run. That does not have to mean the algorithm is
// unverified — the algorithm is arithmetic, and arithmetic can be checked here. This module lets the
// properties that actually matter be tested now: determinism, conservation, no self-dealing, and
// convergence.
//
// It is also the parity oracle for ER-051. When the program does compile, the Rust and this must
// produce byte-identical settlement from the same (seed, entries). If they diverge, the on-chain
// game is not the game players have been watching — which is the single worst outcome of this
// migration and the reason parity is a queue item rather than an afterthought.
//
// Kept deliberately close to the Rust, including its integer semantics: u64 via BigInt, saturating
// subtraction, floor division. Idiomatic TypeScript here would be a different program.
//
// PORT NOTE (er-demo/src/sim/erSim.ts): this is a verbatim copy of engine/src/er-sim.ts, kept in
// sync by hand — er-demo is a standalone app that intentionally does not cross-import from engine/
// (see docs/blueprint plan `snug-floating-mitten.md`). The one addition versus the original is the
// optional `onHit` callback on `tick()`, used by `hitEvents.ts` to capture the ordered sequence of
// real exchanges for rendering — see the comment on `tick()` below for why it's a callback and not
// a second copy of this loop.
//
// RUNTIME CAVEAT, not yet resolved: this module is verified here under Vitest/Node (node:crypto,
// Buffer — both real there) and is meant to also run client-side in the actual browser, both for
// hitEvents precompute (Phase 4) and for VerifyPanel's independent re-verification (Phase 5). A
// Vite browser bundle does NOT have `node:crypto` or `Buffer` for free. Whoever picks up Phase 4/5
// needs to either add a browser polyfill for both, or replace `tickHash`'s sha256 with Web Crypto's
// `crypto.subtle.digest` (which is async — that would ripple `tickHash`/`tick`'s signatures, a real
// design decision, not something to sneak in here while the task at hand is a verbatim port).
// `tsc -b` type-checks today only because "node" was added to tsconfig.app.json's `types`; that
// fixes compilation, not the browser runtime gap described above.

import { createHash } from "node:crypto";

export interface ERFighter {
  wallet: string;
  side: 0 | 1;
  dead: 0 | 1;
  stake: bigint;   // net of fee
  hp: bigint;      // value still in the ring
  banked: bigint;  // value raided from the other side
}

export interface ERRound {
  seed: Buffer;
  fighters: ERFighter[];
  tickCount: bigint;
  pot: bigint;
  /** Extract penalties that have LEFT this round for the house, cumulative — mirrors
   *  `Round.penalties_collected`. Value no longer simply moves between fighters, so conservation is
   *  `totalValue(round) + penaltiesCollected === pot`; see `totalValue`. */
  penaltiesCollected: bigint;
  /** The entry fee this round has charged, cumulative over every `enter` including top-ups — mirrors
   *  `Round.fees_collected`.
   *
   *  IT IS RECORDED HERE, NOT SUPPLIED, because `enter` below computes it: this mirror takes GROSS
   *  stakes and does the same `stake × feeBps / BPS` split the Rust does, so the fee is an output of
   *  replaying the round, exactly as on chain. It carried the same bug too — the fee was computed,
   *  subtracted, and dropped on the floor — and it is fixed here in the same shape as the fix in
   *  `credit_entry`, because a mirror that quietly disagreed about where the money went would be
   *  worse than no mirror.
   *
   *  It does NOT enter the ring, so it is not part of the pot and cancels out of conservation; see
   *  `conservationHolds`. */
  feesCollected: bigint;
  winner: 0 | 1 | null;
}

/** One real exchange produced by `tick()` — the attacker took `amount` from the defender's hp on
 *  step `step`. Only emitted for actual exchanges: misses, self-trades, same-side pairs, and
 *  dead-target picks never reach here (tick() `continue`s past those before any value moves). This
 *  is what `hitEvents.ts` collects to drive rendering — order matters, it IS the fight. */
export interface HitEvent {
  step: bigint;
  attackerId: number;
  defenderId: number;
  amount: bigint;
}

export const BPS = 10_000n;
export const MAX_FIGHTERS = 16;   // mirrors the Rust — see the stack-limit note there

/** Below this, a fighter is finished off rather than left to decay.
 *
 *  Damage is a PERCENTAGE of remaining hp, which is exponential decay: it approaches zero and never
 *  arrives. Worse, integer division floors it to 0 while hp is still positive, so `dmg == 0` skips
 *  the exchange and the fight runs forever with everyone alive. Measured: 5,000 ticks, 0 deaths,
 *  every fighter stuck at hp = 3.
 *
 *  A dust floor makes the round terminate: once a fighter is down to dust the remainder transfers
 *  in one blow and they die. Value is still conserved — the remainder MOVES, it is not deleted. */
export const DUST = 1_000n;

/** What extracting costs at the opening bell, in basis points — 20%, decaying linearly to nothing
 *  over `PENALTY_HORIZON_STEPS`.
 *
 *  Without it, "enter, let one tick land, leave" was a near-riskless option priced at nothing: one
 *  step of a 236-step fight costs you no hp, so you left holding ~99% of your stake. The penalty
 *  DECAYS because the option does — what you give up by leaving is the rest of the fight, which is
 *  everything at the start and nothing at the end. See the Rust constant of the same name for the
 *  full reasoning and the alternatives rejected. */
export const EXTRACT_PENALTY_START_BPS = 2_000n;

/** The cursor at which extracting becomes free, indexed by `fighterCount - 2` (so 2..16 fighters).
 *
 *  = round(25 × n^1.5), measured against this very module: 400 seeds per lineup size, equal stakes,
 *  counting steps until one side has nobody standing. A fight's length is ~n^1.5, and per-fighter
 *  pacing only divides that by n — so the horizon has to scale with the lineup or a duel (median
 *  19.5s) and a sixteen-way (median 54.4s) cannot share one curve. Again: the Rust constant carries
 *  the measurement table and the reasoning; this is its mirror, and
 *  `parity_tests::the_typescript_mirrors_carry_the_same_penalty_curve` parses these very numbers out
 *  of this file and fails if they ever stop matching. */
export const PENALTY_HORIZON_STEPS = [
  71, 130, 200, 280, 367,             // n = 2..6
  463, 566, 675, 791, 912,            // n = 7..11
  1_039, 1_172, 1_310, 1_452, 1_600,  // n = 12..16
] as const;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Mirrors `penalty_horizon_steps`. */
export function penaltyHorizonSteps(fighterCount: number): bigint {
  return BigInt(PENALTY_HORIZON_STEPS[clamp(fighterCount, 2, MAX_FIGHTERS) - 2]);
}

/** Mirrors `extract_penalty_bps`: linear from `EXTRACT_PENALTY_START_BPS` to zero across the
 *  horizon, and zero from there on. Floor division, exactly as the Rust's integer arithmetic does. */
export function extractPenaltyBps(fighterCount: number, cursor: bigint): bigint {
  const horizon = penaltyHorizonSteps(fighterCount);
  const remaining = cursor >= horizon ? 0n : horizon - cursor;
  return (EXTRACT_PENALTY_START_BPS * remaining) / horizon;
}

/** Mirrors `split_extraction` — what a fighter KEEPS and what the house takes, from what left the
 *  ring. BigInt has no width, so the Rust's `u128` intermediate needs no counterpart here; the
 *  floor division is what has to match, and does. */
export function splitExtraction(taken: bigint, fighterCount: number, cursor: bigint): { kept: bigint; penalty: bigint } {
  const penalty = (taken * extractPenaltyBps(fighterCount, cursor)) / BPS;
  return { kept: taken - penalty, penalty };
}

const sat = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

/** sha256(seed ++ le_u64(cursor)) — the Rust builds the same 40-byte preimage. */
export function tickHash(seed: Buffer, cursor: bigint): Buffer {
  const pre = Buffer.alloc(40);
  seed.copy(pre, 0, 0, 32);
  pre.writeBigUInt64LE(cursor, 32);
  return createHash("sha256").update(pre).digest();
}

/** Mirrors `enter`: fee taken here, a repeat entry on the same side TOPS UP rather than duplicating. */
export function enter(round: ERRound, wallet: string, side: 0 | 1, stake: bigint, feeBps: bigint): void {
  if (stake <= 0n) throw new Error("ZeroStake");
  const fee = (stake * feeBps) / BPS;
  const net = stake - fee;
  const existing = round.fighters.find(f => f.wallet === wallet && f.side === side);
  if (existing) {
    existing.stake += net;
    existing.hp += net;
  } else {
    if (round.fighters.length >= MAX_FIGHTERS) throw new Error("RoundFull");
    round.fighters.push({ wallet, side, dead: 0, stake: net, hp: net, banked: 0n });
  }
  round.pot += net;
  // The house's cut, RECORDED rather than merely subtracted — mirrors the same line in
  // `credit_entry`. Outside the find-or-insert on purpose: a top-up pays the fee too, and a counter
  // bumped only on the `else` branch above would be right for every first entry and silently short
  // for every round anyone added to.
  round.feesCollected += fee;
}

/** Mirrors `draw_pair`: an attacker, and a defender who is never the attacker.
 *
 *  Uniform over all `n * (n - 1)` ORDERED pairs of distinct slots. Requires `n >= 2`, which `tick`
 *  guarantees before calling.
 *
 *  IT USED TO BE `let d = h.readUInt32LE(4) % n; if (d === a) d = (d + 1) % n;` and that was a
 *  measured, ~11-sigma bias on ENTRY ORDER. Re-rolling a collision onto `a + 1` is not a re-draw: it
 *  targets slot `a + 1` twice as often as anyone else, and hands slot `a` a bonus valid attack
 *  whenever that bump lands cross-side — which depends purely on how the two sides are laid out
 *  across the array, i.e. on which transaction confirmed first. With eight fighters all staking $10
 *  and each side arriving as a block, slots 3 and 7 earned +15% while slots 0 and 4 died 90% of the
 *  time against 64% for everyone else.
 *
 *  Drawing a rank among the `n - 1` fighters who are NOT the attacker and shifting it past `a` gives
 *  every non-attacker exactly one rank, so no slot can be favoured by where it sits. See the Rust
 *  for the full reasoning; this is its mirror. */
export function drawPair(h: Buffer, n: number): [number, number] {
  // The Rust counterpart is private and would panic on the `% 0`. This one is exported, so it says
  // so out loud instead of returning `[0, NaN]` and failing several frames later at `fighters[NaN]`.
  if (n < 2) throw new Error(`drawPair requires n >= 2, got ${n}`);
  const a = h.readUInt32LE(0) % n;
  let d = h.readUInt32LE(4) % (n - 1);
  if (d >= a) d += 1;
  return [a, d];
}

/** Mirrors `tick`. Deterministic from (seed, tickCount) alone — no clock, no slot, no ordering.
 *
 *  `onHit` is an optional observer, not a second implementation: `hitEvents.ts` needs the ORDERED
 *  sequence of real exchanges to drive rendering, but re-deriving that sequence by re-implementing
 *  this loop elsewhere would be exactly the kind of drift risk that produced the DUST-floor bug
 *  above in the first place (two copies of the same logic, one of them stale). So the loop stays
 *  here, single-sourced, and simply reports each exchange as it happens. Omitting the callback
 *  (the original call shape) is unchanged — this mirrors the Rust `run_fight()` either way. */
export function tick(round: ERRound, steps: number, onHit?: (event: HitEvent) => void): void {
  for (let s = 0; s < steps; s++) {
    const n = round.fighters.length;
    if (n < 2) break;
    const cursor = round.tickCount;
    round.tickCount += 1n;

    const h = tickHash(round.seed, cursor);
    const [a, d] = drawPair(h, n);

    const A = round.fighters[a], D = round.fighters[d];
    if (A.side === D.side) continue;        // never your own team
    if (A.wallet === D.wallet) continue;    // never yourself, even across sides
    if (A.dead === 1 || D.dead === 1) continue;

    const roll = BigInt(h[8] % 24) + 4n;    // 4..27 percent of the SMALLER of the two rings
    // You cannot take more than you brought. Reading the defender alone made an attacker's take
    // independent of their own stake — deposits bought nothing and seats bought everything, which
    // an $80 budget split across eight wallets farmed for ~$152/round. See the Rust for the full
    // reasoning and HOUSE-EDGE-STUDY.md §0 for the measurement.
    const basis = A.hp < D.hp ? A.hp : D.hp;
    let dmg = (basis * roll) / 100n;
    // TERMINATION: finish off a dust DEFENDER rather than chasing an asymptote forever.
    if (D.hp <= DUST) dmg = D.hp;
    // A blow too small to register moves nothing — and is NOT a kill. These two used to share a
    // branch (`D.hp <= DUST || dmg === 0n`), which was only safe while `basis` was the defender's
    // ring. With `basis` reading the attacker, `dmg === 0n` also means "the ATTACKER is spent", and
    // the old form handed that spent attacker the defender's entire ring.
    if (dmg === 0n) continue;

    D.hp = sat(D.hp, dmg);
    A.banked += dmg;
    if (D.hp === 0n) D.dead = 1;

    onHit?.({ step: cursor, attackerId: a, defenderId: d, amount: dmg });
  }
}

/** Mirrors `extract` — a player pulls out mid-fight.
 *
 *  This is the mechanic that makes the rollup load-bearing: without mid-fight input the outcome is a
 *  pure function of (seed, entries) and nothing needs 10ms blocks. With it, WHEN a human presses the
 *  button changes the result, so the fight cannot be precomputed.
 *
 *  Value MOVES from the ring — never created — but it now moves in TWO directions: most of it to the
 *  fighter's own bank, and a decaying slice out of the round entirely, to the house
 *  (`penaltiesCollected`). That is the whole risk/reward decision: give up the chance to take more,
 *  pay for the privilege of being certain, and pay less the longer you were willing to stand there.
 *
 *  Takes `cursor` from `round.tickCount`, which is where the fight actually stands — the Rust reads
 *  it after its own `catch_up`, so a caller mirroring the chain must tick to the current cursor
 *  BEFORE calling this, exactly as the on-chain instruction does for itself.
 *
 *  Returns all three numbers rather than just the payout: `taken` is gross (what left the ring),
 *  `kept` is what reached the bank, `penalty` is what the house took. The old signature returned a
 *  bare `taken`, which is now the one number that does NOT tell a caller what the player received. */
export function extract(round: ERRound, wallet: string): { taken: bigint; kept: bigint; penalty: bigint } {
  const f = round.fighters.find(x => x.wallet === wallet && x.dead === 0 && x.hp > 0n);
  if (!f) throw new Error("NothingToExtract");
  const taken = f.hp;
  const { kept, penalty } = splitExtraction(taken, round.fighters.length, round.tickCount);
  f.banked += kept;
  f.hp = 0n;
  f.dead = 1;          // out of the ring, no longer a valid target
  round.penaltiesCollected += penalty;
  return { taken, kept, penalty };
}

/** Mirrors `settle`: side value is hp + banked; ties go to side A, exactly as the Rust does. */
export function settle(round: ERRound): 0 | 1 {
  let a = 0n, b = 0n;
  for (const f of round.fighters) {
    const v = f.hp + f.banked;
    if (f.side === 0) a += v; else b += v;
  }
  round.winner = a >= b ? 0 : 1;
  return round.winner;
}

export function newRound(seed: Buffer): ERRound {
  return { seed, fighters: [], tickCount: 0n, pot: 0n, penaltiesCollected: 0n, feesCollected: 0n, winner: null };
}

/** Total value still IN PLAY — held by fighters, in the ring or in the bank.
 *
 *  This is no longer the same thing as the pot. `tick` only ever moves value between fighters, so it
 *  cannot change this; `extract` moves a slice of it out of the round to the house, so it can and
 *  does. Use `conservationHolds` for the invariant — this function on its own now answers "what is
 *  still on the table", which is a different and also useful question. */
export function totalValue(round: ERRound): bigint {
  return round.fighters.reduce((n, f) => n + f.hp + f.banked, 0n);
}

/** The whole of the house's take from this round — mirrors the Rust's `house_took`. */
export function houseTook(round: ERRound): bigint {
  return round.penaltiesCollected + round.feesCollected;
}

/** What players were actually charged to be here — mirrors the Rust's `gross_deposits`. `pot` is the
 *  sum of NET stakes, so it is what is being fought over, not what was paid. */
export function grossDeposits(round: ERRound): bigint {
  return round.pot + round.feesCollected;
}

/** THE invariant, with both leaks accounted for: what fighters hold, plus what the house has taken,
 *  is exactly what players were charged. Damage moves value, extraction moves value and skims it —
 *  neither creates nor destroys any. A break here is an economics bug, in one line.
 *
 *  ONE OF THE TWO TERMS IS LOAD-BEARING AND THE OTHER IS NOT, and conflating them would be a way of
 *  claiming more than this function can deliver. `penaltiesCollected` is money that left the RING, so
 *  it genuinely closes a gap: drop it and this returns false on every round anyone extracted from.
 *  `feesCollected` never entered the ring — `enter` credits the fighter the net — so it appears on
 *  both sides here and cancels; this function would return exactly the same booleans with the fee
 *  term deleted from both `houseTook` and `grossDeposits`. It is stated in gross terms anyway because
 *  the gross is the sentence that is true about what players paid, and because every verifier in the
 *  repo now says it the same way.
 *
 *  So this does not test that the fee was recorded correctly and must not be relied on to. What does
 *  is `enter` asserted against a known gross stake — see `engine/src/tests/er-sim.test.ts`, and
 *  `the_fee_is_recorded_rather_than_discarded` in lib.rs, which makes the same point about the same
 *  cancellation. */
export function conservationHolds(round: ERRound): boolean {
  return totalValue(round) + houseTook(round) === grossDeposits(round);
}
