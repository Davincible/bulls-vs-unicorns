// Bulls ⚔ Unicorns engine server — AUTHORITATIVE.
// The engine owns: the round lifecycle (commit-reveal), the battle simulation, and the
// game-wallet ledger. Clients are renderers + verifiers: they replay the broadcast hit log
// and can independently recompute the round from the revealed seed.
// On-chain: real SPL deposits credit the ledger; withdrawals are paid out of the vault.
import { WebSocketServer, WebSocket } from "ws";
import { RoundRunner, newRoundConfig } from "./round.ts";
import type { RoundResult, RoundState } from "./round.ts";
import type { Mode, Side } from "./game.ts";
import { chainReady, vaultPubkey, mints, faucet, verifyDeposit, withdraw, buildDepositTx, walletTokenBalance, airdropSol, solBalance } from "./chain-ops.ts";
import { RPC } from "./chain.ts";

const PORT = Number(process.env.PORT || 8090);
const FEE = 0.002, CAP = 100;

// ---- ledger: real players (by wallet) + persistent bot accounts ----
interface Account { id: string; name: string; side: Side; bull: number; uwu: number; isBot: boolean; dep: number; ret: number; games: number; wins: number;
  depIn?: number; wOut?: number; }   // real on-chain money in / out — the basis for true P&L
const ledger = new Map<string, Account>();
const NAMES = ["degenDan","sol_sniper","0xViper","moonboy","apeQueen","gm_gary","liqLarry","chartchad","frenFred","bagChaser","pumpkin","gigaGwei","turboTina","sendit","wenLambo","diamondD","fomoFrank","nakamotto","zkZoe","based_bri","saylorsz","jitoJoe","rugproof","exitliq","ser_pump","mevMike","validatorV","anonape","solstice","tapedeck"];
// community growth: the arena starts small and fills up over time
const POP_START = 14, POP_GROWTH = 0.5, POP_MAX = 60;
const rounds: Record<Mode, number> = { normal: 0, extraction: 0 };
const B58 = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789";
const walletish = () => { let s=""; for(let i=0;i<4;i++) s += B58[(Math.random()*B58.length)|0]; return s + "…" + B58[(Math.random()*B58.length)|0] + B58[(Math.random()*B58.length)|0] + B58[(Math.random()*B58.length)|0]; };
let seq = 0;
function newBot(mode: Mode, side: Side): Account {
  const id = `${mode}:bot:${++seq}`;
  // a third of newcomers show up as raw addresses — fresh wallets, no handle yet
  const name = Math.random() < 0.34 ? walletish() : NAMES[(Math.random()*NAMES.length)|0] + "_" + seq;
  const a: Account = { id, name, side, bull: side==="bull"? 60+Math.random()*180 : 0, uwu: side==="uwu"? 60+Math.random()*180 : 0, isBot: true, dep:0, ret:0, games:0, wins:0 };
  ledger.set(id, a); return a;
}
function seedBots(mode: Mode, n: number) { for (let i=0;i<n;i++) newBot(mode, i%2 ? "uwu":"bull"); }
const botsFor = (mode: Mode) => [...ledger.values()].filter(a => a.isBot && a.id.startsWith(mode+":"));
function acct(wallet: string, side: Side): Account {
  let a = ledger.get(wallet);
  if (!a) { a = { id: wallet, name: "You", side, bull: 0, uwu: 0, isBot: false, dep:0, ret:0, games:0, wins:0 }; ledger.set(wallet, a); }
  return a;
}

// ---- clients ----
const clients = new Set<WebSocket>();
const walletOf = new Map<WebSocket, string>();          // ws -> wallet (for targeted balance pushes)
function broadcast(msg: unknown) { const s = JSON.stringify(msg); for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s); }
function balPayload(wallet: string) { const a = ledger.get(wallet);
  return { t: "balance", wallet, bull: a?.bull||0, uwu: a?.uwu||0,
           depIn: a?.depIn||0, wOut: a?.wOut||0,      // client: invested = depIn - wOut
           games: a?.games||0, wins: a?.wins||0 }; }

// Leaderboard the engine owns, so real players actually appear on it.
function leadersFor(mode: Mode) {
  const list = [...ledger.values()].filter(a => (a.isBot ? a.id.startsWith(mode + ":") : true));
  const rows = list.map(a => ({ id: a.id, name: a.name, side: a.side, value: a.bull + a.uwu,
      games: a.games, wins: a.wins, isBot: a.isBot,
      pnl: a.isBot ? a.ret - a.dep : (a.bull + a.uwu) + (a.wOut||0) - (a.depIn||0) }))
    .sort((x, y) => y.value - x.value);
  const top = rows.slice(0, 12).map((r, i) => ({ ...r, rank: i + 1 }));
  // real players always appear, even when they're not in the top 12 — otherwise you can play a
  // round and never see yourself on the board
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.isBot && !top.some(t => t.id === r.id)) top.push({ ...r, rank: i + 1 });
  }
  return top;
}
function pushBalance(wallet: string) { const s = JSON.stringify(balPayload(wallet)); for (const c of clients) if (c.readyState===WebSocket.OPEN && walletOf.get(c)===wallet) c.send(s); }

async function onSettle(mode: Mode, r: RoundResult, s: RoundState) {
  const touched = new Set<string>();
  for (const [id, bal] of Object.entries(r.settlement)) {
    const a = ledger.get(id); if (!a) continue;
    a.bull += bal.bull; a.uwu += bal.uwu; a.games++; a.ret += bal.bull + bal.uwu;
    if (a.side === r.winner) a.wins++;
    if (!a.isBot) touched.add(id);
  }
  // Hybrid bots as a *community that grows*: broke wallets leave, new wallets arrive every
  // round, and the population target creeps up over time — while still throttling down as
  // real players fill the arena, so bots never crowd out humans.
  const realPlaying = s.entries.filter(e => !e.id.includes(":bot:")).length;
  let busted = 0;
  for (const a of botsFor(mode)) if (a.bull + a.uwu < 5) { ledger.delete(a.id); busted++; }
  rounds[mode]++;
  const popCap = Math.min(POP_MAX, POP_START + Math.floor(rounds[mode] * POP_GROWTH));
  const target = Math.max(8, popCap - realPlaying * 2);
  let joined = 0;
  while (botsFor(mode).length < target) {
    newBot(mode, botsFor(mode).filter(b=>b.side==="bull").length <= botsFor(mode).filter(b=>b.side==="uwu").length ? "bull":"uwu");
    joined++;
  }
  broadcast({ t: "settled", mode, round: s.round, winner: r.winner, seed: s.seed, seedHash: s.seedHashPublished,
              settlement: r.settlement, hits: r.hits.length,
              community: { total: botsFor(mode).length + realPlaying, joined, busted, cap: popCap } });
  for (const w of touched) pushBalance(w);
}

const runners: Record<Mode, RoundRunner> = {
  normal: new RoundRunner("normal", (r, s) => onSettle("normal", r, s)),
  extraction: new RoundRunner("extraction", (r, s) => onSettle("extraction", r, s)),
};
// start below the population cap so the arena visibly fills up as rounds go by
seedBots("normal", 12); seedBots("extraction", 12);

// bots auto-enter each lobby (a fraction, with a fee taken on deploy)
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

// name lookup so clients can label fighters
const nameFor = (id: string) => ledger.get(id)?.name || (id.length > 8 ? id.slice(0,4)+"…"+id.slice(-4) : id);

// ---- tick loop ----
const lastPhase: Record<Mode, string> = { normal: "", extraction: "" };
setInterval(async () => {
  for (const mode of ["normal", "extraction"] as Mode[]) {
    const rn = runners[mode];
    if (rn.state.phase === "lobby" && lastPhase[mode] !== "lobby") botsEnter(mode); // seed bots at lobby start
    const was = rn.state.phase;
    lastPhase[mode] = rn.state.phase;
    await rn.tick();
    // battle just started → broadcast the FULL replayable round (seed revealed + ordered hit log)
    if (was === "lobby" && rn.state.phase === "battle" && rn.state.result) {
      const s = rn.state;
      broadcast({ t: "roundStart", mode, round: s.round, multiplier: s.multiplier,
        seed: s.seed, seedHash: s.seedHashPublished,
        entries: s.entries.map(e => ({ id: e.id, side: e.side, stake: e.stake, name: nameFor(e.id), bot: e.id.includes(":bot:") })),
        cfg: newRoundConfig(mode, s.multiplier),
        hits: s.result.hits, winner: s.result.winner, settlement: s.result.settlement,
        startedAt: Date.now(), battleMs: s.battleMs || newRoundConfig(mode, s.multiplier).battleMs });
    }
  }
}, 500);

// broadcast a light state snapshot for the UI
setInterval(() => {
  const snap = (mode: Mode) => { const s = runners[mode].state; return { round: s.round, phase: s.phase, multiplier: s.multiplier, entries: s.entries.length, seedHash: s.seedHashPublished, closesInMs: Math.max(0, s.closesAt - Date.now()),
    // who's already in the lobby, so the arena shows fighters gathering instead of sitting empty
    list: s.phase === "lobby" ? s.entries.slice(0, 40).map(e => ({ id: e.id, name: nameFor(e.id), side: e.side, stake: e.stake })) : [],
    leaders: leadersFor(mode) }; };
  broadcast({ t: "state", normal: snap("normal"), extraction: snap("extraction"), accounts: { normal: botsFor("normal").length, extraction: botsFor("extraction").length } });
}, 1000);

// ---- websocket ----
const wss = new WebSocketServer({ port: PORT });
wss.on("error", (e) => console.error("wss error:", (e as Error).message));
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ t: "chain", ready: chainReady(), vault: chainReady() ? vaultPubkey() : null, mints: mints(), rpc: RPC }));
  // send the in-flight round immediately so a joiner isn't staring at an empty arena
  for (const mode of ["normal","extraction"] as Mode[]) {
    const s = runners[mode].state;
    if (s.phase === "battle" && s.result) ws.send(JSON.stringify({ t: "roundStart", mode, round: s.round, multiplier: s.multiplier,
      seed: s.seed, seedHash: s.seedHashPublished,
      entries: s.entries.map(e => ({ id: e.id, side: e.side, stake: e.stake, name: nameFor(e.id), bot: e.id.includes(":bot:") })),
      cfg: newRoundConfig(mode, s.multiplier), hits: s.result.hits, winner: s.result.winner, settlement: s.result.settlement,
      startedAt: s.closesAt - (s.battleMs || newRoundConfig(mode, s.multiplier).battleMs),   // true start, so a joiner syncs mid-battle
      battleMs: s.battleMs || newRoundConfig(mode, s.multiplier).battleMs, resumed: true }));
  }
  const cleanup = () => { clients.delete(ws); walletOf.delete(ws); };
  ws.on("error", cleanup);
  ws.on("close", cleanup);
  ws.on("message", async (raw) => {
    let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (m.wallet) walletOf.set(ws, m.wallet);
      if (m.t === "enter") {                                  // { t:'enter', wallet, mode, side, stake }
        const a = acct(m.wallet, m.side);
        const bank = m.side === "bull" ? a.bull : a.uwu;
        const stake = Math.min(Number(m.stake)||0, bank, CAP);
        if (stake < 1) return ws.send(JSON.stringify({ t: "error", msg: "Insufficient game balance — deposit or use the faucet." }));
        const rn = runners[m.mode as Mode]; if (!rn) return;
        if (rn.state.phase !== "lobby") return ws.send(JSON.stringify({ t: "error", msg: "Deposits closed — wait for the next lobby." }));
        if (m.side === "bull") a.bull -= stake; else a.uwu -= stake;   // debit real balance into the round
        a.dep += stake; a.side = m.side;
        rn.enter(m.wallet, m.side, stake * (1 - FEE));
        ws.send(JSON.stringify({ t: "entered", mode: m.mode, side: m.side, stake }));
        pushBalance(m.wallet);
      } else if (m.t === "faucet") {                          // { t:'faucet', wallet, side }
        if (!chainReady()) return ws.send(JSON.stringify({ t: "error", msg: "chain not configured" }));
        const sig = await faucet(m.wallet, m.side, 500);
        ws.send(JSON.stringify({ t: "faucetDone", side: m.side, sig, amount: 500 }));
      } else if (m.t === "fundMe") {                          // one-click: SOL for fees + both tokens
        if (!chainReady()) return ws.send(JSON.stringify({ t: "error", msg: "chain not configured" }));
        const steps: string[] = [];
        const sol = await solBalance(m.wallet);
        if (sol < 0.5) {
          try { await airdropSol(m.wallet, 2); steps.push("2 SOL"); }
          catch { steps.push("SOL airdrop unavailable (faucet limited) — you need a little SOL for fees"); }
        } else steps.push(`${sol.toFixed(2)} SOL already`);
        try { await faucet(m.wallet, "bull", 500); steps.push("500 BULL"); } catch (e) { steps.push("BULL failed: " + (e as Error).message); }
        try { await faucet(m.wallet, "uwu", 500); steps.push("500 UWU"); } catch (e) { steps.push("UWU failed: " + (e as Error).message); }
        ws.send(JSON.stringify({ t: "fundMeDone", steps }));
      } else if (m.t === "solBalance") {
        if (!chainReady()) return;
        ws.send(JSON.stringify({ t: "solBalance", sol: await solBalance(m.wallet) }));
      } else if (m.t === "buildDeposit") {                  // → unsigned tx for Phantom to sign
        if (!chainReady()) return ws.send(JSON.stringify({ t: "error", msg: "chain not configured" }));
        const txB64 = await buildDepositTx(m.wallet, m.side, m.amount);
        ws.send(JSON.stringify({ t: "depositTx", side: m.side, amount: m.amount, txB64 }));
      } else if (m.t === "deposit") {                         // { t:'deposit', wallet, side, sig }
        if (!chainReady()) return;
        const credited = await verifyDeposit(m.sig, m.side);
        if (credited > 0) { const a = acct(m.wallet, m.side); if (m.side === "bull") a.bull += credited; else a.uwu += credited; a.depIn = (a.depIn||0) + credited; }
        ws.send(JSON.stringify({ t: "depositDone", side: m.side, credited, sig: m.sig }));
        pushBalance(m.wallet);
      } else if (m.t === "withdraw") {                        // { t:'withdraw', wallet, side, amount }
        if (!chainReady()) return ws.send(JSON.stringify({ t: "error", msg: "chain not configured" }));
        const a = acct(m.wallet, m.side);
        const bank = m.side === "bull" ? a.bull : a.uwu;
        const amt = Math.min(Number(m.amount)||0, bank);
        if (amt < 1) return ws.send(JSON.stringify({ t: "error", msg: "Nothing to withdraw on that side." }));
        if (m.side === "bull") a.bull -= amt; else a.uwu -= amt;       // debit first, refund on failure
        pushBalance(m.wallet);
        try { const sig = await withdraw(m.wallet, m.side, amt); a.wOut = (a.wOut||0) + amt; ws.send(JSON.stringify({ t: "withdrawDone", side: m.side, amount: amt, sig })); }
        catch (e) { if (m.side === "bull") a.bull += amt; else a.uwu += amt; pushBalance(m.wallet);
                    ws.send(JSON.stringify({ t: "error", msg: "Withdraw failed: " + (e as Error).message })); }
      } else if (m.t === "chainBalance") {                    // on-chain (Phantom) balances
        if (!chainReady()) return;
        const [bull, uwu] = await Promise.all([walletTokenBalance(m.wallet, "bull"), walletTokenBalance(m.wallet, "uwu")]);
        ws.send(JSON.stringify({ t: "chainBalance", bull, uwu }));
      } else if (m.t === "getBalance") {
        ws.send(JSON.stringify(balPayload(m.wallet)));
      }
    } catch (e) { ws.send(JSON.stringify({ t: "error", msg: (e as Error).message })); }
  });
});
console.log(`⚔  engine live on ws://localhost:${PORT}  (authoritative rounds + hybrid bots) chain=${chainReady()}`);
