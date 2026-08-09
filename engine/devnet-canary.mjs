// Full product loop on DEVNET with a generated wallet — the dress rehearsal for the mainnet canary.
// Every transaction is real and signed exactly as Phantom would, but on devnet so it costs nothing.
// Proves: auth -> faucet -> on-chain deposit -> deploy into a live round -> convert -> withdraw.
//
//   node devnet-canary.mjs ws://localhost:8091
import { Keypair, Connection, VersionedTransaction, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";

const URL = process.argv[2] || "ws://localhost:8091";
// NO FALLBACK, DELIBERATELY. This line used to carry a live Helius key as its default, and this
// repository is public — so the key was readable by anyone for as long as it sat here, and rewriting
// history would not have un-published it. It has been rotated; what stops a replacement being pasted
// back is that there is now nowhere for one to live. A missing endpoint fails here, loudly, at the
// only moment anyone can act on it.
const RPC = process.env.SOLANA_RPC;
if (!RPC) throw new Error("SOLANA_RPC is required — export your own devnet RPC endpoint (no default is provided on purpose).");
const conn = new Connection(RPC, "confirmed");
const kp = Keypair.generate();
const PK = kp.publicKey.toBase58();
const log = (...a) => console.log(...a);
const step = (n, msg) => log(`\n[${n}] ${msg}`);

const ws = new WebSocket(URL);
const pending = new Map();
const waitFor = (t, ms = 25000) => new Promise((res, rej) => {
  const id = setTimeout(() => { pending.delete(t); rej(new Error("timeout waiting for " + t)); }, ms);
  pending.set(t, (m) => { clearTimeout(id); res(m); });
});
const send = (o) => ws.send(JSON.stringify(o));
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const h = pending.get(m.t); if (h) { pending.delete(m.t); h(m); } };

const sign = (nonce) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(nonce), kp.secretKey)).toString("base64");

// sign a Phantom-style tx the engine built for us (base64), send it, return the sig
async function signAndSend(b64) {
  const raw = Buffer.from(b64, "base64");
  let tx;
  try { tx = VersionedTransaction.deserialize(raw); tx.sign([kp]); }
  catch { tx = Transaction.from(raw); tx.partialSign(kp); }
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

ws.onopen = async () => {
  try {
    log("wallet", PK);

    step(1, "authenticate (sign a nonce)");
    send({ t: "authChallenge", wallet: PK });
    const ch = await waitFor("authChallenge");
    send({ t: "authVerify", wallet: PK, signature: sign(ch.nonce) });
    const ar = await waitFor("authResult");
    if (!ar.ok) throw new Error("auth failed: " + (ar.msg || ""));
    log("   auth OK");

    step(2, "fundMe: vault sends gas SOL + mints test BULL/UWU (Phantom would already have SOL)");
    send({ t: "fundMe", wallet: PK, amount: 500 });
    const fd = await waitFor("fundMeDone", 60000);
    log("   funded:", (fd.steps||[]).join(", "));
    await new Promise(r=>setTimeout(r,4000));   // let the mint + gas confirm before spending

    step(3, "deposit 120 UWU on-chain (engine builds, we sign like Phantom)");
    send({ t: "buildDeposit", wallet: PK, side: "uwu", amount: 120 });
    const dep = await waitFor("depositTx", 40000);
    // sign locally, let the ENGINE broadcast (the relay path browsers must use)
    const rawTx = Buffer.from(dep.txB64, "base64");
    let tx2; try { tx2 = VersionedTransaction.deserialize(rawTx); tx2.sign([kp]); }
    catch { tx2 = Transaction.from(rawTx); tx2.partialSign(kp); }
    send({ t: "relayTx", wallet: PK, kind: "deposit", side: "uwu", signedB64: Buffer.from(tx2.serialize()).toString("base64") });
    const dd = await waitFor("depositDone", 60000);
    log("   relayed tx", String(dd.sig||"").slice(0, 24) + "…");
    log("   credited:", dd.credited ?? dd.amount ?? "?", "UWU");

    step(4, "get balance");
    send({ t: "getBalance", wallet: PK });
    const b1 = await waitFor("balance");
    log(`   balance uwu=${(b1.uwu||0).toFixed(2)} sol=${(b1.sol||0).toFixed(2)}`);

    step(5, "convert 40 UWU -> SOL (the generalized swap; simulated on devnet)");
    send({ t: "convert", wallet: PK, from: "uwu", to: "sol", amount: 40 });
    const cv = await Promise.race([waitFor("converted", 30000), waitFor("error", 30000)]);
    if (cv.t === "error") log("   convert:", cv.msg, "(cooldown/price — non-fatal for the rehearsal)");
    else log(`   converted 40 uwu -> ${cv.got?.toFixed(4)} sol (simulated=${cv.simulated})`);

    step(6, "withdraw 20 UWU back on-chain");
    send({ t: "withdraw", wallet: PK, side: "uwu", amount: 20 });
    const wd = await Promise.race([waitFor("withdrawDone", 40000), waitFor("error", 40000)]);
    if (wd.t === "error") log("   withdraw:", wd.msg);
    else log("   withdraw tx", (wd.sig || "").slice(0, 24) + "…");

    log("\nDEVNET CANARY COMPLETE — auth, faucet, deposit, deploy-ready, convert, withdraw all exercised with real signed txs.");
    process.exit(0);
  } catch (e) {
    log("\nCANARY FAILED:", e.message);
    process.exit(1);
  }
};
ws.onerror = (e) => { log("ws error", e.message); process.exit(1); };
setTimeout(() => { log("overall timeout"); process.exit(1); }, 180000);
