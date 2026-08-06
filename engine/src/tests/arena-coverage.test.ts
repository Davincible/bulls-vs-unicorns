// Guards against the class of bug that shipped a ReferenceError to production: the USD-accrual
// change referenced `myTok` inside the N-arena bot path, where the variable is `tok`. Tests passed
// because only 2-team arenas were enabled, so that code never ran.
//
// The lesson: a green suite proves nothing about code paths the suite never enters. These tests
// assert that EVERY arena shape is represented, so N-team logic is always exercised somewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_ARENA_IDS, NARENAS, PAIRINGS, arenaTokens, arenaEco, FIELD } from "../arenas.ts";
import { simulateN } from "../gameN.ts";
import { RoundRunnerN } from "../roundN.ts";

test("every arena shape is covered: 2-team, 3-team and FFA all exist", () => {
  const twoTeam = ALL_ARENA_IDS.filter(a => !(a in NARENAS));
  const threeWay = Object.values(NARENAS).filter(d => d.teams === 3);
  const ffa = Object.values(NARENAS).filter(d => d.teams === 0);
  assert.ok(twoTeam.length >= 2, "2-team arenas must exist");
  assert.ok(threeWay.length >= 1, "a 3-team arena must exist");
  assert.ok(ffa.length >= 1, "an FFA arena must exist");
});

test("every arena's tokens map to a real ledger field (catches a bad FIELD lookup)", () => {
  for (const aid of ALL_ARENA_IDS) {
    const toks = aid in NARENAS ? NARENAS[aid].toks : arenaTokens(aid);
    assert.ok(toks && toks.length, `${aid} has no tokens`);
    for (const t of toks) {
      const field = FIELD[t];
      assert.ok(["bull", "uwu", "sol"].includes(field), `${aid}: token ${t} -> bad field ${field}`);
    }
  }
});

test("N-team runners actually run a round for EVERY N arena", async () => {
  // exercises the N path end to end, which is where the ReferenceError hid
  for (const [aid, def] of Object.entries(NARENAS)) {
    const r = new RoundRunnerN(def.eco, def.teams, async () => {});
    const stakes = [10, 8, 6, 12];
    stakes.forEach((s, i) => r.enter(`${aid}:bot:${i}`, def.teams === 0 ? 0 : i % def.teams, s));
    await r.tick(Date.now() + 10_000_000);
    assert.ok(r.state.result, `${aid}: no result produced`);
    const paid = Object.values(r.state.result!.settlement).reduce((a, b) => a + b, 0);
    const staked = stakes.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(paid - staked) < 1e-3, `${aid}: settlement ${paid} != staked ${staked}`);
  }
});

test("FFA (teams=0) settles without a team index — the shape that broke the win banner", () => {
  const entries = [0, 1, 2, 3].map(i => ({ id: "f" + i, team: 0, stake: 5 + i }));
  const res = simulateN("cover-ffa", entries, {
    mode: "extraction", teams: 0, multiplier: 1, base: 0.085, hitCapFrac: 0.25,
    battleMs: 60_000, tickMs: 50, matchRule: "none",
  });
  assert.ok(res.winnerId, "FFA must name a winning FIGHTER, not a team");
  assert.equal(typeof res.winnerTeam, "number");
});

test("2-team arenas are not all the same pairing (us-* uses UWU/SOL, not Bulls/Unicorns)", () => {
  const pairs = Object.keys(PAIRINGS);
  assert.ok(pairs.includes("au") && pairs.includes("us"), "au and us pairings must both exist");
  assert.notDeepEqual(arenaTokens("au-extraction"), arenaTokens("us-extraction"),
    "different pairings must map to different tokens — this is what made a UWU/SOL round announce BULLS WIN");
  assert.equal(arenaEco("us-extraction"), "extraction");
});
