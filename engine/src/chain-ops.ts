// On-chain operations for the custodial devnet vault: faucet, deposit-verify, withdraw.
// All amounts at this API are WHOLE TOKENS (numbers); base-unit conversion is internal.
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, getAssociatedTokenAddress, mintTo, transfer,
  createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAccount,
} from "@solana/spl-token";
import { connection, loadVaultKeypair, loadConfig, mintFor, DECIMALS } from "./chain.ts";

const UNIT = 10 ** DECIMALS;
const toBase = (whole: number) => BigInt(Math.round(whole * UNIT));
const toWhole = (base: bigint | number) => Number(base) / UNIT;

const cfg = loadConfig();
const vault = loadVaultKeypair();
const seenSigs = new Set<string>(); // dedupe deposit credits

export function chainReady(): boolean { return !!(cfg && cfg.mints?.bull && cfg.mints?.uwu); }
export function vaultPubkey(): string { return vault.publicKey.toBase58(); }
export function mints() { return cfg ? { bull: cfg.mints.bull, uwu: cfg.mints.uwu, decimals: DECIMALS } : null; }

// Faucet: mint `amount` test tokens of `side` to the player's wallet. Returns tx signature.
export async function faucet(walletB58: string, side: "bull" | "uwu", amount = 500): Promise<string> {
  if (!cfg) throw new Error("chain not configured");
  const conn = connection();
  const owner = new PublicKey(walletB58);
  const mint = mintFor(cfg, side);
  const ata = await getOrCreateAssociatedTokenAccount(conn, vault, mint, owner); // vault pays rent
  const sig = await mintTo(conn, vault, mint, ata.address, vault, toBase(amount));
  return sig;
}

// Build an unsigned deposit transaction (user → vault ATA) for Phantom to sign+send.
// Returns base64 of the serialized tx (feePayer = the player). Creates ATAs if missing.
export async function buildDepositTx(walletB58: string, side: "bull" | "uwu", amount: number): Promise<string> {
  if (!cfg) throw new Error("chain not configured");
  const conn = connection();
  const owner = new PublicKey(walletB58);
  const mint = mintFor(cfg, side);
  const userAta = await getAssociatedTokenAddress(mint, owner);
  const vaultAta = await getAssociatedTokenAddress(mint, vault.publicKey);
  const tx = new Transaction();
  // ensure the vault's receiving ATA exists (player pays the tiny rent if we must create it)
  try { await getAccount(conn, vaultAta); } catch { tx.add(createAssociatedTokenAccountInstruction(owner, vaultAta, vault.publicKey, mint)); }
  tx.add(createTransferCheckedInstruction(userAta, mint, vaultAta, owner, toBase(amount), DECIMALS));
  tx.feePayer = owner;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

// Airdrop native SOL to a player so they can pay tx fees. Works on a local validator
// (unlimited) and on devnet when the faucet is not rate-limited; fails soft otherwise.
export async function airdropSol(walletB58: string, sol = 2): Promise<string> {
  const conn = connection();
  const owner = new PublicKey(walletB58);
  const sig = await conn.requestAirdrop(owner, Math.round(sol * 1_000_000_000));
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

export async function solBalance(walletB58: string): Promise<number> {
  try { return (await connection().getBalance(new PublicKey(walletB58))) / 1_000_000_000; }
  catch { return 0; }
}

// Read a player's own on-chain token balance for a side (whole tokens).
export async function walletTokenBalance(walletB58: string, side: "bull" | "uwu"): Promise<number> {
  if (!cfg) return 0;
  const conn = connection();
  const ata = await getAssociatedTokenAddress(mintFor(cfg, side), new PublicKey(walletB58));
  try { const b = await conn.getTokenAccountBalance(ata); return Number(b.value.amount) / UNIT; }
  catch { return 0; }
}

// Verify a deposit tx the client already sent: confirm the vault's ATA for `mint` increased.
// Returns the credited whole-token amount (0 if not valid / already seen).
export async function verifyDeposit(sig: string, side: "bull" | "uwu"): Promise<number> {
  if (!cfg) throw new Error("chain not configured");
  if (seenSigs.has(sig)) return 0;
  const conn = connection();
  const mint = mintFor(cfg, side).toBase58();
  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx || tx.meta?.err) return 0;
  const pre = tx.meta?.preTokenBalances || [];
  const post = tx.meta?.postTokenBalances || [];
  const v = vault.publicKey.toBase58();
  const findBal = (arr: any[]) => arr.find(b => b.owner === v && b.mint === mint);
  const before = findBal(pre)?.uiTokenAmount?.uiAmount || 0;
  const after = findBal(post)?.uiTokenAmount?.uiAmount || 0;
  const delta = after - before;
  if (delta <= 0) return 0;
  seenSigs.add(sig);
  return delta;
}

// Withdraw: send `amount` tokens of `side` from vault → player's wallet. Returns tx signature.
export async function withdraw(walletB58: string, side: "bull" | "uwu", amount: number): Promise<string> {
  if (!cfg) throw new Error("chain not configured");
  const conn = connection();
  const owner = new PublicKey(walletB58);
  const mint = mintFor(cfg, side);
  const userAta = await getOrCreateAssociatedTokenAccount(conn, vault, mint, owner);
  const vaultAta = await getOrCreateAssociatedTokenAccount(conn, vault, mint, vault.publicKey);
  const sig = await transfer(conn, vault, vaultAta.address, userAta.address, vault, toBase(amount));
  return sig;
}

export async function vaultTokenBalance(side: "bull" | "uwu"): Promise<number> {
  if (!cfg) return 0;
  const conn = connection();
  const mint = mintFor(cfg, side);
  const ata = await getAssociatedTokenAddress(mint, vault.publicKey);
  try { const b = await conn.getTokenAccountBalance(ata); return toWhole(BigInt(b.value.amount)); }
  catch { return 0; }
}
