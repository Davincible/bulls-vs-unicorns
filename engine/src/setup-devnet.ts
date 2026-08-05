// One-time devnet setup: fund the vault, create test BULL + UWU mints, write devnet.json.
// Run:  npm run setup:devnet     (idempotent — reuses existing keypair/config)
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import { connection, loadVaultKeypair, loadConfig, saveConfig, DECIMALS, RPC } from "./chain.ts";

async function airdropTo(pubkey: PublicKey, wantSol: number) {
  const conn = connection();
  const bal = await conn.getBalance(pubkey);
  if (bal >= wantSol * LAMPORTS_PER_SOL) { console.log(`  vault balance ${(bal/LAMPORTS_PER_SOL).toFixed(3)} SOL — enough`); return; }
  for (let i = 0; i < 4; i++) {
    try {
      console.log(`  airdrop attempt ${i+1}…`);
      const sig = await conn.requestAirdrop(pubkey, 1 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
      const nb = await conn.getBalance(pubkey);
      console.log(`  → ${(nb/LAMPORTS_PER_SOL).toFixed(3)} SOL`);
      if (nb >= 0.5 * LAMPORTS_PER_SOL) return;
    } catch (e) { console.log(`  airdrop failed: ${(e as Error).message}`); await new Promise(r=>setTimeout(r,2000)); }
  }
}

async function main() {
  console.log(`RPC: ${RPC}`);
  const conn = connection();
  const vault = loadVaultKeypair();
  console.log(`Vault: ${vault.publicKey.toBase58()}`);

  await airdropTo(vault.publicKey, 1.5);
  const bal = await conn.getBalance(vault.publicKey);
  if (bal < 0.05 * LAMPORTS_PER_SOL) {
    console.error(`\n✗ Vault underfunded (${(bal/LAMPORTS_PER_SOL).toFixed(4)} SOL). Devnet faucet rate-limited.`);
    console.error(`  Fund it manually:  https://faucet.solana.com  → paste  ${vault.publicKey.toBase58()}`);
    console.error(`  Then re-run  npm run setup:devnet`);
    process.exit(1);
  }

  let cfg = loadConfig();
  if (cfg?.mints?.bull && cfg?.mints?.uwu) {
    console.log(`Config already has mints — nothing to do.\n  BULL ${cfg.mints.bull}\n  UWU  ${cfg.mints.uwu}`);
    return;
  }

  console.log(`Creating BULL mint…`);
  const bull = await createMint(conn, vault, vault.publicKey, null, DECIMALS);
  console.log(`  BULL: ${bull.toBase58()}`);
  console.log(`Creating UWU mint…`);
  const uwu = await createMint(conn, vault, vault.publicKey, null, DECIMALS);
  console.log(`  UWU:  ${uwu.toBase58()}`);

  cfg = { cluster: "devnet", vault: vault.publicKey.toBase58(), mints: { bull: bull.toBase58(), uwu: uwu.toBase58() }, decimals: DECIMALS };
  saveConfig(cfg);
  console.log(`\n✓ Wrote devnet.json. Vault holds mint authority (can faucet + settle).`);
}

main().catch(e => { console.error(e); process.exit(1); });
