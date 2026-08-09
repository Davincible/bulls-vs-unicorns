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
  winner: 0 | 1 | null;
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
 *  = round(25 × n^1.5), measured this session against this very module: 400 seeds per lineup size,
 *  equal stakes, counting steps until one side has nobody standing. A fight's length is ~n^1.5, and
 *  per-fighter pacing only divides that by n — so the horizon has to scale with the lineup or a duel
 *  (median 19.5s) and a sixteen-way (median 54.4s) cannot share one curve. Again: the Rust constant
 *  carries the measurement table and the reasoning; this is its mirror, and
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
}

/** Mirrors `tick`. Deterministic from (seed, tickCount) alone — no clock, no slot, no ordering. */
export function tick(round: ERRound, steps: number): void {
  for (let s = 0; s < steps; s++) {
    const n = round.fighters.length;
    if (n < 2) break;
    const cursor = round.tickCount;
    round.tickCount += 1n;

    const h = tickHash(round.seed, cursor);
    const a = h.readUInt32LE(0) % n;
    let d = h.readUInt32LE(4) % n;
    if (d === a) d = (d + 1) % n;

    const A = round.fighters[a], D = round.fighters[d];
    if (A.side === D.side) continue;        // never your own team
    if (A.wallet === D.wallet) continue;    // never yourself, even across sides
    if (A.dead === 1 || D.dead === 1) continue;

    const roll = BigInt(h[8] % 24) + 4n;    // 4..27 percent of remaining hp
    let dmg = (D.hp * roll) / 100n;
    // finish off dust rather than chasing an asymptote forever
    if (D.hp <= DUST || dmg === 0n) dmg = D.hp;
    if (dmg === 0n) continue;               // genuinely nothing left to take

    D.hp = sat(D.hp, dmg);
    A.banked += dmg;
    if (D.hp === 0n) D.dead = 1;
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
  return { seed, fighters: [], tickCount: 0n, pot: 0n, penaltiesCollected: 0n, winner: null };
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

/** THE invariant, with the leak accounted for: what fighters hold, plus what the house has taken, is
 *  exactly what was staked. Damage moves value, extraction moves value and skims it — neither
 *  creates nor destroys any. A break here is an economics bug, in one line. */
export function conservationHolds(round: ERRound): boolean {
  return totalValue(round) + round.penaltiesCollected === round.pot;
}
