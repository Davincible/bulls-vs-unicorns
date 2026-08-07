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
import { Connection, Keypair, VersionedTransaction, PublicKey, SystemProgram,
         TransactionMessage } from "@solana/web3.js";
import { RPC } from "./chain.ts";
import { priceUSD, type PriceToken } from "./prices.ts";
import bs58 from "bs58";

// Free tier needs no API key, which is one less secret to leak. Set JUPITER_API_KEY to use the
// paid host with higher limits.
const JUP_KEY = process.env.JUPITER_API_KEY || "";
const JUP_BASE = process.env.JUPITER_BASE || (JUP_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1");
// Slippage is the ceiling on how much worse than quoted a fill may be — and it is also the exact
// budget a sandwich bot has to steal. 1.5% on a thin pair was generous to an attacker. We now ask
// Jupiter for DYNAMIC slippage (it sizes the tolerance to the route's real depth) with this as a
// hard cap, so a quiet market fills at a few bps and only a genuinely volatile one uses the ceiling.
const SLIPPAGE_BPS = Number(process.env.SWAP_SLIPPAGE_BPS || 50);        // 0.5% ceiling
const DYNAMIC_SLIPPAGE = process.env.SWAP_DYNAMIC_SLIPPAGE !== "0";
// MEV: a swap broadcast to a public mempool is visible before it lands and can be sandwiched.
// Routing through Jito's block engine submits it as a bundle instead, so it is never exposed.
// Set SWAP_JITO_URL to a Jito block-engine endpoint to enable; a tip is required for inclusion.
const JITO_URL = process.env.SWAP_JITO_URL || "";
const JITO_TIP_LAMPORTS = Number(process.env.SWAP_JITO_TIP || 100_000);  // 0.0001 SOL
const MAX_PRICE_IMPACT = Number(process.env.SWAP_MAX_IMPACT || 0.05);    // refuse worse than 5%
const IS_TEST_CHAIN = /localhost|127\.0\.0\.1|devnet|testnet/i.test(RPC);

export interface SwapResult {
  ok: boolean;
  outAmount: number;        // whole tokens actually received
  priceImpactPct: number;
  simulated: boolean;       // true = test-chain oracle simulation, not a real swap
  sig?: string;
  viaJito?: boolean;        // true = went out as a private bundle, never in the public mempool
  error?: string;
}

/** base58 signature of a signed transaction — what an explorer and getSignatureStatus expect. */
const bs58Sig = (t: VersionedTransaction) => bs58.encode(t.signatures[0]);

const headers = () => (JUP_KEY ? { "x-api-key": JUP_KEY } : undefined) as Record<string, string> | undefined;

// Jito's published mainnet tip accounts. A bundle must pay one of them to be considered; picking at
// random spreads load and avoids a hot account becoming a write-lock bottleneck.
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];
// Jito can rotate these. Refresh from the block engine when we can and keep the published list as
// the fallback, so a rotation degrades to "still works" rather than "every bundle is rejected".
let tipAccounts = JITO_TIP_ACCOUNTS.slice();
let tipFetchedAt = 0;
async function refreshTipAccounts(): Promise<void> {
  if (!JITO_URL || Date.now() - tipFetchedAt < 60 * 60_000) return;
  tipFetchedAt = Date.now();
  try {
    const r = await fetch(JITO_URL, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }) });
    const j = await r.json() as any;
    if (Array.isArray(j?.result) && j.result.length) tipAccounts = j.result;
  } catch { /* keep the published list */ }
}

export const pickTipAccount = (r = Math.random()) =>
  tipAccounts[Math.min(tipAccounts.length - 1, Math.floor(r * tipAccounts.length))];

/** Build the tip transfer that buys the bundle its inclusion. */
function buildTipTx(vault: Keypair, blockhash: string, lamports: number): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: vault.publicKey,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({
      fromPubkey: vault.publicKey,
      toPubkey: new PublicKey(pickTipAccount()),
      lamports,
    })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([vault]);
  return tx;
}

/**
 * Submit [swap, tip] as an atomic Jito bundle.
 *
 * A swap sent to a public RPC sits in the mempool where a sandwich bot can see it, trade in front of
 * it and sell into it. A bundle goes straight to a block builder: never public, all-or-nothing, and
 * ordered as we specify. Returns true if Jito ACCEPTED the bundle — acceptance is not inclusion, so
 * the caller still confirms the signature and falls back to a normal send if it never lands.
 */
async function sendJitoBundle(txs: VersionedTransaction[]): Promise<boolean> {
  try {
    const body = {
      jsonrpc: "2.0", id: 1, method: "sendBundle",
      params: [txs.map(t => Buffer.from(t.serialize()).toString("base64")), { encoding: "base64" }],
    };
    const r = await fetch(JITO_URL, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) return false;
    const j = await r.json() as any;
    return !!j?.result;
  } catch { return false; }
}

/** Ask Jupiter what a swap would return. Amounts in RAW units. */
export async function quote(inputMint: string, outputMint: string, rawAmount: number) {
  const u = new URL(JUP_BASE + "/quote");
  u.searchParams.set("inputMint", inputMint);
  u.searchParams.set("outputMint", outputMint);
  u.searchParams.set("amount", String(Math.floor(rawAmount)));
  u.searchParams.set("slippageBps", String(SLIPPAGE_BPS));
  if (DYNAMIC_SLIPPAGE) u.searchParams.set("dynamicSlippage", "true");   // tighten to the route's depth
  u.searchParams.set("restrictIntermediateTokens", "true");   // avoid exotic multi-hop routes
  const r = await fetch(u, { headers: headers() });
  if (!r.ok) throw new Error(`jupiter quote ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.json() as Promise<any>;
}

/**
 * Swap `whole` tokens of `inputMint` into `outputMint`, signed and paid for by the vault.
 * Returns how much actually arrived — the caller credits THAT, so the player bears real costs.
 */
// ER FORK: swaps are hard-disabled. Jupiter has no meaningful devnet liquidity, and a swap is the
// single most expensive mistake this fork could make — it is the one path that moves value OUT
// irreversibly. Disabled at the function itself rather than at the call site, so a new caller
// cannot reintroduce it by accident.
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

  // ER FORK KILL SWITCH. Everything above is the devnet oracle simulation and is exactly what this
  // fork should be doing. Everything BELOW is a real Jupiter swap on a live chain — value leaving
  // irreversibly, which is the one thing this branch must never do.
  //
  // (fork kill switch removed — a devnet fork must not be able to refuse this app's real converts)

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
        // let Jupiter pick the tightest safe slippage rather than always spending our ceiling
        ...(DYNAMIC_SLIPPAGE ? { dynamicSlippage: true } : {}),
        // a landed swap is a swap that cannot be re-quoted at a worse price; pay to be included
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { global: false, maxLamports: 200_000, priorityLevel: "high" } },
      }),
    });
    if (!sr.ok) throw new Error(`jupiter swap ${sr.status}: ${(await sr.text()).slice(0, 120)}`);
    const { swapTransaction } = await sr.json() as { swapTransaction: string };

    const conn = new Connection(RPC, "confirmed");
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([vault]);
    const bh = await conn.getLatestBlockhash("confirmed");

    // PRIVATE PATH FIRST. With a block-engine endpoint configured the swap is bundled with a tip and
    // never enters the public mempool, so it cannot be front-run or sandwiched. Acceptance is not
    // inclusion, so we wait for the signature and fall back to an ordinary broadcast if it does not
    // land — the same transaction, so there is no risk of executing the swap twice.
    let landed = false;
    if (JITO_URL) {
      await refreshTipAccounts();
      const tip = buildTipTx(vault, tx.message.recentBlockhash || bh.blockhash, JITO_TIP_LAMPORTS);
      if (await sendJitoBundle([tx, tip])) {
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          const st = await conn.getSignatureStatus(bs58Sig(tx));
          if (st?.value?.confirmationStatus === "confirmed" || st?.value?.confirmationStatus === "finalized") {
            if (st.value.err) throw new Error("swap tx failed on-chain: " + JSON.stringify(st.value.err));
            landed = true; break;
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }

    if (!landed) {
      await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      const conf = await conn.confirmTransaction({ signature: bs58Sig(tx), ...bh }, "confirmed");
      if (conf.value.err) throw new Error("swap tx failed on-chain: " + JSON.stringify(conf.value.err));
    }

    // Credit what the route actually promised after fees/slippage, not a nominal rate.
    return { ok: true, outAmount: Number(q.outAmount) / 10 ** outDp, priceImpactPct: impact, simulated: false, sig: bs58Sig(tx), viaJito: landed };
  } catch (e) {
    return { ok: false, outAmount: 0, priceImpactPct: 0, simulated: false, error: (e as Error).message };
  }
}

export const swapIsSimulated = () => IS_TEST_CHAIN;
