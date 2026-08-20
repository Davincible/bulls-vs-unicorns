// SANDBOX — G12, the price half. ARENA-VAULT.md risk #9: "the price authority can tilt a fight,
// with the arena's own wallets on the board."
//
//   cd engine
//   HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector-price.ts <rounds>
//
// The price is FROZEN at `open_round`, so within a round it cannot move. That closes the solvency
// question (§3.1: credit and redemption use the same number) and it does NOT close the fairness
// question, because the frozen number can be frozen WRONG. This measures how wrong it has to be
// before it matters, and derives the coefficient a governance argument has to be built on.
//
// THE MECHANISM, before the numbers, so the reader can check the numbers against it:
//
//   A fighter is credited `units = amt * p / SCALE` at the frozen price p and redeems slot i at the
//   SAME p. If every unit they ended with were still in their OWN slot, p would cancel exactly and
//   a wrong price would be worth nothing. It does not cancel, because a fighter's terminal holdings
//   are part own-slot ring and part FOREIGN-slot bank — the value they raided. Foreign units redeem
//   into the other side's token at the other side's frozen price, so an over-priced token pays its
//   raiders too little of it. Writing `beta` for the share of a fighter's stake that ends up as
//   foreign-slot bank, and `eps` for the fractional over-pricing of the other mint, the loss is
//
//        d(true return)  ~  - beta * eps / (1 + eps)
//
//   and the winner is whoever's own token was over-stated. `beta` is measured below rather than
//   assumed, and the linear prediction is checked against the simulation at every eps.

import { runFight } from "./fight-variant.ts";
import { makeLobby, roiWithSE } from "./lobby.ts";
import {
  MINTS, MINT_NAMES, TRUE_PRICE, skewedPrice, C4_GREEDY,
  vFightersFromTokens, settleTokens, tokensToUsd, fmtPct, hr, FEE_BPS,
} from "./vector-core.ts";

const STUDY_SEED = "house-edge-v1";
const ROUNDS = Number(process.argv[2] ?? 4000);
const PER_SIDE = 4;

let FAILURES = 0;
const ok = (c: boolean, m: string) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${m}`); if (!c) FAILURES++; };

/** Run `n` rounds with mint `slot` over-priced by `epsBps`, and report each side's TRUE-value ROI
 *  plus the share of stake that ends the round in a foreign slot. */
function sweep(epsBps: number, slot: number, n: number) {
  const frozen = skewedPrice(epsBps, slot);
  const rounds: { inn: number; out: number }[][] = [[], []];
  let stakeUnits = 0, foreignUnits = 0;
  for (let r = 0; r < n; r++) {
    const l = makeLobby(STUDY_SEED, r, PER_SIDE);
    const { fighters, deposits } = vFightersFromTokens(l, frozen);
    runFight(fighters, l.seed, l.steps, C4_GREEDY, l.hashes, true);
    const per = [{ inn: 0, out: 0 }, { inn: 0, out: 0 }];
    for (let i = 0; i < fighters.length; i++) {
      const s = deposits[i].slot;
      const { perMint } = settleTokens(fighters[i], frozen);
      let got = 0;
      for (let m = 0; m < MINTS; m++) got += tokensToUsd(perMint[m], m, TRUE_PRICE);
      per[s].inn += deposits[i].usdTrue;
      per[s].out += got;
      stakeUnits += Number(fighters[i].stake);
      for (let m = 0; m < MINTS; m++) if (m !== s) foreignUnits += Number(fighters[i].ring![m] + fighters[i].vbank![m]);
    }
    rounds[0].push(per[0]); rounds[1].push(per[1]);
  }
  const a = roiWithSE(rounds[0]), b = roiWithSE(rounds[1]);
  return { a, b, beta: foreignUnits / stakeUnits };
}

const t0 = Date.now();
console.log(`check-vector-price.ts — G12 price sensitivity.  rounds=${ROUNDS} fee=${FEE_BPS}bps`);
console.log(`basis: C4 value-min + stolen-first. true price ANSEM $${0.17}/token, UWU $${0.033}/token.`);

hr("1 — beta: how much of a stake ends the round denominated in the OTHER side's token");
const base = sweep(0, 1, Math.min(ROUNDS, 4000));
console.log(`  beta = ${(base.beta * 100).toFixed(3)}% of staked units end in a foreign slot.`);
console.log("  This is the entire exposure surface to a wrong price. Value that never left a fighter's");
console.log("  own slot redeems at the same number it was credited at, so the price cancels on it exactly.");
console.log(`\n  At a fair price both sides sit on the rake: ANSEM ${fmtPct(base.a.roi, 4)} +- ${(base.a.se * 100).toFixed(3)}, ` +
  `UWU ${fmtPct(base.b.roi, 4)} +- ${(base.b.se * 100).toFixed(3)}`);
ok(Math.abs(base.a.roi - base.b.roi) / Math.sqrt(base.a.se ** 2 + base.b.se ** 2) < 2.5,
  "at a correct price the two mints are indistinguishable");

hr("2 — the sweep: UWU's frozen price over-stated by eps, everything else correct");
console.log(`${Math.min(ROUNDS, 4000)} rounds per row, common random numbers across rows.\n`);
// THE eps=0 ROW IS THE CONTROL AND IS SUBTRACTED. It is not zero: these lobbies carry a
// -0.43% side-vs-side sampling difference that the SINGLE-SCALAR fight has too (check-vector.ts
// part 1, C0 row, 0.68 sigma). Reporting it inside the price effect would credit the price with
// noise that has nothing to do with it, so every "excess" column below is net of it.
console.log("   eps      ANSEM ROI (true $)     UWU ROI (true $)     UWU advantage    excess of eps=0    predicted     error");
console.log("  " + "-".repeat(116));
const rowsOut: { eps: number; adv: number; pred: number; excess: number; se: number }[] = [];
let baseAdv = 0, baseSe = 0;
for (const epsBps of [-5000, -2500, -1000, -500, -100, 0, 100, 500, 1000, 2500, 5000]) {
  const s = sweep(epsBps, 1, Math.min(ROUNDS, 20000));
  const adv = s.b.roi - s.a.roi;
  const eps = epsBps / 10_000;
  if (epsBps === 0) { baseAdv = adv; baseSe = Math.sqrt(s.a.se ** 2 + s.b.se ** 2); }
  // The prediction: the over-priced side gains beta*eps/(1+eps), the other loses it, so the
  // ADVANTAGE is twice that. beta is taken from the fair-price run, not refitted per row.
  const pred = 2 * base.beta * eps / (1 + eps);
  const excess = adv - baseAdv;
  const se = Math.sqrt(s.a.se ** 2 + s.b.se ** 2 + baseSe ** 2);
  rowsOut.push({ eps, adv, pred, excess, se });
  console.log(`  ${(eps * 100).toFixed(0).padStart(4)}%   ${fmtPct(s.a.roi, 4).padStart(10)} +- ${(s.a.se * 100).toFixed(3)}   ` +
    `${fmtPct(s.b.roi, 4).padStart(10)} +- ${(s.b.se * 100).toFixed(3)}   ${fmtPct(adv, 4).padStart(11)}   ` +
    `${fmtPct(excess, 4).padStart(13)}   ${fmtPct(pred, 4).padStart(11)}   ${((excess - pred) / se).toFixed(2).padStart(6)}s`);
}
console.log();
// THE TOLERANCE IS IN SIGMA, NOT IN POINTS. Each row is a fresh set of fights — a different frozen
// price changes the units, so the trajectories diverge and the rows are NOT paired the way
// `check-fee-rate.ts`'s are. An absolute tolerance here would be a statement about the sample size.
const near = rowsOut.filter(r => Math.abs(r.eps) <= 0.05 && r.eps !== 0);
const worst = Math.max(...near.map(r => Math.abs(r.excess - r.pred) / r.se));
ok(worst < 3, `the one-parameter model tracks every row inside +-5% to ${worst.toFixed(2)} sigma`);
console.log("  The model is a one-parameter fit with beta measured at eps=0 and NOT refitted per row.");
console.log("  It degrades above ~10% because a badly mis-stated price also changes the RELATIVE SIZES");
console.log("  in the ring, which moves how much gets raided at all — a second-order term this ignores.");

hr("3 — the number a governance argument has to be built on");
// Least squares through the origin over the four rows inside +-5%, which is better determined
// than any single central difference and is reported with the analytic prediction beside it.
const fit = rowsOut.filter(r => Math.abs(r.eps) <= 0.05 && r.eps !== 0);
let sxy = 0, sxx = 0;
for (const r of fit) { sxy += r.eps * r.excess; sxx += r.eps * r.eps; }
const slopeAdv = sxy / sxx;                            // gap per unit eps
console.log(`  MEASURED (least squares through the origin, the four rows inside +-5%):`);
console.log(`  a price error of 1% moves the GAP between the two sides by ${(slopeAdv * 100).toFixed(1)} basis points`);
console.log(`  of one-round return, i.e. about ${(slopeAdv * 50).toFixed(1)} bps onto the over-priced side and the same off the other.`);
console.log(`  PREDICTED from beta alone, with no fitting at all: ${(2 * base.beta * 100).toFixed(1)} bps.`);
console.log(`\n  It is beta that sets this, and beta is large: ${(base.beta * 100).toFixed(1)}% of every stake ends the round`);
console.log("  denominated in the other side's token, because in the extraction economy everything you");
console.log("  raid is banked in the slot you took it from and never comes back.");
const perSide = slopeAdv / 2;             // return shift per unit eps, one side
const feeEps = Number(FEE_BPS) / 10_000 / perSide;
console.log(`\n  COMPARE THE RAKE. The arena charges ${FEE_BPS} bps. A price error of`);
console.log(`  ${(feeEps * 100).toFixed(2)}% hands the favoured side back its entire entry fee;`);
console.log(`  ${(2 * feeEps * 100).toFixed(2)}% makes playing that side positive-expectation outright.`);
console.log("\n  That last line is the finding. The price authority does not need to be dishonest by much,");
console.log("  and ARENA-VAULT.md risk #9 notes the arena's own wallets are on the board.");

hr("4 — does beta depend on the lineup? the slope is only as stable as beta is");
console.log("  seats   beta (foreign share)   implied gap slope per 1% of price error");
console.log("  " + "-".repeat(70));
for (const seats of [8, 16, 48]) {
  const s = sweep(0, 1, Math.min(ROUNDS, 600));
  // beta is re-measured at this lineup size by re-running the fair-price sweep at that size.
  let stakeU = 0, foreignU = 0;
  for (let r = 0; r < Math.min(ROUNDS, 600); r++) {
    const l = makeLobby(STUDY_SEED, 3_000_000 + r, seats / 2);
    const { fighters } = vFightersFromTokens(l, TRUE_PRICE);
    runFight(fighters, l.seed, l.steps, C4_GREEDY, l.hashes, true);
    for (const f of fighters) {
      stakeU += Number(f.stake);
      for (let m = 0; m < MINTS; m++) if (m !== f.slot) foreignU += Number(f.ring![m] + f.vbank![m]);
    }
  }
  const b = foreignU / stakeU;
  console.log(`  ${String(seats).padStart(5)}   ${(b * 100).toFixed(3).padStart(18)}%   ${(2 * b * 100).toFixed(1).padStart(10)} bps`);
}

console.log(`\n${FAILURES === 0 ? "ALL CHECKS PASSED" : `${FAILURES} CHECK(S) FAILED`}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(FAILURES === 0 ? 0 : 1);
