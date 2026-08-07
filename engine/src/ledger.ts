// ledger — the authoritative money state: every account (real players by wallet + persistent bot
// accounts), the house treasury, per-arena stats, and durable persistence. This is the service
// that Phase B swaps from SQLite to on-chain ER accounts, so keeping it behind one module (instead
// of scattered through server.ts) is what makes that migration a contained change.
//
// Balances: bull/uwu are whole tokens; sol is USD units (the vault holds native SOL, converted at
// the live price). dep/ret are play-money P&L; depIn/wOut are REAL on-chain money in/out.
import type { Side, Mode } from "./game.ts";
import { priceUSD } from "./prices.ts";
import { loadSnapshot, saveSnapshot, flushSnapshot } from "./store.ts";

export interface Account {
  id: string; name: string; side: Side; bull: number; uwu: number; sol: number; isBot: boolean;
  dep: number; ret: number; games: number; wins: number;
  raided?: number; best?: number; depIn?: number; wOut?: number;
  depInSol?: number; wOutSol?: number;         // native-SOL deposits/withdrawals, tracked separately
  refBy?: string; refEarned?: number; avatar?: string;   // referral: who brought them + lifetime cut
}

export const ledger = new Map<string, Account>();

// ---- engine-wide accounting state (exported objects: server.ts mutates them in place) ----
export const rounds: Record<Mode, number> = { normal: 0, extraction: 0 };
export const roundsByArena: Record<string, number> = {};

/** The last N settled rounds, engine-side so they survive a restart and are identical for everyone.
 *  Persisted with the ledger; this is the same data the on-chain memo anchors. */
export interface RoundRecord {
  at: number; arena: string; round: number; winner: string; pot: number;
  seedHash: string; seed: string; sig?: string;          // sig = the memo tx, once it lands
  players: Array<{ id: string; name: string; side: string; bot: boolean; inUsd: number; outUsd: number }>;
}
export const roundLog: RoundRecord[] = [];
const ROUND_LOG_MAX = Number(process.env.ROUND_LOG_MAX || 200);
export function pushRound(r: RoundRecord): void {
  roundLog.unshift(r);
  if (roundLog.length > ROUND_LOG_MAX) roundLog.length = ROUND_LOG_MAX;
}
/** Newest-first slice, optionally only the rounds a given wallet actually played. */
export function roundHistory(limit = 40, wallet?: string): RoundRecord[] {
  const rows = wallet ? roundLog.filter(r => r.players.some(p => p.id === wallet)) : roundLog;
  return rows.slice(0, limit);
}
// per-arena economics for the dashboard: deployed, house take, matches, slot wins
export const statsA: Record<string, { deployed: number; take: number; matches: number; winsA: number; winsB: number }> = {};
export const stat = (aid: string) => (statsA[aid] ||= { deployed: 0, take: 0, matches: 0, winsA: 0, winsB: 0 });
// house take: the 0.2% skimmed on every deploy, tracked per mode
export const treasury: Record<Mode, number> = { normal: 0, extraction: 0 };

// The HOUSE's own account. Fees are tokens, not an abstraction: they have to land somewhere or the
// ledger stops adding up to what the vault holds. This account is house money (never a player
// liability) and is what the operator actually withdraws revenue from.
export const TREASURY_ID = "__versus_treasury__";
export function treasuryAcct(): Account {
  let a = ledger.get(TREASURY_ID);
  if (!a) {
    a = { id: TREASURY_ID, name: "Versus Treasury", side: "bull", bull: 0, uwu: 0, sol: 0,
          isBot: true, dep: 0, ret: 0, games: 0, wins: 0 } as Account;
    ledger.set(TREASURY_ID, a);
  }
  return a;
}
/** Bank a fee, in TOKENS of `field`. Keeps the books whole; `treasury` stays as the USD readout. */
export function bankFee(field: "bull" | "uwu" | "sol", tokens: number): void {
  if (!(tokens > 0)) return;
  const t = treasuryAcct();
  t[field] = (t[field] || 0) + tokens;
}
export const totalDeployed: Record<Mode, number> = { normal: 0, extraction: 0 };
export const depSide: Record<Mode, { bull: number; uwu: number }> = { normal: { bull: 0, uwu: 0 }, extraction: { bull: 0, uwu: 0 } };
export const created: Record<Mode, number> = { normal: 0, extraction: 0 };
export const bustedCount: Record<Mode, number> = { normal: 0, extraction: 0 };

// convFees is a reassigned primitive, so it can't be an exported binding server.ts writes to —
// it stays private here and is touched through the accessors below.
let convFees = 0;   // 1% taken when players swap raided enemy coin back to their own side
export const getConvFees = () => convFees;
export const addConvFees = (n: number) => { convFees += n; };
// Set the first (and only) time float recovery credits the bot pool. Persisted so the guard
// survives restarts - see recoverInPlace for why a second run would mint money.
let floatRecoveredAt = 0;
export const getFloatRecoveredAt = () => floatRecoveredAt;
export const markFloatRecovered = () => { floatRecoveredAt = Date.now(); };

// Player-supplied display strings are broadcast to every client and interpolated into the DOM.
// Sanitise at THIS boundary (the engine is authoritative) so no render site can be tricked into
// executing markup — a name like `<img src=x onerror=…>` would otherwise run in every player's
// browser on a wallet-connected page.
export function cleanDisplayName(raw: unknown, max = 24): string {
  return String(raw ?? "")
    .replace(/[<>&"'`\\]/g, "")                 // markup + attribute breakers
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")   // control chars
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")  // bidi overrides (name spoofing)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Avatars are rendered as image URLs — allow only plain http(s), never javascript:/data:. */
export function cleanAvatarUrl(raw: unknown, max = 200): string {
  const s = String(raw ?? "").replace(/[<>"'`\\\s]/g, "").slice(0, max);
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : "";
}

/** Get-or-create an account for a wallet. */
export function acct(wallet: string, side: Side): Account {
  let a = ledger.get(wallet);
  if (!a) { a = { id: wallet, name: "You", side, bull: 0, uwu: 0, sol: 0, isBot: false, dep: 0, ret: 0, games: 0, wins: 0 }; ledger.set(wallet, a); }
  return a;
}

/** The wire shape of a wallet's balance push. Pure over the ledger. */
/** USD value of one unit of a field. `sol` is stored in USD units already, so it is 1. */
function usdPer(field: "bull" | "uwu" | "sol"): number {
  if (field === "sol") return 1;
  const px = priceUSD(field === "bull" ? "ansem" : "uwu");
  return px && px > 0 ? px : 0;
}
/** What an account is actually WORTH, in dollars. Never sum the raw fields: two of them are token
 *  counts and one is dollars, so a bare `bull + uwu + sol` is meaningless. */
export function accountUsd(a: Account): number {
  return (a.bull || 0) * usdPer("bull") + (a.uwu || 0) * usdPer("uwu") + (a.sol || 0);
}

export function balPayload(wallet: string) {
  const a = ledger.get(wallet);
  // Dollar figures computed HERE, where the prices and the deposit split are known. depIn/wOut mix
  // units by design (SPL deposits are token counts, SOL deposits are USD units), and depInSol tracks
  // the SOL portion — so the token portion is the remainder, priced at the account's side token.
  const sideField = ((a?.side === "bull" ? "bull" : "uwu")) as "bull" | "uwu";
  const px = usdPer(sideField);
  const solIn = a?.depInSol || 0, solOut = a?.wOutSol || 0;
  const tokIn = Math.max(0, (a?.depIn || 0) - solIn), tokOut = Math.max(0, (a?.wOut || 0) - solOut);
  const investedUsd = (tokIn * px + solIn) - (tokOut * px + solOut);
  return { t: "balance", wallet, bull: a?.bull || 0, uwu: a?.uwu || 0, sol: a?.sol || 0,
           depIn: a?.depIn || 0, wOut: a?.wOut || 0, refEarned: a?.refEarned || 0,
           games: a?.games || 0, wins: a?.wins || 0,
           // what the balance is WORTH and what it COST, both in dollars
           valueUsd: a ? accountUsd(a) : 0,
           investedUsd,
           prices: { bull: usdPer("bull"), uwu: usdPer("uwu") } };
}

/** Has this account ever touched money? Anyone can authenticate a freshly generated keypair for
 *  free, so accounts with no activity are treated as ephemeral: they are never persisted and never
 *  enter the leaderboard walk. Without this, junk accounts cost real CPU (leadersFor runs ~8x/sec)
 *  and inflate every broadcast — a remote DoS that needs no funds. */
export function hasActivity(a: Account): boolean {
  return a.isBot || a.bull > 0 || a.uwu > 0 || a.sol > 0 || a.dep > 0 || a.ret > 0 ||
         a.games > 0 || (a.depIn || 0) > 0 || (a.wOut || 0) > 0 || (a.refEarned || 0) > 0;
}

// Leaderboard the engine owns, so real players actually appear on it (bots are scoped to the arena).
// What a fighter is CALLED in public. An X handle if they connected one; otherwise a shortened
// address. Invented handles like "bagChaser_6" read as house bots the moment anyone looks twice —
// a wallet stub is what an unnamed participant actually is.
const B58ID = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789";
function walletTag(id: string): string {
  if (!id.includes(":bot:")) return id.slice(0, 4) + "…" + id.slice(-3);
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  let out = "";
  for (let i = 0; i < 7; i++) { out += B58ID[h % B58ID.length]; h = Math.imul(h ^ (h >>> 13), 2246822507) >>> 0; }
  return out.slice(0, 4) + "…" + out.slice(4);
}
/** An X identity is the only thing that earns a real name on the board. */
export function publicName(a: Account): string {
  const n = (a.name || "").trim();
  if (a.avatar && n && n !== "You") return n;      // connected X handle
  if (!a.isBot && n.startsWith("@")) return n;
  return walletTag(a.id);
}

/** Standings computed from the ROUND LOG rather than from whoever still has an account.
 *
 *  A board built from live balances is a survey of survivors: a fighter who won, cashed out and
 *  retired disappears along with their profit, so the aggregate can only ever look negative. It also
 *  reads ~0 for anyone mid-round, because their stake has left their balance and sits in the round.
 *
 *  The log has neither problem. Every settled round is recorded permanently with each fighter's
 *  entry and exit, and the same rows are committed to on-chain by the `results` hash — so these
 *  standings are reconstructible by anyone from Solana plus /round, without trusting us. */
export interface Standing {
  id: string; name: string; rounds: number; wins: number;
  staked: number; returned: number; pnl: number; roi: number; best: number;
}
export function standingsFromLog(arena?: string, limit = 40): Standing[] {
  const by = new Map<string, Standing>();
  for (const r of roundLog) {
    if (arena && r.arena !== arena) continue;
    const winSide = r.winner;
    for (const p of r.players) {
      let row = by.get(p.id);
      if (!row) {
        row = { id: p.id, name: p.name || p.id, rounds: 0, wins: 0,
                staked: 0, returned: 0, pnl: 0, roi: 0, best: 0 };
        by.set(p.id, row);
      }
      row.rounds++;
      if (p.side === winSide) row.wins++;
      row.staked += p.inUsd || 0;
      row.returned += p.outUsd || 0;
      const net = (p.outUsd || 0) - (p.inUsd || 0);
      if (net > row.best) row.best = net;
      if (p.name) row.name = p.name;                 // keep the freshest handle
    }
  }
  const rows = [...by.values()];
  for (const r of rows) {
    r.pnl = r.returned - r.staked;
    r.roi = r.staked > 0 ? r.pnl / r.staked : 0;
  }
  return rows.sort((a, b) => b.pnl - a.pnl).slice(0, limit);
}

export function leadersFor(aid: string) {
  const list = [...ledger.values()].filter(a => (a.isBot ? a.id.startsWith(aid + ":") : hasActivity(a)));
  // Everything on this board is DOLLARS. dep/ret/raided are accumulated in token units by the
  // settlement path, so they are converted with the account's own side token rather than shown raw.
  const rows = list.map(a => {
    const sideField = (a.side === "bull" ? "bull" : "uwu") as "bull" | "uwu";
    const px = usdPer(sideField);
    const value = accountUsd(a);
    // dep/ret are already dollars (accumulated at the round's price) — do NOT re-price them
    const depUsd = a.dep || 0, retUsd = a.ret || 0;
    return { id: a.id, name: publicName(a), avatar: a.avatar, side: a.side, value,
      games: a.games, wins: a.wins, isBot: a.isBot,
      dep: depUsd, ret: retUsd, raided: (a.raided || 0) * px, best: (a.best || 0) * px,
      // a player's cost basis is what they DEPOSITED (depIn/wOut are token units of what they moved
      // on-chain); a bot has no deposit, so its P/L is simply what it won against what it staked
      pnl: a.isBot ? retUsd - depUsd
                   : value + (a.wOut || 0) * px - (a.depIn || 0) * px };
  })
    .sort((x, y) => y.pnl - x.pnl);          // board ranks by total P&L
  const top = rows.slice(0, 40).map((r, i) => ({ ...r, rank: i + 1 }));
  // real players always appear, even outside the top 40 — otherwise you can play a round and never see yourself
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.isBot && !top.some(t => t.id === r.id)) top.push({ ...r, rank: i + 1 });
  }
  return top;
}

/** Queue a durable snapshot of the whole money state (debounced in store.ts). */
export function persist() {
  // Only accounts that hold or have moved money are written. A zero-activity account is identical
  // to one acct() would recreate on demand, so dropping it is lossless for balances (it only forgets
  // a cosmetic display name) — and it stops free account creation from bloating the ledger forever.
  saveSnapshot({ accounts: [...ledger.values()].filter(hasActivity), treasury, totalDeployed, depSide, created,
                 busted: bustedCount, convFees, rounds, roundsByArena, statsA, floatRecoveredAt,
                 roundLog: roundLog.slice(0, 200) } as any);
}

/** Wipe lifetime P&L counters. Balances are NEVER touched — dep/ret/games/wins/raided/best are
 *  display statistics, and theirs were accumulated in mixed units before the USD fix. */
/** A retired account keeps its record: balances go back to the pool, but games/wins/dep/ret stay so
 *  the board is not a survey of survivors. Deleting them is what made "nobody is profitable" true
 *  no matter how the game actually went. */
export function isRetired(a: Account): boolean { return (a as any).retired === true; }

export function resetLifetimeStats(): number {
  let n = 0;
  for (const a of ledger.values()) {
    if (!(a.dep || a.ret || a.games || a.wins || a.raided || a.best)) continue;
    a.dep = 0; a.ret = 0; a.games = 0; a.wins = 0; a.raided = 0; a.best = 0;
    n++;
  }
  return n;
}

/** Load the last snapshot on boot, then write off any SOL liability not backed by a real deposit. */
export function restore() {
  const snap = loadSnapshot(); if (!snap) return;
  for (const a of snap.accounts || []) {
    // re-sanitise on load: a ledger written before names were sanitised could carry stored markup
    a.name = cleanDisplayName(a.name) || String(a.id).slice(0, 6);
    if (a.avatar) a.avatar = cleanAvatarUrl(a.avatar);
    ledger.set(a.id, a);
  }
  Object.assign(treasury, snap.treasury || {});
  Object.assign(totalDeployed, snap.totalDeployed || {});
  Object.assign(depSide, (snap as any).depSide || {});
  Object.assign(created, snap.created || {});
  Object.assign(bustedCount, snap.busted || {});
  Object.assign(rounds, snap.rounds || {});
  Object.assign(roundsByArena, (snap as any).roundsByArena || {});
  roundLog.length = 0;
  for (const r of ((snap as any).roundLog || [])) roundLog.push(r);
  convFees = snap.convFees || 0;
  floatRecoveredAt = (snap as any).floatRecoveredAt || 0;
  Object.assign(statsA, (snap as any).statsA || {});
  // RECONCILE: SOL units must be backed by real deposits. Test faucets used to credit the ledger
  // directly, leaving liability the vault could not honour. Anything unbacked is written off here.
  let wroteOff = 0, touched = 0;
  for (const a of ledger.values()) {
    if (a.isBot) continue;
    const backed = Math.max(0, (a.depInSol || 0) - (a.wOutSol || 0));
    if ((a.sol || 0) > backed + 0.0001) { wroteOff += (a.sol || 0) - backed; a.sol = backed; touched++; }
  }
  if (wroteOff > 0.01) {
    console.log(`reconciled ledger: wrote off ${wroteOff.toFixed(2)} unbacked SOL units across ${touched} account(s)`);
    setTimeout(persist, 0);   // write the corrected ledger immediately, not on the next money event
  }
  const players = [...ledger.values()].filter(a => !a.isBot);
  console.log(`restored ledger: ${ledger.size} accounts (${players.length} real) from disk`);
}

/** Flush any pending snapshot synchronously — used on shutdown so nothing in flight is lost. */
export function flush() { flushSnapshot(); }
