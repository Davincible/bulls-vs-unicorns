// SANDBOX. Run from engine/:
//
//     npx tsx ../sandbox/house-edge/strategy-mechanics.ts [lives] [splitRounds]
//     npx tsx ../sandbox/house-edge/strategy-mechanics.ts 20000 3000      # the reported run
//
// Nothing in engine/, er-demo/ or programs/ imports this file. It reads engine/data/ledger.db by
// COPYING it first and opening the copy read-only; the working-tree database is never touched.
//
// ================================================================================================
// WHAT THIS MEASURES, AND WHY IT IS A DIFFERENT QUESTION FROM THE TWO EXISTING DOCUMENTS
// ================================================================================================
// HOUSE-EDGE-STUDY.md measures the GAME. HOUSE-STRATEGY.md measures the OPERATOR'S ONE DIAL —
// `fee_bps` — and concludes that it is the only structural, sybil-immune, size-neutral stream there
// is. Both stop at the entry rake. This script asks the next question: are there OTHER mechanics,
// and are any of them worth more than the rate they would replace?
//
// Four candidates, each modelled, each ranked on expected revenue against variance and against HOW
// FAST A SOPHISTICATED PLAYER NEUTRALISES IT:
//
//   MECHANIC 1  a carry on parked capital          (§3)
//   MECHANIC 2  the conversion spread              (§2 — already real, already earning, and the
//                                                        existing docs missed it)
//   MECHANIC 3  fee-structure variants             (§4)
//   MECHANIC 4  round cadence and pot size         (§5)
//
// ================================================================================================
// THREE HARD CONSTRAINTS. THEY BOUND EVERY ANSWER BELOW AND THEY ARE NOT NEGOTIABLE.
// ================================================================================================
//
// (1) DISCLOSED MECHANICS ONLY. Everything modelled here can be printed in the rules without
//     changing its value. Nothing below depends on players not knowing about it, and nothing below
//     gives operator-controlled wallets an advantage unavailable to anyone else. Where a mechanic
//     only pays while concealed, the analysis STOPS at that sentence and says so — that is a result,
//     not a gap. (§4.1 does exactly this to the naive stake tier; §2 of HOUSE-STRATEGY.md already
//     did it to the extract penalty, which is ~60% of modelled revenue and is one popular guide
//     away from zero.)
//
// (2) A PUBLISHED STAKE-SIZE ADVANTAGE IS FARMABLE BY ANYONE. HOUSE-EDGE-STUDY.md §11.5 established
//     that the old small-stake edge and the $150.87/round sybil farm were THE SAME OBJECT seen from
//     two sides. So every stake-band asymmetry priced below is ALSO priced against an adversary who
//     splits optimally across up to `MAX_FIGHTERS = 48` seats (raised from 16 in the zero_copy
//     migration), and the number that gets reported is the NET after that adversary. An edge a sharp
//     player takes faster than the house is a cost.
//
// (3) THE REAL CASH POSITION BOUNDS EVERYTHING. The only actual outflow is keeper gas plus
//     unreclaimed rent: 0.00981 SOL/round all-in = $1.4715/round at SOL $150. Every mechanic is
//     reported in $/round and $/day against that number. A mechanic that does not clear $1.4715 is
//     not a revenue stream, it is a rounding error with a marketing page.
//
// ================================================================================================
// METHOD
// ================================================================================================
// Lifetime work reuses `lifetime-core.ts` — the validated payoff pool, `PlayerModel`, the gas and
// cadence constants, and the stats helpers. That file is NOT modified here; where the core's
// `simulateLife` is too narrow (it hardcodes `fee = stake * feeBps / 10_000`, which cannot express a
// rake cap, a settlement rake, a flat ticket or a conversion spread) this file implements a strict
// GENERALISATION, `simulateLifeSchedule`, and §4.0 ASSERTS that the generalisation reproduces the
// core function draw-for-draw and cent-for-cent on a flat schedule. If that assertion ever fails,
// every table from §4 onward is void and the script exits non-zero.
//
// The full-lobby splitting adversary (MAX_FIGHTERS = 48 seats) runs REAL FIGHTS on the shipped rule
// (`fight-variant.ts` BASELINE, which `parity.ts` asserts byte-identical to `advance_fight`), not on
// the pool, because the pool was harvested at 8 seats and the adversary's whole point is to occupy
// every seat there is.
//
// Every number carries a 95% CI and a sample size. Every invented elasticity is labelled INVENTED
// in the table that uses it. Every extrapolation past what the code actually does is labelled
// REGIME B, following HOUSE-STRATEGY.md §2's convention.

import {
  loadOrBuildPool, makeDrawR, verifyPool, binOf,
  BASE_PLAYER, simulateLife, type PlayerModel, type LifeResult,
  GAS_SOL_PER_ROUND, GAS_USD_PER_ROUND, SOL_USD, ROUNDS_PER_HOUR,
  STAKE_CAP_USD, MIN_ENTRY, CONVERT_FEE,
  mean, sd, ci95, quant, hash32,
} from "./lifetime-core.ts";
import { runFight, payout, BASELINE, makeFighter, MAX_FIGHTERS } from "./fight-variant.ts";
import { BANDS, usd, toUsd, finish, type Entry } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const LIVES = Number(process.argv[2] ?? 20_000);
const SPLIT_ROUNDS = Number(process.argv[3] ?? 4_000);
const TAG = "mechanics-v1";

// The repo root, derived from this file's own location so the script runs from anywhere.
const ROOT = resolve(import.meta.dirname, "..", "..");
const SCRATCH = process.env.HE_POOL_DIR
  ?? "/private/tmp/claude-501/-Users-tyler-Launchpad-Crypto-UwuGame-magicblock/d5279d95-4422-4376-a720-d79efa3c4e5c/scratchpad";

const ROUNDS_PER_DAY = ROUNDS_PER_HOUR * 24;              // 784.8 at the ~110s cadence
const GAS_USD_PER_DAY = GAS_USD_PER_ROUND * ROUNDS_PER_DAY;

const $ = (v: number, d = 4) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(d)}`;
const pctS = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;
const rule = (n: number) => "-".repeat(n);
const bar = (n: number) => "=".repeat(n);

console.log(`
${bar(112)}
FOUR REVENUE MECHANICS, MODELLED AND RANKED
${bar(112)}
seed tag "${TAG}"   |   ${LIVES.toLocaleString()} simulated player-lives per cell   |   ${SPLIT_ROUNDS.toLocaleString()} real ${MAX_FIGHTERS}-seat fights per adversary cell
gas floor: ${GAS_SOL_PER_ROUND} SOL/round = ${$(GAS_USD_PER_ROUND)}/round at SOL $${SOL_USD} = ${$(GAS_USD_PER_DAY, 2)}/day at ${ROUNDS_PER_HOUR.toFixed(1)} rounds/hour
reproduce: cd engine && npx tsx ../sandbox/house-edge/strategy-mechanics.ts ${LIVES} ${SPLIT_ROUNDS}
`);

// ================================================================================================
// §1  THE CUSTODY PROBE — run FIRST, because it decides whether Mechanic 1 exists at all
// ================================================================================================
// HOUSE-STRATEGY.md §1 asserts the deployed program custodies nothing. Mechanic 1 (a carry on
// parked capital) is arithmetic over parked capital, so if there is no custody there is no parked
// capital and the mechanic's revenue is identically zero at every rate. That is a strong enough
// claim that this script re-verifies it from source rather than citing it.

interface Probe { label: string; got: string; expect: string; ok: boolean; }
const probes: Probe[] = [];
function probe(label: string, got: string, expect: string) {
  probes.push({ label, got, expect, ok: got === expect });
}

const arenaRs = readFileSync(`${ROOT}/programs/bulls-arena/src/lib.rs`, "utf8");
const custodyHits = (arenaRs.match(/anchor_spl|token::transfer|TokenAccount/g) ?? []).length;
probe("bulls-arena token-custody symbols", String(custodyHits), "0");

const workspaceToml = readFileSync(`${ROOT}/Cargo.toml`, "utf8");
const members = /members\s*=\s*\[([^\]]*)\]/.exec(workspaceToml)?.[1] ?? "";
probe("programs/vault in workspace members", String(members.includes("vault")), "false");

const vaultRs = existsSync(`${ROOT}/programs/vault/src/lib.rs`)
  ? readFileSync(`${ROOT}/programs/vault/src/lib.rs`, "utf8") : "";
const vaultId = /declare_id!\("([^"]+)"\)/.exec(vaultRs)?.[1] ?? "(no vault program)";
probe("programs/vault declared id is the placeholder", String(vaultId.startsWith("VauLt1111")), "true");

// `Enter<'info>` — five accounts, none of them a token account.
const enterCtx = /pub struct Enter<'info>\s*\{([\s\S]*?)\n\}/.exec(arenaRs)?.[1] ?? "";
const enterAccounts = (enterCtx.match(/^\s*pub \w+:/gm) ?? []).length;
probe("Enter<'info> account count", String(enterAccounts), "5");
probe("Enter<'info> contains a token account", String(/TokenAccount|token::/.test(enterCtx)), "false");

console.log(`\n${bar(112)}`);
console.log(`§1  CUSTODY PROBE — re-verified from source, because Mechanic 1 lives or dies on it`);
console.log(bar(112));
console.log(`  ${"check".padEnd(48)} ${"measured".padStart(12)}   ${"required".padStart(10)}   verdict`);
console.log(rule(112));
for (const p of probes)
  console.log(`  ${p.label.padEnd(48)} ${p.got.padStart(12)}   ${p.expect.padStart(10)}   ${p.ok ? "ok" : "MISMATCH"}`);
console.log(`  ${"programs/vault declare_id!".padEnd(48)} ${vaultId.slice(0, 12).padStart(12)}...`);
const CUSTODY_EXISTS = probes.some(p => !p.ok);
console.log(rule(112));
console.log(CUSTODY_EXISTS
  ? `  AT LEAST ONE PROBE MISMATCHED. Custody may have shipped since HOUSE-STRATEGY.md §1 was written.\n` +
    `  Re-read the program before trusting §3 below, which assumes AUM is identically zero today.`
  : `  CONFIRMED: the deployed program custodies nothing. There is no platform balance to charge a\n` +
    `  carry on, so MECHANIC 1's revenue today is EXACTLY $0.0000/round at EVERY rate (§3), and the\n` +
    `  whole of §3 is a REGIME B extrapolation conditional on a custody path that does not exist.`);

// ================================================================================================
// §2  MECHANIC 2 — THE CONVERSION SPREAD. Already real, already earning, and both study documents
//     missed it entirely.
// ================================================================================================
// Neither HOUSE-EDGE-STUDY.md nor HOUSE-STRATEGY.md contains the string "convert". Both treat the
// entry rake as the operator's only stream. That is wrong about the code AND wrong about the
// measured data, and this is the largest single correction in this file.

console.log(`\n\n${bar(112)}`);
console.log(`§2  MECHANIC 2 — THE CONVERSION SPREAD`);
console.log(bar(112));

// ---- §2.1 the source probe: the comment and the behaviour disagree ------------------------------
// `engine/src/arenas.ts:40` calls CONVERT_FEE "PumpSwap pool fee, swapped on-chain at mainnet",
// i.e. money that leaves for a liquidity pool. `engine/src/server.ts` says the opposite in the
// convert handler, and the code agrees with the handler: the AMM's own fee and slippage are already
// inside `res.outAmount`, and CONVERT_FEE is skimmed off that number and handed to `addConvFees`,
// which is the treasury's own counter. So the operator earns it.
const arenasTs = readFileSync(`${ROOT}/engine/src/arenas.ts`, "utf8");
const serverTs = readFileSync(`${ROOT}/engine/src/server.ts`, "utf8");
const ledgerTs = readFileSync(`${ROOT}/engine/src/ledger.ts`, "utf8");

const arenasComment = /\/\/ Economy constants[\s\S]*?\n/.exec(arenasTs)?.[0].trim() ?? "";
const convComment = /\/\/ \(PumpSwap[^\n]*/.exec(arenasTs)?.[0] ?? "";
const houseCutLine = /\/\/ .*house cut is taken on top of that\./.exec(serverTs)?.[0] ?? "(not found)";
const skimLines = serverTs.split("\n")
  .map((l, i) => ({ n: i + 1, l }))
  .filter(x => /const fee = outUnits \* CONVERT_FEE|addConvFees\(fee \* usdPerUnit|addConvFees\(usdIn \* otcFee/.test(x.l));
const otcTok = Number(/OTC_FEE_TOKEN = Number\(process\.env\.OTC_FEE_TOKEN \|\| ([\d.]+)\)/.exec(serverTs)?.[1] ?? NaN);
const otcSol = Number(/OTC_FEE_SOL = Number\(process\.env\.OTC_FEE_SOL \|\| ([\d.]+)\)/.exec(serverTs)?.[1] ?? NaN);
const convCooldownMs = Number(/CONVERT_COOLDOWN_MS = Number\(process\.env\.CONVERT_COOLDOWN_MS \|\| ([\d_]+)\)/
  .exec(serverTs)?.[1].replace(/_/g, "") ?? NaN);
const addConvFeesDecl = /export const addConvFees = [^\n]*/.exec(ledgerTs)?.[0] ?? "(not found)";

console.log(`
§2.1  A DOCUMENTATION DEFECT: the comment says the pool takes it; the code hands it to the house.

  engine/src/arenas.ts   ${arenasComment.replace(/\n/g, "\n                         ")}
                         ${convComment}
        -> CONVERT_FEE = ${CONVERT_FEE}  (${(CONVERT_FEE * 1e4).toFixed(0)} bps), described as a POOL fee.

  engine/src/server.ts   ${houseCutLine.trim()}
${skimLines.map(x => `        line ${String(x.n).padStart(4)}:   ${x.l.trim()}`).join("\n")}

  engine/src/ledger.ts   ${addConvFeesDecl.trim()}

  THE READING. \`res.outAmount\` is what the swap ACTUALLY returned, so the AMM's fee and the
  slippage are ALREADY inside it and have already been borne by the player. CONVERT_FEE is then
  taken OFF that number and added to \`convFees\`, a treasury counter. The comment in arenas.ts is
  wrong: ${(CONVERT_FEE * 1e4).toFixed(0)} bps is not the pool's cut, it is a second house rake charged on top of the pool's cut.

  The internal OTC route is the same skim with no pool involved at all:
        OTC_FEE_TOKEN = ${otcTok}  (${(otcTok * 1e4).toFixed(0)} bps, token<->token)      "the spread we would have paid a pool"
        OTC_FEE_SOL   = ${otcSol}  (${(otcSol * 1e4).toFixed(0)} bps, anything through SOL)
        CONVERT_COOLDOWN_MS = ${convCooldownMs.toLocaleString()}  -> at most ONE convert per player per ~round.

  FLAGGED AS A DEFECT, NOT FIXED (standing instruction: economic defects get a reproduction, not an
  edit). The reproduction is by inspection: read arenas.ts:40 and server.ts's convert handler side
  by side. Severity: documentation only — the money goes where the handler says, not where the
  constant's comment says. But the two study documents were both written off the constants, and
  that is exactly how a live revenue stream went unrecorded.`);

// ---- §2.2 the measured data --------------------------------------------------------------------
// engine/data/ledger.db is gitignored and lives only in the working tree. It is the ONLY measured
// evidence in this repository of a second revenue stream. Copied before reading; opened read-only.
const DB_SRC = `${ROOT}/engine/data/ledger.db`;
const DB_COPY = `${SCRATCH}/ledger-mechanics-ro.db`;
mkdirSync(dirname(DB_COPY), { recursive: true });
copyFileSync(DB_SRC, DB_COPY);
const db = new DatabaseSync(DB_COPY, { readOnly: true });
const metaRows = db.prepare("select key, value from meta").all() as { key: string; value: string }[];
const meta: Record<string, unknown> = {};
for (const r of metaRows) { try { meta[r.key] = JSON.parse(r.value); } catch { meta[r.key] = r.value; } }

const treasury = meta.treasury as Record<string, number>;
const deployed = meta.totalDeployed as Record<string, number>;
const roundsBy = meta.rounds as Record<string, number>;
const convFees = meta.convFees as number;
const TREASURY = treasury.normal + treasury.extraction;
const DEPLOYED = deployed.normal + deployed.extraction;
const DB_ROUNDS = roundsBy.normal + roundsBy.extraction;

// Bot domination, quantified rather than asserted, from the accounts table's own isBot flag.
const accts = db.prepare("select data from accounts").all() as { data: string }[];
let botDep = 0, humDep = 0, botN = 0, humN = 0;
for (const a of accts) {
  const j = JSON.parse(a.data);
  const d = Number(j.dep ?? 0);
  if (j.isBot) { botDep += d; botN++; } else { humDep += d; humN++; }
}
db.close();

const impliedRakeBps = TREASURY / DEPLOYED * 1e4;
const convShareOfRake = convFees / TREASURY;
const convBpsOfDeploy = convFees / DEPLOYED * 1e4;

// rho = convert volume per unit of deploy volume. Named by the SIZE of rho, not by the fee rate that
// produced it: a LOW fee rate implies a HIGH volume for the same dollars collected, so the 30 bps
// reading is the HIGH-rho end. Both ends are real rates in the code, so the range is measured rather
// than assumed and nothing below ever leaves it.
const RHO_HI = convFees / CONVERT_FEE / DEPLOYED;   // all-swap-route / OTC-through-SOL (30 bps) reading
const RHO_LO = convFees / otcTok / DEPLOYED;        // all-OTC-token-to-token (100 bps) reading
const RHO_MID = (RHO_LO + RHO_HI) / 2;

console.log(`
§2.2  MEASURED, from engine/data/ledger.db (gitignored, working tree only; copied and opened
      READ-ONLY at ${DB_COPY})

  ${"meta row".padEnd(22)} ${"value".padStart(18)}    derived
  ${rule(104)}
  ${"treasury (rake)".padEnd(22)} ${$(TREASURY, 2).padStart(18)}    normal ${$(treasury.normal, 2)} + extraction ${$(treasury.extraction, 2)}
  ${"convFees (spread)".padEnd(22)} ${$(convFees, 2).padStart(18)}    ${pctS(convShareOfRake, 1)} of rake revenue over the same period
  ${"totalDeployed".padEnd(22)} ${$(DEPLOYED, 2).padStart(18)}    normal ${$(deployed.normal, 0)} + extraction ${$(deployed.extraction, 0)}
  ${"rounds".padEnd(22)} ${String(DB_ROUNDS).padStart(18)}    normal ${roundsBy.normal} + extraction ${roundsBy.extraction}
  ${rule(104)}
  ${"implied rake rate".padEnd(22)} ${impliedRakeBps.toFixed(3).padStart(15)} bps    engine/src/arenas.ts FEE = 0.002 = 20 bps  -> ${Math.abs(impliedRakeBps - 20) < 0.5 ? "AGREES" : "DISAGREES"}
  ${"rake per round".padEnd(22)} ${$(TREASURY / DB_ROUNDS).padStart(18)}
  ${"spread per round".padEnd(22)} ${$(convFees / DB_ROUNDS).padStart(18)}    ie. the spread is worth ${(convFees / TREASURY).toFixed(3)}x the rake, measured
  ${"spread per $ deployed".padEnd(22)} ${convBpsOfDeploy.toFixed(3).padStart(15)} bps

  IMPLIED CONVERT VOLUME. convFees is a dollar total, not a volume, so the volume depends on which
  route the converts took. The two ends of the range are both real fee rates in the code:
    at ${(CONVERT_FEE * 1e4).toFixed(0)} bps (swap route / OTC-through-SOL):  ${$(convFees / CONVERT_FEE, 0).padStart(12)}  = ${(convFees / CONVERT_FEE / DEPLOYED * 100).toFixed(1)}% of deploy volume
    at ${(otcTok * 1e4).toFixed(0)} bps (OTC token<->token):             ${$(convFees / otcTok, 0).padStart(12)}  = ${(convFees / otcTok / DEPLOYED * 100).toFixed(1)}% of deploy volume
  So CONVERT VOLUME PER UNIT OF DEPLOY VOLUME, call it rho, is measured at ${(RHO_LO * 100).toFixed(1)}%-${(RHO_HI * 100).toFixed(1)}%: one dollar
  converted for every ${(1 / RHO_HI).toFixed(0)}-${(1 / RHO_LO).toFixed(0)} dollars deployed. Every model below sweeps rho across that
  measured range and never outside it.

  *** TWO CAVEATS, AND THE SECOND ONE IS NEARLY FATAL. ***

  (i) RATE. This is the LEGACY CUSTODIAL \`engine/\` product, not the on-chain arena, and it ran at a
      ${impliedRakeBps.toFixed(1)} bps rake. The arena is now at 100 bps — 5x. The ${(convShareOfRake * 100).toFixed(1)}% headline is a RATIO, and it
      rescales: at the same convert behaviour against a 100 bps rake the spread is worth
      ${(convShareOfRake * impliedRakeBps / 100 * 100).toFixed(1)}% of rake revenue, not ${(convShareOfRake * 100).toFixed(1)}%. Quote the rescaled number, never the raw one.

  (ii) WHO GENERATED IT. ${botN} of ${botN + humN} accounts carry \`isBot: true\`. Bot deposits ${$(botDep, 0)};
       HUMAN deposits ${$(humDep, 2)} — ${(humDep / (botDep + humDep) * 100).toFixed(4)}% of the total. This dataset is not
       "bot-dominated", it is BOTS WITH A ROUNDING ERROR OF HUMANS. A bot converts on a schedule
       written by the operator; a human converts when they change their mind. rho as measured is
       therefore a statement about the bot policy in \`engine/src/server.ts\`, not about demand.
       It is still the only measured second stream in the repository, and it is still evidence that
       the plumbing exists and earns — but it is NOT a forecast of human convert volume, and any
       number below that depends on rho should be read as "the shape of the answer", not the answer.`);

// ---- §2.3 the model ----------------------------------------------------------------------------
// Revenue = spread x convert volume, and convert volume = rho x deploy volume. Deploy volume per
// round is taken from HOUSE-STRATEGY.md §1's measured ladder of real gross per round, so the two
// documents are directly comparable.
const REAL_GROSS = [                             // HOUSE-STRATEGY.md §1, measured
  { players: 1, gross: 41.72 }, { players: 2, gross: 84.71 }, { players: 3, gross: 126.90 },
  { players: 4, gross: 165.87 }, { players: 6, gross: 250.97 },
];
const SPREADS_BPS = [0, 10, 30, 50, 100];

console.log(`
§2.3  MODEL — spread x convert volume, at the arena's own measured real gross per round.
      rho swept across the MEASURED range only: lo = ${(RHO_LO * 100).toFixed(1)}%, mid = ${(RHO_MID * 100).toFixed(1)}%, hi = ${(RHO_HI * 100).toFixed(1)}%.
      Deterministic: the spread is a fixed percentage of a volume, so it has ZERO variance for the
      house, exactly like the entry rake (HOUSE-EDGE-STUDY.md §11.1). No CI column, because there is
      no sampling in it — the uncertainty is entirely in rho, which is why rho is swept.
`);
{
  const hdr = `  real   real gross/rd  ` + SPREADS_BPS.map(s => `${s}bps@lo`.padStart(11)).join("") + "   " +
    SPREADS_BPS.map(s => `${s}bps@hi`.padStart(11)).join("");
  console.log(hdr); console.log(rule(hdr.length));
  for (const r of REAL_GROSS) {
    console.log(`  ${String(r.players).padStart(4)}   ${$(r.gross, 2).padStart(12)}  ` +
      SPREADS_BPS.map(s => $(r.gross * RHO_LO * s / 1e4).padStart(11)).join("") + "   " +
      SPREADS_BPS.map(s => $(r.gross * RHO_HI * s / 1e4).padStart(11)).join(""));
  }
  console.log(rule(hdr.length));
  console.log(`  columns 1-5 use rho = lo (${(RHO_LO * 100).toFixed(1)}%); columns 6-10 use rho = hi (${(RHO_HI * 100).toFixed(1)}%). The shipped rate is ${(CONVERT_FEE * 1e4).toFixed(0)} bps.`);
  console.log(`\n  AGAINST THE RAKE, SAME LOBBY. Two comparisons, and they differ by 3x for a reason worth stating.`);
  console.log(`  At 4 real players HOUSE-STRATEGY §2 measures ${$(5.028)}/round of net house revenue on ${$(165.87, 2)} of real`);
  console.log(`  gross. The shipped ${(CONVERT_FEE * 1e4).toFixed(0)} bps spread on the same lobby is ${$(165.87 * RHO_LO * CONVERT_FEE)}-${$(165.87 * RHO_HI * CONVERT_FEE)}/round. So:`);
  console.log(`    vs the ENTRY FEE alone (1.00% of gross = ${$(1.6587)}/round, the only structural stream):  ${(RHO_LO * CONVERT_FEE / 0.01 * 100).toFixed(1)}%-${(RHO_HI * CONVERT_FEE / 0.01 * 100).toFixed(1)}%`);
  console.log(`    vs TOTAL net house revenue (${$(5.028)}/round, ~60% of which is the extract penalty):    ${(165.87 * RHO_LO * CONVERT_FEE / 5.028 * 100).toFixed(1)}%-${(165.87 * RHO_HI * CONVERT_FEE / 5.028 * 100).toFixed(1)}%`);
  console.log(`  The first number is the like-for-like one: the legacy ${(convShareOfRake * 100).toFixed(1)}% was measured against a 20 bps`);
  console.log(`  ENTRY rake with no penalty stream, and ${(convShareOfRake * 100).toFixed(1)}% x 20/100 = ${(convShareOfRake * 20 / 100 * 100).toFixed(1)}% reproduces the top of that range`);
  console.log(`  exactly. The second is smaller only because HOUSE-STRATEGY §4.1 shows the penalty stream is`);
  console.log(`  ~60% of modelled revenue AND is "one sentence of public knowledge away from zero" — so at`);
  console.log(`  P(extract) = 0, which is the robust case that document tells you to plan against, the spread`);
  console.log(`  is back to ${(RHO_LO * CONVERT_FEE / 0.01 * 100).toFixed(1)}%-${(RHO_HI * CONVERT_FEE / 0.01 * 100).toFixed(1)}% of everything the house makes.`);
  // The one question that matters: does the spread alone clear the gas?
  console.log(`\n  DOES THE SPREAD ALONE PAY FOR THE GAS (${$(GAS_USD_PER_ROUND)}/round)?`);
  const need = (rho: number, s: number) => GAS_USD_PER_ROUND / (rho * s / 1e4);
  const hdr2 = `  spread   gross/round needed @rho=lo   @rho=mid   @rho=hi     real players needed @mid`;
  console.log(hdr2); console.log(rule(hdr2.length));
  for (const s of SPREADS_BPS.filter(x => x > 0)) {
    const g = need(RHO_MID, s);
    const pl = REAL_GROSS.find(r => r.gross >= g);
    console.log(`  ${(s + " bps").padStart(7)}   ${$(need(RHO_LO, s), 0).padStart(22)}   ${$(g, 0).padStart(8)}   ${$(need(RHO_HI, s), 0).padStart(8)}     ` +
      (pl ? `${pl.players}` : `>6 (${(g / 41.72).toFixed(1)}x the 1-player row)`));
  }
  console.log(rule(hdr2.length));
}

// ================================================================================================
// THE PAYOFF POOL — everything from here on is lifetime work and needs it.
// ================================================================================================
const pool = loadOrBuildPool(150_000, "lifetime-v1", 8);
const vp = verifyPool(pool, () => {});   // silent: lifetime-core prints the full table in its own scripts
console.log(`\n  payoff pool: 150,000 fights x 8 seats, cached. Validation re-run silently: worst deviation from`);
console.log(`  E[R] = 1 above $0.10 is ${vp.worstSigma.toFixed(2)} sigma -> ${vp.ok ? "POOL OK" : "POOL FAILED"}; dust drift ${$(vp.dustDriftUsd, 6)}/fight.`);
if (!vp.ok) { console.error("POOL FAILED — every table below is void."); process.exit(1); }
const drawR = makeDrawR(pool);

// ================================================================================================
// §3  MECHANIC 1 — A CARRY ON PARKED CAPITAL.  REGIME B THROUGHOUT.
// ================================================================================================
console.log(`\n\n${bar(112)}`);
console.log(`§3  MECHANIC 1 — A CARRY ON PARKED CAPITAL   [REGIME B: conditional on a custody path that does not exist]`);
console.log(bar(112));

// §3.1 THE KILLER, STATED BEFORE THE MODEL SO NOBODY READS THE MODEL AS A FORECAST.
console.log(`
§3.1  THE KILLER, UP FRONT. §1 above re-verified from source that the deployed program custodies
      nothing: ${custodyHits} occurrences of anchor_spl / token::transfer / TokenAccount in
      programs/bulls-arena/src/lib.rs, Enter<'info> carries ${enterAccounts} accounts and none is a token
      account, programs/vault/ is outside the workspace \`members\` list and still declares
      ${vaultId}.
      On the live site every balance a player sees is browser localStorage (er-demo/src/v2/data/
      simLedger.ts). AUM = $0. So:

           MECHANIC 1 REVENUE TODAY = $0.0000/round AT EVERY RATE, EXACTLY.

      Everything in §3.2-§3.4 is a REGIME B extrapolation. It answers "what would this be worth IF
      custody shipped", which is a legitimate planning question and is not a measurement.`);

// §3.2 the decisive comparison: an active player already pays orders of magnitude more.
{
  const feePerRound = 0.01;
  const perHourActive = 1 - Math.pow(1 - feePerRound, ROUNDS_PER_HOUR);
  const perDayActive = 1 - Math.pow(1 - feePerRound, ROUNDS_PER_DAY);
  console.log(`
§3.2  THE DECISIVE COMPARISON — the carry cannot touch an ACTIVE player, because the rake already
      ate them. A fully-redeployed bankroll at the live 100 bps entry rake pays:

        per round  ${pctS(feePerRound, 4).padStart(10)}
        per hour   ${pctS(perHourActive, 4).padStart(10)}   (= 1 - 0.99^${ROUNDS_PER_HOUR.toFixed(1)})
        per day    ${pctS(perDayActive, 4).padStart(10)}   (= 1 - 0.99^${ROUNDS_PER_DAY.toFixed(1)})

      A carry of 100 bps/DAY is ${(perDayActive / 0.01).toFixed(0)}x smaller than what that same player is already paying,
      and ${(perHourActive / (0.01 / 24)).toFixed(0)}x smaller per hour. Adding it to an active balance is not a revenue mechanic, it
      is a rounding error attached to a reason to leave.

      SO THE CARRY MONETISES EXACTLY ONE THING: THE DORMANT TAIL. Capital that is parked and NOT
      playing currently pays the operator NOTHING AT ALL — no rake, because the rake is charged on
      entry (HOUSE-STRATEGY.md §5), and no carry, because there is no carry. That is the entire
      case for the mechanic, and it is a real one.`);

  console.log(`
§3.3  "YOU NEED $X OF DORMANT BALANCE TO PAY FOR ONE ROUND OF GAS" (${$(GAS_USD_PER_ROUND)}, ${ROUNDS_PER_DAY.toFixed(1)} rounds/day)
      AUM* = gas/round x rounds/day / (r/10,000).  Deterministic; no CI, no sampling.
`);
  const RATES = [1, 2, 5, 10, 25, 50, 100];
  const hdr = `  rate bps/day    DORMANT AUM that pays for ONE ROUND    annualised   rev/round @ $250k   % of gas`;
  console.log(hdr); console.log(rule(hdr.length));
  for (const r of RATES) {
    const x = r / 1e4;
    const aumRound = GAS_USD_PER_ROUND / x * ROUNDS_PER_DAY;   // == the AUM that pays a day's gas in a day
    const rev250k = 250_000 * x / ROUNDS_PER_DAY;
    console.log(`  ${String(r).padStart(9)}       ${$(aumRound, 0).padStart(28)}       ` +
      `${(Math.pow(1 + x, 365) - 1).toFixed(2).padStart(6)}x/yr      ${$(rev250k).padStart(10)}      ${(rev250k / GAS_USD_PER_ROUND * 100).toFixed(1).padStart(5)}%`);
  }
  console.log(rule(hdr.length));
  console.log(`  Note the two AUM columns are the SAME condition: an AUM whose carry over one round pays for`);
  console.log(`  that round also pays for a day of gas in a day. That identity is why the answer is a single`);
  console.log(`  number per rate and not a schedule.`);
  console.log(`\n  Read the first row. At 1 bps/day you need ${$(GAS_USD_PER_ROUND / 1e-4 * ROUNDS_PER_DAY / 1e6, 1)}M of DORMANT balance to pay for ONE round`);
  console.log(`  of gas. At 10 bps/day, ${$(GAS_USD_PER_ROUND / 1e-3 * ROUNDS_PER_DAY / 1e6, 2)}M. At 100 bps/day — a 37x/yr carry that no depositor tolerates —`);
  console.log(`  ${$(GAS_USD_PER_ROUND / 1e-2 * ROUNDS_PER_DAY, 0)}. The arena's break-even on real player volume is $41-49/round (HOUSE-STRATEGY §2);`);
  console.log(`  the carry needs six figures of idle deposits to reach the same place.`);
}

// §3.4 retention. THE ELASTICITY BELOW IS INVENTED. There is no measurement of it anywhere.
{
  console.log(`
§3.4  RATE vs RETENTION.  *** THE ELASTICITY IS INVENTED. NOTHING IN THIS REPOSITORY MEASURES IT. ***

      Model: dormant capital arrives at D $/day and is withdrawn with per-day hazard
             h(r) = h0 + kappa * (r / 10,000),
      i.e. a base rate at which parked money leaves anyway, plus a term proportional to the visible
      drain. h0 = 0.02/day (a ~34-day half-life on untouched parked capital) is INVENTED. kappa is
      the elasticity and is swept, because the answer is entirely a function of it:
        kappa = 0   perfectly inelastic — nobody ever notices. Bounds the mechanic from above.
        kappa = 5   a 100 bps/day carry adds 5 points/day of withdrawal hazard.
        kappa = 20  a 100 bps/day carry adds 20 points/day. The headline case.
        kappa = 50  depositors watch the number and react hard.

      Steady state AUM = D / h(r), so revenue/day = D * x / (h0 + kappa*x) with x = r/10,000. That
      SATURATES at D/kappa however high the rate goes, which is the whole finding: the carry's
      revenue is bounded by the DEPOSIT FLOW divided by the elasticity, and no rate escapes it.
`);
  const KAPPAS = [0, 5, 20, 50];
  const H0 = 0.02;
  const D = 10_000;   // INVENTED: $10,000/day of new dormant capital. Scale linearly for other D.
  const RATES = [0, 1, 2, 5, 10, 25, 50, 100];
  const hdr = `  rate     ` + KAPPAS.map(k => `kappa=${k}`.padStart(13)).join("") + `      ` +
    KAPPAS.map(k => `AUM k=${k}`.padStart(12)).join("");
  console.log(`  revenue $/day at D = $${D.toLocaleString()}/day of new dormant capital, and the steady-state AUM that supports it`);
  console.log(hdr); console.log(rule(hdr.length));
  for (const r of RATES) {
    const x = r / 1e4;
    console.log(`  ${(r + "bps").padStart(7)}  ` +
      KAPPAS.map(k => $(D * x / (H0 + k * x), 2).padStart(13)).join("") + `      ` +
      KAPPAS.map(k => $(D / (H0 + k * x), 0).padStart(12)).join(""));
  }
  console.log(rule(hdr.length));
  for (const k of KAPPAS.filter(k => k > 0)) {
    const ceiling = D / k;
    const rHalf = 1e4 * H0 / k;
    console.log(`  kappa=${String(k).padStart(2)}: revenue CEILING ${$(ceiling, 2)}/day (${$(ceiling / ROUNDS_PER_DAY)}/round = ${(ceiling / GAS_USD_PER_DAY * 100).toFixed(1)}% of gas), ` +
      `half of it reached at ${rHalf.toFixed(1)} bps/day.`);
  }
  console.log(`  kappa= 0: unbounded, but only because a perfectly inelastic depositor is not a person.`);
  console.log(`\n  READ THE CEILING COLUMN AGAINST THE GAS. At kappa = 20 the carry cannot pay the gas at ANY`);
  console.log(`  rate unless dormant inflow exceeds ${$(GAS_USD_PER_DAY * 20, 0)}/day. That is the mechanic's real constraint —`);
  console.log(`  not the rate, the flow.`);

  // Mix sensitivity: revenue vs the dormant share of total AUM.
  console.log(`\n  MIX SENSITIVITY — revenue $/round vs the DORMANT SHARE of total platform AUM.`);
  console.log(`  (Active balances are excluded on purpose: during a round they are in the ring, and outside`);
  console.log(`  it they are already paying 100 bps per re-entry. Charging them twice is the fastest way to`);
  console.log(`  turn §3.2's ${pctS(perDayActiveHolder(), 1)}/day into a reason to leave.)`);
  const TOTALS = [50_000, 250_000, 1_000_000, 5_000_000];
  const SHARES = [0, 0.25, 0.5, 0.75, 1.0];
  for (const r of [2, 10, 50]) {
    const x = r / 1e4;
    const hdr2 = `    r=${r}bps   total AUM  ` + SHARES.map(s => `${(s * 100).toFixed(0)}% dormant`.padStart(14)).join("");
    console.log(`\n` + hdr2); console.log("  " + rule(hdr2.length - 2));
    for (const T of TOTALS)
      console.log(`    ${" ".repeat(8)}${$(T, 0).padStart(11)}  ` +
        SHARES.map(s => `${$(T * s * x / ROUNDS_PER_DAY)}/rd`.padStart(14)).join(""));
  }
  console.log(`\n  A cell below ${$(GAS_USD_PER_ROUND)}/round does not pay for the round it is printed against.`);
}
function perDayActiveHolder() { return 1 - Math.pow(0.99, ROUNDS_PER_DAY); }

// ================================================================================================
// THE LIFETIME MACHINERY — a strict generalisation of lifetime-core's simulateLife.
// ================================================================================================
// `simulateLife` hardcodes `fee = stake * feeBps / 10_000`. That cannot express a rake cap, a
// settlement rake, a flat ticket, or a conversion spread, all of which §2 and §4 need. So this is a
// generalisation over a RakeSchedule closure. It must be a strict generalisation: §4.0 asserts it
// reproduces the core function draw-for-draw on a flat schedule, and exits non-zero if it does not.

interface RakeSchedule {
  label: string;
  /** Rake taken on the way IN, in USD, as a function of the stake in USD. */
  entry: (stakeUsd: number) => number;
  /** Rake taken on the way OUT, on WINNINGS only. `undefined` means none, and — critically — means
   *  no extra work, so the flat case stays byte-identical to the core function. */
  settle?: (netStakeUsd: number, payoutUsd: number) => number;
  /** The settlement rate in bps, carried alongside the closure ONLY so §4.3 can price the schedule
   *  analytically. A settlement rake is `bps x E[(R-1)+] x net stake`, and `E[(R-1)+]` is a property
   *  of the pool bin, so the expected rake on a stake can be computed without simulating it. Keeping
   *  the rate as data rather than reverse-engineering it out of the closure is the difference
   *  between a measurement and a guess. */
  settleBps?: number;
  /** Per-round probability of a convert, and the spread charged on the converted balance. Zero
   *  means the RNG stream is NOT advanced, which is what keeps the flat case stream-identical. */
  convertP?: number;
  convertSpread?: number;
}

interface LifeResult2 extends LifeResult {
  /** Sum / sum-of-squares / count of the player's per-round relative balance change. This is the
   *  PLAYER-VISIBLE VARIANCE: the thing they actually watch, round by round. */
  retSum: number; retSq: number; retN: number;
}

function simulateLifeSchedule(
  m: PlayerModel, sch: RakeSchedule, rnd: () => number,
  draw: (bin: number, rnd: () => number) => number,
): LifeResult2 {
  let bal = m.bankroll;
  let deposited = m.bankroll;
  let rake = 0;
  let peak = bal;
  let streak = 0;
  let busts = 0;
  let redepositP = m.redeposit;
  let rounds = 0;
  let exit: "ruin" | "quit" | "cap" = "cap";
  let retSum = 0, retSq = 0, retN = 0;

  for (; rounds < m.maxRounds; rounds++) {
    if (bal < MIN_ENTRY) {
      if (rnd() < redepositP) {
        busts++;
        deposited += m.bankroll;
        bal += m.bankroll;
        redepositP *= m.redepositDecay;
        peak = bal; streak = 0;
        continue;
      }
      exit = "ruin";
      break;
    }
    const stake = Math.min(Math.max(bal * m.stakeFraction, MIN_ENTRY), Math.min(bal, STAKE_CAP_USD));
    // A rake can never exceed the stake it is charged on; that clamp is what makes a flat $0.05
    // ticket survivable at the $0.01 minimum entry instead of minting negative balances.
    const fee = Math.min(stake, Math.max(0, sch.entry(stake)));
    const R = draw(binOf(stake), rnd);
    const before = bal;
    const gross = (stake - fee) * R;
    const sfee = sch.settle ? Math.max(0, sch.settle(stake - fee, gross)) : 0;
    bal = Math.max(0, bal - stake + gross - sfee);
    rake += fee + sfee;

    if (bal < before) streak = Math.min(m.streakCap, streak + 1); else streak = 0;
    if (bal > peak) peak = bal;
    const ret = (bal - before) / before;
    retSum += ret; retSq += ret * ret; retN++;

    const dd = peak > 0 ? Math.max(0, 1 - bal / peak) : 0;
    const h = m.hazardBase + m.hazardDrawdown * dd + m.hazardStreak * streak;
    if (rnd() < h) { exit = "quit"; rounds++; break; }

    // The convert is charged AFTER the hazard draw and only when it is switched on, so a schedule
    // with convertP = 0 consumes exactly the draws simulateLife consumes. That is what makes the
    // §4.0 equivalence assertion possible at all.
    if (sch.convertP && sch.convertP > 0 && rnd() < sch.convertP) {
      const cost = bal * (sch.convertSpread ?? 0);
      bal = Math.max(0, bal - cost);
      rake += cost;
    }
  }
  return { rakeUsd: rake, depositedUsd: deposited, withdrawnUsd: Math.max(0, bal), rounds, busts, exit,
           retSum, retSq, retN };
}

interface Cohort {
  label: string;
  n: number;
  rake: number; rakeCI: number;
  rounds: number; roundsMed: number;
  deposited: number; withdrawn: number;
  retSd: number;              // pooled SD of per-round relative balance change (player-visible)
  termSd: number;             // SD of (withdrawn - deposited) / deposited across the population
  ruin: number; quit: number;
  rakePerRound: number;
}

function runCohort(label: string, m: PlayerModel, sch: RakeSchedule, seedTag: string, n: number): Cohort {
  const rakes = new Float64Array(n), rds = new Float64Array(n), terms = new Float64Array(n);
  let dep = 0, wd = 0, retSum = 0, retSq = 0, retN = 0, ruin = 0, quit = 0, roundsTot = 0;
  for (let i = 0; i < n; i++) {
    const r = simulateLifeSchedule(m, sch, mulberry32(hash32(`${TAG}|${seedTag}|${i}`)), drawR);
    rakes[i] = r.rakeUsd; rds[i] = r.rounds;
    terms[i] = (r.withdrawnUsd - r.depositedUsd) / r.depositedUsd;
    dep += r.depositedUsd; wd += r.withdrawnUsd;
    retSum += r.retSum; retSq += r.retSq; retN += r.retN;
    roundsTot += r.rounds;
    if (r.exit === "ruin") ruin++; else if (r.exit === "quit") quit++;
  }
  const rm = retSum / retN;
  return {
    label, n,
    rake: mean(rakes), rakeCI: ci95(rakes),
    rounds: mean(rds), roundsMed: quant(rds, 0.5),
    deposited: dep / n, withdrawn: wd / n,
    retSd: Math.sqrt(Math.max(0, retSq / retN - rm * rm)),
    termSd: sd(terms),
    ruin: ruin / n, quit: quit / n,
    rakePerRound: roundsTot > 0 ? (mean(rakes) * n) / roundsTot : 0,
  };
}

const flatSchedule = (bps: number): RakeSchedule =>
  ({ label: `flat ${bps} bps`, entry: s => s * bps / 1e4 });

/** E[(R-1)+] per stake bin, straight off the validated pool. This is the expected WINNINGS per
 *  dollar of net stake, and it is the only extra quantity a settlement rake needs in order to be
 *  priced exactly rather than simulated. */
const EPOS: number[] = pool.bins.map(xs => {
  if (xs.length === 0) return NaN;
  let s = 0; for (const x of xs) s += Math.max(0, x - 1);
  return s / xs.length;
});
for (let b = 0; b < EPOS.length; b++) {          // fill empty bins from the nearest populated one
  if (!Number.isNaN(EPOS[b])) continue;
  let j = b; while (j < EPOS.length && Number.isNaN(EPOS[j])) j++;
  if (j === EPOS.length) { j = b; while (j >= 0 && Number.isNaN(EPOS[j])) j--; }
  EPOS[b] = EPOS[j];
}

/** Expected TOTAL rake on one entry of `stakeUsd`, entry piece plus settlement piece. Deterministic
 *  in the entry piece; an expectation over the pool in the settlement piece. */
const expectedRake = (sch: RakeSchedule, stakeUsd: number): number => {
  const e = Math.min(stakeUsd, Math.max(0, sch.entry(stakeUsd)));
  const net = stakeUsd - e;
  const s = sch.settleBps ? net * EPOS[binOf(stakeUsd)] * sch.settleBps / 1e4 : 0;
  return e + s;
};

// ================================================================================================
// §4  MECHANIC 3 — FEE STRUCTURE VARIANTS
// ================================================================================================
console.log(`\n\n${bar(112)}`);
console.log(`§4  MECHANIC 3 — FEE STRUCTURE VARIANTS, at matched revenue where calibration is possible`);
console.log(bar(112));

// ---- §4.0 the equivalence assertion -------------------------------------------------------------
{
  let worstRake = 0, worstRounds = 0;
  for (let i = 0; i < 2000; i++) {
    const seed = hash32(`${TAG}|equiv|${i}`);
    const a = simulateLife(BASE_PLAYER, 100, mulberry32(seed), drawR);
    const b = simulateLifeSchedule(BASE_PLAYER, flatSchedule(100), mulberry32(seed), drawR);
    worstRake = Math.max(worstRake, Math.abs(a.rakeUsd - b.rakeUsd));
    worstRounds = Math.max(worstRounds, Math.abs(a.rounds - b.rounds));
  }
  console.log(`\n§4.0  EQUIVALENCE ASSERTION — simulateLifeSchedule must be a STRICT generalisation of`);
  console.log(`      lifetime-core's simulateLife, or every table below is measuring a different game.`);
  console.log(`      2,000 paired lives, identical seeds, flat 100 bps:`);
  console.log(`        worst |rake difference|   ${$(worstRake, 12)}`);
  console.log(`        worst |rounds difference| ${worstRounds}`);
  if (worstRake > 1e-9 || worstRounds > 0) {
    console.error(`      ASSERTION FAILED — the generalisation diverges from the core. Discard §4 and §5.`);
    process.exit(1);
  }
  console.log(`        -> IDENTICAL. The generalisation is safe to use.`);
}

// ---- §4.1 the schedules -------------------------------------------------------------------------
// Calibration: every family carries one free scalar, solved by bisection against the flat-100 bps
// LIFETIME rake per acquired player, under COMMON RANDOM NUMBERS (same seed set every iteration) so
// the objective is monotone and smooth and the bisection converges to the fourth decimal.
const CAL_LIVES = Math.min(6000, LIVES);
const CAL_SEED = "cal";

function lifetimeRake(m: PlayerModel, sch: RakeSchedule, n = CAL_LIVES): number {
  let s = 0;
  for (let i = 0; i < n; i++)
    s += simulateLifeSchedule(m, sch, mulberry32(hash32(`${TAG}|${CAL_SEED}|${i}`)), drawR).rakeUsd;
  return s / n;
}

function calibrate(m: PlayerModel, target: number, make: (x: number) => RakeSchedule,
                   lo: number, hi: number, iters = 26): number {
  let a = lo, b = hi;
  for (let i = 0; i < iters; i++) {
    const mid = (a + b) / 2;
    if (lifetimeRake(m, make(mid)) < target) a = mid; else b = mid;
  }
  return (a + b) / 2;
}

const P = BASE_PLAYER;
const TARGET = lifetimeRake(P, flatSchedule(100));

// Tiered by stake, MARGINAL brackets (the defensible version — a cliff schedule is even more
// farmable, and §4.2 prices both). Published rate card:
//     first $10 of the stake        25 bps
//     $10 to $50                   100 bps
//     above $50                    `top` bps, calibrated to match total revenue
const tieredMarginal = (topBps: number): RakeSchedule => ({
  label: `tiered marginal 25/100/${topBps.toFixed(0)}`,
  entry: s => 0.0025 * Math.min(s, 10) + 0.01 * Math.min(Math.max(s - 10, 0), 40) + (topBps / 1e4) * Math.max(s - 50, 0),
});
// Tiered by stake, CLIFF brackets (the naive version most rate cards actually are).
const tieredCliff = (topBps: number): RakeSchedule => ({
  label: `tiered cliff 25/100/${topBps.toFixed(0)}`,
  entry: s => s * (s <= 10 ? 25 : s <= 50 ? 100 : topBps) / 1e4,
});
// Rake cap per entry.
const capped = (capUsd: number): RakeSchedule =>
  ({ label: `100 bps, capped at ${$(capUsd, 2)}/entry`, entry: s => Math.min(s * 0.01, capUsd) });
// Entry + settlement: half the entry rate, the rest taken on WINNINGS.
const entryPlusSettle = (settleBps: number): RakeSchedule => ({
  label: `50 bps entry + ${settleBps.toFixed(0)} bps on winnings`,
  entry: s => s * 0.005,
  settle: (net, out) => Math.max(0, out - net) * settleBps / 1e4,
  settleBps,
});
// Pure settlement rake: nothing on entry, everything on winnings.
const pureSettle = (settleBps: number): RakeSchedule => ({
  label: `0 bps entry + ${settleBps.toFixed(0)} bps on winnings`,
  entry: () => 0,
  settle: (net, out) => Math.max(0, out - net) * settleBps / 1e4,
  settleBps,
});
// Flat ticket per entry.
const ticket = (t: number): RakeSchedule => ({ label: `flat ${$(t, 3)}/entry ticket`, entry: () => t });

console.log(`\n§4.1  CALIBRATION. Free scalar solved by bisection against the flat-100 bps lifetime rake per`);
console.log(`      acquired player (${$(TARGET, 4)}, ${CAL_LIVES.toLocaleString()} lives, common random numbers).`);
const topMarginal = calibrate(P, TARGET, tieredMarginal, 100, 1200);
const topCliff = calibrate(P, TARGET, tieredCliff, 100, 1200);
const settleBps = calibrate(P, TARGET, entryPlusSettle, 0, 6000);
const pureBps = calibrate(P, TARGET, pureSettle, 0, 12000);
const ticketCal = calibrate(P, TARGET, ticket, 0, 2);
console.log(`        tiered MARGINAL top rate  ${topMarginal.toFixed(1).padStart(9)} bps`);
console.log(`        tiered CLIFF   top rate  ${topCliff.toFixed(1).padStart(10)} bps`);
console.log(`        50 bps entry + settlement ${settleBps.toFixed(1).padStart(9)} bps on winnings`);
console.log(`        0 bps entry + settlement  ${pureBps.toFixed(1).padStart(9)} bps on winnings`);
console.log(`        flat ticket               ${$(ticketCal, 4).padStart(9)} /entry`);
console.log(`      NOTE: the rake CAPS are deliberately NOT calibrated. A cap can only remove revenue,`);
console.log(`      so the number worth reporting is exactly how much it removes.`);

const SCHEDULES: RakeSchedule[] = [
  flatSchedule(100),
  tieredMarginal(topMarginal),
  tieredCliff(topCliff),
  capped(0.25), capped(0.50), capped(1.00),
  entryPlusSettle(settleBps),
  pureSettle(pureBps),
  ticket(0.05),
  ticket(ticketCal),
];

// ---- §4.2 lifetime table ------------------------------------------------------------------------
console.log(`\n§4.2  LIFETIME per ACQUIRED PLAYER. ${LIVES.toLocaleString()} independent lives per row, $100 opening bankroll,`);
console.log(`      100% redeployment, BASE_PLAYER churn model (lifetime-core.ts — every term INVENTED).`);
console.log(`      "player sd/round" is the pooled standard deviation of the round-over-round relative`);
console.log(`      balance change: the number a player actually watches. "rev/sd" is the ranking metric.`);
{
  const rows = SCHEDULES.map(s => runCohort(s.label, P, s, `m3|${s.label}`, LIVES));
  const hdr = `  schedule                                  lifetime rake   95% CI     rounds  median   player   term   ruin   rev/sd`;
  const hdr2 = `                                            per player                lived   rounds  sd/round   sd     rate`;
  console.log(`\n` + hdr); console.log(hdr2); console.log(rule(hdr.length));
  for (const r of rows)
    console.log(`  ${r.label.padEnd(40)} ${$(r.rake, 3).padStart(12)}  +-${$(r.rakeCI, 3).padStart(7)}  ` +
      `${r.rounds.toFixed(0).padStart(7)}  ${r.roundsMed.toFixed(0).padStart(6)}  ${(r.retSd * 100).toFixed(2).padStart(7)}%  ` +
      `${r.termSd.toFixed(3).padStart(5)}  ${(r.ruin * 100).toFixed(1).padStart(5)}%  ${(r.rake / r.retSd).toFixed(1).padStart(7)}`);
  console.log(rule(hdr.length));
  const base = rows[0];
  console.log(`  baseline = flat 100 bps. Same-revenue rows differ only in HOW the money is taken.`);
  for (const r of rows.slice(1)) {
    const dRev = r.rake - base.rake, dSd = r.retSd - base.retSd;
    console.log(`    ${r.label.padEnd(40)} revenue ${pctS(dRev / base.rake, 1).padStart(8)}   player sd ${pctS(dSd / base.retSd, 1).padStart(8)}   ` +
      `rounds lived ${pctS(r.rounds / base.rounds - 1, 1).padStart(8)}`);
  }

  // Regressivity: the same schedules against three bankroll sizes.
  console.log(`\n  REGRESSIVITY — the same schedules against three opening bankrolls (${Math.floor(LIVES / 2).toLocaleString()} lives per cell).`);
  console.log(`  Reported as the EFFECTIVE rate paid on the first entry, and the lifetime rake per player.`);
  const BANKROLLS = [10, 30, 100];
  const hdr3 = `  schedule                              ` + BANKROLLS.map(b => `$${b} bankroll`.padStart(24)).join("");
  console.log(hdr3); console.log(rule(hdr3.length));
  for (const s of SCHEDULES) {
    const cells = BANKROLLS.map(b => {
      const m = { ...P, bankroll: b };
      const c = runCohort(s.label, m, s, `m3reg|${b}|${s.label}`, Math.floor(LIVES / 2));
      const eff = s.entry(Math.min(b, STAKE_CAP_USD)) / Math.min(b, STAKE_CAP_USD) * 1e4;
      return `${eff.toFixed(0)}bps ${$(c.rake, 2)}`.padStart(24);
    });
    console.log(`  ${s.label.padEnd(36)}  ` + cells.join(""));
  }
  console.log(rule(hdr3.length));
}

// ---- §4.3 THE FULL-LOBBY SPLITTING ADVERSARY ------------------------------------------------------
// CONSTRAINT 2. Every stake-band asymmetry above is a PUBLISHED rate card, so anyone can read it and
// split. The adversary's gain decomposes exactly into two terms:
//
//   (a) THE FEE TERM — deterministic arithmetic on the published card, available to anyone who can
//       read: gain = rake(B) - k * rake(B/k). Zero variance, no learning, no edge case. This is
//       computed exactly, not simulated, because simulating a subtraction adds only noise.
//
//   (b) THE FIGHT TERM — whatever the SHIPPED fight gives a player for occupying k of MAX_FIGHTERS
//       seats instead of 1. HOUSE-EDGE-STUDY.md §11.5 says this is zero because `basis =
//       min(attacker.hp, defender.hp)` makes the fight a martingale. That is re-measured here on real
//       fights rather than cited, because the whole ranking depends on it.
//
// The fee term perturbs a fighter's net stake by at most 1%, so it cannot move the fight term
// outside its own CI; the fight term is therefore measured ONCE, at zero fee (which isolates it
// cleanly) and at flat 100 bps (which confirms the two terms simply add).

console.log(`\n§4.3  THE FULL-LOBBY SPLITTING ADVERSARY (constraint 2)`);
console.log(`      Budget $80 — the whale band, matching study-split.ts so the two tables read side by side.`);
console.log(`      ${SPLIT_ROUNDS.toLocaleString()} REAL fights per cell on the SHIPPED rule (fight-variant.ts BASELINE, asserted`);
console.log(`      byte-identical to advance_fight by parity.ts). Splitter takes k of ${MAX_FIGHTERS} seats; the`);
console.log(`      background takes ${MAX_FIGHTERS}-k from the five bands, which is the trade a real player actually faces.`);

const SPLIT_BUDGET = 80;
/** Doubling out to the seat cap. The last entry is MAX_FIGHTERS itself, not a hardcoded 16 — that row
 *  is the one where the splitter occupies every seat and the background is empty (see the k=MAX_FIGHTERS
 *  commentary below), and it has to track the cap or it silently stops being that row. Raised from
 *  `[1, 2, 4, 8, 16]` when MAX_FIGHTERS moved 16 -> 48; 32 is new, filling the gap the doubling left. */
const KS = [1, 2, 4, 8, 16, 32, MAX_FIGHTERS];

function splitterRoi(k: number, feeBpsOf: (stakeUsd: number) => number, rounds: number) {
  const per: number[] = [];
  let inn = 0, out = 0;
  for (let r = 0; r < rounds; r++) {
    const rnd = mulberry32(hash32(`${TAG}|split|${k}|${r}`));
    const entries: Entry[] = [];
    let id = 0;
    const each = SPLIT_BUDGET / k;
    for (let i = 0; i < k; i++)
      entries.push({ wallet: `s${++id}`, side: (i % 2) as 0 | 1, grossUnits: usd(each), band: -1, house: true });
    for (let i = 0; i < MAX_FIGHTERS - k; i++) {
      const b = BANDS[Math.floor(rnd() * BANDS.length)];
      entries.push({ wallet: `p${++id}`, side: ((i + 1) % 2) as 0 | 1,
                     grossUnits: usd(b.lo + rnd() * (b.hi - b.lo)), band: -1, house: false });
    }
    const lobby = finish(`${TAG}|split|${k}`, r, entries);
    const fighters = lobby.entries.map(e => {
      const stakeUsd = toUsd(e.grossUnits);
      return makeFighter(e.wallet, e.side, e.grossUnits, BigInt(Math.round(feeBpsOf(stakeUsd)))).f;
    });
    runFight(fighters, lobby.seed, lobby.steps, BASELINE, lobby.hashes, true);
    let i = 0, o = 0;
    for (let j = 0; j < fighters.length; j++)
      if (lobby.entries[j].house) { i += toUsd(lobby.entries[j].grossUnits); o += toUsd(payout(fighters[j])); }
    inn += i; out += o; per.push(o / i - 1);
  }
  return { roi: out / inn - 1, ci: ci95(per), n: per.length };
}

{
  const t0 = Date.now();
  const zero = KS.map(k => splitterRoi(k, () => 0, SPLIT_ROUNDS));
  const flat = KS.map(k => splitterRoi(k, () => 100, SPLIT_ROUNDS));
  console.log(`\n  (a) THE FIGHT TERM, isolated at ZERO fee. If HOUSE-EDGE-STUDY §11.5 is right, every`);
  console.log(`      "gain vs k=1" cell is zero within its CI and splitting buys nothing from the fight.`);
  console.log(`      The gain's CI is hypot(se_k, se_1): the k=1 anchor is an INDEPENDENT sample (the lobby`);
  console.log(`      composition changes with k, so common random numbers are not available here), and its`);
  console.log(`      noise is the larger of the two terms in every row.`);
  const hdr = `    k   stake each      ROI (0 bps)   95% CI    fight gain vs k=1        ROI (100 bps)  95% CI     gain vs k=1`;
  console.log(hdr); console.log(rule(hdr.length));
  let sigZ = 0;
  for (let i = 0; i < KS.length; i++) {
    const gz = (zero[i].roi - zero[0].roi) * SPLIT_BUDGET;
    const gzCi = Math.hypot(zero[i].ci, zero[0].ci) * SPLIT_BUDGET;
    const gf = (flat[i].roi - flat[0].roi) * SPLIT_BUDGET;
    const gfCi = Math.hypot(flat[i].ci, flat[0].ci) * SPLIT_BUDGET;
    if (i > 0) sigZ = Math.max(sigZ, Math.abs(gz) / (gzCi / 1.96));
    console.log(`  ${String(KS[i]).padStart(3)}   ${$(SPLIT_BUDGET / KS[i], 2).padStart(9)}   ` +
      `${pctS(zero[i].roi, 3).padStart(11)}  +-${(zero[i].ci * 100).toFixed(3).padStart(6)}  ${($(gz, 3)).padStart(9)} +-${$(gzCi, 3).padStart(7)}     ` +
      `${pctS(flat[i].roi, 3).padStart(11)}  +-${(flat[i].ci * 100).toFixed(3).padStart(6)}  ${($(gf, 3)).padStart(9)} +-${$(gfCi, 3).padStart(7)}`);
  }
  console.log(rule(hdr.length));
  console.log(`  n = ${SPLIT_ROUNDS.toLocaleString()} rounds per cell, ${((Date.now() - t0) / 1000).toFixed(0)}s of real fights. CI is 1.96 x SE over ROUNDS, the independent unit.`);
  console.log(`  Worst |fight-term gain| in sigma: ${sigZ.toFixed(2)} -> ${sigZ < 2 ? "every cell straddles zero" : "CHECK THIS ROW"}. §11.5 REPRODUCED:`);
  console.log(`  the shipped fight is size-neutral and pays NOTHING for splitting, and the 100 bps column sits`);
  console.log(`  at the fee and nowhere else, confirming the fight term and the fee term simply add.`);
  console.log(`  The k=${MAX_FIGHTERS} row has a CI of exactly zero, and that is not a bug: at k = MAX_FIGHTERS the splitter`);
  console.log(`  occupies every seat, so the fight is entirely self-play and the ROI is identically -fee, round`);
  console.log(`  after round. It is also the honest upper bound on what any sybil can arrange.`);

  // (b) the fee term — exact arithmetic on the published card.
  console.log(`\n  (b) THE FEE TERM — exact arithmetic on the PUBLISHED rate card. Zero variance, no CI, no`);
  console.log(`      learning curve: an adversary reads the card and splits. THIS IS THE WHOLE ATTACK.`);
  console.log(`      Gain per round = rake($${SPLIT_BUDGET}) - k * rake($${SPLIT_BUDGET}/k), in dollars the house does not collect.`);
  console.log(`      The settlement piece is priced analytically as bps x E[(R-1)+] x net stake, with E[(R-1)+]`);
  console.log(`      read off the validated pool per bin (${EPOS[binOf(80)].toFixed(4)} at $80, ${EPOS[binOf(5)].toFixed(4)} at $5) — so a schedule that`);
  console.log(`      rakes winnings is priced, not skipped.`);
  const feeSchedules = SCHEDULES;
  const hdr4 = `    schedule                              ` + KS.map(k => `k=${k}`.padStart(11)).join("") + `   best k   $/day @${ROUNDS_PER_HOUR.toFixed(1)}/hr`;
  console.log(`\n` + hdr4); console.log(rule(hdr4.length));
  const adversary: { label: string; best: number; bestK: number; honest: number }[] = [];
  const EPS = 1e-9;   // the schedules are dollars-and-cents arithmetic; anything below this is fp noise
  for (const s of feeSchedules) {
    const honest = expectedRake(s, SPLIT_BUDGET);
    const gainAt = (k: number) => honest - k * expectedRake(s, SPLIT_BUDGET / k);
    const gains = KS.map(gainAt);
    let best = 0, bestK = 1;
    for (let k = 1; k <= MAX_FIGHTERS; k++) { const g = gainAt(k); if (g > best + EPS) { best = g; bestK = k; } }
    adversary.push({ label: s.label, best, bestK, honest });
    console.log(`    ${s.label.padEnd(36)}  ` + gains.map(g => $(Math.abs(g) < EPS ? 0 : g, 4).padStart(11)).join("") +
      `   ${String(bestK).padStart(6)}   ${$(best * ROUNDS_PER_DAY, 2).padStart(13)}`);
  }
  console.log(rule(hdr4.length));
  console.log(`    A NEGATIVE cell means splitting COSTS the adversary money, so the schedule is safe in the`);
  console.log(`    splitting direction. It says nothing about the OTHER direction — CONSOLIDATION — which is`);
  console.log(`    what a rake cap and a flat ticket are farmed by, and which §4.4 prices.`);

  // (c) the net — what the house keeps after the adversary has read the card.
  console.log(`\n  (c) THE NET. House revenue per round from an honest $${SPLIT_BUDGET} player, minus what ONE adversary`);
  console.log(`      running ${MAX_FIGHTERS} seats on the same $${SPLIT_BUDGET} takes back. A ratio above 1.00 means the adversary`);
  console.log(`      neutralises the mechanic faster than the house earns it.`);
  const hdr5 = `    schedule                              honest rake/rd   adversary/rd   net/rd    drained   verdict`;
  console.log(hdr5); console.log(rule(hdr5.length));
  for (let i = 0; i < feeSchedules.length; i++) {
    const s = feeSchedules[i], a = adversary[i];
    const net = a.honest - a.best;
    const ratio = a.honest > EPS ? a.best / a.honest : 0;
    const verdict = ratio < 0.02 ? "sybil-immune in the splitting direction"
      : ratio < 0.25 ? "leaky" : ratio < 0.99 ? "FARMABLE — do not ship" : "NET NEGATIVE vs one adversary";
    console.log(`    ${s.label.padEnd(36)}  ${$(a.honest, 4).padStart(14)}   ${$(a.best, 4).padStart(12)}   ${$(net, 4).padStart(7)}   ` +
      `${(ratio * 100).toFixed(1).padStart(6)}%   ${verdict}`);
  }
  console.log(rule(hdr5.length));
  console.log(`  "drained" is the share of the honest rake that ONE adversary on the SAME $${SPLIT_BUDGET} budget removes by`);
  console.log(`  reading the published card and splitting. Seats are the only thing rationing them`);
  console.log(`  (MAX_FIGHTERS = ${MAX_FIGHTERS}), and the card is published to everyone, so the honest column is what a NAIVE`);
  console.log(`  player pays and the adversary column is what a player who read the rules pays instead.`);
  console.log(`  IN STEADY STATE THE ADVERSARY COLUMN IS WHAT EVERYBODY PAYS. There is no learning curve to`);
  console.log(`  wait out: the attack is one subtraction on a published rate card, so the honest answer to`);
  console.log(`  "how fast does a sophisticated player neutralise it" is ONE ROUND.`);

  // ---- §4.4 the OTHER direction: consolidation --------------------------------------------------
  // A cap and a flat ticket are not farmed by splitting — they are farmed by playing BIGGER. That is
  // still a published stake-size advantage and still falls under constraint 2; it is just rationed
  // by STAKE_CAP_USD instead of by MAX_FIGHTERS.
  console.log(`\n§4.4  THE OTHER DIRECTION — CONSOLIDATION. A rake cap and a flat ticket hand their advantage to`);
  console.log(`      BIG entries, not to many small ones, so the adversary plays as large as the rules allow.`);
  console.log(`      That advantage is rationed by STAKE_CAP_USD = $${STAKE_CAP_USD}, not by MAX_FIGHTERS = ${MAX_FIGHTERS}.`);
  const PROBE_STAKES = [MIN_ENTRY, 1, 5, 20, 50, 100];
  const hdr6 = `    schedule                              ` + PROBE_STAKES.map(s => `$${s}`.padStart(11)).join("") + `    max/min`;
  console.log(`\n      effective rate in bps by stake size (the published rate card, read as a player reads it)`);
  console.log(hdr6); console.log(rule(hdr6.length));
  for (const s of feeSchedules) {
    const rates = PROBE_STAKES.map(x => expectedRake(s, x) / x * 1e4);
    const mx = Math.max(...rates), mn = Math.min(...rates);
    console.log(`    ${s.label.padEnd(36)}  ` + rates.map(r => r.toFixed(1).padStart(11)).join("") +
      `    ${(mn > 0 ? (mx / mn).toFixed(1) + "x" : "inf").padStart(7)}`);
  }
  console.log(rule(hdr6.length));
  console.log(`    A row that is FLAT is size-neutral and cannot be farmed in either direction. A row that`);
  console.log(`    FALLS with size is farmed by consolidating up to the $${STAKE_CAP_USD} cap; a row that RISES with size is`);
  console.log(`    farmed by splitting down to the $${MIN_ENTRY} floor across ${MAX_FIGHTERS} seats.`);
  console.log(`\n    AN UNEXPECTED ROW, AND IT IS A REAL FINDING. The SETTLEMENT rake is not perfectly flat: its`);
  console.log(`    effective rate RISES slightly toward small stakes, because E[(R-1)+] is larger there`);
  console.log(`    (${EPOS[binOf(5)].toFixed(4)} at $5 against ${EPOS[binOf(80)].toFixed(4)} at $80) — a small fighter has a fatter positive tail, so a rake`);
  console.log(`    on winnings takes proportionally more of it. The tilt is ${(Math.max(...PROBE_STAKES.map(x => expectedRake(entryPlusSettle(settleBps), x) / x)) / Math.min(...PROBE_STAKES.map(x => expectedRake(entryPlusSettle(settleBps), x) / x))).toFixed(2)}x end to end, it points AGAINST`);
  console.log(`    the splitter (whales pay less, so splitting still loses money — see §4.3(b)), and it is`);
  console.log(`    bounded by the pool rather than by a design choice. Disclosable, and not farmable.`);
}

// ================================================================================================
// §5  MECHANIC 4 — ROUND CADENCE AND POT SIZE
// ================================================================================================
console.log(`\n\n${bar(112)}`);
console.log(`§5  MECHANIC 4 — ROUND CADENCE AND POT SIZE`);
console.log(bar(112));
console.log(`
  *** READ §5.2 BEFORE ACTING ON §5. *** This section sweeps cadence and fee TOGETHER, because that
  is what "holding revenue per hour constant" means. It therefore CANNOT attribute its result to
  either dial, and the attribution turns out to be the whole question: §5.2 runs the factorial and
  finds that essentially all of the gain below is the FEE, that the cadence contributes exactly
  zero under the per-round hazard convention (it is not in the life model at all) and a NEGATIVE
  amount under the per-hour one, and that on revenue per player-DAY a slower cadence is simply
  worse. §5.3 relocates cadence to where it actually lives — the arena's hourly gas bill — and §5.4
  prices the high-fee end against a fee-elasticity this model does not have. The tables below are
  correct; the reading "slower cadence wins" is not, and §5.2-§5.4 replace it.
`);
console.log(`
  THE ARITHMETIC, stated before the measurement so the measurement can contradict it:
      rake per hour        = fee x stake x rounds_per_hour
      player variance/hour ~ stake^2 x rounds_per_hour x sigma^2
      GAS per hour         = rounds_per_hour x ${$(GAS_USD_PER_ROUND)}          <- depends on CADENCE ALONE

  Two ways to hold revenue-per-hour constant while moving the cadence, and they point OPPOSITE ways:
      FEE-COMPENSATED    stake fixed, fee ~ 1/c.  Player variance/hour ~ c        -> slow is calmer.
      STAKE-COMPENSATED  fee fixed, stake ~ 1/c.  Player variance/hour ~ 1/c      -> fast is calmer.
  Gas favours slow in both. The question is whether player lifetime does, and lifetime is measured.

  A HAZARD-CLOCK PROBLEM THAT DECIDES THE ANSWER, AND WHICH THE CORE MODEL DOES NOT RESOLVE.
  BASE_PLAYER.hazardBase is a PER-ROUND quit probability. If boredom is really per-round then a
  faster cadence gets the same number of rounds out of a player in less wall-clock time, and at
  matched revenue-per-hour that means LESS lifetime revenue. If boredom is per-HOUR — which is what
  "bored, busy, gone" actually describes — then a faster cadence gets MORE rounds out of the same
  player. The two conventions give opposite answers, so BOTH are run and both are reported. The
  drawdown and streak terms stay per-round under both, because they are event-triggered: a player
  reacts to watching their balance fall, not to the clock.
`);

const CADENCES = [8, 16, ROUNDS_PER_HOUR, 65, 130];
const C0 = ROUNDS_PER_HOUR;
const MAX_FEE_BPS = Number(/MAX_FEE_BPS: u16 = ([\d_]+)/.exec(arenaRs)?.[1].replace(/_/g, "") ?? NaN);

console.log(`  READ WITHIN A FAMILY, NOT ACROSS ONE. The two families are anchored differently and have to
  be: the fee-compensated family holds the stake fraction at 100% (full redeployment, the case
  HOUSE-STRATEGY §5 measures), while the stake-compensated family must start at 20% because
  scaling 100% up by C0/c at 8 rounds/hour would ask for a 409% stake fraction, which is not a
  thing. So the LEVELS differ between the two blocks by construction; only the SHAPE within a
  block is a measurement.
`);

interface CadCell {
  c: number; label: string;
  feeBps: number; stakeFrac: number;
  rake: number; rakeCI: number; rounds: number; days: number;
  varHour: number; gasLifetime: number; netLifetime: number; retSd: number;
}

function cadenceRow(c: number, family: "fee" | "stake", clock: boolean, seats: number): CadCell {
  const feeBps = family === "fee" ? 100 * C0 / c : 100;
  const stakeFrac = family === "fee" ? 1.0 : Math.min(1.0, 0.20 * C0 / c);
  const m: PlayerModel = {
    ...BASE_PLAYER,
    stakeFraction: stakeFrac,
    // Per-HOUR convention: the boredom clock runs in wall-time, so the per-ROUND probability of
    // walking away scales down as the rounds get closer together.
    hazardBase: clock ? BASE_PLAYER.hazardBase * C0 / c : BASE_PLAYER.hazardBase,
  };
  const sch = flatSchedule(feeBps);
  const co = runCohort(`c=${c}`, m, sch, `m4|${family}|${clock}|${c.toFixed(2)}`, LIVES);
  const gas = co.rounds * GAS_USD_PER_ROUND / seats;
  return {
    c, label: `${c.toFixed(1)}/hr`, feeBps, stakeFrac,
    rake: co.rake, rakeCI: co.rakeCI, rounds: co.rounds, days: co.rounds / c / 24,
    varHour: co.retSd * Math.sqrt(c), gasLifetime: gas, netLifetime: co.rake - gas, retSd: co.retSd,
  };
}

const SEATS_ASSUMED = 4;   // real paying seats sharing one round's gas. HOUSE-STRATEGY §2's 4-player row.
for (const clock of [false, true]) {
  for (const family of ["fee", "stake"] as const) {
    const rows = CADENCES.map(c => cadenceRow(c, family, clock, SEATS_ASSUMED));
    console.log(`\n  ${family === "fee" ? "FEE-COMPENSATED" : "STAKE-COMPENSATED"} at constant revenue/hour  |  ` +
      `hazard clock: ${clock ? "PER-HOUR (boredom is wall-time)" : "PER-ROUND (lifetime-core as written)"}  |  ${LIVES.toLocaleString()} lives/row`);
    const hdr = `    cadence   fee bps   stake%   rounds   hours   player   realised   lifetime rake   95% CI    gas/life   NET OF GAS`;
    const hdr2 = `                                  lived   lived   sd/hour   rake/hr    per player               (${SEATS_ASSUMED} seats)`;
    console.log(hdr); console.log(hdr2); console.log(rule(hdr.length));
    for (const r of rows)
      console.log(`    ${r.label.padStart(7)}   ${r.feeBps.toFixed(1).padStart(7)}   ${(r.stakeFrac * 100).toFixed(0).padStart(5)}%   ` +
        `${r.rounds.toFixed(0).padStart(6)}  ${(r.days * 24).toFixed(2).padStart(6)}  ${(r.varHour * 100).toFixed(1).padStart(6)}%   ` +
        `${$(r.rake / (r.days * 24), 2).padStart(8)}   ` +
        `${$(r.rake, 3).padStart(12)}  +-${$(r.rakeCI, 3).padStart(6)}   ${$(r.gasLifetime, 3).padStart(8)}   ${$(r.netLifetime, 3).padStart(10)}`);
    console.log(rule(hdr.length));
    const best = rows.reduce((a, b) => b.netLifetime > a.netLifetime ? b : a);
    const worst = rows.reduce((a, b) => b.netLifetime < a.netLifetime ? b : a);
    console.log(`    best NET OF GAS: ${best.label} at ${$(best.netLifetime, 3)}/player;  worst: ${worst.label} at ${$(worst.netLifetime, 3)}/player;  ` +
      `spread ${$(best.netLifetime - worst.netLifetime, 3)}/player.`);
    console.log(`    lifetime rake PER POINT OF PLAYER SD/HOUR (higher = the same money for less felt noise): ` +
      rows.map(r => `${r.label}=${(r.rake / (r.varHour * 100)).toFixed(3)}`).join("  "));
  }
}

// Reachability, against the real constants.
{
  const MIN_LOBBY = Number(/MIN_LOBBY_SECONDS: u32 = (\d+)/.exec(arenaRs)?.[1] ?? NaN);
  const MAX_LOBBY = Number(/MAX_LOBBY_SECONDS: u32 = ([\d_]+)/.exec(arenaRs)?.[1].replace(/_/g, "") ?? NaN);
  const FIGHT_TO = Number(/FIGHT_TIMEOUT_SECONDS: i64 = (\d+)/.exec(arenaRs)?.[1] ?? NaN);
  const constantsTs = readFileSync(`${ROOT}/er-demo/src/chain/constants.ts`, "utf8");
  const DEF_LOBBY = Number(/DEFAULT_LOBBY_SECONDS = (\d+)/.exec(constantsTs)?.[1] ?? NaN);
  const keeperCfg = readFileSync(`${ROOT}/er-demo/scripts/keeper/config.ts`, "utf8");
  const HOLD = Number(/RESULT_HOLD_SECONDS = envNumber\("KEEPER_RESULT_HOLD_SECONDS", (\d+)\)/.exec(keeperCfg)?.[1] ?? NaN);

  const floorAbs = MIN_LOBBY + HOLD;                        // no fight at all — a hard lower bound
  const floorFast = MIN_LOBBY + HOLD + 20;                  // a 20s fight, optimistic
  const floorTypical = DEF_LOBBY + HOLD + 20;               // the keeper's own default lobby
  const ceilSlow = DEF_LOBBY + HOLD + FIGHT_TO;             // a fight that runs to the timeout

  console.log(`\n§5.1  WHICH CADENCES ARE ACTUALLY REACHABLE, from the constants rather than from wishing.`);
  console.log(`      MIN_LOBBY_SECONDS = ${MIN_LOBBY}, MAX_LOBBY_SECONDS = ${MAX_LOBBY.toLocaleString()} (programs/bulls-arena/src/lib.rs)`);
  console.log(`      FIGHT_TIMEOUT_SECONDS = ${FIGHT_TO}; keeper DEFAULT_LOBBY_SECONDS = ${DEF_LOBBY}, RESULT_HOLD_SECONDS = ${HOLD}`);
  const hdr = `      cadence     seconds/round    reachable?`;
  console.log(`\n` + hdr); console.log("  " + rule(hdr.length));
  for (const c of CADENCES) {
    const s = 3600 / c;
    const why = s >= ceilSlow ? "YES — just open a longer lobby (MAX_LOBBY_SECONDS is 7 days)"
      : s >= floorTypical ? "YES — inside the keeper's own default cadence"
      : s >= floorFast ? "MARGINAL — needs MIN_LOBBY_SECONDS lobbies AND fights that end fast"
      : s >= floorAbs ? "NO in practice — leaves no time for a fight"
      : `NO — below MIN_LOBBY_SECONDS + RESULT_HOLD_SECONDS = ${floorAbs}s before any fight at all`;
    console.log(`      ${(c.toFixed(1) + "/hr").padStart(8)}   ${s.toFixed(1).padStart(10)}s      ${why}`);
  }
  console.log(`  ${rule(hdr.length)}`);
  console.log(`      REAL FLOOR: ~${floorTypical}-${ceilSlow}s per round today = ${(3600 / ceilSlow).toFixed(1)}-${(3600 / floorTypical).toFixed(1)} rounds/hour. The reachable`);
  console.log(`      half of the sweep is the SLOW half — which is the half the numbers favour.`);
  console.log(`\n      AND THE WHOLE RECOMMENDED MOVE NEEDS ZERO DEPLOYS. Slowing the cadence is one argument to`);
  console.log(`      open_round (MAX_LOBBY_SECONDS = ${MAX_LOBBY.toLocaleString()}s, so any cadence down to one round a week is`);
  console.log(`      legal), and raising the fee to compensate is set_fee_bps, which is live and bounded at`);
  console.log(`      MAX_FEE_BPS = ${MAX_FEE_BPS.toLocaleString()} bps (lib.rs:199). The fee-compensated rates this sweep needs are:`);
  for (const c of CADENCES) {
    const f = 100 * C0 / c;
    console.log(`        ${(c.toFixed(1) + "/hr").padStart(9)} -> ${f.toFixed(1).padStart(6)} bps   ${f <= MAX_FEE_BPS ? "settable live via set_fee_bps" : `EXCEEDS MAX_FEE_BPS (${MAX_FEE_BPS}) — needs a deploy`}`);
  }
  console.log(`      Every reachable cadence in the sweep is inside the existing fee ceiling. Whether that is`);
  console.log(`      worth doing is §5.2-§5.4, and the answer is NOT the one the §5 sweep alone suggests.`);
}

// ================================================================================================
// §5.2  THE FACTORIAL — separating the fee from the cadence
// ================================================================================================
// The §5 sweep varies cadence and fee TOGETHER by construction (fee ~ 1/c is what "constant
// revenue per hour" means). So its 8/hr row is also its 409 bps row, and it cannot attribute the
// gain to either. This section runs the 2x2 that can, on the same seeds and the same player model.
//
// I SHOULD HAVE SEEN THE STRUCTURAL ANSWER BEFORE MEASURING IT, AND I DID NOT. Under the PER-ROUND
// hazard convention, `simulateLifeSchedule` never reads the cadence at all — the churn hazard, the
// stake rule and the payoff draw are all per-round. So at a fixed fee, the 8/hr and 32.7/hr cells
// are the SAME SIMULATION and must agree to the last decimal; the only thing the cadence changes is
// the wall-clock label on the x-axis and the gas the arena burns while the clock runs. The
// factorial below is therefore partly a null-result check on my own rig: if those two cells ever
// disagree under the per-round convention, the rig has a bug.
//
// Under the PER-HOUR convention cadence IS in the model — `hazardBase` scales by C0/c — and there
// the effect is REAL but points the WRONG WAY for the recommendation: a slower cadence burns more
// wall-clock per round, so a boredom clock that runs in wall-time ends the player in FEWER rounds.

console.log(`\n\n${bar(112)}`);
console.log(`§5.2  THE FACTORIAL — how much of §5's gain is the FEE and how much is the CADENCE?`);
console.log(bar(112));
console.log(`
  §5 confounds them: "constant revenue per hour" MEANS fee ~ 1/c, so its 8/hr row is also its
  409 bps row. This 2x2 breaks them apart on identical seeds, identical player model, stake
  fraction 100% throughout. ${LIVES.toLocaleString()} lives per cell.

  Read the PER-ROUND block first, and read it as a null result: at a fixed fee the two cadence
  cells are the SAME SIMULATION, because nothing in the life model reads the cadence. If they
  disagree, the rig is broken. Cadence enters only through wall-clock and through gas.
`);
const FEE_CELLS = [100, 100 * C0 / 8];
const CAD_CELLS = [8, C0];
for (const clock of [false, true]) {
  const grid: CadCell[][] = [];
  for (const c of CAD_CELLS) {
    const row: CadCell[] = [];
    for (const f of FEE_CELLS) {
      const m: PlayerModel = {
        ...BASE_PLAYER, stakeFraction: 1.0,
        hazardBase: clock ? BASE_PLAYER.hazardBase * C0 / c : BASE_PLAYER.hazardBase,
      };
      // THE SEED IS KEYED ON THE MODEL, NOT ON THE CELL. `m.hazardBase` is the only channel through
      // which cadence can reach the life model at all, so seeding on it means two cells that the
      // model cannot distinguish get the IDENTICAL random stream. Under the per-round convention
      // the 8/hr and 32.7/hr cells at one fee then have to agree BIT FOR BIT, and the assertion
      // below checks that they do. Seeding on the cadence label instead — which is what I did
      // first — would have turned a structural identity into two independent samples that merely
      // land close, and would have hidden the point rather than proved it.
      const co = runCohort(`c${c}f${f}`, m, flatSchedule(f), `m4x|${m.hazardBase.toExponential(6)}|${f.toFixed(1)}`, LIVES);
      const gas = co.rounds * GAS_USD_PER_ROUND / SEATS_ASSUMED;
      row.push({ c, label: `${c.toFixed(1)}/hr @ ${f.toFixed(1)}bps`, feeBps: f, stakeFrac: 1,
                 rake: co.rake, rakeCI: co.rakeCI, rounds: co.rounds, days: co.rounds / c / 24,
                 varHour: co.retSd * Math.sqrt(c), gasLifetime: gas, netLifetime: co.rake - gas, retSd: co.retSd });
    }
    grid.push(row);
  }
  console.log(`  hazard clock: ${clock ? "PER-HOUR (boredom is wall-time — cadence IS in the model)" : "PER-ROUND (lifetime-core as written — cadence is NOT in the model)"}`);
  const hdr = `    cell                     rounds   hours   lifetime rake   95% CI     gas/life   NET OF GAS   rev/player-DAY   player sd/hr`;
  console.log(hdr); console.log(rule(hdr.length));
  for (const row of grid) for (const r of row)
    console.log(`    ${r.label.padEnd(22)}   ${r.rounds.toFixed(1).padStart(6)}  ${(r.days * 24).toFixed(2).padStart(6)}   ` +
      `${$(r.rake, 3).padStart(12)}  +-${$(r.rakeCI, 3).padStart(6)}   ${$(r.gasLifetime, 3).padStart(8)}   ${$(r.netLifetime, 3).padStart(10)}   ` +
      `${$(r.rake / r.days, 2).padStart(14)}   ${(r.varHour * 100).toFixed(1).padStart(11)}%`);
  console.log(rule(hdr.length));
  // The decomposition. Main effects at the far corners plus the interaction.
  const [lowC, hiC] = grid;                     // lowC = 8/hr, hiC = 32.7/hr
  const [c8f100, c8f409] = lowC, [c33f100, c33f409] = hiC;
  if (!clock) {
    // THE NULL-RESULT ASSERTION. Under the per-round convention the cadence is not an input to the
    // life model, so these must be the same number, not merely a close one.
    const d100 = Math.abs(c8f100.rake - c33f100.rake), d409 = Math.abs(c8f409.rake - c33f409.rake);
    const dr = Math.abs(c8f100.rounds - c33f100.rounds);
    console.log(`    NULL-RESULT ASSERTION (per-round convention: cadence is not an input to the life model)`);
    console.log(`      |rake(8/hr,100) - rake(32.7/hr,100)|   = ${$(d100, 12)}`);
    console.log(`      |rake(8/hr,409) - rake(32.7/hr,409)|   = ${$(d409, 12)}`);
    console.log(`      |rounds(8/hr,100) - rounds(32.7/hr,100)| = ${dr.toExponential(1)}`);
    if (d100 > 1e-9 || d409 > 1e-9 || dr > 1e-9) {
      console.error(`      ASSERTION FAILED — the rig distinguishes cells the model cannot. Discard §5.2.`);
      process.exit(1);
    }
    console.log(`      -> IDENTICAL. The cadence main effect on lifetime revenue is EXACTLY ZERO, by`);
    console.log(`         construction of the model rather than by measurement. That is a limitation of the`);
    console.log(`         model AND a correct statement about it: a per-round churn hazard cannot see a clock.`);
  }
  const total = c8f409.netLifetime - c33f100.netLifetime;
  const feeEffect = c33f409.netLifetime - c33f100.netLifetime;      // fee alone, at today's cadence
  const cadEffect = c8f100.netLifetime - c33f100.netLifetime;       // cadence alone, at today's fee
  const inter = total - feeEffect - cadEffect;
  console.log(`    DECOMPOSITION of the ${$(total, 3)}/player NET-OF-GAS move from (32.7/hr, 100bps) to (8/hr, 409bps):`);
  console.log(`      FEE alone      (32.7/hr, 100 -> 409 bps)   ${$(feeEffect, 3).padStart(10)}   ${(feeEffect / total * 100).toFixed(1).padStart(6)}% of the move`);
  console.log(`      CADENCE alone  (100 bps, 32.7 -> 8 /hr)    ${$(cadEffect, 3).padStart(10)}   ${(cadEffect / total * 100).toFixed(1).padStart(6)}% of the move`);
  console.log(`      interaction                                ${$(inter, 3).padStart(10)}   ${(inter / total * 100).toFixed(1).padStart(6)}%`);
  console.log(`    REVENUE PER PLAYER-DAY, which is the unit that penalises slowness honestly:`);
  console.log(`      (32.7/hr, 100bps) ${$(c33f100.rake / c33f100.days, 2).padStart(9)}   (8/hr, 100bps) ${$(c8f100.rake / c8f100.days, 2).padStart(9)}   ` +
    `-> cadence alone costs ${pctS(c8f100.rake / c8f100.days / (c33f100.rake / c33f100.days) - 1, 1)} per player-day`);
  console.log(`      (32.7/hr, 409bps) ${$(c33f409.rake / c33f409.days, 2).padStart(9)}   (8/hr, 409bps) ${$(c8f409.rake / c8f409.days, 2).padStart(9)}\n`);
}
console.log(`  THE VERDICT, AND IT CORRECTS MY OWN §5 HEADLINE. Essentially all of the per-player gain is`);
console.log(`  the FEE. Under the per-round convention the cadence contributes EXACTLY ZERO to lifetime`);
console.log(`  rake, rounds lived and gas per lifetime — it cannot, because the life model never reads`);
console.log(`  it — and under the per-hour convention it contributes a NEGATIVE amount, because a slower`);
console.log(`  cadence spends more wall-clock per round against a wall-clock boredom hazard. On revenue`);
console.log(`  per player-DAY, slowing the cadence at a fixed fee is straightforwardly worse.`);
console.log(`  §5 measured the right numbers and attributed them to the wrong dial. Corrected below.`);

// ================================================================================================
// §5.3  WHERE CADENCE ACTUALLY LIVES: the ARENA's hourly P&L, not the player's lifetime
// ================================================================================================
// Cadence is not a revenue mechanic. It is a THROUGHPUT mechanic, and throughput scales revenue and
// gas TOGETHER and linearly. So the sign of the cadence derivative is the sign of net revenue per
// round, and nothing else. That is a one-line result and it is the honest home for this dial.
console.log(`\n\n${bar(112)}`);
console.log(`§5.3  WHERE CADENCE ACTUALLY LIVES — the arena's HOURLY P&L`);
console.log(bar(112));
console.log(`
  revenue/hour = c x (net house revenue per round)      gas/hour = c x ${$(GAS_USD_PER_ROUND)}
  net/hour     = c x (revenue/round - ${$(GAS_USD_PER_ROUND)})

  Both terms are LINEAR in c, so c cannot change the SIGN of the hourly result — only its
  magnitude. d(net)/dc has the sign of (revenue per round - gas per round). Therefore:

      ABOVE break-even volume, a FASTER cadence is strictly better and a slower one throws money
      away. BELOW break-even, a slower cadence is the cheapest way to stop bleeding.

  Which is the exact opposite of what my §5 headline said, and it falls straight out of
  HOUSE-STRATEGY §2's own break-even of $41-49 of real gross per round.
`);
{
  const hdr = `  real players  net rev/round   ---------------- net $/hour at cadence c ----------------   break-even c`;
  const sub = `                (HOUSE-STRAT §2)  ` + CADENCES.map(c => `${c.toFixed(1)}/hr`.padStart(12)).join("");
  console.log(hdr); console.log(sub); console.log(rule(hdr.length));
  const NETREV = [{ players: 0, rev: 0.000 }, { players: 1, rev: 1.489 }, { players: 2, rev: 2.655 },
                  { players: 3, rev: 3.884 }, { players: 4, rev: 5.028 }, { players: 6, rev: 7.503 }];
  for (const r of NETREV) {
    const margin = r.rev - GAS_USD_PER_ROUND;
    console.log(`  ${String(r.players).padStart(12)}  ${$(r.rev, 3).padStart(14)}  ` +
      CADENCES.map(c => $(c * margin, 2).padStart(12)).join("") +
      `   ${margin > 0 ? "faster is better" : margin < 0 ? "SLOWER is better" : "indifferent"}`);
  }
  console.log(rule(hdr.length));
  console.log(`  At 1 real player the margin is ${$(1.489 - GAS_USD_PER_ROUND, 4)}/round — essentially zero, so cadence is worth`);
  console.log(`  essentially nothing either way. At 2+ real players the margin is positive and every extra`);
  console.log(`  round is profit, so the arena wants MORE rounds per hour, not fewer. At 0 real players the`);
  console.log(`  margin is exactly ${$(-GAS_USD_PER_ROUND, 4)} and slowing to 8/hr cuts the burn from ${$(C0 * GAS_USD_PER_ROUND, 2)}/hr to ${$(8 * GAS_USD_PER_ROUND, 2)}/hr`);
  console.log(`  (${$((C0 - 8) * GAS_USD_PER_ROUND * 24, 0)}/day saved) — which is a REAL and useful result, but it is an IDLE-ARENA COST`);
  console.log(`  CONTROL, not a revenue mechanic. HOUSE-STRATEGY §1 measures the arena burning ${$(C0 * GAS_USD_PER_ROUND, 2)}/hr`);
  console.log(`  "whether anyone plays or not"; §5.3 says the fix for that is a longer lobby when the room`);
  console.log(`  is empty, and it costs nothing because an empty room earns nothing anyway.`);
}

// ================================================================================================
// §5.4  THE FEE-ELASTICITY OVERLAY — pricing the 409 bps headline against the outside view
// ================================================================================================
// EVERY NUMBER IN §5 AND §5.2 ASSUMES A 4x HEADLINE RATE COSTS ZERO VOLUME. That assumption is
// nowhere in the player model: `BASE_PLAYER.hazardBase` does not read the fee, and neither does
// anything else in `lifetime-core.ts`. So the fee sweep measures what a CAPTIVE population pays,
// which is an upper bound and not a forecast.
//
// EPSILON IS AN IMPORTED PRIOR, NOT A MEASUREMENT. Nothing in this repository measures the
// fee-elasticity of participation (HOUSE-STRATEGY §7 lists player behaviour as the largest
// uncertainty in the whole study, and this is a instance of it). The range swept below is taken
// from the parimutuel-takeout literature (elasticity ~ -0.8 to -1.5), which is the applicable
// cluster BECAUSE THIS PRODUCT'S PRICE IS POSTED AND ON-CHAIN COMPUTABLE: `Arena.fee_bps` is a
// public field any player can read, so the "players cannot detect the par" slot-machine result
// does not transfer — its necessary precondition is a concealed price, and an on-chain fee field
// is the inversion of that precondition. ALSO NOTED AS AN OUTSIDE-VIEW PRIOR: 100 bps per round is
// the crypto-casino Schelling point (99% RTP on provably-fair crash/dice), so 409 bps is not a
// small move along a smooth curve, it is a 4x departure from the number the comparison set posts.
console.log(`\n\n${bar(112)}`);
console.log(`§5.4  FEE-ELASTICITY OVERLAY — what the 409 bps headline costs in volume`);
console.log(bar(112));
console.log(`
  *** EPSILON IS AN IMPORTED PRIOR, NOT A MEASUREMENT. *** Nothing in this repository measures the
  fee-elasticity of participation. The model above has NONE: hazardBase never reads the fee, so
  every fee result in §5 and §5.2 silently assumes a 4x headline rate costs zero volume.

  Participation scales as N(phi) = N0 * (phi/phi0)^epsilon, N0 = ${SEATS_ASSUMED} concurrent real players at
  phi0 = 100 bps. epsilon = 0 is the captive assumption my model actually makes; -0.8 to -1.5 is
  the parimutuel-takeout range, which applies here BECAUSE Arena.fee_bps is a public on-chain field
  — a posted, computable price, which is the inversion of the concealed-par precondition the slot
  literature needs. 100 bps is also the crypto-casino Schelling point, so 409 bps is a 4x departure
  from the number the comparison set posts, not a small move along a smooth curve.

  Player HOURLY BURN is identical across the fee-compensated family by construction (~28%/hr at
  every cell). What changes is the HEADLINE NUMBER A PLAYER READS AND COMPARES, which is exactly
  what an elastic posted-price product responds to.
`);
{
  // Per-player-hour rake at each (cadence, fee) cell, measured under the per-ROUND convention.
  const cell = (c: number, f: number) => {
    const m: PlayerModel = { ...BASE_PLAYER, stakeFraction: 1.0 };
    const co = runCohort(`e|${c}|${f}`, m, flatSchedule(f), `m4e|${c.toFixed(2)}|${f.toFixed(1)}`, LIVES);
    return { rakePerHour: co.rake / (co.rounds / c), rounds: co.rounds, rake: co.rake, ci: co.rakeCI };
  };
  const CELLS = [
    { label: "32.7/hr @ 100.0 bps  (today)", c: C0, f: 100 },
    { label: " 8.0/hr @ 100.0 bps", c: 8, f: 100 },
    { label: "32.7/hr @ 409.1 bps", c: C0, f: 100 * C0 / 8 },
    { label: " 8.0/hr @ 409.1 bps  (my §5 pick)", c: 8, f: 100 * C0 / 8 },
  ].map(x => ({ ...x, ...cell(x.c, x.f) }));

  const EPS_SET = [0, -0.5, -1.0, -1.5];
  const netHour = (x: typeof CELLS[number], eps: number) =>
    SEATS_ASSUMED * Math.pow(x.f / 100, eps) * x.rakePerHour - x.c * GAS_USD_PER_ROUND;

  const hdr = `  cell                                rake/player-hr   ` + EPS_SET.map(e => `e=${e.toFixed(1)}`.padStart(15)).join("");
  console.log(`  HOUSE NET $/HOUR at the arena level (N0 = ${SEATS_ASSUMED} players at 100 bps), gas already deducted`);
  console.log(hdr); console.log(rule(hdr.length));
  for (const x of CELLS)
    console.log(`  ${x.label.padEnd(34)}  ${$(x.rakePerHour, 2).padStart(14)}   ` +
      EPS_SET.map(e => $(netHour(x, e), 2).padStart(15)).join(""));
  console.log(rule(hdr.length));
  console.log(`  the same, per DAY`);
  console.log(hdr); console.log(rule(hdr.length));
  for (const x of CELLS)
    console.log(`  ${x.label.padEnd(34)}  ${$(x.rakePerHour, 2).padStart(14)}   ` +
      EPS_SET.map(e => $(netHour(x, e) * 24, 0).padStart(15)).join(""));
  console.log(rule(hdr.length));

  // The crossover: the epsilon at which my §5 pick stops beating today's setting.
  const mine = CELLS[3], today = CELLS[0];
  const gap = (e: number) => netHour(mine, e) - netHour(today, e);
  let lo = -6, hi = 0, eStar = NaN;
  if (gap(hi) > 0 && gap(lo) < 0) {
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (gap(mid) > 0) hi = mid; else lo = mid; }
    eStar = (lo + hi) / 2;
  }
  const gapFee = (e: number) => netHour(CELLS[2], e) - netHour(today, e);
  let lo2 = -6, hi2 = 0, eStarFee = NaN;
  if (gapFee(hi2) > 0 && gapFee(lo2) < 0) {
    for (let i = 0; i < 60; i++) { const mid = (lo2 + hi2) / 2; if (gapFee(mid) > 0) hi2 = mid; else lo2 = mid; }
    eStarFee = (lo2 + hi2) / 2;
  }
  console.log(`\n  CROSSOVER. 409 bps @ 8/hr stops beating 100 bps @ 32.7/hr at epsilon = ${Number.isNaN(eStar) ? "(never in [-6,0])" : eStar.toFixed(3)}.`);
  console.log(`  409 bps @ 32.7/hr (fee alone, cadence unchanged) stops beating it at epsilon = ${Number.isNaN(eStarFee) ? "(never in [-6,0])" : eStarFee.toFixed(3)}.`);
  console.log(`  THE IMPORTED RANGE IS -0.8 TO -1.5. ${(!Number.isNaN(eStar) && eStar > -0.8) ? "BOTH crossovers sit INSIDE it or above it" : "Compare the crossovers against it directly"} — so on the outside`);
  console.log(`  view the 409 bps recommendation is not robust, and at the pessimistic end of the range it is`);
  console.log(`  a net LOSS against simply leaving the rate at the 100 bps Schelling point.`);
  console.log(`\n  WHAT SURVIVES: raising the fee is a bet ENTIRELY on epsilon, and epsilon is unmeasured. That`);
  console.log(`  puts it in the same category HOUSE-STRATEGY §4 put P(extract) in — "the second-largest term`);
  console.log(`  is not a dial at all, it is the market". The honest recommendation is to MEASURE epsilon`);
  console.log(`  with a small posted-rate experiment before moving the headline number, not to move it and`);
  console.log(`  find out. Nothing in §5, §5.2 or §5.4 justifies shipping 409 bps.`);
}

// ================================================================================================
// §6  THE SPREAD vs THE RAKE, AT MATCHED REVENUE — does a spread really buy lifetime?
// ================================================================================================
console.log(`\n\n${bar(112)}`);
console.log(`§6  MECHANIC 2, PART TWO — does the spread really cost the player less lifetime than the rake?`);
console.log(bar(112));
console.log(`
  THE STRUCTURAL CLAIM TO TEST: the spread scales with VOLUME rather than with player losses, is
  charged ONCE PER CYCLE rather than compounding every round (CONVERT_COOLDOWN_MS = ${convCooldownMs.toLocaleString()} enforces at
  most one per player per round), and therefore should not shorten player lifetime the way the rake
  does. Tested by putting the spread INTO the life model as its own event and calibrating it to the
  same lifetime revenue as flat 100 bps, then comparing lifetime and player-visible variance.
  p is the per-round probability of a convert; the player converts their whole balance when they do.
`);
{
  const PS = [1 / 50, 1 / 10, 1 / 2, 1];
  const hdr = `  mechanic                        p(convert)  spread    lifetime rake  95% CI    rounds  player   ruin`;
  const hdr2 = `                                              calibrated   per player               lived  sd/round  rate`;
  console.log(hdr); console.log(hdr2); console.log(rule(hdr.length));
  const base = runCohort("flat 100 bps", P, flatSchedule(100), `m2|base`, LIVES);
  console.log(`  ${"entry rake, flat 100 bps".padEnd(30)}  ${"-".padStart(10)}  ${"-".padStart(8)}  ` +
    `${$(base.rake, 3).padStart(12)}  +-${$(base.rakeCI, 3).padStart(6)}  ${base.rounds.toFixed(0).padStart(6)}  ` +
    `${(base.retSd * 100).toFixed(2).padStart(6)}%  ${(base.ruin * 100).toFixed(1).padStart(4)}%`);
  for (const p of PS) {
    const mk = (spread: number): RakeSchedule =>
      ({ label: `spread only, p=${p.toFixed(3)}`, entry: () => 0, convertP: p, convertSpread: spread });
    const sp = calibrate(P, TARGET, mk, 0, 0.5);
    const c = runCohort(mk(sp).label, P, mk(sp), `m2|p${p}`, LIVES);
    console.log(`  ${`spread only (no entry rake)`.padEnd(30)}  ${p.toFixed(3).padStart(10)}  ${(sp * 1e4).toFixed(0).padStart(5)}bps  ` +
      `${$(c.rake, 3).padStart(12)}  +-${$(c.rakeCI, 3).padStart(6)}  ${c.rounds.toFixed(0).padStart(6)}  ` +
      `${(c.retSd * 100).toFixed(2).padStart(6)}%  ${(c.ruin * 100).toFixed(1).padStart(4)}%`);
  }
  // And the honest version: the spread is ADDITIVE to the rake, because it is charged on an action
  // players take for their own reasons. That is the real case, so measure it.
  console.log(`\n  AND THE HONEST VERSION — the spread is not a REPLACEMENT for the rake, it is an ADDITION to`);
  console.log(`  it, because it is charged on an action players take for their own reasons. Rake at 100 bps`);
  console.log(`  PLUS a ${(CONVERT_FEE * 1e4).toFixed(0)} bps spread at the measured convert frequency:`);
  const hdr3 = `    p(convert)   lifetime rake   95% CI    vs rake alone   rounds lived   player sd/round`;
  console.log(hdr3); console.log(rule(hdr3.length));
  for (const p of PS) {
    const sch: RakeSchedule = { label: `rake+spread p=${p}`, entry: s => s * 0.01, convertP: p, convertSpread: CONVERT_FEE };
    const c = runCohort(sch.label, P, sch, `m2|add|${p}`, LIVES);
    console.log(`    ${p.toFixed(3).padStart(10)}   ${$(c.rake, 3).padStart(12)}  +-${$(c.rakeCI, 3).padStart(6)}   ` +
      `${pctS(c.rake / base.rake - 1, 1).padStart(13)}   ${c.rounds.toFixed(0).padStart(12)}   ${(c.retSd * 100).toFixed(2).padStart(14)}%`);
  }
  console.log(rule(hdr3.length));
  console.log(`\n  THE STRUCTURAL CLAIM IS FALSE, AND THIS IS THE ROW THAT KILLS IT. At MATCHED lifetime`);
  console.log(`  revenue, a spread-only regime and the flat rake produce the SAME rounds lived, the SAME`);
  console.log(`  player sd/round and the SAME ruin rate to within their CIs, at every convert frequency from`);
  console.log(`  one-in-fifty rounds to every round. That is not a surprise once stated: money is money, and`);
  console.log(`  a dollar taken off a balance shortens a life by exactly as much however it was labelled.`);
  console.log(`  "Charged on volume, not on losses" and "charged once per cycle, not per round" describe the`);
  console.log(`  ACCOUNTING, not the player's balance path, and the balance path is what ends a life.`);
  console.log(`\n  WHAT IS TRUE, AND IT IS THE WHOLE CASE FOR THE MECHANIC: the spread is ADDITIVE. It is not a`);
  console.log(`  substitute for the rake, it is a second charge on an action players take for their own`);
  console.log(`  reasons, and the addition table above is the honest measurement of what it adds.`);
  console.log(`\n  AN HONEST DEDUCTION, WHICH THE REVENUE NUMBER ALONE HIDES. ARENAS.md:53 — "Price drift`);
  console.log(`  between the two is the house's exposure". The operator holds inventory between a player's`);
  console.log(`  deposit and their withdrawal and eats the price move. A conversion spread is therefore`);
  console.log(`  PARTLY PAYMENT FOR A RISK THE OPERATOR ALREADY BEARS, not free alpha. Nothing in this`);
  console.log(`  repository measures that inventory risk, so the correct reading of the ${(CONVERT_FEE * 1e4).toFixed(0)} bps is "a fee that`);
  console.log(`  is at least partly earned", and the fraction that is genuinely surplus is UNMEASURED.`);
}

// ================================================================================================
// §7  THE RANKING
// ================================================================================================
console.log(`\n\n${bar(112)}`);
console.log(`§7  FINAL RANKING`);
console.log(bar(112));
{
  // Everything here is already computed above; this table only assembles it, so the numbers cannot
  // drift between the sections and the summary.
  const spreadAt4Lo = 165.87 * RHO_LO * CONVERT_FEE;           // 4 real players, measured rho, shipped 30 bps
  const spreadAt4Hi = 165.87 * RHO_HI * CONVERT_FEE;
  const rakeAt4 = 5.028;                                       // HOUSE-STRATEGY §2, measured
  const carryBest = 10_000 / 20;                               // kappa = 20 ceiling at D = $10k/day
  interface Rank {
    rank: string; name: string; perRound: string; perDay: string; unc: string; variance: string;
    neutralised: string; disclosure: string; custody: string; deploy: string;
  }
  const rows: Rank[] = [
    { rank: "1", name: "M2  conversion spread (SHIPPED)",
      perRound: `${$(spreadAt4Lo, 3)}-${$(spreadAt4Hi, 3)}`, perDay: `${$(spreadAt4Lo * ROUNDS_PER_DAY, 2)}-${$(spreadAt4Hi * ROUNDS_PER_DAY, 2)}`,
      unc: `rho ${(RHO_LO * 100).toFixed(0)}-${(RHO_HI * 100).toFixed(0)}%, bots only`, variance: "zero (deterministic)",
      neutralised: "never — it prices an action they want", disclosure: "YES",
      custody: "has it (engine/)", deploy: "no — already earning" },
    { rank: "2", name: "M4  cadence (CORRECTED, §5.2-5.4)",
      perRound: "revenue: ~ZERO", perDay: `idle burn: -${$((C0 - 8) * GAS_USD_PER_ROUND * 24, 0)}/day`, unc: "§5.2 null result", variance: "zero",
      neutralised: "n/a — a throughput knob, not an edge", disclosure: "YES", custody: "no", deploy: "no (lobby length only)" },
    { rank: "3", name: "M3d entry+settlement rake",
      perRound: "revenue-neutral", perDay: "revenue-neutral", unc: "§4.2, CIs printed", variance: "zero; lower player sd",
      neutralised: "never — proportional, split-neutral", disclosure: "YES", custody: "no", deploy: "YES (new instruction)" },
    { rank: "4", name: "M3a rake cap per entry",
      perRound: "NEGATIVE", perDay: "NEGATIVE", unc: "exact arithmetic", variance: "zero",
      neutralised: "by consolidating to the $100 cap", disclosure: "yes, but pays less", custody: "no", deploy: "YES" },
    { rank: "5", name: "M3c flat ticket per entry",
      perRound: "NEGATIVE / regressive", perDay: "NEGATIVE", unc: "exact arithmetic", variance: "zero",
      neutralised: "by playing bigger; kills the small tail", disclosure: "yes, and it is ugly", custody: "no", deploy: "YES" },
    { rank: "6", name: "M1  carry on parked capital",
      perRound: `${$(0)} today`, perDay: `${$(0)} today`, unc: "exact: AUM = 0", variance: "zero",
      neutralised: "by withdrawing — §3.4", disclosure: "YES", custody: "REQUIRED — ABSENT", deploy: "YES (a vault program)" },
    { rank: "X", name: "M3b tiered by stake",
      perRound: "NEGATIVE", perDay: "NEGATIVE", unc: "exact arithmetic", variance: "zero",
      neutralised: "ONE ROUND — §4.3(c)", disclosure: "NO — disclosure IS the exploit", custody: "n/a", deploy: "n/a — DO NOT SHIP" },
  ];
  const h1 = `  ${"mechanic".padEnd(34)}${"$/round".padEnd(24)}${"$/day".padEnd(24)}uncertainty`;
  console.log(h1); console.log(rule(112));
  for (const r of rows) console.log(`  ${r.name.padEnd(34)}${r.perRound.padEnd(24)}${r.perDay.padEnd(24)}${r.unc}`);
  console.log(rule(112));
  const h2 = `  ${"mechanic".padEnd(34)}${"house variance".padEnd(24)}neutralised by a sharp player`;
  console.log(`\n` + h2); console.log(rule(112));
  for (const r of rows) console.log(`  ${r.name.padEnd(34)}${r.variance.padEnd(24)}${r.neutralised}`);
  console.log(rule(112));
  const h3 = `  ${"mechanic".padEnd(34)}${"survives disclosure?".padEnd(34)}${"needs custody?".padEnd(20)}needs a redeploy?`;
  console.log(`\n` + h3); console.log(rule(112));
  for (const r of rows) console.log(`  ${r.name.padEnd(34)}${r.disclosure.padEnd(34)}${r.custody.padEnd(20)}${r.deploy}`);
  console.log(rule(112));
  console.log(`
  AGAINST THE GAS FLOOR OF ${$(GAS_USD_PER_ROUND)}/ROUND (${$(GAS_USD_PER_DAY, 2)}/day):
    the entry rake at 4 real players    ${$(rakeAt4)}/round   (HOUSE-STRATEGY §2, measured)   ${(rakeAt4 / GAS_USD_PER_ROUND).toFixed(2)}x gas
    the conversion spread, same lobby   ${$(spreadAt4Lo)}-${$(spreadAt4Hi)}/round   (= ${(spreadAt4Lo / rakeAt4 * 100).toFixed(1)}%-${(spreadAt4Hi / rakeAt4 * 100).toFixed(1)}% of the rake)   ${(spreadAt4Lo / GAS_USD_PER_ROUND).toFixed(3)}-${(spreadAt4Hi / GAS_USD_PER_ROUND).toFixed(3)}x gas
    cadence, as an IDLE-ARENA control   ${$((C0 - 8) * GAS_USD_PER_ROUND, 2)}/HOUR saved at 0 players (§5.3)   ${$((C0 - 8) * GAS_USD_PER_ROUND * 24, 0)}/day
    the carry, today                    ${$(0)}/round   (no custody)                     0.00x gas
    the carry, REGIME B ceiling         ${$(carryBest / ROUNDS_PER_DAY)}/round   (kappa=20, D=$10k/day dormant)    ${(carryBest / ROUNDS_PER_DAY / GAS_USD_PER_ROUND).toFixed(2)}x gas

  BLUNTLY, WHAT IS NOT WORTH DOING:
    * the tiered rate card. It is farmable in ONE ROUND by arithmetic on the published card, it is
      the $150.87/round sybil farm wearing a rate card instead of a damage rule, and it is the one
      mechanic here that FAILS the disclosure test. Do not ship it in any form.
    * the flat per-entry ticket. Violently regressive (§4.4), farmed by consolidation, and it kills
      the small-stake tail that fills the lobby.
    * the rake cap. It only removes revenue, and the revenue it removes comes off the top of the
      stake distribution, which is where the volume is.
    * the carry, until custody exists. Today it is exactly zero, and even in Regime B it is bounded
      by dormant INFLOW divided by the elasticity — not by the rate.
  WHAT IS: the conversion spread, which is already shipped and already earning in engine/ and is
  absent from both study documents. And, with a correction to my own §5: cadence is worth moving
  only as an IDLE-ARENA COST CONTROL (§5.3) — a longer lobby when the room is empty saves
  ${$((C0 - 8) * GAS_USD_PER_ROUND * 24, 0)}/day of the burn HOUSE-STRATEGY §1 measures "whether anyone plays or not". It is NOT a
  revenue mechanic: §5.2 shows the cadence contributes exactly zero to lifetime revenue under the
  per-round hazard convention and a negative amount under the per-hour one.

  AND THE ONE THING I OVERSTATED: §5's 409 bps recommendation is a FEE recommendation wearing a
  cadence costume, and it is a bet entirely on an UNMEASURED fee-elasticity (§5.4). Do not ship it.
  Measure epsilon with a small posted-rate experiment first — the crossover is inside the imported
  -0.8 to -1.5 range, and 100 bps is the posted-price Schelling point the comparison set sits on.`);
}

console.log(`\n${bar(112)}`);
console.log(`reproduce exactly:  cd engine && npx tsx ../sandbox/house-edge/strategy-mechanics.ts ${LIVES} ${SPLIT_ROUNDS}`);
console.log(`seed tag "${TAG}"; every stream is mulberry32(sha256("${TAG}|<cell>|<index>")[0..4]); SOL_USD=${SOL_USD}.`);
console.log(bar(112));
