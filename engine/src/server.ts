// Bulls ⚔ Unicorns engine server.
// Runs both mode round-loops, drives hybrid bots, keeps a ledger, and streams state to clients
// over WebSocket. On-chain settlement (settle_round) + Postgres are wired in the *-onchain
// modules; this server runs standalone (in-memory ledger) so it can host the devnet test now.
import { WebSocketServer, WebSocket } from "ws";
import { RoundRunner } from "./round.ts";
import type { RoundResult, RoundState } from "./round.ts";
import type { Mode, Side } from "./game.ts";

const PORT = Number(process.env.PORT || 8090);

// ---- ledger: real players (by wallet) + persistent bot accounts ----
interface Account { id: string; name: string; side: Side; bull: number; uwu: number; isBot: boolean; dep: number; ret: number; games: number; wins: number; }
const ledger = new Map<string, Account>();
const NAMES = ["degenDan","sol_sniper","0xViper","moonboy","apeQueen","gm_gary","liqLarry","chartchad","frenFred","bagChaser","pumpkin","gigaGwei","turboTina","sendit","wenLambo","diamondD","fomoFrank","nakamotto","zkZoe","based_bri"];
let seq = 0;
function newBot(mode: Mode, side: Side): Account { const id = `${mode}:bot:${++seq}`; const a: Account = { id, name: NAMES[seq % NAMES.length] + "_" + seq, side, bull: side==="bull"? 60+Math.random()*180 : 0, uwu: side==="uwu"? 60+Math.random()*180 : 0, isBot: true, dep:0, ret:0, games:0, wins:0 }; ledger.set(id, a); return a; }
function seedBots(mode: Mode, n: number) { for (let i=0;i<n;i++) newBot(mode, i%2 ? "uwu":"bull"); }
const botsFor = (mode: Mode) => [...ledger.values()].filter(a => a.isBot && a.id.startsWith(mode+":"));

// ---- round runners per mode ----
const clients = new Set<WebSocket>();
function broadcast(msg: unknown) { const s = JSON.stringify(msg); for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s); }

async function onSettle(mode: Mode, r: RoundResult, s: RoundState) {
  // credit each entry's final wallet balance back to its account (bots + players)
  for (const [id, bal] of Object.entries(r.settlement)) {
    const a = ledger.get(id); if (!a) continue;
    a.bull += bal.bull; a.uwu += bal.uwu; a.games++; a.ret += bal.bull + bal.uwu;
    if (a.side === r.winner) a.wins++;
  }
  // hybrid bots: bust the broke, add fresh (growing base; throttles down as real players fill)
  const realPlaying = s.entries.filter(e => !e.id.includes(":bot:")).length;
  for (const a of botsFor(mode)) if (a.bull + a.uwu < 5) ledger.delete(a.id);
  const targetBots = Math.max(6, 22 - realPlaying * 2);
  while (botsFor(mode).length < targetBots) newBot(mode, botsFor(mode).filter(b=>b.side==="bull").length <= botsFor(mode).filter(b=>b.side==="uwu").length ? "bull":"uwu");
  broadcast({ t: "settled", mode, round: s.round, winner: r.winner, seed: s.seed, seedHash: s.seedHashPublished, hits: r.hits.length });
}

const runners: Record<Mode, RoundRunner> = {
  normal: new RoundRunner("normal", (r, s) => onSettle("normal", r, s)),
  extraction: new RoundRunner("extraction", (r, s) => onSettle("extraction", r, s)),
};
seedBots("normal", 22); seedBots("extraction", 22);

// bots auto-enter each lobby (a fraction, with a fee taken on deploy)
const FEE = 0.002, CAP = 100;
function botsEnter(mode: Mode) {
  const rn = runners[mode]; if (rn.state.phase !== "lobby") return;
  for (const a of botsFor(mode)) {
    if (Math.random() < 0.6) continue;                      // not every bot plays every round
    const bankroll = a.side === "bull" ? a.bull : a.uwu;
    const stake = Math.min(Math.max(6, bankroll * (0.18 + Math.random()*0.37)), CAP, bankroll);
    if (stake < 6) continue;
    if (a.side === "bull") a.bull -= stake; else a.uwu -= stake;
    rn.enter(a.id, a.side, stake * (1 - FEE));               // net of deploy fee
  }
}

// ---- tick loop ----
let lastPhase: Record<Mode, string> = { normal: "", extraction: "" };
setInterval(async () => {
  for (const mode of ["normal", "extraction"] as Mode[]) {
    const rn = runners[mode];
    if (rn.state.phase === "lobby" && lastPhase[mode] !== "lobby") botsEnter(mode); // seed bots at lobby start
    lastPhase[mode] = rn.state.phase;
    await rn.tick();
  }
}, 500);

// broadcast a light state snapshot for the UI
setInterval(() => {
  const snap = (mode: Mode) => { const s = runners[mode].state; return { round: s.round, phase: s.phase, multiplier: s.multiplier, entries: s.entries.length, seedHash: s.seedHashPublished, closesInMs: Math.max(0, s.closesAt - Date.now()) }; };
  broadcast({ t: "state", normal: snap("normal"), extraction: snap("extraction"), accounts: { normal: botsFor("normal").length, extraction: botsFor("extraction").length } });
}, 1000);

// ---- websocket ----
const wss = new WebSocketServer({ port: PORT });
wss.on("error", (e) => console.error("wss error:", (e as Error).message));
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("error", () => clients.delete(ws));   // don't crash on a client disconnect/error
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.t === "enter") {                                  // { t:'enter', wallet, mode, side, stake }
        const a = ledger.get(m.wallet) || (ledger.set(m.wallet, { id: m.wallet, name: "You", side: m.side, bull: 0, uwu: 0, isBot: false, dep:0, ret:0, games:0, wins:0 }).get(m.wallet)!);
        // (real deposits credit a.bull/a.uwu via the on-chain deposit watcher; here we trust the reserve)
        runners[m.mode as Mode].enter(m.wallet, m.side, m.stake * (1 - FEE));
      }
    } catch {}
  });
});
console.log(`⚔  engine live on ws://localhost:${PORT}  (normal + extraction, hybrid bots)`);
