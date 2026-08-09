// PROVE THE PRODUCTION LOOP, not a local one.
//
// The bundle carrying the right strings proves the build. The page reading round 23 proves the
// reads. Neither proves a WRITE, and a write is the whole product: a real player entering a
// held-open lobby is the event the keeper is waiting for, and everything after it (close lobby ->
// VRF draw -> delegate to the ER -> stepped fight -> settle) only happens because that write landed.
//
// So: mint a burner, fund it from the operator wallet (devnet's own faucet rate-limits
// `requestAirdrop` to uselessness — five consecutive 429s, measured), inject it into the live
// origin's localStorage, deploy from the real page at https://bullsvsunicorns.fun/, and then watch
// the KEEPER's own status endpoint carry the round through to Settled.
//
// Nothing here is simulated and nothing runs against localhost.

import { chromium } from "playwright-core";
import { Keypair, Connection, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import fs from "node:fs";

const SITE = "https://bullsvsunicorns.fun/";
const KEEPER = "https://bulls-arena-keeper-devnet.fly.dev/keeper-status.json";
const RPC = "https://api.devnet.solana.com";
const STORAGE_KEY = "er-demo:burner-secret-key";
const OUT = "/private/tmp/claude-501/-Users-tyler-Launchpad-Crypto-UwuGame-magicblock/d5279d95-4422-4376-a720-d79efa3c4e5c/scratchpad";
const FUND_SOL = 0.15;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const status = async () => (await fetch(KEEPER)).json();

// ---------------------------------------------------------------------------- fund a burner
const conn = new Connection(RPC, "confirmed");
const operator = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync("/Users/tyler/Launchpad/Crypto/UwuGame/magicblock/.devnet/fork-payer.json"))));
const burner = Keypair.generate();
log("operator", operator.publicKey.toBase58());
log("burner  ", burner.publicKey.toBase58());

const before = await status();
log(`round #${before.round.no} phase=${before.round.phase} fighters=${before.round.fighterCount} real=${before.round.realFighterCount} heldOpen=${before.round.heldOpen}`);

const fundSig = await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({
  fromPubkey: operator.publicKey, toPubkey: burner.publicKey, lamports: FUND_SOL * LAMPORTS_PER_SOL,
})), [operator], { commitment: "confirmed" });
log(`funded burner with ${FUND_SOL} SOL — ${fundSig}`);

// ---------------------------------------------------------------------------- drive the live page
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

// Seed the burner into the live origin BEFORE any script runs, so the app adopts it rather than
// minting one we would then have to fund a second time.
await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  [STORAGE_KEY, JSON.stringify(Array.from(burner.secretKey))]);

const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 240)); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 240)));

await page.goto(SITE + "?signer=burner", { waitUntil: "networkidle", timeout: 90_000 });
const go = page.getByRole("button", { name: /let.?s go/i });
if (await go.count()) { await go.first().click(); await page.waitForTimeout(400); }
await page.waitForTimeout(6000);

const seen = await page.evaluate((k) => {
  const raw = localStorage.getItem(k);
  return raw ? JSON.parse(raw).length : null;
}, STORAGE_KEY);
log("burner present in page localStorage, secret bytes =", seen);
await page.screenshot({ path: `${OUT}/prod-01-loaded.png` });

// The deploy control. Try the obvious affordances in order and report which one existed.
const bodyText = () => page.locator("body").innerText();
log("visible balance/gate hints:", (await bodyText()).slice(0, 400).replace(/\n+/g, " | "));

const candidates = [
  page.getByRole("button", { name: /^deploy/i }),
  page.getByRole("button", { name: /enter/i }),
  page.getByRole("button", { name: /send (a )?fighter/i }),
];
let clicked = null;
for (const c of candidates) {
  if (await c.count()) {
    const first = c.first();
    if (await first.isEnabled().catch(() => false)) {
      const label = (await first.innerText().catch(() => "?")).trim();
      await first.click();
      clicked = label;
      break;
    }
  }
}
log("deploy control clicked:", clicked ?? "NONE FOUND/ENABLED");
if (!clicked) {
  const all = await page.getByRole("button").allInnerTexts();
  log("buttons on page:", JSON.stringify(all.slice(0, 40)));
}
await page.waitForTimeout(12_000);
await page.screenshot({ path: `${OUT}/prod-02-after-deploy.png`, fullPage: true });

// ---------------------------------------------------------------------------- watch the keeper
const phases = [];
const deadline = Date.now() + 6 * 60_000;
let last = "";
while (Date.now() < deadline) {
  const s = await status().catch(() => null);
  if (s) {
    const key = `#${s.round.no}:${s.round.phase}:${s.round.fighterCount}f/${s.round.realFighterCount}r`;
    if (key !== last) { last = key; phases.push({ at: new Date().toISOString().slice(11, 19), key, pot: s.round.pot }); log("KEEPER", key, "pot", s.round.pot); }
    if (s.round.phase === "Settled" && s.round.no >= before.round.no) break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}

await page.screenshot({ path: `${OUT}/prod-03-final.png`, fullPage: true });
const finalText = await bodyText();
const finalStatus = await status();
const burnerBal = await conn.getBalance(burner.publicKey);

console.log("\n================ RESULT ================");
console.log("phase timeline:", JSON.stringify(phases, null, 2));
console.log("final round:", JSON.stringify(finalStatus.round, null, 2));
console.log("keeper roundsCompleted:", finalStatus.keeper.roundsCompleted, "lastError:", finalStatus.keeper.lastError);
console.log("burner balance after:", burnerBal / LAMPORTS_PER_SOL, "SOL");
console.log("console errors:", errors.slice(0, 10));
console.log("\npage text (first 1200):\n", finalText.slice(0, 1200));

await browser.close();
