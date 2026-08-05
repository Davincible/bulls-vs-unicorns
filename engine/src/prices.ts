// Live USD prices for the arena tokens (DexScreener — free, no key, covers pump.fun + SOL).
// The arena ledger is USD-unit denominated: deposits credit tokens × price, withdrawals pay
// units ÷ price. Prices refresh on an interval and NEVER silently go stale: consumers must
// check freshness before quoting.
const MINTS = {
  ansem: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
  uwu: "UWUy7J86LUiBv5SjAUZ53LMGhtnqvbQ7QNSSkyupump",
  sol: "So11111111111111111111111111111111111111112",
};
export type PriceToken = keyof typeof MINTS;
const state: Record<string, { usd: number; at: number }> = {};
const MAX_AGE_MS = 5 * 60_000;

async function fetchOne(token: PriceToken): Promise<number | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${MINTS[token]}`);
    const j: any = await r.json();
    // take the deepest-liquidity pair's price
    const pairs = (j.pairs || []).filter((p: any) => p.priceUsd);
    if (!pairs.length) return null;
    pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return Number(pairs[0].priceUsd) || null;
  } catch { return null; }
}

export async function refreshPrices(): Promise<void> {
  for (const t of Object.keys(MINTS) as PriceToken[]) {
    const p = await fetchOne(t);
    if (p && p > 0) state[t] = { usd: p, at: Date.now() };
  }
}

/** USD price, or null if unknown/stale — callers must refuse to quote on null. */
export function priceUSD(token: PriceToken): number | null {
  const s = state[token];
  if (!s || Date.now() - s.at > MAX_AGE_MS) return null;
  return s.usd;
}
export function allPrices() {
  const out: Record<string, { usd: number | null; ageS: number | null }> = {};
  for (const t of Object.keys(MINTS)) {
    const s = state[t];
    out[t] = s ? { usd: s.usd, ageS: Math.round((Date.now() - s.at) / 1000) } : { usd: null, ageS: null };
  }
  return out;
}
export function startPriceLoop(intervalMs = 60_000) {
  refreshPrices();
  setInterval(refreshPrices, intervalMs).unref?.();
}
