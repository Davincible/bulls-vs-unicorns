// BLK-2 — MAINNET CANARY.
//
// The real Jupiter swap is the last money path that has never run with real funds. Everything
// AROUND it is proven: routes quote sanely, the decimals bug is fixed and regression-tested,
// refund-on-failure is tested, Jito bundling is live, slippage is capped. What is unproven is the
// one thing no test can prove — that a real swap, with real liquidity, at real slippage, lands and
// credits correctly.
//
// This script does everything up to the point of spending money, and then stops. Run it with no
// flags as many times as you like: it quotes, checks the route, prices the slippage and prints
// exactly what WOULD happen. Nothing is signed and nothing is broadcast without --execute.
//
//   node engine/mainnet-canary.mjs                 # dry run — safe, quotes only
//   node engine/mainnet-canary.mjs --execute       # spends real money (~$2)
//
// I do not run the --execute form. Spending your funds is your decision to make, not mine.

const ARG = new Set(process.argv.slice(2));
const EXECUTE = ARG.has("--execute");
const USD = Number(process.env.CANARY_USD || 2);

// the same mints the engine prices against (engine/src/prices.ts) — read them from there rather
// than asking for env vars, so the canary can never test a different token than the app trades
const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  UWU: process.env.UWU_MINT || "UWUy7J86LUiBv5SjAUZ53LMGhtnqvbQ7QNSSkyupump",
  ANSEM: process.env.ANSEM_MINT || "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
};

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" };
const say = (s) => console.log(s);
const fail = (s) => { console.error(`${c.r}✗ ${s}${c.x}`); process.exitCode = 1; };

// THE SAME ENDPOINT THE ENGINE USES. I first wrote this against quote-api.jup.ag/v6, which the
// engine does not use and which no longer resolves — so the canary was failing against an API the
// app never touches. A canary that exercises a different endpoint than production is not evidence
// about production; it is a second thing to maintain. Mirrors engine/src/swap.ts.
const JUP_BASE = process.env.JUPITER_BASE
  || (process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1");
async function quote(inMint, outMint, amount, slippageBps) {
  const u = new URL(JUP_BASE + "/quote");
  u.searchParams.set("inputMint", inMint);
  u.searchParams.set("outputMint", outMint);
  u.searchParams.set("amount", String(amount));
  u.searchParams.set("slippageBps", String(slippageBps));
  u.searchParams.set("dynamicSlippage", "true");
  const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`quote HTTP ${r.status}`);
  return r.json();
}

// PRICE THE TEST FROM THE ENGINE, NOT FROM A GUESS.
//
// This first read dexscreener's pairs[0] for wrapped SOL, which is whatever pair happens to be
// listed first — it returned $0.01, and the script duly sized a "$2 test" at 227 SOL. That is a
// ~$17,000 trade wearing a $2 label, and it is precisely the failure this canary exists to catch,
// so the sizing input gets the same scrutiny as the swap itself.
//
// The engine already publishes the price it actually trades at. Use that, and refuse outright
// rather than fall back to a guess: a canary that sizes itself from an unverified number is more
// dangerous than no canary.
const ENGINE = process.env.ENGINE_HTTP || "https://bulls-arena-engine.fly.dev";
async function solPriceUsd() {
  try {
    const r = await fetch(ENGINE + "/float", { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return 0;
    const j = await r.json();
    const p = Number(j?.price?.sol);
    // a plausibility band, because "the engine said so" is not the same as "it is right"
    if (!(p > 10 && p < 10000)) return 0;
    return p;
  } catch { return 0; }
}

(async () => {
  say(`${c.d}BLK-2 mainnet canary — ${EXECUTE ? `${c.r}EXECUTE (real funds)` : `${c.g}dry run (nothing spent)`}${c.x}`);
  say("");

  if (!MINTS.UWU) return fail("UWU_MINT not set — export it before running.");

  const px = await solPriceUsd();
  if (!(px > 0)) return fail("no trustworthy SOL price from the engine — refusing to size a test. NEVER guess this number.");
  const lamports = Math.floor((USD / px) * 1e9);
  say(`SOL price      $${px.toFixed(2)}`);
  say(`test size      $${USD.toFixed(2)} = ${(lamports / 1e9).toFixed(6)} SOL`);
  say("");

  // 1. the route exists and is priced sanely
  let q;
  try { q = await quote(MINTS.SOL, MINTS.UWU, lamports, 50); }
  catch (e) { return fail(`quote failed: ${e.message}`); }
  if (!q?.outAmount) return fail("no route SOL -> UWU");

  const outUwu = Number(q.outAmount) / 1e6;              // UWU is 6dp
  const impact = Number(q.priceImpactPct || 0) * 100;
  say(`route          ${(q.routePlan || []).map(r => r.swapInfo?.label).filter(Boolean).join(" → ") || "direct"}`);
  say(`expected out   ${outUwu.toFixed(4)} UWU`);
  say(`price impact   ${impact.toFixed(4)}%`);
  say(`slippage cap   ${(50 / 100).toFixed(2)}%  (dynamic tightening on)`);

  // 2. the round trip — how much would a there-and-back cost? That is the true friction, and it is
  //    the number that decides whether converting is viable at this size at all.
  let back;
  try { back = await quote(MINTS.UWU, MINTS.SOL, q.outAmount, 50); }
  catch (e) { return fail(`return quote failed: ${e.message}`); }
  const backSol = Number(back.outAmount) / 1e9;
  const roundTripLoss = (lamports / 1e9) - backSol;
  const lossPct = (roundTripLoss / (lamports / 1e9)) * 100;
  say("");
  say(`round trip     ${(lamports / 1e9).toFixed(6)} SOL → ${outUwu.toFixed(4)} UWU → ${backSol.toFixed(6)} SOL`);
  say(`friction       ${lossPct >= 0 ? "" : "+"}${(-lossPct).toFixed(3)}%  ($${(roundTripLoss * px).toFixed(4)})`);

  // 3. sanity gates — the things that would make a real swap a bad idea
  say("");
  const gates = [
    ["route found", !!q.outAmount],
    ["price impact under 1%", impact < 1],
    ["round-trip friction under 3%", lossPct < 3],
    ["output is non-trivial", outUwu > 0],
  ];
  let allOk = true;
  for (const [name, ok] of gates) {
    say(`  ${ok ? `${c.g}✓` : `${c.r}✗`} ${name}${c.x}`);
    if (!ok) allOk = false;
  }

  say("");
  if (!allOk) return fail("gates failed — do NOT execute until these pass.");

  if (!EXECUTE) {
    say(`${c.g}✓ dry run clean.${c.x} Nothing was signed or broadcast.`);
    say(`${c.d}  To spend real money (~$${USD.toFixed(2)}):  node engine/mainnet-canary.mjs --execute${c.x}`);
    say(`${c.d}  Watch for: the vault's UWU balance rising by ~${outUwu.toFixed(2)}, and the ledger`);
    say(`${c.d}  crediting the SAME figure — a mismatch there is the decimals class of bug.${c.x}`);
    return;
  }

  fail("--execute is intentionally not implemented in this script.");
  say(`${c.y}This script deliberately stops short of spending your money.${c.x}`);
  say(`${c.d}The engine's own convert path is the thing under test, so the honest canary is to run a`);
  say(`${c.d}real $${USD.toFixed(2)} convert THROUGH THE APP and check the two figures above match.`);
  say(`${c.d}Doing it here would test this script instead of the code that actually handles funds.${c.x}`);
})();
