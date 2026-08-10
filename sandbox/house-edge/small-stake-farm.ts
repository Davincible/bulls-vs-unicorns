// SANDBOX — NOT SHIPPED, NOT ON CHAIN, NOT IMPORTED BY THE ENGINE OR THE DEMO.
//
// Run: cd engine && HE_FEE_BPS=100 NODE_OPTIONS=--max-old-space-size=12288 \
//        npx tsx ../sandbox/house-edge/small-stake-farm.ts [rounds] [part]
//   `part` is 0|1|2|3|4|5|6|all so the seven parts can be run as parallel background processes.
//
// THE ONE QUESTION THIS FILE ANSWERS
// ---------------------------------
// For a mechanic that favours small stakes, how does the INTENDED EFFECT — what a genuinely small
// player gains — compare to the FARM RATE — what an adversary who splits a budget optimally
// extracts? Every mechanic here is measured on BOTH sides of that comparison, on the same lobbies,
// with the same hash tables, so the two numbers are paired rather than merely adjacent.
//
// THE CLAIM UNDER TEST (SPEC.md), stated so it can be broken rather than assumed:
//   > For any anonymous rule whose effect on a wallet depends only on that wallet's own stake size,
//   > a player with budget B who splits into k wallets of B/k receives the treatment intended for a
//   > B/k-sized player. The INTENDED EFFECT and the FARM RATE are therefore THE SAME NUMBER. The
//   > only things that can separate them are (a) the 48-seat cap, (b) the $0.01 minimum entry,
//   > (c) a per-wallet cost that scales with k — gas, or an identity.
// Parts 1-5 each try to find a mechanic that separates them. Part 6 asks whether the OPERATOR, who
// pays keeper gas and must seat every round, can farm any of them faster than a private adversary.
//
// WHAT THIS FILE DOES NOT ESTABLISH
//   - It does not model player behaviour. Every "honest" player here is a fixed-stake seat filler.
//     Retention, redeposit and stake choice live in strategy-mechanics.ts / lifetime-core.ts, and a
//     mechanic that looks cheap here can still be expensive once churn responds to it.
//   - It does not price an X account. Part 3 prints a BREAK-EVEN, which is the number a real market
//     price would have to be compared against; it does not claim to know that price.
//   - The farm lobbies confound "more of my wallets" with "fewer of theirs", exactly as
//     study-split.ts:17-21 documents, because that is the trade a player faces in a full lobby.
//   - Fights are truncated by `stopWhenOver` (fight-variant.ts:323-329), which is outcome-identical
//     and therefore affects timing only — except in PART 0, which runs the full bell on purpose.
//
// INTEGERS. Every money path is BigInt micro-units (1e6 = $1). Floats appear only in reporting and
// in the statistics. CONSERVATION IS ASSERTED, NOT ASSUMED: after every fight this file runs, in
// every part, it checks the integer identity
//        sum_i (hp_i + banked_i)  ===  sum_i (net stake_i)
// and `process.exit(1)`s on the first failure. Under the per-entry ring cap of PART 5 the identity
// gains a second line, stated there. The count of checked fights is printed at the end of every part.

import { createHash } from "node:crypto";
import {
  runFight, payout, makeFighter, FEE_BPS, DUST_ABSOLUTE, W_UNIFORM, BASELINE, MAX_FIGHTERS,
} from "./fight-variant.ts";
import type { Fighter, FightConfig, DustRule } from "./fight-variant.ts";
import { BANDS, finish, makeLobby, usd, pct, toUsd, roiWithSE, diffWithSE } from "./lobby.ts";
import type { Entry, Lobby } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { CAP as STAKE_CAP_USD, MIN_ENTRY } from "../../engine/src/arenas.ts";

// ================================================================================================
// PARAMETERS
// ================================================================================================

const ROUNDS = Number(process.argv[2] ?? 800);
const PART = String(process.argv[3] ?? "all");
const STUDY_SEED = "small-stake-farm-v1";

const SEATS_FULL = MAX_FIGHTERS;            // 48 — the deployed seat cap
const ABS: DustRule = { kind: "absolute", units: DUST_ABSOLUTE };

/** Cadence and gas, from SPEC.md's measured baseline (and lifetime-core.ts:62-66). ~110s per round. */
const ROUNDS_PER_HOUR = 3600 / 110;         // 32.727
const ROUNDS_PER_DAY = ROUNDS_PER_HOUR * 24; // 785.45
const SOL_USD = Number(process.env.SOL_USD ?? 150);
const GAS_PRE_USD = 0.00981 * SOL_USD;      // $1.4715 — keeper gas per round BEFORE rent reclaim
const GAS_POST_USD = 0.00041 * SOL_USD;     // $0.0615 — after reclaim

/** Every lobby family this file builds. Printed in the header so a reader can reproduce any table
 *  without reading the source: the fight seed is `sha256("he|<family>|<round>")` (lobby.ts:53) and
 *  the lobby contents come from `mulberry32(sha256("<family>|<round>")[0..4])`. */
const SEED_FAMILIES = [
  "p0-lineup", "p1a-subject", "p1b-farm", "p1d-floor",
  "p2-subject", "p2-band", "p2-farm",
  "p3-subject", "p3-farm", "p3-pool", "p4-neutral",
  "p5-band", "p5-farm", "p5-subject", "p6-farm",
] as const;

// ================================================================================================
// SHARED MACHINERY
// ================================================================================================

const hash32 = (s: string) => createHash("sha256").update(s).digest().readUInt32LE(0);
const $ = (x: number, d = 2) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(d)}`;
const rule = (n: number) => "-".repeat(n);
const bar = (n: number) => "=".repeat(n);
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
};

/** A seat. `Entry` (lobby.ts:19) plus the identity bit the gated damage rule reads. `house` is
 *  reused as "this seat belongs to the subject under study" — the honest player in the intended
 *  effect tables, the adversary's wallets in the farm tables. */
type Seat = Entry & { verified?: 0 | 1 };
const seats = (l: Lobby) => l.entries as Seat[];

// ---- the conservation assertion -----------------------------------------------------------------

let CONSERVED = 0;
let CONSERVED_PART = 0;

/** THE IDENTITY: value in the ring plus value banked equals the net stake that entered, exactly, in
 *  integers. The fight only ever MOVES units between `hp` and `banked` (fight-variant.ts:427-428),
 *  so any drift is a bug in this rig or in the loop, and either one voids every number below. */
function conserve(fighters: Fighter[], expect: bigint, where: string): void {
  let s = 0n;
  for (const f of fighters) s += f.hp + f.banked;
  if (s !== expect) {
    console.error(`\nCONSERVATION FAILED in ${where}: sum(hp+banked) = ${s} but net stake = ${expect} (delta ${s - expect} units)`);
    console.error(`Every table in this run is describing a broken game. Exiting.`);
    process.exit(1);
  }
  CONSERVED++; CONSERVED_PART++;
}

function conservationReport(part: string): void {
  console.log(`\n  CONSERVATION: sum(hp+banked) === sum(net stake), asserted in integers on ${CONSERVED_PART.toLocaleString()} fights in PART ${part} (${CONSERVED.toLocaleString()} this process). No failures.`);
  CONSERVED_PART = 0;
}

// ---- building and playing ------------------------------------------------------------------------

interface PlayOpts {
  feeBps?: bigint;
  /** PART 5's per-entry ring cap, as an exact rational `capNum/capDen` multiple of the round's mean
   *  GROSS entry. Undefined means no cap and no extra arithmetic. */
  capNum?: bigint; capDen?: bigint;
  stopWhenOver?: boolean;
  where?: string;
}

interface PlayResult {
  fighters: Fighter[];
  fees: bigint;
  /** Per-seat value refunded before the bell by the ring cap; all zero when no cap is configured. */
  refunds: bigint[];
  /** Per-seat settlement: `payout(f) + refund`. The only quantity a player ever sees. */
  out: bigint[];
}

/** Build the lineup, apply the ring cap if configured, run the fight to conclusion, assert
 *  conservation, and return per-seat settlements. Every fight in this file goes through here, which
 *  is what makes "conservation is asserted on EVERY fight" a property of the rig rather than a
 *  promise. */
function play(lobby: Lobby, cfg: FightConfig, o: PlayOpts = {}): PlayResult {
  const es = seats(lobby);
  const feeBps = o.feeBps ?? FEE_BPS;
  const fighters: Fighter[] = [];
  let fees = 0n, net = 0n, gross = 0n;
  for (const e of es) {
    const { f, fee } = makeFighter(e.wallet, e.side, e.grossUnits, feeBps, e.verified);
    fighters.push(f); fees += fee; net += f.stake; gross += e.grossUnits;
  }

  const refunds: bigint[] = new Array(fighters.length).fill(0n);
  let ringed = net;
  if (o.capNum !== undefined && o.capDen !== undefined) {
    // THE DISCLOSED RULE: "no fighter's ring may exceed C times the mean GROSS entry of the round;
    // the excess is refunded before the bell." Order-free (it reads the multiset of entries, not
    // their sequence), value-conserving (the excess is handed back untouched), and it never enters
    // the damage loop — the fight that runs afterwards is byte-for-byte the shipped fight on a
    // different, smaller lineup.
    const mu = gross / BigInt(fighters.length);
    const cap = (o.capNum * mu) / o.capDen;
    ringed = 0n;
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      if (f.stake > cap) { refunds[i] = f.stake - cap; f.stake = cap; f.hp = cap; }
      ringed += f.stake;
    }
    // SECOND LINE OF THE IDENTITY, asserted before the bell rather than after it: the cap moves
    // value out of the ring, it does not create or destroy any.
    let refTot = 0n; for (const r of refunds) refTot += r;
    if (ringed + refTot !== net) {
      console.error(`\nRING CAP FAILED in ${o.where ?? "?"}: ringed ${ringed} + refunded ${refTot} !== net ${net}`);
      process.exit(1);
    }
  }

  runFight(fighters, lobby.seed, lobby.steps, cfg, lobby.hashes, o.stopWhenOver ?? true);
  conserve(fighters, ringed, o.where ?? "play");

  const out = fighters.map((f, i) => payout(f) + refunds[i]);
  return { fighters, fees, refunds, out };
}

// ---- lobby families ------------------------------------------------------------------------------

/** THE SUBJECT LOBBY — the intended-effect rig. Seat 0 is the player under study; seats 1..n-1 are
 *  background drawn from `BANDS` (lobby.ts:11-17, mean ~$42).
 *
 *  The background depends on (family, round, seats) and NEVER on the subject's stake, and the fight
 *  seed does not read the entries at all (lobby.ts:53) — so an entire stake sweep can be scored
 *  against literally the same opponents, the same sides and the same lazily-filled hash table by
 *  mutating `entries[0].grossUnits` in place between cells. That is a strictly stronger form of
 *  common random numbers than study-split.ts:41-56 can offer, and it is available only because the
 *  subject occupies one seat whose SIZE does not change the seat COUNT.
 *
 *  `verifiedFrac` is drawn from an independent stream, so the verified set NESTS as v rises: the
 *  wallets verified at v = 0.25 are a subset of those verified at v = 0.5. PART 3 needs that,
 *  because otherwise a change in v would reshuffle who is verified and the decay it measures would
 *  be confounded with resampling. */
function subjectLobby(family: string, round: number, n: number, verifiedFrac = 0): Lobby {
  const rnd = mulberry32(hash32(`${STUDY_SEED}|${family}|${n}|${round}`));
  const vrnd = mulberry32(hash32(`${STUDY_SEED}|${family}|${n}|verify|${round}`));
  const es: Seat[] = [{ wallet: "subject", side: 0, grossUnits: 0n, band: -1, house: true, verified: 0 }];
  for (let i = 0; i < n - 1; i++) {
    const b = Math.floor(rnd() * BANDS.length);
    const band = BANDS[b];
    es.push({
      wallet: `p${i}`, side: ((i + 1) % 2) as 0 | 1,
      grossUnits: usd(band.lo + rnd() * (band.hi - band.lo)),
      band: b, house: false, verified: vrnd() < verifiedFrac ? 1 : 0,
    });
  }
  return finish(`${STUDY_SEED}|${family}|${n}`, round, es);
}

/** THE FARM LOBBY — the farm-rate rig, and a direct copy of study-split.ts:41-56's design: the
 *  lobby is always exactly `n` fighters, the splitter takes k of them and the background takes
 *  n - k. That confounds "more of my wallets" with "fewer of theirs" DELIBERATELY, for the reason
 *  given at study-split.ts:17-21 — it is the actual trade a player faces in a full lobby, and
 *  separating the two would measure a game nobody can play.
 *
 *  ONE THING IS NEW, and it raises the farm rate rather than flattering it. study-split.ts:48 puts
 *  the splitter's wallets on ALTERNATING sides, which makes roughly half of the splitter's exchanges
 *  internal washes between its own wallets: zero-sum for the adversary, and worse than zero-sum
 *  because they burn draws that would otherwise have collected the small-stake bonus off a large
 *  opponent. A real adversary STACKS all k wallets on one side — `enter` tops up rather than
 *  duplicating a wallet already on that side, so k DISTINCT wallets on side 0 is legal. Only the
 *  ADVERSARY'S OWN choice changes: the background keeps the alternating sides it would have had
 *  anyway (study-split.ts:51), because the adversary cannot choose where anybody else sits.
 *
 *  The splitter's stakes are placeholders, set by the caller, so one lobby family serves every
 *  budget in a sweep under common random numbers. */
function farmLobby(family: string, round: number, n: number, k: number, stacked: boolean, verifiedFrac = 0): Lobby {
  // The LAYOUT IS NOT IN THE SEED, on purpose. Stacked and alternating therefore face the identical
  // background, the identical sides for that background, and the identical hash table — the only
  // difference between them is which side the adversary's own wallets sit on, which is the only
  // thing the adversary controls. It also gives a free control: at k = 1 the two layouts are the
  // same lineup and must print the same number to the last cent.
  const rnd = mulberry32(hash32(`${STUDY_SEED}|${family}|${n}|${k}|${round}`));
  const vrnd = mulberry32(hash32(`${STUDY_SEED}|${family}|${n}|${k}|verify|${round}`));
  const es: Seat[] = [];
  for (let i = 0; i < k; i++)
    es.push({ wallet: `s${i}`, side: (stacked ? 0 : i % 2) as 0 | 1, grossUnits: 0n, band: -1, house: true, verified: 0 });
  for (let i = 0; i < n - k; i++) {
    const b = Math.floor(rnd() * BANDS.length);
    const band = BANDS[b];
    es.push({
      wallet: `p${i}`, side: ((i + 1) % 2) as 0 | 1,
      grossUnits: usd(band.lo + rnd() * (band.hi - band.lo)),
      band: b, house: false, verified: vrnd() < verifiedFrac ? 1 : 0,
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

// ---- scoring -------------------------------------------------------------------------------------

interface Cell { per: { inn: number; out: number }[] }

/** Score a list of cells against one lobby family, ONE ROUND AT A TIME.
 *
 *  Round-major rather than cell-major for two reasons. Memory: a 48-seat lobby carries a 17,280-slot
 *  lazy hash table (fight-variant.ts:54), and holding `rounds` of them at once is what forces
 *  `--max-old-space-size` on the older studies; here exactly one is live. Pairing: every cell in the
 *  list sees the same lobby AND the same filled hash slots, so differences between cells are paired
 *  and their standard errors are one to two orders of magnitude below independent sampling.
 *
 *  `prep` mutates the lobby for its cell (stake sizes, identity bits) and must set everything it
 *  cares about, because the previous cell's mutation is still there. */
function scoreCells(
  rounds: number,
  mk: (r: number) => Lobby,
  cells: { prep: (l: Lobby) => void; cfg: FightConfig; opts?: PlayOpts }[],
  take: (l: Lobby, i: number) => boolean,
): Cell[] {
  const acc: Cell[] = cells.map(() => ({ per: [] }));
  for (let r = 0; r < rounds; r++) {
    const lobby = mk(r);
    for (let c = 0; c < cells.length; c++) {
      cells[c].prep(lobby);
      const res = play(lobby, cells[c].cfg, cells[c].opts);
      let inn = 0, out = 0;
      const es = seats(lobby);
      for (let i = 0; i < es.length; i++) if (take(lobby, i)) { inn += toUsd(es[i].grossUnits); out += toUsd(res.out[i]); }
      acc[c].per.push({ inn, out });
    }
  }
  return acc;
}

/** Ratio-of-sums ROI with a NORMAL standard error over rounds — study-split.ts:76-79's estimator.
 *
 *  Used wherever a grid has hundreds of cells, because `roiWithSE`'s 2,000-resample bootstrap
 *  (lobby.ts:82) costs O(2000 x rounds) per cell and would then cost more than the fights it is
 *  describing. Where the stake is constant across rounds — which is every farm cell, since the
 *  budget is fixed — the two estimators agree by construction: `inn` is the same number every round,
 *  so the ratio of sums IS the mean of the ratios. The headline tables use the bootstrap. */
function roiNormal(per: { inn: number; out: number }[]): { roi: number; se: number; n: number } {
  let I = 0, O = 0;
  for (const p of per) { I += p.inn; O += p.out; }
  const rs = per.map(p => (p.inn > 0 ? p.out / p.inn - 1 : 0));
  return { roi: I > 0 ? O / I - 1 : 0, se: sd(rs) / Math.sqrt(per.length), n: per.length };
}

const ci95 = (se: number) => 1.96 * se;
const cellS = (r: { roi: number; se: number }, d = 2) => `${pct(r.roi, d)}+-${(ci95(r.se) * 100).toFixed(d)}`;

// ================================================================================================
// HEADER
// ================================================================================================

function header(): void {
  console.log(`\n${bar(124)}`);
  console.log(`SMALL-STAKE MECHANICS — INTENDED EFFECT vs FARM RATE`);
  console.log(bar(124));
  console.log(`reproduce exactly:`);
  console.log(`    cd engine && HE_FEE_BPS=${FEE_BPS} SOL_USD=${SOL_USD} NODE_OPTIONS=--max-old-space-size=12288 \\`);
  console.log(`        npx tsx ../sandbox/house-edge/small-stake-farm.ts ${ROUNDS} ${PART}`);
  console.log(``);
  console.log(`  fee rate under test      ${FEE_BPS} bps   (fight-variant.ts:34 reads HE_FEE_BPS; the live arena charges 100)`);
  console.log(`  rounds per cell          ${ROUNDS.toLocaleString()}`);
  console.log(`  part                     ${PART}`);
  console.log(`  seats                    ${SEATS_FULL} (MAX_FIGHTERS), plus thin lobbies of 4 and 8 where marked`);
  console.log(`  min entry / stake cap    ${$(MIN_ENTRY, 2)} / ${$(STAKE_CAP_USD, 0)}   dust floor ${DUST_ABSOLUTE} units = ${$(Number(DUST_ABSOLUTE) / 1e6, 3)}`);
  console.log(`  cadence                  ~110s -> ${ROUNDS_PER_HOUR.toFixed(1)} rounds/hr -> ${ROUNDS_PER_DAY.toFixed(0)} rounds/day`);
  console.log(`  keeper gas               ${$(GAS_PRE_USD, 4)}/round pre-reclaim, ${$(GAS_POST_USD, 4)}/round post-reclaim (SOL ${$(SOL_USD, 0)})`);
  console.log(``);
  console.log(`  SEEDS. Study seed "${STUDY_SEED}". Nothing else is random; there is no unseeded call anywhere.`);
  console.log(`    subject lobbies (intended effect)   stakes/sides  mulberry32( sha256("${STUDY_SEED}|<family>|<n>|<round>")[0..4] )`);
  console.log(`                                        identity bits mulberry32( sha256("${STUDY_SEED}|<family>|<n>|verify|<round>")[0..4] )`);
  console.log(`                                        fight seed    sha256("he|${STUDY_SEED}|<family>|<n>|<round>")`);
  console.log(`    farm lobbies (farm rate)            stakes/sides  mulberry32( sha256("${STUDY_SEED}|<family>|<n>|<k>|<round>")[0..4] )`);
  console.log(`                                        identity bits mulberry32( sha256("${STUDY_SEED}|<family>|<n>|<k>|verify|<round>")[0..4] )`);
  console.log(`                                        fight seed    sha256("he|${STUDY_SEED}|<family>|<n>|<k>|<round>")`);
  console.log(`    PART 0 lineups                      sha256("${STUDY_SEED}|p0-lineup|<round>"), fight seed sha256("he|${STUDY_SEED}|p0-lineup|<round>")`);
  console.log(`    band lobbies (PARTS 2, 3, 5)        lobby.ts makeLobby, study seed "${STUDY_SEED}|<family>"          (lobby.ts:34-56)`);
  console.log(`    THE SEATING LAYOUT IS NOT IN ANY SEED, so stacked and alternating face an identical background,`);
  console.log(`    identical background sides and an identical hash table. The comparison is paired to the cent.`);
  console.log(`    families        ${SEED_FAMILIES.join(", ")}`);
  console.log(`    bootstrap draws are seeded per table (see the roiWithSE / diffWithSE call sites), so the CIs`);
  console.log(`    reproduce too, not just the point estimates.`);
  console.log(bar(124));
}

// ================================================================================================
// PART 0 — HARNESS SELF-CHECKS. Every one of these must pass or the process exits 1.
// ================================================================================================

/** The configuration every other part varies. `legacy` is the DEPLOYED byte layout, `shift` is the
 *  shipped defender draw, and the ONLY thing that moves between this and `BASELINE` is the damage
 *  basis — which is the whole point: a difference downstream can then be attributed to P and to
 *  nothing else. `runFight` rejects `legacy` only for WEIGHTED draws (fight-variant.ts:345), and
 *  both weights here are uniform, so this is a legal configuration on the deployed layout. */
const blend = (P: bigint, extra: { gate?: "attacker"; capMult?: bigint } = {}): FightConfig => ({
  attacker: W_UNIFORM, defender: W_UNIFORM, dust: ABS, layout: "legacy",
  defenderDraw: "shift", damage: { blend: P, ...extra },
});

/** A deliberately awkward lineup: a random seat count from 2 to 48, stakes spanning the whole legal
 *  range from MIN_ENTRY to STAKE_CAP_USD (four orders of magnitude, so `min` and `defender` bases
 *  are as far apart as the rules allow), and random sides. If two rules agree here they agree. */
function randomLineup(family: string, round: number): Lobby {
  const rnd = mulberry32(hash32(`${STUDY_SEED}|${family}|${round}`));
  const n = 2 + Math.floor(rnd() * (SEATS_FULL - 1));
  const es: Seat[] = [];
  for (let i = 0; i < n; i++) {
    // log-uniform over [MIN_ENTRY, STAKE_CAP_USD] so tiny and huge rings are equally represented
    const lg = Math.log(MIN_ENTRY) + rnd() * (Math.log(STAKE_CAP_USD) - Math.log(MIN_ENTRY));
    es.push({ wallet: `f${i}`, side: (i % 2) as 0 | 1, grossUnits: usd(Math.exp(lg)), band: -1, house: false, verified: 0 });
  }
  // Force at least one fighter onto each side; a one-sided lineup exercises nothing.
  es[0].side = 0; es[1].side = 1;
  return finish(`${STUDY_SEED}|${family}`, round, es);
}

/** Compare two configurations on the same lineup and return the number of seats whose (hp, banked,
 *  dead) triple differs. Zero means byte-identical outcome. The full bell is run — `stopWhenOver` is
 *  OFF here, so this is the strongest form of the check available. */
function outcomeDiff(lobby: Lobby, a: FightConfig, b: FightConfig, where: string): number {
  const ra = play(lobby, a, { stopWhenOver: false, where: `${where}/a` });
  const rb = play(lobby, b, { stopWhenOver: false, where: `${where}/b` });
  let d = 0;
  for (let i = 0; i < ra.fighters.length; i++) {
    const x = ra.fighters[i], y = rb.fighters[i];
    if (x.hp !== y.hp || x.banked !== y.banked || x.dead !== y.dead) d++;
  }
  return d;
}

function part0(): void {
  const N = Math.max(200, Math.min(400, ROUNDS));
  console.log(`\n${bar(124)}`);
  console.log(`PART 0 — HARNESS SELF-CHECKS. ${N} random lineups each, 2-48 seats, stakes log-uniform on [${$(MIN_ENTRY, 2)}, ${$(STAKE_CAP_USD, 0)}].`);
  console.log(`         Full bell, stopWhenOver OFF. Any non-zero difference column exits 1.`);
  console.log(bar(124));

  const checks: { name: string; a: FightConfig; b: FightConfig }[] = [
    {
      // If this fails, every P-sweep in this file is confounded with the byte layout or the
      // defender draw, and none of them mean what their captions say.
      name: `legacy + shift + {blend: 0} === BASELINE (damage "min")`,
      a: blend(0n), b: BASELINE,
    },
    ...[0n, 20n, 100n, 10000n].map(P => ({
      name: `capMult: 1 at P=${P} === damage "min"`,
      a: blend(P, { capMult: 1n }), b: BASELINE,
    })),
    ...[20n, 100n, 10000n].map(P => ({
      name: `gate "attacker", nobody verified, P=${P} === damage "min"`,
      a: blend(P, { gate: "attacker" }), b: BASELINE,
    })),
  ];

  const hdr = `  check                                                          lineups   seats differing   verdict`;
  console.log(`\n${hdr}`); console.log(rule(hdr.length));
  let failed = false;
  for (const c of checks) {
    let diff = 0;
    for (let r = 0; r < N; r++) diff += outcomeDiff(randomLineup("p0-lineup", r), c.a, c.b, c.name);
    if (diff !== 0) failed = true;
    console.log(`  ${c.name.padEnd(60)}  ${String(N).padStart(7)}   ${String(diff).padStart(15)}   ${diff === 0 ? "IDENTICAL" : "*** DIFFERS ***"}`);
  }
  console.log(rule(hdr.length));

  if (failed) {
    console.error(`\n  A self-check failed. The rig is not measuring what its captions claim. Exiting 1.`);
    process.exit(1);
  }
  console.log(`\n  WHAT THESE FOUR FACTS BUY:`);
  console.log(`   1. blend P=0 on the deployed layout IS the shipped rule, so the only thing varying downstream is P.`);
  console.log(`   2. capMult = 1 collapses the blend to the shipped rule at EVERY P, so PART 2's C=1 column is a control`);
  console.log(`      rather than a measurement, and the C axis is anchored at "no bonus at all".`);
  console.log(`   3. an unverified field under gate "attacker" plays the shipped fight exactly, so PART 3's decay curve`);
  console.log(`      starts from the shipped rule by construction and not by approximation.`);
  console.log(`   4. conservation holds in integers on every fight this process ran, counted below.`);
  conservationReport("0");
}

// ================================================================================================
// PART 1 — INTENDED EFFECT vs FARM RATE FOR THE BLEND DIAL P
// ================================================================================================

/** The dial, in basis points. P = 0 is the shipped size-neutral rule; P = 100 is 1% and already
 *  opens a 32-point ROI spread (SPEC.md's measured baseline, from study-damage.ts). */
const P_MAIN = [0n, 5n, 10n, 20n, 40n, 100n];
const HONEST_STAKES = [1, 3, 5, 10, 20, 50, 100];
const BUDGETS = [20, 80, 400];
const K_MAIN = [1, 2, 4, 8, 12, 16, 24, 32, 40, 48];

const perDay = (perRound: number) => perRound * ROUNDS_PER_DAY;

/** (a) THE INTENDED EFFECT. One wallet, whole budget, in a field of n-1 opponents drawn from BANDS.
 *  Returns a [stake][P] grid of ROI cells with a bootstrap SE over rounds. */
function intendedGrid(n: number, Ps: bigint[], stakesUsd: number[]): { roi: number; se: number; n: number }[][] {
  const cells = stakesUsd.flatMap(s => Ps.map(P => ({
    prep: (l: Lobby) => { seats(l)[0].grossUnits = usd(s); },
    cfg: blend(P),
    opts: { where: `p1a/${n}/$${s}/P${P}` },
  })));
  const acc = scoreCells(ROUNDS, r => subjectLobby("p1a-subject", r, n), cells, (_l, i) => i === 0);
  const out: { roi: number; se: number; n: number }[][] = [];
  for (let si = 0; si < stakesUsd.length; si++)
    out.push(Ps.map((_, pi) => roiWithSE(acc[si * Ps.length + pi].per, 2000, 1000 + si * 13 + pi)));
  return out;
}

function printIntended(n: number, grid: { roi: number; se: number; n: number }[][], Ps: bigint[], stakesUsd: number[]): void {
  const h1 = `    stake  ` + Ps.map(P => `P=${P}bps`.padStart(18)).join("");
  console.log(`\n  ROI per round on the honest player's own stake, ${n} seats (subject + ${n - 1} from BANDS, mean ~$42).`);
  console.log(`  n = ${ROUNDS.toLocaleString()} rounds per cell; +- is a 95% CI from a 2,000-resample bootstrap over rounds.`);
  console.log(h1); console.log(rule(h1.length));
  for (let si = 0; si < stakesUsd.length; si++)
    console.log(`  ${("$" + stakesUsd[si].toFixed(0)).padStart(6)}   ` + grid[si].map(c => cellS(c).padStart(18)).join(""));
  console.log(rule(h1.length));
  const h2 = `    stake  ` + Ps.map(P => `P=${P}bps`.padStart(18)).join("");
  console.log(`\n  the same thing in money: dollars per round, and dollars per day at ${ROUNDS_PER_DAY.toFixed(0)} rounds/day`);
  console.log(h2); console.log(rule(h2.length));
  for (let si = 0; si < stakesUsd.length; si++)
    console.log(`  ${("$" + stakesUsd[si].toFixed(0)).padStart(6)}   ` + grid[si].map(c =>
      `${$(c.roi * stakesUsd[si], 4)} /${$(perDay(c.roi * stakesUsd[si]), 2)}`.padStart(18)).join(""));
  console.log(rule(h2.length));
}

interface FarmCell { roi: number; se: number; k: number; perWallet: number; legal: boolean }

/** (b) THE FARM RATE. Budget B split into k wallets in an n-seat lobby, background takes n - k.
 *  Design copied from study-split.ts:41-56; the STACKED layout is the addition documented on
 *  `farmLobby`. Returns [k][B][P]. */
function farmGrid(family: string, n: number, ks: number[], stacked: boolean, budgets: number[], Ps: bigint[]): FarmCell[][][] {
  const out: FarmCell[][][] = [];
  for (const k of ks) {
    const cells = budgets.flatMap(B => Ps.map(P => ({
      prep: (l: Lobby) => {
        const parts = splitUnits(usd(B), k);
        const es = seats(l);
        for (let i = 0; i < k; i++) es[i].grossUnits = parts[i];
      },
      cfg: blend(P),
      opts: { where: `p1b/${n}/k${k}/$${B}/P${P}` },
    })));
    // A wallet may not exceed STAKE_CAP_USD and may not sit below MIN_ENTRY. Illegal cells are run
    // anyway (the fight does not know about the cap) but are REPORTED as illegal rather than quoted,
    // because a number nobody is allowed to play is not a farm rate.
    const acc = scoreCells(ROUNDS, r => farmLobby(family, r, n, k, stacked), cells, (_l, i) => i < k);
    const row: FarmCell[][] = [];
    for (let bi = 0; bi < budgets.length; bi++) {
      const per = budgets[bi] / k;
      row.push(Ps.map((_, pi) => {
        const s = roiNormal(acc[bi * Ps.length + pi].per);
        return { roi: s.roi, se: s.se, k, perWallet: per, legal: per <= STAKE_CAP_USD + 1e-9 && per >= MIN_ENTRY - 1e-9 };
      }));
    }
    out.push(row);
  }
  return out;
}

function printFarm(label: string, n: number, ks: number[], budgets: number[], Ps: bigint[], g: FarmCell[][][]): { B: number; P: bigint; k: number; roi: number; se: number }[] {
  const best: { B: number; P: bigint; k: number; roi: number; se: number }[] = [];
  for (let bi = 0; bi < budgets.length; bi++) {
    const B = budgets[bi];
    // A budget can be UNPLAYABLE in a thin lobby: with only n-1 seats to split across, B/k may sit
    // above STAKE_CAP_USD at every available k. That is not a small farm rate, it is a lobby the
    // adversary cannot enter with that much money, and it is reported as such rather than quoted.
    if (!ks.some((_, ki) => g[ki][bi][0].legal)) {
      console.log(`\n  ${label} — budget ${$(B, 0)}: NO LEGAL SPLIT. Every k in {${ks.join(", ")}} puts more than ${$(STAKE_CAP_USD, 0)} on a wallet`);
      console.log(`  (${n} seats bounds k at ${ks[ks.length - 1]}, so the smallest per-wallet stake available is ${$(B / ks[ks.length - 1], 2)}). The seat cap is binding,`);
      console.log(`  which is exactly constraint (a) of the central claim doing its job.`);
      continue;
    }
    console.log(`\n  ${label} — budget ${$(B, 0)}, ${n} seats, splitter takes k and the background takes ${n}-k.`);
    console.log(`  ROI is on the WHOLE ${$(B, 0)}. n = ${ROUNDS.toLocaleString()} rounds/cell, +- is a 95% CI (normal, over rounds; the`);
    console.log(`  budget is constant round to round so the ratio of sums IS the mean of the ratios).`);
    const h = `    k   per wallet  ` + Ps.map(P => `P=${P}bps`.padStart(18)).join("");
    console.log(h); console.log(rule(h.length));
    for (let ki = 0; ki < ks.length; ki++) {
      const legal = g[ki][bi][0].legal;
      console.log(`  ${String(ks[ki]).padStart(3)}   ${$(B / ks[ki], 4).padStart(10)}${legal ? " " : "!"} ` +
        Ps.map((_, pi) => cellS(g[ki][bi][pi]).padStart(18)).join(""));
    }
    console.log(rule(h.length));
    console.log(`  "!" marks a cell no player may enter: per-wallet stake outside [${$(MIN_ENTRY, 2)}, ${$(STAKE_CAP_USD, 0)}].`);

    // dollars, and the gain over the smallest LEGAL k (which is k=1 unless the stake cap forbids it)
    const base = ks.findIndex((_, ki) => g[ki][bi][0].legal);
    const h2 = `    k   per wallet  ` + Ps.map(P => `P=${P}bps`.padStart(20)).join("");
    console.log(`\n  dollars per round on the whole budget, and the GAIN over k=${base >= 0 ? ks[base] : "n/a"} (the smallest legal split)`);
    console.log(h2); console.log(rule(h2.length));
    for (let ki = 0; ki < ks.length; ki++) {
      if (!g[ki][bi][0].legal) continue;
      console.log(`  ${String(ks[ki]).padStart(3)}   ${$(B / ks[ki], 4).padStart(10)}  ` +
        Ps.map((_, pi) => `${$(g[ki][bi][pi].roi * B, 4)} (${$((g[ki][bi][pi].roi - g[base][bi][pi].roi) * B, 4)})`.padStart(20)).join(""));
    }
    console.log(rule(h2.length));
    for (let pi = 0; pi < Ps.length; pi++) {
      let bk = -1;
      for (let ki = 0; ki < ks.length; ki++) if (g[ki][bi][pi].legal && (bk < 0 || g[ki][bi][pi].roi > g[bk][bi][pi].roi)) bk = ki;
      if (bk < 0) continue;
      best.push({ B, P: Ps[pi], k: ks[bk], roi: g[bk][bi][pi].roi, se: g[bk][bi][pi].se });
    }
  }
  return best;
}

function part1(): void {
  console.log(`\n${bar(124)}`);
  console.log(`PART 1 — THE BLEND DIAL P: what a genuinely small player gains, against what a splitter extracts`);
  console.log(bar(124));
  console.log(`config: { attacker: uniform, defender: uniform, dust: absolute ${DUST_ABSOLUTE}, layout: "legacy",`);
  console.log(`          defenderDraw: "shift", damage: { blend: P } }   — PART 0 proved P=0 IS the shipped rule.`);

  // ---- (a) --------------------------------------------------------------------------------------
  console.log(`\n${rule(124)}`);
  console.log(`1(a)  INTENDED EFFECT — ONE honest wallet, whole budget, no split, in a field of BANDS opponents.`);
  console.log(rule(124));
  const g8 = intendedGrid(8, P_MAIN, HONEST_STAKES);
  printIntended(8, g8, P_MAIN, HONEST_STAKES);
  const g48 = intendedGrid(SEATS_FULL, P_MAIN, HONEST_STAKES);
  printIntended(SEATS_FULL, g48, P_MAIN, HONEST_STAKES);
  console.log(`\n  Read the P=0 column first: it is the shipped rule and it should sit at -${(Number(FEE_BPS) / 100).toFixed(2)}% for every stake, because`);
  console.log(`  the shipped fight is size-neutral (HOUSE-EDGE §11.5). Everything to its right is the bonus.`);

  // ---- (b) --------------------------------------------------------------------------------------
  console.log(`\n${rule(124)}`);
  console.log(`1(b)  FARM RATE — one adversary, budget B, split into k wallets of B/k. 48 seats.`);
  console.log(rule(124));
  console.log(`  TWO SEATING LAYOUTS, and the difference is the adversary's own choice, not the field's:`);
  console.log(`    ALTERNATING  study-split.ts:48 — wallets on alternating sides, so ~half the adversary's`);
  console.log(`                 exchanges are internal washes between its own wallets.`);
  console.log(`    STACKED      all k wallets on side 0. The background keeps the alternating sides it would`);
  console.log(`                 have had anyway, because the adversary cannot choose where anyone else sits.`);

  const farmStk = farmGrid("p1b-farm", SEATS_FULL, K_MAIN, true, BUDGETS, P_MAIN);
  const bestStk = printFarm("STACKED", SEATS_FULL, K_MAIN, BUDGETS, P_MAIN, farmStk);
  const farmAlt = farmGrid("p1b-farm", SEATS_FULL, K_MAIN, false, BUDGETS, P_MAIN);
  const bestAlt = printFarm("ALTERNATING", SEATS_FULL, K_MAIN, BUDGETS, P_MAIN, farmAlt);

  console.log(`\n  ARGMAX SUMMARY, 48 seats. "$/day" is the adversary's own P&L per day at ${ROUNDS_PER_DAY.toFixed(0)} rounds/day, seating every round.`);
  const h = `    budget   P        STACKED  k*      $/rd       $/day     $/day per $B  |  ALTERNATING  k*      $/rd       $/day    stacking gain`;
  console.log(h); console.log(rule(h.length));
  for (let i = 0; i < bestStk.length; i++) {
    const a = bestStk[i], b = bestAlt[i];
    console.log(`  ${$(a.B, 0).padStart(7)}   ${String(a.P).padStart(5)}bps   ` +
      `${String(a.k).padStart(9)}  ${$(a.roi * a.B, 4).padStart(9)}  ${$(perDay(a.roi * a.B), 2).padStart(10)}  ${$(perDay(a.roi * a.B) / a.B, 4).padStart(12)}  |  ` +
      `${String(b.k).padStart(10)}  ${$(b.roi * b.B, 4).padStart(9)}  ${$(perDay(b.roi * b.B), 2).padStart(10)}  ${$(perDay((a.roi - b.roi) * a.B), 2).padStart(13)}`);
  }
  console.log(rule(h.length));

  // ---- thin lobbies -----------------------------------------------------------------------------
  console.log(`\n${rule(124)}`);
  console.log(`1(b-thin)  REALISTIC OCCUPANCY. er-demo/public/keeper-status.json reports fighterCount 1, realFighterCount 0:`);
  console.log(`           the live board is nearly empty, not 48-deep. A thin lobby is the adversary's BEST case — fewer`);
  console.log(`           honest seats to dilute the bonus and a larger share of the pot — so this is the number that`);
  console.log(`           matters for this product today.`);
  console.log(rule(124));
  for (const n of [4, 8]) {
    const ks = n === 4 ? [1, 2, 3] : [1, 2, 4, 6, 7];
    const gs = farmGrid("p1b-farm", n, ks, true, BUDGETS, P_MAIN);
    const bs = printFarm(`STACKED, THIN LOBBY n=${n}`, n, ks, BUDGETS, P_MAIN, gs);
    const hh = `    n=${n}  budget   P         k*       $/rd        $/day     $/day per $ of budget`;
    console.log(`\n${hh}`); console.log(rule(hh.length));
    for (const b of bs)
      console.log(`        ${$(b.B, 0).padStart(7)}   ${String(b.P).padStart(5)}bps  ${String(b.k).padStart(6)}  ${$(b.roi * b.B, 4).padStart(9)}  ${$(perDay(b.roi * b.B), 2).padStart(11)}  ${$(perDay(b.roi * b.B) / b.B, 4).padStart(21)}`);
    console.log(rule(hh.length));
  }

  // ---- (c) --------------------------------------------------------------------------------------
  console.log(`\n${rule(124)}`);
  console.log(`1(c)  THE RATIO — the whole question on one line per P.`);
  console.log(rule(124));
  console.log(`  INTENDED: a genuine ${$(5, 0)} honest player, ONE wallet, 48 seats (same lobby size as the farm, so the two are comparable).`);
  console.log(`  FARM:     the best (k, layout) cell at budget ${$(80, 0)}, 48 seats. "per $" divides by the money at risk, which is`);
  console.log(`            the only way a ${$(5, 0)} stake and an ${$(80, 0)} budget can be compared at all.`);
  const si5 = HONEST_STAKES.indexOf(5);
  const hC = `    P        intended $5/rd    %/rd     $/day   $/day per $  |  farm k*   $/rd      $/day   $/day per $  |  FARM / INTENDED (per $)`;
  console.log(`\n${hC}`); console.log(rule(hC.length));
  const ratios: { P: bigint; ratio: number; intendedPerD: number; farmPerD: number; k: number }[] = [];
  for (let pi = 0; pi < P_MAIN.length; pi++) {
    const inte = g48[si5][pi];
    const iPerD = perDay(inte.roi * 5) / 5;
    const a = bestStk.find(x => x.B === 80 && x.P === P_MAIN[pi])!;
    const b = bestAlt.find(x => x.B === 80 && x.P === P_MAIN[pi])!;
    const f = a.roi >= b.roi ? a : b;
    const fPerD = perDay(f.roi * 80) / 80;
    ratios.push({ P: P_MAIN[pi], ratio: iPerD !== 0 ? fPerD / iPerD : NaN, intendedPerD: iPerD, farmPerD: fPerD, k: f.k });
    console.log(`  ${String(P_MAIN[pi]).padStart(5)}bps  ${$(inte.roi * 5, 4).padStart(13)}  ${pct(inte.roi, 2).padStart(7)}  ${$(perDay(inte.roi * 5), 2).padStart(8)}  ${$(iPerD, 4).padStart(11)}  |  ${String(f.k).padStart(6)}  ${$(f.roi * 80, 4).padStart(8)}  ${$(perDay(f.roi * 80), 2).padStart(9)}  ${$(fPerD, 4).padStart(11)}  |  ${(iPerD !== 0 ? (fPerD / iPerD).toFixed(2) + "x" : "n/a").padStart(23)}`);
  }
  console.log(rule(hC.length));
  console.log(`\n  PLAINLY: a ratio above 1.00 means the adversary extracts more per dollar at risk than the player the`);
  console.log(`  mechanic was written for. Both columns are net of the ${FEE_BPS} bps fee, so the shipped row (P=0) sits at`);
  console.log(`  -1.00% on both sides and its ratio is the ratio of two negative numbers — read the P>0 rows.`);
  for (const r of ratios) {
    if (r.P === 0n) continue;
    const verdict = r.farmPerD > r.intendedPerD
      ? `THE FARM EXCEEDS THE INTENDED EFFECT by ${(r.farmPerD - r.intendedPerD >= 0 ? "+" : "")}${$(r.farmPerD - r.intendedPerD, 4)}/day per dollar (${(r.farmPerD / r.intendedPerD).toFixed(2)}x)`
      : `the farm does NOT exceed the intended effect (${(r.farmPerD / r.intendedPerD).toFixed(2)}x)`;
    console.log(`    P=${String(r.P).padStart(5)}bps at k*=${String(r.k).padStart(2)}: ${verdict}`);
  }

  part1d();
  conservationReport("1");
}

/** (d) THE FLOOR — how far down does splitting pay?
 *
 *  A DELIBERATE DEPARTURE FROM THE BRIEF, AND IT IS A CORRECTION RATHER THAN A CONVENIENCE. The
 *  brief asks for k = 48 with the budget swept down to $0.48, so that each wallet holds the $0.01
 *  minimum. But in study-split.ts's design — which this file copies — the lobby is exactly 48 seats
 *  and the splitter takes k of them, so k = 48 means the splitter owns EVERY SEAT and the fight is
 *  entirely self-play: ROI is identically -fee at every budget and every P, and the cell measures
 *  nothing at all. (strategy-mechanics.ts says the same thing about its own k = MAX_FIGHTERS row.)
 *  So the per-wallet stake is swept directly instead, at three occupancy levels that leave a real
 *  field to farm: k = 8, 24 and 40 wallets against 40, 24 and 8 background seats. B = k x target.
 *
 *  The question is whether the DUST RULE caps the farm at tiny stakes. It is the only floor in the
 *  loop: `if (D.hp <= floorD) dmg = D.hp` with floorD = 1,000 units = $0.001 (fight-variant.ts:424).
 *  Note which side it keys on — the DEFENDER. A $0.01 wallet ATTACKING is not floored at all; the
 *  blend lets it bite `P x ring_d / BPS` off a whale regardless of its own ring. What the floor does
 *  is kill it in one blow when it is drawn as a defender. So the two forces are: bites that do not
 *  shrink with the wallet, against a death that arrives sooner. */
function part1d(): void {
  console.log(`\n${rule(124)}`);
  console.log(`1(d)  THE FLOOR — how far down does splitting pay, and does the dust rule cap it?`);
  console.log(rule(124));
  const targets = [1.00, 0.50, 0.20, 0.10, 0.05, 0.02, 0.01];
  const Ps = [0n, 20n, 40n, 100n];
  const KS = [8, 24, 40];

  const hdr = `    k    per wallet   budget  ` + Ps.map(P => `P=${P}bps`.padStart(16)).join("") + `    dead%  banked/wallet`;
  for (const k of KS) {
    console.log(`\n  k = ${k} adversary wallets against ${SEATS_FULL - k} background seats, STACKED on side 0. ROI is on the whole budget.`);
    console.log(`  n = ${ROUNDS.toLocaleString()} rounds/cell. "dead%" and "banked/wallet" are for the RIGHTMOST P column (P=${Ps[Ps.length - 1]}bps).`);
    console.log(hdr); console.log(rule(hdr.length));
    for (const t of targets) {
      const B = t * k;
      const cells = Ps.map(P => ({
        prep: (l: Lobby) => { const parts = splitUnits(usd(B), k); const es = seats(l); for (let i = 0; i < k; i++) es[i].grossUnits = parts[i]; },
        cfg: blend(P), opts: { where: `p1d/k${k}/$${t}/P${P}` },
      }));
      // bespoke loop rather than scoreCells: this table needs PER-FIGHTER diagnostics (deaths, banked)
      // and not just the aggregate, because the dust rule's signature is a death rate, not an ROI.
      const per: { inn: number; out: number }[][] = Ps.map(() => []);
      let dead = 0, seatsSeen = 0, bankedTot = 0n;
      for (let r = 0; r < ROUNDS; r++) {
        const lobby = farmLobby("p1d-floor", r, SEATS_FULL, k, true);
        for (let ci = 0; ci < cells.length; ci++) {
          cells[ci].prep(lobby);
          const res = play(lobby, cells[ci].cfg, cells[ci].opts);
          let inn = 0, out = 0;
          for (let i = 0; i < k; i++) { inn += toUsd(seats(lobby)[i].grossUnits); out += toUsd(res.out[i]); }
          per[ci].push({ inn, out });
          if (ci === cells.length - 1) for (let i = 0; i < k; i++) { seatsSeen++; if (res.fighters[i].dead === 1) dead++; bankedTot += res.fighters[i].banked; }
        }
      }
      const rs = Ps.map((_, ci) => roiNormal(per[ci]));
      console.log(`  ${String(k).padStart(3)}   ${$(t, 4).padStart(10)}  ${$(B, 2).padStart(7)}  ` +
        Ps.map((_, ci) => `${$(rs[ci].roi * B, 4)}`.padStart(16)).join("") +
        `   ${(100 * dead / seatsSeen).toFixed(1).padStart(5)}%  ${$(toUsd(bankedTot) / seatsSeen, 4).padStart(13)}`);
    }
    console.log(rule(hdr.length));
    console.log(`  cells are DOLLARS PER ROUND on the whole budget. Divide by the budget for ROI; multiply by ${ROUNDS_PER_DAY.toFixed(0)} for $/day.`);
  }
  console.log(`\n  WHERE THE DUST RULE BITES. floorD = ${DUST_ABSOLUTE} units = ${$(Number(DUST_ABSOLUTE) / 1e6, 3)}, and it keys on the DEFENDER`);
  console.log(`  (fight-variant.ts:424). A wallet holding ${$(0.01, 2)} gross holds ${(0.01 * (1 - Number(FEE_BPS) / 1e4) * 1e6).toFixed(0)} units of ring, ${(0.01 * (1 - Number(FEE_BPS) / 1e4) * 1e6 / Number(DUST_ABSOLUTE)).toFixed(1)}x the floor, so it dies`);
  console.log(`  in at most a handful of blows. It does NOT limit what that wallet takes as an ATTACKER: the blend's`);
  console.log(`  basis reads the defender's ring, so a ${$(0.01, 2)} attacker still bites P/BPS of a whale. Read the dead%`);
  console.log(`  column against the $/round column: if $/round keeps rising while dead% saturates, the floor is not`);
  console.log(`  capping the farm — the SEAT COUNT is.`);
}

// ================================================================================================
// PART 2 — THE BOUNDED BLEND (capMult)
// ================================================================================================
//
// `capMult: C` clamps `basis <= C * min(ring_a, ring_d)` (fight-variant.ts:254-260). It is the only
// STRUCTURAL bound on the blend available without an identity: the unclamped blend's payoff to a
// splitter grows without limit as the split gets finer, because the smaller the attacker, the larger
// `ring_d / min(ring_a, ring_d)`. C = 1 is exactly `min` at every P (PART 0 proves it); C = 1000 is
// unclamped at every P that matters. The question is whether any (P, C) keeps a MATERIAL intended
// effect while COLLAPSING the farm — i.e. whether the clamp bites the splitter harder than it bites
// the genuine small player.

const P2 = [20n, 40n, 100n, 500n, 10000n];
const C2 = [1n, 2n, 3n, 5n, 10n, 1000n];
const K2 = [1, 2, 4, 8, 16, 24, 32, 48];
const P2_BUDGET = 80;

/** ROI by BANDS band, study-damage.ts:39-55's accumulation, for a list of configurations scored
 *  against the same lobbies. Returns [config][band]. */
function bandTable(family: string, perSide: number, cfgs: { cfg: FightConfig; opts?: PlayOpts }[], rounds = ROUNDS): { roi: number; se: number; n: number }[][] {
  const acc = cfgs.map(() => BANDS.map(() => [] as { inn: number; out: number }[]));
  for (let r = 0; r < rounds; r++) {
    const lobby = makeLobby(`${STUDY_SEED}|${family}`, r, perSide);
    for (let c = 0; c < cfgs.length; c++) {
      const res = play(lobby, cfgs[c].cfg, { ...cfgs[c].opts, where: `${family}/cfg${c}` });
      const row = BANDS.map(() => ({ inn: 0, out: 0 }));
      for (let i = 0; i < res.fighters.length; i++) {
        row[lobby.entries[i].band].inn += toUsd(lobby.entries[i].grossUnits);
        row[lobby.entries[i].band].out += toUsd(res.out[i]);
      }
      for (let b = 0; b < BANDS.length; b++) acc[c][b].push(row[b]);
    }
  }
  return acc.map((bs, c) => bs.map((per, b) => roiWithSE(per, 600, 2000 + c * 7 + b)));
}

function part2(): void {
  console.log(`\n${bar(124)}`);
  console.log(`PART 2 — THE BOUNDED BLEND. Grid P x capMult C. Does a clamp separate the intended effect from the farm?`);
  console.log(bar(124));
  console.log(`  basis = clamp( (P*ring_d + (BPS-P)*min(ring_a,ring_d)) / BPS , <= C * min(ring_a,ring_d) )`);
  console.log(`  C = 1 is the shipped rule at every P (PART 0). C = 1000 is unclamped. n = ${ROUNDS.toLocaleString()} rounds per cell.`);

  const grid = P2.flatMap(P => C2.map(C => ({ P, C, cfg: blend(P, { capMult: C }) })));

  // ---- intended effect: a $5 honest wallet, 8 seats ----------------------------------------------
  const cells5 = grid.map(g => ({
    prep: (l: Lobby) => { seats(l)[0].grossUnits = usd(5); },
    cfg: g.cfg, opts: { where: `p2/i/${g.P}/${g.C}` },
  }));
  const acc5 = scoreCells(ROUNDS, r => subjectLobby("p2-subject", r, 8), cells5, (_l, i) => i === 0);
  const roi5 = acc5.map(a => roiNormal(a.per));

  console.log(`\n  (i) INTENDED EFFECT — a genuine $5 honest player, ONE wallet, 8 seats. ROI per round, 95% CI over rounds.`);
  const h1 = `      P \\ C  ` + C2.map(C => `C=${C}`.padStart(17)).join("");
  console.log(h1); console.log(rule(h1.length));
  for (let pi = 0; pi < P2.length; pi++)
    console.log(`  ${String(P2[pi]).padStart(7)}bps  ` + C2.map((_, ci) => cellS(roi5[pi * C2.length + ci]).padStart(17)).join(""));
  console.log(rule(h1.length));

  // ---- band spread at 48 seats -------------------------------------------------------------------
  const bt = bandTable("p2-band", SEATS_FULL / 2, grid.map(g => ({ cfg: g.cfg, opts: { where: `p2/b/${g.P}/${g.C}` } })));
  console.log(`\n  (ii) THE BAND TABLE at ${SEATS_FULL} seats, study-damage.ts:59-63 layout. "spread" is minnow ROI minus whale ROI —`);
  console.log(`       the thing the mechanic is FOR. n = ${ROUNDS.toLocaleString()} rounds; +- is a 95% CI from a 600-resample bootstrap.`);
  const h2 = `      P      C   ` + ["whale", "big", "medium", "small", "minnow"].map(s => s.padStart(17)).join("") + `        spread`;
  console.log(h2); console.log(rule(h2.length));
  const spread: number[] = [];
  for (let i = 0; i < grid.length; i++) {
    const rs = bt[i];
    spread.push(rs[4].roi - rs[0].roi);
    console.log(`  ${String(grid[i].P).padStart(7)}  ${String(grid[i].C).padStart(4)}   ` +
      rs.map(r => cellS(r).padStart(17)).join("") + `  ${pct(rs[4].roi - rs[0].roi, 1).padStart(12)}`);
  }
  console.log(rule(h2.length));

  // ---- farm ---------------------------------------------------------------------------------------
  console.log(`\n  (iii) FARM RATE — an ${$(P2_BUDGET, 0)} adversary, ${SEATS_FULL} seats, best k over ${K2.join("/")}, both seating layouts.`);
  const farm: { k: number; roi: number; se: number; stacked: boolean }[] = grid.map(() => ({ k: 1, roi: -Infinity, se: 0, stacked: true }));
  for (const stacked of [true, false]) {
    for (const k of K2) {
      const cells = grid.map(g => ({
        prep: (l: Lobby) => { const parts = splitUnits(usd(P2_BUDGET), k); const es = seats(l); for (let i = 0; i < k; i++) es[i].grossUnits = parts[i]; },
        cfg: g.cfg, opts: { where: `p2/f/${g.P}/${g.C}/k${k}` },
      }));
      const acc = scoreCells(ROUNDS, r => farmLobby("p2-farm", r, SEATS_FULL, k, stacked), cells, (_l, i) => i < k);
      for (let i = 0; i < grid.length; i++) {
        const s = roiNormal(acc[i].per);
        if (s.roi > farm[i].roi) farm[i] = { k, roi: s.roi, se: s.se, stacked };
      }
    }
  }
  const h3 = `      P \\ C  ` + C2.map(C => `C=${C}`.padStart(19)).join("");
  console.log(`\n       best cell per (P, C): "k* layout  $/rd". $/day = $/rd x ${ROUNDS_PER_DAY.toFixed(0)}.`);
  console.log(h3); console.log(rule(h3.length));
  for (let pi = 0; pi < P2.length; pi++)
    console.log(`  ${String(P2[pi]).padStart(7)}bps  ` + C2.map((_, ci) => {
      const f = farm[pi * C2.length + ci];
      return `${f.k}${f.stacked ? "s" : "a"} ${$(f.roi * P2_BUDGET, 4)}`.padStart(19);
    }).join(""));
  console.log(rule(h3.length));
  console.log(`       "s" = stacked, "a" = alternating.`);
  const h3b = `      P \\ C  ` + C2.map(C => `C=${C}`.padStart(17)).join("");
  console.log(`\n       the same cells as $/day`);
  console.log(h3b); console.log(rule(h3b.length));
  for (let pi = 0; pi < P2.length; pi++)
    console.log(`  ${String(P2[pi]).padStart(7)}bps  ` + C2.map((_, ci) =>
      $(perDay(farm[pi * C2.length + ci].roi * P2_BUDGET), 2).padStart(17)).join(""));
  console.log(rule(h3b.length));

  // ---- the ratio, and the frontier ----------------------------------------------------------------
  console.log(`\n  (iv) FARM / INTENDED, per dollar at risk. Numerator: farm $/day divided by the ${$(P2_BUDGET, 0)} budget.`);
  console.log(`       Denominator: the $5 honest player's $/day divided by ${$(5, 0)}. Both are net of the ${FEE_BPS} bps fee, so a`);
  console.log(`       cell whose intended effect is NEGATIVE (the bonus does not cover the fee) prints "n/a" — the`);
  console.log(`       mechanic has not helped that player at all and a ratio would be meaningless.`);
  const h4 = `      P \\ C  ` + C2.map(C => `C=${C}`.padStart(15)).join("");
  console.log(h4); console.log(rule(h4.length));
  const cellStat: { P: bigint; C: bigint; intended: number; farmPerD: number; ratio: number; k: number; spread: number }[] = [];
  for (let pi = 0; pi < P2.length; pi++) {
    const parts: string[] = [];
    for (let ci = 0; ci < C2.length; ci++) {
      const i = pi * C2.length + ci;
      const iPerD = perDay(roi5[i].roi * 5) / 5;
      const fPerD = perDay(farm[i].roi * P2_BUDGET) / P2_BUDGET;
      const ratio = iPerD > 0 ? fPerD / iPerD : NaN;
      cellStat.push({ P: P2[pi], C: C2[ci], intended: roi5[i].roi, farmPerD: fPerD, ratio, k: farm[i].k, spread: spread[i] });
      parts.push((Number.isFinite(ratio) ? `${ratio.toFixed(2)}x` : "n/a").padStart(15));
    }
    console.log(`  ${String(P2[pi]).padStart(7)}bps  ` + parts.join(""));
  }
  console.log(rule(h4.length));

  // Pareto frontier: intended effect UP, farm-per-dollar-per-day DOWN.
  const live = cellStat.filter(c => c.intended > 0);
  const front = live.filter(a => !live.some(b => b !== a && b.intended >= a.intended && b.farmPerD <= a.farmPerD && (b.intended > a.intended || b.farmPerD < a.farmPerD)));
  front.sort((a, b) => a.intended - b.intended);
  console.log(`\n  THE PARETO FRONTIER over the ${live.length} cells whose intended effect is positive at all (out of ${cellStat.length}).`);
  console.log(`  Axes: intended effect UP (a $5 honest player's ROI/round), farm cost DOWN ($/day per dollar of adversary budget).`);
  const h5 = `      P      C   intended $5 ROI/rd   farm $/day per $B   ratio   best k   band spread`;
  console.log(h5); console.log(rule(h5.length));
  for (const c of front)
    console.log(`  ${String(c.P).padStart(7)}  ${String(c.C).padStart(4)}   ${pct(c.intended, 3).padStart(18)}   ${$(c.farmPerD, 5).padStart(17)}   ${(Number.isFinite(c.ratio) ? c.ratio.toFixed(2) + "x" : "n/a").padStart(5)}   ${String(c.k).padStart(6)}   ${pct(c.spread, 1).padStart(11)}`);
  console.log(rule(h5.length));

  const separating = live.filter(c => c.ratio < 1 && c.intended > 0.005);
  console.log(`\n  THE ANSWER. A cell "separates" if the farm takes LESS per dollar per day than the honest $5 player gains`);
  console.log(`  (ratio < 1.00) while the honest player gains something material (> +0.50%/round).`);
  if (separating.length === 0) {
    console.log(`  *** NO CELL SEPARATES THEM. *** Every (P, C) with a material intended effect hands the splitter at`);
    console.log(`  least as much per dollar. The clamp scales the bonus DOWN for the splitter and the honest player by`);
    console.log(`  the same factor, because it is a function of the same quantity: the ratio of the two rings.`);
    const bestRatio = live.reduce((a, c) => (c.ratio < a.ratio ? c : a));
    console.log(`  The least-bad cell is P=${bestRatio.P} C=${bestRatio.C}: intended ${pct(bestRatio.intended, 3)}/round, farm ${$(bestRatio.farmPerD, 5)}/day per $, ratio ${bestRatio.ratio.toFixed(2)}x.`);
  } else {
    console.log(`  Cells that separate (${separating.length}):`);
    for (const c of separating)
      console.log(`    P=${String(c.P).padStart(5)} C=${String(c.C).padStart(4)}  intended ${pct(c.intended, 3)}/rd, farm ${$(c.farmPerD, 5)}/day per $, ratio ${c.ratio.toFixed(2)}x, best k=${c.k}`);
  }
  conservationReport("2");
}

// ================================================================================================
// PART 3 — THE IDENTITY GATE
// ================================================================================================
//
// DISCLOSED RULE: "the small-stake bonus applies only to a wallet with a verified X link."
// Mechanically: `gate: "attacker"` — the blend applies to an exchange only when the ATTACKER carries
// `verified === 1`, and every other exchange falls back to `min`, the shipped size-neutral rule
// (fight-variant.ts:245-253). This is (c) in the central claim: a PER-WALLET COST THAT SCALES WITH
// k. It is the only one of the three that a designer controls.
//
// THE THING NOBODY HAS COMPUTED, and it is the mechanic's real limit: the bonus is ZERO-SUM INSIDE
// THE VERIFIED SET. A verified small player only gains by biting somebody, and once everybody is
// verified the person being bitten is another verified player. So the intended effect must DECAY as
// the verified fraction v rises, and it must decay toward the shipped rule. Measure the decay, then
// notice what it means: the mechanic's value to an honest player is largest exactly when almost
// nobody has bothered to verify — which is precisely when an adversary who verifies k wallets faces
// an unverified field and takes the whole bonus pool.

const P3 = [20n, 40n, 100n];
const V3 = [0, 0.25, 0.5, 1.0];
const STAKES3 = [1, 3, 5, 10, 20];
const K3 = [1, 2, 4, 8, 12, 16, 24, 32, 40, 48];
const P3_BUDGET = 80;

function part3(): void {
  console.log(`\n${bar(124)}`);
  console.log(`PART 3 — THE IDENTITY GATE. gate: "attacker" + blend P. n = ${ROUNDS.toLocaleString()} rounds per cell.`);
  console.log(bar(124));

  // ---- (i) the unverified field plays the shipped fight -------------------------------------------
  console.log(`\n  (i) CONTROL — an UNVERIFIED field must get exactly the shipped rule: ROI = -fee = ${pct(-Number(FEE_BPS) / 1e4, 2)} in every band.`);
  console.log(`      PART 0 already proved the OUTCOMES are byte-identical; this prices the outcome, so the sigma below is`);
  console.log(`      a statement about the shipped rule's own size-neutrality (HOUSE-EDGE §11.5), not about the gate.`);
  const ctrl = bandTable("p3-pool", SEATS_FULL / 2, P3.map(P => ({ cfg: blend(P, { gate: "attacker" }), opts: { where: `p3/ctrl/${P}` } })));
  const target = -Number(FEE_BPS) / 1e4;
  const h0 = `      config                          ` + ["whale", "big", "medium", "small", "minnow"].map(s => s.padStart(17)).join("") + `   worst sigma vs -fee`;
  console.log(h0); console.log(rule(h0.length));
  for (let i = 0; i < P3.length; i++) {
    const rs = ctrl[i];
    const sig = Math.max(...rs.map(r => (r.se > 0 ? Math.abs(r.roi - target) / r.se : 0)));
    console.log(`      gate+blend P=${String(P3[i]).padStart(5)}bps, v=0     ` + rs.map(r => cellS(r).padStart(17)).join("") + `   ${sig.toFixed(2).padStart(19)}`);
  }
  console.log(rule(h0.length));

  // ---- (ii) the honest verified small player, and the decay in v ----------------------------------
  console.log(`\n  (ii) THE HONEST VERIFIED SMALL PLAYER. One wallet, verified, against a field with verified fraction v.`);
  console.log(`       v = 0 means the subject is the only verified wallet in the lobby. The verified sets NEST as v rises`);
  console.log(`       (an independent RNG stream), so this is a decay curve and not four independent samples.`);
  for (const n of [SEATS_FULL, 8]) {
    const cells = STAKES3.flatMap(s => P3.flatMap(P => V3.map(v => ({
      v, s, P,
      prep: (l: Lobby) => { const es = seats(l); es[0].grossUnits = usd(s); es[0].verified = 1; },
      cfg: blend(P, { gate: "attacker" }),
      opts: { where: `p3/h/${n}/${s}/${P}/${v}` },
    }))));
    // v is a property of the LOBBY, not of the cell, so it cannot be swept by `prep`. One pass per v.
    const byV = new Map<number, ReturnType<typeof roiNormal>[]>();
    const rawV = new Map<number, Cell[]>();
    for (const v of V3) {
      const sub = cells.filter(c => c.v === v);
      const acc = scoreCells(ROUNDS, r => subjectLobby("p3-subject", r, n, v), sub, (_l, i) => i === 0);
      byV.set(v, acc.map(a => roiNormal(a.per)));
      rawV.set(v, acc);
    }
    console.log(`\n       ${n} seats — ROI per round on the honest verified player's own stake`);
    const h = `        stake   P        ` + V3.map(v => `v=${v.toFixed(2)}`.padStart(18)).join("") + `      decay v=0 -> v=1 (paired)`;
    console.log(h); console.log(rule(h.length));
    for (let si = 0; si < STAKES3.length; si++) {
      for (let pi = 0; pi < P3.length; pi++) {
        const idx = si * P3.length + pi;
        const row = V3.map(v => byV.get(v)![idx]);
        // The DECAY is a paired difference: v = 0 and v = 1 are the same lobbies, the same sides, the
        // same hash table and the same background stakes — only the identity bits differ, and the
        // verified sets nest. Its CI is therefore one to two orders of magnitude tighter than the
        // levels beside it, which is why a decay of a fraction of a point is still readable here.
        const d = diffWithSE(rawV.get(1.0)![idx].per, rawV.get(0)![idx].per, 2000, 3000 + si * 5 + pi);
        console.log(`        ${("$" + STAKES3[si]).padStart(5)}   ${String(P3[pi]).padStart(5)}bps  ` +
          row.map(c => cellS(c).padStart(18)).join("") + `   ${`${pct(d.diff, 3)}+-${(ci95(d.se) * 100).toFixed(3)}`.padStart(25)}`);
      }
    }
    console.log(rule(h.length));
  }
  console.log(`\n       THE DECAY IS THE FINDING. The bonus is zero-sum inside the verified set, so the last column is what`);
  console.log(`       an honest verified player actually gets once the mechanic has succeeded at getting people verified.`);

  // ---- (iii) the farm, and what an X account is worth ----------------------------------------------
  console.log(`\n  (iii) THE FARM — an adversary who buys k verified wallets and splits ${$(P3_BUDGET, 0)} across them, ${SEATS_FULL} seats.`);
  console.log(`        Reported per WALLET per DAY, because that is the most an X account can be worth to the attacker`);
  console.log(`        and therefore the break-even price it must be bought below.`);
  for (const bgV of [0, 0.5]) {
    const h = `        P      layout   ` + K3.map(k => `k=${k}`.padStart(11)).join("") + `    k*   $/rd   $/day  MAX $/wallet/day (at k)`;
    console.log(`\n        background verified fraction v = ${bgV.toFixed(2)}   (cells are $/round on the whole ${$(P3_BUDGET, 0)})`);
    console.log(h); console.log(rule(h.length));
    for (const P of P3) {
      for (const stacked of [true, false]) {
        const rois: number[] = [];
        for (const k of K3) {
          const cells = [{
            prep: (l: Lobby) => {
              const parts = splitUnits(usd(P3_BUDGET), k); const es = seats(l);
              for (let i = 0; i < k; i++) { es[i].grossUnits = parts[i]; es[i].verified = 1; }
            },
            cfg: blend(P, { gate: "attacker" }), opts: { where: `p3/f/${P}/k${k}/${bgV}` },
          }];
          const acc = scoreCells(ROUNDS, r => farmLobby("p3-farm", r, SEATS_FULL, k, stacked, bgV), cells, (_l, i) => i < k);
          rois.push(roiNormal(acc[0].per).roi);
        }
        let bi = 0; for (let i = 0; i < rois.length; i++) if (rois[i] > rois[bi]) bi = i;
        let wi = 0; for (let i = 0; i < rois.length; i++) if (perDay(rois[i] * P3_BUDGET) / K3[i] > perDay(rois[wi] * P3_BUDGET) / K3[wi]) wi = i;
        console.log(`      ${String(P).padStart(5)}bps  ${(stacked ? "stacked" : "alt").padStart(7)}   ` +
          rois.map(r => $(r * P3_BUDGET, 3).padStart(11)).join("") +
          `  ${String(K3[bi]).padStart(4)}  ${$(rois[bi] * P3_BUDGET, 2).padStart(6)}  ${$(perDay(rois[bi] * P3_BUDGET), 2).padStart(7)}  ${`${$(perDay(rois[wi] * P3_BUDGET) / K3[wi], 4)} (k=${K3[wi]})`.padStart(23)}`);
      }
    }
    console.log(rule(h.length));
  }
  console.log(`\n        BREAK-EVEN, STATED AS A NUMBER TO COMPARE A PRICE AGAINST, NOT AS A PRICE. An X account is durable:`);
  console.log(`        it earns its $/wallet/day every day it survives. So the ceiling on what an attacker will pay is`);
  console.log(`        MAX $/wallet/day x (expected account lifetime in days). This file does not know either the market`);
  console.log(`        price of an aged X account or how long one survives a ban wave, and does not guess at them.`);

  // ---- (iv) who actually receives the bonus pool ---------------------------------------------------
  console.log(`\n  (iv) WHERE THE BONUS POOL GOES at v = 0.50. The pool is measured as a PAIRED per-seat difference against`);
  console.log(`       the shipped rule on the same lobby and the same hash table: bonus_i = out_i(gated blend) - out_i(BASELINE).`);
  console.log(`       Conservation makes sum(bonus_i) = 0 exactly, so "the pool" is the sum of the POSITIVE side.`);
  const hP = `        P     k    pool $/rd   to splitter   to verified minnow+small   to other verified   to unverified`;
  console.log(hP); console.log(rule(hP.length));
  for (const P of P3) {
    for (const k of [4, 16, 32]) {
      let pool = 0, toSplit = 0, toSmall = 0, toOther = 0, toUnver = 0;
      for (let r = 0; r < ROUNDS; r++) {
        const lobby = farmLobby("p3-pool", r, SEATS_FULL, k, true, 0.5);
        const parts = splitUnits(usd(P3_BUDGET), k); const es = seats(lobby);
        for (let i = 0; i < k; i++) { es[i].grossUnits = parts[i]; es[i].verified = 1; }
        const a = play(lobby, blend(P, { gate: "attacker" }), { where: `p3/pool/${P}/${k}/a` });
        const b = play(lobby, BASELINE, { where: `p3/pool/${P}/${k}/b` });
        for (let i = 0; i < es.length; i++) {
          const d = toUsd(a.out[i]) - toUsd(b.out[i]);
          if (d <= 0) continue;
          pool += d;
          if (i < k) toSplit += d;
          else if (es[i].verified === 1 && es[i].band >= 3) toSmall += d;
          else if (es[i].verified === 1) toOther += d;
          else toUnver += d;
        }
      }
      const pc = (x: number) => `${(100 * x / pool).toFixed(1)}%`;
      console.log(`      ${String(P).padStart(5)}bps ${String(k).padStart(4)}  ${$(pool / ROUNDS, 4).padStart(10)}   ${pc(toSplit).padStart(11)}   ${pc(toSmall).padStart(24)}   ${pc(toOther).padStart(17)}   ${pc(toUnver).padStart(13)}`);
    }
  }
  console.log(rule(hP.length));
  console.log(`       "verified minnow+small" is a GENUINE single-wallet small player: a background seat in the $3-8 or`);
  console.log(`       $8-20 band that carries the identity bit. "to unverified" is nonzero only because an unverified`);
  console.log(`       fighter can still be a net winner when the wallet that WOULD have bitten it spent its draw elsewhere.`);
  conservationReport("3");
}

// ================================================================================================
// PART 4 — A FEE BANDED BY STAKE, AND WHETHER §8.1's FINDING GENERALISES
// ================================================================================================
//
// HOUSE-LIFETIME.md §8.1 found a TIERED rate card is drained 75% in one round and must never ship.
// The obvious rescue is SMOOTHNESS: a cliff is farmable because it has a cliff, so make the schedule
// continuous and the attack goes away. This part prices that hope.
//
// IT NEEDS NO FIGHT SIMULATION, and that is a claim rather than a convenience, so it is asserted:
// the shipped fight is size-neutral and pays NOTHING for splitting (HOUSE-EDGE §11.5, reproduced at
// zero fee below), so the fee term and the fight term simply add and the fee term is arithmetic on
// the published card. An adversary reads the card and subtracts. There is no learning curve.

const P4_BUDGET = 80;
const K4 = Array.from({ length: 16 }, (_, i) => i + 1);

interface RateCard {
  label: string;
  /** Effective TOTAL rate in basis points on a gross stake of `s` USD. Marginal schedules are
   *  expressed here as total-rate-on-the-whole-entry, because that is what a player pays and what an
   *  adversary compares. */
  bps: (s: number) => number;
}

/** E[ s x bps(s) / 1e4 ] over the BANDS stake distribution: five equally likely bands, uniform
 *  inside each (lobby.ts:39-47). Deterministic midpoint quadrature rather than Monte Carlo, because a
 *  revenue-matching bisection needs a smooth, reproducible objective — a resampled objective would
 *  make the calibration itself a random variable. */
const QUAD_NODES = 4001;
function expectedRevenue(c: RateCard): number {
  let s = 0;
  for (const b of BANDS) {
    for (let i = 0; i < QUAD_NODES; i++) {
      const x = b.lo + ((i + 0.5) / QUAD_NODES) * (b.hi - b.lo);
      s += x * c.bps(x) / 1e4;
    }
  }
  return s / (BANDS.length * QUAD_NODES);
}

/** Solve a schedule family's one free scalar so its revenue matches the flat-100 bps control on the
 *  same stake distribution. Monotone in the scalar by construction, so bisection is exact to 1e-12. */
function matchRevenue(make: (x: number) => RateCard, lo: number, hi: number, target: number): number {
  let a = lo, b = hi;
  for (let i = 0; i < 80; i++) {
    const m = (a + b) / 2;
    if (expectedRevenue(make(m)) < target) a = m; else b = m;
  }
  return (a + b) / 2;
}

function part4(): void {
  console.log(`\n${bar(124)}`);
  console.log(`PART 4 — A FEE BANDED BY STAKE. Does SMOOTHNESS escape §8.1's 75% drain?`);
  console.log(bar(124));

  // ---- the assertion that lets the rest be arithmetic ---------------------------------------------
  console.log(`\n  (0) THE ASSERTION THAT MAKES THIS PART ARITHMETIC. At ZERO fee the fight must pay nothing for`);
  console.log(`      splitting, k = 1..16, ${$(P4_BUDGET, 0)} budget, ${SEATS_FULL} seats, STACKED (the layout most favourable to the splitter).`);
  console.log(`      If any cell is significant the fee term and the fight term do not separate and this part is void.`);
  const zero: { k: number; roi: number; se: number }[] = [];
  for (const k of K4) {
    const cells = [{
      prep: (l: Lobby) => { const parts = splitUnits(usd(P4_BUDGET), k); const es = seats(l); for (let i = 0; i < k; i++) es[i].grossUnits = parts[i]; },
      cfg: BASELINE, opts: { feeBps: 0n, where: `p4/neutral/k${k}` },
    }];
    const acc = scoreCells(ROUNDS, r => farmLobby("p4-neutral", r, SEATS_FULL, k, true), cells, (_l, i) => i < k);
    const s = roiNormal(acc[0].per);
    zero.push({ k, roi: s.roi, se: s.se });
  }
  const h0 = `        k   ` + K4.map(k => String(k).padStart(7)).join("");
  console.log(`\n${h0}`);
  console.log(`   gain $/rd ` + zero.map(z => $((z.roi - zero[0].roi) * P4_BUDGET, 3).padStart(7)).join(""));
  console.log(`   sigma     ` + zero.map((z, i) => (i === 0 ? "-" : (Math.abs(z.roi - zero[0].roi) / Math.hypot(z.se, zero[0].se)).toFixed(2)).padStart(7)).join(""));
  const worstSig = Math.max(...zero.slice(1).map(z => Math.abs(z.roi - zero[0].roi) / Math.hypot(z.se, zero[0].se)));
  console.log(`\n      worst |gain| = ${worstSig.toFixed(2)} sigma over ${ROUNDS.toLocaleString()} rounds per cell -> ${worstSig < 2 ? "every cell straddles zero; §11.5 REPRODUCED" : "*** CHECK THIS: the fight is NOT split-neutral here ***"}`);

  // ---- the rate cards ------------------------------------------------------------------------------
  const flat: RateCard = { label: "flat 100 bps (control)", bps: () => 100 };
  const TARGET = expectedRevenue(flat);

  const cliff = (top: number): RateCard => ({ label: `tiered cliff 25/100/${top.toFixed(0)}`, bps: s => (s <= 10 ? 25 : s <= 50 ? 100 : top) });
  const marginal = (top: number): RateCard => ({
    label: `tiered marginal 25/100/${top.toFixed(0)}`,
    bps: s => (0.0025 * Math.min(s, 10) + 0.01 * Math.min(Math.max(s - 10, 0), 40) + (top / 1e4) * Math.max(s - 50, 0)) / s * 1e4,
  });
  const power = (b: number) => (A: number): RateCard => ({ label: `smooth power  A*s^${b.toFixed(2)}  A=${A.toFixed(3)}`, bps: s => A * Math.pow(s, b) });
  const logsch = (c: number) => (a: number): RateCard => ({
    label: `smooth log    a*(1+${c.toFixed(2)}*ln(s/${MIN_ENTRY}))  a=${a.toFixed(3)}`,
    bps: s => a * (1 + c * Math.log(s / MIN_ENTRY)),
  });
  const floored = (fmin: number, b: number) => (A: number): RateCard => ({
    label: `floor ${fmin.toFixed(0)}bps + A*s^${b.toFixed(2)}  A=${A.toFixed(3)}`,
    bps: s => Math.max(fmin, A * Math.pow(s, b)),
  });

  const cards: RateCard[] = [flat];
  cards.push(cliff(matchRevenue(cliff, 100, 2000, TARGET)));
  cards.push(marginal(matchRevenue(marginal, 100, 2000, TARGET)));
  for (const b of [0.1, 0.25, 0.5]) cards.push(power(b)(matchRevenue(power(b), 1e-3, 1e4, TARGET)));
  for (const c of [0.10, 0.25, 0.50]) cards.push(logsch(c)(matchRevenue(logsch(c), 1e-3, 1e4, TARGET)));
  for (const fmin of [50, 90]) cards.push(floored(fmin, 0.25)(matchRevenue(floored(fmin, 0.25), 1e-3, 1e4, TARGET)));

  console.log(`\n  (1) THE CARDS, all revenue-matched to flat 100 bps on the BANDS stake distribution.`);
  console.log(`      Target revenue ${$(TARGET, 6)} per entry (mean stake ${$(expectedRevenue({ label: "", bps: () => 1e4 }), 4)}). Deterministic quadrature, ${(BANDS.length * QUAD_NODES).toLocaleString()} nodes.`);
  const PROBES = [MIN_ENTRY, 0.1, 1, 5, 20, 80, 100];
  const h1 = `      schedule                                     ` + PROBES.map(s => `$${s}`.padStart(9)).join("") + `    max/min    rev/entry`;
  console.log(h1); console.log(rule(h1.length));
  for (const c of cards) {
    const rs = PROBES.map(s => c.bps(s));
    console.log(`      ${c.label.padEnd(44)} ` + rs.map(r => r.toFixed(1).padStart(9)).join("") +
      `    ${(Math.max(...rs) / Math.min(...rs)).toFixed(1).padStart(7)}x  ${$(expectedRevenue(c), 6).padStart(11)}`);
  }
  console.log(rule(h1.length));
  console.log(`      cells are the EFFECTIVE rate in bps at that gross stake, as a player reads the card.`);

  // ---- drain vs intended effect -------------------------------------------------------------------
  console.log(`\n  (2) THE ATTACK, and the honest player it is supposed to be for, side by side.`);
  console.log(`      DRAIN: an ${$(P4_BUDGET, 0)} adversary splits to the revenue-MINIMISING k, bounded by ${SEATS_FULL} seats and the ${$(MIN_ENTRY, 2)} minimum entry.`);
  console.log(`      INTENDED: what a genuine ${$(5, 0)} single-wallet player saves against the flat control, per round and per day.`);
  const h2 = `      schedule                                     honest/rd   k*   split/rd    drained    $/day   |  $5 saves/rd    $/day   |  drain per $ / save per $`;
  console.log(h2); console.log(rule(h2.length));
  const flatFive = 5 * flat.bps(5) / 1e4;
  const rows: { label: string; drained: number; perDollar: number; savePerDollar: number }[] = [];
  for (const c of cards) {
    const honest = P4_BUDGET * c.bps(P4_BUDGET) / 1e4;
    let bestK = 1, bestRake = honest;
    for (let k = 1; k <= SEATS_FULL; k++) {
      const per = P4_BUDGET / k;
      if (per < MIN_ENTRY) break;
      const rake = P4_BUDGET * c.bps(per) / 1e4;
      if (rake < bestRake - 1e-12) { bestRake = rake; bestK = k; }
    }
    const drained = honest > 0 ? (honest - bestRake) / honest : 0;
    const gainDay = perDay(honest - bestRake);
    const save = flatFive - 5 * c.bps(5) / 1e4;
    const perDollarDrain = gainDay / P4_BUDGET, perDollarSave = perDay(save) / 5;
    rows.push({ label: c.label, drained, perDollar: perDollarDrain, savePerDollar: perDollarSave });
    console.log(`      ${c.label.padEnd(44)} ${$(honest, 4).padStart(9)}  ${String(bestK).padStart(3)}  ${$(bestRake, 4).padStart(9)}  ${(drained * 100).toFixed(1).padStart(8)}%  ${$(gainDay, 2).padStart(8)}   |  ${$(save, 4).padStart(10)}  ${$(perDay(save), 2).padStart(8)}   |  ${(perDollarSave !== 0 ? (perDollarDrain / perDollarSave).toFixed(2) + "x" : "n/a").padStart(24)}`);
  }
  console.log(rule(h2.length));

  console.log(`\n  (3) DOES SMOOTHNESS HELP? THE DRAIN IS AN IDENTITY, NOT A PROPERTY OF CONTINUITY:`);
  console.log(`          drained  =  1 - bps(B/k*) / bps(B)`);
  console.log(`      It reads the schedule at exactly two points and never asks whether the curve between them has a`);
  console.log(`      corner. A cliff is drained 75% because its two points are 4x apart; a smooth power law with the`);
  console.log(`      same end-to-end spread is drained by the same amount. The ONLY thing that shrinks the drain is`);
  console.log(`      shrinking the discount itself — which is the intended effect. The last column prices that trade:`);
  console.log(`      dollars the adversary takes per dollar of budget, over dollars a genuine $5 player saves per dollar`);
  console.log(`      of stake. A schedule "escapes" only if that ratio is below 1.00.`);
  const escapes = rows.filter(r => r.savePerDollar > 1e-9 && r.perDollar / r.savePerDollar < 1);
  if (escapes.length === 0) console.log(`\n      *** NO SCHEDULE ESCAPES. *** Every card with a small-stake discount hands an ${$(P4_BUDGET, 0)} splitter at least as`);
  else { console.log(`\n      Schedules with a ratio below 1.00:`); for (const e of escapes) console.log(`        ${e.label.padEnd(44)} ${(e.perDollar / e.savePerDollar).toFixed(3)}x`); }
  if (escapes.length === 0) console.log(`      many dollars per dollar as it gives the genuine small player. Smoothness changes the shape and not the trade.`);
  console.log(`\n      THE ONE STRUCTURAL LEVER THAT DOES WORK IS A HARD FLOOR, and it works by bounding the discount:`);
  console.log(`      a floor at f_min caps the drain at 1 - f_min/bps(B), which is a design parameter rather than an`);
  console.log(`      accident of the curve. Read the two "floor" rows against the "power" rows with the same exponent.`);
  conservationReport("4");
}

// ================================================================================================
// PART 5 — THE PER-ENTRY CAP RELATIVE TO THE POT
// ================================================================================================
//
// DISCLOSED RULE: "no fighter's ring may exceed C times the mean GROSS entry of the round; the excess
// is refunded before the bell." Implemented in `play()` as a pre-fight ring normalisation:
// order-free (it reads the multiset of entries), value-conserving (asserted in integers, twice), and
// it never touches the damage loop — the fight that runs afterwards is the SHIPPED fight on a
// smaller lineup. That is the whole appeal: no new damage rule, no new byte layout, nothing to port.
//
// MY PRIOR, STATED BEFORE THE MEASUREMENT SO IT CAN BE REFUTED: the shipped fight is already
// size-neutral, so a cap should change VARIANCE and not MEAN. If that is right, this is not a
// small-stake-favouring mechanic at all — it is a variance instrument, and it should be described as
// one. Both quantities are measured below and the verdict is stated in sigma.

/** C = 1.0 and 1.25 are NOT in the brief and are here because the brief's smallest value turns out to
 *  be near the top of the useful range. The BANDS mean gross entry is ~$42 and `STAKE_CAP_USD` is
 *  $100, so any C at or above ~2.4 refunds nothing at all and the row is inert by construction — the
 *  stake cap has already done the capping. Without these two rows the sweep would have had one
 *  informative cell and four copies of "no cap". */
const C5: { label: string; num?: bigint; den?: bigint }[] = [
  { label: "C = 1.0", num: 1n, den: 1n },
  { label: "C = 1.25", num: 5n, den: 4n },
  { label: "C = 1.5", num: 3n, den: 2n },
  { label: "C = 2  ", num: 2n, den: 1n },
  { label: "C = 3  ", num: 3n, den: 1n },
  { label: "C = 5  ", num: 5n, den: 1n },
  { label: "no cap ", num: undefined, den: undefined },
];

function part5(): void {
  console.log(`\n${bar(124)}`);
  console.log(`PART 5 — THE PER-ENTRY CAP. Ring <= C x mean gross entry; the excess is refunded, untouched by the fight.`);
  console.log(bar(124));
  console.log(`  The fight underneath is BASELINE — the shipped rule, unchanged. n = ${ROUNDS.toLocaleString()} rounds, ${SEATS_FULL} seats from BANDS.`);
  console.log(`  CONSERVATION here is TWO identities, both integer, both asserted every round (see play()):`);
  console.log(`      ringed + refunded === net stake        (before the bell)`);
  console.log(`      sum(hp + banked)  === ringed           (after the bell)`);

  // ---- ROI and per-seat sd by band ----------------------------------------------------------------
  const perRound = C5.map(() => BANDS.map(() => [] as { inn: number; out: number }[]));
  const perSeat = C5.map(() => BANDS.map(() => [] as number[]));
  const refunded = C5.map(() => ({ ref: 0, gross: 0 }));
  for (let r = 0; r < ROUNDS; r++) {
    const lobby = makeLobby(`${STUDY_SEED}|p5-band`, r, SEATS_FULL / 2);
    for (let c = 0; c < C5.length; c++) {
      const res = play(lobby, BASELINE, { capNum: C5[c].num, capDen: C5[c].den, where: `p5/band/${C5[c].label}` });
      const row = BANDS.map(() => ({ inn: 0, out: 0 }));
      for (let i = 0; i < res.fighters.length; i++) {
        const b = lobby.entries[i].band;
        const inn = toUsd(lobby.entries[i].grossUnits), out = toUsd(res.out[i]);
        row[b].inn += inn; row[b].out += out;
        perSeat[c][b].push(out / inn - 1);
        refunded[c].ref += toUsd(res.refunds[i]); refunded[c].gross += inn;
      }
      for (let b = 0; b < BANDS.length; b++) perRound[c][b].push(row[b]);
    }
  }

  console.log(`\n  (1) ROI BY BAND. If the cap favoured small players in EXPECTATION these columns would fan out.`);
  const h1 = `      cap      ` + BANDS.map(b => b.name.trim().padStart(17)).join("") + `      spread   gross refunded`;
  console.log(h1); console.log(rule(h1.length));
  const target = -Number(FEE_BPS) / 1e4;
  let worstSig = 0;
  for (let c = 0; c < C5.length; c++) {
    const rs = BANDS.map((_, b) => roiWithSE(perRound[c][b], 2000, 5000 + c * 11 + b));
    worstSig = Math.max(worstSig, ...rs.map(r => (r.se > 0 ? Math.abs(r.roi - target) / r.se : 0)));
    console.log(`      ${C5[c].label}  ` + rs.map(r => cellS(r).padStart(17)).join("") +
      `  ${pct(rs[4].roi - rs[0].roi, 2).padStart(10)}   ${(100 * refunded[c].ref / refunded[c].gross).toFixed(2).padStart(13)}%`);
  }
  console.log(rule(h1.length));
  console.log(`      worst deviation of any band from -fee = ${pct(target, 2)}:  ${worstSig.toFixed(2)} sigma`);

  console.log(`\n  (2) THE VARIANCE CHANNEL — per-SEAT standard deviation of round ROI, by band. This is what a cap actually`);
  console.log(`      moves: it bounds how big an opponent can be, and therefore how large a single exchange can be.`);
  const h2 = `      cap      ` + BANDS.map(b => b.name.trim().padStart(15)).join("") + `     seats/band`;
  console.log(h2); console.log(rule(h2.length));
  for (let c = 0; c < C5.length; c++)
    console.log(`      ${C5[c].label}  ` + BANDS.map((_, b) => `${(100 * sd(perSeat[c][b])).toFixed(2)}%`.padStart(15)).join("") +
      `   ${perSeat[c][0].length.toLocaleString().padStart(12)}`);
  console.log(rule(h2.length));
  const relVar = BANDS.map((_, b) => sd(perSeat[0][b]) / sd(perSeat[C5.length - 1][b]));
  console.log(`      C=1.5 as a fraction of uncapped:  ` + BANDS.map((_, b) => `${(100 * relVar[b]).toFixed(1)}%`.padStart(15)).join(""));

  // ---- is it farmable? splitting -------------------------------------------------------------------
  console.log(`\n  (3) IS IT FARMABLE BY SPLITTING? ${$(80, 0)} budget, ${SEATS_FULL} seats, STACKED, cap C = 2.`);
  const ks = [1, 2, 4, 8, 16, 24, 32, 48];
  const splitRes: { k: number; roi: number; se: number }[] = [];
  for (const k of ks) {
    const cells = [{
      prep: (l: Lobby) => { const parts = splitUnits(usd(80), k); const es = seats(l); for (let i = 0; i < k; i++) es[i].grossUnits = parts[i]; },
      cfg: BASELINE, opts: { capNum: 2n, capDen: 1n, where: `p5/split/k${k}` },
    }];
    const acc = scoreCells(ROUNDS, r => farmLobby("p5-farm", r, SEATS_FULL, k, true), cells, (_l, i) => i < k);
    const s = roiNormal(acc[0].per);
    splitRes.push({ k, roi: s.roi, se: s.se });
  }
  const h3 = `        k   ` + ks.map(k => String(k).padStart(13)).join("");
  console.log(h3);
  console.log(`   ROI/rd   ` + splitRes.map(s => cellS(s).padStart(13)).join(""));
  console.log(`   gain $   ` + splitRes.map(s => $((s.roi - splitRes[0].roi) * 80, 3).padStart(13)).join(""));
  const bestSplit = splitRes.reduce((a, s) => (s.roi > a.roi ? s : a));
  console.log(`      argmax k = ${bestSplit.k}, gain over k=1 = ${$((bestSplit.roi - splitRes[0].roi) * 80, 4)}/round (${(Math.abs(bestSplit.roi - splitRes[0].roi) / Math.hypot(bestSplit.se, splitRes[0].se)).toFixed(2)} sigma)`);

  // ---- consolidating -------------------------------------------------------------------------------
  console.log(`\n  (4) IS IT REVERSE-FARMED BY CONSOLIDATING? A single wallet of increasing size in a BANDS field, ${SEATS_FULL} seats.`);
  console.log(`      A cap punishes size if it exists, so the adversary's optimum here should be SMALL, not large.`);
  const bigStakes = [5, 20, 50, 100];
  const conCells = bigStakes.flatMap(s => C5.map(cc => ({
    prep: (l: Lobby) => { seats(l)[0].grossUnits = usd(s); },
    cfg: BASELINE, opts: { capNum: cc.num, capDen: cc.den, where: `p5/con/$${s}/${cc.label}` },
  })));
  const conAcc = scoreCells(ROUNDS, r => subjectLobby("p5-subject", r, SEATS_FULL), conCells, (_l, i) => i === 0);
  const h4 = `        stake   ` + C5.map(c => c.label.trim().padStart(19)).join("");
  console.log(h4); console.log(rule(h4.length));
  for (let si = 0; si < bigStakes.length; si++)
    console.log(`        ${("$" + bigStakes[si]).padStart(5)}   ` + C5.map((_, ci) => cellS(roiNormal(conAcc[si * C5.length + ci].per)).padStart(19)).join(""));
  console.log(`\n        per-round ROI standard deviation of the same cells`);
  for (let si = 0; si < bigStakes.length; si++)
    console.log(`        ${("$" + bigStakes[si]).padStart(5)}   ` + C5.map((_, ci) => {
      const rs = conAcc[si * C5.length + ci].per.map(p => p.out / p.inn - 1);
      return `${(100 * sd(rs)).toFixed(2)}%`.padStart(19);
    }).join(""));
  console.log(rule(h4.length));

  console.log(`\n  (5) THE VERDICT, MEAN vs VARIANCE. Read table (1) for the mean and table (2) for the variance.`);
  console.log(`      If every band in (1) sits at -fee within a couple of sigma, the cap does NOT favour small players in`);
  console.log(`      expectation and should never be sold as though it did; if (2) falls materially for the small bands,`);
  console.log(`      it is a genuine variance instrument, which is a real product benefit and a different claim.`);
  console.log(`      Note also which direction the refund runs: the fee is charged on GROSS before the cap, so a whale`);
  console.log(`      pays ${FEE_BPS} bps on money that never enters the ring. That is a small-stake tilt in the FEE, not in the fight,`);
  console.log(`      and it is bounded by ${$(STAKE_CAP_USD, 0)} rather than by the cap.`);
  conservationReport("5");
}

// ================================================================================================
// PART 6 — CAN THE OPERATOR FARM ANY OF THIS?
// ================================================================================================
//
// The operator is not a privileged player. It is a WORSE one, in three specific ways this part
// prices: it pays keeper gas nobody else pays, it must seat every round rather than picking its
// spots, and its wallets are published so its book can be read and avoided.
//
// AND THE MONEY IS NOT FREE. A farm is not revenue: the fight conserves value, so every dollar the
// house's own book wins is a dollar some real player's balance lost. That transfer is reported
// explicitly below rather than left implicit in a P&L line, because "the house can farm its own
// mechanic" and "the house can take players' money faster" are the same sentence.

const P6_BUDGET = 80;
const K6 = [1, 2, 4, 8, 12, 16, 24, 32, 40];

interface Mech { label: string; cfg: FightConfig; opts?: PlayOpts; verify?: boolean; bgV?: number }

function part6(): void {
  console.log(`\n${bar(124)}`);
  console.log(`PART 6 — THE OPERATOR'S POSITION. Each mechanic at a setting the earlier parts identify as farmable.`);
  console.log(bar(124));
  console.log(`  book size ${$(P6_BUDGET, 0)} per round, ${SEATS_FULL} seats, STACKED. n = ${ROUNDS.toLocaleString()} rounds per (mechanic, k) cell.`);
  console.log(`  keeper gas ${$(GAS_PRE_USD, 4)}/round pre-reclaim and ${$(GAS_POST_USD, 4)}/round post-reclaim; a private adversary pays NEITHER.`);

  const mechs: Mech[] = [
    { label: "SHIPPED (control, damage=min)   ", cfg: BASELINE },
    { label: "blend P=40 bps                  ", cfg: blend(40n) },
    { label: "blend P=100 bps, capMult C=3    ", cfg: blend(100n, { capMult: 3n }) },
    { label: "gated blend P=40, field v=0.50  ", cfg: blend(40n, { gate: "attacker" }), verify: true, bgV: 0.5 },
    { label: "per-entry ring cap C=2          ", cfg: BASELINE, opts: { capNum: 2n, capDen: 1n } },
  ];

  interface Row { k: number; house: number[]; real: number[]; houseFee: number[]; realFee: number[]; bgMean: number[] }
  const results: { m: Mech; rows: Row[] }[] = [];
  for (const m of mechs) {
    const rows: Row[] = [];
    for (const k of K6) {
      const row: Row = { k, house: [], real: [], houseFee: [], realFee: [], bgMean: [] };
      for (let r = 0; r < ROUNDS; r++) {
        const lobby = farmLobby("p6-farm", r, SEATS_FULL, k, true, m.bgV ?? 0);
        const parts = splitUnits(usd(P6_BUDGET), k); const es = seats(lobby);
        for (let i = 0; i < k; i++) { es[i].grossUnits = parts[i]; es[i].verified = m.verify ? 1 : 0; }
        const res = play(lobby, m.cfg, { ...m.opts, where: `p6/${m.label}/k${k}` });
        let hp = 0, rp = 0, hf = 0, rf = 0, bg = 0;
        const feeRate = Number(FEE_BPS) / 1e4;
        for (let i = 0; i < es.length; i++) {
          const g = toUsd(es[i].grossUnits), o = toUsd(res.out[i]);
          if (i < k) { hp += o - g; hf += g * feeRate; } else { rp += o - g; rf += g * feeRate; bg += g; }
        }
        row.house.push(hp); row.real.push(rp); row.houseFee.push(hf); row.realFee.push(rf);
        row.bgMean.push(es.length > k ? bg / (es.length - k) : 0);
      }
      rows.push(row);
    }
    results.push({ m, rows });
  }

  // ---- (a) always-seat vs selective ----------------------------------------------------------------
  console.log(`\n  (a) THE HOUSE (must seat every round) vs A PRIVATE ADVERSARY (picks its spots).`);
  console.log(`      TWO SELECTIVITY MODELS, because the brief's own filter turns out to be inert at the interesting k:`);
  console.log(`        "own"  the specified rule — skip any round whose FIELD MEAN GROSS is below the adversary's OWN`);
  console.log(`               per-wallet stake. At a fine split the per-wallet stake is a fraction of the ~$42 field mean,`);
  console.log(`               so the filter never fires and the column collapses onto the always-seat one. Reported anyway.`);
  console.log(`        "rich" seat only on the richest third of fields, by the same public pre-bell information. This is the`);
  console.log(`               filter that actually models "picks its spots", and it is the one to read.`);
  console.log(`      k* IS AN ARGMAX OVER ${K6.length} NOISY CELLS, so it carries a winner's curse: the reported P&L at k* is biased`);
  console.log(`      UP by up to ~1.5 standard errors. The CI beside it is the per-cell CI, not a CI for the maximum.`);
  const h1 = `      mechanic                          k*    house $/rd (95% CI)    -gas(pre)   -gas(post)  house $/day(post) | adv "own" $/day  adv "rich" seat%  $/seated rd   $/day`;
  console.log(h1); console.log(rule(h1.length));
  const best: { m: Mech; k: number; house: number; hse: number; advDay: number; advRichDay: number; houseDayPost: number; real: number; houseFee: number; realFee: number; resid: number }[] = [];
  for (const { m, rows } of results) {
    let bi = 0;
    for (let i = 0; i < rows.length; i++) if (mean(rows[i].house) > mean(rows[bi].house)) bi = i;
    const row = rows[bi];
    const hRd = mean(row.house), hse = sd(row.house) / Math.sqrt(row.house.length);
    const per = P6_BUDGET / row.k;
    const ownSeated = row.house.filter((_, i) => row.bgMean[i] >= per);
    const ownDay = ROUNDS_PER_DAY * (ownSeated.length / row.house.length) * (ownSeated.length ? mean(ownSeated) : 0);
    const cut = [...row.bgMean].sort((a, b) => a - b)[Math.floor(row.bgMean.length * 2 / 3)];
    const richSeated = row.house.filter((_, i) => row.bgMean[i] >= cut);
    const richRate = richSeated.length / row.house.length;
    const richPer = richSeated.length ? mean(richSeated) : 0;
    const richDay = ROUNDS_PER_DAY * richRate * richPer;
    // the conservation identity in DOLLARS, as a residual: house P&L + real P&L + all fees === 0
    let resid = 0;
    for (let i = 0; i < row.house.length; i++) resid = Math.max(resid, Math.abs(row.house[i] + row.real[i] + row.houseFee[i] + row.realFee[i]));
    console.log(`      ${m.label} ${String(row.k).padStart(4)}  ${`${$(hRd, 4)} +-${$(ci95(hse), 4)}`.padStart(21)}  ${$(hRd - GAS_PRE_USD, 4).padStart(10)}  ${$(hRd - GAS_POST_USD, 4).padStart(11)}  ${$(perDay(hRd - GAS_POST_USD), 2).padStart(16)} | ${$(ownDay, 2).padStart(15)}  ${(100 * richRate).toFixed(1).padStart(15)}%  ${$(richPer, 4).padStart(11)}  ${$(richDay, 2).padStart(9)}`);
    best.push({ m, k: row.k, house: hRd, hse, advDay: ownDay, advRichDay: richDay, houseDayPost: perDay(hRd - GAS_POST_USD), real: mean(row.real), houseFee: mean(row.houseFee), realFee: mean(row.realFee), resid });
  }
  console.log(rule(h1.length));

  // ---- (b) the transfer ------------------------------------------------------------------------------
  console.log(`\n  (b) WHERE THE MONEY COMES FROM. THIS IS NOT A REVENUE LINE. The fight conserves value exactly, so`);
  console.log(`          house P&L  +  real players' P&L  +  all fees  =  0`);
  console.log(`      every round. The residual column is that identity measured in dollars and it is floating-point noise`);
  console.log(`      or a bug; there is no third possibility. The house's farm is therefore a TRANSFER OUT OF REAL`);
  console.log(`      PLAYERS' BALANCES, dollar for dollar, plus the fees those players pay on top.`);
  const h2 = `      mechanic                          house $/rd   real players $/rd   real $ out per $1 house farms   real-player fees $/rd   identity residual`;
  console.log(h2); console.log(rule(h2.length));
  for (const b of best)
    console.log(`      ${b.m.label} ${$(b.house, 4).padStart(11)}   ${$(b.real, 4).padStart(17)}   ${(b.house > 1e-9 ? $(-b.real / b.house, 4) : "n/a (house loses)").padStart(30)}   ${$(b.realFee, 4).padStart(21)}   ${b.resid.toExponential(2).padStart(17)}`);
  console.log(rule(h2.length));
  console.log(`      Read the control row first. Under the SHIPPED rule the house's own book earns -fee and nothing else,`);
  console.log(`      so "per $1 farmed" is undefined: there is no farm. Every positive row below it is a mechanic that`);
  console.log(`      created one.`);

  console.log(`\n  (c) THE HOUSE'S CONSOLIDATED POSITION. Fees the house pays on its OWN entries are circular — money moved`);
  console.log(`      from its book to its treasury — so they are netted out and only fees from REAL players are counted.`);
  const h3 = `      mechanic                          farm $/rd   real-player fees $/rd   own fees (circular)   consolidated $/rd   $/day post-gas`;
  console.log(h3); console.log(rule(h3.length));
  for (const b of best) {
    const cons = b.house + b.realFee;
    console.log(`      ${b.m.label} ${$(b.house, 4).padStart(10)}   ${$(b.realFee, 4).padStart(21)}   ${$(b.houseFee, 4).padStart(19)}   ${$(cons, 4).padStart(17)}   ${$(perDay(cons - GAS_POST_USD), 2).padStart(14)}`);
  }
  console.log(rule(h3.length));

  console.log(`\n  (d) THE PLAIN SENTENCE.`);
  console.log(`      SELECTIVITY IS AN OPTION, NOT AN OBLIGATION, and reading it as an obligation would flatter the house.`);
  console.log(`      A private adversary may always-seat exactly as the house does, so its rate is the BEST of its three`);
  console.log(`      choices — always-seat, "own" filter, "rich" filter — and it pays no keeper gas in any of them. The`);
  console.log(`      house's rate is always-seat MINUS gas. The two therefore differ by the gas and by nothing else,`);
  console.log(`      unless a filter beats always-seat, which it does only when the per-seated-round lift more than`);
  console.log(`      offsets the forgone rounds.`);
  const hd = `      mechanic                          house $/day (post-gas)   adversary best $/day   which choice   edge to the house`;
  console.log(hd); console.log(rule(hd.length));
  for (const b of best) {
    const always = perDay(b.house);
    const choices: [string, number][] = [["always-seat", always], ["own filter", b.advDay], ["rich filter", b.advRichDay]];
    const bestChoice = choices.reduce((a, c) => (c[1] > a[1] ? c : a));
    const edge = b.houseDayPost - bestChoice[1];
    console.log(`      ${b.m.label} ${$(b.houseDayPost, 2).padStart(22)}   ${$(bestChoice[1], 2).padStart(20)}   ${bestChoice[0].padStart(12)}   ${(edge > 0 ? `house +${$(edge, 2)}` : `ADVERSARY +${$(-edge, 2)}`).padStart(18)}`);
  }
  console.log(rule(hd.length));
  console.log(`      A pre-reclaim keeper costs ${$(perDay(GAS_PRE_USD), 2)}/day and a post-reclaim one ${$(perDay(GAS_POST_USD), 2)}/day. Those two numbers are the`);
  console.log(`      entire structural difference, and they run AGAINST the operator in every row.`);
  console.log(`\n      The operator's three handicaps are all visible in those two columns: it pays gas the adversary does not,`);
  console.log(`      it cannot skip an unfavourable field, and its wallets are published so a real adversary can also avoid`);
  console.log(`      seating against them. Only the first two are priced here; the third would widen the gap further.`);
  conservationReport("6");
}

// ================================================================================================
// DISPATCH
// ================================================================================================

const t0 = Date.now();
header();
const want = (p: string) => PART === "all" || PART === p;
// PART 0 runs in EVERY process, not only when it is asked for. It is cheap, and it is what licenses
// every caption in the part that follows it — a part run on its own with the self-checks skipped
// would be a table whose meaning had never been verified in that process.
part0();
if (want("1")) part1();
if (want("2")) part2();
if (want("3")) part3();
if (want("4")) part4();
if (want("5")) part5();
if (want("6")) part6();
console.log(`\n${bar(124)}`);
console.log(`DONE. part ${PART}, ${ROUNDS.toLocaleString()} rounds/cell, ${((Date.now() - t0) / 1000).toFixed(0)}s. Conservation asserted on ${CONSERVED.toLocaleString()} fights; zero failures.`);
console.log(bar(124));
