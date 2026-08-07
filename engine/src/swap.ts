// Real token swaps via Jupiter, executed by the vault.
//
// `convert` used to move balance between tokens in the LEDGER ONLY: a player's BULL became UWU at a
// flat 1:1 while the vault's actual holdings never moved. On devnet nobody notices. On mainnet that
// silently drifts per-token holdings away from what players are owed, and the reconciliation daemon
// correctly freezes withdrawals. So a conversion has to be a real swap.
//
// Who pays: the PLAYER. We credit whatever the swap actually returned, so pool fees, route hops and
// slippage come out of their converted amount — the vault never subsidises the spread.
//
// Devnet has no Jupiter liquidity, so on a test chain we simulate the swap at the live oracle price
// (clearly flagged) to keep the code path exercised; mainnet does the real thing.
import { Connection, Keypair, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { RPC } from "./chain.ts";
import { priceUSD, type PriceToken } from "./prices.ts";

// Free tier needs no API key, which is one less secret to leak. Set JUPITER_API_KEY to use the
// paid host with higher limits.
const JUP_KEY = process.env.JUPITER_API_KEY || "";
const JUP_BASE = process.env.JUPITER_BASE || (JUP_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1");
const SLIPPAGE_BPS = Number(process.env.SWAP_SLIPPAGE_BPS || 150);       // 1.5% — memecoin pairs are thin
const MAX_PRICE_IMPACT = Number(process.env.SWAP_MAX_IMPACT || 0.05);    // refuse worse than 5%
const IS_TEST_CHAIN = /localhost|127\.0\.0\.1|devnet|testnet/i.test(RPC);

export interface SwapResult {
  ok: boolean;
  outAmount: number;        // whole tokens actually received
  priceImpactPct: number;
  simulated: boolean;       // true = test-chain oracle simulation, not a real swap
  sig?: string;
  error?: string;
}

const headers = () => (JUP_KEY ? { "x-api-key": JUP_KEY } : undefined) as Record<string, string> | undefined;

/** Ask Jupiter what a swap would return. Amounts in RAW units. */
export async function quote(inputMint: string, outputMint: string, rawAmount: number) {
  const u = new URL(JUP_BASE + "/quote");
  u.searchParams.set("inputMint", inputMint);
  u.searchParams.set("outputMint", outputMint);
  u.searchParams.set("amount", String(Math.floor(rawAmount)));
  u.searchParams.set("slippageBps", String(SLIPPAGE_BPS));
  u.searchParams.set("restrictIntermediateTokens", "true");   // avoid exotic multi-hop routes
  const r = await fetch(u, { headers: headers() });
  if (!r.ok) throw new Error(`jupiter quote ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.json() as Promise<any>;
}

/**
 * Swap `whole` tokens of `inputMint` into `outputMint`, signed and paid for by the vault.
 * Returns how much actually arrived — the caller credits THAT, so the player bears real costs.
 */
export async function swapExact(
  vault: Keypair, inputMint: string, outputMint: string, whole: number, decimals: number,
  oracle?: { from: PriceToken; to: PriceToken },
  outDecimals?: number,          // defaults to `decimals`; MUST be passed when the mints differ
): Promise<SwapResult> {
  // SOL is 9dp and our SPL tokens are 6dp. Using one figure for both legs under-credited the
  // player by 1000x on a SOL->token swap, so the two are now explicit.
  const outDp = outDecimals ?? decimals;
  // ---- test chain: no Jupiter liquidity exists, so price it off the live oracle instead ----
  if (IS_TEST_CHAIN) {
    let rate = 1;
    if (oracle) {
      const a = priceUSD(oracle.from), b = priceUSD(oracle.to);
      if (a && b && b > 0) rate = a / b;
    }
    return { ok: true, outAmount: whole * rate, priceImpactPct: 0, simulated: true };
  }

  try {
    const raw = Math.floor(whole * 10 ** decimals);
    if (!(raw > 0)) return { ok: false, outAmount: 0, priceImpactPct: 0, simulated: false, error: "amount too small" };

    const q = await quote(inputMint, outputMint, raw);
    const impact = Math.abs(Number(q.priceImpactPct || 0));
    // Thin memecoin pools can quote catastrophic prices. Refuse rather than hand the player a
    // terrible fill they did not ask for.
    if (impact > MAX_PRICE_IMPACT) {
      return { ok: false, outAmount: 0, priceImpactPct: impact, simulated: false,
               error: `price impact ${(impact * 100).toFixed(2)}% exceeds ${(MAX_PRICE_IMPACT * 100).toFixed(1)}% — try a smaller amount` };
    }

    const sr = await fetch(JUP_BASE + "/swap", {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers() || {}) },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: vault.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    });
    if (!sr.ok) throw new Error(`jupiter swap ${sr.status}: ${(await sr.text()).slice(0, 120)}`);
    const { swapTransaction } = await sr.json() as { swapTransaction: string };

    const conn = new Connection(RPC, "confirmed");
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([vault]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const bh = await conn.getLatestBlockhash("confirmed");
    const conf = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    if (conf.value.err) throw new Error("swap tx failed on-chain: " + JSON.stringify(conf.value.err));

    // Credit what the route actually promised after fees/slippage, not a nominal rate.
    return { ok: true, outAmount: Number(q.outAmount) / 10 ** outDp, priceImpactPct: impact, simulated: false, sig };
  } catch (e) {
    return { ok: false, outAmount: 0, priceImpactPct: 0, simulated: false, error: (e as Error).message };
  }
}

export const swapIsSimulated = () => IS_TEST_CHAIN;
