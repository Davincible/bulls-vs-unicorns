// reconciliation daemon — the solvency guard. Every N seconds it asserts, per asset, that what
// players could withdraw (ledger LIABILITIES) never exceeds what the vault actually holds on-chain
// (HOLDINGS). If a breach is seen, withdrawals FREEZE and an alert is logged; when a later check
// passes, withdrawals resume. The comparison core (`evaluate`) is pure so it can be unit-tested
// without touching the chain; `start` wires it to the live RPC reads.
import { chainReady, vaultPubkey, vaultTokenBalance, solBalance } from "./chain-ops.ts";
import { RPC } from "./chain.ts";

// Enforcement = actually FREEZE withdrawals on a breach. Only on a live chain: on a test chain
// balances are faucet-minted test credit (liabilities always exceed the vault), so freezing would
// just break dev. There we still compute + report the numbers, we just don't freeze.
const IS_TEST_CHAIN = /localhost|127\.0\.0\.1|devnet|testnet/i.test(RPC);
const ENFORCE =
  process.env.RECONCILE_OFF === "1" ? false
  : process.env.RECONCILE_ENFORCE === "1" ? true
  : !IS_TEST_CHAIN;

export interface AssetRecon { asset: string; liability: number; holdings: number; ok: boolean; shortfall: number; }
export interface ReconReport { at: number; ok: boolean; assets: AssetRecon[]; skipped?: string }

// A tiny tolerance absorbs float dust and rounding; a real breach is far larger than this.
const EPS = 1e-4;

/** Pure solvency comparison. Each entry is one asset's [liability, holdings] in the SAME unit. */
export function evaluate(rows: Array<{ asset: string; liability: number; holdings: number }>, at = Date.now()): ReconReport {
  const assets: AssetRecon[] = rows.map(r => {
    const shortfall = Math.max(0, r.liability - r.holdings);
    return { asset: r.asset, liability: r.liability, holdings: r.holdings, ok: shortfall <= EPS, shortfall };
  });
  return { at, ok: assets.every(a => a.ok), assets };
}

export interface Liabilities { bull: number; uwu: number; solUsd: number }   // bull/uwu in whole tokens, solUsd in USD units

let frozen = false;
let last: ReconReport | null = null;
let warnedTestChain = false;   // so a test-chain shortfall logs once, not every cycle
let timer: ReturnType<typeof setInterval> | null = null;

export function isFrozen(): boolean { return frozen; }
export function latest(): ReconReport | null { return last; }

/** Read on-chain holdings, compare to current ledger liabilities, and set the freeze flag. */
export async function runOnce(getLiabilities: () => Liabilities, solPrice: () => number): Promise<ReconReport> {
  try {
    const L = getLiabilities();
    const rows: Array<{ asset: string; liability: number; holdings: number }> = [];
    // native SOL: ledger tracks USD units, the vault holds SOL — convert liability to SOL to compare
    const px = solPrice();
    const solHoldings = await solBalance(vaultPubkey());
    rows.push({ asset: "sol", liability: px > 0 ? L.solUsd / px : 0, holdings: solHoldings });
    if (chainReady()) {
      rows.push({ asset: "bull", liability: L.bull, holdings: await vaultTokenBalance("bull") });
      rows.push({ asset: "uwu", liability: L.uwu, holdings: await vaultTokenBalance("uwu") });
    }
    const report = evaluate(rows);
    last = report;
    const bad = () => report.assets.filter(a => !a.ok).map(a => `${a.asset}: owe ${a.liability.toFixed(4)} > have ${a.holdings.toFixed(4)}`).join("; ");
    if (!report.ok && !ENFORCE) {
      // test chain: report the shortfall once so it's visible, but never freeze dev
      if (!warnedTestChain) { console.warn(`⚠ reconcile: unbacked balance (test chain, not freezing) — ${bad()}`); warnedTestChain = true; }
    } else if (!report.ok && !frozen) {
      frozen = true;
      console.error(`⛔ RECONCILE BREACH — withdrawals FROZEN — ${bad()}`);
    } else if (report.ok && frozen) {
      frozen = false;
      console.log("✅ RECONCILE healthy again — withdrawals resumed");
    }
    return report;
  } catch (e) {
    // A failed RPC read must NOT freeze the book on a false alarm — skip this cycle instead.
    const report: ReconReport = { at: Date.now(), ok: last?.ok ?? true, assets: last?.assets ?? [], skipped: (e as Error).message };
    last = report;
    return report;
  }
}

/** Start the periodic solvency check. Returns a stop() for shutdown/tests. */
export function start(getLiabilities: () => Liabilities, solPrice: () => number, intervalMs = 15_000): () => void {
  void runOnce(getLiabilities, solPrice);                       // check immediately on boot
  timer = setInterval(() => void runOnce(getLiabilities, solPrice), intervalMs);
  if (typeof timer === "object" && "unref" in timer) (timer as any).unref?.();   // don't hold the process open
  return () => { if (timer) clearInterval(timer); timer = null; };
}
