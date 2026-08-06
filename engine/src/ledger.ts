// ledger — the authoritative money state: every account (real players by wallet + persistent bot
// accounts), the house treasury, per-arena stats, and durable persistence. This is the service
// that Phase B swaps from SQLite to on-chain ER accounts, so keeping it behind one module (instead
// of scattered through server.ts) is what makes that migration a contained change.
//
// Balances: bull/uwu are whole tokens; sol is USD units (the vault holds native SOL, converted at
// the live price). dep/ret are play-money P&L; depIn/wOut are REAL on-chain money in/out.
import type { Side, Mode } from "./game.ts";
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
// per-arena economics for the dashboard: deployed, house take, matches, slot wins
export const statsA: Record<string, { deployed: number; take: number; matches: number; winsA: number; winsB: number }> = {};
export const stat = (aid: string) => (statsA[aid] ||= { deployed: 0, take: 0, matches: 0, winsA: 0, winsB: 0 });
// house take: the 0.2% skimmed on every deploy, tracked per mode
export const treasury: Record<Mode, number> = { normal: 0, extraction: 0 };
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
export function balPayload(wallet: string) {
  const a = ledger.get(wallet);
  return { t: "balance", wallet, bull: a?.bull || 0, uwu: a?.uwu || 0, sol: a?.sol || 0,
           depIn: a?.depIn || 0, wOut: a?.wOut || 0, refEarned: a?.refEarned || 0,
           games: a?.games || 0, wins: a?.wins || 0 };
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
export function leadersFor(aid: string) {
  const list = [...ledger.values()].filter(a => (a.isBot ? a.id.startsWith(aid + ":") : hasActivity(a)));
  const rows = list.map(a => ({ id: a.id, name: a.name, avatar: a.avatar, side: a.side, value: a.bull + a.uwu + a.sol,
      games: a.games, wins: a.wins, isBot: a.isBot,
      dep: a.dep, ret: a.ret, raided: a.raided || 0, best: a.best || 0,
      pnl: a.isBot ? a.ret - a.dep : (a.bull + a.uwu + a.sol) + (a.wOut || 0) - (a.depIn || 0) }))
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
                 busted: bustedCount, convFees, rounds, statsA, floatRecoveredAt } as any);
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
