// SANDBOX. Run from engine/:  npx tsx ../sandbox/house-edge/check-dice.ts [hashes] [rounds]
//
// "Lets play with how the dice are used, uniform is not beneficial" — the brief that started §1 of
// HOUSE-EDGE-STUDY.md. This script answers what the dice ACTUALLY do in the shipped game, at the
// level of the hash bytes, rather than at the level of the ROI table they eventually produce.
//
// Three separate things get called "the dice" and they are not the same knob:
//   1. WHO is drawn      — `h[0..4] % n` and `h[4..8] % (n-1)`, the attacker and defender slots.
//   2. HOW HARD          — `roll = h[8] % 24 + 4`, i.e. 4..27 percent.
//   3. PERCENT OF WHAT   — `basis = min(attacker.hp, defender.hp)`. THIS is the one that decides
//                          whether stake size matters, and it is the one the fix changed.
//
// Read against er-sim.ts's own `tickHash`/`drawPair` so the byte arithmetic is the deployed one.

import { tickHash, drawPair } from "../../engine/src/er-sim.ts";
import { FEE_BPS } from "./fight-variant.ts";
import { createHash } from "node:crypto";

const HASHES = Number(process.argv[2] ?? 2_000_000);
const N_FOR_SLOTS = 8;

console.log(`\n=== WHAT THE DICE ACTUALLY DO ===`);
console.log(`${HASHES.toLocaleString()} tick hashes off the deployed chain sha256(seed ++ le_u64(cursor))`);
console.log(`(this section is independent of stakes and of ${FEE_BPS} bps — it is pure byte arithmetic)\n`);

// -------------------------------------------------------------------------------------------------
// 2. HOW HARD — roll = h[8] % 24 + 4
// -------------------------------------------------------------------------------------------------
const rollCount = new Array(28).fill(0);
const slotA = new Array(N_FOR_SLOTS).fill(0);
const slotD = new Array(N_FOR_SLOTS).fill(0);
const pairCount = new Map<string, number>();

const seed = createHash("sha256").update("dice|check").digest();
for (let c = 0; c < HASHES; c++) {
  const h = tickHash(seed, BigInt(c));
  rollCount[(h[8] % 24) + 4]++;
  const [a, d] = drawPair(h, N_FOR_SLOTS);
  slotA[a]++; slotD[d]++;
  const k = `${a},${d}`; pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
}

console.log(`--- 2. HOW HARD: roll = h[8] %% 24 + 4, so 4..27 percent of the basis ---`);
console.log(`h[8] is a uniform BYTE (0..255) and 256 is NOT a multiple of 24. 256 = 24x10 + 16, so the`);
console.log(`sixteen residues 0..15 are reachable 11 ways and the eight residues 16..23 only 10 ways.`);
console.log(`THE DICE ARE THEREFORE NOT UNIFORM — but the non-uniformity is modulo bias, not design.\n`);
let obsMean = 0;
for (let r = 4; r <= 27; r++) obsMean += r * rollCount[r] / HASHES;
console.log(`  roll   count        share      share if uniform    ratio`);
for (const r of [4, 5, 18, 19, 20, 21, 26, 27]) {
  const share = rollCount[r] / HASHES;
  console.log(`   ${String(r).padStart(2)}   ${String(rollCount[r]).padStart(9)}   ${(share * 100).toFixed(4)}%          ${(100 / 24).toFixed(4)}%      ${(share * 24).toFixed(4)}`);
}
const lowShare = rollCount.slice(4, 20).reduce((a, x) => a + x, 0) / HASHES;
const hiShare = rollCount.slice(20, 28).reduce((a, x) => a + x, 0) / HASHES;
console.log(`\n  rolls  4..19 (11/256 each):  ${(lowShare * 100).toFixed(4)}%   theory ${(16 * 11 / 256 * 100).toFixed(4)}%`);
console.log(`  rolls 20..27 (10/256 each):  ${(hiShare * 100).toFixed(4)}%   theory ${(8 * 10 / 256 * 100).toFixed(4)}%`);
console.log(`  mean roll observed ${obsMean.toFixed(5)}   theory ${(3904 / 256).toFixed(5)}   a UNIFORM 4..27 would be 15.50000`);
console.log(`  => damage runs ${(100 * (1 - obsMean / 15.5)).toFixed(2)}% weaker than a uniform die, i.e. fights are marginally slower.`);
console.log(`  IT IS SIZE-NEUTRAL: the same die is rolled for every exchange whoever is in it, so it`);
console.log(`  cannot favour a stake band. It is a pacing bias, not an economic one.\n`);

// -------------------------------------------------------------------------------------------------
// 1. WHO — the slot draws
// -------------------------------------------------------------------------------------------------
console.log(`--- 1. WHO: attacker h[0..4] %% n, defender a rank among the n-1 who are not the attacker ---`);
const expA = HASHES / N_FOR_SLOTS;
let worstA = 0, worstD = 0;
for (let i = 0; i < N_FOR_SLOTS; i++) {
  worstA = Math.max(worstA, Math.abs(slotA[i] - expA) / Math.sqrt(expA));
  worstD = Math.max(worstD, Math.abs(slotD[i] - expA) / Math.sqrt(expA));
}
console.log(`  n = ${N_FOR_SLOTS}. attacker slot: worst deviation ${worstA.toFixed(2)} sigma. defender slot: worst ${worstD.toFixed(2)} sigma.`);
const pairs = [...pairCount.values()];
const expP = HASHES / (N_FOR_SLOTS * (N_FOR_SLOTS - 1));
let worstP = 0, worstPk = "";
for (const [k, v] of pairCount) { const s = Math.abs(v - expP) / Math.sqrt(expP); if (s > worstP) { worstP = s; worstPk = k; } }
console.log(`  ordered pairs realised: ${pairs.length} of ${N_FOR_SLOTS * (N_FOR_SLOTS - 1)} possible; worst cell ${worstPk} at ${worstP.toFixed(2)} sigma.`);
console.log(`  the residual modulo bias here is 2^32 %% n out of 2^32 — for n <= 16 that is under 4e-9`);
console.log(`  and is not measurable at any sample size this game will ever produce.\n`);

// -------------------------------------------------------------------------------------------------
// 3. PERCENT OF WHAT — the basis, which is the only size-sensitive term
// -------------------------------------------------------------------------------------------------
console.log(`--- 3. PERCENT OF WHAT: basis = min(attacker.hp, defender.hp) ---`);
console.log(`This is the term that decides whether a stake band has an edge, and it is EXACTLY symmetric:\n`);
const cases: [number, number][] = [[100, 5], [100, 100], [80, 3], [50, 20]];
console.log(`  attacker $   defender $   dmg when A hits D    dmg when D hits A    net drift`);
for (const [x, y] of cases) {
  const bx = Math.min(x, y);
  console.log(`  ${String(x).padStart(9)}   ${String(y).padStart(9)}   ${("$" + (bx * 0.1525).toFixed(3)).padStart(17)}    ${("$" + (bx * 0.1525).toFixed(3)).padStart(17)}    ${"$0.000".padStart(9)}`);
}
console.log(`\n  Both directions read the SAME min, so the expected transfer between any two fighters is zero`);
console.log(`  whatever their sizes. The fight is a martingale in (hp + banked) for every fighter, and`);
console.log(`  "the dice favour small stakes" is FALSE of the shipped rule. It was TRUE of v5 — where`);
console.log(`  basis was the defender's ring alone, so a minnow hitting a whale took a WHALE-sized bite —`);
console.log(`  and that asymmetry is exactly the seat law of HOUSE-EDGE-STUDY.md §0, which was farmable`);
console.log(`  at $152/round on an $80 budget and was removed for that reason (§10.2, §10.3).\n`);
console.log(`  So the answer to "does the shipped curve give small players an edge" is NO, deliberately.`);
console.log(`  §10.5 records the decision: every P > 0 in the blend sells the exploit back in proportion`);
console.log(`  to P, and the mandate was to close a farm, not to price one. A size tilt and a sybil farm`);
console.log(`  are the same object viewed from two sides — you cannot ship one without the other.\n`);
