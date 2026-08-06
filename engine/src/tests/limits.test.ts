// Rate-limit invariants. The engine does real work per message (ed25519 verify, ledger writes,
// RPC), so one client must not be able to monopolise it. Budgets must throttle abuse while leaving
// normal play untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowMessage, connectionAllowed, releaseConnection, connectionsFor, resetLimits, droppedFor, LIMITS } from "../limits.ts";

const sock = () => ({});

test("normal play is never throttled", () => {
  resetLimits();
  const ws = sock();
  // a real client sends a handful of cheap messages per second; 20 in one burst must all pass
  for (let i = 0; i < 20; i++) assert.equal(allowMessage(ws, "prices"), true, `msg ${i} throttled`);
  assert.equal(droppedFor(ws), 0);
});

test("a flood is cut off once the burst is spent", () => {
  resetLimits();
  const ws = sock();
  let allowed = 0;
  for (let i = 0; i < 5000; i++) if (allowMessage(ws, "prices")) allowed++;
  assert.ok(allowed <= LIMITS.burst + 2, `flood should stop near the burst ceiling, allowed ${allowed}`);
  assert.ok(allowed >= 10, "but a real burst must still get through");
  assert.ok(droppedFor(ws) > 1000, "drops are counted");
});

test("expensive operations drain the budget faster than cheap ones", () => {
  resetLimits();
  const cheap = sock(), pricey = sock();
  let c = 0, p = 0;
  for (let i = 0; i < 500; i++) { if (allowMessage(cheap, "prices")) c++; }
  for (let i = 0; i < 500; i++) { if (allowMessage(pricey, "authVerify")) p++; }
  assert.ok(p < c, `authVerify (${p}) must be throttled harder than prices (${c})`);
});

test("budgets are per socket — one abuser cannot starve another client", () => {
  resetLimits();
  const abuser = sock(), victim = sock();
  for (let i = 0; i < 5000; i++) allowMessage(abuser, "prices");
  assert.equal(allowMessage(victim, "prices"), true, "an unrelated socket keeps its full budget");
});

test("the bucket refills over time", async () => {
  resetLimits();
  const ws = sock();
  while (allowMessage(ws, "prices")) { /* drain */ }
  assert.equal(allowMessage(ws, "prices"), false, "drained");
  await new Promise(r => setTimeout(r, 250));
  assert.equal(allowMessage(ws, "prices"), true, "refilled after a pause");
});

test("connections per address are capped and released", () => {
  resetLimits();
  const ip = "1.2.3.4";
  const socks: object[] = [];
  let accepted = 0;
  for (let i = 0; i < LIMITS.maxPerIp + 10; i++) if (connectionAllowed(ip)) { accepted++; socks.push(sock()); }
  assert.equal(accepted, LIMITS.maxPerIp, "cap enforced");
  assert.equal(connectionAllowed(ip), false, "further connections refused");
  releaseConnection(socks[0], ip);
  assert.equal(connectionsFor(ip), LIMITS.maxPerIp - 1, "slot freed on close");
  assert.equal(connectionAllowed(ip), true, "a freed slot can be reused");
});

test("one address filling its cap does not block a different address", () => {
  resetLimits();
  for (let i = 0; i < LIMITS.maxPerIp; i++) connectionAllowed("10.0.0.1");
  assert.equal(connectionAllowed("10.0.0.1"), false);
  assert.equal(connectionAllowed("10.0.0.2"), true, "a different client is unaffected");
});
