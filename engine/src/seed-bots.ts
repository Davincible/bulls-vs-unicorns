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
import { RPC, IS_TEST_CHAIN } from "./chain.ts";
import { faucet, withdrawSol, solBalance, chainReady, vaultPubkey, transferFromVault,
         sendSolFrom, transferTokensFrom, tokenBalanceOf } from "./chain-ops.ts";
import { Keypair } from "@solana/web3.js";
import { readFileSync as _read, existsSync as _exists } from "node:fs";
import { ensureBotWallets, keypairOf, writeBotPool } from "./bot-wallets.ts";

const N = Number(process.env.BOT_WALLETS || 20);
const SOL_EACH = Number(process.env.SOL_EACH || 0.05);
const TOK_EACH = Number(process.env.TOK_EACH || 200);
const DEPOSIT_EACH = Number(process.env.DEPOSIT_EACH || 150);
// ANSEM and UWU differ ~6x in price, so an equal TOKEN count is a wildly unequal DOLLAR amount.
// Per-token overrides let each side of the book be funded to the same value.
const TOK_BULL = Number(process.env.TOK_BULL || TOK_EACH);
const TOK_UWU = Number(process.env.TOK_UWU || TOK_EACH);
const DEP_BULL = Number(process.env.DEP_BULL || DEPOSIT_EACH);
const DEP_UWU = Number(process.env.DEP_UWU || DEPOSIT_EACH);
const tokFor = (side: "bull" | "uwu") => (side === "bull" ? TOK_BULL : TOK_UWU);
const depFor = (side: "bull" | "uwu") => (side === "bull" ? DEP_BULL : DEP_UWU);
// Native SOL deposited as GAME balance (not fees). Arenas with a SOL side need this or that
// army can never deploy. Ledger `sol` is USD units, so 0.1 SOL ~ $7 at current prices.
const SOL_DEPOSIT = Number(process.env.SOL_DEPOSIT || 0);
// SEED WALLET: a keypair the OPERATOR holds, used to fund the bots. Without it the float has to sit
// in the VAULT first - and the vault key lives on the server, so a server compromise would reach the
// entire float instead of only what players have actually deposited.
const SEED_KEYPAIR = process.env.SEED_KEYPAIR || "";
const seedKp: Keypair | null = SEED_KEYPAIR && _exists(SEED_KEYPAIR)
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(_read(SEED_KEYPAIR, "utf8"))))
  : null;
const ENGINE_WS = process.env.ENGINE_WS || "wss://bulls-arena-engine.fly.dev";

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

  // report on whichever wallet is actually paying
  const funder = seedKp ? seedKp.publicKey.toBase58() : vaultPubkey();
  if (seedKp) {
    console.log(`funding from SEED wallet ${funder}`);
    console.log(`  (the vault stays clean - it only ever receives player/bot deposits)`);
    for (const side of ["bull", "uwu"] as const) {
      console.log(`  seed holds ${(await tokenBalanceOf(funder, side)).toFixed(2)} ${side}`);
    }
  }
  const vaultSol = await solBalance(funder);
  const needSol = N * SOL_EACH;
  console.log(`funder holds ${vaultSol.toFixed(4)} SOL; seeding ${N} wallets needs ~${needSol.toFixed(2)} SOL`);
  if (vaultSol < needSol + 0.05) { console.error("funder SOL too low - top it up first"); process.exit(1); }

  console.log(`\nplan per bot: ${DEP_BULL} BULL, ${DEP_UWU} UWU` +
              (SOL_DEPOSIT > 0 ? `, ${SOL_DEPOSIT} SOL game balance` : "") +
              `, ${SOL_EACH} SOL fees`);
  console.log(`total across ${N} bots: ${(DEP_BULL*N).toFixed(2)} BULL, ${(DEP_UWU*N).toFixed(2)} UWU, ` +
              `${((SOL_DEPOSIT+SOL_EACH)*N).toFixed(3)} SOL\n`);

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
      // Skip only when EVERY leg this run is meant to fund is already there. Checking tokens alone
      // meant a top-up that added SOL float silently skipped every wallet that still held tokens.
      const tokensDone = bal && (DEP_BULL <= 0 || bal.bull >= DEP_BULL * 0.9) && (DEP_UWU <= 0 || bal.uwu >= DEP_UWU * 0.9);
      const solDone = SOL_DEPOSIT <= 0 || (bal && bal.sol > 0);
      if (tokensDone && solDone) { console.log(`${tag} already funded (bull ${bal.bull.toFixed(1)}, sol ${(bal.sol||0).toFixed(1)}) - skip`); skipped++; continue; }

      // 1. SOL for its own transaction fees
      const haveSol = await solBalance(w);
      if (haveSol < SOL_EACH * 0.5) {
        await step("sol", () => seedKp ? sendSolFrom(seedKp, w, SOL_EACH) : withdrawSol(w, SOL_EACH));
        await sleep(800);
      }

      // 2. tokens. On a test chain the vault holds mint authority so we can mint. On mainnet
      //    ANSEM/UWU have NO mint authority (fixed supply), so the float must be tokens we actually
      //    bought and now transfer out of the vault.
      const give = seedKp
        ? (side: "bull" | "uwu") => transferTokensFrom(seedKp, w, side, tokFor(side))  // operator float
        : IS_TEST_CHAIN
          ? (side: "bull" | "uwu") => faucet(w, side, tokFor(side))                    // devnet: mint
          : (side: "bull" | "uwu") => transferFromVault(w, side, tokFor(side));        // legacy fallback
      if (tokFor("bull") > 0) { await step("fund bull", () => give("bull")); await sleep(800); }
      if (tokFor("uwu")  > 0) { await step("fund uwu",  () => give("uwu"));  await sleep(800); }

      // 2b. SOL game balance. Arenas with a SOL side (as-*, us-*, 3-way) draw from the `sol`
      //     ledger field, which is USD units and only moves on a REAL native-SOL deposit. Without
      //     this the SOL army can never deploy, every round is one-sided, and the whole arena busts.
      if (SOL_DEPOSIT > 0) {
        try {
          await step("sol float", () => seedKp ? sendSolFrom(seedKp, w, SOL_DEPOSIT + 0.01)
                                              : withdrawSol(w, SOL_DEPOSIT + 0.01));
          await sleep(900);
          const built = await ask(ws, { t: "buildSolDeposit", wallet: w, sol: SOL_DEPOSIT }, ["solDepositTx", "error"], 30000);
          if (built?.t === "solDepositTx") {
            const stx = Transaction.from(Buffer.from(built.txB64, "base64"));
            stx.partialSign(kp);
            const ssig = await conn.sendRawTransaction(stx.serialize());
            await conn.confirmTransaction(ssig, "confirmed");
            await ask(ws, { t: "depositSol", wallet: w, sig: ssig }, ["depositSolDone", "error"], 30000);
            await sleep(300);
          } else console.log(`${tag} sol deposit unavailable: ${built?.msg || "no reply"}`);
        } catch (e) { console.log(`${tag} sol float failed: ${(e as Error).message.slice(0, 70)}`); }
      }

      // 3. real deposits, through the same path a player uses
      for (const side of ["bull", "uwu"] as const) {
        // amount 0 = this token is not part of the launch (e.g. a UWU/SOL-only room needs no ANSEM)
        if (!(depFor(side) > 0)) continue;
        const built = await ask(ws, { t: "buildDeposit", wallet: w, side, amount: depFor(side) }, ["depositTx", "error"], 30000);
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
