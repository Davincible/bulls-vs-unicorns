// Commit-reveal lifecycle invariants — what "provably fair" actually rests on. The round runner
// must publish sha256(seed) BEFORE betting, keep the seed hidden during the lobby, then reveal a
// seed that hashes to exactly the published commitment. If this ever drifts, players could no
// longer verify a round wasn't altered after seeing the bets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RoundRunner } from "../round.ts";
import { seedHash } from "../game.ts";

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const FUTURE = () => Date.now() + 10_000_000;   // force any pending phase deadline to have passed

test("lobby commits a hash and hides the seed", () => {
  const r = new RoundRunner("normal", async () => {});
  assert.equal(r.state.phase, "lobby");
  assert.match(r.state.seedHashPublished, /^[0-9a-f]{64}$/, "a sha256 commitment is published at lobby");
  assert.equal(r.state.seed, undefined, "the seed must stay hidden while betting is open");
});

test("reveal: the revealed seed hashes to exactly the pre-committed value", async () => {
  const r = new RoundRunner("extraction", async () => {});
  const committed = r.state.seedHashPublished;
  r.enter("p1", "bull", 10); r.enter("p2", "uwu", 10); r.enter("p3", "bull", 5);
  await r.tick(FUTURE());                                   // lobby -> battle (reveal + simulate)
  assert.equal(r.state.phase, "battle");
  assert.ok(r.state.seed, "seed is revealed at battle start");
  assert.equal(seedHash(r.state.seed!), committed, "revealed seed must match the commitment");
  assert.ok(r.state.result, "a result is computed on reveal");
});

test("settlement conserves the entered stakes (no value minted/destroyed)", async () => {
  const r = new RoundRunner("normal", async () => {});
  const stakes = [10, 10, 5, 7.5, 2];
  r.enter("a", "bull", stakes[0]); r.enter("b", "uwu", stakes[1]); r.enter("c", "bull", stakes[2]);
  r.enter("d", "uwu", stakes[3]); r.enter("e", "bull", stakes[4]);
  await r.tick(FUTURE());
  const paid = sum(Object.values(r.state.result!.settlement).map(s => s.bull + s.uwu));
  assert.ok(Math.abs(paid - sum(stakes)) < 1e-3, `paid ${paid} vs staked ${sum(stakes)}`);
});

test("battle -> settle fires onSettle once and opens a fresh lobby with a NEW commitment", async () => {
  let settleCalls = 0; let settledResult: any = null;
  const r = new RoundRunner("normal", async (res) => { settleCalls++; settledResult = res; });
  const firstCommit = r.state.seedHashPublished;
  r.enter("p1", "bull", 10); r.enter("p2", "uwu", 10);
  // timestamps must increase past each deadline: battle sets closesAt = (reveal now) + battleMs,
  // so the settle tick must be even further ahead than the reveal tick.
  const t0 = Date.now();
  await r.tick(t0 + 10_000_000);                            // -> battle (closesAt now ~t0+10M+battleMs)
  const settled = await r.tick(t0 + 20_000_000);           // -> settle -> fresh lobby
  assert.equal(settled, true, "tick returns true when a round settled");
  assert.equal(settleCalls, 1, "onSettle fires exactly once per round");
  assert.ok(settledResult, "onSettle receives the round result");
  assert.equal(r.state.phase, "lobby", "a new lobby opens");
  assert.equal(r.state.round, 2, "round number advances");
  assert.notEqual(r.state.seedHashPublished, firstCommit, "a fresh seed is committed for the next round");
  assert.equal(r.state.seed, undefined, "next seed hidden again");
});

test("entering the same side twice tops up one fighter (no duplicate settlement key)", async () => {
  const r = new RoundRunner("normal", async () => {});
  r.enter("p1", "bull", 10);
  r.enter("p1", "bull", 15);                                // top-up, not a second fighter
  assert.equal(r.state.entries.filter(e => e.id === "p1" && e.side === "bull").length, 1);
  assert.equal(r.state.entries.find(e => e.id === "p1")!.stake, 25);
});

test("entering after the lobby closes is refused", async () => {
  const r = new RoundRunner("normal", async () => {});
  await r.tick(FUTURE());                                   // now in battle
  assert.equal(r.enter("late", "bull", 10), false, "no entries once betting is locked");
});
