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
import { loadSnapshot, saveSnapshot, flushSnapshot } from "./store.ts";

const PORT = Number(process.env.PORT || 8090);

// ---- arena registry: pairing × economy. Slot A/B map onto the 2-team sim's bull/uwu slots. ----
// Token names: ansem (ledger field `bull`), uwu, sol. SOL arenas play from the `sol` balance
// (funded via fundMe on test chains; native-SOL on-chain deposits are the next wiring step).
type Tok = "ansem" | "uwu" | "sol";
const FIELD: Record<Tok, "bull" | "uwu" | "sol"> = { ansem: "bull", uwu: "uwu", sol: "sol" };
const PAIRINGS: Record<string, [Tok, Tok]> = { au: ["ansem", "uwu"], as: ["ansem", "sol"], us: ["uwu", "sol"] };
const ARENA_IDS = Object.keys(PAIRINGS).flatMap(p => ["normal", "extraction"].map(e => `${p}-${e}`));
const arenaTokens = (aid: string): [Tok, Tok] => PAIRINGS[aid.split("-")[0]];
const arenaEco = (aid: string): Mode => aid.split("-")[1] as Mode;
const FEE = 0.001, CAP = 100, CONVERT_FEE = 0.003, MIN_ENTRY = 0.01;   // convert = PumpSwap pool fee (0.30%), swap executed on-chain at mainnet

// ---- ledger: real players (by wallet) + persistent bot accounts ----
interface Account { id: string; name: string; side: Side; bull: number; uwu: number; sol: number; isBot: boolean; dep: number; ret: number; games: number; wins: number;
  raided?: number; best?: number; depIn?: number; wOut?: number;
  refBy?: string; refEarned?: number; avatar?: string; }   // referral: who brought them, and lifetime cut earned   // real on-chain money in / out — the basis for true P&L
const ledger = new Map<string, Account>();
const NAMES = ["degenDan","sol_sniper","0xViper","moonboy","apeQueen","gm_gary","liqLarry","chartchad","frenFred","bagChaser","pumpkin","gigaGwei","turboTina","sendit","wenLambo","diamondD","fomoFrank","nakamotto","zkZoe","based_bri","saylorsz","jitoJoe","rugproof","exitliq","ser_pump","mevMike","validatorV","anonape","solstice","tapedeck"];
// community growth: the arena starts small and fills up over time
const POP_START = Number(process.env.POP_START || 22), POP_GROWTH = Number(process.env.POP_GROWTH || 0.7), POP_MAX = Number(process.env.POP_MAX || 90);
const rounds: Record<Mode, number> = { normal: 0, extraction: 0 };
const roundsByArena: Record<string, number> = {};
// house take: the 0.2% skimmed on every deploy, tracked per mode
const treasury: Record<Mode, number> = { normal: 0, extraction: 0 };
let convFees = 0;   // 1% taken when players swap raided enemy coin back to their own side

function persist() {
  saveSnapshot({ accounts: [...ledger.values()], treasury, totalDeployed, depSide, created,
                 busted: bustedCount, convFees, rounds });
}
function restore() {
  const snap = loadSnapshot(); if (!snap) return;
  for (const a of snap.accounts || []) ledger.set(a.id, a);
  Object.assign(treasury, snap.treasury || {});
  Object.assign(totalDeployed, snap.totalDeployed || {});
  Object.assign(depSide, (snap as any).depSide || {});
  Object.assign(created, snap.created || {});
  Object.assign(bustedCount, snap.busted || {});
  Object.assign(rounds, snap.rounds || {});
  convFees = snap.convFees || 0;
  const players = [...ledger.values()].filter(a => !a.isBot);
  console.log(`restored ledger: ${ledger.size} accounts (${players.length} real) from disk`);
}
const totalDeployed: Record<Mode, number> = { normal: 0, extraction: 0 };
const depSide: Record<Mode, { bull: number; uwu: number }> = { normal: { bull: 0, uwu: 0 }, extraction: { bull: 0, uwu: 0 } };
const created: Record<Mode, number> = { normal: 0, extraction: 0 };
const bustedCount: Record<Mode, number> = { normal: 0, extraction: 0 };
const BOT_BANK_MIN = Number(process.env.BOT_BANK_MIN || 60), BOT_BANK_MAX = Number(process.env.BOT_BANK_MAX || 240), BOT_STAKE_MIN = Number(process.env.BOT_STAKE_MIN || 6);
const B58 = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789";
const walletish = () => { let s=""; for(let i=0;i<4;i++) s += B58[(Math.random()*B58.length)|0]; return s + "…" + B58[(Math.random()*B58.length)|0] + B58[(Math.random()*B58.length)|0] + B58[(Math.random()*B58.length)|0]; };
let seq = 0;
function newBot(aid: string, side: Side): Account {
  const id = `${aid}:bot:${++seq}`;
  // a third of newcomers show up as raw addresses — fresh wallets, no handle yet
  const name = Math.random() < 0.34 ? walletish() : NAMES[(Math.random()*NAMES.length)|0] + "_" + seq;
  const bank = BOT_BANK_MIN + Math.random() * (BOT_BANK_MAX - BOT_BANK_MIN);
  const a: Account = { id, name, side, bull: 0, uwu: 0, sol: 0, isBot: true, dep: 0, ret: 0, games: 0, wins: 0 };
  // bank in the arena's token for this bot's slot
  const toks = arenaTokens(aid) || (["ansem", "uwu"] as [Tok, Tok]);
  a[FIELD[toks[side === "bull" ? 0 : 1]]] = bank;
  ledger.set(id, a); created[arenaEco(aid)]++; return a;
}
function seedBots(aid: string, n: number) { for (let i=0;i<n;i++) newBot(aid, i%2 ? "uwu":"bull"); }
const botsFor = (aid: string) => [...ledger.values()].filter(a => a.isBot && a.id.startsWith(aid+":"));
function acct(wallet: string, side: Side): Account {
  let a = ledger.get(wallet);
  if (!a) { a = { id: wallet, name: "You", side, bull: 0, uwu: 0, sol: 0, isBot: false, dep:0, ret:0, games:0, wins:0 }; ledger.set(wallet, a); }
  return a;
}

// ---- clients ----
const clients = new Set<WebSocket>();
const walletOf = new Map<WebSocket, string>();          // ws -> wallet (for targeted balance pushes)
function broadcast(msg: unknown) { const s = JSON.stringify(msg); for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s); }
function balPayload(wallet: string) { const a = ledger.get(wallet);
  return { t: "balance", wallet, bull: a?.bull||0, uwu: a?.uwu||0, sol: a?.sol||0,
           depIn: a?.depIn||0, wOut: a?.wOut||0, refEarned: a?.refEarned||0,
           games: a?.games||0, wins: a?.wins||0 }; }

// Leaderboard the engine owns, so real players actually appear on it.
function leadersFor(aid: string) {
  const list = [...ledger.values()].filter(a => (a.isBot ? a.id.startsWith(aid + ":") : true));
  const rows = list.map(a => ({ id: a.id, name: a.name, avatar: a.avatar, side: a.side, value: a.bull + a.uwu + a.sol,
      games: a.games, wins: a.wins, isBot: a.isBot,
      dep: a.dep, ret: a.ret, raided: a.raided||0, best: a.best||0,
      pnl: a.isBot ? a.ret - a.dep : (a.bull + a.uwu + a.sol) + (a.wOut||0) - (a.depIn||0) }))
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

async function onSettle(aid: string, r: RoundResult, s: RoundState) {
  const mode = arenaEco(aid);
  const [tokA, tokB] = arenaTokens(aid);
  const touched = new Set<string>();
  for (const [key, bal] of Object.entries(r.settlement)) {
    const id = key.split("|")[0];
    const a = ledger.get(id); if (!a) continue;
    a[FIELD[tokA]] += bal.bull; a[FIELD[tokB]] += bal.uwu; a.games++; a.ret += bal.bull + bal.uwu;
    if (a.side === r.winner) a.wins++;
    const f = r.fighters.find(x => x.id === key);
    if (f) { a.raided = (a.raided||0) + f.raided; if (f.bestHit > (a.best||0)) a.best = f.bestHit; }
    if (!a.isBot) touched.add(id);
  }
  // Hybrid bots as a *community that grows*: broke wallets leave, new wallets arrive every
  // round, and the population target creeps up over time — while still throttling down as
  // real players fill the arena, so bots never crowd out humans.
  const realPlaying = s.entries.filter(e => !e.id.includes(":bot:")).length;
  let busted = 0;
  const BUST = Number(process.env.BOT_BUST || Math.min(5, BOT_BANK_MIN * 0.4));
  for (const a of botsFor(aid)) if (a.bull + a.uwu + a.sol < BUST) { ledger.delete(a.id); busted++; bustedCount[mode]++; }
  rounds[mode]++; roundsByArena[aid] = (roundsByArena[aid] || 0) + 1;
  const popCap = Math.min(POP_MAX, POP_START + Math.floor((roundsByArena[aid] || 0) * POP_GROWTH));
  const target = Math.max(Number(process.env.POP_MIN || 12), popCap - realPlaying * 2);
  let joined = 0;
  while (botsFor(aid).length < target) {
    newBot(aid, botsFor(aid).filter(b=>b.side==="bull").length <= botsFor(aid).filter(b=>b.side==="uwu").length ? "bull":"uwu");
    joined++;
  }
  broadcast({ t: "settled", arena: aid, mode, round: s.round, winner: r.winner, seed: s.seed, seedHash: s.seedHashPublished,
              settlement: r.settlement, hits: r.hits.length,
              community: { total: botsFor(aid).length + realPlaying, joined, busted, cap: popCap } });
  for (const w of touched) pushBalance(w);
  persist();
}

const runners: Record<string, RoundRunner> = {};
for (const aid of ARENA_IDS) runners[aid] = new RoundRunner(arenaEco(aid), (r, s) => onSettle(aid, r, s));
restore();
const SEED = Number(process.env.SEED_BOTS || 18);
for (const aid of ARENA_IDS) if (botsFor(aid).length === 0) seedBots(aid, SEED);

// bots auto-enter each lobby (a fraction, with a fee taken on deploy)
function botsEnter(aid: string) {
  const rn = runners[aid]; if (rn.state.phase !== "lobby") return;
  const [tokA, tokB] = arenaTokens(aid);
  for (const a of botsFor(aid)) {
    if (Math.random() < 0.25) continue;                     // most wallets play each round
    const myTok = a.side === "bull" ? tokA : tokB;
    const bankroll = a[FIELD[myTok]];
    const stake = Math.min(Math.max(BOT_STAKE_MIN, bankroll * (0.18 + Math.random()*0.37)), CAP, bankroll);
    if (stake < BOT_STAKE_MIN) continue;
    a[FIELD[myTok]] -= stake;
    const mode = arenaEco(aid);
    a.dep += stake; treasury[mode] += stake * FEE; totalDeployed[mode] += stake; depSide[mode][a.side] += stake;
    rn.enter(`${a.id}|${a.side}`, a.side, stake * (1 - FEE));   // net of deploy fee
  }
}

// name lookup so clients can label fighters
const nameFor = (key: string) => { const id = key.split("|")[0];
  return ledger.get(id)?.name || (id.length > 8 ? id.slice(0,4)+"…"+id.slice(-4) : id); };

// ---- tick loop ----
const lastPhase: Record<string, string> = {};
setInterval(async () => {
  for (const aid of ARENA_IDS) {
    const mode = arenaEco(aid);
    const rn = runners[aid];
    if (rn.state.phase === "lobby" && lastPhase[aid] !== "lobby") botsEnter(aid);
    const was = rn.state.phase;
    lastPhase[aid] = rn.state.phase;
    await rn.tick();
    if (was === "lobby" && rn.state.phase === "battle" && rn.state.result) {
      const s = rn.state;
      broadcast({ t: "roundStart", arena: aid, mode, round: s.round, multiplier: s.multiplier,
        seed: s.seed, seedHash: s.seedHashPublished,
        entries: s.entries.map(e => ({ id: e.id, wallet: e.id.split("|")[0], side: e.side, stake: e.stake, name: nameFor(e.id), avatar: ledger.get(e.id.split("|")[0])?.avatar, bot: e.id.includes(":bot:") })),
        cfg: newRoundConfig(mode, s.multiplier),
        hitCount: s.result.hits.length, winner: s.result.winner, settlement: s.result.settlement,
        startedAt: Date.now(), battleMs: s.battleMs || newRoundConfig(mode, s.multiplier).battleMs });
    }
  }
}, 500);

// broadcast a light state snapshot for the UI
setInterval(() => {
  const snap = (aid: string) => { const mode = arenaEco(aid); const s = runners[aid].state; return { arena: aid, tokens: arenaTokens(aid), round: s.round, phase: s.phase, multiplier: s.multiplier, entries: s.entries.length, seedHash: s.seedHashPublished, closesInMs: Math.max(0, s.closesAt - Date.now()),
    // who's already in the lobby, so the arena shows fighters gathering instead of sitting empty
    list: s.phase === "lobby" ? s.entries.slice(0, 40).map(e => ({ id: e.id, name: nameFor(e.id), side: e.side, stake: e.stake })) : [],
    leaders: leadersFor(aid),
    house: { take: treasury[mode], conv: convFees, deployed: totalDeployed[mode],
             depBull: depSide[mode].bull, depUwu: depSide[mode].uwu,
             accounts: botsFor(aid).length,
             bulls: botsFor(aid).filter(a => a.side === "bull").length,
             unis: botsFor(aid).filter(a => a.side === "uwu").length,
             created: created[mode], busted: bustedCount[mode] } }; };
  const arenas: Record<string, unknown> = {};
  for (const aid of ARENA_IDS) arenas[aid] = snap(aid);
  broadcast({ t: "state", arenas, normal: snap("au-normal"), extraction: snap("au-extraction") });
}, 1000);

// ---- websocket ----
const wss = new WebSocketServer({ port: PORT });
wss.on("error", (e) => {
  const err = e as NodeJS.ErrnoException;
  // Never limp along on a taken port: a second engine writing the same ledger file would
  // clobber real balances. Die loudly instead.
  if (err.code === "EADDRINUSE") {
    console.error(`FATAL: port ${PORT} is already in use — another engine is running. Exiting so the ledger stays consistent.`);
    process.exit(1);
  }
  console.error("wss error:", err.message);
});
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ t: "chain", ready: chainReady(), vault: chainReady() ? vaultPubkey() : null, mints: mints(), rpc: RPC }));
  // send the in-flight round immediately so a joiner isn't staring at an empty arena
  for (const aid of ARENA_IDS) {
    const mode = arenaEco(aid);
    const s = runners[aid].state;
    if (s.phase === "battle" && s.result) ws.send(JSON.stringify({ t: "roundStart", arena: aid, mode, round: s.round, multiplier: s.multiplier,
      seed: s.seed, seedHash: s.seedHashPublished,
      entries: s.entries.map(e => ({ id: e.id, wallet: e.id.split("|")[0], side: e.side, stake: e.stake, name: nameFor(e.id), bot: e.id.includes(":bot:") })),
      cfg: newRoundConfig(mode, s.multiplier), hitCount: s.result.hits.length, winner: s.result.winner, settlement: s.result.settlement,
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
      if (m.t === "enter") {          // { t:'enter', wallet, arena?|mode, side (slot A/B), stake }
        const aid = m.arena && runners[m.arena] ? m.arena : ("au-" + m.mode);
        const rn = runners[aid]; if (!rn) return;
        const [tokA, tokB] = arenaTokens(aid);
        const myTok = m.side === "bull" ? tokA : tokB;
        const a = acct(m.wallet, m.side);
        const bank = a[FIELD[myTok]];
        if (rn.state.phase !== "lobby") return ws.send(JSON.stringify({ t: "error", msg: "Deposits closed — wait for the next lobby." }));
        // the CAP is per side per round, so topping up cannot push you past it
        const already = rn.state.entries.filter(e => e.id === `${m.wallet}|${m.side}`)
                          .reduce((n, e) => n + e.stake / (1 - FEE), 0);
        const headroom = Math.max(0, CAP - already);
        const stake = Math.min(Number(m.stake)||0, bank, headroom);
        if (headroom < MIN_ENTRY) return ws.send(JSON.stringify({ t: "error", msg: `You're at the $${CAP} cap on that side this round.` }));
        if (stake < MIN_ENTRY) return ws.send(JSON.stringify({ t: "error", msg: `Minimum entry is $${MIN_ENTRY}.` }));
        a[FIELD[myTok]] -= stake;                                      // debit the arena token
        a.dep += stake; a.side = m.side;
        if (m.ref && !a.refBy && m.ref !== m.wallet) a.refBy = String(m.ref).slice(0, 64);
        const fee = stake * FEE;
        let refCut = 0;
        if (a.refBy) {   // referrer earns 10% of every fee their signups generate, forever
          refCut = fee * 0.10;
          const r = acct(a.refBy, m.side);
          if (m.side === "bull") r.bull += refCut; else r.uwu += refCut;
          r.refEarned = (r.refEarned || 0) + refCut;
          pushBalance(a.refBy);
        }
        const eco = arenaEco(aid);
        treasury[eco] += fee - refCut; totalDeployed[eco] += stake; depSide[eco][m.side as Side] += stake;
        rn.enter(`${m.wallet}|${m.side}`, m.side, stake * (1 - FEE));
        ws.send(JSON.stringify({ t: "entered", arena: aid, mode: arenaEco(aid), side: m.side, stake }));
        pushBalance(m.wallet); persist();
      } else if (m.t === "faucet") {                          // { t:'faucet', wallet, side }
        if (!chainReady()) return ws.send(JSON.stringify({ t: "error", msg: "chain not configured" }));
        const sig = await faucet(m.wallet, m.side, 500);
        ws.send(JSON.stringify({ t: "faucetDone", side: m.side, sig, amount: 500 }));
      } else if (m.t === "fundMe") {                          // one-click: SOL for fees + both tokens
        if (!chainReady()) return ws.send(JSON.stringify({ t: "error", msg: "chain not configured" }));
        const amt = Math.min(Math.max(Number(m.amount) || 500, 1), 1000);
        const steps: string[] = [];
        const sol = await solBalance(m.wallet);
        if (sol < 0.5) {
          try { await airdropSol(m.wallet, 2); steps.push("2 SOL"); }
          catch { steps.push("SOL airdrop unavailable (faucet limited) — you need a little SOL for fees"); }
        } else steps.push(`${sol.toFixed(2)} SOL already`);
        try { await faucet(m.wallet, "bull", amt); steps.push(amt + " BULL"); } catch (e) { steps.push("BULL failed: " + (e as Error).message); }
        try { await faucet(m.wallet, "uwu", amt); steps.push(amt + " UWU"); } catch (e) { steps.push("UWU failed: " + (e as Error).message); }
        { const a2 = acct(m.wallet, "bull"); a2.sol += amt; steps.push(amt + " SOL-units (arena credit)"); persist(); }
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
        pushBalance(m.wallet); persist();
      } else if (m.t === "withdraw") {                        // { t:'withdraw', wallet, side, amount }
        if (!chainReady()) return ws.send(JSON.stringify({ t: "error", msg: "chain not configured" }));
        const a = acct(m.wallet, m.side);
        const bank = m.side === "bull" ? a.bull : a.uwu;
        const amt = Math.min(Number(m.amount)||0, bank);
        if (amt < 0.01) return ws.send(JSON.stringify({ t: "error", msg: "Nothing to withdraw on that side." }));
        if (m.side === "bull") a.bull -= amt; else a.uwu -= amt;       // debit first, refund on failure
        pushBalance(m.wallet);
        try { const sig = await withdraw(m.wallet, m.side, amt); a.wOut = (a.wOut||0) + amt; persist(); ws.send(JSON.stringify({ t: "withdrawDone", side: m.side, amount: amt, sig })); }
        catch (e) { if (m.side === "bull") a.bull += amt; else a.uwu += amt; pushBalance(m.wallet);
                    ws.send(JSON.stringify({ t: "error", msg: "Withdraw failed: " + (e as Error).message })); }
      } else if (m.t === "convert") {          // { wallet, to:'bull'|'uwu', amount? }
        // You raid the ENEMY's coin, so your own side's token drains while theirs piles up.
        // Without this you eventually cannot deploy on your own side at all.
        const to: Side = m.to === "bull" ? "bull" : "uwu";
        const a = acct(m.wallet, to);
        const avail = to === "bull" ? a.uwu : a.bull;
        const amt = Math.min(Number(m.amount) > 0 ? Number(m.amount) : avail, avail);
        if (amt < 0.01) return ws.send(JSON.stringify({ t: "error", msg: "Nothing to convert." }));
        const fee = amt * CONVERT_FEE;
        if (to === "bull") { a.uwu -= amt; a.bull += amt - fee; }
        else { a.bull -= amt; a.uwu += amt - fee; }
        convFees += fee;
        ws.send(JSON.stringify({ t: "converted", to, amount: amt, fee }));
        pushBalance(m.wallet); persist();
      } else if (m.t === "chainBalance") {                    // on-chain (Phantom) balances
        if (!chainReady()) return;
        const [bull, uwu] = await Promise.all([walletTokenBalance(m.wallet, "bull"), walletTokenBalance(m.wallet, "uwu")]);
        ws.send(JSON.stringify({ t: "chainBalance", bull, uwu }));
      } else if (m.t === "setName") {          // { wallet, name, avatar } — X identity
        const a = acct(m.wallet, "bull");
        a.name = String(m.name || "").slice(0, 24) || a.name;
        if (m.avatar) a.avatar = String(m.avatar).slice(0, 200);
        ws.send(JSON.stringify({ t: "named", name: a.name }));
      } else if (m.t === "getBalance") {
        ws.send(JSON.stringify(balPayload(m.wallet)));
      }
    } catch (e) { ws.send(JSON.stringify({ t: "error", msg: (e as Error).message })); }
  });
});
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => { flushSnapshot(); console.log("ledger flushed to disk"); process.exit(0); });
process.on("exit", () => flushSnapshot());
console.log(`⚔  engine live on ws://localhost:${PORT}  (authoritative rounds + hybrid bots) chain=${chainReady()}`);
