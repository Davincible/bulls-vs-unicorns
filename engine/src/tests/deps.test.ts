// SEC-H1. npm audit reports 3 high / 5 moderate, all transitive under @solana/*. There is no fixed
// version upstream — bigint-buffer@1.1.5 IS the latest and is still flagged — so this cannot be
// resolved by upgrading. What makes it acceptable is documented and asserted here rather than
// assumed, because "we checked once" decays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// GHSA for bigint-buffer is a buffer overflow in the NATIVE addon's toBigIntLE. When the addon is
// absent the package falls back to a pure-JS implementation that does not have the flaw. Our
// deployment logs "Failed to load bindings, pure JS will be used" on every boot.
test("the vulnerable bigint-buffer NATIVE binding is not loadable", () => {
  let nativePresent = true;
  try { require("bigint-buffer/build/Release/bigint_buffer.node"); }
  catch { nativePresent = false; }
  assert.equal(nativePresent, false,
    "the native addon is now loadable, so the overflow advisory APPLIES — re-evaluate SEC-H1");
});

// We never call the affected API ourselves; it is reached only when @solana/buffer-layout-utils
// decodes token account data. Recorded so a future direct use is a deliberate decision.
test("we do not call the affected API directly", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const offenders: string[] = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    if (/toBigIntLE|toBufferLE|require\(["']bigint-buffer/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `direct use of the flagged API in: ${offenders.join(", ")}`);
});
