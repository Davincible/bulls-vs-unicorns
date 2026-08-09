// The engine holds a keyed RPC URL and a vault secret key. Anything that can reach a log, a client,
// or a public endpoint must be scrubbed first. This is not hypothetical: the keyed RPC was once
// broadcast to every browser, and /memo returned raw error strings on a public CORS:* endpoint
// while Node's fetch errors routinely embed the full request URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactDeep } from "../redact.ts";

// An OBVIOUSLY FAKE key, and that is the point. This fixture used to carry the project's real
// Helius credential — so the test proving that keys never leak was itself publishing one, in a
// public repository. A redaction test needs a key-SHAPED string, never a key.
const KEYED = "https://mainnet.helius-rpc.com/?api-key=00000000-dead-beef-cafe-000000000000";

test("an API key never survives redaction", () => {
  const out = redact(`TypeError: fetch failed for ${KEYED}`);
  assert.ok(!out.includes("dead-beef"), `key leaked: ${out}`);
  assert.ok(!/api-key=[^*]/.test(out), "no live api-key parameter");
});

test("every credential-ish parameter name is covered", () => {
  for (const p of ["api-key", "api_key", "apikey", "key", "token", "secret", "auth", "password", "access_token"]) {
    const out = redact(`https://host/x?${p}=SUPERSECRET123`);
    assert.ok(!out.includes("SUPERSECRET123"), `${p} leaked: ${out}`);
  }
});

test("an unnamed parameter on a URL is still redacted — we cannot enumerate every credential", () => {
  const out = redact("connect ECONNREFUSED https://rpc.example.com/?zzz=SUPERSECRET123");
  assert.ok(!out.includes("SUPERSECRET123"), `unknown param leaked: ${out}`);
});

test("a byte-array key is redacted", () => {
  const arr = "[" + Array.from({ length: 64 }, (_, i) => i % 256).join(",") + "]";
  assert.ok(!redact(`VAULT_SECRET_KEY=${arr}`).includes("63"), "byte-array key leaked");
});

test("the actual configured secret is redacted wherever it appears", () => {
  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "a-very-real-secret-value-1234567890";
  try {
    const out = redact("boom: a-very-real-secret-value-1234567890 in the message");
    assert.ok(!out.includes("a-very-real-secret"), `configured secret leaked: ${out}`);
  } finally { if (prev === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prev; }
});

test("ordinary messages survive intact — redaction must not destroy diagnostics", () => {
  const msg = "Transaction simulation failed: insufficient lamports 1017915720, need 6421561702";
  assert.equal(redact(msg), msg);
});

test("a public signature is NOT redacted — it is public data and we need it", () => {
  const sig = "5xXZMefR6ZqRCknvDB5d2N5Lf4DK1y4NRfcieqE7fSDMrw4aZrWJgpoU3Sx4WnHx1gCtmGmbZe8pU6QC2t8";
  assert.equal(redact(sig), sig, "a 64-88 char signature must stay readable");
});

test("redactDeep scrubs nested payloads, which is how a new field would leak", () => {
  const stats = { enabled: true, posted: 9, lastError: `fetch failed ${KEYED}`, nested: { url: KEYED } };
  const out = redactDeep(stats);
  assert.equal(JSON.stringify(out).includes("dead-beef"), false, "key survived somewhere in the tree");
  assert.equal(out.posted, 9, "non-string values pass through untouched");
  assert.equal(out.enabled, true);
});

test("null and undefined do not throw", () => {
  assert.equal(redact(null), "");
  assert.equal(redact(undefined), "");
});
