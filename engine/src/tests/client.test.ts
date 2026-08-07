// CLIENT TESTS — the gap that cost the most development time this session.
//
// The engine has 300+ tests running in ~4 seconds. web/index.html has 2,400+ lines and had NONE, so
// every client bug was found by deploying and poking a live page: ~5 minutes to learn what a
// one-second check would have said. Four real bugs would all have been caught here:
//
//   - Band A read `_ast` above its `const` declaration — a TDZ ReferenceError that took the whole
//     dashboard down, and the plain syntax check passed it
//   - the profile viewer wrote to #modalBody, which does not exist (the element is #pcard)
//   - removing the auto-convert toggle left three unguarded $("#autoConv").classList reads
//   - renaming the BULL token label broke HANDLE, which was keyed on that exact string
//
// These are static checks over the source rather than a DOM harness. Cheap, and they catch the
// class of mistake that actually happened: reaching for an element or a key that is not there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const HTML = readFileSync(new URL("../../../web/index.html", import.meta.url), "utf8");
const SCRIPT = (HTML.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || []).join("\n");

/** Every id the script reads. */
function idsUsed(): Set<string> {
  const out = new Set<string>();
  for (const m of SCRIPT.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)) out.add(m[1]);
  for (const m of SCRIPT.matchAll(/getElementById\("([A-Za-z0-9_-]+)"\)/g)) out.add(m[1]);
  return out;
}
/** Every id the markup defines, plus ids the script creates at runtime. */
function idsDefined(): Set<string> {
  const out = new Set<string>();
  for (const m of HTML.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) out.add(m[1]);
  for (const m of SCRIPT.matchAll(/\.id\s*=\s*"([A-Za-z0-9_-]+)"/g)) out.add(m[1]);
  return out;
}

// The invariant is NOT "every id exists" — code legitimately references elements that appear on
// only some views and guards them. It is "every id that does NOT exist is guarded". An unguarded
// reference to a missing element is the #modalBody bug: it throws the moment that line runs.
test("every element the script reaches for either exists or is null-guarded", () => {
  const used = idsUsed(), have = idsDefined();
  const missing = [...used].filter(id => !have.has(id));
  const lines = SCRIPT.split("\n");
  // Guard shapes vary — `if(!el)return`, `const a=$(x),b=$(y); if(a)`, `?.`, `&&`, and BLOCK guards
  // where `if($("#x")){` opens on an earlier line and the use sits inside it. So look at the line
  // plus a short window above it; a bare use with no check anywhere near is the real bug.
  const guardRe = /if\s*\(|\?\.|&&|\|\|/;
  const nearGuard = (i: number) => lines.slice(Math.max(0, i - 3), i + 1).some(l => guardRe.test(l));
  const unguarded = missing.filter(id =>
    lines.some((l, i) => l.includes('"#' + id + '"') && !nearGuard(i)));
  assert.deepEqual(unguarded, [],
    "unguarded references to missing elements: " + unguarded.join(", ") + " — this is the #modalBody bug");
});

test("no unguarded .classList / .textContent on a possibly-absent element", () => {
  const have = idsDefined();
  const bad: string[] = [];
  for (const m of SCRIPT.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)\.(classList|textContent|innerHTML|style)/g)) {
    if (!have.has(m[1])) bad.push(m[1]);
  }
  assert.deepEqual(bad, [],
    "unguarded DOM access on missing ids: " + bad.join(", ") + " — this is the #autoConv bug");
});

test("the token-label map and every lookup keyed on it agree", () => {
  // TOKMETA labels are used as KEYS elsewhere ({ANSEM:"bull"}, HANDLE={ANSEM:...}). Renaming a
  // label without updating those maps silently yields undefined — exactly what BULL -> ANSEM hit,
  // and it fails in a path (deploying the ANSEM side) that the live arena does not exercise.
  const labels = [...SCRIPT.matchAll(/label:"([A-Z]+)"/g)].map(m => m[1]);
  assert.ok(labels.length >= 3, "expected the arena token labels to be declared");
  for (const keyed of SCRIPT.matchAll(/\{([A-Z]+):"[a-z]+",\s*([A-Z]+):"[a-z]+",\s*([A-Z]+):"[a-z]+"\}/g)) {
    for (const k of [keyed[1], keyed[2], keyed[3]]) {
      assert.ok(labels.includes(k),
        'a map is keyed on "' + k + '" but no token carries that label — the lookup returns undefined');
    }
  }
});

test("no underscore-prefixed const is read before its declaration", () => {
  // The Band A crash: `_ast` used well above `const _ast=`. A const read before its declaration is
  // a TDZ ReferenceError at runtime, and parsing the file will not tell you.
  const fns = SCRIPT.split(/\n\s*function\s+/);
  const offenders: string[] = [];
  for (const fn of fns) {
    for (const m of fn.matchAll(/\bconst\s+(_[A-Za-z0-9]+)\s*=/g)) {
      const name = m[1], decl = m.index ?? 0;
      const first = fn.indexOf(name);
      if (first >= 0 && first < decl - name.length) offenders.push(name);
    }
  }
  assert.deepEqual([...new Set(offenders)], [],
    "const used before declaration (TDZ): " + offenders.join(", ") + " — the Band A dashboard crash");
});

test("the inline app script parses", () => {
  const blocks = HTML.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
  const body = (blocks[1] || "").replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  assert.ok(body.length > 1000, "expected to find the main inline script");
  assert.doesNotThrow(() => new Function(body));
});
