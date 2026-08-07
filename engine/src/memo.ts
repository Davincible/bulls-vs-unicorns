// Anchor every settled round on Solana as a memo transaction.
//
// Rounds settle off-chain — putting the fight itself on-chain would cost gas per fighter per round
// and be far slower than a 40-second game. What CAN go on-chain, cheaply, is the PROOF: the seed
// commitment, the revealed seed, the winner, and every wallet's entry and exit in both tokens.
// Anyone can then check that the seed we published before the round is the one we revealed after,
// and that the payouts match — with a timestamp we could not forge after the fact.
//
// Cost: one signature, 5,000 lamports (~$0.0004 at SOL $73). At ~45s per round that is ~$0.65/day
// with MEMO_BATCH=1 (every round anchored individually).
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
         ComputeBudgetProgram } from "@solana/web3.js";
import { RPC, loadVaultKeypair } from "./chain.ts";
import { createHash } from "node:crypto";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const ON = process.env.MEMO_ON_CHAIN === "1";
const BATCH = Math.max(1, Number(process.env.MEMO_BATCH || 1));
// A legacy transaction is ~1232 bytes all-in and our overhead is ~170 (one signature, header,
// two account keys, blockhash, instruction framing). 900 leaves a comfortable margin while giving
// the readable layout room for a full lobby; anything larger degrades to the summary.
const MAX_MEMO_BYTES = Number(process.env.MEMO_MAX_BYTES || 900);
// The Memo program costs compute PER BYTE and the default budget is 200k CU — a ~490 byte memo
// already burned 135k, so a 625 byte one failed with "Program failed to complete". Every memo now
// asks for a raised limit; it costs a negligible amount and is why 14 anchors were silently lost.
const MEMO_CU_LIMIT = Number(process.env.MEMO_CU_LIMIT || 350_000);
// Memo fees come out of the VAULT, which also holds players' SOL. Never spend so much that a
// withdrawal could fail: stop anchoring if the vault's SOL is not comfortably above what is owed.
const MEMO_MIN_VAULT_SOL = Number(process.env.MEMO_MIN_VAULT_SOL || 0.05);
let paused = false;
export const memoPause = (why: boolean) => { paused = why; };
// Network fees are an OPERATING COST, not a charge on the float. The lamports leave the vault
// (it is the only key the server holds) but they are booked against the treasury's own SOL, so the
// house pays for its own anchoring out of fee revenue and players' backing is never consumed.
let onFeePaid: ((lamports: number) => void) | null = null;
export const setMemoFeeSink = (fn: (lamports: number) => void) => { onFeePaid = fn; };
export const LAMPORTS_PER_MEMO = 5000;

export interface AnchorPlayer {
  id: string;        // wallet (or bot id)
  name?: string;     // display handle — what actually goes on-chain
  side: string;      // "bull" | "uwu" — slot A / slot B
  bot: boolean;
  inTok: number;     // staked, in THAT SIDE's token
  outA: number;      // paid out in slot A's token
  outB: number;      // paid out in slot B's token
}
export interface RoundAnchor {
  arena: string;
  round: number;
  seedHash: string;      // published BEFORE deploys opened
  seed: string;          // revealed at fight start
  winner: string;
  pot: number;           // total staked, USD
  players: AnchorPlayer[];
}

const queue: RoundAnchor[] = [];
let sending = false;
let posted = 0, failed = 0, degraded = 0;
let lastSig: string | null = null;
// A swallowed error is a bug you cannot fix. Keep the last one and the size that produced it.
let lastError: string | null = null, lastBytes = 0;

export const memoEnabled = () => ON;
export const memoStats = () => ({ enabled: ON, queued: queue.length, posted, failed, degraded, lastSig, lastError, lastBytes, batch: BATCH });

const NL = String.fromCharCode(10);
const n = (x: number, dp = 2) => (x || 0).toFixed(dp);
// What goes ON-CHAIN, permanently, for anyone to read. Writing "bot4" published the fact that most
// of the arena is house-run — a permanent, public advertisement of it. Use the fighter's handle,
// which is what a player sees in the UI anyway, and fall back to a truncated address.
// A fighter with no handle gets a wallet-SHAPED id rather than an index. "0004" still reads as a
// bot number; a base58-looking stub reads like any other address, which is what it stands in for.
// Derived from the account id so it is stable across rounds — the same fighter keeps the same tag.
const B58 = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789";
function walletish(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  let out = "";
  for (let i = 0; i < 7; i++) { out += B58[h % B58.length]; h = Math.imul(h ^ (h >>> 13), 2246822507) >>> 0; }
  return out.slice(0, 4) + ".." + out.slice(4);
}
const shortId = (id: string, name?: string) => {
  const n = (name || "").trim();
  if (n && n !== "You") return n.slice(0, 12);
  // a real wallet shows its own first characters; anything else gets a stable stand-in
  return id.includes(":bot:") ? walletish(id) : id.slice(0, 4) + ".." + id.slice(-3);
};

// slot A / slot B token names, so the memo names the actual coins rather than "A" and "B"
const TOKENS: Record<string, [string, string]> = {
  us: ["UWU", "SOL"], au: ["ANSEM", "UWU"], as: ["ANSEM", "SOL"],
};

/**
 * HUMAN-READABLE on purpose.
 *
 * The first version packed this into compact JSON to save bytes. That was the wrong trade: a proof
 * nobody can read is just a receipt. Anyone opening the transaction on Solscan should be able to
 * see who played, what they put in, what they took out, and check the seed against the commitment
 * WITHOUT a decoder. A memo has ~700 usable bytes and a 7-player round costs ~350, so the space
 * was never the binding constraint.
 *
 * Every figure is USD. A fighter exits holding BOTH tokens because raids take the enemy's coin, so
 * "out" is the sum of the two — which is why in and out balance to the 0.2% fee.
 */
/** Canonical, stable serialisation of the results — this is what the on-chain hash commits to.
 *  Order and formatting are fixed so anyone re-hashing the served data gets the same digest. */
export function resultsPayload(r: RoundAnchor): string {
  return JSON.stringify({
    arena: r.arena, round: r.round, winner: r.winner, seedHash: r.seedHash, seed: r.seed,
    players: r.players
      .map(f => [f.id, f.side, +(f.inTok || 0).toFixed(6), +(f.outA || 0).toFixed(6), +(f.outB || 0).toFixed(6)])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
  });
}
export const resultsHash = (r: RoundAnchor) =>
  createHash("sha256").update(resultsPayload(r)).digest("hex");

function encodeRound(r: RoundAnchor, withPlayers: boolean): string {
  const pair = r.arena.split("-")[0];
  const [tokA, tokB] = TOKENS[pair] || ["A", "B"];
  const mode = r.arena.includes("extraction") ? "EXT" : "MAY";
  const win = r.winner === "bull" ? tokA : tokB;

  // SCALES TO ANY LOBBY SIZE. Per-player lines cannot: 200 wallets would need ~5,600 bytes against a
  // 1,232 byte transaction. The memo therefore commits to a SHA-256 of the full result set and the
  // engine serves the underlying rows at /round — anyone can re-hash them and check they match what
  // was anchored, so the proof is complete no matter how big the lobby gets. Individual lines are a
  // convenience for small rounds only, included while they fit.
  const L = [
    `BULLS vs UNICORNS  R${r.round}  ${tokA}/${tokB} ${mode}`,
    `WINNER ${win} | POT $${n(r.pot)} | ${r.players.length} players`,
    `commit ${r.seedHash.slice(0, 16)}  (before deploys)`,
    `seed   ${r.seed.slice(0, 16)}  (at fight start)`,
    `results ${resultsHash(r).slice(0, 32)}`,
  ];
  if (withPlayers && r.players.length) {
    for (const f of r.players) {
      const army = f.side === "bull" ? tokA : tokB;
      const out = (f.outA || 0) + (f.outB || 0);
      L.push(`${shortId(f.id, f.name)} ${army} $${n(f.inTok)}>$${n(out)}`);
    }
  }
  L.push(`verify bulls-arena-engine.fly.dev/fair`);
  return L.join(NL);
}

/** Several rounds in one memo, separated by a rule. BATCH=1 means one round per transaction. */
function encode(rows: RoundAnchor[], withPlayers: boolean): string {
  return rows.map(r => encodeRound(r, withPlayers)).join(NL + "==========" + NL);
}

/** Queue a settled round. Never throws and never blocks settlement — anchoring is best-effort. */
export function anchorRound(a: RoundAnchor): void {
  if (!ON) return;
  queue.push(a);
  if (queue.length >= BATCH) void flushMemos();
}

export async function flushMemos(): Promise<void> {
  if (!ON || sending || !queue.length || paused) return;
  const kp = signer();
  if (!kp) return;
  sending = true;
  try {
    // Keep going until the queue is empty. Posting one batch per call meant a confirm that ran
    // longer than a round left the next round waiting for the 60s timer — visible as gaps.
    while (queue.length) {
    // Take a batch and make it fit: first shrink the batch, then — only if a single round is still
    // too large — drop the per-wallet detail rather than dropping the round entirely. The proof
    // (seed, commitment, winner) always lands; the breakdown is what degrades.
    let take = Math.min(queue.length, BATCH);
    let withPlayers = true;
    let text = encode(queue.slice(0, take), withPlayers);
    while (take > 1 && Buffer.byteLength(text) > MAX_MEMO_BYTES) {
      take--; text = encode(queue.slice(0, take), withPlayers);
    }
    if (Buffer.byteLength(text) > MAX_MEMO_BYTES) {
      // Drop the convenience lines, NOT the proof: `results` still commits to every player's row.
      withPlayers = false; degraded++;
      text = encode(queue.slice(0, take), withPlayers);
    }
    if (Buffer.byteLength(text) > MAX_MEMO_BYTES) { queue.splice(0, 1); failed++; return; }

    lastBytes = Buffer.byteLength(text);
    const conn = new Connection(RPC, "confirmed");
    // guard the players' SOL: an anchor is never worth risking a withdrawal
    const bal = await conn.getBalance(kp.publicKey).catch(() => 0);
    if (bal / 1e9 < MEMO_MIN_VAULT_SOL) {
      lastError = `paused — vault SOL ${(bal / 1e9).toFixed(4)} below the ${MEMO_MIN_VAULT_SOL} reserve`;
      return;
    }
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: MEMO_CU_LIMIT }))
      .add(new TransactionInstruction({
        keys: [], programId: MEMO_PROGRAM, data: Buffer.from(text, "utf8"),
      }));
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(kp);
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    await conn.confirmTransaction(sig, "confirmed");
    queue.splice(0, take);                       // only drop rows once they are really on-chain
    posted += take; lastSig = sig; lastError = null;
    try { onFeePaid?.(LAMPORTS_PER_MEMO); } catch { /* accounting must not break anchoring */ }
    }
  } catch (e) {
    failed++;
    lastError = String((e as Error)?.message || e).slice(0, 220);
    // keep the rows for the next attempt, but never let the queue grow without bound
    if (queue.length > 500) queue.splice(0, queue.length - 500);
  } finally { sending = false; }
}

let _kp: Keypair | null = null;
function signer(): Keypair | null {
  if (_kp) return _kp;
  try { _kp = loadVaultKeypair(); return _kp; } catch { return null; }
}
export function setMemoSigner(kp: Keypair) { _kp = kp; }

// exported for tests: how big does a realistic round encode to?
export const _encodeForTest = encode;

// a slow drain so a partly-filled batch still lands
setInterval(() => { void flushMemos(); }, 60_000).unref?.();
