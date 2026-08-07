// Durable ledger — SQLite (WAL), a drop-in for the old single JSON file.
// The engine holds real deposits, so balances MUST survive a restart and MUST NOT corrupt on a
// mid-write crash. The JSON file rewrote the whole ledger on every event; this writes each save
// inside one SQLite transaction (accounts as rows, meta as key/value), so a crash can never
// leave a half-written ledger. Same interface as before, so server.ts is unchanged.
//
// A legacy `data/ledger.json` is imported automatically on first run so nothing is lost.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = process.env.LEDGER_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "data");
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
const DB_PATH = join(DIR, "ledger.db");
const LEGACY_JSON = join(DIR, "ledger.json");

export interface Snapshot {
  accounts: any[];
  treasury?: Record<string, number>;
  totalDeployed?: Record<string, number>;
  depSide?: Record<string, unknown>;
  created?: Record<string, number>;
  busted?: Record<string, number>;
  convFees?: number;
  rounds?: Record<string, number>;
  roundsByArena?: Record<string, number>;
  statsA?: Record<string, unknown>;
  savedAt?: number;
  floatRecoveredAt?: number;
}
// keys that are per-account rows; everything else on the Snapshot is engine-wide "meta"
const META_KEYS = ["treasury", "totalDeployed", "depSide", "created", "busted", "convFees", "rounds", "statsA", "savedAt", "floatRecoveredAt", "roundsByArena"] as const;

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

const putAccount = db.prepare("INSERT INTO accounts(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data");
const clearAccounts = db.prepare("DELETE FROM accounts");
const allAccounts = db.prepare("SELECT data FROM accounts");
const putMeta = db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
const allMeta = db.prepare("SELECT key, value FROM meta");

// one-time import of a pre-SQLite JSON ledger so an in-flight deployment loses nothing
function importLegacyIfEmpty() {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  if (count > 0 || !existsSync(LEGACY_JSON)) return;
  try {
    const snap: Snapshot = JSON.parse(readFileSync(LEGACY_JSON, "utf8"));
    writeSnapshot(snap);
    renameSync(LEGACY_JSON, LEGACY_JSON + ".imported");
    console.log(`ledger: imported ${snap.accounts?.length ?? 0} accounts from legacy ledger.json`);
  } catch (e) {
    console.error("ledger: legacy import failed:", (e as Error).message);
  }
}

export function loadSnapshot(): Snapshot | null {
  try {
    importLegacyIfEmpty();
    const accounts = (allAccounts.all() as { data: string }[]).map(r => JSON.parse(r.data));
    if (!accounts.length) return null;
    const snap: Snapshot = { accounts };
    for (const { key, value } of allMeta.all() as { key: string; value: string }[]) {
      (snap as Record<string, unknown>)[key] = JSON.parse(value);
    }
    return snap;
  } catch (e) {
    console.error("ledger load failed (starting fresh):", (e as Error).message);
    return null;
  }
}

function writeSnapshot(s: Snapshot) {
  db.exec("BEGIN");                                  // one transaction: a crash rolls back cleanly
  try {
    clearAccounts.run();
    for (const a of s.accounts || []) putAccount.run(a.id, JSON.stringify(a));
    for (const k of META_KEYS) if ((s as Record<string, unknown>)[k] !== undefined) putMeta.run(k, JSON.stringify((s as Record<string, unknown>)[k]));
    putMeta.run("savedAt", JSON.stringify(Date.now()));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("ledger save failed (rolled back):", (e as Error).message);
  }
}

let pending: ReturnType<typeof setTimeout> | null = null;
let latest: Snapshot | null = null;

/** Queue a save (debounced). Call after anything that moves money. */
export function saveSnapshot(s: Snapshot) {
  latest = s;
  if (pending) return;
  pending = setTimeout(() => { pending = null; if (latest) writeSnapshot(latest); }, 1000);
}
/** Flush immediately — used on shutdown so nothing in flight is lost. */
export function flushSnapshot() {
  if (pending) { clearTimeout(pending); pending = null; }
  if (latest) writeSnapshot(latest);
}
