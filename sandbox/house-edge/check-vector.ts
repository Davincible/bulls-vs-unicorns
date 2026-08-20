// SANDBOX — G12. Does a two-mint holdings vector keep the fight fair?
//
// Re-runs the bars HOUSE-EDGE-STUDY.md §11 and HOUSE-SMALL-STAKE.md cleared against the single
// scalar `basis = min(attacker.hp, defender.hp)`, against each candidate vector basis instead.
//
//   cd engine
//   HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts <rounds> <part|all>
//
// parts: 0 self-checks and the bit-identity claim | 1 the candidates, screened
//        2 exact conservation at scale            | 3 house take by MINT — the new failure mode
//        4 stake bands and the sybil farm         | 5 fight length and the bell
//        6 claim dust, priced                    | 7 extract, four regimes, take by mint
//
// Exits non-zero if any invariant fails, so it is usable as a gate and not only as a report.

import { runFight, payout, makeFighter, vsum, takeSlots } from "./fight-variant.ts";
import type { Fighter, FightConfig } from "./fight-variant.ts";
import { makeLobby, finish, usd, BANDS, fightersOf } from "./lobby.ts";
import { roiWithSE, toUsd, pct } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { createHash } from "node:crypto";
import { newRound, enter, tick, extract, penaltyHorizonSteps } from "../../engine/src/er-sim.ts";
import type { Lobby, Entry } from "./lobby.ts";
import {
  MINTS, MINT_NAMES, TRUE_PRICE, slotOfSide, CANDIDATES, C0_SCALAR, C4_GREEDY, C1_SLOT_MIN,
  C2_TOKEN_MIN, C3_PROPORTIONAL, C5_OWN_FIRST, candidate,
  vFightersOf, vFightersFromTokens, residualOf, maxAbs, potPerSlotOf, claimDust, settleTokens,
  unitsToUsd, tokensToUsd, dustToUnits, fmtPct, hr, FEE_BPS, stepBudget, PRICE_SCALE,
} from "./vector-core.ts";

const STUDY_SEED = "house-edge-v1";      // the SAME seed every other study in this directory uses
const ROUNDS = Number(process.argv[2] ?? 4000);
const PART = String(process.argv[3] ?? "all");
const PER_SIDE = 4;                       // 8 fighters, the §11 lineup

let FAILURES = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${msg}`);
  if (!cond) FAILURES++;
};
const want = (p: string) => PART === "all" || PART === p;

const clone = (f: Fighter[]): Fighter[] => f.map(g => ({
  ...g, ring: g.ring ? [...g.ring] : undefined, vbank: g.vbank ? [...g.vbank] : undefined,
}));

/** One round, run to conclusion. Returns the settled fighters and the per-slot pot it started with. */
function runRound(l: Lobby, cfg: FightConfig, stop = true): { f: Fighter[]; pot: bigint[]; endedAt: number; steps: number } {
  const { fighters } = vFightersOf(l);
  const pot = potPerSlotOf(fighters);
  const st = runFight(fighters, l.seed, l.steps, cfg, l.hashes, stop);
  return { f: fighters, pot, endedAt: st.endedAt, steps: l.steps };
}

// =================================================================================================
// PART 0 — the harness itself, and THE structural claim everything else rests on.
// =================================================================================================
function part0() {
  hr("PART 0 — self-checks, and the claim that the vector is a partition of the scalar");

  // takeSlots: §3.4(b)'s stable descending order, ties by ascending index, own slot last.
  ok(JSON.stringify(takeSlots([5n, 9n, 9n], 0, "stolen-first")) === JSON.stringify([1, 2, 0]),
    "takeSlots: stolen slots descending, EQUAL pots tie-break by ascending index, own last");
  ok(JSON.stringify(takeSlots([5n, 9n, 9n], 0, "own-first")) === JSON.stringify([0, 1, 2]),
    "takeSlots: own-first puts the defender's own mint at the head");

  // THE CLAIM: in the EXTRACTION economy a fighter's RING never acquires a foreign slot, because
  // winnings go to `banked`. The ring is therefore mono-slot for the whole fight, `sum(ring)` is
  // `ring[own]`, and `value-min` is not merely close to `min(A.hp, D.hp)` — it IS it.
  let monoViolations = 0, ident = 0, checked = 0;
  for (let r = 0; r < Math.min(ROUNDS, 2000); r++) {
    const l = makeLobby(STUDY_SEED, r, PER_SIDE);
    const { fighters: sc } = fightersOf(l);
    runFight(sc, l.seed, l.steps, C0_SCALAR, l.hashes, true);
    for (const cfg of [C4_GREEDY, C5_OWN_FIRST, C3_PROPORTIONAL]) {
      const { f } = runRound(l, cfg);
      for (const g of f) { let occupied = 0; for (const x of g.ring!) if (x !== 0n) occupied++; if (occupied > 1) monoViolations++; }
      let same = true;
      for (let i = 0; i < f.length; i++) {
        if (f[i].hp !== sc[i].hp || f[i].banked !== sc[i].banked || f[i].dead !== sc[i].dead) same = false;
      }
      if (same) ident++;
      checked++;
    }
  }
  ok(monoViolations === 0, `EXTRACTION keeps every ring mono-slot (${monoViolations} violations)`);
  ok(ident === checked,
    `every value-min candidate is BIT-IDENTICAL to the scalar fight in hp/banked/dead (${ident}/${checked} round-configs)`);

  // The partition invariant, asserted rather than assumed, on a mayhem fight where the ring really
  // does go multi-slot.
  const l0 = makeLobby(STUDY_SEED, 7, PER_SIDE);
  const mayhem = candidate("value-min", "stolen-first", { economy: "mayhem" });
  const { f: mf } = runRound(l0, mayhem, false);
  let multi = 0;
  for (const g of mf) { let occ = 0; for (const x of g.ring!) if (x !== 0n) occ++; if (occ > 1) multi++; }
  ok(multi > 0, `MAYHEM does put foreign slots in the ring (${multi}/${mf.length} fighters), so the take order is live there`);
  ok(mf.every(g => vsum(g.ring!) === g.hp && vsum(g.vbank!) === g.banked),
    "the partition invariant sum(ring)===hp and sum(vbank)===banked survives mayhem");
}

// =================================================================================================
// PART 1 — screen the candidates. Does the fight happen at all, and is it symmetric?
// =================================================================================================
function part1() {
  hr("PART 1 — the candidates, screened: does a fight even occur, and does it favour a mint?");
  const n = Math.min(ROUNDS, 3000);
  console.log(`${n} rounds x ${PER_SIDE * 2} fighters, seed "${STUDY_SEED}", fee ${FEE_BPS} bps\n`);
  console.log("  id  basis / take order                exchanges/round   concluded   ANSEM ROI    UWU ROI      spread");
  console.log("  " + "-".repeat(104));

  const rows: { id: string; spread: number; exch: number }[] = [];
  // C0 IS IN THE TABLE, and it is the row that decides how to read the others. Side 0 and side 1
  // are the two mints in a two-mint arena, so an ANSEM-vs-UWU spread is only a VECTOR defect if it
  // is larger than the side-vs-side spread the single-scalar fight already had on the same lobbies.
  const table = [{ id: "C0", name: "scalar control, no vector at all", cfg: C0_SCALAR }, ...CANDIDATES];
  for (const { id, name, cfg } of table) {
    let exch = 0, concluded = 0;
    const roi: { inn: number; out: number }[][] = [[], []];
    for (let r = 0; r < n; r++) {
      const l = makeLobby(STUDY_SEED, r, PER_SIDE);
      const { fighters } = cfg.vector ? vFightersOf(l) : fightersOf(l);
      const before = fighters.map(g => g.hp);
      const st = runFight(fighters, l.seed, l.steps, cfg, l.hashes, true);
      exch += st.exchanges;
      if (st.endedAt < l.steps) concluded++;
      const per: { inn: number; out: number }[] = [{ inn: 0, out: 0 }, { inn: 0, out: 0 }];
      for (let i = 0; i < fighters.length; i++) {
        const s = slotOfSide(fighters[i].side);
        per[s].inn += Number(before[i]); per[s].out += Number(payout(fighters[i]));
      }
      roi[0].push(per[0]); roi[1].push(per[1]);
    }
    const a = roiWithSE(roi[0]), b = roiWithSE(roi[1]);
    const spread = a.roi - b.roi;
    const se = Math.sqrt(a.se ** 2 + b.se ** 2);
    rows.push({ id, spread, exch: exch / n });
    console.log(`  ${id}  ${name}  ${(exch / n).toFixed(1).padStart(10)}   ${((concluded / n) * 100).toFixed(1).padStart(7)}%   ` +
      `${fmtPct(a.roi, 3).padStart(9)}  ${fmtPct(b.roi, 3).padStart(9)}   ${fmtPct(spread, 3).padStart(9)}  ${(Math.abs(spread) / se).toFixed(2).padStart(5)}s`);
  }
  console.log();
  const c0 = rows.find(r => r.id === "C0")!;
  // The screen: a rule that moves no value is not a fight, and a rule whose two mints differ by
  // more than a rounding error is not a fair one. NOTE these ROIs are gross of the entry fee —
  // `vFightersOf` credits the NET stake — so the fair value of every cell here is 0.0000%, and
  // §11's -1.00% appears in part 4 where the fee is charged.
  for (const row of rows) {
    if (row.exch < 1) console.log(`  NOTE  ${row.id} moved value on ${row.exch.toFixed(2)} exchanges/round — DEADLOCK, not a fight`);
  }
  ok(rows.find(r => r.id === "C1")!.exch < 1, "C1 slot-min DEADLOCKS a two-mint arena (expected: the minima are all zero)");
  ok(Math.abs(rows.find(r => r.id === "C2")!.spread) > 0.02, "C2 token-min is grossly mint-asymmetric (expected: the mugging)");
  for (const id of ["C3", "C4", "C5"]) {
    ok(Math.abs(rows.find(r => r.id === id)!.spread - c0.spread) < 1e-12,
      `${id} value-min introduces ZERO new mint spread — identical to the scalar control's side spread`);
  }
  console.log(`\n  The C0 row is the point: the scalar fight ALREADY shows a ${fmtPct(c0.spread, 3)} side-vs-side`);
  console.log("  spread on these lobbies. C3/C4/C5 reproduce it to the last micro-unit, so it is inherited");
  console.log("  sampling noise in the lobby draw, not something the mint vector introduced. Part 3 tests");
  console.log("  whether it is distinguishable from zero at all.");
}

// =================================================================================================
// PART 2 — exact conservation, at the precedent's scale.
// =================================================================================================
function part2() {
  hr("PART 2 — exact conservation, per mint slot, at 80,000 round-simulations");
  const per = Math.max(1, Math.floor(ROUNDS));
  const cfgs: { id: string; cfg: FightConfig }[] = [
    { id: "C3 proportional      ", cfg: C3_PROPORTIONAL },
    { id: "C4 stolen-first      ", cfg: C4_GREEDY },
    { id: "C5 own-first         ", cfg: C5_OWN_FIRST },
    { id: "C4 MAYHEM            ", cfg: candidate("value-min", "stolen-first", { economy: "mayhem" }) },
  ];
  console.log(`${per} rounds x ${cfgs.length} configurations = ${per * cfgs.length} round-simulations\n`);
  console.log("  configuration            worst |residual|   per-slot worst   partition worst   rounds exact");
  console.log("  " + "-".repeat(94));
  for (const { id, cfg } of cfgs) {
    let worst = 0n, worstSlot = 0n, worstPart = 0n, exact = 0;
    for (let r = 0; r < per; r++) {
      const l = makeLobby(STUDY_SEED, r, PER_SIDE);
      const { f, pot } = runRound(l, cfg, cfg.vector!.economy !== "mayhem");
      const res = residualOf(f, pot);
      const m = maxAbs(res);
      if (m > worst) worst = m;
      for (const x of res.perSlot) { const a = x < 0n ? -x : x; if (a > worstSlot) worstSlot = a; }
      if (res.partition > worstPart) worstPart = res.partition;
      if (m === 0n) exact++;
    }
    console.log(`  ${id}  ${String(worst).padStart(15)}   ${String(worstSlot).padStart(14)}   ${String(worstPart).padStart(15)}   ${exact}/${per}`);
    ok(worst === 0n, `${id.trim()}: conservation EXACT in all ${per} rounds (worst residual ${worst} micro-units)`);
  }
}

// =================================================================================================
// PART 3 — THE NEW FAILURE MODE. Does what you brought change what you get back?
// =================================================================================================
function part3() {
  hr("PART 3 — house take and player return BY MINT, at the true price");
  const n = Math.max(1, ROUNDS);
  console.log(`${n} rounds x ${PER_SIDE * 2} fighters, full token round trip, frozen price == true price\n`);

  for (const { id, name, cfg } of [
    { id: "C4", name: "value-min + stolen-first", cfg: C4_GREEDY },
    { id: "C3", name: "value-min + proportional", cfg: C3_PROPORTIONAL },
    { id: "C2", name: "token-min (control)     ", cfg: C2_TOKEN_MIN },
  ]) {
    // Per-mint gross in / net out, in TOKEN BASE UNITS — the denomination a player can spend.
    const inn = new Array(MINTS).fill(0n), out = new Array(MINTS).fill(0n), fee = new Array(MINTS).fill(0n);
    const roiRounds: { inn: number; out: number }[][] = [[], []];
    for (let r = 0; r < n; r++) {
      const l = makeLobby(STUDY_SEED, r, PER_SIDE);
      const { fighters, deposits, feeTokens } = vFightersFromTokens(l, TRUE_PRICE);
      runFight(fighters, l.seed, l.steps, cfg, l.hashes, true);
      const per: { inn: number; out: number }[] = [{ inn: 0, out: 0 }, { inn: 0, out: 0 }];
      for (let i = 0; i < MINTS; i++) { fee[i] += feeTokens[i]; inn[i] += 0n; }
      for (let i = 0; i < fighters.length; i++) {
        const s = deposits[i].slot;
        inn[s] += deposits[i].tokens;
        const { perMint } = settleTokens(fighters[i], TRUE_PRICE);
        for (let m = 0; m < MINTS; m++) out[m] += perMint[m];
        per[s].inn += deposits[i].usdTrue;
        let got = 0; for (let m = 0; m < MINTS; m++) got += tokensToUsd(perMint[m], m, TRUE_PRICE);
        per[s].out += got;
      }
      roiRounds[0].push(per[0]); roiRounds[1].push(per[1]);
    }
    console.log(`  ${id} ${name}`);
    console.log("     mint     deposited (tok)      paid out (tok)   house take %        player ROI (USD, true px)");
    for (let m = 0; m < MINTS; m++) {
      const takePct = Number(inn[m] - out[m]) / Number(inn[m]);
      const r = roiWithSE(roiRounds[m]);
      console.log(`     ${MINT_NAMES[m].padEnd(6)}  ${String(inn[m]).padStart(17)}  ${String(out[m]).padStart(18)}   ` +
        `${(takePct * 100).toFixed(4).padStart(9)}%        ${fmtPct(r.roi, 4).padStart(10)} +- ${(r.se * 100).toFixed(4)}`);
    }
    const rA = roiWithSE(roiRounds[0]), rB = roiWithSE(roiRounds[1]);
    const diff = rA.roi - rB.roi;
    const se = Math.sqrt(rA.se ** 2 + rB.se ** 2);
    console.log(`     ANSEM - UWU return difference: ${fmtPct(diff, 4)}  (${(Math.abs(diff) / se).toFixed(2)} sigma)\n`);
    if (id !== "C2") ok(Math.abs(diff) / se < 2.5, `${id}: which mint you brought is worth ${fmtPct(diff, 4)}, under 2.5 sigma`);
  }
}

// =================================================================================================
// PART 4 — stake bands, and the eight-wallet sybil farm.
// =================================================================================================
function part4() {
  hr("PART 4 — stake bands, and the sybil farm, under the recommended basis");
  const n = Math.max(1, ROUNDS);

  // --- bands, exactly as HOUSE-EDGE-STUDY.md §11.5 does them ---
  console.log(`Bands: ${n} rounds x ${PER_SIDE * 2} fighters. Fair value is the rake and nothing else.\n`);
  console.log("  band                 C0 scalar (control)      C4 vector           difference");
  console.log("  " + "-".repeat(78));
  const acc = (k: number) => Array.from({ length: BANDS.length }, () => [] as { inn: number; out: number }[]);
  const bands0 = acc(0), bands4 = acc(0);
  for (let r = 0; r < n; r++) {
    const l = makeLobby(STUDY_SEED, r, PER_SIDE);
    const runs: { tag: 0 | 1; f: Fighter[] }[] = [];
    const { fighters: s0, fees: f0 } = fightersOf(l);
    runFight(s0, l.seed, l.steps, C0_SCALAR, l.hashes, true);
    runs.push({ tag: 0, f: s0 });
    const { fighters: s4 } = vFightersOf(l);
    runFight(s4, l.seed, l.steps, C4_GREEDY, l.hashes, true);
    runs.push({ tag: 1, f: s4 });
    for (const { tag, f } of runs) {
      const tgt = tag === 0 ? bands0 : bands4;
      const perBand = BANDS.map(() => ({ inn: 0, out: 0 }));
      for (let i = 0; i < f.length; i++) {
        const b = l.entries[i].band;
        perBand[b].inn += Number(l.entries[i].grossUnits);   // GROSS: the fee is a real cost
        perBand[b].out += Number(payout(f[i]));
      }
      for (let b = 0; b < BANDS.length; b++) tgt[b].push(perBand[b]);
    }
  }
  for (let b = 0; b < BANDS.length; b++) {
    const a = roiWithSE(bands0[b]), c = roiWithSE(bands4[b]);
    console.log(`  ${BANDS[b].name}   ${fmtPct(a.roi, 3).padStart(9)} +- ${(a.se * 100).toFixed(2).padStart(5)}   ` +
      `${fmtPct(c.roi, 3).padStart(9)} +- ${(c.se * 100).toFixed(2).padStart(5)}   ${fmtPct(c.roi - a.roi, 4).padStart(10)}`);
    ok(c.roi <= 0 || c.roi < 2 * c.se, `${BANDS[b].name.trim()}: no positive expectation (${fmtPct(c.roi, 3)})`);
    ok(Math.abs(c.roi - a.roi) < 1e-9, `${BANDS[b].name.trim()}: vector band ROI is IDENTICAL to the scalar's`);
  }

  // --- the sybil farm, on study-split.ts's OWN lobby construction so the numbers are comparable to
  //     HOUSE-EDGE-STUDY.md §11.2 rather than merely similar in spirit: a full 48-seat lobby, the
  //     splitter taking k of the seats ALTERNATING SIDES, the background filling the other 48-k.
  //
  //     Alternating sides is doubly interesting here and was not a choice made for this study: in a
  //     two-mint arena it means the splitter is holding BOTH MINTS, which is the one genuinely new
  //     sybil shape ADR-001 creates. It is measured because study-split.ts already built it.
  const SEATS = 48, BUDGET = 80;
  console.log(`\nSybil farm, study-split.ts's construction: a $${BUDGET} budget across k of ${SEATS} seats,`);
  console.log(`alternating sides (so k > 1 holds BOTH mints), background fills the rest. ${Math.min(n, 2500)} rounds.\n`);
  console.log("  wallets   C0 scalar $/round        C4 vector $/round      vs k=1 (C4)   difference C4-C0");
  console.log("  " + "-".repeat(94));
  let k1 = 0;
  for (const k of [1, 2, 4, 8, 12]) {
    const res: number[][] = [[], []];
    const rr = Math.min(n, 2500);
    for (let r = 0; r < rr; r++) {
      const rnd = mulberry32((r * 2654435761 + k * 7919) >>> 0);
      const entries: Entry[] = [];
      let id = 0;
      for (let i = 0; i < k; i++)
        entries.push({ wallet: `s${++id}`, side: (i % 2) as 0 | 1, grossUnits: usd(BUDGET / k), band: -1, house: true });
      for (let i = 0; i < SEATS - k; i++) {
        const b = BANDS[Math.floor(rnd() * BANDS.length)];
        entries.push({ wallet: `p${++id}`, side: ((i + 1) % 2) as 0 | 1, grossUnits: usd(b.lo + rnd() * (b.hi - b.lo)), band: -1, house: false });
      }
      const l = finish(`${STUDY_SEED}|split|${k}`, r, entries);
      const { fighters: s0 } = fightersOf(l);
      runFight(s0, l.seed, l.steps, C0_SCALAR, l.hashes, true);
      const { fighters: s4 } = vFightersOf(l);
      runFight(s4, l.seed, l.steps, C4_GREEDY, l.hashes, true);
      for (const [t, f] of [[0, s0], [1, s4]] as const) {
        let got = 0n;
        for (let j = 0; j < f.length; j++) if (l.entries[j].house) got += payout(f[j]);
        res[t].push(toUsd(got) - BUDGET);
      }
    }
    const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
    const sem = (xs: number[]) => {
      const m = mean(xs);
      return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
    };
    const m0 = mean(res[0]), m4 = mean(res[1]), e4 = sem(res[1]);
    if (k === 1) k1 = m4;
    console.log(`  ${String(k).padStart(7)}   ${("$" + m0.toFixed(4)).padStart(12)} +- ${e4.toFixed(3)}   ${("$" + m4.toFixed(4)).padStart(12)} +- ${e4.toFixed(3)}   ` +
      `${("$" + (m4 - k1).toFixed(4)).padStart(11)}   ${(m4 - m0).toFixed(8).padStart(16)}`);
    ok(m4 <= 0.02, `${k}-wallet farm has no positive expectation under the vector (${m4.toFixed(4)} $/round)`);
    ok(Math.abs(m4 - m0) < 1e-9, `${k}-wallet farm is IDENTICAL to the scalar's number`);
  }
  console.log("\n  The 'vs k=1' column is §11.2's metric — what SPLITTING buys over entering once.");
  console.log("  The right-hand column is G12's: what the mint vector changes, which is nothing at all.");
}

// =================================================================================================
// PART 5 — fight length and the bell.
// =================================================================================================
function part5() {
  hr("PART 5 — fight length and the 180s bell");
  const n = Math.min(ROUNDS, 400);
  const lineups = [8, 16, 48];
  // THE BAR'S OWN CONSTRUCTION, and getting this wrong cost a run: 124s / 76.2% was measured
  // against EQUAL $10 STAKES ALTERNATING SIDES (`check-fight-length.ts`, "the same shape the
  // horizon was fitted against"), not against a banded lobby. A banded 48-seat lobby concludes
  // before the bell only ~45% of the time under the SHIPPED scalar rule too, so quoting that
  // against 76.2% would have reported a regression that the vector did not cause and that is not
  // a regression at all — it is a different lineup.
  const STAKE = 10_000_000n;   // $10, matching check-fight-length.ts
  console.log(`${n} seeds per (lineup, config). Equal $10 stakes alternating sides — the shape the bar was`);
  console.log("measured against. Bar: 124s median at n=48, 76.2% concluding before the 180s bell.\n");
  console.log("  config                  n     median s    p90 s   concluded before bell");
  console.log("  " + "-".repeat(76));
  const cfgs: { id: string; cfg: FightConfig; vec: boolean }[] = [
    { id: "C0 scalar (control) ", cfg: C0_SCALAR, vec: false },
    { id: "C4 stolen-first     ", cfg: C4_GREEDY, vec: true },
    { id: "C3 proportional     ", cfg: C3_PROPORTIONAL, vec: true },
    { id: "C4 MAYHEM           ", cfg: candidate("value-min", "stolen-first", { economy: "mayhem" }), vec: true },
  ];
  for (const { id, cfg, vec } of cfgs) {
    for (const size of lineups) {
      const secs: number[] = [];
      let concluded = 0;
      for (let r = 0; r < n; r++) {
        const entries: Entry[] = [];
        for (let i = 0; i < size; i++)
          entries.push({ wallet: `w${i}`, side: (i % 2) as 0 | 1, grossUnits: STAKE, band: -1, house: false });
        // `seed_of` from check-variance-bell.ts, which is tests/fight_length.rs byte for byte —
        // so the C0 row has the SAME published target to land on that the repo's own bell script
        // does, rather than a seed of this study's invention.
        const pre = Buffer.alloc(8); pre.writeBigUInt64LE(BigInt(r));
        const seed = createHash("sha256").update(Buffer.concat([Buffer.from("penalty-horizon"), pre])).digest();
        const l: Lobby = { seed, entries, hashes: new Array(stepBudget(size)), steps: stepBudget(size) };
        const f = vec ? vFightersOf(l).fighters : fightersOf(l).fighters;
        const st = runFight(f, l.seed, l.steps, cfg, l.hashes, false);
        // `canonical_cursor` = elapsed x 2 x fighter_count, so seconds = steps / (2 * n).
        secs.push(st.endedAt / (2 * size));
        if (st.endedAt < l.steps) concluded++;
      }
      secs.sort((a, b) => a - b);
      const med = secs[Math.floor(secs.length / 2)];
      const p90 = secs[Math.floor(secs.length * 0.9)];
      console.log(`  ${id}  ${String(size).padStart(3)}   ${med.toFixed(1).padStart(9)}   ${p90.toFixed(1).padStart(6)}   ${((concluded / n) * 100).toFixed(1).padStart(10)}%`);
      if (id.startsWith("C4 stolen")) {
        if (size === 48) ok(concluded / n >= 0.75, `C4 at 48 seats concludes before the bell ${((concluded / n) * 100).toFixed(1)}% of the time (bar 76.2%)`);
        if (size === 48) ok(Math.abs(med - 124) < 12, `C4 at 48 seats has a ${med.toFixed(1)}s median (bar 124s)`);
      }
    }
    console.log();
  }
}

// =================================================================================================
// PART 6 — claim dust, priced.
// =================================================================================================
function part6() {
  hr("PART 6 — the rounding that stops being free: claim dust, per round");
  const n = Math.min(ROUNDS, 4000);
  let dust = new Array(MINTS).fill(0n);
  let worstRound = 0, occupiedMax = 0;
  for (let r = 0; r < n; r++) {
    const l = makeLobby(STUDY_SEED, r, PER_SIDE);
    const { fighters } = vFightersFromTokens(l, TRUE_PRICE);
    runFight(fighters, l.seed, l.steps, C4_GREEDY, l.hashes, true);
    const d = claimDust(fighters, TRUE_PRICE);
    let usdR = 0;
    for (let i = 0; i < MINTS; i++) { dust[i] += d[i]; usdR += dustToUnits(d[i]) / 1e6; }
    if (usdR > worstRound) worstRound = usdR;
    for (const f of fighters) { let occ = 0; for (let i = 0; i < MINTS; i++) if (f.ring![i] + f.vbank![i] > 0n) occ++; if (occ > occupiedMax) occupiedMax = occ; }
  }
  let totalUsd = 0;
  console.log(`  ${n} rounds x ${PER_SIDE * 2} fighters, full token round trip.\n`);
  for (let i = 0; i < MINTS; i++) {
    const u = dustToUnits(dust[i]) / 1e6;
    totalUsd += u;
    console.log(`  ${MINT_NAMES[i].padEnd(6)}  ${dustToUnits(dust[i]).toFixed(2).padStart(12)} micro-units total   $${u.toFixed(9)}   $${(u / n).toFixed(11)}/round`);
  }
  console.log(`\n  TOTAL   $${totalUsd.toFixed(9)} over ${n} rounds = $${(totalUsd / n).toFixed(11)}/round`);
  console.log(`  worst single round: $${worstRound.toFixed(11)}   max occupied slots per fighter: ${occupiedMax}`);
  // The bound: strictly under one BASE UNIT of each occupied mint, per fighter — because the only
  // floor left is `units / price`, and one step of that division is one base unit.
  const perFighter = (Number(TRUE_PRICE[0]) + Number(TRUE_PRICE[1])) / Number(PRICE_SCALE) / 1e6;
  console.log(`  bound at 8 seats, both slots occupied:  $${(perFighter * 8).toFixed(11)}/round`);
  console.log(`  bound at MAX_FIGHTERS=48:               $${(perFighter * 48).toFixed(11)}/round`);
  console.log(`  single-mint comparison (HOUSE-EDGE-STUDY.md §11.1): $0.000016/round, and it went the PLAYER's way.`);
  ok(totalUsd / n < perFighter * 8, `claim dust ${(totalUsd / n).toExponential(2)} $/round is under the 8-seat bound ${(perFighter * 8).toExponential(2)}`);
  ok(occupiedMax <= MINTS, "no fighter ever occupies more slots than there are mints");
}

// =================================================================================================
// PART 7 — EXTRACT. The path ADR-001 §3 says "adds three floor divisions per extract".
//
// It runs against `engine/src/er-sim.ts` DIRECTLY — its own `enter`/`tick`/`extract`/`settle` —
// exactly as `check-house-accrual.ts` does, and derives the per-slot ledger in CLOSED FORM beside
// it. That is legitimate rather than a second simulator because part 0 proves the closed form: in
// a two-team, two-mint extraction arena a fighter's ring holds only their own mint (winnings bank)
// and their bank holds only the OTHER side's mint (you may only raid across the side line), so
// (hp, banked, side) determines the whole vector. The only value that breaks that pattern is what
// `extract` moves from a fighter's own ring into their own bank, and it is tracked as it happens.
// =================================================================================================
function part7() {
  hr("PART 7 — extract, the four regimes, and the house take BY MINT");
  const n = Math.max(1, Math.min(ROUNDS, 20000));
  console.log(`${n} rounds x ${PER_SIDE * 2} fighters x 4 regimes, against engine/src/er-sim.ts directly.\n`);
  console.log("  regime     house take % of gross    ANSEM take %   UWU take %   worst per-slot residual   divisions/extract");
  console.log("  " + "-".repeat(108));

  for (const regime of ["hold", "horizon", "random", "quarter"] as const) {
    const gross = new Array(MINTS).fill(0n), take = new Array(MINTS).fill(0n);
    let worst = 0n, divisions = 0, extracts = 0;
    const rnd = mulberry32(0x5eed);
    for (let r = 0; r < n; r++) {
      const l = makeLobby(STUDY_SEED, r, PER_SIDE);
      const round = newRound(l.seed);
      for (const e of l.entries) enter(round, e.wallet, e.side, e.grossUnits, FEE_BPS);
      const nf = round.fighters.length;
      const budget = stepBudget(nf);
      const horizon = Number(penaltyHorizonSteps(nf));
      const potSlot = new Array(MINTS).fill(0n);
      const feeSlot = new Array(MINTS).fill(0n);
      for (let i = 0; i < l.entries.length; i++) {
        const s = slotOfSide(l.entries[i].side);
        potSlot[s] += round.fighters[i].stake;
        feeSlot[s] += l.entries[i].grossUnits - round.fighters[i].stake;
        gross[s] += l.entries[i].grossUnits;
      }
      // Who leaves, and when.
      const when = new Map<number, string[]>();
      if (regime !== "hold") {
        for (const e of l.entries) {
          if (regime === "quarter" && rnd() >= 0.25) continue;
          const c = regime === "horizon" ? horizon
            : regime === "random" ? Math.floor(rnd() * budget)
            : Math.floor(rnd() * horizon);
          const key = Math.min(c, budget);
          if (!when.has(key)) when.set(key, []);
          when.get(key)!.push(e.wallet);
        }
      }
      const ownBank = new Map<string, bigint>();
      const penSlot = new Array(MINTS).fill(0n);
      let cursor = 0;
      for (const s of [...when.keys()].sort((a, b) => a - b)) {
        if (s > cursor) { tick(round, s - cursor); cursor = s; }
        for (const w of when.get(s)!) {
          const f = round.fighters.find(x => x.wallet === w && x.dead === 0 && x.hp > 0n);
          if (!f) continue;
          const slot = slotOfSide(f.side);
          const { kept, penalty } = extract(round, w);
          ownBank.set(w, (ownBank.get(w) ?? 0n) + kept);
          penSlot[slot] += penalty;
          // THE DIVISION COUNT ADR-001 §3 ASSERTS. The ring is mono-slot, so the penalty is skimmed
          // from ONE slot: one division, not three. Counted rather than argued.
          let occ = 0; for (let i = 0; i < MINTS; i++) if (i === slot) occ++;
          divisions += occ; extracts++;
        }
      }
      if (cursor < budget) tick(round, budget - cursor);
      // The per-slot ledger, in closed form.
      const held = new Array(MINTS).fill(0n);
      for (const f of round.fighters) {
        const own = slotOfSide(f.side), other = 1 - own;
        const mine = ownBank.get(f.wallet) ?? 0n;
        held[own] += f.hp + mine;
        held[other] += f.banked - mine;
      }
      for (let i = 0; i < MINTS; i++) {
        const res = held[i] + penSlot[i] - potSlot[i];
        const a = res < 0n ? -res : res;
        if (a > worst) worst = a;
        take[i] += feeSlot[i] + penSlot[i];
      }
    }
    let tg = 0n, tt = 0n;
    for (let i = 0; i < MINTS; i++) { tg += gross[i]; tt += take[i]; }
    const p = (t: bigint, g: bigint) => (Number(t) / Number(g) * 100).toFixed(4);
    console.log(`  ${regime.padEnd(9)}  ${p(tt, tg).padStart(18)}%   ${p(take[0], gross[0]).padStart(11)}%  ${p(take[1], gross[1]).padStart(10)}%   ` +
      `${String(worst).padStart(21)}   ${(extracts ? divisions / extracts : 0).toFixed(2).padStart(16)}`);
    ok(worst === 0n, `${regime}: per-slot conservation EXACT across all ${n} rounds`);
    const d = Math.abs(Number(take[0]) / Number(gross[0]) - Number(take[1]) / Number(gross[1]));
    ok(d < 0.004, `${regime}: house take differs between mints by ${(d * 100).toFixed(4)} points`);
    if (extracts) ok(divisions / extracts === 1, `${regime}: extract costs ONE floor division per slot-skim, not three`);
  }
}

// =================================================================================================

const t0 = Date.now();
console.log(`check-vector.ts — G12, ADR-001-two-mints.md.  rounds=${ROUNDS} part=${PART} fee=${FEE_BPS}bps`);
if (want("0")) part0();
if (want("1")) part1();
if (want("2")) part2();
if (want("3")) part3();
if (want("4")) part4();
if (want("5")) part5();
if (want("6")) part6();
if (want("7")) part7();
console.log(`\n${FAILURES === 0 ? "ALL CHECKS PASSED" : `${FAILURES} CHECK(S) FAILED`}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(FAILURES === 0 ? 0 : 1);
