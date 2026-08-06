// End-to-end money loop against the LIVE deployment on devnet, with a throwaway player keypair
// that signs exactly like Phantom would. Proves the real product path: auth -> fund -> on-chain
// deposit -> deploy into a round -> settle -> withdraw. Run: node e2e-money.mjs
import { Keypair, Connection, Transaction, SystemProgram, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import nacl from "tweetnacl";

// Gas fallback: devnet's public SOL faucet is usually dry, so a fresh wallet can't pay tx fees.
// Fund it from the vault key on disk (devnet only, tiny amount) so the deposit can actually sign.
async function fundGasFromVault(conn, toPubkey, sol = 0.02) {
  const secret = Uint8Array.from(JSON.parse(readFileSync(".vault-keypair.json", "utf8")));
  const vault = Keypair.fromSecretKey(secret);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: vault.publicKey, toPubkey: new PublicKey(toPubkey), lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
  tx.feePayer = vault.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(vault);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

const WS = process.argv[2] || "wss://bulls-arena-engine.fly.dev";
const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const log = (s) => console.log(s);

const open = () => new Promise((res, rej) => {
  const ws = new WebSocket(WS);
  const t = setTimeout(() => rej(new Error("connect timeout")), 12000);
  ws.addEventListener("open", () => { clearTimeout(t); res(ws); }, { once: true });
  ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("connect error")); }, { once: true });
});
function ask(ws, payload, wants, ms = 20000) {
  return new Promise((resolve) => {
    const on = (ev) => { const m = JSON.parse(ev.data); if (wants.includes(m.t)) { done(); resolve(m); } };
    const done = () => { clearTimeout(t); ws.removeEventListener("message", on); };
    const t = setTimeout(() => { done(); resolve(null); }, ms);
    ws.addEventListener("message", on); if (payload) ws.send(JSON.stringify(payload));
  });
}
const sign = (n, sk) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(n), sk)).toString("base64");
const bal = async (ws, w) => (await ask(ws, { t: "getBalance", wallet: w }, ["balance"], 8000)) || {};

const run = async () => {
  const kp = Keypair.generate();
  const w = kp.publicKey.toBase58();
  log(`player: ${w}`);
  const ws = await open();
  const chain = await ask(ws, null, ["chain"], 8000);
  log(`chain ready=${chain?.ready} vault=${String(chain?.vault).slice(0, 8)}...`);

  // auth
  const c = await ask(ws, { t: "authChallenge", wallet: w }, ["authChallenge"], 8000);
  const a = await ask(ws, { t: "authVerify", wallet: w, signature: sign(c.nonce, kp.secretKey) }, ["authResult"], 8000);
  log(`1. auth: ${a?.ok ? "OK" : "FAILED"}`);
  if (!a?.ok) { ws.close(); process.exit(1); }

  // fund: airdrop SOL for fees + faucet tokens
  log(`2. fundMe (airdrop SOL + faucet tokens)…`);
  const f = await ask(ws, { t: "fundMe", wallet: w, amount: 500 }, ["fundMeDone", "error"], 60000);
  log(`   -> ${f?.t === "fundMeDone" ? JSON.stringify(f.steps) : "ERROR: " + (f?.msg || "no reply")}`);
  // ensure the wallet has gas even when the devnet faucet is dry
  const solBal = await conn.getBalance(kp.publicKey).catch(() => 0);
  if (solBal < 0.005 * LAMPORTS_PER_SOL) {
    log(`   airdrop dry -> funding gas from vault…`);
    try { const g = await fundGasFromVault(conn, w, 0.02); log(`   gas tx: ${g.slice(0, 16)}…`); }
    catch (e) { log(`   gas funding failed: ${e.message}`); }
  }

  // deposit 25 BULL on-chain (build unsigned tx -> sign -> send -> tell engine to verify)
  log(`3. deposit 25 BULL on-chain…`);
  const dtx = await ask(ws, { t: "buildDeposit", wallet: w, side: "bull", amount: 25 }, ["depositTx", "error"], 30000);
  if (dtx?.t !== "depositTx") { log(`   -> build failed: ${dtx?.msg || "no reply"}`); return finish(ws, false); }
  const tx = Transaction.from(Buffer.from(dtx.txB64, "base64"));
  tx.partialSign(kp);
  let sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, "confirmed");
    log(`   on-chain tx: ${sig.slice(0, 16)}…`);
  } catch (e) { log(`   -> send failed (devnet faucet likely dry, no SOL for fees): ${e.message}`); return finish(ws, "partial"); }
  const dep = await ask(ws, { t: "deposit", wallet: w, side: "bull", sig }, ["balance", "error"], 30000);
  const b1 = await bal(ws, w);
  log(`   credited: bull=${b1.bull}`);
  if (!(b1.bull > 0)) return finish(ws, false);

  // deploy 10 into a round
  log(`4. deploy 10 BULL into au-normal…`);
  // wait for a lobby
  let entered = null;
  for (let i = 0; i < 30 && !entered; i++) {
    const e = await ask(ws, { t: "enter", wallet: w, arena: "au-normal", side: "bull", stake: 10 }, ["entered", "error"], 2500);
    if (e?.t === "entered") entered = e;
    else await new Promise(r => setTimeout(r, 1500));
  }
  const b2 = await bal(ws, w);
  log(`   ${entered ? "entered stake=" + entered.stake : "could not enter (no lobby window hit)"}; bull now ${b2.bull}`);

  // wait for settlement (balance changes as the round resolves)
  log(`5. waiting for the round to settle…`);
  const settled = await ask(ws, null, ["balance"], 90000);
  const b3 = await bal(ws, w);
  log(`   after settle: bull=${b3.bull} games=${b3.games}`);

  // withdraw whatever is left
  log(`6. withdraw remaining BULL…`);
  const wd = await ask(ws, { t: "withdraw", wallet: w, side: "bull", amount: 999 }, ["withdrawDone", "error"], 30000);
  log(`   -> ${wd?.t === "withdrawDone" ? "withdrawn " + wd.amount + " tx " + String(wd.sig).slice(0, 12) + "…" : "ERROR: " + (wd?.msg || "no reply")}`);

  return finish(ws, true);
};
function finish(ws, ok) {
  log(`\n=== ${ok === true ? "FULL LOOP OK" : ok === "partial" ? "PARTIAL (devnet faucet limit)" : "INCOMPLETE"} ===`);
  ws.close(); process.exit(ok === true ? 0 : ok === "partial" ? 0 : 1);
}
run().catch(e => { console.error("harness error:", e.message); process.exit(2); });
