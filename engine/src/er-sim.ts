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
  return { seed, fighters: [], tickCount: 0n, pot: 0n, winner: null };
}

/** Total value in play. Should never change once the fight starts — damage MOVES value, it does not
 *  create or destroy it. This is the invariant that catches an economics bug in one line. */
export function totalValue(round: ERRound): bigint {
  return round.fighters.reduce((n, f) => n + f.hp + f.banked, 0n);
}
