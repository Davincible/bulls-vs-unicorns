// SANDBOX. Run from engine/:  npx tsx ../sandbox/house-edge/strategy-sensitivity.ts [rounds]
//
// WHICH DIAL ACTUALLY CONTROLS THE HOUSE'S EDGE — ranked, on identical draws.
//
// Five candidate dials:
//   1. `Arena.fee_bps`                  — live, settable without a deploy, bounded by MAX_FEE_BPS=1000
//   2. `EXTRACT_PENALTY_START_BPS`      — a compile-time const (2,000). Needs a deploy to move.
//   3. `PENALTY_HORIZON_STEPS`          — a compile-time table. Needs a deploy to move.
//   4. house wallet COUNT
//   5. house wallet STAKE
//
// A NOTE ON HOW 2 AND 3 ARE SWEPT, because it looks like cheating and is not. The penalty rate does
// not affect the fight at all: `extract` sets `hp = 0` and splits `taken` into `kept` (to the
// player's bank) and `penalty` (out of the round) — the ring loses `taken` either way, and no
// subsequent draw can tell which split was applied. So recording `(taken, cursor, n)` at each real
// extraction and re-pricing it under a different constant is EXACT, not an approximation, and it
// needs no edit to `er-sim.ts` (which this brief forbids touching anyway).
//
// WHAT IT DOES NOT CAPTURE, and this is the honest limit: a higher penalty would DETER extraction.
// The sweep holds behaviour fixed, so every penalty figure above the current 2,000 bps is an UPPER
// BOUND on the revenue and every figure below it is a LOWER bound. Labelled in the table.

import { newRound, enter, tick, extract, settle, penaltyHorizonSteps } from "../../engine/src/er-sim.ts";
import { stepBudget } from "./fight-variant.ts";
import { BANDS, usd, toUsd } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { createHash } from "node:crypto";

const ROUNDS = Number(process.argv[2] ?? 6000);
const SEATS = 8;
const TAG = "sensitivity-v1";
const BASE = { feeBps: 100n, extractProb: 0.30, houseSeats: 2, houseStake: 10, penStartBps: 2000, horizonMult: 1.0 };

interface Ext { takenU: bigint; cursor: number; n: number; isHouse: boolean; }
interface Out { grossRealU: bigint; grossHouseU: bigint; feesRealU: bigint; feesHouseU: bigint; housePnlPreExtractU: bigint; exts: Ext[]; realNetPreU: bigint; }

/** Plays a round WITHOUT applying any penalty (penalty priced afterwards), so one simulation serves
 *  every penalty setting. `extract` still runs — it is what removes the ring — but we add the
 *  penalty back to the player and record the raw `taken` so it can be re-split at any rate. */
function simRound(tag: string, feeBps: bigint, extractProb: number, houseSeats: number, houseStake: number, rnd: () => number): Out {
  const round = newRound(createHash("sha256").update(tag).digest());
  const isHouse: boolean[] = []; const grossUnits: bigint[] = [];
  let placed = 0;
  for (let i = 0; i < houseSeats && placed < SEATS; i++, placed++) {
    const g = usd(houseStake); enter(round, `h${i}`, (placed % 2) as 0 | 1, g, feeBps); isHouse.push(true); grossUnits.push(g);
  }
  for (let i = 0; placed < SEATS; i++, placed++) {
    const b = BANDS[Math.floor(rnd() * BANDS.length)];
    const g = usd(b.lo + rnd() * (b.hi - b.lo));
    enter(round, `p${i}`, (placed % 2) as 0 | 1, g, feeBps); isHouse.push(false); grossUnits.push(g);
  }
  const n = round.fighters.length, budget = stepBudget(n), horizon = Number(penaltyHorizonSteps(n));
  let feesRealU = 0n, feesHouseU = 0n;
  for (let i = 0; i < n; i++) { const f = (grossUnits[i] * feeBps) / 10_000n; if (isHouse[i]) feesHouseU += f; else feesRealU += f; }

  const when = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (isHouse[i]) continue;                         // house holds, per strategy-house-book.ts
    if (rnd() >= extractProb) continue;
    const c = Math.floor(rnd() * horizon);
    if (c >= budget) continue;
    const at = when.get(c) ?? []; at.push(i); when.set(c, at);
  }
  const exts: Ext[] = [];
  let cursor = 0;
  for (const s of [...when.keys()].sort((a, b) => a - b)) {
    if (s > cursor) { tick(round, s - cursor); cursor = s; }
    for (const i of when.get(s)!) {
      const w = round.fighters[i].wallet;
      if (!round.fighters.find(x => x.wallet === w && x.dead === 0 && x.hp > 0n)) continue;
      const { taken, penalty } = extract(round, w);
      round.fighters[i].banked += penalty;            // undo the default split; re-priced below
      exts.push({ takenU: taken, cursor: s, n, isHouse: isHouse[i] });
    }
  }
  if (cursor < budget) tick(round, budget - cursor);
  settle(round);

  let grossRealU = 0n, grossHouseU = 0n, housePnlPreExtractU = 0n, realNetPreU = 0n;
  for (let i = 0; i < n; i++) {
    const pnl = round.fighters[i].hp + round.fighters[i].banked - grossUnits[i];
    if (isHouse[i]) { grossHouseU += grossUnits[i]; housePnlPreExtractU += pnl; }
    else { grossRealU += grossUnits[i]; realNetPreU += pnl; }
  }
  return { grossRealU, grossHouseU, feesRealU, feesHouseU, housePnlPreExtractU, exts, realNetPreU };
}

/** Re-price every recorded extraction at a hypothetical (start, horizonMult) and return the house's
 *  penalty take, split real/house. Mirrors `extract_penalty_bps` + `split_extraction` exactly. */
function pricePenalties(o: Out, startBps: number, horizonMult: number) {
  let real = 0n, house = 0n;
  for (const e of o.exts) {
    const horizon = Math.max(1, Math.round(Number(penaltyHorizonSteps(e.n)) * horizonMult));
    const remaining = e.cursor >= horizon ? 0 : horizon - e.cursor;
    const bps = BigInt(Math.floor(startBps * remaining / horizon));
    const p = (e.takenU * bps) / 10_000n;
    if (e.isHouse) house += p; else real += p;
  }
  return { real, house };
}

/** net_house = fees(all) + penalties(all) + house-wallet P&L, in micro-units. */
function netHouse(o: Out, startBps: number, horizonMult: number): bigint {
  const p = pricePenalties(o, startBps, horizonMult);
  return o.feesRealU + o.feesHouseU + p.real + p.house + (o.housePnlPreExtractU - p.house);
}

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
function ci95(xs: number[], seed = 3, resamples = 1500) {
  const rnd = mulberry32(seed); const d: number[] = [];
  for (let b = 0; b < resamples; b++) { let s = 0; for (let k = 0; k < xs.length; k++) s += xs[Math.floor(rnd() * xs.length)]; d.push(s / xs.length); }
  d.sort((a, b) => a - b); return [d[Math.floor(0.025 * d.length)], d[Math.floor(0.975 * d.length)]] as const;
}

console.log(`\n=== WHICH DIAL CONTROLS THE HOUSE'S EDGE ===`);
console.log(`measured on engine/src/er-sim.ts  |  ${ROUNDS} rounds/cell  |  ${SEATS} seats  |  seeds sha256("${TAG}|...")`);
console.log(`baseline: fee ${BASE.feeBps} bps, P(extract) ${BASE.extractProb}, ${BASE.houseSeats} house seats @ $${BASE.houseStake}, penalty ${BASE.penStartBps} bps, horizon x${BASE.horizonMult}`);
console.log(`\nEVERY ROW REPORTS: net house revenue per round, and as a percentage of REAL player gross.`);
console.log(`Real gross is the denominator that matters — house volume is not revenue (see strategy-house-book.ts §A).\n`);

/** Run one configuration and print a row. */
function row(label: string, cfg: Partial<typeof BASE>, seedOff: number, note = "") {
  const c = { ...BASE, ...cfg };
  const nets: number[] = [], grs: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const o = simRound(`${TAG}|${label}|${r}`, c.feeBps, c.extractProb, c.houseSeats, c.houseStake, mulberry32((r * 2654435761 + seedOff) >>> 0));
    nets.push(toUsd(netHouse(o, c.penStartBps, c.horizonMult)));
    grs.push(toUsd(o.grossRealU));
  }
  const [lo, hi] = ci95(nets, 17 + seedOff);
  const g = mean(grs);
  console.log(`  ${label.padEnd(30)} $${mean(nets).toFixed(3).padStart(7)}  [${lo.toFixed(3)}, ${hi.toFixed(3)}]   ${(100 * mean(nets) / g).toFixed(2).padStart(6)}% of real gross  ${note}`);
  return mean(nets);
}

console.log(`--- DIAL 1: Arena.fee_bps (LIVE, no deploy, capped at 1000) ---`);
const f0 = row("fee 0 bps", { feeBps: 0n }, 11);
row("fee 20 bps (the old rate)", { feeBps: 20n }, 12);
const f100 = row("fee 100 bps (LIVE NOW)", { feeBps: 100n }, 13);
row("fee 300 bps", { feeBps: 300n }, 14);
row("fee 1000 bps (MAX_FEE_BPS)", { feeBps: 1000n }, 15);

console.log(`\n--- DIAL 2: EXTRACT_PENALTY_START_BPS (compile-time const; needs a deploy) ---`);
row("penalty 0 bps (disabled)", { penStartBps: 0 }, 21, "LOWER bound");
row("penalty 1000 bps", { penStartBps: 1000 }, 22, "LOWER bound");
const p2000 = row("penalty 2000 bps (SHIPPED)", { penStartBps: 2000 }, 23);
row("penalty 4000 bps", { penStartBps: 4000 }, 24, "UPPER bound - would deter");
console.log(`  (behaviour held fixed: a higher penalty deters extraction, so 4000 is an upper bound)`);

console.log(`\n--- DIAL 3: PENALTY_HORIZON_STEPS multiplier (compile-time table; needs a deploy) ---`);
row("horizon x0.5 (free sooner)", { horizonMult: 0.5 }, 31);
row("horizon x1.0 (SHIPPED)", { horizonMult: 1.0 }, 32);
row("horizon x2.0 (free later)", { horizonMult: 2.0 }, 33, "UPPER bound - would deter");

console.log(`\n--- DIAL 4: house wallet COUNT (free to change, no deploy) ---`);
row("0 house seats", { houseSeats: 0 }, 41);
row("2 house seats (live #27 ratio)", { houseSeats: 2 }, 42);
row("4 house seats", { houseSeats: 4 }, 43);
row("6 house seats", { houseSeats: 6 }, 44);

console.log(`\n--- DIAL 5: house wallet STAKE (free to change, no deploy) ---`);
row("house stake $1", { houseStake: 1 }, 51);
row("house stake $10", { houseStake: 10 }, 52);
row("house stake $100", { houseStake: 100 }, 53);
row("house stake $1000", { houseStake: 1000 }, 54);

console.log(`\n--- THE ASSUMPTION, swept: P(a real player extracts before the bell) ---`);
console.log(`This is not a dial the house controls. It is the guess the whole penalty stream rests on.\n`);
for (const p of [0.0, 0.1, 0.3, 0.6, 1.0]) row(`P(extract) = ${p.toFixed(1)}`, { extractProb: p }, 60 + Math.round(p * 10));

console.log(`\nRANKING RULE: compare each dial's spread from end to end. A dial that moves net revenue by`);
console.log(`less than the 95% CI is not a dial. A dial the house cannot change without a deploy is not`);
console.log(`a dial today. And a row that moves the number only by changing P(extract) is not a dial at`);
console.log(`all — it is the market telling the house what its revenue is.\n`);
