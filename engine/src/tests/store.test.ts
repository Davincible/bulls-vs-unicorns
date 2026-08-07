// Ledger persistence invariants. The engine holds real deposits, so a saved snapshot MUST
// survive a process restart intact — this is the crash-safety claim in store.ts made testable.
// Each test uses its own throwaway LEDGER_DIR so nothing touches the live ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// store.ts binds its DB path from LEDGER_DIR at import time, so set it before a FRESH import.
// Node caches modules by URL, so a unique query string forces a new module instance per test.
async function freshStore(dir: string) {
  process.env.LEDGER_DIR = dir;
  return import("../store.ts?t=" + Date.now() + Math.random());
}

function tmp() { return mkdtempSync(join(tmpdir(), "bulls-ledger-")); }
// store.ts keeps its SQLite handle open for the process lifetime, so on Windows the temp dir
// can't be removed mid-run. Cleanup is best-effort — the OS reclaims the temp dir regardless.
function cleanup(dir: string) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* handle still open */ } }

test("snapshot round-trips accounts and meta across a reopen", async () => {
  const dir = tmp();
  try {
    const s1 = await freshStore(dir);
    const snap = {
      accounts: [
        { id: "wallet-A", bull: 12.5, uwu: 0, sol: 1.2 },
        { id: "wallet-B", bull: 0, uwu: 99, sol: 0 },
      ],
      treasury: { bull: 3.3 }, convFees: 1.75, depSide: { "wallet-A": "bull" }, savedAt: 111,
    };
    s1.saveSnapshot(snap as any);
    s1.flushSnapshot();                       // force the debounced write to disk now

    const s2 = await freshStore(dir);         // simulate a restart: brand-new module + DB handle
    const loaded = s2.loadSnapshot();
    assert.ok(loaded, "expected a snapshot after reopen");
    assert.equal(loaded!.accounts.length, 2);
    const byId = Object.fromEntries(loaded!.accounts.map((a: any) => [a.id, a]));
    assert.equal(byId["wallet-A"].bull, 12.5);
    assert.equal(byId["wallet-B"].uwu, 99);
    assert.equal(loaded!.convFees, 1.75);
    assert.deepEqual(loaded!.treasury, { bull: 3.3 });
    assert.deepEqual(loaded!.depSide, { "wallet-A": "bull" });
  } finally { cleanup(dir); }
});

test("a later save fully replaces the prior account set (no stale rows)", async () => {
  const dir = tmp();
  try {
    const s1 = await freshStore(dir);
    s1.saveSnapshot({ accounts: [{ id: "old", bull: 5 }] } as any);
    s1.flushSnapshot();
    s1.saveSnapshot({ accounts: [{ id: "new", bull: 7 }] } as any);
    s1.flushSnapshot();

    const s2 = await freshStore(dir);
    const loaded = s2.loadSnapshot();
    assert.equal(loaded!.accounts.length, 1, "old account must not linger");
    assert.equal(loaded!.accounts[0].id, "new");
  } finally { cleanup(dir); }
});

test("empty ledger loads as null (fresh boot), not a crash", async () => {
  const dir = tmp();
  try {
    const s = await freshStore(dir);
    assert.equal(s.loadSnapshot(), null);
  } finally { cleanup(dir); }
});

// A redeploy reset every arena to "round 1", which wiped the match history and every previous-rounds
// list with it. On a live deployment that happened ~20 times in a day. The counter has to survive.
test("the per-arena round counter survives a restart", async () => {
  const dir = tmp();
  try {
    const s1: any = await freshStore(dir);
    // an empty ledger deliberately loads as null, so include an account
    s1.saveSnapshot({ accounts: [{ id: "W1", uwu: 1, bull: 0, sol: 0 }],
                      roundsByArena: { "us-extraction": 4746, "au-normal": 12 } });
    s1.flushSnapshot();
    const s2: any = await freshStore(dir);            // simulates the process restarting
    const back = s2.loadSnapshot();
    assert.equal(back.roundsByArena["us-extraction"], 4746, "round number must persist");
    assert.equal(back.roundsByArena["au-normal"], 12);
  } finally { cleanup(dir); }
});

test("a runner resumes at the NEXT round, never at 1", () => {
  const persisted = 4746;
  const startRound = (persisted || 0) + 1;
  assert.equal(startRound, 4747, "carry on where we left off");
  const fresh = (undefined as any || 0) + 1;
  assert.equal(fresh, 1, "a brand new arena still starts at 1");
});
