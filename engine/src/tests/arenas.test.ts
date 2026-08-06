// Arena registry invariants. Pure config, so a cheap guard against a typo silently mis-routing an
// arena to the wrong tokens or economy (which would settle the wrong ledger field).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELD, PAIRINGS, ARENA_IDS, arenaTokens, arenaEco, NARENAS, NARENA_IDS } from "../arenas.ts";

test("2-team registry: 3 pairings × 2 economies = 6 arenas, each well-formed", () => {
  assert.equal(ARENA_IDS.length, 6);
  for (const aid of ARENA_IDS) {
    const toks = arenaTokens(aid);
    assert.ok(Array.isArray(toks) && toks.length === 2, `${aid} must map to a token pair`);
    for (const t of toks) assert.ok(t in FIELD, `${aid}: unknown token ${t}`);
    assert.ok(["normal", "extraction"].includes(arenaEco(aid)), `${aid}: bad economy`);
  }
});

test("FIELD maps each token to its ledger balance field", () => {
  assert.deepEqual(FIELD, { ansem: "bull", uwu: "uwu", sol: "sol" });
});

test("pairings are the three distinct token combinations", () => {
  assert.deepEqual(PAIRINGS.au, ["ansem", "uwu"]);
  assert.deepEqual(PAIRINGS.as, ["ansem", "sol"]);
  assert.deepEqual(PAIRINGS.us, ["uwu", "sol"]);
});

test("N-team registry: 3-way has 3 teams, FFA has 0 (solo)", () => {
  assert.deepEqual(new Set(NARENA_IDS), new Set(["3w-normal", "3w-extraction", "ffa-extraction", "ffa-normal"]));
  assert.equal(NARENAS["3w-normal"].teams, 3);
  assert.equal(NARENAS["3w-extraction"].teams, 3);
  assert.equal(NARENAS["ffa-extraction"].teams, 0);
  assert.equal(NARENAS["ffa-normal"].teams, 0);
});
