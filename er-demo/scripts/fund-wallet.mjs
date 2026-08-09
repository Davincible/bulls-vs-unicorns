#!/usr/bin/env node
// FUND-WALLET — transfers devnet SOL from the fork-payer to a burner wallet, run manually by whoever
// is testing/presenting this demo. The fork-payer keypair (`.devnet/fork-payer.json`) must never ship
// in the browser bundle — it holds real (if worthless) devnet SOL earmarked for this whole project,
// and a browser bundle is public by construction. This script is the ONLY place that keypair gets
// used for the demo's player-funding path; the app itself never sees it.
//
// A burner wallet's pubkey comes from chain/useSigner.ts's localStorage entry — open devtools,
// `localStorage.getItem("er-demo:burner-secret-key")`, or just read the pubkey the app logs/displays
// once ConnectWallet.tsx exists (Phase 3). Until then, grab it from a browser console:
//   JSON.parse(localStorage.getItem("er-demo:burner-secret-key"))  // -> secret key bytes
//
//   cd er-demo && bun run scripts/fund-wallet.mjs <pubkey> [amountSol=0.05]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from "@solana/web3.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same devnet-only assertion shape as engine/src/devnet-guard.ts / src/devnet-guard.ts — inlined
// rather than imported (this is a plain Node/Bun script outside the Vite module graph, matching
// scripts/spike-session-er.mjs's own precedent for why cross-boundary imports aren't worth it here).
class MainnetBlocked extends Error {}
const SAFE_URL = [/\bapi\.devnet\.solana\.com\b/i, /\bdevnet\b/i, /\btestnet\b/i];
const MAINNET_URL = [/\bapi\.mainnet-beta\.solana\.com\b/i, /\bmainnet\b/i, /\bmainnet-beta\b/i];
// eslint-disable-next-line no-control-regex
const stripUrlNoise = (s) => s.replace(/[\x00-\x1f\x7f]/g, "");
function assertDevnetUrl(url, what = "endpoint") {
  const u = stripUrlNoise(String(url || "").trim());
  if (!u) throw new MainnetBlocked(`${what}: empty URL — refusing to guess a cluster.`);
  if (MAINNET_URL.some((re) => re.test(u))) {
    throw new MainnetBlocked(`${what} points at MAINNET (${u}). This is a devnet-only script. Refusing.`);
  }
  if (SAFE_URL.some((re) => re.test(u))) return;
  throw new MainnetBlocked(`${what} could not be positively identified as devnet: ${u}`);
}

const BASE_RPC = "https://api.devnet.solana.com";
assertDevnetUrl(BASE_RPC, "base devnet RPC");

const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

const [, , pubkeyArg, amountArg] = process.argv;
if (!pubkeyArg) {
  console.error("usage: bun run scripts/fund-wallet.mjs <pubkey> [amountSol=0.05]");
  process.exit(1);
}
let destination;
try {
  destination = new PublicKey(pubkeyArg);
} catch {
  console.error(`"${pubkeyArg}" is not a valid pubkey`);
  process.exit(1);
}
const amountSol = amountArg ? Number(amountArg) : 0.05;
if (!Number.isFinite(amountSol) || amountSol <= 0) {
  console.error(`amountSol must be a positive number, got "${amountArg}"`);
  process.exit(1);
}

const base = new Connection(BASE_RPC, "confirmed");
const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));

const startBalance = await base.getBalance(forkPayer.publicKey);
console.log(`fork-payer  ${forkPayer.publicKey.toBase58()}  ${(startBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
if (lamports > startBalance) {
  console.error(`fork-payer only has ${(startBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL, cannot send ${amountSol}`);
  process.exit(1);
}

const tx = new Transaction().add(
  SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: destination, lamports }),
);
const sig = await base.sendTransaction(tx, [forkPayer]);
await base.confirmTransaction(sig, "confirmed");
console.log(`sent ${amountSol} SOL -> ${destination.toBase58()}`);
console.log(`signature: ${sig}`);

const endBalance = await base.getBalance(forkPayer.publicKey);
console.log(`fork-payer balance now: ${(endBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
