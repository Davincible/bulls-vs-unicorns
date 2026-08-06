// Real on-chain bot wallets.
//
// Bots used to be ledger-only rows seeded with an invented bank (BOT_BANK_MIN..MAX). That is fine
// while they only fight each other, but the moment a REAL player raids a bot and wins its coins,
// that becomes a withdrawable balance backed by nothing — which is exactly the UWU shortfall the
// reconciliation daemon flagged.
//
// Here each bot gets a genuine Solana keypair that:
//   1. holds real SOL (so it can pay its own transaction fees),
//   2. holds real tokens, and
//   3. DEPOSITS them into the vault like any player would.
// After that a bot's ledger balance is backed by tokens the vault actually holds, so player
// winnings taken off a bot are covered. It also gives MagicBlock ERs real accounts to delegate,
// and it is the same shape we need on mainnet where bots play with real money.
//
// The keypairs are secrets: they live in LEDGER_DIR (the mounted volume in production), never git.
import { Keypair } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = process.env.LEDGER_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "data");
// Keep mainnet keys in their own file. Solana keypairs work on any cluster, so the devnet set would
// function on mainnet too — but reusing them means a key leaked in a devnet context (a log, a
// screenshot, a shared machine) would put REAL money at risk. One file per environment.
const WALLET_FILE = process.env.BOT_WALLETS_FILE || "bot-wallets.json";
const FILE = join(DIR, WALLET_FILE);

export interface BotWalletRecord { pubkey: string; secret: number[]; created: number; }

function ensureDir() { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true }); }

export function loadBotWallets(): BotWalletRecord[] {
  if (!existsSync(FILE)) return [];
  try { return JSON.parse(readFileSync(FILE, "utf8")); }
  catch (e) { console.error("bot-wallets: unreadable, starting empty:", (e as Error).message); return []; }
}

function saveBotWallets(rows: BotWalletRecord[]) {
  ensureDir();
  writeFileSync(FILE, JSON.stringify(rows, null, 2));
}

/** Return exactly `n` bot wallets, creating any that don't exist yet. Idempotent. */
export function ensureBotWallets(n: number): BotWalletRecord[] {
  const rows = loadBotWallets();
  let made = 0;
  while (rows.length < n) {
    const kp = Keypair.generate();
    rows.push({ pubkey: kp.publicKey.toBase58(), secret: Array.from(kp.secretKey), created: Date.now() });
    made++;
  }
  if (made > 0) { saveBotWallets(rows); console.log(`bot-wallets: created ${made} new (${rows.length} total)`); }
  return rows.slice(0, n);
}

export function keypairOf(row: BotWalletRecord): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(row.secret));
}

/** Public addresses only — safe to log, ship, or set as an env var. */
export function botPubkeys(): string[] { return loadBotWallets().map(r => r.pubkey); }

// The ENGINE only needs to know WHICH accounts form the bot pool — it never signs for them, so it
// must never hold their private keys. Addresses come from BOT_POOL (env) or a plain pubkey list;
// the secret keyfile stays on the seeding machine.
const POOL_FILE = join(DIR, WALLET_FILE.replace(/\.json$/, "") + "-pool.json");

export function writeBotPool(pubkeys: string[]) {
  ensureDir();
  writeFileSync(POOL_FILE, JSON.stringify({ pubkeys, updated: Date.now() }, null, 2));
}

/** Pool addresses for the engine: BOT_POOL env, then bot-pool.json, then (dev only) the keyfile. */
export function poolPubkeys(): string[] {
  const env = (process.env.BOT_POOL || "").split(",").map(s => s.trim()).filter(Boolean);
  if (env.length) return env;
  if (existsSync(POOL_FILE)) {
    try { return JSON.parse(readFileSync(POOL_FILE, "utf8")).pubkeys || []; } catch { /* fall through */ }
  }
  return botPubkeys();   // local dev, where the keyfile is present anyway
}
