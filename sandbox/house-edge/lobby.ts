// SANDBOX. Lobby generation + the accounting every study script shares.

import { createHash } from "node:crypto";
import { mulberry32 } from "./rng.ts";
import { makeFighter, UNITS_PER_USD, tickHash, stepBudget } from "./fight-variant.ts";
import type { Fighter } from "./fight-variant.ts";

/** The stake bands `engine/src/study.ts` and ARENAS.md already use, in USD. Kept identical so the
 *  two tables can be read side by side — that comparability is the only reason not to pick rounder
 *  numbers. */
export const BANDS = [
  { name: "whale  ($80-100)", lo: 80, hi: 100 },
  { name: "big    ($50-80) ", lo: 50, hi: 80 },
  { name: "medium ($20-50) ", lo: 20, hi: 50 },
  { name: "small  ($8-20)  ", lo: 8, hi: 20 },
  { name: "minnow ($3-8)   ", lo: 3, hi: 8 },
] as const;

export interface Entry { wallet: string; side: 0 | 1; grossUnits: bigint; band: number; house: boolean; }
export interface Lobby { seed: Buffer; entries: Entry[]; hashes: Buffer[]; steps: number; }

/** USD -> integer micro-units, the on-chain denomination (er-demo/src/v2/contract.ts). */
export const usd = (v: number) => BigInt(Math.round(v * 1e6));

/** One lobby, reproducible from (studySeed, roundIndex) alone.
 *
 *  The FIGHT seed is sha256("he|<studySeed>|<round>") and the hash table is precomputed here, so
 *  every configuration under test sees the identical lobby AND the identical draw sequence — common
 *  random numbers. Differences between configs are then paired, and their standard errors are one to
 *  two orders of magnitude smaller than independent sampling would give. */
export function makeLobby(studySeed: string, round: number, perSide: number): Lobby {
  const rnd = mulberry32(hash32(`${studySeed}|lobby|${round}`));
  const entries: Entry[] = [];
  let id = 0;
  for (const side of [0, 1] as const) {
    for (let i = 0; i < perSide; i++) {
      const b = Math.floor(rnd() * BANDS.length);
      const band = BANDS[b];
      entries.push({
        wallet: `w${++id}`, side,
        grossUnits: usd(band.lo + rnd() * (band.hi - band.lo)),
        band: b, house: false,
      });
    }
  }
  return finish(studySeed, round, entries);
}

export function finish(studySeed: string, round: number, entries: Entry[]): Lobby {
  const seed = createHash("sha256").update(`he|${studySeed}|${round}`).digest();
  const steps = stepBudget(entries.length);
  const hashes: Buffer[] = new Array(steps);
  for (let s = 0; s < steps; s++) hashes[s] = tickHash(seed, BigInt(s));
  return { seed, entries, hashes, steps };
}

export function fightersOf(l: Lobby): { fighters: Fighter[]; fees: bigint } {
  const fighters: Fighter[] = [];
  let fees = 0n;
  for (const e of l.entries) {
    const { f, fee } = makeFighter(e.wallet, e.side, e.grossUnits);
    fighters.push(f); fees += fee;
  }
  return { fighters, fees };
}

function hash32(s: string): number {
  const d = createHash("sha256").update(s).digest();
  return d.readUInt32LE(0);
}

// ------------------------------------------------------------------------------------------------
// Statistics. Floats live HERE and only here — never on the path from a hash to a damage number.
// ------------------------------------------------------------------------------------------------

/** Ratio-of-sums ROI with a bootstrap standard error over ROUNDS (not over entries).
 *
 *  Rounds are the independent unit: two fighters in the same round are not independent observations,
 *  because one's gain is literally the other's loss. Bootstrapping entries would understate the
 *  error by roughly sqrt(fighters-per-round). */
export function roiWithSE(perRound: { inn: number; out: number }[], resamples = 2000, seed = 1): { roi: number; se: number; n: number } {
  const n = perRound.length;
  let I = 0, O = 0;
  for (const r of perRound) { I += r.inn; O += r.out; }
  const roi = I > 0 ? O / I - 1 : 0;
  const rnd = mulberry32(seed);
  const draws: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let bi = 0, bo = 0;
    for (let k = 0; k < n; k++) { const j = Math.floor(rnd() * n); bi += perRound[j].inn; bo += perRound[j].out; }
    if (bi > 0) draws.push(bo / bi - 1);
  }
  const m = draws.reduce((a, x) => a + x, 0) / draws.length;
  const v = draws.reduce((a, x) => a + (x - m) * (x - m), 0) / (draws.length - 1);
  return { roi, se: Math.sqrt(v), n };
}

/** Paired bootstrap of a DIFFERENCE between two configs measured on the same rounds. */
export function diffWithSE(a: { inn: number; out: number }[], b: { inn: number; out: number }[], resamples = 2000, seed = 7) {
  const n = a.length;
  const point = (Σ(a, "out") / Σ(a, "inn") - 1) - (Σ(b, "out") / Σ(b, "inn") - 1);
  const rnd = mulberry32(seed);
  const draws: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let ai = 0, ao = 0, bi = 0, bo = 0;
    for (let k = 0; k < n; k++) {
      const j = Math.floor(rnd() * n);
      ai += a[j].inn; ao += a[j].out; bi += b[j].inn; bo += b[j].out;
    }
    if (ai > 0 && bi > 0) draws.push((ao / ai - 1) - (bo / bi - 1));
  }
  const m = draws.reduce((x, y) => x + y, 0) / draws.length;
  const v = draws.reduce((x, y) => x + (y - m) * (y - m), 0) / (draws.length - 1);
  return { diff: point, se: Math.sqrt(v) };
}

const Σ = (rs: { inn: number; out: number }[], k: "inn" | "out") => rs.reduce((a, r) => a + r[k], 0);

export const toUsd = (u: bigint) => Number(u) / Number(UNITS_PER_USD);
export const pct = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;
