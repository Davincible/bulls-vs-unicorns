// Commit-reveal lifecycle invariants — what "provably fair" actually rests on. The round runner
// must publish sha256(seed) BEFORE betting, keep the seed hidden during the lobby, then reveal a
// seed that hashes to exactly the published commitment. If this ever drifts, players could no
// longer verify a round wasn't altered after seeing the bets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RoundRunner, deriveSeed } from "../round.ts";
import { RoundRunnerN } from "../roundN.ts";
import { seedHash } from "../game.ts";
import { seedHashN } from "../gameN.ts";

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const FUTURE = () => Date.now() + 10_000_000;   // force any pending phase deadline to have passed

test("lobby commits a hash and hides the seed", () => {
  const r = new RoundRunner("normal", async () => {});
  assert.equal(r.state.phase, "lobby");
  assert.match(r.state.seedHashPublished, /^[0-9a-f]{64}$/, "a sha256 commitment is published at lobby");
  assert.equal(r.state.seed, undefined, "the seed must stay hidden while betting is open");
});

// The commitment chain, end to end. The seed is no longer DRAWN at lobby open — if it were, the
// engine would know the outcome while entries were still open, and "provably fair" cannot rest on
// the operator choosing not to use knowledge it holds. The secret is committed at open; the seed is
// derived from that secret plus the final entries at close. Verification is two steps now, and it
// proves strictly more.
test("reveal: the committed secret and the entries reproduce the seed exactly", async () => {
  const r = new RoundRunner("extraction", async () => {});
  const committed = r.state.seedHashPublished;
  r.enter("p1", "bull", 10); r.enter("p2", "uwu", 10); r.enter("p3", "bull", 5);
  await r.tick(FUTURE());                                   // lobby -> battle (derive + reveal + simulate)
  assert.equal(r.state.phase, "battle");
  assert.ok(r.state.seed, "seed exists once entries are locked");
  assert.ok(r.state.secretRevealed, "the committed secret is published so the chain can be checked");
  // 1. the secret is the one committed before deploys opened
  assert.equal(seedHash(r.state.secretRevealed!), committed, "secret must match the commitment");
  // 2. the seed follows from that secret and the entries anyone can see
  assert.equal(deriveSeed(r.state.secretRevealed!, r.state.entries), r.state.seed,
    "seed must be reproducible from the published secret and entries");
  assert.ok(r.state.result, "a result is computed on reveal");
});

test("the seed does not exist while anyone can still act on it", () => {
  const r = new RoundRunner("normal", async () => {});
  r.enter("p1", "bull", 10);
  assert.ok(r.state.seedHashPublished, "the commitment IS published during the lobby");
  assert.ok(!r.state.seed, "but the seed itself must not exist yet — not to a player, not to us");
  assert.ok(!r.state.secretRevealed, "and the secret stays hidden while entries are open");
});

test("the derivation binds the entries, so a fight cannot be replayed before they close", () => {
  const secret = "a".repeat(64);
  const two = [{ id: "p1", side: "bull", stake: 10 }, { id: "p2", side: "uwu", stake: 10 }];
  const three = [...two, { id: "p3", side: "bull", stake: 3 }];
  assert.notEqual(deriveSeed(secret, two), deriveSeed(secret, three),
    "one more entry must change the seed — otherwise the round is decided before it closes");
  // order must not matter: a verifier rebuilding the list must reach the same seed
  assert.equal(deriveSeed(secret, two), deriveSeed(secret, [...two].reverse()),
    "canonical ordering — otherwise verification depends on iteration order and fails at random");
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

// ---- N-team runner (3-way + FFA) — same commit-reveal contract ----
test("N-team 3-way: commit-reveal holds and settlement conserves", async () => {
  const r = new RoundRunnerN("normal", 3, async () => {});
  const committed = r.state.seedHashPublished;
  assert.equal(r.state.seed, undefined, "seed hidden in lobby");
  const stakes = [10, 8, 6, 12, 4, 9];
  stakes.forEach((s, i) => r.enter("t" + i, i % 3, s));     // spread across 3 teams
  await r.tick(FUTURE());
  assert.equal(seedHashN(r.state.seed!), committed, "revealed seed matches N-team commitment");
  const paid = sum(Object.values(r.state.result!.settlement));
  assert.ok(Math.abs(paid - sum(stakes)) < 1e-3, `3-way paid ${paid} vs staked ${sum(stakes)}`);
});

test("N-team FFA (teams=0): commit-reveal holds and settlement conserves", async () => {
  const r = new RoundRunnerN("extraction", 0, async () => {});
  const committed = r.state.seedHashPublished;
  const stakes = [5, 5, 20, 1, 8];
  stakes.forEach((s, i) => r.enter("f" + i, 0, s));         // FFA: team ignored, each solo
  await r.tick(FUTURE());
  assert.equal(seedHashN(r.state.seed!), committed, "revealed seed matches FFA commitment");
  const paid = sum(Object.values(r.state.result!.settlement));
  assert.ok(Math.abs(paid - sum(stakes)) < 1e-3, `FFA paid ${paid} vs staked ${sum(stakes)}`);
});
