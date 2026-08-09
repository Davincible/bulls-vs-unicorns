// DEVNET GUARD — the mainnet kill switch for er-demo, the browser-side MagicBlock ER hackathon demo.
//
// Ported from engine/src/devnet-guard.ts. ONLY the portable core comes across: `MainnetBlocked`,
// `SAFE`/`MAINNET`, `stripUrlNoise`, `assertDevnetUrl`, `isDevnetUrl`. `assertForkIsDevnetOnly` and
// `FORK_DISABLED`/`refuseIfDisabled` do NOT port — they walk `process.env` and gate Node-only
// capabilities (Jupiter swaps, mainnet memo anchoring, the production Fly deploy) that don't exist
// in this app. This is deliberately a copy, not a cross-import from `engine/` — this app is meant to
// be isolated from the mainnet product entirely (see snug-floating-mitten.md), and importing across
// that package boundary would undo the isolation for the sake of five small functions.
//
// This is a hard assertion that runs at import time, before any chain endpoint is used. It fails
// CLOSED: an endpoint it cannot positively identify as devnet/local is rejected. An allowlist of
// known-safe hosts, not a denylist of known-bad ones — a denylist silently permits every endpoint
// nobody thought to ban, including a mainnet RPC behind an unfamiliar proxy domain.
//
// It also refuses on a bare API-key URL with no cluster in the hostname (e.g. a Helius URL that
// could be either cluster), because "probably devnet" is not good enough when the downside is real
// funds on a demo that was never meant to reach them.

export class MainnetBlocked extends Error {
  constructor(msg: string) { super(msg); this.name = "MainnetBlocked"; }
}

/** Hosts and patterns positively identified as safe. Anything else is refused. */
const SAFE = [
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i,
  /^wss?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i,
  /\bapi\.devnet\.solana\.com\b/i,
  /\bapi\.testnet\.solana\.com\b/i,
  /\bdevnet\b/i,            // e.g. devnet.helius-rpc.com, devnet.magicblock.app
  /\btestnet\b/i,
];

/** Explicitly hostile shapes, checked first so the error message can name the reason. */
const MAINNET = [
  /\bapi\.mainnet-beta\.solana\.com\b/i,
  /\bmainnet\b/i,
  /\bmainnet-beta\b/i,
];

// SEC finding (2026-08-09, independent review, carried over from engine/src/devnet-guard.ts):
// assertDevnetUrl only trimmed the string's ENDS before matching, but the WHATWG URL parser that
// `fetch`/`Connection` actually use strips ASCII tab and newline from ANYWHERE in the input, not
// just the ends, as its very first normalization step. `https://api.mai\tnnet-beta.solana.com/?x=devnet`
// matched neither MAINNET (the embedded tab breaks the literal "mainnet") nor got refused by SAFE
// (the tab-free "devnet" in the query string still matched) — yet resolves to real mainnet the
// moment anything actually connects to it, because the tab vanishes during parsing. Strip the same
// characters the URL parser would before matching either list, so a regex-shaped bypass can't
// survive contact with the parser that matters.
// eslint-disable-next-line no-control-regex
const stripUrlNoise = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, "");

export function assertDevnetUrl(url: string, what = "endpoint"): void {
  const u = stripUrlNoise(String(url || "").trim());
  if (!u) throw new MainnetBlocked(`${what}: empty URL — refusing to guess a cluster.`);
  for (const re of MAINNET) {
    if (re.test(u)) {
      throw new MainnetBlocked(
        `${what} points at MAINNET (${u.replace(/([?&](api-key|key|token)=)[^&]+/gi, "$1***")}). ` +
        `This is the MagicBlock ER demo — it is devnet-only by construction. Refusing to start.`);
    }
  }
  if (SAFE.some(re => re.test(u))) return;
  throw new MainnetBlocked(
    `${what} could not be positively identified as devnet: ` +
    `${u.replace(/([?&](api-key|key|token)=)[^&]+/gi, "$1***")}\n` +
    `This guard fails CLOSED — an allowlist, not a denylist, because a denylist silently permits ` +
    `every endpoint nobody thought to ban. Put "devnet" in the host, or use api.devnet.solana.com.`);
}

/** True when the URL is safe. Never throws — for call sites that want to skip rather than crash. */
export function isDevnetUrl(url: string): boolean {
  try { assertDevnetUrl(url); return true; } catch { return false; }
}
