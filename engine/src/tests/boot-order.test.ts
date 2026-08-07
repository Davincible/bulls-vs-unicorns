// The round counter resetting on every deploy was not a logic bug — RoundRunner resumes from
// `startRound` correctly, and always did. It was purely STATEMENT ORDER in server.ts: the runners
// were constructed from roundsByArena three lines before restore() filled it, so every arena was
// seeded from an empty record and started at 0+1.
//
// Nothing about the runner or the snapshot can catch that, because both are individually correct.
// The only thing that pins it is the order itself, so that is what this asserts. It has already
// regressed once, and the comment sitting directly above the bug claimed the opposite was true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RoundRunner } from "../round.ts";

const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

test("restore() runs before the round runners are seeded from roundsByArena", () => {
  const restoreAt = src.indexOf("\nrestore();");
  const runnerAt = src.indexOf("new RoundRunner(");
  assert.ok(restoreAt > 0, "restore() call not found");
  assert.ok(runnerAt > 0, "RoundRunner construction not found");
  assert.ok(restoreAt < runnerAt,
    "restore() must populate roundsByArena BEFORE the runners read it — otherwise every arena " +
    "restarts at round 1 on each deploy and the previous-rounds list resets with it");
});

test("a runner resumes from the round it is given, rather than restarting at 1", () => {
  const r = new RoundRunner("normal" as any, async () => {}, 41);
  assert.equal(r.state.round, 41);
});

test("the default is still round 1 for a genuinely fresh arena", () => {
  const r = new RoundRunner("normal" as any, async () => {});
  assert.equal(r.state.round, 1);
});
