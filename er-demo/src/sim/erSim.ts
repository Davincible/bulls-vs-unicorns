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

    onHit?.({ step: cursor, attackerId: a, defenderId: d, amount: dmg });
  }
}

/** Mirrors `extract` — a player pulls out mid-fight.
 *
 *  This is the mechanic that makes the rollup load-bearing: without mid-fight input the outcome is a
 *  pure function of (seed, entries) and nothing needs 10ms blocks. With it, WHEN a human presses the
 *  button changes the result, so the fight cannot be precomputed.
 *
 *  Value MOVES from the ring to the bank — never created. That is the entire risk/reward decision:
 *  give up the chance to take more, in exchange for keeping what you have. */
export function extract(round: ERRound, wallet: string): bigint {
  const f = round.fighters.find(x => x.wallet === wallet && x.dead === 0 && x.hp > 0n);
  if (!f) throw new Error("NothingToExtract");
  const taken = f.hp;
  f.banked += taken;
  f.hp = 0n;
  f.dead = 1;          // out of the ring, no longer a valid target
  return taken;
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
