// Shared devnet chain config + helpers (custodial vault MVP).
// The vault is an engine-controlled keypair that also holds mint authority for the
// devnet test BULL/UWU tokens, so the engine can faucet + settle without a custom program.
// This same client-facing API (deposit an SPL transfer to the vault ATA, withdraw signed
// by the vault) is what the trustless Anchor program will implement later for mainnet.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENGINE_DIR = join(HERE, "..");
// CHAIN_CONFIG lets a mainnet deploy point at mainnet.json instead of the devnet default.
export const CFG_PATH = process.env.CHAIN_CONFIG || join(ENGINE_DIR, "devnet.json");
export const KEY_PATH = join(ENGINE_DIR, ".vault-keypair.json"); // gitignored — never upload

export const DECIMALS = 6;
export const RPC = process.env.SOLANA_RPC || clusterApiUrl("devnet");
const IS_TEST_CHAIN = /localhost|127\.0\.0\.1|devnet|testnet/i.test(RPC);

export interface DevnetConfig {
  cluster: "devnet";
  vault: string;                 // vault pubkey (base58)
  mints: { bull: string; uwu: string };
  decimals: number;
}

// A single public RPC throttles hard: reading 20 wallets was enough to trigger 429s, and under real
// player load that would stall deposits and withdrawals. SOLANA_RPC_FALLBACK takes a comma-separated
// list tried in order, and one shared Connection is reused rather than built per call.
const FALLBACKS = (process.env.SOLANA_RPC_FALLBACK || "").split(",").map(s => s.trim()).filter(Boolean);
export const RPC_LIST = [RPC, ...FALLBACKS];
let rpcIdx = 0;
let _conn: Connection | null = null;

export function connection(): Connection {
  if (!_conn) _conn = new Connection(RPC_LIST[rpcIdx], "confirmed");
  return _conn;
}

/** Rotate to the next endpoint after a rate-limit/outage. Returns the one now in use. */
export function rotateRpc(): string {
  if (RPC_LIST.length < 2) return RPC_LIST[0];
  rpcIdx = (rpcIdx + 1) % RPC_LIST.length;
  _conn = new Connection(RPC_LIST[rpcIdx], "confirmed");
  const shown = RPC_LIST[rpcIdx].replace(/([?&](api-key|key|token)=)[^&]+/i, "$1***");
  console.warn(`rpc: rotated to ${shown}`);
  return RPC_LIST[rpcIdx];
}

/** Run an RPC call with backoff, rotating endpoints when one starts refusing us. */
export async function withRpcRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const msg = String((e as Error)?.message || e);
      const throttled = /429|Too Many Requests|rate/i.test(msg);
      if (i === tries - 1) break;
      if (throttled) rotateRpc();
      await new Promise(r => setTimeout(r, 400 * Math.pow(2, i)));
    }
  }
  throw last;
}

export function loadVaultKeypair(): Keypair {
  // 1) Secret manager / host env — VAULT_SECRET_KEY as the JSON byte array (same format the CLI and
  //    the key file use). This is how the key travels to Fly/Railway/VPS without ever hitting git.
  const env = process.env.VAULT_SECRET_KEY?.trim();
  if (env) {
    try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env))); }
    catch (e) { throw new Error("VAULT_SECRET_KEY is set but not a valid JSON byte array: " + (e as Error).message); }
  }
  // 2) Local dev — a gitignored key file next to the engine.
  if (existsSync(KEY_PATH)) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(KEY_PATH, "utf8")));
    return Keypair.fromSecretKey(secret);
  }
  // 3) No key anywhere. Auto-generating is fine on a throwaway TEST chain, but on a live chain it
  //    would silently create a NEW, unfunded vault we don't control (deposits lost, withdraws fail).
  //    Refuse loudly instead.
  if (!IS_TEST_CHAIN) {
    throw new Error("No vault key on a live chain. Set VAULT_SECRET_KEY (secret manager) or provide .vault-keypair.json. Refusing to auto-generate a new vault.");
  }
  const kp = Keypair.generate();
  writeFileSync(KEY_PATH, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

export function loadConfig(): DevnetConfig | null {
  if (!existsSync(CFG_PATH)) return null;
  return JSON.parse(readFileSync(CFG_PATH, "utf8"));
}

export function saveConfig(cfg: DevnetConfig): void {
  writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
}

export function mintFor(cfg: DevnetConfig, side: "bull" | "uwu"): PublicKey {
  return new PublicKey(cfg.mints[side]);
}
