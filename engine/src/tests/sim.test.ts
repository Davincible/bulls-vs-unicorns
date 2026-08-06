// Money-critical invariants for the battle sims. These are the checks that were throwaway
// scripts during the build; committed here so nothing ships that breaks them. Run: `npm test`.
//
// The sims decide who keeps whose money, so three properties must ALWAYS hold:
//   1. DETERMINISM   same seed+entries+cfg -> byte-identical result (provable fairness + client replay)
//   2. CONSERVATION  total value paid out == total value staked (no money minted or destroyed)
//   3. NO FRIENDLY-FIRE  a fighter never damages a teammate (3-way must not devolve into FFA)
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateRound, verifyRound, type Entry, type RoundConfig } from "../game.ts";
import { simulateN, type EntryN, type CfgN } from "../gameN.ts";

const EPS = 1e-6;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

// ---- config mirrors round.ts / roundN.ts exactly so tests exercise the real runtime path ----
const cfg2 = (mode: "normal" | "extraction"): RoundConfig =>
  ({ mode, multiplier: 1, base: 0.085, hitCapFrac: 0.25, battleMs: 60_000, tickMs: 50, dust: 1.2 });
const cfgN = (mode: "normal" | "extraction", teams: number): CfgN =>
  ({ mode, teams, multiplier: 1, base: 0.085, hitCapFrac: 0.25, battleMs: 60_000, tickMs: 50,
     matchRule: teams === 0 ? "none" : "min" });

// deterministic-looking but varied lobby so tests cover whales + dust + odd sizes
function lobby2(): Entry[] {
  const sides = ["bull", "uwu"] as const;
  return Array.from({ length: 24 }, (_, i) => ({
    id: "p" + i, side: sides[i % 2], stake: [1, 3.5, 10, 42, 0.5, 7][i % 6],
  }));
}
function lobbyN(teams: number): EntryN[] {
  return Array.from({ length: 30 }, (_, i) => ({
    id: "n" + i, team: i % teams, stake: [1, 3.5, 10, 42, 0.5, 7][i % 6],
  }));
}
function lobbyFFA(): EntryN[] {
  return Array.from({ length: 16 }, (_, i) => ({
    id: "f" + i, team: 0, stake: [1, 3.5, 10, 42, 0.5, 7][i % 6],
  }));
}

// ---------------------------------------------------------------- 2-team (game.ts)
test("2-team: deterministic — verifyRound accepts a fresh sim", () => {
  const e = lobby2();
  for (const mode of ["normal", "extraction"] as const) {
    const r = simulateRound("seed-2team", e, cfg2(mode));
    assert.equal(verifyRound("seed-2team", e, cfg2(mode), r), true, `verify failed in ${mode}`);
  }
});

test("2-team: deterministic — two independent runs are identical", () => {
  const e = lobby2();
  const a = simulateRound("dup-seed", e, cfg2("normal"));
  const b = simulateRound("dup-seed", e, cfg2("normal"));
  assert.equal(JSON.stringify(a.settlement), JSON.stringify(b.settlement));
  assert.equal(a.winner, b.winner);
  assert.equal(a.hits.length, b.hits.length);
});

test("2-team: conservation — payout equals total stake (per mode)", () => {
  const e = lobby2();
  const staked = sum(e.map(x => x.stake));
  for (const mode of ["normal", "extraction"] as const) {
    const r = simulateRound("cons-2", e, cfg2(mode));
    const paid = sum(Object.values(r.settlement).map(s => s.bull + s.uwu));
    assert.ok(Math.abs(paid - staked) < 1e-3, `${mode}: paid ${paid} vs staked ${staked}`);
  }
});

test("2-team: no friendly-fire — every hit crosses sides", () => {
  const e = lobby2();
  const side = new Map(e.map(x => [x.id, x.side]));
  const r = simulateRound("ff-2", e, cfg2("normal"));
  for (const h of r.hits) assert.notEqual(side.get(h.atk), side.get(h.def), `same-side hit ${h.atk}->${h.def}`);
});

// ---------------------------------------------------------------- 3-way (gameN.ts)
test("3-way: deterministic — identical settlement across runs", () => {
  const e = lobbyN(3);
  const a = simulateN("dup-3w", e, cfgN("normal", 3));
  const b = simulateN("dup-3w", e, cfgN("normal", 3));
  assert.equal(JSON.stringify(a.settlement), JSON.stringify(b.settlement));
  assert.equal(a.winnerId, b.winnerId);
});

test("3-way: conservation — payout equals total stake (per mode)", () => {
  const e = lobbyN(3);
  const staked = sum(e.map(x => x.stake));
  for (const mode of ["normal", "extraction"] as const) {
    const r = simulateN("cons-3", e, cfgN(mode, 3));
    const paid = sum(Object.values(r.settlement));
    assert.ok(Math.abs(paid - staked) < 1e-3, `${mode}: paid ${paid} vs staked ${staked}`);
  }
});

test("3-way: no friendly-fire — armies only strike other armies", () => {
  const e = lobbyN(3);
  const team = new Map(e.map(x => [x.id, x.team]));
  const r = simulateN("ff-3", e, cfgN("normal", 3));
  assert.ok(r.hits.length > 0, "expected some combat");
  for (const h of r.hits) assert.notEqual(team.get(h.atk), team.get(h.def), `same-team hit ${h.atk}->${h.def}`);
});

test("3-way: matched book — min rule, refunds never negative", () => {
  const e = lobbyN(3);
  const r = simulateN("match-3", e, cfgN("normal", 3));
  // min rule: matched cap = smallest team total, so every fighter's unmatched refund is >= 0
  for (const f of r.fighters) assert.ok(f.unmatched >= -EPS, `negative refund for ${f.id}: ${f.unmatched}`);
});

// ---------------------------------------------------------------- FFA (gameN.ts, teams=0)
test("FFA: deterministic + conservation", () => {
  const e = lobbyFFA();
  const staked = sum(e.map(x => x.stake));
  const a = simulateN("ffa", e, cfgN("extraction", 0));
  const b = simulateN("ffa", e, cfgN("extraction", 0));
  assert.equal(JSON.stringify(a.settlement), JSON.stringify(b.settlement));
  const paid = sum(Object.values(a.settlement));
  assert.ok(Math.abs(paid - staked) < 1e-3, `FFA: paid ${paid} vs staked ${staked}`);
});

test("FFA: no self-hits — a solo fighter never hits itself", () => {
  const e = lobbyFFA();
  const r = simulateN("ffa-self", e, cfgN("extraction", 0));
  for (const h of r.hits) assert.notEqual(h.atk, h.def, `self hit by ${h.atk}`);
});

// ---------------------------------------------------------------- degenerate lobbies
test("empty + single-fighter lobbies settle without crashing", () => {
  assert.doesNotThrow(() => simulateRound("empty", [], cfg2("normal")));
  assert.doesNotThrow(() => simulateN("empty-n", [], cfgN("normal", 3)));
  const solo: Entry[] = [{ id: "solo", side: "bull", stake: 10 }];
  const r = simulateRound("solo", solo, cfg2("normal"));
  const paid = r.settlement["solo"].bull + r.settlement["solo"].uwu;
  assert.ok(Math.abs(paid - 10) < 1e-3, "solo fighter should get its stake back untouched");
});

// One-sided lobbies are the NORMAL case on a thin float: the arena ran for long stretches with
// entries on a single side only. If those stakes are not returned in full, every such round quietly
// burns real money — which is what the live /float endpoint caught (1520 UWU on-chain, 995 on the
// books minutes after a resync). The solo case was covered; several fighters on one side was not.
for (const mode of ["normal", "extraction"] as const) {
  test(`${mode}: a one-sided lobby returns every stake in full`, () => {
    const e: Entry[] = [
      { id: "a", side: "bull", stake: 12.5 },
      { id: "b", side: "bull", stake: 3.25 },
      { id: "c", side: "bull", stake: 40 },
    ];
    const staked = sum(e.map(x => x.stake));
    const r = simulateRound(`one-sided-${mode}`, e, cfg2(mode));
    const paid = sum(Object.values(r.settlement).map(s => s.bull + s.uwu));
    assert.ok(Math.abs(paid - staked) < 1e-3,
              `${mode}: paid ${paid.toFixed(4)} vs staked ${staked.toFixed(4)} — a no-opposition round must refund`);
  });

  test(`${mode}: a wildly unmatched book refunds the excess rather than burning it`, () => {
    const e: Entry[] = [
      { id: "big", side: "bull", stake: 100 },
      { id: "small", side: "uwu", stake: 1 },
    ];
    const staked = sum(e.map(x => x.stake));
    const r = simulateRound(`unmatched-${mode}`, e, cfg2(mode));
    const paid = sum(Object.values(r.settlement).map(s => s.bull + s.uwu));
    assert.ok(Math.abs(paid - staked) < 1e-3,
              `${mode}: paid ${paid.toFixed(4)} vs staked ${staked.toFixed(4)}`);
  });
}
