// SANDBOX. Run from engine/:  HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/small-stake-field.ts [rounds]
//
// WHO PAYS FOR THE SMALL-STAKE BONUS, AND WHAT HAPPENS WHEN THEY ARE NOT IN THE ROOM.
//
// Every mechanic in this study is a REDISTRIBUTION: `parity.ts` asserts value is conserved for all 98
// (attacker, defender, basis) combinations, so a blended damage basis cannot create money. It can only
// move it from large rings to small ones. That has a consequence nobody has measured and which bounds
// the entire mechanic from above:
//
//     THE BONUS A SMALL PLAYER RECEIVES IS PAID BY THE LARGE PLAYERS IN THEIR OWN LOBBY. In a lobby
//     with no large players, the bonus is zero, however aggressive the setting.
//
// That matters here specifically, and not as a theoretical caveat. `er-demo/public/keeper-status.json`
// round #20 reports `fighterCount: 1, houseFighterCount: 1, realFighterCount: 0`, and the deployed
// house ladder stakes $5-$20 per bot (`config.ts:644,645`). A board made of house bots at $5-$20 has
// almost no dispersion, so a mechanic that pays small stakes out of large ones has almost nothing to
// pay out of. This script measures how the intended effect decays as the field's dispersion falls.
//
// It also measures the second-order fact that decides whether the mechanic can be a PRODUCT rather
// than an exploit: the bonus is zero-sum WITHIN the small cohort. If everyone in the room is small,
// nobody is favoured — so the mechanic's value to a genuine small player falls as the mechanic
// succeeds in attracting more of them.
//
// NOTHING HERE IS DEPLOYED. Sandbox only; reads `fight-variant.ts`, writes nothing.

import { runFight, payout, DUST_ABSOLUTE, W_UNIFORM, FEE_BPS } from "./fight-variant.ts";
import type { FightConfig, DustRule } from "./fight-variant.ts";
import { finish, fightersOf, usd, toUsd, pct } from "./lobby.ts";
import type { Entry } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";

const ROUNDS = Number(process.argv[2] ?? 3000);
const STUDY_SEED = "small-stake-field-v1";
const ABS: DustRule = { kind: "absolute", units: DUST_ABSOLUTE };

/** The deployed byte layout and the deployed defender draw. The ONLY thing that varies across the
 *  columns below is the damage basis, so a difference cannot be blamed on the draw. */
const cfg = (P: bigint): FightConfig => ({
  attacker: W_UNIFORM, defender: W_UNIFORM, dust: ABS,
  layout: "legacy", defenderDraw: "shift",
  damage: P === -1n ? "min" : { blend: P },
});

const PS: bigint[] = [-1n, 10n, 20n, 40n, 100n];
const label = (P: bigint) => (P === -1n ? "SHIPPED(min)" : `P=${P}bps`);

/** A field is described by the stakes of the OTHER seats. The subject always stakes $5. */
interface Field { name: string; stakes: (r: () => number) => number[]; }

const SEATS = 8;
const FIELDS: Field[] = [
  { name: "live board: 7 house bots $5-$20      ", stakes: r => Array.from({ length: SEATS - 1 }, () => 5 + r() * 15) },
  { name: "all equal to the subject: 7 x $5     ", stakes: () => Array.from({ length: SEATS - 1 }, () => 5) },
  { name: "small cohort: 7 x $3-$8              ", stakes: r => Array.from({ length: SEATS - 1 }, () => 3 + r() * 5) },
  { name: "the invented BANDS field (mean ~$42) ", stakes: r => Array.from({ length: SEATS - 1 }, () => [90, 65, 35, 14, 5.5][Math.floor(r() * 5)] * (0.8 + 0.4 * r())) },
  { name: "one whale $100 + 6 x $5              ", stakes: r => [100, ...Array.from({ length: SEATS - 2 }, () => 5)] },
  { name: "three whales $100 + 4 x $5           ", stakes: r => [100, 100, 100, ...Array.from({ length: SEATS - 4 }, () => 5)] },
  { name: "all whales: 7 x $100                 ", stakes: () => Array.from({ length: SEATS - 1 }, () => 100) },
];

/** The lobbies for one field, built ONCE and shared by every P.
 *
 *  This is the `lobby.ts` common-random-numbers idiom and it is not an optimisation for its own sake:
 *  the lazy `hashes` table means the sha256 chain is computed once per lobby and reused by every
 *  configuration scored against it, which makes the columns PAIRED. Building a fresh lobby per (P,
 *  round) — the first draft did — both destroys the pairing and recomputes ~2,880 hashes per cell,
 *  which is where a two-minute run became a forty-minute one. */
function lobbiesFor(f: Field) {
  const out = [];
  for (let r = 0; r < ROUNDS; r++) {
    const rnd = mulberry32(((r * 2654435761) ^ 0x9e3779b9) >>> 0);
    const others = f.stakes(rnd);
    const entries: Entry[] = [{ wallet: "subject", side: 0, grossUnits: usd(5), band: -1, house: false }];
    // Sides alternate from seat 1 so the subject always faces the same side-balance whatever the
    // field is; otherwise a field change would confound "who is in the room" with "how many are
    // opposite me", and only the first is under test.
    others.forEach((s, i) => entries.push({ wallet: `o${i}`, side: ((i + 1) % 2) as 0 | 1, grossUnits: usd(s), band: -1, house: false }));
    out.push(finish(`${STUDY_SEED}|${f.name}`, r, entries));
  }
  return out;
}

/** Ratio-of-sums ROI for seat 0 with a bootstrap SE over ROUNDS — rounds are the independent unit,
 *  because two fighters in one round are one another's counterparty (lobby.ts:`roiWithSE`). */
function subject(P: bigint, lobbies: ReturnType<typeof lobbiesFor>): { roi: number; se: number; sdRound: number } {
  const per: { inn: number; out: number }[] = [];
  for (let r = 0; r < lobbies.length; r++) {
    const lobby = lobbies[r];
    const { fighters } = fightersOf(lobby);
    const net = fighters.reduce((a, g) => a + g.stake, 0n);
    runFight(fighters, lobby.seed, lobby.steps, cfg(P), lobby.hashes, true);
    const end = fighters.reduce((a, g) => a + g.hp + g.banked, 0n);
    if (end !== net) { console.error(`CONSERVATION FAILED round ${r}: ${net} in, ${end} out`); process.exit(1); }
    per.push({ inn: toUsd(lobby.entries[0].grossUnits), out: toUsd(payout(fighters[0])) });
  }
  let I = 0, O = 0; for (const p of per) { I += p.inn; O += p.out; }
  const roi = O / I - 1;
  const rs = per.map(p => p.out / p.inn - 1);
  const m = rs.reduce((a, x) => a + x, 0) / rs.length;
  const v = rs.reduce((a, x) => a + (x - m) ** 2, 0) / (rs.length - 1);
  return { roi, se: Math.sqrt(v / rs.length), sdRound: Math.sqrt(v) };
}

console.log(`\n${"=".repeat(120)}`);
console.log(`WHO PAYS FOR THE SMALL-STAKE BONUS  —  the subject always stakes $5; only the FIELD changes`);
console.log(`${"=".repeat(120)}`);
console.log(`REPRODUCE:  cd engine && HE_FEE_BPS=${FEE_BPS} npx tsx ../sandbox/house-edge/small-stake-field.ts ${ROUNDS}`);
console.log(`seeds: fight sha256("he|${STUDY_SEED}|<field>|<round>"), field mulberry32((round*2654435761)^0x9e3779b9)`);
console.log(`${ROUNDS} rounds x ${SEATS} seats, fee ${FEE_BPS} bps, conservation asserted in integers every round.`);
console.log(`\nA $5 subject's ROI per round. The fee alone would be -1.00%; anything above that is the bonus.\n`);

// Every cell is computed EXACTLY ONCE and the three tables are three views of the same grid. The
// first draft recomputed the grid per table, which tripled a 5-minute run for no extra information.
const GRID = FIELDS.map(f => {
  const rnd = mulberry32(12345);
  let s = 0; for (let i = 0; i < 400; i++) { const xs = f.stakes(rnd); s += xs.reduce((a, x) => a + x, 0) / xs.length; }
  const lobbies = lobbiesFor(f);
  return { f, meanField: s / 400, rows: PS.map(P => subject(P, lobbies)) };
});

const head = "field for the other 7 seats            mean field $" + PS.map(P => label(P).padStart(16)).join("");
console.log(head); console.log("-".repeat(head.length));
for (const g of GRID)
  console.log(`${g.f.name} ${("$" + g.meanField.toFixed(2)).padStart(12)}` +
    g.rows.map(r => `${pct(r.roi, 2)}+-${(r.se * 100).toFixed(2)}`.padStart(16)).join(""));

console.log(`\n--- the same rows, as the BONUS ONLY (ROI minus the SHIPPED column, percentage points) ---\n`);
const h2 = "field for the other 7 seats            mean field $" + PS.slice(1).map(P => label(P).padStart(16)).join("");
console.log(h2); console.log("-".repeat(h2.length));
for (const g of GRID) {
  const base = g.rows[0];
  console.log(`${g.f.name} ${("$" + g.meanField.toFixed(2)).padStart(12)}` +
    g.rows.slice(1).map(r => `${pct(r.roi - base.roi, 2)}+-${(Math.hypot(r.se, base.se) * 100).toFixed(2)}`.padStart(16)).join(""));
}

console.log(`\n--- per-round ROI standard deviation for the same $5 subject (the VARIANCE channel) ---\n`);
const h3 = "field for the other 7 seats                        " + PS.map(P => label(P).padStart(16)).join("");
console.log(h3); console.log("-".repeat(h3.length));
for (const g of GRID)
  console.log(`${g.f.name}             ` + g.rows.map(r => `${(r.sdRound * 100).toFixed(1)}%`.padStart(16)).join(""));
console.log(`
READ THIS BEFORE QUOTING ANY NUMBER ABOVE. The bonus is a transfer out of the large rings in the SAME
lobby. Two consequences follow and both bound the mechanic from above:
  1. On a board with no dispersion there is nothing to transfer, so the bonus is ~0 at every setting.
     The live board (keeper-status.json #20: realFighterCount 0, house bots $5-$20) is that board.
  2. The bonus is zero-sum inside the small cohort, so it is worth LESS to a genuine small player the
     better the mechanic works at attracting more of them. It is self-extinguishing as a product.
`);
