// THE PRODUCTION APP MUST NOT IMPORT THE FORK'S GUARDS.
//
// The MagicBlock ER fork is devnet-only by construction and carries a kill switch that refuses any
// mainnet endpoint. Correct for the fork. Catastrophic here: when those commits reached this branch
// the mainnet game called assertForkIsDevnetOnly() at boot, threw, and exited code 1 in a restart
// loop until the machine hit its limit. The live product was down until the image was rolled back.
//
// Two of the three couplings were worse than the crash, because they failed SILENTLY:
//
//   memo.ts   ON = MEMO_ON_CHAIN==="1" && isDevnetUrl(RPC)
//             On mainnet that is false, so on-chain anchoring switched itself off with no error and
//             no log line. Provable fairness is this product's central claim; the only symptom
//             would have been someone noticing posted=0.
//
//   swap.ts   refuseIfDisabled("jupiterSwaps")
//             would have refused real converts on the live app.
//
// A guard belonging to a devnet fork must never have power over the mainnet product. The fork's own
// files stay in the tree for its use; this test only asserts that production code does not depend
// on them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const SRC = new URL("../", import.meta.url);
const files = readdirSync(SRC).filter(f => f.endsWith(".ts") && f !== "devnet-guard.ts");

test("no production module imports devnet-guard", () => {
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, SRC), "utf8");
    if (/from\s+"\.\/devnet-guard\.ts"/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    "these import the fork's guard and can be disabled or killed by it: " + offenders.join(", "));
});

test("no production module calls the fork's guard functions", () => {
  const banned = ["assertForkIsDevnetOnly", "refuseIfDisabled", "isDevnetUrl", "assertDevnetUrl"];
  const offenders: string[] = [];
  for (const f of files) {
    // Strip comments first. The explanations of WHY these were removed name the functions, and a
    // naive scan flagged the very comments documenting the fix — a test that fails on its own
    // rationale is worse than no test, because the obvious way to "pass" it is to delete the
    // explanation.
    const src = readFileSync(new URL(f, SRC), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const fn of banned) if (new RegExp("\\b" + fn + "\\s*\\(").test(src)) offenders.push(f + ":" + fn);
  }
  assert.deepEqual(offenders, [], "fork guard invoked in production code: " + offenders.join(", "));
});

test("anchoring is gated on its own flag alone", () => {
  const memo = readFileSync(new URL("memo.ts", SRC), "utf8");
  const m = memo.match(/const ON = ([^;]+);/);
  assert.ok(m, "expected the anchoring flag to be declared");
  assert.ok(!/isDevnetUrl|devnet/i.test(m[1]),
    "anchoring must not depend on a devnet check — on mainnet that silently disables it: " + m[1]);
  assert.match(m[1], /MEMO_ON_CHAIN/, "anchoring should key off MEMO_ON_CHAIN");
});
