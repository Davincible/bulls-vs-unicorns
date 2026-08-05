// Durable ledger. The engine holds real deposits, so balances MUST survive a restart —
// otherwise a redeploy silently wipes what players are owed while their tokens sit in the vault.
// Small JSON snapshot, written debounced; fine at this scale, swap for Postgres when it isn't.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = process.env.LEDGER_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = join(DIR, "ledger.json");
const TMP = FILE + ".tmp";

export interface Snapshot {
  accounts: any[];
  treasury?: Record<string, number>;
  totalDeployed?: Record<string, number>;
  created?: Record<string, number>;
  busted?: Record<string, number>;
  convFees?: number;
  rounds?: Record<string, number>;
  savedAt?: number;
}

export function loadSnapshot(): Snapshot | null {
  try {
    if (!existsSync(FILE)) return null;
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch (e) {
    console.error("ledger load failed (starting fresh):", (e as Error).message);
    return null;
  }
}

let pending: NodeJS.Timeout | null = null;
let latest: Snapshot | null = null;

function writeNow() {
  if (!latest) return;
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    latest.savedAt = Date.now();
    writeFileSync(TMP, JSON.stringify(latest));
    renameSync(TMP, FILE);            // atomic-ish: never leave a half-written ledger
  } catch (e) {
    console.error("ledger save failed:", (e as Error).message);
  }
}

/** Queue a save (debounced). Call after anything that moves money. */
export function saveSnapshot(s: Snapshot) {
  latest = s;
  if (pending) return;
  pending = setTimeout(() => { pending = null; writeNow(); }, 1000);
}

/** Flush immediately — used on shutdown so nothing in flight is lost. */
export function flushSnapshot() {
  if (pending) { clearTimeout(pending); pending = null; }
  writeNow();
}
