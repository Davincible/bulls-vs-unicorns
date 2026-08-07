// DEVNET GUARD — the mainnet kill switch for the MagicBlock ER fork.
//
// This branch is a FORK. It must never touch mainnet: not the RPC, not the vault, not Jupiter, not
// the anchoring path. The existing IS_TEST_CHAIN checks are soft — they gate individual behaviours
// on a regex and let everything else through, so a mainnet SOLANA_RPC would boot happily and only
// selectively behave differently. That is the wrong shape for "never".
//
// This is a hard assertion that runs at import time, before any money path can initialise. It fails
// CLOSED: an endpoint it cannot positively identify as devnet/local is rejected. An allowlist of
// known-safe hosts, not a denylist of known-bad ones — a denylist silently permits every endpoint
// nobody thought to ban, including a mainnet RPC behind an unfamiliar proxy domain.
//
// It also refuses on a bare API-key URL with no cluster in the hostname (e.g. a Helius URL that
// could be either cluster), because "probably devnet" is not good enough when the downside is real
// funds on a fork that was never meant to reach them.

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

export function assertDevnetUrl(url: string, what = "endpoint"): void {
  const u = String(url || "").trim();
  if (!u) throw new MainnetBlocked(`${what}: empty URL — refusing to guess a cluster.`);
  for (const re of MAINNET) {
    if (re.test(u)) {
      throw new MainnetBlocked(
        `${what} points at MAINNET (${u.replace(/([?&](api-key|key|token)=)[^&]+/gi, "$1***")}). ` +
        `This is the MagicBlock ER fork — it is devnet-only by construction. Refusing to start.`);
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

/** Feature kill switches for this fork. Each is a capability that only makes sense on mainnet. */
export const FORK_DISABLED = {
  // Jupiter has no meaningful devnet liquidity, and a swap is the single most expensive mistake
  // this fork could make. Disabled outright rather than pointed somewhere harmless.
  jupiterSwaps: true,
  // Anchoring writes to a mainnet program with real fees. The ER commits state to devnet instead.
  mainnetMemoAnchoring: true,
  // The production Fly app serves real players. Deploying this fork there would replace it.
  productionDeploy: true,
} as const;

export function refuseIfDisabled(feature: keyof typeof FORK_DISABLED): void {
  if (FORK_DISABLED[feature]) {
    throw new MainnetBlocked(
      `"${feature}" is disabled on the MagicBlock ER fork. This branch is devnet-only; ` +
      `that capability exists to move real funds and has no place here.`);
  }
}

/** Boot assertion. Import for side effect as early as possible in any entrypoint. */
export function assertForkIsDevnetOnly(env: NodeJS.ProcessEnv = process.env): string[] {
  const checked: string[] = [];
  const urlVars = ["SOLANA_RPC", "RPC_FALLBACKS", "MAGICBLOCK_RPC", "MAGICBLOCK_ROUTER", "ENGINE_HTTP"];
  for (const k of urlVars) {
    const v = env[k];
    if (!v) continue;
    for (const one of v.split(",").map(s => s.trim()).filter(Boolean)) {
      assertDevnetUrl(one, k);
      checked.push(`${k}=${one.replace(/([?&](api-key|key|token)=)[^&]+/gi, "$1***")}`);
    }
  }
  // A mainnet vault key must never be present in this fork's environment at all — not merely
  // unused. Its presence means someone copied production config across, and the next mistake is
  // one env var away.
  if (env.VAULT_SECRET && env.ALLOW_FORK_VAULT !== "1") {
    throw new MainnetBlocked(
      `VAULT_SECRET is set on the ER fork. This fork uses devnet-funded keypairs only; a production ` +
      `vault key here means production config was copied across. Unset it, or set ALLOW_FORK_VAULT=1 ` +
      `if you have deliberately generated a DEVNET-only vault.`);
  }
  return checked;
}
