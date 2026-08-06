// Seed real, on-chain-funded bot wallets.
//
//   npm run seed:bots                      # 20 wallets against the live engine
//   BOT_WALLETS=20 SOL_EACH=0.05 TOK_EACH=200 DEPOSIT_EACH=150 npm run seed:bots
//   ENGINE_WS=ws://localhost:8090 npm run seed:bots
//
// For each wallet: send it SOL from the vault (fees), mint it tokens, then make a REAL deposit
// into the vault through the engine's normal protocol (auth -> buildDeposit -> sign -> send ->
// deposit). The result is a bot whose ledger balance is backed by tokens the vault actually holds.
//
// Idempotent: wallets already holding a deposited balance are skipped, so it is safe to re-run.
import { Connection, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import nacl from "tweetnacl";
import { RPC } from "./chain.ts";
import { faucet, withdrawSol, solBalance, chainReady, vaultPubkey, transferFromVault } from "./chain-ops.ts";
import { ensureBotWallets, keypairOf, writeBotPool } from "./bot-wallets.ts";

const N = Number(process.env.BOT_WALLETS || 20);
const SOL_EACH = Number(process.env.SOL_EACH || 0.05);
const TOK_EACH = Number(process.env.TOK_EACH || 200);
const DEPOSIT_EACH = Number(process.env.DEPOSIT_EACH || 150);
const ENGINE_WS = process.env.ENGINE_WS || "wss://bulls-arena-engine.fly.dev";
const IS_TEST_CHAIN = /localhost|127\.0\.0\.1|devnet|testnet/i.test(RPC);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const conn = new Connection(RPC, "confirmed");

function ask(ws: WebSocket, payload: unknown, wants: string[], ms = 30000): Promise<any> {
  return new Promise(resolve => {
    const on = (ev: MessageEvent) => { const m = JSON.parse(ev.data as string); if (wants.includes(m.t)) { done(); resolve(m); } };
    const done = () => { clearTimeout(t); ws.removeEventListener("message", on); };
    const t = setTimeout(() => { done(); resolve(null); }, ms);
    ws.addEventListener("message", on);
    if (payload) ws.send(JSON.stringify(payload));
  });
}
const sign = (nonce: string, sk: Uint8Array) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(nonce), sk)).toString("base64");

// Freshly created token accounts are not immediately visible at "confirmed", so spl-token helpers
// intermittently throw TokenAccountNotFoundError right after they create an ATA. Retry with a pause
// rather than failing the whole wallet.
async function step<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: any;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; if (i < tries) { console.log(`      ${label}: ${(e as Error).message || e} - retry ${i}/${tries - 1}`); await sleep(1500 * i); } }
  }
  throw new Error(`${label} failed after ${tries}: ${last?.message || last}`);
}

async function main() {
  // Minting and spending real value — never let this fire at mainnet by accident.
  if (!IS_TEST_CHAIN && process.env.I_UNDERSTAND_MAINNET !== "1") {
    console.error(`REFUSING: ${RPC} is not a test chain. This mints tokens and spends SOL.`);
    console.error(`On mainnet bots must be funded with REAL purchased tokens - set I_UNDERSTAND_MAINNET=1 only if that is what you mean.`);
    process.exit(1);
  }
  if (!chainReady()) { console.error("chain not configured (missing mints)"); process.exit(1); }
  // Loud reminder of WHICH mints we're about to use. The default devnet.json points at
  // local-validator mints that do not exist on public devnet - minting against them fails with a
  // confusing TokenAccountNotFoundError. Set CHAIN_CONFIG=./devnet-public.json for public devnet.
  console.log(`chain config: ${process.env.CHAIN_CONFIG || "devnet.json (default)"}  rpc: ${RPC.replace(/([?&](api-key|key|token)=)[^&]+/i, "$1***")}`);

  const vaultSol = await solBalance(vaultPubkey());
  const needSol = N * SOL_EACH;
  console.log(`vault ${vaultPubkey()} holds ${vaultSol.toFixed(4)} SOL; seeding ${N} wallets needs ~${needSol.toFixed(2)} SOL`);
  if (vaultSol < needSol + 0.1) { console.error("vault SOL too low - top it up first"); process.exit(1); }

  const rows = ensureBotWallets(N);
  const ws = new WebSocket(ENGINE_WS);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine connect timeout")), 15000);
    ws.addEventListener("open", () => { clearTimeout(t); res(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("engine connect failed")); }, { once: true });
  });
  await ask(ws, null, ["chain"], 10000);
  console.log(`connected to ${ENGINE_WS}\n`);

  let funded = 0, skipped = 0, failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], kp = keypairOf(row), w = row.pubkey;
    const tag = `[${String(i + 1).padStart(2)}/${rows.length}] ${w.slice(0, 6)}…`;
    try {
      // auth as this bot so the engine will honour its deposits
      const c = await ask(ws, { t: "authChallenge", wallet: w }, ["authChallenge"], 15000);
      if (!c?.nonce) { console.log(`${tag} auth challenge failed`); failed++; continue; }
      const a = await ask(ws, { t: "authVerify", wallet: w, signature: sign(c.nonce, kp.secretKey) }, ["authResult"], 15000);
      if (!a?.ok) { console.log(`${tag} auth rejected`); failed++; continue; }

      const bal = await ask(ws, { t: "getBalance", wallet: w }, ["balance"], 15000);
      if (bal && (bal.bull >= DEPOSIT_EACH * 0.9)) { console.log(`${tag} already funded (bull ${bal.bull.toFixed(1)}) - skip`); skipped++; continue; }

      // 1. SOL for its own transaction fees
      const haveSol = await solBalance(w);
      if (haveSol < SOL_EACH * 0.5) { await step("sol", () => withdrawSol(w, SOL_EACH)); await sleep(800); }

      // 2. tokens. On a test chain the vault holds mint authority so we can mint. On mainnet
      //    ANSEM/UWU have NO mint authority (fixed supply), so the float must be tokens we actually
      //    bought and now transfer out of the vault.
      const give = IS_TEST_CHAIN
        ? (side: "bull" | "uwu") => faucet(w, side, TOK_EACH)
        : (side: "bull" | "uwu") => transferFromVault(w, side, TOK_EACH);
      await step("fund bull", () => give("bull")); await sleep(800);
      await step("fund uwu",  () => give("uwu"));  await sleep(800);

      // 3. real deposits, through the same path a player uses
      for (const side of ["bull", "uwu"] as const) {
        const built = await ask(ws, { t: "buildDeposit", wallet: w, side, amount: DEPOSIT_EACH }, ["depositTx", "error"], 30000);
        if (built?.t !== "depositTx") { console.log(`${tag} ${side} build failed: ${built?.msg || "no reply"}`); failed++; continue; }
        const tx = Transaction.from(Buffer.from(built.txB64, "base64"));
        tx.partialSign(kp);
        const sig = await conn.sendRawTransaction(tx.serialize());
        await conn.confirmTransaction(sig, "confirmed");
        await ask(ws, { t: "deposit", wallet: w, side, sig }, ["balance", "error"], 30000);
        await sleep(300);
      }
      const after = await ask(ws, { t: "getBalance", wallet: w }, ["balance"], 15000);
      console.log(`${tag} funded -> bull ${(after?.bull ?? 0).toFixed(1)}  uwu ${(after?.uwu ?? 0).toFixed(1)}`);
      funded++;
    } catch (e) {
      const err = e as any;
      console.log(`${tag} FAILED:`, err?.message || String(err));
      if (err?.logs) console.log("   chain logs:", JSON.stringify(err.logs).slice(0, 200));
      failed++;
    }
    await sleep(600);   // stay friendly to the RPC
  }

  console.log(`\nseeded: ${funded} funded, ${skipped} already done, ${failed} failed`);
  // Publish the ADDRESS list for the engine. It never needs the private keys - keeping them off
  // the production server means a compromised engine cannot move bot funds.
  writeBotPool(rows.map(r => r.pubkey));
  console.log("\nbot-wallets.json holds the SECRET keys - keep it on this machine only.");
  console.log("Give the engine only the ADDRESSES:\n");
  console.log(`  fly secrets set BOT_POOL="${rows.map(r => r.pubkey).join(",")}" --app bulls-arena-engine\n`);
  ws.close();
  process.exit(failed && !funded ? 1 : 0);
}
main().catch(e => { console.error("seed-bots failed:", e.message); process.exit(1); });
