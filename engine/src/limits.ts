// limits — per-socket message budgets and per-IP connection caps.
//
// The engine is a public endpoint doing real work per message: ed25519 verification, ledger
// mutation, on-chain RPC. Without a budget one client can monopolise the event loop and starve
// every player. This is a token bucket per socket (steady rate + burst) plus a cap on concurrent
// sockets per address. Over-budget messages are DROPPED SILENTLY — replying would just double the
// traffic an attacker gets for free.
//
// Costs are weighted: a signature verification is far more expensive than reading a price.

export interface Limits {
  ratePerSec: number;      // sustained messages/second per socket
  burst: number;           // bucket capacity (short spikes above the sustained rate)
  maxPerIp: number;        // concurrent sockets from one address
}
export const LIMITS: Limits = {
  ratePerSec: Number(process.env.RATE_PER_SEC || 25),
  burst: Number(process.env.RATE_BURST || 60),
  maxPerIp: Number(process.env.MAX_CONN_PER_IP || 50),
};
// Escape hatch for tests and local dev; never set this on a public deploy.
const OFF = process.env.RATE_LIMIT_OFF === "1";

// Expensive operations cost more than cheap reads. Auth is the pricey one (ed25519 + it is the
// gateway to creating ledger accounts), so it is deliberately throttled hardest.
const COST: Record<string, number> = {
  authChallenge: 4, authVerify: 8,
  buildDeposit: 6, buildSolDeposit: 6, deposit: 6, depositSol: 6,
  withdraw: 6, withdrawSol: 6, fundMe: 10, faucet: 10,
  chainBalance: 4, solBalance: 4,
};
const DEFAULT_COST = 1;

interface Bucket { tokens: number; last: number; dropped: number }
const buckets = new Map<object, Bucket>();
const perIp = new Map<string, number>();

/** Charge a message against this socket's budget. Returns false when it should be dropped. */
export function allowMessage(ws: object, type?: string): boolean {
  if (OFF) return true;
  const now = Date.now();
  let b = buckets.get(ws);
  if (!b) { b = { tokens: LIMITS.burst, last: now, dropped: 0 }; buckets.set(ws, b); }
  // refill continuously up to the burst ceiling
  b.tokens = Math.min(LIMITS.burst, b.tokens + ((now - b.last) / 1000) * LIMITS.ratePerSec);
  b.last = now;
  const cost = (type && COST[type]) || DEFAULT_COST;
  if (b.tokens < cost) { b.dropped++; return false; }
  b.tokens -= cost;
  return true;
}

/** How many messages this socket has had dropped (for logging/diagnostics). */
export function droppedFor(ws: object): number { return buckets.get(ws)?.dropped ?? 0; }

/** Register a new connection. Returns false if this address is already at its cap. */
export function connectionAllowed(ip: string): boolean {
  if (OFF) return true;
  const n = perIp.get(ip) || 0;
  if (n >= LIMITS.maxPerIp) return false;
  perIp.set(ip, n + 1);
  return true;
}

/** Release a socket's slot and its bucket. Must be called on close/error. */
export function releaseConnection(ws: object, ip: string): void {
  buckets.delete(ws);
  if (OFF) return;
  const n = (perIp.get(ip) || 1) - 1;
  if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
}

/** Current connection count for an address (diagnostics/tests). */
export function connectionsFor(ip: string): number { return perIp.get(ip) || 0; }

/** Test helper — wipe all state. */
export function resetLimits(): void { buckets.clear(); perIp.clear(); }
