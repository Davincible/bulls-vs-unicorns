// SANDBOX — NOT SHIPPED, NOT ON CHAIN, NOT IMPORTED BY THE ENGINE OR THE DEMO.
//
// Run: cd engine && HE_FEE_BPS=100 NODE_OPTIONS=--max-old-space-size=12288 \
//        npx tsx ../sandbox/house-edge/small-stake-pstar.ts [rounds] [part]
//   `part` is 0|A|B|C|D|E|F|all so the parts can be run as parallel background processes.
//
// THE ONE QUESTION THIS FILE ANSWERS
// ---------------------------------
//   Is there a tilt P weak enough to be UNPROFITABLE TO FARM after the attacker's own transaction
//   costs, yet strong enough to MATTER to a genuine small player?
//
// Define P* = the largest blend setting at which an optimally-splitting attacker's net is at or
// below zero after their own per-wallet-per-round gas. The deliverable is not P* on its own; it is
// what an honest small player actually gets AT P*. If a $5 wallet's edge at P* is +0.02%/round the
// window is real and worthless. If it is +2%/round the mechanic is shippable.
//
// THE CONSTRAINT THAT MAY DECIDE IT BEFORE ANY SIMULATION
// ------------------------------------------------------
// `P` is a u16 in BASIS POINTS. The smallest representable non-zero tilt is P = 1 bps. If P* < 1 bps
// then no shippable setting exists at all and the dial's own granularity forecloses the question.
// P = 1 is therefore MEASURED DIRECTLY as its own row everywhere it appears — never interpolated.
//
// THE MEASUREMENT PROBLEM AND HOW IT IS SOLVED
// -------------------------------------------
// At P = 1 bps the effect on a mid-sized wallet is ~1/20th of what the prior rig measured at P = 20,
// against a ~44% per-round standard deviation. An UNPAIRED run cannot see it. So EVERYTHING here is
// paired against P = 0 on the identical lobby AND the identical lazy sha256 hash table, exactly as
// study-damage.ts and small-stake-farm.ts do: the lobby is built once per round and every P is
// scored against it, round-major. The reported quantity is always the PAIRED DIFFERENCE and its own
// standard error — never two independent levels for the reader to subtract. Where the paired SE is
// too large to separate P = 1 from P = 0, the table says so and prints the resolution limit instead
// of a point estimate.
//
// WHAT THE PAIRING DOES AND DOES NOT BUY. Under uniform weights the (attacker, defender) index pair
// at each step comes from the hash bytes alone and never from the fighters' state, so two runs at
// different P walk the SAME sequence of candidate exchanges. Only the amounts differ — until a
// death flips, which changes who is skipped from that step on. The paired difference is therefore
// "nearly deterministic with occasional discrete jumps", not exactly deterministic, and its measured
// SE (printed everywhere) is the honest statement of how much of it survived.
//
// FRAMING, CARRIED INTO THE OUTPUT RATHER THAN LEFT IN THE BRIEF
// -------------------------------------------------------------
// Even at a safe P*, the tilt favours SMALL PLAYERS and not the operator. The house gains nothing
// directly from it — the fight conserves value exactly, so a tilt is a transfer between players —
// and the operator still pays keeper gas that no player pays. Any case for shipping this is a
// PRODUCT case, not a revenue case and not a farming case. The script says so in its own header.
//
// INTEGERS. Every money path is BigInt micro-units (1e6 = $1). Floats appear only in reporting and
// in the statistics. CONSERVATION IS ASSERTED, NOT ASSUMED: after every fight this file runs, in
// every part, it checks the integer identity
//        sum_i (hp_i + banked_i)  ===  sum_i (net stake_i)  ===  sum_i gross_i - sum_i fee_i
// and `process.exit(1)`s on the first failure. The count of checked fights is printed per part.

import { createHash } from "node:crypto";
import {
  runFight, payout, makeFighter, FEE_BPS, BPS, DUST_ABSOLUTE, W_UNIFORM, BASELINE, MAX_FIGHTERS,
} from "./fight-variant.ts";
import type { Fighter, FightConfig, DustRule } from "./fight-variant.ts";
import { BANDS, finish, makeLobby, usd, pct, toUsd } from "./lobby.ts";
import type { Entry, Lobby } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { CAP as STAKE_CAP_USD, MIN_ENTRY } from "../../engine/src/arenas.ts";

// ================================================================================================
// PARAMETERS
// ================================================================================================

const ROUNDS = Number(process.argv[2] ?? 600);
const PART = String(process.argv[3] ?? "all");
const STUDY_SEED = "small-stake-pstar-v1";
const ABS: DustRule = { kind: "absolute", units: DUST_ABSOLUTE };

/** THE DIAL, in basis points, on a log grid that INCLUDES 1 — the smallest representable setting.
 *  P = 0 is the shipped size-neutral rule and is the pairing control for every other column. */
const P_GRID = [0n, 1n, 2n, 3n, 5n, 10n, 20n, 40n, 100n];
/** The sub-grid used to estimate the small-P slope. Deliberately excludes P >= 10, where death-flip
 *  cascades make the bonus visibly super-linear and an extrapolation to P < 1 would be flattered. */
const P_SLOPE = [1n, 2n, 3n, 5n];

const SEATS_GRID = [8, 16, 32, 48];          // 48 = MAX_FIGHTERS, the live cap. 30-48 is the reality.
/** $0.40 = 40 wallets at the $0.01 minimum entry, which is the brief's floor. $2 and $8 are ADDED to
 *  the brief's grid because the first smoke run put the binding cell at the SMALLEST budget and left
 *  a 50x gap above it; without them the boundary between "farmable" and "not" would be located only
 *  to within a factor of 50, and that boundary is the deliverable. */
const BUDGETS = [0.40, 2, 8, 20, 80, 400];
const K_GRID = [1, 2, 4, 8, 16, 24, 32, 40];
const HONEST_STAKES = [0.50, 1, 5, 20];
/** Part F's stake sweep for b(s), the per-wallet bonus curve. Spans the whole legal range. */
const B_CURVE_STAKES = [0.01, 0.05, 0.20, 0.50, 1, 3, 5, 10, 20, 50];

/** PER-WALLET PER-ROUND GAS, swept rather than assumed. One Solana signature is 5,000 lamports =
 *  0.000005 SOL = $0.00075 at SOL $150; on the ephemeral rollup it is lower still, which is why $0
 *  is in the grid as the attacker's best case. The upper end is not a real Solana price — it is the
 *  answer to "how expensive would an entry have to be", which PART E inverts explicitly. */
const SIG_LAMPORTS = 5000;
const SOL_USD = Number(process.env.SOL_USD ?? 150);
const SIG_USD = (SIG_LAMPORTS / 1e9) * SOL_USD;   // $0.00075
const GAS_GRID = [0, SIG_USD, 0.0075, 0.05, 0.25, 1.00];

/** Cadence, from SPEC.md's measured baseline. ~110s per round. */
const ROUNDS_PER_HOUR = 3600 / 110;
const ROUNDS_PER_DAY = ROUNDS_PER_HOUR * 24;      // 785.45
const ROUNDS_PER_YEAR = ROUNDS_PER_DAY * 365;     // 286,689 — the detectability horizon
/** Keeper gas, paid by the OPERATOR and by nobody else. Here only to price the framing sentence. */
const KEEPER_GAS_POST_USD = 0.00041 * SOL_USD;

/** THE REALISTIC CELL for the squeeze table: a full board, a serious but not absurd budget, and one
 *  Solana signature per wallet per round. */
const REAL_SEATS = 48, REAL_BUDGET = 80, REAL_GAS = SIG_USD;
/** The bar for "matters to a genuine small player", as PART E inverts it. */
const MATTERS_PCT = 0.01;    // +1%/round on the honest player's own stake

/** ALREADY-MEASURED LIFETIME COHORT CELLS (HOUSE-SMALL-STAKE.md §4.1). Quoted, not re-run: these
 *  come from small-stake-lifetime.ts at 8 replicate populations of 3,000 lives each, Kaplan-Meier,
 *  with the error bar taken BETWEEN replicate populations. `sig` is |delta| / (se) in sigma. */
const LIFETIME_DELTA: { P: bigint; delta: number; se: number; sigma: number }[] = [
  { P: 5n, delta: -0.08, se: 0.42, sigma: 0.4 },
  { P: 10n, delta: +0.34, se: 0.45, sigma: 1.5 },
  { P: 20n, delta: +1.14, se: 0.51, sigma: 4.4 },
  { P: 40n, delta: +1.85, se: 0.51, sigma: 7.2 },
  { P: 100n, delta: +3.80, se: 0.42, sigma: 18.1 },
];

const SEED_FAMILIES = ["pa-farm", "pb-subject", "pf-subject", "p0-lineup", "p0-band"] as const;

// ================================================================================================
// SHARED MACHINERY  (idioms lifted from small-stake-farm.ts; this file is self-contained on purpose,
// because that file executes at import time)
// ================================================================================================

const hash32 = (s: string) => createHash("sha256").update(s).digest().readUInt32LE(0);
const $ = (x: number, d = 2) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(d)}`;
const rule = (n: number) => "-".repeat(n);
const bar = (n: number) => "=".repeat(n);
const mean = (xs: ArrayLike<number>) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]; return s / xs.length; };
const sd = (xs: ArrayLike<number>) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let v = 0; for (let i = 0; i < xs.length; i++) v += (xs[i] - m) * (xs[i] - m);
  return Math.sqrt(v / (xs.length - 1));
};
const meanRange = (xs: ArrayLike<number>, lo: number, hi: number) => {
  let s = 0; for (let i = lo; i < hi; i++) s += xs[i]; return s / (hi - lo);
};
const ci95 = (se: number) => 1.96 * se;
const FEE = Number(FEE_BPS) / 1e4;

type Seat = Entry & { verified?: 0 | 1 };
const seats = (l: Lobby) => l.entries as Seat[];

// ---- the conservation assertion ------------------------------------------------------------------

let CONSERVED = 0;
let CONSERVED_PART = 0;

/** THE IDENTITY: value in the ring plus value banked equals the net stake that entered, exactly, in
 *  integers, and the net stake is the gross minus the fees the house took and not one unit more.
 *  The fight only ever MOVES units between `hp` and `banked`, so any drift is a bug in this rig or
 *  in the loop, and either one voids every number below.
 *
 *  The SECOND equality is the strong form of "the rake remains the only edge": whatever P does to
 *  the distribution among fighters, the field as a whole hands the house exactly `sum(fee)` and the
 *  house takes nothing else. That is asserted here in integers on every fight at every P, which is
 *  a stronger statement than any band table could make with a confidence interval. */
function conserve(fighters: Fighter[], net: bigint, gross: bigint, fees: bigint, where: string): void {
  let s = 0n;
  for (const f of fighters) s += f.hp + f.banked;
  if (s !== net || net !== gross - fees) {
    console.error(`\nCONSERVATION FAILED in ${where}:`);
    console.error(`  sum(hp+banked) = ${s}, net stake = ${net}, gross = ${gross}, fees = ${fees}`);
    console.error(`  deltas: ring-vs-net ${s - net}, net-vs-(gross-fees) ${net - (gross - fees)}`);
    console.error(`Every table in this run is describing a broken game. Exiting.`);
    process.exit(1);
  }
  CONSERVED++; CONSERVED_PART++;
}

function conservationReport(part: string): void {
  console.log(`\n  CONSERVATION: sum(hp+banked) === sum(net stake) === sum(gross) - sum(fees), asserted in integers on`);
  console.log(`  ${CONSERVED_PART.toLocaleString()} fights in PART ${part} (${CONSERVED.toLocaleString()} this process). No failures. The house took exactly the ${FEE_BPS} bps`);
  console.log(`  rake at every P, so the tilt is a transfer BETWEEN PLAYERS and never a second edge.`);
  CONSERVED_PART = 0;
}

// ---- building and playing --------------------------------------------------------------------

interface PlayResult { fighters: Fighter[]; out: bigint[]; fees: bigint }

/** Build the lineup, run the fight to conclusion, assert conservation, return per-seat settlements.
 *  Every fight in this file goes through here, which is what makes "conservation is asserted on
 *  EVERY fight" a property of the rig rather than a promise. */
function play(lobby: Lobby, cfg: FightConfig, where: string, stopWhenOver = true): PlayResult {
  const es = seats(lobby);
  const fighters: Fighter[] = [];
  let fees = 0n, net = 0n, gross = 0n;
  for (const e of es) {
    const { f, fee } = makeFighter(e.wallet, e.side, e.grossUnits, FEE_BPS, e.verified);
    fighters.push(f); fees += fee; net += f.stake; gross += e.grossUnits;
  }
  runFight(fighters, lobby.seed, lobby.steps, cfg, lobby.hashes, stopWhenOver);
  conserve(fighters, net, gross, fees, where);
  return { fighters, out: fighters.map(payout), fees };
}

/** The configuration every part varies. `legacy` is the DEPLOYED byte layout, `shift` is the shipped
 *  defender draw, and the ONLY thing that moves between this and `BASELINE` is the damage basis —
 *  which PART 0 proves, so a difference downstream is attributable to P and to nothing else. */
const blend = (P: bigint): FightConfig => ({
  attacker: W_UNIFORM, defender: W_UNIFORM, dust: ABS, layout: "legacy",
  defenderDraw: "shift", damage: { blend: P },
});

// ---- lobby families ----------------------------------------------------------------------------

/** THE SUBJECT LOBBY — the intended-effect rig. Seat 0 is the player under study; seats 1..n-1 are
 *  background drawn from BANDS (mean ~$42). The background depends on (family, round, seats) and
 *  NEVER on the subject's stake, and the fight seed does not read the entries at all, so an entire
 *  stake sweep can be scored against literally the same opponents, the same sides and the same
 *  lazily-filled hash table by mutating `entries[0].grossUnits` in place between cells. */
function subjectLobby(family: string, round: number, n: number): Lobby {
  const rnd = mulberry32(hash32(`${STUDY_SEED}|${family}|${n}|${round}`));
  const es: Seat[] = [{ wallet: "subject", side: 0, grossUnits: 0n, band: -1, house: true, verified: 0 }];
  for (let i = 0; i < n - 1; i++) {
    const b = Math.floor(rnd() * BANDS.length);
    const band = BANDS[b];
    es.push({
      wallet: `p${i}`, side: ((i + 1) % 2) as 0 | 1,
      grossUnits: usd(band.lo + rnd() * (band.hi - band.lo)),
      band: b, house: false, verified: 0,
    });
  }
  return finish(`${STUDY_SEED}|${family}|${n}`, round, es);
}

/** THE FARM LOBBY — the farm-rate rig, copied from study-split.ts / small-stake-farm.ts: the lobby
 *  is always exactly `n` fighters, the splitter takes k of them and the background takes n - k. That
 *  confounds "more of my wallets" with "fewer of theirs" DELIBERATELY, because it is the actual
 *  trade a player faces in a full lobby.
 *
 *  NEITHER THE STAKES NOR THE SEATING LAYOUT ARE IN THE SEED. The splitter's stakes and its wallets'
 *  SIDES are placeholders set by the caller's `prep`, so one lobby serves every budget, every layout
 *  and every P in the sweep under common random numbers — the background, the background's sides and
 *  the hash table are identical across all of them. It also gives a free control: at k = 1 the two
 *  layouts are the same lineup and must agree to the last unit. */
function farmLobby(family: string, round: number, n: number, k: number): Lobby {
  const rnd = mulberry32(hash32(`${STUDY_SEED}|${family}|${n}|${k}|${round}`));
  const es: Seat[] = [];
  for (let i = 0; i < k; i++)
    es.push({ wallet: `s${i}`, side: 0, grossUnits: 0n, band: -1, house: true, verified: 0 });
  for (let i = 0; i < n - k; i++) {
    const b = Math.floor(rnd() * BANDS.length);
    const band = BANDS[b];
    es.push({
      wallet: `p${i}`, side: ((i + 1) % 2) as 0 | 1,
      grossUnits: usd(band.lo + rnd() * (band.hi - band.lo)),
      band: b, house: false, verified: 0,
    });
  }
  return finish(`${STUDY_SEED}|${family}|${n}|${k}`, round, es);
}

/** Split `total` micro-units across k wallets so the parts sum EXACTLY to `total` — the first
 *  `total % k` wallets get one unit more. Reporting "ROI on the whole budget" is only honest if the
 *  wallets actually add up to the budget; `usd(B/k)` rounds and they do not. */
function splitUnits(total: bigint, k: number): bigint[] {
  const K = BigInt(k), base = total / K, rem = total % K;
  return Array.from({ length: k }, (_, i) => base + (BigInt(i) < rem ? 1n : 0n));
}

// ---- scoring -----------------------------------------------------------------------------------

interface CellSpec { prep: (l: Lobby) => void; cfg: FightConfig; where: string }

/** Score a list of cells against one lobby family, ONE ROUND AT A TIME.
 *
 *  Round-major rather than cell-major for two reasons. Memory: a 48-seat lobby carries a 17,280-slot
 *  lazy hash table and holding `rounds` of them at once is what forces --max-old-space-size on the
 *  older studies; here exactly one is live. Pairing: every cell in the list sees the same lobby AND
 *  the same filled hash slots, so differences between cells are paired and their standard errors are
 *  one to two orders of magnitude below independent sampling. THIS IS THE WHOLE REASON P = 1 IS
 *  MEASURABLE AT ALL.
 *
 *  `prep` must set everything its cell cares about, because the previous cell's mutation is still
 *  there. Returns, per cell, the per-round dollar total taken by the seats `take` selects. */
function scoreCells(
  rounds: number,
  mk: (r: number) => Lobby,
  cells: CellSpec[],
  take: (i: number) => boolean,
): Float64Array[] {
  const acc = cells.map(() => new Float64Array(rounds));
  for (let r = 0; r < rounds; r++) {
    const lobby = mk(r);
    for (let c = 0; c < cells.length; c++) {
      cells[c].prep(lobby);
      const res = play(lobby, cells[c].cfg, cells[c].where);
      let out = 0;
      for (let i = 0; i < res.out.length; i++) if (take(i)) out += toUsd(res.out[i]);
      acc[c][r] = out;
    }
  }
  return acc;
}

/** A paired difference and its standard error over rounds. `a` and `b` are per-round dollar
 *  outcomes measured ON THE SAME ROUNDS, so the difference is taken round by round BEFORE averaging.
 *  Reporting mean(a) - mean(b) with two independent SEs would inflate the error by one to two orders
 *  of magnitude and would hide every result below P = 10. */
interface Paired { d: number; se: number; n: number }
function paired(a: Float64Array, b: Float64Array): Paired {
  const n = a.length;
  const diff = new Float64Array(n);
  for (let i = 0; i < n; i++) diff[i] = a[i] - b[i];
  return { d: mean(diff), se: sd(diff) / Math.sqrt(n), n };
}
/** The resolution limit of a paired estimate: the smallest magnitude it can call non-zero at 95%. */
const resolvable = (p: Paired) => Math.abs(p.d) > ci95(p.se);
const pairedS = (p: Paired, scale: number, d = 4) =>
  `${(p.d * scale >= 0 ? "+" : "")}${(p.d * scale).toFixed(d)}+-${(ci95(p.se) * scale).toFixed(d)}`;

// ================================================================================================
// HEADER
// ================================================================================================

function header(): void {
  console.log(`\n${bar(132)}`);
  console.log(`P* — THE LARGEST TILT THAT CANNOT PAY FOR ITS OWN FARM, AND WHAT AN HONEST SMALL PLAYER GETS THERE`);
  console.log(bar(132));
  console.log(`reproduce exactly:`);
  console.log(`    cd engine && HE_FEE_BPS=${FEE_BPS} SOL_USD=${SOL_USD} NODE_OPTIONS=--max-old-space-size=12288 \\`);
  console.log(`        npx tsx ../sandbox/house-edge/small-stake-pstar.ts ${ROUNDS} ${PART}`);
  console.log(``);
  console.log(`  fee rate under test      ${FEE_BPS} bps   (fight-variant.ts reads HE_FEE_BPS; the live arena charges 100)`);
  console.log(`  rounds per cell          ${ROUNDS.toLocaleString()}          part  ${PART}`);
  console.log(`  P grid (bps)             ${P_GRID.join(", ")}   — P=1 IS MEASURED, NEVER INTERPOLATED`);
  console.log(`  seats / budgets / k      ${SEATS_GRID.join(",")} / ${BUDGETS.map(b => $(b, 2)).join(",")} / ${K_GRID.join(",")}, both layouts`);
  console.log(`  per-wallet gas grid      ${GAS_GRID.map(g => $(g, 5)).join(", ")}   (one signature = ${SIG_LAMPORTS} lamports = ${$(SIG_USD, 5)} at SOL ${$(SOL_USD, 0)})`);
  console.log(`  min entry / stake cap    ${$(MIN_ENTRY, 2)} / ${$(STAKE_CAP_USD, 0)}   dust floor ${DUST_ABSOLUTE} units = ${$(Number(DUST_ABSOLUTE) / 1e6, 3)}`);
  console.log(`  cadence                  ~110s -> ${ROUNDS_PER_DAY.toFixed(0)} rounds/day -> ${Math.round(ROUNDS_PER_YEAR).toLocaleString()} rounds/year`);
  console.log(``);
  console.log(`  SEEDS. Study seed "${STUDY_SEED}". Nothing else is random; there is no unseeded call anywhere.`);
  console.log(`    subject lobbies   stakes/sides  mulberry32( sha256("${STUDY_SEED}|<family>|<n>|<round>")[0..4] )`);
  console.log(`                      fight seed    sha256("he|${STUDY_SEED}|<family>|<n>|<round>")`);
  console.log(`    farm lobbies      stakes/sides  mulberry32( sha256("${STUDY_SEED}|<family>|<n>|<k>|<round>")[0..4] )`);
  console.log(`                      fight seed    sha256("he|${STUDY_SEED}|<family>|<n>|<k>|<round>")`);
  console.log(`    families          ${SEED_FAMILIES.join(", ")}`);
  console.log(`    NEITHER THE SPLITTER'S STAKES NOR ITS SEATING LAYOUT IS IN ANY SEED, so every budget, every k-layout`);
  console.log(`    and every P faces an identical background, identical background sides and an identical hash table.`);
  console.log(`    Every difference reported below is PAIRED round by round. Two independent levels are never subtracted.`);
  console.log(bar(132));

  // ---- the framing, stated before any number so it cannot be read as a conclusion drawn from one --
  console.log(`\nWHO THIS MECHANIC IS FOR, STATED UP FRONT BECAUSE IT CONSTRAINS HOW THE TABLES SHOULD BE READ`);
  console.log(rule(132));
  console.log(`  The fight conserves value exactly (asserted in integers on every fight below), so a tilt CREATES NO`);
  console.log(`  MONEY. It is a transfer out of large rings into small ones, in the same lobby, and the house's take is`);
  console.log(`  exactly the ${FEE_BPS} bps rake at P = 0 and at every P above it. The operator therefore gains NOTHING DIRECTLY`);
  console.log(`  from the tilt and still pays keeper gas — ${$(KEEPER_GAS_POST_USD, 4)}/round post-reclaim, ${$(KEEPER_GAS_POST_USD * ROUNDS_PER_DAY, 2)}/day — that no player pays.`);
  console.log(`  Any case for shipping this is a PRODUCT case (does a visible small-player tilt acquire or retain?),`);
  console.log(`  not a farming case and not a revenue case. PART D puts the only measured revenue evidence beside it.`);
  console.log(rule(132));

  // ---- the arithmetic fact, computed from the deployed constants rather than asserted -------------
  const ratio = STAKE_CAP_USD / MIN_ENTRY;
  console.log(`\nAN EXACT ARITHMETIC FACT ABOUT P = 1 BPS, BEFORE ANY SIMULATION`);
  console.log(rule(132));
  console.log(`  The blend is  basis = (P*ring_d + (${BPS}-P)*min(ring_a,ring_d)) / ${BPS}.  For an attacker of ring a against a`);
  console.log(`  defender of ring d > a, that is  basis = a * (1 + (P/${BPS})*(d/a - 1)),  so the attacker's damage is`);
  console.log(`  MULTIPLIED by roughly  1 + P*(d/a)/${BPS}.`);
  console.log(``);
  console.log(`  The legal stake range is [${$(MIN_ENTRY, 2)}, ${$(STAKE_CAP_USD, 0)}] — a span of exactly ${ratio.toLocaleString()}x, which is EXACTLY the basis-point`);
  console.log(`  denominator. So at P = 1 bps, the smallest legal wallet hitting the largest legal wallet has its damage`);
  console.log(`  basis multiplied by  1 + 1*${ratio.toLocaleString()}/${BPS} = ${(1 + ratio / Number(BPS)).toFixed(2)}x  —  IT DOUBLES.`);
  console.log(``);
  console.log(`  THE SMALLEST REPRESENTABLE TILT IS NOT A SMALL TILT AT THE BOTTOM OF THE STAKE RANGE. The u16-in-bps`);
  console.log(`  encoding cannot express a setting mild enough to leave the $0.01 wallet alone, because one bps is`);
  console.log(`  already a 2x multiplier there. Everything PART A measures is downstream of this one line.`);
  console.log(rule(132));
}

// ================================================================================================
// PART 0 — HARNESS SELF-CHECKS. Every one of these must pass or the process exits 1.
// ================================================================================================

/** A deliberately awkward lineup: a random seat count from 2 to 48, stakes log-uniform over the whole
 *  legal range (four orders of magnitude, so `min` and `defender` bases are as far apart as the rules
 *  allow), and random sides. If two rules agree here they agree. */
function randomLineup(round: number): Lobby {
  const rnd = mulberry32(hash32(`${STUDY_SEED}|p0-lineup|${round}`));
  const n = 2 + Math.floor(rnd() * (MAX_FIGHTERS - 1));
  const es: Seat[] = [];
  for (let i = 0; i < n; i++) {
    const lg = Math.log(MIN_ENTRY) + rnd() * (Math.log(STAKE_CAP_USD) - Math.log(MIN_ENTRY));
    es.push({ wallet: `f${i}`, side: (i % 2) as 0 | 1, grossUnits: usd(Math.exp(lg)), band: -1, house: false, verified: 0 });
  }
  es[0].side = 0; es[1].side = 1;   // a one-sided lineup exercises nothing
  return finish(`${STUDY_SEED}|p0-lineup`, round, es);
}

function part0(): void {
  const N = Math.max(200, Math.min(400, ROUNDS));
  console.log(`\n${bar(132)}`);
  console.log(`PART 0 — HARNESS SELF-CHECKS. Any failure exits 1 and every table after it is void.`);
  console.log(bar(132));

  // ---- (i) the shipped-rule identity ------------------------------------------------------------
  console.log(`\n  (i) legacy + shift + {blend: 0} must be BYTE-IDENTICAL to BASELINE (damage "min").`);
  console.log(`      ${N} random lineups, 2-48 seats, stakes log-uniform on [${$(MIN_ENTRY, 2)}, ${$(STAKE_CAP_USD, 0)}], FULL BELL (stopWhenOver OFF).`);
  console.log(`      If this fails, every P-sweep in this file is confounded with the byte layout or the defender draw.`);
  let diff = 0;
  for (let r = 0; r < N; r++) {
    const lobby = randomLineup(r);
    const a = play(lobby, blend(0n), "p0/blend0", false);
    const b = play(lobby, BASELINE, "p0/baseline", false);
    for (let i = 0; i < a.fighters.length; i++) {
      const x = a.fighters[i], y = b.fighters[i];
      if (x.hp !== y.hp || x.banked !== y.banked || x.dead !== y.dead) diff++;
    }
  }
  console.log(`      lineups ${N}   seats differing: ${diff}   ${diff === 0 ? "IDENTICAL" : "*** DIFFERS ***"}`);
  if (diff !== 0) { console.error(`\n  Self-check (i) failed. Exiting 1.`); process.exit(1); }

  // ---- (ii) the fairness constraint --------------------------------------------------------------
  //
  // THE COORDINATOR'S STANDING CONSTRAINT IS "the rake must remain the only edge". There are two
  // readings of that and only one of them is a testable claim about a tilt:
  //
  //   THE EXACT ONE. The FIELD AS A WHOLE hands the house exactly sum(fee) and nothing else. That is
  //   an integer identity, it is asserted on every single fight in this process by `conserve`, and it
  //   holds at every P by construction because the fight only moves units between hp and banked.
  //
  //   THE STATISTICAL ONE. Each stake BAND sits at -fee. This is true and required AT P = 0 — the
  //   shipped rule is size-neutral — and it is deliberately FALSE at every P > 0, because moving the
  //   bands apart IS the mechanic. Asserting it at P > 0 would be a category error: it would fail
  //   exactly when the tilt was working. So P = 0 is ASSERTED (3 SE) and P > 0 is REPORTED, and the
  //   P > 0 rows are the intended tilt on a non-splitting field rather than a fairness violation.
  const NB = Math.max(200, Math.min(600, ROUNDS));
  console.log(`\n  (ii) THE FAIRNESS CONSTRAINT, in its two forms.`);
  console.log(`      EXACT   sum(payout) === sum(gross) - sum(fees), integers, EVERY fight, EVERY P. Asserted by \`conserve\`.`);
  console.log(`      BANDS   a NON-SPLITTING BANDS field, 8 seats, ${NB} rounds, paired across P on one lobby per round.`);
  console.log(`              P = 0 is ASSERTED to sit at -${(FEE * 100).toFixed(2)}% in every band (|roi + fee| <= 3 SE, else exit 1).`);
  console.log(`              P > 0 is REPORTED, not asserted: separating the bands is the mechanic, not a leak.`);

  const bandCells: CellSpec[] = P_GRID.map(P => ({ prep: () => {}, cfg: blend(P), where: `p0-band/P${P}` }));
  const bandIn: number[][] = BANDS.map(() => []);
  const bandOut: number[][][] = P_GRID.map(() => BANDS.map(() => []));
  for (let r = 0; r < NB; r++) {
    const lobby = makeLobby(`${STUDY_SEED}|p0-band`, r, 4);
    const es = seats(lobby);
    const inn = BANDS.map(() => 0);
    for (const e of es) inn[e.band] += toUsd(e.grossUnits);
    for (let b = 0; b < BANDS.length; b++) bandIn[b].push(inn[b]);
    for (let c = 0; c < bandCells.length; c++) {
      const res = play(lobby, bandCells[c].cfg, bandCells[c].where);
      const o = BANDS.map(() => 0);
      for (let i = 0; i < es.length; i++) o[es[i].band] += toUsd(res.out[i]);
      for (let b = 0; b < BANDS.length; b++) bandOut[c][b].push(o[b]);
    }
  }
  const roiOf = (inn: number[], out: number[]) => {
    let I = 0, O = 0; const rs: number[] = [];
    for (let i = 0; i < inn.length; i++) { I += inn[i]; O += out[i]; if (inn[i] > 0) rs.push(out[i] / inn[i] - 1); }
    return { roi: I > 0 ? O / I - 1 : 0, se: sd(rs) / Math.sqrt(rs.length) };
  };
  const hb = `      P (bps)  ` + BANDS.map(b => b.name.trim().padStart(20)).join("") + `      whole field`;
  console.log(`\n${hb}`); console.log(rule(hb.length));
  let bandFail = false;
  for (let c = 0; c < P_GRID.length; c++) {
    const cells = BANDS.map((_, b) => roiOf(bandIn[b], bandOut[c][b]));
    const allIn = bandIn[0].map((_, r) => BANDS.reduce((a, _b, bi) => a + bandIn[bi][r], 0));
    const allOut = bandIn[0].map((_, r) => BANDS.reduce((a, _b, bi) => a + bandOut[c][bi][r], 0));
    const all = roiOf(allIn, allOut);
    if (P_GRID[c] === 0n) for (const cc of cells) if (Math.abs(cc.roi + FEE) > 3 * cc.se) bandFail = true;
    console.log(`      ${String(P_GRID[c]).padStart(7)}  ` +
      cells.map(cc => `${pct(cc.roi, 2)}+-${(cc.se * 100).toFixed(2)}`.padStart(20)).join("") +
      `  ${pct(all.roi, 4).padStart(15)}`);
  }
  console.log(rule(hb.length));
  console.log(`      "whole field" is the exact identity in percentage form: it must read -${(FEE * 100).toFixed(2)}% at every P, and it does,`);
  console.log(`      to four decimals, because the house's take is sum(fee) and the tilt only rearranges what is left.`);
  if (bandFail) {
    console.error(`\n  Self-check (ii) failed: a band at P = 0 is further than 3 SE from -${(FEE * 100).toFixed(2)}%. The shipped rule is not size-neutral`);
    console.error(`  in this rig, so no tilt measured against it means anything. Exiting 1.`);
    process.exit(1);
  }
  console.log(`\n      P = 0 sits at -${(FEE * 100).toFixed(2)}% in every band within 3 SE: PASS. The shipped rule is size-neutral here.`);
  console.log(`      Read the P = 1 row as the answer to "how much of the tilt survives at the smallest representable setting`);
  console.log(`      against a field nobody is splitting". It is the honest player's whole story in one line.`);

  conservationReport("0");
}

// ================================================================================================
// THE ATTACKER SWEEP — shared by PARTS A, C, D and E, computed once per process
// ================================================================================================

interface AtkCell {
  seatsN: number; k: number; stacked: boolean; budget: number; P: bigint;
  legal: boolean;
  /** Per-round P&L in dollars on the WHOLE budget, gross of the attacker's own gas: out - budget.
   *  The fee is already inside it, because `out` is settled from the NET stake. */
  x: Float64Array;
}
/** A[si][ki][li][bi][pi] */
type AtkGrid = { seatsN: number; ks: number[]; cells: AtkCell[][][][] }[];

const ksFor = (n: number) => K_GRID.filter(k => k <= n - 1);
/** PRE-REGISTERED k, fixed by this rule BEFORE any cell was looked at, and stated so it cannot be
 *  quietly changed afterwards: the largest grid k that still leaves a sixth of the board to the
 *  field (k <= 5n/6) and is not the whole board (k <= n-1). n=48 -> 40, n=32 -> 24, n=16 -> 8,
 *  n=8 -> 4. It exists because an argmax over ~16 noisy cells is biased upward, and the volatility
 *  rig learned that the hard way. */
const preRegK = (n: number) => {
  const cap = Math.min(n - 1, Math.floor((5 * n) / 6));
  const ok = ksFor(n).filter(k => k <= cap);
  return ok.length ? ok[ok.length - 1] : ksFor(n)[0];
};

function attackerSweep(): AtkGrid {
  const grid: AtkGrid = [];
  for (const n of SEATS_GRID) {
    const ks = ksFor(n);
    const perK: AtkCell[][][][] = [];
    for (const k of ks) {
      // ONE lobby family per (seats, k). Both layouts, all budgets and all P are scored against it,
      // so 2 x |budgets| x |P| = 72 fights share one background and one lazy hash table per round.
      const cells: CellSpec[] = [];
      const meta: AtkCell[] = [];
      for (const stacked of [true, false]) for (const budget of BUDGETS) for (const P of P_GRID) {
        const per = budget / k;
        cells.push({
          prep: (l: Lobby) => {
            const parts = splitUnits(usd(budget), k);
            const es = seats(l);
            for (let i = 0; i < k; i++) { es[i].grossUnits = parts[i]; es[i].side = (stacked ? 0 : i % 2) as 0 | 1; }
          },
          cfg: blend(P),
          where: `pa/${n}/k${k}/${stacked ? "stk" : "alt"}/$${budget}/P${P}`,
        });
        meta.push({
          seatsN: n, k, stacked, budget, P,
          // A wallet may not exceed STAKE_CAP_USD nor sit below MIN_ENTRY. Illegal cells are run
          // anyway (the fight does not know about the cap) but never enter an argmax or a P*, because
          // a number nobody is allowed to play is not a farm rate.
          legal: per <= STAKE_CAP_USD + 1e-9 && per >= MIN_ENTRY - 1e-9,
          x: new Float64Array(0),
        });
      }
      const acc = scoreCells(ROUNDS, r => farmLobby("pa-farm", r, n, k), cells, i => i < k);
      for (let c = 0; c < meta.length; c++) {
        const x = new Float64Array(ROUNDS);
        for (let r = 0; r < ROUNDS; r++) x[r] = acc[c][r] - meta[c].budget;
        meta[c].x = x;
      }
      // reshape to [layout][budget][P]
      const shaped: AtkCell[][][] = [];
      let c = 0;
      for (let li = 0; li < 2; li++) {
        const byB: AtkCell[][] = [];
        for (let bi = 0; bi < BUDGETS.length; bi++) {
          const byP: AtkCell[] = [];
          for (let pi = 0; pi < P_GRID.length; pi++) byP.push(meta[c++]);
          byB.push(byP);
        }
        shaped.push(byB);
      }
      perK.push(shaped);
    }
    grid.push({ seatsN: n, ks, cells: perK });
  }
  return grid;
}

/** Every legal cell at a given (seats, budget, P), flattened for an argmax. */
function legalCells(g: AtkGrid, si: number, bi: number, pi: number): AtkCell[] {
  const out: AtkCell[] = [];
  const e = g[si];
  for (let ki = 0; ki < e.ks.length; ki++) for (let li = 0; li < 2; li++) {
    const c = e.cells[ki][li][bi][pi];
    if (c.legal) out.push(c);
  }
  return out;
}
/** Net $/round after the attacker's own per-wallet-per-round gas. */
const netOf = (c: AtkCell, g: number, lo = 0, hi = c.x.length) => meanRange(c.x, lo, hi) - c.k * g;

interface BestCell { c: AtkCell | null; net: number; se: number }
function bestBy(cells: AtkCell[], g: number, lo: number, hi: number, evalLo = lo, evalHi = hi): BestCell {
  let best: AtkCell | null = null, bn = -Infinity;
  for (const c of cells) { const v = netOf(c, g, lo, hi); if (v > bn) { bn = v; best = c; } }
  if (!best) return { c: null, net: NaN, se: NaN };
  const n = evalHi - evalLo;
  const ev = netOf(best, g, evalLo, evalHi);
  const slice = best.x.subarray(evalLo, evalHi);
  return { c: best, net: ev, se: sd(slice) / Math.sqrt(n) };
}

// ================================================================================================
// PART A — THE ATTACKER'S NET AFTER THEIR OWN COSTS
// ================================================================================================

/** THE DEFINITION OF "NET", stated once and used everywhere.
 *
 *  The attacker's alternative is NOT PLAYING. So their net is ABSOLUTE: the whole per-round P&L on
 *  the budget, which already carries the ${FEE_BPS} bps rake they pay on entry, minus k signatures of gas.
 *  P* is the largest P at which that is still <= 0.
 *
 *  The INCREMENTAL reading — bonus over P=0 minus gas, ignoring the rake — is also reported, because
 *  it is the right number for an attacker who would be seated anyway (a house bot's operator, a
 *  market maker, anyone farming several arenas at once) and it is a strictly WEAKER requirement. It
 *  is the lower bound on P*, and the closed form in PART F is expressed in it. */
function partA(g: AtkGrid): void {
  console.log(`\n${bar(132)}`);
  console.log(`PART A — THE ATTACKER'S NET AFTER THEIR OWN PER-WALLET-PER-ROUND GAS, AND P*`);
  console.log(bar(132));
  console.log(`  net $/round  =  (settlement - budget)  -  k * g.  The rake is already inside the first term. Gas is charged`);
  console.log(`  PER WALLET PER ROUND, so at k = 40 the attacker signs 40 transactions a round — the cost the existing`);
  console.log(`  $0.01-wallet result ignored entirely.`);
  console.log(`  P* = the largest P in the grid at which the best legal (k, layout) cell is still <= 0.`);

  const half = ROUNDS >> 1;

  // ---- A.0 the P = 0 control -----------------------------------------------------------------------
  //
  // EVERY "P* < 1" CLAIM BELOW IS A CLAIM ABOUT THE TILT, and it is only a claim about the tilt if the
  // SHIPPED rule is not already farmable in the same cell. So the control is measured first and given
  // its own confidence interval. A cell that is significantly positive at P = 0 would be a finding
  // about `damage: "min"` and not about the blend at all, and it would have to be reported as such.
  console.log(`\n${rule(132)}`);
  console.log(`A.0  THE P = 0 CONTROL. Before any tilt: is the SHIPPED rule already farmable by a fine split?`);
  console.log(rule(132));
  console.log(`     Expectation: -${(FEE * 100).toFixed(2)}% of the budget per round (the rake) and nothing else, at every k and every layout.`);
  console.log(`     Any cell significantly above zero here would be a result about \`damage: "min"\`, not about the blend,`);
  console.log(`     and would void the interpretation of every P* in A.3.`);
  {
    const hh = `      seats  budget    best P=0 cell   gross $/rd  +-95%      as % of budget   vs -rake     significant?`;
    console.log(`\n${hh}`); console.log(rule(hh.length));
    let sig = 0, tested = 0;
    for (let si = 0; si < SEATS_GRID.length; si++) for (let bi = 0; bi < BUDGETS.length; bi++) {
      const cells = legalCells(g, si, bi, 0);
      if (!cells.length) continue;
      // split-sample so "the most positive of ~16 cells" is not quoted from the data that chose it
      const b = bestBy(cells, 0, 0, half, half, ROUNDS);
      tested++;
      const positive = b.net - ci95(b.se) > 0;
      if (positive) sig++;
      console.log(`      ${String(SEATS_GRID[si]).padStart(5)}  ${$(BUDGETS[bi], 2).padStart(6)}    ${(`k=${b.c!.k}${b.c!.stacked ? "s" : "a"}`).padStart(13)}   ${$(b.net, 4).padStart(10)}  ${$(ci95(b.se), 4).padStart(8)}   ` +
        `${(100 * b.net / BUDGETS[bi]).toFixed(3).padStart(14)}%   ${$(b.net + FEE * BUDGETS[bi], 4).padStart(9)}     ${positive ? "*** POSITIVE ***" : "no"}`);
    }
    console.log(rule(hh.length));
    console.log(`      ${sig} of ${tested} (seats, budget) rows have a P = 0 cell significantly above zero at 95%, and each row is`);
    console.log(`      itself the max over ~${2 * K_GRID.length} cells, so at a 5% false-positive rate a handful is expected by chance.`);
    console.log(`      "vs -rake" is the gap to the exact expectation: the shipped fight is a martingale in hp+banked, so a`);
    console.log(`      splitter's P = 0 P&L must be -rake x budget. Cells far from it at fine splits are the ones to distrust.`);
  }

  // ---- A.1 the k / layout surface at the realistic cell -----------------------------------------
  console.log(`\n${rule(132)}`);
  console.log(`A.1  THE (k, layout) SURFACE at ${REAL_SEATS} seats, budget ${$(REAL_BUDGET, 0)}, g = ${$(REAL_GAS, 5)} (one signature). $/round, net of gas.`);
  console.log(`     Paired: every cell in this table faced the same background and the same hash table as every other.`);
  console.log(rule(132));
  const siR = SEATS_GRID.indexOf(REAL_SEATS), biR = BUDGETS.indexOf(REAL_BUDGET);
  {
    const e = g[siR];
    const hh = `      k   per wallet  layout  ` + P_GRID.map(P => `P=${P}`.padStart(13)).join("");
    console.log(hh); console.log(rule(hh.length));
    for (let ki = 0; ki < e.ks.length; ki++) for (let li = 0; li < 2; li++) {
      const row = e.cells[ki][li][biR];
      const c0 = row[0];
      console.log(`  ${String(e.ks[ki]).padStart(5)}   ${$(REAL_BUDGET / e.ks[ki], 4).padStart(10)}${c0.legal ? " " : "!"} ${(li === 0 ? "stack" : "alt").padStart(6)}  ` +
        row.map(c => $(netOf(c, REAL_GAS), 4).padStart(13)).join(""));
    }
    console.log(rule(hh.length));
    console.log(`      "!" marks a per-wallet stake outside [${$(MIN_ENTRY, 2)}, ${$(STAKE_CAP_USD, 0)}] — a cell no player may enter. Never used in an argmax.`);
    console.log(`      At k = 1 the two layouts are the SAME lineup and must agree exactly; they do, which is a free control.`);
  }

  // ---- A.2 the argmax, honestly ------------------------------------------------------------------
  console.log(`\n${rule(132)}`);
  console.log(`A.2  THE ARGMAX AND ITS WINNER'S CURSE. Three columns, and the middle one is the one to believe.`);
  console.log(rule(132));
  console.log(`     IN-SAMPLE     k chosen on all ${ROUNDS} rounds and scored on the same rounds. An argmax over ~16 noisy cells`);
  console.log(`                   is biased UPWARD; this column is the attacker's most flattering self-report.`);
  console.log(`     SPLIT-SAMPLE  k chosen on rounds [0,${half}) and scored on rounds [${half},${ROUNDS}). Unbiased by construction. THE NUMBER.`);
  console.log(`     PRE-REG       k fixed by rule before any cell was seen: largest grid k with k <= 5n/6 and k <= n-1.`);
  {
    const hh = `      seats  budget      g    P    in-sample k*  $/rd     split k*  $/rd  +-95%      pre-reg k  $/rd     curse (in - split)`;
    console.log(`\n${hh}`); console.log(rule(hh.length));
    for (const si of [SEATS_GRID.indexOf(48)]) for (const bi of [BUDGETS.indexOf(0.40), BUDGETS.indexOf(80)]) {
      for (const gg of [SIG_USD]) for (let pi = 0; pi < P_GRID.length; pi++) {
        const cells = legalCells(g, si, bi, pi);
        if (!cells.length) continue;
        const ins = bestBy(cells, gg, 0, ROUNDS);
        const spl = bestBy(cells, gg, 0, half, half, ROUNDS);
        const pk = preRegK(SEATS_GRID[si]);
        const preCells = cells.filter(c => c.k === pk);
        const pre = preCells.length ? bestBy(preCells, gg, 0, ROUNDS) : { c: null, net: NaN, se: NaN };
        console.log(`      ${String(SEATS_GRID[si]).padStart(5)}  ${$(BUDGETS[bi], 2).padStart(6)}  ${$(gg, 5).padStart(7)}  ${String(P_GRID[pi]).padStart(3)}  ` +
          `${(ins.c ? `${ins.c.k}${ins.c.stacked ? "s" : "a"}` : "-").padStart(12)}  ${$(ins.net, 4).padStart(8)}  ` +
          `${(spl.c ? `${spl.c.k}${spl.c.stacked ? "s" : "a"}` : "-").padStart(8)}  ${$(spl.net, 4).padStart(8)} +-${$(ci95(spl.se), 4).padStart(7)}  ` +
          `${String(pk).padStart(9)}  ${$(pre.net, 4).padStart(8)}  ${$(ins.net - spl.net, 4).padStart(18)}`);
      }
      console.log(rule(hh.length));
    }
    console.log(`      "40s" = 40 wallets stacked, "40a" = alternating. STACKING IS NOT UNIFORMLY BETTER and which one wins`);
    console.log(`      moves with the budget — the max over layouts is what every P* below uses.`);
  }

  // ---- A.3 P* over the cross-product -------------------------------------------------------------
  console.log(`\n${rule(132)}`);
  console.log(`A.3  P*(seats, budget, g) — the largest GRID P whose best legal cell is still at or below zero.`);
  console.log(`     "<1" means even P = 1 bps, THE SMALLEST REPRESENTABLE SETTING, is already profitable to farm:`);
  console.log(`     there is no shippable tilt at all in that cell. ">100" means no grid P was profitable.`);
  console.log(`     Cells use the SPLIT-SAMPLE argmax, so no P* here is inflated by the winner's curse.`);
  console.log(rule(132));
  printPStarTable(g, half);

  // ---- A.4 monotonicity + slope linearity --------------------------------------------------------
  console.log(`\n${rule(132)}`);
  console.log(`A.4  IS THE BONUS LINEAR IN P AT SMALL P? This licenses (or refuses) any extrapolation below P = 1.`);
  console.log(rule(132));
  console.log(`     bonus(P) = paired mean of (x at P) - (x at P=0), on the SAME rounds, at the best cell. If the blend`);
  console.log(`     were exactly linear, bonus(P)/P would be flat. It is not exactly linear because a tiny damage change`);
  console.log(`     can flip a death and re-route the rest of the fight, so the ratio is reported and read, not assumed.`);
  {
    const hh = `      seats  budget      cell   ` + P_SLOPE.concat([10n, 20n, 40n, 100n]).map(P => `bonus/P @${P}`.padStart(15)).join("");
    console.log(`\n${hh}`); console.log(rule(hh.length));
    for (const si of [SEATS_GRID.indexOf(48)]) for (let bi = 0; bi < BUDGETS.length; bi++) {
      const cells = legalCells(g, si, bi, P_GRID.indexOf(1n));
      if (!cells.length) continue;
      const ref = bestBy(cells, SIG_USD, 0, half, half, ROUNDS).c!;
      const e = g[si]; const ki = e.ks.indexOf(ref.k), li = ref.stacked ? 0 : 1;
      const zero = e.cells[ki][li][bi][0];
      const cols = P_SLOPE.concat([10n, 20n, 40n, 100n]).map(P => {
        const pi = P_GRID.indexOf(P);
        const pr = paired(e.cells[ki][li][bi][pi].x, zero.x);
        return `${(pr.d / Number(P)).toFixed(5)}`.padStart(15);
      });
      console.log(`      ${String(SEATS_GRID[si]).padStart(5)}  ${$(BUDGETS[bi], 2).padStart(6)}  ${(`${ref.k}${ref.stacked ? "s" : "a"}`).padStart(6)}   ` + cols.join(""));
    }
    console.log(rule(hh.length));
    console.log(`      Flat across P = 1..5 licenses the sub-1-bps extrapolation in A.5. Rising with P means the`);
    console.log(`      extrapolation UNDERSTATES the farm below 1 bps, which is the safe direction for this question.`);
  }

  // ---- A.5 the continuous P*, below the representable floor ---------------------------------------
  console.log(`\n${rule(132)}`);
  console.log(`A.5  WHERE P* ACTUALLY SITS ON A CONTINUOUS DIAL  ***EXTRAPOLATED — THESE SETTINGS ARE NOT REPRESENTABLE***`);
  console.log(rule(132));
  console.log(`     P is a u16 in bps, so anything below 1 cannot be configured. This table exists to say HOW FAR below`);
  console.log(`     the floor P* sits, i.e. by what factor the dial's own granularity overshoots. Method, per legal cell:`);
  console.log(`        base = paired mean P&L at P = 0;  beta = least-squares slope of bonus(P) through the origin over`);
  console.log(`        P in {${P_SLOPE.join(",")}};  break-even P_cell = (k*g - base) / beta.  P* = min over cells (the attacker`);
  console.log(`        picks the cell that turns positive FIRST). Slope fitted on the first half, evaluated on the second.`);
  printContinuousPStar(g, half);
  conservationReport("A");
}

/** A cell that is ALREADY profitable at P = 0, before the tilt does anything. That is a claim about
 *  the SHIPPED rule and not about the tilt, so it is never folded into a P* — it is reported on its
 *  own in A.0 with a confidence interval, where it is almost always sampling noise. */
const ALREADY_FARMS = -1;

/** The break-even P for one cell on a continuous dial, using a small-P slope fitted through the
 *  origin. Returns NaN where the cell has no positive slope (nothing for the tilt to farm) and
 *  ALREADY_FARMS where the cell is positive before the tilt is applied at all. */
function breakEvenP(e: AtkGrid[number], ki: number, li: number, bi: number, gg: number, lo: number, hi: number): number {
  const zero = e.cells[ki][li][bi][0];
  const base = meanRange(zero.x, lo, hi);
  const kg = zero.k * gg;
  if (base - kg > 0) return ALREADY_FARMS;
  let num = 0, den = 0;
  for (const P of P_SLOPE) {
    const pi = P_GRID.indexOf(P);
    const c = e.cells[ki][li][bi][pi];
    let b = 0;
    for (let r = lo; r < hi; r++) b += c.x[r] - zero.x[r];
    b /= (hi - lo);
    num += Number(P) * b; den += Number(P) * Number(P);
  }
  const beta = num / den;
  if (!(beta > 0)) return NaN;
  return (kg - base) / beta;
}
/** The smallest break-even P over every legal cell at (seats, budget, g) — the attacker picks the
 *  cell that turns positive FIRST. Also returns how many cells were already profitable at P = 0. */
function bindingP(e: AtkGrid[number], bi: number, gg: number, lo: number, hi: number): { p: number; k: number; li: number; already: number } {
  let best = Infinity, bk = 0, bl = 0, already = 0;
  for (let ki = 0; ki < e.ks.length; ki++) for (let li = 0; li < 2; li++) {
    if (!e.cells[ki][li][bi][0].legal) continue;
    const p = breakEvenP(e, ki, li, bi, gg, lo, hi);
    if (p === ALREADY_FARMS) { already++; continue; }
    if (!Number.isNaN(p) && p < best) { best = p; bk = e.ks[ki]; bl = li; }
  }
  return { p: best, k: bk, li: bl, already };
}
const bpS = (p: number) => !Number.isFinite(p) ? "no farm" : p < 0.001 ? p.toExponential(1) : p.toFixed(3);

function printContinuousPStar(g: AtkGrid, half: number): void {
  const hh = `      seats  budget    ` + GAS_GRID.map(x => `g=${$(x, 5)}`.padStart(16)).join("");
  console.log(`\n${hh}`); console.log(rule(hh.length));
  for (let si = 0; si < SEATS_GRID.length; si++) {
    const e = g[si];
    for (let bi = 0; bi < BUDGETS.length; bi++) {
      // fitted on the first half so the min-over-cells is not chosen on the data it is quoted from
      const cols = GAS_GRID.map(gg => {
        const b = bindingP(e, bi, gg, 0, half);
        return `${bpS(b.p)}${Number.isFinite(b.p) ? ` (k${b.k})` : ""}`.padStart(16);
      });
      console.log(`      ${String(SEATS_GRID[si]).padStart(5)}  ${$(BUDGETS[bi], 2).padStart(6)}    ` + cols.join(""));
    }
  }
  console.log(rule(hh.length));
  console.log(`      Every number in this table is in BASIS POINTS and every one below 1.000 IS UNREPRESENTABLE. Divide 1`);
  console.log(`      by the cell to read "the smallest setting the dial can express is N times too strong to be safe".`);
  console.log(`      "no farm" means no legal cell in that row has a positive small-P slope at all — the tilt buys the`);
  console.log(`      attacker nothing there and no gas price is needed to stop them.`);
}

/** P* by two decision rules, because the choice between them is a judgement and not a measurement:
 *    POINT      the largest P whose best cell's POINT ESTIMATE is still <= 0
 *    SIGNIFICANT the largest P whose best cell is not yet 95%-significantly above zero
 *  The second is the operator-friendly reading ("unprofitable" = "not demonstrably profitable") and
 *  is always >= the first. Printing one without the other would be picking a side silently. */
function pStarAt(g: AtkGrid, si: number, bi: number, gg: number, half: number, requireSig: boolean): string {
  let anyLegal = false;
  for (let pi = 0; pi < P_GRID.length; pi++) {
    const cells = legalCells(g, si, bi, pi);
    if (!cells.length) continue;
    anyLegal = true;
    const b = bestBy(cells, gg, 0, half, half, ROUNDS);
    const positive = requireSig ? b.net - ci95(b.se) > 0 : b.net > 0;
    if (positive) return pi === 0 ? "P0!" : pi === 1 ? "<1" : String(P_GRID[pi - 1]);
  }
  return anyLegal ? ">100" : "none";
}

function printPStarTable(g: AtkGrid, half: number): void {
  const hh = `      seats  budget    ` + GAS_GRID.map(x => `g=${$(x, 5)}`.padStart(14)).join("");
  console.log(`\n  Each cell reads  POINT | SIGNIFICANT.  "P0!" means the P = 0 control itself came out positive, which is`);
  console.log(`  a statement about sampling noise in that cell (see A.0) rather than about the tilt.`);
  console.log(`\n${hh}`); console.log(rule(hh.length));
  for (let si = 0; si < SEATS_GRID.length; si++) {
    for (let bi = 0; bi < BUDGETS.length; bi++) {
      const cols = GAS_GRID.map(gg => `${pStarAt(g, si, bi, gg, half, false)} | ${pStarAt(g, si, bi, gg, half, true)}`.padStart(14));
      console.log(`      ${String(SEATS_GRID[si]).padStart(5)}  ${$(BUDGETS[bi], 2).padStart(6)}    ` + cols.join(""));
    }
  }
  console.log(rule(hh.length));
  console.log(`      "<1" is the finding that forecloses the question in that cell: even 1 bps, the smallest setting the`);
  console.log(`      dial can express, is already profitable to farm there.`);
}

// ================================================================================================
// THE HONEST SWEEP — shared by PARTS B, D, E and F
// ================================================================================================

interface HonestGrid { seatsN: number; stakes: number[]; out: Float64Array[][] }   // [stake][P]

function honestSweep(seatsGrid: number[], stakes: number[], family: string): HonestGrid[] {
  const res: HonestGrid[] = [];
  for (const n of seatsGrid) {
    const cells: CellSpec[] = [];
    for (const s of stakes) for (const P of P_GRID) cells.push({
      prep: (l: Lobby) => { seats(l)[0].grossUnits = usd(s); },
      cfg: blend(P), where: `${family}/${n}/$${s}/P${P}`,
    });
    const acc = scoreCells(ROUNDS, r => subjectLobby(family, r, n), cells, i => i === 0);
    const out: Float64Array[][] = [];
    let c = 0;
    for (let si = 0; si < stakes.length; si++) { const row: Float64Array[] = []; for (let pi = 0; pi < P_GRID.length; pi++) row.push(acc[c++]); out.push(row); }
    res.push({ seatsN: n, stakes, out });
  }
  return res;
}

/** The honest player's BONUS at P: the paired gain over the shipped rule, in dollars per round, on
 *  their own single wallet. This is the tilt's gift and nothing else — the rake is in both arms and
 *  cancels out of the difference. */
const honestBonus = (h: HonestGrid, si: number, pi: number) => paired(h.out[si][pi], h.out[si][0]);

// ================================================================================================
// PART B — THE HONEST PLAYER AT THE SAME P
// ================================================================================================

function partB(H: HonestGrid[]): void {
  console.log(`\n${bar(132)}`);
  console.log(`PART B — ONE HONEST WALLET, NO SPLIT, AGAINST A BANDS FIELD, PAIRED AGAINST P = 0 ON THE SAME LOBBIES`);
  console.log(bar(132));
  console.log(`  THE BONUS is the PAIRED difference (P vs P=0) on identical rounds, so the ${FEE_BPS} bps rake is in both arms and`);
  console.log(`  cancels. It is what the tilt gives this player and nothing else. Two further columns matter:`);
  console.log(`    NET OF OWN GAS   bonus - g. A ${$(0.5, 2)} wallet paying one ${$(SIG_USD, 5)} signature spends ${(100 * SIG_USD / 0.5).toFixed(3)}% of its stake to enter,`);
  console.log(`                     which at small P exceeds the bonus outright.`);
  console.log(`    TAKE-HOME        bonus - rake - gas. What the player's balance actually does. The tilt is a DISCOUNT ON`);
  console.log(`                     THE RAKE before it is a profit, and the two are not the same claim.`);

  for (const h of H) {
    console.log(`\n${rule(132)}`);
    console.log(`  ${h.seatsN} SEATS — subject + ${h.seatsN - 1} from BANDS (mean ~$42). n = ${ROUNDS.toLocaleString()} rounds/cell, +- is a 95% CI on the PAIRED difference.`);
    console.log(rule(132));
    const hh = `      stake  ` + P_GRID.slice(1).map(P => `P=${P}`.padStart(17)).join("");
    console.log(`\n  BONUS, %/round of the player's own stake (paired vs P = 0)`);
    console.log(hh); console.log(rule(hh.length));
    for (let si = 0; si < h.stakes.length; si++) {
      const s = h.stakes[si];
      console.log(`      ${$(s, 2).padStart(5)}  ` + P_GRID.slice(1).map((_P, i) => {
        const p = honestBonus(h, si, i + 1);
        const cell = `${((p.d / s) * 100 >= 0 ? "+" : "")}${((p.d / s) * 100).toFixed(3)}+-${((ci95(p.se) / s) * 100).toFixed(3)}`;
        return (resolvable(p) ? cell : `[<${((ci95(p.se) / s) * 100).toFixed(3)}]`).padStart(17);
      }).join(""));
    }
    console.log(rule(hh.length));
    console.log(`      [<x] means the paired estimate is NOT distinguishable from zero at 95%; x is this rig's resolution`);
    console.log(`      limit for that cell in percentage points per round. It is a bound, not a point estimate.`);

    console.log(`\n  BONUS in money, $/round, and NET OF THE PLAYER'S OWN ONE SIGNATURE (${$(SIG_USD, 5)})`);
    console.log(hh); console.log(rule(hh.length));
    for (let si = 0; si < h.stakes.length; si++) {
      console.log(`      ${$(h.stakes[si], 2).padStart(5)}  ` + P_GRID.slice(1).map((_P, i) => {
        const p = honestBonus(h, si, i + 1);
        return `${$(p.d, 5)} /${$(p.d - SIG_USD, 5)}`.padStart(17);
      }).join(""));
    }
    console.log(rule(hh.length));

    console.log(`\n  TAKE-HOME, %/round = bonus - rake(${(FEE * 100).toFixed(2)}%) - gas. Negative means the tilt has not yet paid for the rake.`);
    console.log(hh); console.log(rule(hh.length));
    for (let si = 0; si < h.stakes.length; si++) {
      const s = h.stakes[si];
      console.log(`      ${$(s, 2).padStart(5)}  ` + P_GRID.slice(1).map((_P, i) => {
        const p = honestBonus(h, si, i + 1);
        const th = (p.d - SIG_USD) / s - FEE;
        return `${(th * 100 >= 0 ? "+" : "")}${(th * 100).toFixed(3)}%`.padStart(17);
      }).join(""));
    }
    console.log(rule(hh.length));
  }
  conservationReport("B");
}

// ================================================================================================
// PART C — THE DETECTABILITY BOUND
// ================================================================================================

function partC(g: AtkGrid): void {
  console.log(`\n${bar(132)}`);
  console.log(`PART C — THE DETECTABILITY BOUND. A farm with positive EV that takes a decade to distinguish from noise`);
  console.log(`         is not a business.`);
  console.log(bar(132));
  console.log(`  Per (P, seats, budget, best k): edge = mean net $/round after gas; sd = its per-round standard deviation;`);
  console.log(`  rounds to 1 sigma = (sd/edge)^2, the point at which cumulative profit exceeds one standard deviation of`);
  console.log(`  its own noise; Sharpe/day = (edge/sd) * sqrt(${ROUNDS_PER_DAY.toFixed(0)}).`);
  console.log(`  P_detect = the largest grid P at which the attacker still needs MORE THAN A YEAR of continuous play`);
  console.log(`  (${Math.round(ROUNDS_PER_YEAR).toLocaleString()} rounds) to be confident the edge is real.`);
  console.log(``);
  console.log(`  A CAVEAT THAT WEAKENS THIS BOUND, AND IT IS MINE TO STATE. This measures how long a P&L SERIES takes to`);
  console.log(`  separate from zero. A disclosed rule is not discovered that way: the attacker reads the rule, computes`);
  console.log(`  the expected bonus from the lobby composition they can see, and needs no P&L evidence at all. Treat`);
  console.log(`  P_detect as a bound on a BLIND attacker, and the gas bound as the one that binds a reading one.`);

  const half = ROUNDS >> 1;
  for (const si of [SEATS_GRID.indexOf(48), SEATS_GRID.indexOf(32)]) {
    for (const bi of [BUDGETS.indexOf(0.40), BUDGETS.indexOf(80), BUDGETS.indexOf(400)]) {
      const hh = `      P     best k   edge $/rd    sd $/rd    edge/sd   rounds to 1sd        days       Sharpe/day   verdict`;
      console.log(`\n  ${SEATS_GRID[si]} seats, budget ${$(BUDGETS[bi], 2)}, g = ${$(SIG_USD, 5)}/wallet/round.`);
      console.log(hh); console.log(rule(hh.length));
      // P_detect = the largest P at which the attacker STILL cannot confirm the edge inside a year.
      // Detectability is monotone in P (the edge grows, the noise does not), so the first detectable
      // P ends the scan; anything after it would be a sampling artefact rather than a reversal.
      let pDetect = ">100", pStarHere = ">100", firstDetect = false, firstProfit = false;
      for (let pi = 0; pi < P_GRID.length; pi++) {
        const cells = legalCells(g, si, bi, pi);
        if (!cells.length) { console.log(`      ${String(P_GRID[pi]).padStart(3)}   no legal split at this budget and seat count`); continue; }
        const b = bestBy(cells, SIG_USD, 0, half, half, ROUNDS);
        const slice = b.c!.x.subarray(half, ROUNDS);
        const s = sd(slice);
        const edge = b.net;
        const n1 = edge !== 0 ? (s / edge) * (s / edge) : Infinity;
        const sharpe = s > 0 ? (edge / s) * Math.sqrt(ROUNDS_PER_DAY) : 0;
        const detectable = edge > 0 && n1 <= ROUNDS_PER_YEAR;
        if (!firstProfit && edge > 0) { firstProfit = true; pStarHere = pi === 0 ? "P=0 FARMS" : pi === 1 ? "<1" : String(P_GRID[pi - 1]); }
        if (!firstDetect && detectable) { firstDetect = true; pDetect = pi === 0 ? "P=0" : pi === 1 ? "<1" : String(P_GRID[pi - 1]); }
        console.log(`      ${String(P_GRID[pi]).padStart(3)}   ${(`${b.c!.k}${b.c!.stacked ? "s" : "a"}`).padStart(6)}   ${$(edge, 4).padStart(9)}  ${$(s, 4).padStart(9)}  ${(s > 0 ? (edge / s).toFixed(5) : "n/a").padStart(9)}  ` +
          `${(Number.isFinite(n1) ? Math.round(n1).toLocaleString() : "inf").padStart(15)}  ${(Number.isFinite(n1) ? (n1 / ROUNDS_PER_DAY).toFixed(1) : "inf").padStart(10)}  ${sharpe.toFixed(3).padStart(15)}   ` +
          `${edge <= 0 ? "loses money" : detectable ? "DETECTABLE within a year" : "below the noise for >1yr"}`);
      }
      console.log(rule(hh.length));
      const asNum = (s: string) => s === "P=0 FARMS" || s === "P=0" ? 0 : s === "<1" ? 0.5 : s === ">100" ? 200 : Number(s);
      console.log(`      P*       (gas)        largest P whose best cell is still <= 0 after gas : ${pStarHere}`);
      console.log(`      P_detect (statistics) largest P still needing > 1 year to confirm      : ${pDetect}`);
      console.log(`      TIGHTER CEILING: ${asNum(pStarHere) < asNum(pDetect) ? "P* (gas) — the farm turns PROFITABLE at a lower P than it becomes CONFIRMABLE."
        : asNum(pDetect) < asNum(pStarHere) ? "P_detect (statistics) — the attacker could confirm an edge before it paid for itself, which is unusual and worth reading twice."
        : "they coincide in this cell."}`);
    }
  }
  conservationReport("C");
}

// ================================================================================================
// PART D — THE SQUEEZE
// ================================================================================================

function partD(g: AtkGrid, H: HonestGrid[]): void {
  console.log(`\n${bar(132)}`);
  console.log(`PART D — THE SQUEEZE. ONE TABLE. THREE COLUMNS THAT MUST BE READ TOGETHER.`);
  console.log(bar(132));
  console.log(`  1. what the tilt gives an honest ${$(5, 0)} player — paired, ${REAL_SEATS} seats, with its own 95% CI`);
  console.log(`  2. what it gives an attacker at the realistic cell — ${REAL_SEATS} seats, ${$(REAL_BUDGET, 0)}, g = ${$(REAL_GAS, 5)}, split-sample best k`);
  console.log(`  3. what it gives the OPERATOR — the already-measured lifetime cohort cells, quoted not re-run`);
  console.log(`     (small-stake-lifetime.ts, 8 replicate populations x 3,000 lives, Kaplan-Meier, HOUSE-SMALL-STAKE.md §4.1)`);

  const half = ROUNDS >> 1;
  const h48 = H.find(x => x.seatsN === REAL_SEATS)!;
  const si5 = h48.stakes.indexOf(5);
  const siR = SEATS_GRID.indexOf(REAL_SEATS), biR = BUDGETS.indexOf(REAL_BUDGET);

  const hh = `      P (bps)   honest $5 edge %/rd (paired)      attacker net $/rd    $/day       best k    d lifetime rake/player`;
  console.log(`\n${hh}`); console.log(rule(hh.length));
  for (let pi = 1; pi < P_GRID.length; pi++) {
    const P = P_GRID[pi];
    const p = honestBonus(h48, si5, pi);
    const hCell = resolvable(p)
      ? `${((p.d / 5) * 100 >= 0 ? "+" : "")}${((p.d / 5) * 100).toFixed(3)}+-${((ci95(p.se) / 5) * 100).toFixed(3)}`
      : `[< ${((ci95(p.se) / 5) * 100).toFixed(3)} — unresolved]`;
    const b = bestBy(legalCells(g, siR, biR, pi), REAL_GAS, 0, half, half, ROUNDS);
    const lt = LIFETIME_DELTA.find(x => x.P === P);
    const ltCell = lt
      ? `${lt.delta >= 0 ? "+" : "-"}${$(Math.abs(lt.delta), 2)} +-${lt.se.toFixed(2)} (${lt.sigma.toFixed(1)}s)${lt.sigma < 2 ? " n.s." : ""}`
      : `NOT MEASURED`;
    console.log(`      ${String(P).padStart(7)}   ${hCell.padStart(30)}      ${$(b.net, 4).padStart(17)}  ${$(b.net * ROUNDS_PER_DAY, 2).padStart(10)}   ${(b.c ? `${b.c.k}${b.c.stacked ? "s" : "a"}` : "-").padStart(7)}    ${ltCell.padStart(23)}`);
  }
  console.log(rule(hh.length));
  console.log(`\n  ON COLUMN 3. The lifetime cells at P = 1, 2 and 3 DO NOT EXIST — small-stake-lifetime.ts's P grid starts at`);
  console.log(`  5 and adding a cell costs 8 replicate populations of 3,000 lives. What the measured cells already say is`);
  console.log(`  decisive enough without them:`);
  console.log(`      blend-5   -${$(0.08, 2)} +-0.42  (0.4 sigma)  NOT SIGNIFICANT`);
  console.log(`      blend-10  +${$(0.34, 2)} +-0.45  (1.5 sigma)  NOT SIGNIFICANT`);
  console.log(`      blend-20  +${$(1.14, 2)} +-0.51  (4.4 sigma)  the first significant cell`);
  console.log(`  P <= 10 HAS NO MEASURED LIFETIME EFFECT AT ALL, and the trend below 5 is monotone toward zero, so the`);
  console.log(`  cells at P = 1-3 could only be smaller than a value already indistinguishable from zero. THE LIFETIME-`);
  console.log(`  REVENUE CASE ALREADY REQUIRES P >= 20, independently of anything this file measures.`);
  console.log(`  (And even at P = 20 that gain is per ACQUIRED PLAYER; §4.1 measures rake per unit TIME as FALLING at`);
  console.log(`  every setting below P = 100, because lives lengthen faster than per-player value rises.)`);
  conservationReport("D");
}

// ================================================================================================
// PART E — SENSITIVITY, AND THE ONE NUMBER THE OWNER NEEDS
// ================================================================================================

function partE(g: AtkGrid, H: HonestGrid[]): void {
  console.log(`\n${bar(132)}`);
  console.log(`PART E — SENSITIVITY: P* AS A RANGE, WHICH ASSUMPTION IT IS MOST FRAGILE TO, AND THE INVERSION`);
  console.log(bar(132));

  const half = ROUNDS >> 1;

  // ---- E.1 the range and the fragility ranking ---------------------------------------------------
  console.log(`\nE.1  THE RANGE. Continuous break-even P over the full cross-product (EXTRAPOLATED below 1 bps).`);
  console.log(`     Ranked by how much each axis moves P*, holding the others at the realistic cell.`);
  const cont = (si: number, bi: number, gg: number) => bindingP(g[si], bi, gg, 0, half).p;
  const siR = SEATS_GRID.indexOf(REAL_SEATS), biR = BUDGETS.indexOf(REAL_BUDGET);
  const baseP = cont(siR, biR, REAL_GAS);
  const axes: { name: string; vals: string[]; ps: number[] }[] = [
    { name: "per-wallet gas g", vals: GAS_GRID.map(x => $(x, 5)), ps: GAS_GRID.map(x => cont(siR, biR, x)) },
    { name: "seats on the board", vals: SEATS_GRID.map(String), ps: SEATS_GRID.map((_s, si) => cont(si, biR, REAL_GAS)) },
    { name: "attacker budget", vals: BUDGETS.map(x => $(x, 2)), ps: BUDGETS.map((_b, bi) => cont(siR, bi, REAL_GAS)) },
  ];
  const hE = `      axis                    values -> break-even P (bps)                                                                  spread`;
  console.log(`\n${hE}`); console.log(rule(hE.length));
  const ranked = axes.map(a => {
    const fin = a.ps.filter(p => Number.isFinite(p) && p > 0);
    // The spread is a RATIO over the finite cells only; a cell where nothing farms is not "P* = inf",
    // it is an axis value that removes the farm entirely, and that is reported in words rather than
    // silently made the numerator of a ratio.
    const spread = fin.length > 1 ? Math.max(...fin) / Math.min(...fin) : NaN;
    const kills = a.ps.filter(p => !Number.isFinite(p)).length;
    return { ...a, spread, kills };
  }).sort((x, y) => (Number.isNaN(y.spread) ? -1 : y.spread) - (Number.isNaN(x.spread) ? -1 : x.spread));
  for (const a of ranked) {
    const body = a.vals.map((v, i) => `${v}:${bpS(a.ps[i])}`).join("  ");
    console.log(`      ${a.name.padEnd(22)}  ${body.padEnd(88)}  ${(Number.isNaN(a.spread) ? "n/a" : `${a.spread.toFixed(1)}x`).padStart(10)}`);
  }
  console.log(rule(hE.length));
  console.log(`      Realistic cell (${REAL_SEATS} seats, ${$(REAL_BUDGET, 0)}, g=${$(REAL_GAS, 5)}): break-even P = ${bpS(baseP)} bps.`);
  console.log(`      MOST FRAGILE TO: ${ranked[0].name}${Number.isNaN(ranked[0].spread) ? "" : ` — it moves the break-even P by ${ranked[0].spread.toFixed(1)}x across the swept range`}.`);
  for (const a of ranked) if (a.kills > 0) console.log(`      ${a.name}: ${a.kills} of ${a.vals.length} values remove the farm entirely ("no farm"), which is a stronger statement than a large P*.`);

  // ---- E.2 the inversion -------------------------------------------------------------------------
  console.log(`\n${rule(132)}`);
  console.log(`E.2  THE INVERSION — the single number that says what would have to change about the world.`);
  console.log(rule(132));
  console.log(`     Step 1: find P_matters = the smallest P at which an honest ${$(5, 0)} wallet's edge, net of its own gas,`);
  console.log(`             reaches +${(MATTERS_PCT * 100).toFixed(0)}%/round at ${REAL_SEATS} seats. (Also reported at 8 seats, where the tilt is far stronger.)`);
  console.log(`     Step 2: at that P, find the per-wallet entry cost g* that makes EVERY legal (k, layout, budget) cell`);
  console.log(`             non-positive:  g* = max over cells of  (cell's gross farm $/round) / k.`);
  console.log(`     That g* is what an entry would have to cost for a tilt worth having to be unfarmable.`);

  for (const nSeats of [REAL_SEATS, 8]) {
    const h = H.find(x => x.seatsN === nSeats);
    if (!h) continue;
    const si5 = h.stakes.indexOf(5);
    if (si5 < 0) continue;
    // P_matters by linear interpolation between grid points on the net-of-gas edge
    let pm = NaN, interp = false;
    const edgeAt = (pi: number) => (honestBonus(h, si5, pi).d - SIG_USD) / 5;
    for (let pi = 1; pi < P_GRID.length; pi++) {
      if (edgeAt(pi) >= MATTERS_PCT) {
        const lo = Number(P_GRID[pi - 1]), hi = Number(P_GRID[pi]);
        const e0 = pi === 1 ? -SIG_USD / 5 : edgeAt(pi - 1), e1 = edgeAt(pi);
        pm = e1 === e0 ? hi : lo + (hi - lo) * (MATTERS_PCT - e0) / (e1 - e0);
        interp = pm !== hi;
        break;
      }
    }
    console.log(`\n     ${nSeats} SEATS.  honest $5 net-of-gas edge by P:  ` + P_GRID.slice(1).map((P, i) => `P${P}:${(edgeAt(i + 1) * 100).toFixed(3)}%`).join("  "));
    if (Number.isNaN(pm)) { console.log(`     No grid P reaches +${(MATTERS_PCT * 100).toFixed(0)}%/round for a $5 wallet at ${nSeats} seats. P_matters > 100 bps.`); continue; }
    console.log(`     P_matters = ${pm.toFixed(2)} bps${interp ? "   *** INTERPOLATED between measured grid points ***" : "   (a measured grid point)"}`);

    // g* at the nearest measured grid P at or above P_matters, so the farm side is MEASURED not fitted.
    //
    // THE ESTIMATOR MATTERS HERE MORE THAN ANYWHERE ELSE IN THE FILE, because g* is a MAX over ~900
    // cells and a max over noisy quantities is the winner's curse in its purest form. The naive
    // version — max of (measured gross P&L)/k — is dominated by whichever k = 1 cell happened to run
    // hot, since a single $80 wallet has the largest per-round sd on the grid and divides by 1.
    //
    // So g* is decomposed into a PRECISE part and an EXACT part, and nothing noisy survives:
    //     per-wallet net at P  =  (paired bonus per wallet)  +  (per-wallet P&L at P = 0)  -  g
    //   The first term is a PAIRED difference and its SE is one to two orders below the level's.
    //   The second is bounded above by -fee x s_a in expectation (the shipped fight is a martingale;
    //   A.0 measures no cell significantly above it), so dropping it gives an UPPER BOUND on g*, and
    //   subtracting the exact rake gives the rake-credited figure. Both are reported.
    let pi = P_GRID.findIndex(P => Number(P) >= pm); if (pi < 0) pi = P_GRID.length - 1;
    const Puse = P_GRID[pi];
    const gStarOver = (minK: number) => {
      // Selected on the RAKE-CREDITED value, which is the actual binding constraint, and which is
      // (paired bonus) - (exact rake): one precise term and one arithmetic term, nothing noisy.
      let pick: AtkCell | null = null, bv = -Infinity, bb = 0, bse = 0;
      for (let sj = 0; sj < SEATS_GRID.length; sj++) {
        const e = g[sj];
        for (let ki = 0; ki < e.ks.length; ki++) for (let li = 0; li < 2; li++) for (let bi = 0; bi < BUDGETS.length; bi++) {
          const c = e.cells[ki][li][bi][pi];
          if (!c.legal || c.k < minK) continue;
          const pr = paired(c.x, e.cells[ki][li][bi][0].x);
          const v = pr.d / c.k - FEE * (c.budget / c.k);
          if (v > bv) { bv = v; bb = pr.d / c.k; bse = pr.se / c.k; pick = c; }
        }
      }
      return pick ? { c: pick, bonus: bb, net: bv, se: bse } : null;
    };
    for (const [label, minK] of [["all legal cells", 1], ["genuine splits, k >= 2", 2]] as const) {
      const r = gStarOver(minK);
      if (!r || r.net <= 0) { console.log(`     g* (${label}) at P = ${Puse} bps: no cell has a positive per-wallet net — no entry cost is needed.`); continue; }
      const rakeCredit = FEE * (r.c.budget / r.c.k);
      const net = r.net;
      console.log(`\n     g* over ${label}, at the nearest MEASURED grid point P = ${Puse} bps:`);
      console.log(`         binding cell: ${r.c.seatsN} seats, budget ${$(r.c.budget, 2)}, k = ${r.c.k}${r.c.stacked ? " stacked" : " alternating"}, ${$(r.c.budget / r.c.k, 4)}/wallet`);
      console.log(`         paired bonus per wallet   ${$(r.bonus, 5)} +-${$(ci95(r.se), 5)} /round        <- UPPER BOUND on g*`);
      console.log(`         less the exact rake it pays  -${$(rakeCredit, 5)} /round (${(FEE * 100).toFixed(2)}% of ${$(r.c.budget / r.c.k, 4)})`);
      console.log(`         g* (rake-credited)        ${$(net, 5)} per wallet per round`);
      console.log(`         = ${(net / SIG_USD).toLocaleString(undefined, { maximumFractionDigits: 0 })}x one Solana signature (${$(SIG_USD, 5)})`);
      console.log(`         = ${(100 * net / 5).toFixed(3)}% of a $5 stake per round = ${(net / (FEE * 5)).toFixed(2)}x the entire rake that player pays`);
      console.log(`         = ${(100 * net / 1).toFixed(3)}% of a $1 stake and ${(100 * net / 0.5).toFixed(3)}% of a ${$(0.5, 2)} stake, per round`);
    }
    console.log(`\n     PLAINLY: for a tilt a ${$(5, 0)} player can feel to be unfarmable, ENTERING ONE ROUND WOULD HAVE TO COST more`);
    console.log(`     than the numbers above — a per-round toll far larger than the rake, levied on every wallet including`);
    console.log(`     the small ones the tilt exists to help. The cure is strictly worse than the disease it treats.`);
  }
  conservationReport("E");
}

// ================================================================================================
// PART F — THE CLOSED FORM, AND WHETHER GAS OPENS THE WINDOW OR SHUTS IT
// ================================================================================================

/** Rei's reframing, tested rather than taken on trust, WITH ONE CORRECTION THAT CHANGES THE ANSWER.
 *
 *  THE PROPOSAL. Both parties break even where their per-wallet bonus equals the per-wallet cost, so
 *  P*_h/P*_a = b_a/b_h, gas cancels out of the ratio, and the honest player's net at the attacker's
 *  break-even is (window - 1) x gas at ANY gas price.
 *
 *  THE CORRECTION. The per-wallet cost is not `g`. It is `fee*s + g`, because a wallet also pays the
 *  ${FEE_BPS} bps rake on its own stake every time it enters, and at s = $5 that rake is ${'$'}0.05 against a
 *  ${'$'}0.00075 signature — SIXTY-SEVEN TIMES LARGER. Gas is a rounding error in the attacker's cost
 *  structure and the fee is the whole of it. With c(s) = fee*s + g:
 *      P*(s) = 100 * c(s) / b(s)        honest net at P*_a  =  c(s_a) * b(s_h)/b(s_a)  -  c(s_h)
 *  Gas does NOT cancel, because the attacker's per-wallet stake is not the honest player's, so their
 *  fee terms differ. This part measures b(s) directly and evaluates both forms side by side. */
function partF(g: AtkGrid, H: HonestGrid[], BC: HonestGrid[]): void {
  console.log(`\n${bar(132)}`);
  console.log(`PART F — b(s): THE PER-WALLET BONUS CURVE, AND THE CLOSED FORM FOR THE WINDOW`);
  console.log(bar(132));

  const half = ROUNDS >> 1;
  const bc = BC[0];
  console.log(`  b(s) = one wallet of stake s, alone, in a ${bc.seatsN}-seat BANDS field: its PAIRED bonus in $/round over P = 0.`);
  console.log(`  The whole question is whether the honest player and the attacker sit on the SAME SIDE of this curve's peak.`);

  const showP = [1n, 20n, 100n].filter(P => P_GRID.includes(P));
  const hF = `      stake      ` + showP.map(P => `b(s) @P=${P}`.padStart(20)).join("") + `     b/s @P=100`;
  console.log(`\n${hF}`); console.log(rule(hF.length));
  const bAt = (si: number, P: bigint) => honestBonus(bc, si, P_GRID.indexOf(P));
  for (let si = 0; si < bc.stakes.length; si++) {
    const s = bc.stakes[si];
    console.log(`      ${$(s, 2).padStart(7)}      ` + showP.map(P => {
      const p = bAt(si, P);
      return (resolvable(p) ? `${$(p.d, 5)}+-${$(ci95(p.se), 5)}` : `[<${$(ci95(p.se), 5)}]`).padStart(20);
    }).join("") + `  ${(bAt(si, 100n).d / s * 100).toFixed(2)}%`.padStart(15));
  }
  console.log(rule(hF.length));
  {
    const bs = bc.stakes.map((_s, si) => bAt(si, 100n).d);
    let pk = 0; for (let i = 1; i < bs.length; i++) if (bs[i] > bs[pk]) pk = i;
    console.log(`      PEAK of b(s) at P = 100: ${$(bc.stakes[pk], 2)} per wallet, ${$(bs[pk], 4)}/round. The curve falls on both sides —`);
    console.log(`      below the peak the wallet dies too fast to collect, above it the blend has less disparity to exploit.`);
    console.log(`      b(s)/s (the last column) is what a PERCENTAGE-of-stake reader sees, and it rises monotonically as s`);
    console.log(`      falls: the SPLITTER optimises b(s)/s per dollar of budget, the honest player only ever sees b(s)/s at`);
    console.log(`      their own s. Those are the same curve read with two different objectives.`);

    // THE SHAPE IS THE WHOLE ARGUMENT, so it is quantified rather than described. Over the flat
    // region b(s) is nearly CONSTANT IN DOLLARS across two orders of magnitude of stake. A wallet's
    // bonus therefore barely depends on how much is in it, and a budget B split k ways collects
    // ~k x b instead of ~1 x b. The per-dollar bonus is linear in k and the only bound is the seat
    // cap. This is the mechanism behind every farm number in this file, in one line.
    const flat = bc.stakes.map((s, si) => ({ s, b: bs[si] })).filter(x => x.b > 0.5 * bs[pk]);
    if (flat.length > 1) {
      const lo = flat[0], hi = flat[flat.length - 1];
      console.log(``);
      console.log(`      THE SHAPE, QUANTIFIED. b(s) stays within a factor of 2 of its peak from ${$(lo.s, 2)} to ${$(hi.s, 2)} — a`);
      console.log(`      ${(hi.s / lo.s).toFixed(0)}x span of stake over which the bonus in DOLLARS moves by only ${(hi.b / lo.b).toFixed(2)}x. A wallet's bonus is very`);
      console.log(`      nearly INDEPENDENT OF WHAT IS IN IT. So a budget B split k ways collects about k x b instead of b,`);
      console.log(`      and the per-dollar bonus is LINEAR IN k with no diminishing return until the seat cap stops it.`);
      console.log(`      There is no honest-player-favouring shape here at all: the curve favours WALLET COUNT, and wallet`);
      console.log(`      count is the one thing an anonymous rule cannot see.`);
    }
  }

  // ---- F.2 the window ------------------------------------------------------------------------------
  console.log(`\n${rule(132)}`);
  console.log(`F.2  THE WINDOW  b_h / b_a,  AND THE HONEST NET AT THE ATTACKER'S BREAK-EVEN, BOTH FORMS`);
  console.log(rule(132));
  const siR = SEATS_GRID.indexOf(REAL_SEATS), biR = BUDGETS.indexOf(REAL_BUDGET);
  const h48 = H.find(x => x.seatsN === REAL_SEATS)!;
  const hh = `      P    honest s_h  b_h $/rd    attacker best  s_a      b_a/wallet  window b_h/b_a   naive net (g only)   with the fee`;
  console.log(`\n${hh}`); console.log(rule(hh.length));
  for (const P of [1n, 20n, 100n]) {
    const pi = P_GRID.indexOf(P); if (pi < 0) continue;
    const cells = legalCells(g, siR, biR, pi);
    if (!cells.length) continue;
    const best = bestBy(cells, REAL_GAS, 0, half, half, ROUNDS).c!;
    const e = g[siR]; const ki = e.ks.indexOf(best.k), li = best.stacked ? 0 : 1;
    const zero = e.cells[ki][li][biR][0];
    const bonusTot = paired(best.x.subarray(half, ROUNDS) as Float64Array, zero.x.subarray(half, ROUNDS) as Float64Array);
    const b_a = bonusTot.d / best.k;
    const s_a = best.budget / best.k;
    for (const s_h of [1, 5, 20]) {
      const sih = h48.stakes.indexOf(s_h); if (sih < 0) continue;
      const b_h = honestBonus(h48, sih, pi).d;
      const W = b_h / b_a;
      const naive = SIG_USD * (W - 1);
      const c_a = FEE * s_a + SIG_USD, c_h = FEE * s_h + SIG_USD;
      const withFee = c_a * W - c_h;
      console.log(`      ${String(P).padStart(3)}  ${$(s_h, 2).padStart(10)}  ${$(b_h, 5).padStart(9)}    ${(`${best.k}${best.stacked ? "s" : "a"}`).padStart(6)}  ${$(s_a, 4).padStart(7)}  ${$(b_a, 5).padStart(11)}  ${W.toFixed(3).padStart(14)}   ` +
        `${`${$(naive, 5)} (${(100 * naive / s_h).toFixed(4)}%)`.padStart(18)}   ${`${$(withFee, 5)} (${(100 * withFee / s_h).toFixed(4)}%)`.padStart(19)}`);
    }
  }
  console.log(rule(hh.length));
  console.log(`      "naive net (g only)" is the proposed closed form: (window - 1) x one signature. It is scale-free in gas`);
  console.log(`      and it is what the honest player would take home if entering cost gas and NOTHING ELSE.`);
  console.log(`      "with the fee" replaces the per-wallet cost g by c(s) = ${(FEE * 100).toFixed(2)}% x s + g, which is what a wallet actually`);
  console.log(`      pays. THE TWO DISAGREE BY ORDERS OF MAGNITUDE AND THEY DISAGREE IN SIGN, because the attacker's wallet`);
  console.log(`      is far smaller than the honest player's and therefore pays a far smaller fee: the attacker reaches`);
  console.log(`      break-even at a P where the honest player has not yet recovered their own rake.`);

  // ---- F.3 does gas open the window or shut it? ----------------------------------------------------
  console.log(`\n${rule(132)}`);
  console.log(`F.3  DOES A HIGHER ENTRY COST OPEN THE WINDOW OR SHUT IT? The attacker re-optimises; the honest player`);
  console.log(`     cannot. If the attacker's optimal wallet size s_a rises toward the honest player's s_h as g rises,`);
  console.log(`     then b_a rises toward b_h, the window closes toward 1, and RAISING THE ENTRY COST DESTROYS THE`);
  console.log(`     WINDOW RATHER THAN OPENING IT — which would make the whole idea unrescuable by any fee design.`);
  console.log(rule(132));
  {
    const pi = P_GRID.indexOf(100n);
    const hG = `      g            best cell   s_a       b_a/wallet   window vs $5   attacker net $/rd   honest $5 net at that P*`;
    console.log(`\n  P = 100 bps, ${REAL_SEATS} seats, budget ${$(REAL_BUDGET, 0)}.`);
    console.log(hG); console.log(rule(hG.length));
    const sih = h48.stakes.indexOf(5);
    const b_h = honestBonus(h48, sih, pi).d;
    for (const gg of GAS_GRID) {
      const cells = legalCells(g, siR, biR, pi);
      const best = bestBy(cells, gg, 0, half, half, ROUNDS);
      if (!best.c) continue;
      const e = g[siR]; const ki = e.ks.indexOf(best.c.k), li = best.c.stacked ? 0 : 1;
      const zero = e.cells[ki][li][biR][0];
      const bt = paired(best.c.x.subarray(half, ROUNDS) as Float64Array, zero.x.subarray(half, ROUNDS) as Float64Array);
      const b_a = bt.d / best.c.k;
      const s_a = best.c.budget / best.c.k;
      const W = b_h / b_a;
      const c_a = FEE * s_a + gg, c_h = FEE * 5 + gg;
      const honestNet = c_a * W - c_h;
      console.log(`      ${$(gg, 5).padStart(9)}    ${(`${best.c.k}${best.c.stacked ? "s" : "a"}`).padStart(9)}   ${$(s_a, 4).padStart(7)}   ${$(b_a, 5).padStart(10)}   ${W.toFixed(3).padStart(12)}   ${$(best.net, 4).padStart(17)}   ${`${$(honestNet, 5)} (${(100 * honestNet / 5).toFixed(3)}%)`.padStart(24)}`);
    }
    console.log(rule(hG.length));
    console.log(`      Read s_a down the column. If it RISES with g the attacker is being pushed toward the honest player's`);
    console.log(`      wallet size and the window is closing; if it is FLAT the per-wallet cost is too small to bind at all`);
    console.log(`      and gas is simply not a lever on this mechanic.`);
  }
  conservationReport("F");
}

// ================================================================================================
// THE VERDICT
// ================================================================================================

function verdict(g: AtkGrid, H: HonestGrid[]): void {
  const half = ROUNDS >> 1;
  const siR = SEATS_GRID.indexOf(REAL_SEATS), biR = BUDGETS.indexOf(REAL_BUDGET);
  const h48 = H.find(x => x.seatsN === REAL_SEATS)!;
  const si5 = h48.stakes.indexOf(5);

  // THE BINDING P*: the smallest break-even over EVERY (seats, budget, k, layout) at one signature of
  // gas. The attacker chooses all four, so the number that decides shippability is the MINIMUM over
  // the whole grid — not the value at whichever cell looks realistic to a defender.
  let bindP = Infinity, bindWhere = "", bindBudget = 0;
  for (let sj = 0; sj < SEATS_GRID.length; sj++) for (let bi = 0; bi < BUDGETS.length; bi++) {
    const b = bindingP(g[sj], bi, SIG_USD, 0, half);
    if (Number.isFinite(b.p) && b.p < bindP) {
      bindP = b.p; bindBudget = BUDGETS[bi];
      bindWhere = `${SEATS_GRID[sj]} seats, budget ${$(BUDGETS[bi], 2)}, k=${b.k}${b.li === 0 ? " stacked" : " alternating"} (${$(BUDGETS[bi] / b.k, 4)}/wallet)`;
    }
  }
  const realP = bindingP(g[siR], biR, REAL_GAS, 0, half);
  const p1 = honestBonus(h48, si5, P_GRID.indexOf(1n));
  const netAt1 = bestBy(legalCells(g, siR, biR, P_GRID.indexOf(1n)), REAL_GAS, 0, half, half, ROUNDS);

  console.log(`\n${bar(132)}`);
  console.log(`THE ANSWER, STATED WITHOUT SOFTENING`);
  console.log(bar(132));
  const forecloses = bindP < 1;
  if (forecloses) {
    console.log(`  NO REPRESENTABLE P SURVIVES ITS OWN FARM.`);
    console.log(``);
    console.log(`  The binding break-even sits at P = ${bpS(bindP)} bps (${bindWhere}), against a dial whose smallest`);
    console.log(`  non-zero setting is 1 bps. THE DIAL OVERSHOOTS THE SAFE REGION BY ${(1 / bindP).toFixed(0)}x. The granularity of the`);
    console.log(`  u16-in-basis-points encoding forecloses the question before any product argument is reached.`);
  } else {
    console.log(`  A WINDOW EXISTS AND IT IS REPRESENTABLE. P* = ${bindP.toFixed(3)} bps, binding at ${bindWhere}.`);
    console.log(`  The largest shippable integer setting is P = ${Math.floor(bindP)} bps.`);
  }
  console.log(``);
  console.log(`  P* AT THE REALISTIC CELL (${REAL_SEATS} seats, ${$(REAL_BUDGET, 0)} budget, g = ${$(REAL_GAS, 5)}): ${bpS(realP.p)} bps at k = ${realP.k}.`);
  console.log(`  ${realP.p >= 1 ? `THAT IS REPRESENTABLE, and it is a materially different answer from the binding one above. The gap between`
    : `That is also below the representable floor.`}`);
  console.log(`  ${realP.p >= 1 ? `the two is the whole finding: a serious attacker with a serious budget must first beat the ${FEE_BPS} bps rake on that`
    : `The attacker's budget is the axis that decides it.`}`);
  console.log(`  ${realP.p >= 1 ? `budget, which a DUST attacker at ${$(bindBudget, 2)} barely pays. The mechanic is farmable by pocket change, not by capital.` : ``}`);
  console.log(``);
  console.log(`  AT THE SMALLEST REPRESENTABLE SETTING, P = 1 bps, ${REAL_SEATS} seats:`);
  console.log(`    honest $5 player's bonus   ${resolvable(p1) ? `${((p1.d / 5) * 100).toFixed(4)}% +- ${((ci95(p1.se) / 5) * 100).toFixed(4)}%/round` : `NOT RESOLVED at n=${ROUNDS}; |bonus| < ${((ci95(p1.se) / 5) * 100).toFixed(4)}%/round at 95%`}`);
  console.log(`    take-home after rake+gas   ${(((p1.d - SIG_USD) / 5 - FEE) * 100).toFixed(4)}%/round  ${(p1.d - SIG_USD) / 5 - FEE < 0 ? "— STILL LOSING. The tilt has not paid for the rake." : "— positive."}`);
  console.log(`    attacker net (${$(REAL_BUDGET, 0)}, g=${$(REAL_GAS, 5)})  ${$(netAt1.net, 4)}/round = ${$(netAt1.net * ROUNDS_PER_DAY, 2)}/day at k = ${netAt1.c ? netAt1.c.k : "-"}`);
  console.log(``);
  console.log(`  AND THE MECHANIC PAYS THE OPERATOR NOTHING DIRECTLY AT ANY SETTING. The fight conserves value; the house`);
  console.log(`  takes exactly ${FEE_BPS} bps at P = 0 and at P = 100 alike (asserted in integers on ${CONSERVED.toLocaleString()} fights in this process).`);
  console.log(`  The only measured revenue effect is lifetime, it is not significant below P = 20, and §4.1 measures rake`);
  console.log(`  per unit TIME as falling at every setting below P = 100. This can only ever be a PRODUCT argument.`);
  console.log(bar(132));
}

// ================================================================================================
// DISPATCH
// ================================================================================================

const t0 = Date.now();
header();
const want = (p: string) => PART === "all" || PART === p;
// PART 0 runs in EVERY process, not only when it is asked for. It is cheap, and it is what licenses
// every caption in the part that follows it.
part0();

const needAtk = ["A", "C", "D", "E", "F", "all"].includes(PART);
const needHon = ["B", "D", "E", "F", "all"].includes(PART);
const needCurve = ["F", "all"].includes(PART);

const ATK = needAtk ? attackerSweep() : ([] as AtkGrid);
if (needAtk) console.log(`\n  [attacker sweep complete: ${((Date.now() - t0) / 1000).toFixed(0)}s]`);
const HON = needHon ? honestSweep(SEATS_GRID, HONEST_STAKES, "pb-subject") : ([] as HonestGrid[]);
const CURVE = needCurve ? honestSweep([REAL_SEATS], B_CURVE_STAKES, "pf-subject") : ([] as HonestGrid[]);
if (needHon || needCurve) console.log(`  [honest sweeps complete: ${((Date.now() - t0) / 1000).toFixed(0)}s]`);

if (want("A")) partA(ATK);
if (want("B")) partB(HON);
if (want("C")) partC(ATK);
if (want("D")) partD(ATK, HON);
if (want("E")) partE(ATK, HON);
if (want("F")) partF(ATK, HON, CURVE);
if (needAtk && needHon) verdict(ATK, HON);

console.log(`\n${bar(132)}`);
console.log(`DONE. part ${PART}, ${ROUNDS.toLocaleString()} rounds/cell, ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
console.log(`Conservation asserted in integers on ${CONSERVED.toLocaleString()} fights; zero failures.`);
console.log(bar(132));
