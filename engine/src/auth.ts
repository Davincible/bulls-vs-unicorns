// auth — wallet-ownership proof. A socket must sign a server-issued nonce with the wallet's
// ed25519 key before ANY money operation on that wallet is honoured. This is the layer that
// closed the "engine trusted any wallet id" hole: without a proven signature, guarded ops are
// refused. State is per-socket and dropped on disconnect.
import { WebSocket } from "ws";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { randomBytes, timingSafeEqual } from "node:crypto";

const authed = new Map<WebSocket, Set<string>>();   // ws -> wallets it has proven ownership of
const nonces = new Map<WebSocket, string>();         // ws -> the current challenge awaiting a signature

// RESUMABLE SESSIONS. Auth was per-socket and dropped on disconnect, so every reconnect (and every
// page refresh) demanded a fresh wallet signature — players were signing just to deploy into a
// round, which is not a chain operation at all. A signature now mints a bearer token the client can
// replay to re-prove the same wallet without another prompt. Signing stays mandatory for the FIRST
// proof; tokens are random 32-byte values, expire, and are bound to one wallet.
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const sessions = new Map<string, { wallet: string; exp: number }>();

function sweepSessions(now = Date.now()) {
  if (sessions.size < 512) return;                    // cheap: only tidy when it actually grows
  for (const [t, v] of sessions) if (v.exp <= now) sessions.delete(t);
}

/** Mint a session token for a wallet that has just proven ownership by signature. */
export function mintSession(wallet: string): string {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { wallet, exp: Date.now() + SESSION_TTL_MS });
  sweepSessions();
  return token;
}

/** Re-prove a wallet on a NEW socket using a token from a previous signature. */
export function resume(ws: WebSocket, wallet: string, token: string): boolean {
  const rec = sessions.get(String(token || ""));
  if (!rec) return false;
  if (rec.exp <= Date.now()) { sessions.delete(String(token)); return false; }
  // constant-time compare so a token cannot be guessed a character at a time
  const a = Buffer.from(rec.wallet), b = Buffer.from(String(wallet || ""));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  (authed.get(ws) ?? authed.set(ws, new Set()).get(ws)!).add(rec.wallet);
  return true;
}

/** Invalidate a token (explicit sign-out). */
export function endSession(token: string): void { sessions.delete(String(token || "")); }

// Operations that move or reveal money. Every one requires a proven wallet on the socket.
export const GUARDED = new Set([
  "enter", "enterN", "withdraw", "withdrawSol", "convert",
  "buildDeposit", "buildSolDeposit", "deposit", "depositSol", "setName", "fundMe", "relayTx",
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
