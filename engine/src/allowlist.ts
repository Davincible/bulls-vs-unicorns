// allowlist — closed-beta launch gate. Mainnet opens ONLY to pre-approved, pre-funded wallets;
// non-listed wallets cannot pass auth on a live chain. On a TEST chain (localhost/devnet/testnet)
// the gate is OPEN so dev play is unhindered. Sources, merged: the WHITELIST env var (comma-
// separated pubkeys) and an optional data/whitelist.txt (one pubkey per line, `#` comments ok).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RPC } from "./chain.ts";

const IS_TEST_CHAIN = /localhost|127\.0\.0\.1|devnet|testnet/i.test(RPC);
// Enforce on any non-test chain. ALLOWLIST_ENFORCE=1 forces it on (e.g. staging against mainnet
// data); ALLOWLIST_OFF=1 forces it off (never use on a real launch).
export const enforced =
  process.env.ALLOWLIST_OFF === "1" ? false
  : process.env.ALLOWLIST_ENFORCE === "1" ? true
  : !IS_TEST_CHAIN;

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "whitelist.txt");
let allow = new Set<string>();

export function load(): number {
  const next = new Set<string>();
  const add = (raw: string) => { const w = raw.trim(); if (w && !w.startsWith("#")) next.add(w); };
  (process.env.WHITELIST || "").split(",").forEach(add);
  if (existsSync(FILE)) {
    try { readFileSync(FILE, "utf8").split(/\r?\n/).forEach(add); }
    catch (e) { console.error("allowlist: could not read whitelist.txt:", (e as Error).message); }
  }
  allow = next;
  return allow.size;
}
load();

/** May this wallet play? Always true on a test chain; on a live chain, only if whitelisted. */
export function isAllowed(wallet: string): boolean {
  return !enforced || allow.has(wallet);
}

if (enforced) {
  console.log(`allowlist ENFORCED (live chain): ${allow.size} wallet(s) whitelisted`);
  if (allow.size === 0) console.warn("allowlist: WHITELIST is EMPTY on a live chain — nobody can play until you add wallets");
}
