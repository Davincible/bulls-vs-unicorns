// Re-credit bot-pool wallets whose ledger balance was destroyed by the bust bug.
//
// The bust path used to delete a retiring bot together with whatever it still held. That money came
// from real deposits, so the ledger's record of the float evaporated while the vault kept holding
// the tokens on-chain. This restores the books to the truth the chain already knows.
//
//   DRY RUN (default):  npx tsx src/recover-float.ts
//   APPLY:              RECOVER_APPLY=1 npx tsx src/recover-float.ts
//
// SAFETY: it only ever credits UP TO what a wallet actually deposited (depIn - wOut), and refuses
// outright if the vault does not hold enough to back the result. It cannot invent money.
import { loadSnapshot, saveSnapshot, flushSnapshot } from "./store.ts";
import { poolPubkeys } from "./bot-wallets.ts";
import { vaultTokenBalance, solBalance, vaultPubkey, chainReady } from "./chain-ops.ts";
import { priceUSD, refreshPrices } from "./prices.ts";
import { pathToFileURL } from "node:url";

const APPLY = process.env.RECOVER_APPLY === "1";

/** Credit pool wallets from the LIVE in-memory ledger. Running this inside the engine at boot is
 *  race-free; the standalone CLI writes the snapshot file, which a running engine will overwrite
 *  with its own stale in-memory state on the next persist. */
export async function recoverInPlace(
  ledger: Map<string, any>, pool: Set<string>,
  held: { uwu: number; solUsd: number },
): Promise<{ credited: number; uwu: number; sol: number; reason?: string }> {
  let wantUwu = 0, wantSol = 0;
  const plan: Array<[any, number, number]> = [];
  for (const a of ledger.values()) {
    if (!pool.has(a.id)) continue;
    const solBacked = Math.max(0, (a.depInSol || 0) - (a.wOutSol || 0));
    const tokenDep = Math.max(0, (a.depIn || 0) - (a.wOut || 0) - solBacked);
    const addUwu = Math.max(0, tokenDep - (a.uwu || 0));
    const addSol = Math.max(0, solBacked - (a.sol || 0));
    if (addUwu > 0.0001 || addSol > 0.0001) { plan.push([a, addUwu, addSol]); wantUwu += addUwu; wantSol += addSol; }
  }
  if (!plan.length) return { credited: 0, uwu: 0, sol: 0, reason: "nothing to recover" };
  let otherUwu = 0, otherSol = 0;
  for (const a of ledger.values()) { if (pool.has(a.id) || a.isBot) continue; otherUwu += a.uwu || 0; otherSol += a.sol || 0; }
  if (otherUwu + wantUwu > held.uwu + 1e-6) return { credited: 0, uwu: 0, sol: 0, reason: `would owe ${(otherUwu+wantUwu).toFixed(2)} UWU vs ${held.uwu.toFixed(2)} held` };
  if (wantSol > 0.0001 && !(held.solUsd > 0)) return { credited: 0, uwu: 0, sol: 0, reason: "SOL price unavailable - cannot verify" };
  if (otherSol + wantSol > held.solUsd + 1e-6) return { credited: 0, uwu: 0, sol: 0, reason: `would owe $${(otherSol+wantSol).toFixed(2)} SOL vs $${held.solUsd.toFixed(2)} held` };
  for (const [a, u, so] of plan) { a.uwu = (a.uwu || 0) + u; a.sol = (a.sol || 0) + so; }
  return { credited: plan.length, uwu: wantUwu, sol: wantSol };
}

async function main() {
  if (!chainReady()) { console.error("chain not configured"); process.exit(1); }
  const snap = loadSnapshot();
  if (!snap) { console.error("no ledger snapshot found"); process.exit(1); }

  const pool = new Set(poolPubkeys());
  if (!pool.size) { console.error("no BOT_POOL configured - nothing to recover"); process.exit(1); }

  const accounts: any[] = snap.accounts || [];
  console.log(`ledger: ${accounts.length} accounts, ${pool.size} pool wallets\n`);

  // what each pool wallet is OWED per its own deposit record
  let wantBull = 0, wantUwu = 0, wantSol = 0;
  const plan: Array<{ id: string; bull: number; uwu: number; sol: number }> = [];
  for (const a of accounts) {
    if (!pool.has(a.id)) continue;
    // depIn is recorded in the token that was deposited; depInSol tracks native SOL separately
    const solBacked = Math.max(0, (a.depInSol || 0) - (a.wOutSol || 0));
    const tokenDeposited = Math.max(0, (a.depIn || 0) - (a.wOut || 0) - solBacked);
    // this launch deposited UWU + SOL only; bull stays whatever it already is
    const targetUwu = tokenDeposited;
    const targetSol = solBacked;
    const addUwu = Math.max(0, targetUwu - (a.uwu || 0));
    const addSol = Math.max(0, targetSol - (a.sol || 0));
    if (addUwu > 0.0001 || addSol > 0.0001) {
      plan.push({ id: a.id, bull: 0, uwu: addUwu, sol: addSol });
      wantUwu += addUwu; wantSol += addSol;
    }
  }

  if (!plan.length) { console.log("nothing to recover - ledger already matches deposits"); process.exit(0); }

  console.log(`would credit ${plan.length} wallet(s):`);
  console.log(`  UWU ${wantUwu.toFixed(4)}`);
  console.log(`  SOL(usd units) ${wantSol.toFixed(4)}`);

  // the vault MUST be able to back the restored balances
  const heldUwu = await vaultTokenBalance("uwu");
  const heldBull = await vaultTokenBalance("bull");
  const heldSolNative = await solBalance(vaultPubkey());
  // pull a fresh price before judging solvency - a stale/absent feed must not wave this through
  await refreshPrices().catch(() => {});
  const px = priceUSD("sol") || 0;
  const heldSolUsd = px > 0 ? heldSolNative * px : 0;

  // existing liabilities that are NOT part of this recovery
  let otherUwu = 0, otherSol = 0;
  for (const a of accounts) {
    if (pool.has(a.id) || a.isBot) continue;
    otherUwu += a.uwu || 0; otherSol += a.sol || 0;
  }

  console.log(`\nvault holds: ${heldUwu.toFixed(2)} UWU, ${heldBull.toFixed(2)} BULL, ${heldSolNative.toFixed(4)} SOL (~$${heldSolUsd.toFixed(2)})`);
  console.log(`after recovery the book would owe: ${(otherUwu + wantUwu).toFixed(2)} UWU, $${(otherSol + wantSol).toFixed(2)} of SOL`);

  if (otherUwu + wantUwu > heldUwu + 1e-6) {
    console.error(`\nREFUSING: recovery would owe more UWU than the vault holds.`); process.exit(1);
  }
  // A missing price must FAIL the check, not skip it. The first run printed "~$0.00" because the
  // price loop had not ticked yet, which would have waved the SOL leg through unverified.
  if (wantSol > 0.0001 && !(px > 0)) {
    console.error(`\nREFUSING: SOL price unavailable, so the SOL leg cannot be verified against`);
    console.error(`vault holdings. Wait for the price feed and re-run.`); process.exit(1);
  }
  if (otherSol + wantSol > heldSolUsd + 1e-6) {
    console.error(`\nREFUSING: recovery would owe $${(otherSol + wantSol).toFixed(2)} of SOL but the`);
    console.error(`vault only holds ${heldSolNative.toFixed(4)} SOL (~$${heldSolUsd.toFixed(2)}).`); process.exit(1);
  }
  console.log("\nsolvency check: PASS - the vault fully backs the restored balances");

  if (!APPLY) {
    console.log("\nDRY RUN. Nothing written. Re-run with RECOVER_APPLY=1 to apply.");
    process.exit(0);
  }

  const byId = new Map(accounts.map(a => [a.id, a]));
  for (const p of plan) {
    const a = byId.get(p.id);
    if (!a) continue;
    a.uwu = (a.uwu || 0) + p.uwu;
    a.sol = (a.sol || 0) + p.sol;
  }
  saveSnapshot({ ...snap, accounts } as any);
  flushSnapshot();
  console.log(`\nAPPLIED. Restart the engine so the bot bank picks the float up.`);
}
// Only run the CLI when this file is the ENTRY POINT. Without this guard, importing
// recoverInPlace from the server executed main(), which called process.exit and killed the engine
// on boot.
const isEntry = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] || "").href; }
  catch { return false; }
})();
if (isEntry) main().catch(e => { console.error("recover failed:", e.message); process.exit(1); });
