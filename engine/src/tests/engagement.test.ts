// B2 — engagement after the self-target fix.
//
// Two rules were added so a wallet could not fight itself: skip same-owner fighters when choosing a
// target, and skip the damage exchange if a collision happens anyway. Both are keyed on the owner
// half of the "wallet|side" id. The risk is obvious in hindsight - an over-broad owner check would
// quietly stop EVERYONE engaging, and a battle where nothing ever connects still settles, still
// conserves value, and still passes every existing test. It just would not be a game.
//
// So this pins both directions: strangers must still fight, and a wallet still must not fight itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateRound, type Entry, type RoundConfig } from "../game.ts";

const cfg = (mode: "normal" | "extraction" = "normal"): RoundConfig =>
  ({ mode, multiplier: 1, base: 0.085, hitCapFrac: 0.25, battleMs: 60_000, tickMs: 50, dust: 1.2 });

const owner = (id: string) => id.split("|")[0];

/** A realistic lobby: distinct wallets, ids in the real "wallet|side" shape. */
const strangers = (): Entry[] => Array.from({ length: 12 }, (_, i) => ({
  id: `w${i}|${i % 2 ? "uwu" : "bull"}`,
  side: (i % 2 ? "uwu" : "bull") as Entry["side"],
  stake: [1, 3.5, 10, 42, 0.5, 7][i % 6],
}));

test("fighters from different wallets still engage — the fix did not disarm the arena", () => {
  const r = simulateRound("b2-strangers", strangers(), cfg());
  assert.ok(r.hits.length > 0, "no hits at all — combat is broken, not merely quiet");
  const dmg = r.fighters.reduce((n, f) => n + (f.dmgDealt || 0), 0);
  assert.ok(dmg > 0, `damage dealt should be positive, got ${dmg}`);
});

test("engagement is broad, not one lucky pair", () => {
  const r = simulateRound("b2-broad", strangers(), cfg());
  const fought = new Set<string>();
  for (const h of r.hits) { fought.add(owner(h.atk)); fought.add(owner(h.def)); }
  assert.ok(fought.size >= 4, `only ${fought.size} wallets ever connected — engagement is too narrow`);
});

test("a wallet on BOTH sides never trades a hit with itself", () => {
  // the exact shape that caused this: one wallet fielding an army on each side
  const e: Entry[] = [
    { id: "solo|bull", side: "bull", stake: 25 },
    { id: "solo|uwu", side: "uwu", stake: 25 },
    { id: "other|bull", side: "bull", stake: 10 },
    { id: "other|uwu", side: "uwu", stake: 10 },
  ];
  const r = simulateRound("b2-self", e, cfg());
  const self = r.hits.filter(h => owner(h.atk) === owner(h.def));
  assert.equal(self.length, 0, `a wallet hit itself ${self.length} times`);
  assert.ok(r.hits.length > 0, "the two real opponents should still have fought");
});

test("self-dealing is blocked without stopping that wallet fighting strangers", () => {
  const e: Entry[] = [
    { id: "solo|bull", side: "bull", stake: 25 },
    { id: "solo|uwu", side: "uwu", stake: 25 },
    { id: "rival|uwu", side: "uwu", stake: 30 },
    { id: "rival2|bull", side: "bull", stake: 30 },
  ];
  const r = simulateRound("b2-mixed", e, cfg());
  const soloVsStranger = r.hits.filter(h =>
    (owner(h.atk) === "solo") !== (owner(h.def) === "solo"));
  assert.ok(soloVsStranger.length > 0, "the two-sided wallet was excluded from combat entirely");
  assert.equal(r.hits.filter(h => owner(h.atk) === owner(h.def)).length, 0);
});

test("engagement holds in extraction mode too", () => {
  const r = simulateRound("b2-extraction", strangers(), cfg("extraction"));
  assert.ok(r.hits.length > 0, "no hits in extraction mode");
});
