// auth — wallet-ownership proof. A socket must sign a server-issued nonce with the wallet's
// ed25519 key before ANY money operation on that wallet is honoured. This is the layer that
// closed the "engine trusted any wallet id" hole: without a proven signature, guarded ops are
// refused. State is per-socket and dropped on disconnect.
import { WebSocket } from "ws";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const authed = new Map<WebSocket, Set<string>>();   // ws -> wallets it has proven ownership of
const nonces = new Map<WebSocket, string>();         // ws -> the current challenge awaiting a signature

// RESUMABLE SESSIONS (stateless). Auth was per-socket and dropped on disconnect, so every reconnect
// and every page refresh demanded a fresh wallet signature — players were signing just to deploy
// into a round, which is not a chain operation at all.
//
// Tokens are HMAC-signed rather than stored: "<walletB64>.<expMs>.<sig>". That means they survive an
// engine restart, which an in-memory table would not — and this engine redeploys often, so a stored
// table would log everyone out several times a day. Nothing secret lives in the token; the HMAC is
// what makes it unforgeable, and the wallet is bound into the signed payload so a token for one
// wallet cannot be replayed for another.
//
// Signing is still mandatory for the FIRST proof of ownership. This only avoids re-proving it.
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000);
// A stable per-deployment secret. SESSION_SECRET if provided, else derived from the vault key so it
// is consistent across restarts without adding another secret to manage.
const SESSION_SECRET = createHash("sha256")
  .update(String(process.env.SESSION_SECRET || process.env.VAULT_SECRET_KEY || "bulls-arena-dev-secret"))
  .digest();

const signPayload = (payload: string) =>
  createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");

/** Mint a session token for a wallet that has just proven ownership by signature. */
export function mintSession(wallet: string): string {
  const payload = Buffer.from(wallet).toString("base64url") + "." + (Date.now() + SESSION_TTL_MS);
  return payload + "." + signPayload(payload);
}

/** Re-prove a wallet on a NEW socket using a token from a previous signature. */
export function resume(ws: WebSocket, wallet: string, token: string): boolean {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return false;
    const payload = parts[0] + "." + parts[1];
    const expect = signPayload(payload);
    const got = Buffer.from(parts[2]);
    const want = Buffer.from(expect);
    // constant-time compare so a token cannot be brute-forced a character at a time
    if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
    if (!(Number(parts[1]) > Date.now())) return false;                 // expired
    const signedWallet = Buffer.from(parts[0], "base64url").toString();
    if (signedWallet !== String(wallet || "")) return false;            // bound to one wallet
    (authed.get(ws) ?? authed.set(ws, new Set()).get(ws)!).add(signedWallet);
    return true;
  } catch { return false; }
}

/** Stateless tokens cannot be revoked individually; rotating SESSION_SECRET invalidates all. */
export function endSession(_token: string): void { /* no server-side state to clear */ }

// Operations that move or reveal money. Every one requires a proven wallet on the socket.
export const GUARDED = new Set([
  "enter", "enterN", "withdraw", "withdrawSol", "convert",
  "buildDeposit", "buildSolDeposit", "deposit", "depositSol", "setName", "fundMe", "relayTx",
  // faucet MINTS balance. It is disabled on live chains, but that gate is a regex on the RPC URL —
  // defence in depth, not a second lock on the same door.
  "faucet",
  // NB: authResume is deliberately NOT guarded — it is how a socket becomes authed.
]);

/** Has this socket proven control of `wallet`? */
export function isAuthed(ws: WebSocket, wallet: string): boolean {
  return authed.get(ws)?.has(wallet) === true;
}

/** Issue a fresh nonce for this socket to sign. */
export function challenge(ws: WebSocket): string {
  const nonce = "Bulls vs Unicorns login " + Date.now() + " " + Math.random().toString(36).slice(2);
  nonces.set(ws, nonce);
  return nonce;
}

export interface VerifyResult { ok: boolean; wallet?: string; msg?: string; }

/** Verify a base64 ed25519 signature over the socket's outstanding nonce. On success the wallet
 *  becomes trusted for this socket and the nonce is consumed (single use). */
export function verify(ws: WebSocket, wallet: string, signatureB64: string): VerifyResult {
  try {
    const nonce = nonces.get(ws);
    if (!nonce) return { ok: false, msg: "no challenge" };
    const pk = new PublicKey(wallet).toBytes();
    const sig = Uint8Array.from(Buffer.from(String(signatureB64), "base64"));
    const ok = sig.length === 64 && nacl.sign.detached.verify(new TextEncoder().encode(nonce), sig, pk);
    if (ok) { (authed.get(ws) ?? authed.set(ws, new Set()).get(ws)!).add(wallet); nonces.delete(ws); }
    return { ok, wallet };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

/** Drop all auth state for a disconnected socket. */
export function forget(ws: WebSocket): void {
  authed.delete(ws);
  nonces.delete(ws);
}
