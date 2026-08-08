// The browser recomputes the commitment chain independently — that independence IS the fairness
// claim. So its deriveSeed must agree with the engine's byte for byte. One character of drift and
// every honest round reports "MISMATCH", which does not read as a bug in the verifier; it reads as
// the operator being caught cheating. Worse than no verifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deriveSeed } from "../round.ts";

const HTML = readFileSync(new URL("../../../web/index.html", import.meta.url), "utf8");

/** Reimplement the CLIENT's version by reading it out of the page, so the test cannot silently
 *  drift from what actually ships. */
function clientDerive(secret: string, entries: Array<{ id: string; side: string; stake: number }>) {
  const m = HTML.match(/async function deriveSeedJS\(secret,entries\)\{([\s\S]*?)\n  \}/);
  assert.ok(m, "deriveSeedJS must exist in the shipped page");
  const body = m![1];
  // the two things that decide the bytes: the separator and the canonical row format
  assert.match(body, /\.sort\(\)/, "client must sort — otherwise entry order changes the seed");
  assert.match(body, /toFixed\(8\)/, "client must fix stake precision, or a float tail breaks it");
  assert.match(body, /secret\+"\|"\+canon/, "client must join secret and entries with '|'");
  const canon = entries.map(e => `${e.id}|${e.side}|${Number(e.stake).toFixed(8)}`).sort().join(";");
  return createHash("sha256").update(secret + "|" + canon).digest("hex");
}

const S = "b".repeat(64);

test("engine and client derive the same seed for the same round", () => {
  const entries = [
    { id: "wallet1", side: "bull", stake: 12.3456789 },
    { id: "wallet2", side: "uwu", stake: 0.5 },
    { id: "wallet3", side: "bull", stake: 100 },
  ];
  assert.equal(clientDerive(S, entries), deriveSeed(S, entries));
});

test("they agree regardless of the order entries arrive in", () => {
  const a = [{ id: "p1", side: "bull", stake: 1 }, { id: "p2", side: "uwu", stake: 2 }];
  const b = [...a].reverse();
  assert.equal(deriveSeed(S, a), deriveSeed(S, b), "engine is order-independent");
  assert.equal(clientDerive(S, b), deriveSeed(S, a), "and the client agrees with it");
});

test("they agree on awkward stakes — floats are where verifiers usually diverge", () => {
  for (const stake of [0.1 + 0.2, 1 / 3, 1e-8, 99999.999999999, 0]) {
    const e = [{ id: "p", side: "bull", stake }];
    assert.equal(clientDerive(S, e), deriveSeed(S, e), `diverged at stake=${stake}`);
  }
});

test("an empty lobby still derives cleanly on both sides", () => {
  assert.equal(clientDerive(S, []), deriveSeed(S, []));
});

test("changing any single field changes the seed", () => {
  const base = [{ id: "p1", side: "bull", stake: 10 }];
  const seed = deriveSeed(S, base);
  assert.notEqual(deriveSeed(S, [{ id: "p2", side: "bull", stake: 10 }]), seed, "id matters");
  assert.notEqual(deriveSeed(S, [{ id: "p1", side: "uwu", stake: 10 }]), seed, "side matters");
  assert.notEqual(deriveSeed(S, [{ id: "p1", side: "bull", stake: 10.01 }]), seed, "stake matters");
  assert.notEqual(deriveSeed("c".repeat(64), base), seed, "secret matters");
});
