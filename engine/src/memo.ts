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
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { RPC, loadVaultKeypair } from "./chain.ts";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const ON = process.env.MEMO_ON_CHAIN === "1";
const BATCH = Math.max(1, Number(process.env.MEMO_BATCH || 1));
// A legacy transaction is ~1232 bytes all-in. Staying well under it leaves room for the signature,
// blockhash and program ids without ever risking an oversized-transaction rejection.
const MAX_MEMO_BYTES = 700;

export interface AnchorPlayer {
  id: string;        // wallet (or bot id)
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

export const memoEnabled = () => ON;
export const memoStats = () => ({ enabled: ON, queued: queue.length, posted, failed, degraded, lastSig, batch: BATCH });

const n = (x: number, dp = 4) => Number((x || 0).toFixed(dp));
const shortId = (id: string) => id.includes(":bot:") ? "b" + id.split(":bot:")[1] : id.slice(0, 6);

/** Compact wire form. Short keys and trimmed ids, because every byte is transaction size. */
function encode(rows: RoundAnchor[], withPlayers: boolean): string {
  const body = rows.map(r => {
    const base: any = {
      a: r.arena.replace("-extraction", "-x").replace("-normal", "-n"),
      r: r.round,
      h: r.seedHash.slice(0, 16),     // enough to bind the commitment; full hash is served over http
      s: r.seed.slice(0, 16),
      w: r.winner === "bull" ? "A" : "B",
      p: n(r.pot, 2),
      c: r.players.length,
    };
    // per-wallet: [id, side(0=A,1=B), staked, outA, outB] — arrays beat objects for size
    if (withPlayers) base.f = r.players.map(f => [shortId(f.id), f.side === "bull" ? 0 : 1,
                                                  n(f.inTok), n(f.outA), n(f.outB)]);
    return base;
  });
  return "BvU1|" + JSON.stringify(body);
}

/** Queue a settled round. Never throws and never blocks settlement — anchoring is best-effort. */
export function anchorRound(a: RoundAnchor): void {
  if (!ON) return;
  queue.push(a);
  if (queue.length >= BATCH) void flushMemos();
}

export async function flushMemos(): Promise<void> {
  if (!ON || sending || !queue.length) return;
  const kp = signer();
  if (!kp) return;
  sending = true;
  try {
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
      withPlayers = false; degraded++;
      text = encode(queue.slice(0, take), withPlayers);
    }
    if (Buffer.byteLength(text) > MAX_MEMO_BYTES) { queue.splice(0, 1); failed++; return; }

    const conn = new Connection(RPC, "confirmed");
    const tx = new Transaction().add(new TransactionInstruction({
      keys: [], programId: MEMO_PROGRAM, data: Buffer.from(text, "utf8"),
    }));
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(kp);
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    await conn.confirmTransaction(sig, "confirmed");
    queue.splice(0, take);                       // only drop rows once they are really on-chain
    posted += take; lastSig = sig;
  } catch {
    failed++;
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
