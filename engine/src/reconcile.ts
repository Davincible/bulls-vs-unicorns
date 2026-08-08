// reconciliation daemon — the solvency guard. Every N seconds it asserts, per asset, that what
// players could withdraw (ledger LIABILITIES) never exceeds what the vault actually holds on-chain
// (HOLDINGS). If a breach is seen, withdrawals FREEZE and an alert is logged; when a later check
// passes, withdrawals resume. The comparison core (`evaluate`) is pure so it can be unit-tested
// without touching the chain; `start` wires it to the live RPC reads.
import { chainReady, vaultPubkey, vaultTokenBalance, solBalance } from "./chain-ops.ts";
import { IS_TEST_CHAIN } from "./chain.ts";

// Enforcement = actually FREEZE withdrawals on a breach. Only on a live chain: on a test chain
// balances are faucet-minted test credit (liabilities always exceed the vault), so freezing would
// just break dev. There we still compute + report the numbers, we just don't freeze.
const ENFORCE =
  process.env.RECONCILE_OFF === "1" ? false
  : process.env.RECONCILE_ENFORCE === "1" ? true
  : !IS_TEST_CHAIN;

// `unit` is the denomination BOTH liability and holdings are expressed in. It is not decoration:
// the ledger keeps SOL in USD while the vault holds SOL, so these rows are converted before they
// get here and an unlabelled number is genuinely ambiguous to anyone reading the endpoint.
export interface AssetRecon { asset: string; liability: number; holdings: number; ok: boolean; shortfall: number; unpriced?: boolean; unit?: string }
export interface ReconReport { at: number; ok: boolean; assets: AssetRecon[]; skipped?: string }

// A tiny tolerance absorbs float dust and rounding; a real breach is far larger than this.
const EPS = 1e-4;

/** Pure solvency comparison. Each entry is one asset's [liability, holdings] in the SAME unit.
 *  An `unpriced` row is INDETERMINATE (e.g. SOL owed but the price feed is down): it can't be
 *  compared, so it never counts as a breach — a price outage must not read as insolvency. */
export function evaluate(rows: Array<{ asset: string; liability: number; holdings: number; unpriced?: boolean; unit?: string }>, at = Date.now()): ReconReport {
  const assets: AssetRecon[] = rows.map(r => {
    if (r.unpriced) {
      const holdings = Number.isFinite(r.holdings) ? r.holdings : 0;
      return { asset: r.asset, liability: 0, holdings, ok: true, shortfall: 0, unpriced: true, unit: r.unit };
    }
    // guard: never let a NaN/undefined slip through as a fake shortfall
    const liability = Number.isFinite(r.liability) ? r.liability : 0;
    const holdings = Number.isFinite(r.holdings) ? r.holdings : 0;
    const shortfall = Math.max(0, liability - holdings);
    return { asset: r.asset, liability, holdings, ok: shortfall <= EPS, shortfall, unit: r.unit };
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
    const rows: Array<{ asset: string; liability: number; holdings: number; unpriced?: boolean; unit?: string }> = [];
    // native SOL: ledger tracks USD units, the vault holds SOL — convert liability to SOL to compare.
    // If SOL is actually owed but the price feed is down, solvency is INDETERMINATE (mark unpriced)
    // rather than faking 0 (false "solvent") or NaN (false "shortfall") — and never freeze on it.
    const px = solPrice();
    const solHoldings = await solBalance(vaultPubkey());
    if (L.solUsd > 0 && !(px > 0)) {
      rows.push({ asset: "sol", liability: L.solUsd, holdings: solHoldings, unpriced: true, unit: "SOL" });
    } else {
      rows.push({ asset: "sol", liability: px > 0 ? L.solUsd / px : 0, holdings: solHoldings, unit: "SOL" });
    }
    if (chainReady()) {
      rows.push({ asset: "bull", liability: L.bull, holdings: await vaultTokenBalance("bull"), unit: "BULL" });
      rows.push({ asset: "uwu", liability: L.uwu, holdings: await vaultTokenBalance("uwu"), unit: "UWU" });
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
