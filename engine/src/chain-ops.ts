// On-chain operations for the custodial devnet vault: faucet, deposit-verify, withdraw.
// All amounts at this API are WHOLE TOKENS (numbers); base-unit conversion is internal.
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, Keypair,
         VersionedTransaction } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, getAssociatedTokenAddress, mintTo, transfer,
  createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAccount,
} from "@solana/spl-token";
import { connection, loadVaultKeypair, loadConfig, mintFor, DECIMALS, withRpcRetry } from "./chain.ts";

const UNIT = 10 ** DECIMALS;
const toBase = (whole: number) => BigInt(Math.round(whole * UNIT));
const toWhole = (base: bigint | number) => Number(base) / UNIT;

const cfg = loadConfig();
const vault = loadVaultKeypair();
const seenSigs = new Set<string>(); // dedupe deposit credits
// Signatures whose verification is IN FLIGHT. Both verifiers used to check seenSigs, await an RPC
// round trip, and only then record the signature - a check-then-act straddling an await. Two
// concurrent calls for the same signature both passed the check, both awaited, and both returned a
// positive delta, so ONE on-chain deposit was credited to the ledger TWICE. Sending the same
// relayTx message twice in quick succession was enough to trigger it.
//
// Reserving before the await closes the window. It is deliberately a SEPARATE set from seenSigs:
// an RPC failure must release the reservation so a genuine retry can still be credited, whereas
// seenSigs is permanent and means "already credited". Collapsing the two would turn one dropped
// RPC call into a deposit that could never be credited at all.
const inFlightSigs = new Set<string>();
/** Reserve a signature for verification. False if already credited, or already being verified. */
function claimSig(sig: string): boolean {
  if (seenSigs.has(sig) || inFlightSigs.has(sig)) return false;
  inFlightSigs.add(sig);
  return true;
}
/** Test-only view of the dedupe state. */
export function __sigState(sig: string) { return { seen: seenSigs.has(sig), inFlight: inFlightSigs.has(sig) }; }

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

// ---- NATIVE SOL: a system transfer, not a token transfer. Separate path end to end. ----
// Deposits move lamports player -> vault; withdrawals move them back. Amounts crossing this
// boundary are SOL, not USD units — the caller converts using the live price.
export async function buildSolDepositTx(walletB58: string, sol: number): Promise<string> {
  const conn = connection();
  const owner = new PublicKey(walletB58);
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: vault.publicKey,
                                  lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
  tx.feePayer = owner;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

/** Verify a native-SOL deposit: confirm the VAULT's lamport balance actually rose. */
export async function verifySolDeposit(sig: string): Promise<number> {
  if (!claimSig(sig)) return 0;              // reserved BEFORE the await, so a twin call sees it
  try {
    const conn = connection();
    const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx || tx.meta?.err) return 0;
    const keys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
    const idx = keys.indexOf(vault.publicKey.toBase58());
    if (idx < 0) return 0;
    const before = tx.meta?.preBalances?.[idx] ?? 0, after = tx.meta?.postBalances?.[idx] ?? 0;
    const delta = (after - before) / LAMPORTS_PER_SOL;
    if (delta <= 0) return 0;
    seenSigs.add(sig);                       // permanent: this one has now been credited
    return delta;
  } finally { inFlightSigs.delete(sig); }    // release, so a failed read can be retried
}

/** Pay native SOL out of the vault to a player. */
export async function withdrawSol(walletB58: string, sol: number): Promise<string> {
  const conn = connection();
  const owner = new PublicKey(walletB58);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: vault.publicKey, toPubkey: owner, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
  tx.feePayer = vault.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(vault);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
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
  try { return (await withRpcRetry(() => connection().getBalance(new PublicKey(walletB58)))) / 1_000_000_000; }
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
  if (!claimSig(sig)) return 0;              // reserved BEFORE the await, so a twin call sees it
  try {
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
    seenSigs.add(sig);                       // permanent: this one has now been credited
    return delta;
  } finally { inFlightSigs.delete(sig); }    // release, so a failed read can be retried
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

// ---- funding from a wallet WE control that is NOT the vault -------------------------------
// The vault key lives on the server, so anything it holds is exposed to server compromise. Funding
// bots straight from a seed wallet the operator holds means the float never sits under the server's
// key: the vault only ever receives money that has been formally deposited.
export async function sendSolFrom(payer: Keypair, toB58: string, sol: number): Promise<string> {
  const conn = connection();
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey, toPubkey: new PublicKey(toB58),
    lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

export async function transferTokensFrom(payer: Keypair, toB58: string, side: "bull" | "uwu", amount: number): Promise<string> {
  if (!cfg) throw new Error("chain not configured");
  const conn = connection();
  const mint = mintFor(cfg, side);
  const from = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  const to = await getOrCreateAssociatedTokenAccount(conn, payer, mint, new PublicKey(toB58));  // payer covers rent
  const have = toWhole(BigInt(from.amount.toString()));
  if (have < amount) throw new Error(`seed wallet holds ${have.toFixed(4)} ${side}, needs ${amount}`);
  return transfer(conn, payer, from.address, to.address, payer, toBase(amount));
}

export async function tokenBalanceOf(ownerB58: string, side: "bull" | "uwu"): Promise<number> {
  if (!cfg) return 0;
  const ata = await getAssociatedTokenAddress(mintFor(cfg, side), new PublicKey(ownerB58));
  try { const b = await connection().getTokenAccountBalance(ata); return Number(b.value.amount) / UNIT; }
  catch { return 0; }
}

// Send tokens the VAULT ALREADY HOLDS to a wallet. This is how bots get funded on mainnet: ANSEM
// and UWU have no mint authority (fixed supply), so `faucet` is impossible there — the float has to
// be tokens we actually bought, transferred out of the vault.
export async function transferFromVault(walletB58: string, side: "bull" | "uwu", amount: number): Promise<string> {
  if (!cfg) throw new Error("chain not configured");
  const conn = connection();
  const owner = new PublicKey(walletB58);
  const mint = mintFor(cfg, side);
  const vaultAta = await getOrCreateAssociatedTokenAccount(conn, vault, mint, vault.publicKey);
  const userAta = await getOrCreateAssociatedTokenAccount(conn, vault, mint, owner);   // vault pays rent
  const have = toWhole(BigInt(vaultAta.amount.toString()));
  if (have < amount) throw new Error(`vault holds ${have.toFixed(4)} ${side}, need ${amount} — buy more first`);
  return transfer(conn, vault, vaultAta.address, userAta.address, vault, toBase(amount));
}

// Relay a Phantom-signed transaction through the ENGINE's RPC. Browsers get 403 from the public
// mainnet endpoint when they call sendRawTransaction directly, so the client hands us the signed
// bytes and we broadcast via our keyed (Helius) endpoint, then confirm. We never sign here — the tx
// is already fully signed by the user; the vault key is not involved.
/** Assert a signed transaction is a DEPOSIT from `wallet` into our vault, before we relay it.
 *
 *  Broadcasting is a separate capability from crediting. Crediting was already safe — the verify*
 *  path checks the vault actually received the money — but an unconstrained relay lets an
 *  authenticated caller push ANY transaction through our paid RPC: spam, MEV, arbitrage, all at our
 *  cost and under our endpoint's reputation. The allowlist limits who, not what.
 *
 *  Returns null when acceptable, or a reason to refuse.
 *
 *  Alternative considered: simulate the transaction and inspect balance deltas. That is stricter but
 *  costs an RPC round trip on every deposit and still needs this structural check to decide what the
 *  deltas should be, so it is not worth the latency here.
 */
const RELAY_OK_PROGRAMS = new Set([
  SystemProgram.programId.toBase58(),
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   // SPL Token
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  // Associated Token Account
  "ComputeBudget111111111111111111111111111111",
]);

/** Destinations a deposit is allowed to pay: the vault itself (native SOL) or its token accounts. */
let _vaultTargets: Set<string> | null = null;
async function vaultTargets(): Promise<Set<string>> {
  if (_vaultTargets) return _vaultTargets;
  const t = new Set<string>([vault.publicKey.toBase58()]);
  if (cfg) for (const side of ["bull", "uwu"] as const) {
    try { t.add((await getAssociatedTokenAddress(mintFor(cfg, side), vault.publicKey)).toBase58()); }
    catch { /* a mint we cannot derive simply is not an allowed destination */ }
  }
  _vaultTargets = t;
  return t;
}

export async function inspectRelayTx(signedB64: string, wallet: string): Promise<string | null> {
  const raw = Buffer.from(signedB64, "base64");
  if (!raw.length) return "empty transaction";
  if (raw.length > 1500) return "transaction too large";

  let tx: Transaction;
  try { tx = Transaction.from(raw); }
  catch { return "only legacy deposit transactions may be relayed"; }

  // The fee payer must be the wallet we authenticated, so nobody can relay a third party's tx.
  const owner = new PublicKey(wallet);
  if (!tx.feePayer || !tx.feePayer.equals(owner)) return "fee payer is not the authenticated wallet";

  // Only the programs our own deposit builder emits.
  for (const ix of tx.instructions) {
    if (!RELAY_OK_PROGRAMS.has(ix.programId.toBase58())) return "unexpected program in transaction";
  }

  // ...and it has to actually pay US. An SPL deposit targets the vault's ATA, not the vault itself,
  // so checking for the vault pubkey alone would miss every token deposit.
  const targets = await vaultTargets();
  const paysVault = tx.instructions.some(ix => ix.keys.some(k => targets.has(k.pubkey.toBase58())));
  if (!paysVault) return "transaction does not pay the vault";

  return null;
}

export async function broadcastSigned(signedB64: string): Promise<string> {
  const conn = connection();
  const raw = Buffer.from(signedB64, "base64");
  const sig = await withRpcRetry(() => conn.sendRawTransaction(raw, { maxRetries: 3, skipPreflight: false }));
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

export async function vaultTokenBalance(side: "bull" | "uwu"): Promise<number> {
  if (!cfg) return 0;
  const mint = mintFor(cfg, side);
  const ata = await getAssociatedTokenAddress(mint, vault.publicKey);
  // the reconciliation daemon calls this every 15s - it must survive a throttled endpoint
  try { const b = await withRpcRetry(() => connection().getTokenAccountBalance(ata)); return toWhole(BigInt(b.value.amount)); }
  catch { return 0; }
}
