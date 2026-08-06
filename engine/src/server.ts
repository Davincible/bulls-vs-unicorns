// Bulls ⚔ Unicorns engine server — AUTHORITATIVE.
// The engine owns: the round lifecycle (commit-reveal), the battle simulation, and the
// game-wallet ledger. Clients are renderers + verifiers: they replay the broadcast hit log
// and can independently recompute the round from the revealed seed.
// On-chain: real SPL deposits credit the ledger; withdrawals are paid out of the vault.
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { RoundRunner, newRoundConfig } from "./round.ts";
import type { RoundResult, RoundState } from "./round.ts";
import type { Mode, Side } from "./game.ts";
import { chainReady, vaultPubkey, mints, faucet, verifyDeposit, withdraw, buildDepositTx, walletTokenBalance, airdropSol, solBalance,
         buildSolDepositTx, verifySolDeposit, withdrawSol } from "./chain-ops.ts";
import { priceUSD, startPriceLoop, allPrices } from "./prices.ts";
import { RPC } from "./chain.ts";
import { GUARDED, isAuthed, challenge as authChallenge, verify as authVerify, forget as authForget } from "./auth.ts";
import { isAllowed as walletAllowed } from "./allowlist.ts";
import { start as startReconcile, isFrozen, latest as reconLatest } from "./reconcile.ts";
import { allowMessage, connectionAllowed, releaseConnection, LIMITS } from "./limits.ts";
import { type Account, ledger, rounds, roundsByArena, statsA, stat, treasury, totalDeployed, depSide,
         created, bustedCount, getConvFees, addConvFees, persist, restore, flush,
         acct, balPayload, leadersFor, cleanDisplayName, cleanAvatarUrl } from "./ledger.ts";
import { RoundRunnerN, cfgN } from "./roundN.ts";
import { type Tok, FIELD, PAIRINGS, ARENA_IDS, arenaTokens, arenaEco, NARENAS, NARENA_IDS,
         FEE, CAP, CONVERT_FEE, MIN_ENTRY } from "./arenas.ts";

const PORT = Number(process.env.PORT || 8090);
// SOL arenas are denominated in USD units. On a test chain the price feed may be irrelevant, so
// SOL_USD lets us pin a rate; otherwise we use the live price and REFUSE to quote when it's stale.
const SOL_USD_FIXED = Number(process.env.SOL_USD || 0);
// FAUCETS MINT UNBACKED CREDIT. They are test-chain only: fundMe/faucet hand out tokens and
// SOL units with no deposit behind them, so on mainnet they would let anyone withdraw real
// funds against invented balance. Hard-disabled unless the RPC is a test chain.
const IS_TEST_CHAIN = /localhost|127\.0\.0\.1|devnet|testnet/i.test(RPC);
const FAUCET_ON = IS_TEST_CHAIN && process.env.DISABLE_FAUCET !== "1";
if (!FAUCET_ON) console.log("faucets DISABLED (mainnet-safe): fundMe/faucet will be refused");
const solUsd = () => SOL_USD_FIXED > 0 ? SOL_USD_FIXED : priceUSD("sol");
startPriceLoop();

// ---- arena registry lives in ./arenas.ts (pure: Tok/FIELD/PAIRINGS/ARENA_IDS/arenaTokens/
// arenaEco for 2-team, NARENAS/NARENA_IDS for N-team, plus the FEE/CAP/CONVERT_FEE/MIN_ENTRY economy
// constants). Slot A/B map onto the 2-team sim's bull/uwu slots; SOL arenas play from `sol`.

// ---- ledger lives in ./ledger.ts (Account/ledger/treasury/statsA/rounds/totalDeployed/depSide/
// created/bustedCount/persist/restore/flush/acct/balPayload/leadersFor + convFees accessors).
// Bot generation and client bookkeeping stay here. ----
const NAMES = ["degenDan","sol_sniper","0xViper","moonboy","apeQueen","gm_gary","liqLarry","chartchad","frenFred","bagChaser","pumpkin","gigaGwei","turboTina","sendit","wenLambo","diamondD","fomoFrank","nakamotto","zkZoe","based_bri","saylorsz","jitoJoe","rugproof","exitliq","ser_pump","mevMike","validatorV","anonape","solstice","tapedeck"];
// community growth: the arena starts small and fills up over time
const POP_START = Number(process.env.POP_START || 22), POP_GROWTH = Number(process.env.POP_GROWTH || 0.7), POP_MAX = Number(process.env.POP_MAX || 90);
const BOT_BANK_MIN = Number(process.env.BOT_BANK_MIN || 60), BOT_BANK_MAX = Number(process.env.BOT_BANK_MAX || 240), BOT_STAKE_MIN = Number(process.env.BOT_STAKE_MIN || 6);
// how many bots actually enter a round, per side (keeps a huge population from flooding one lobby)
const PLAY_MIN = Number(process.env.PLAY_MIN || 0), PLAY_MAX = Number(process.env.PLAY_MAX || 0);
const BOT_STAKE_MAX = Number(process.env.BOT_STAKE_MAX || 0);
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

// ---- clients ----
const clients = new Set<WebSocket>();
const walletOf = new Map<WebSocket, string>();          // ws -> wallet (for targeted balance pushes)
// AUTH lives in ./auth.ts — a socket must prove control of a wallet (sign a nonce) before any
// money operation on it. GUARDED / isAuthed / authChallenge / authVerify / authForget are imported.
function broadcast(msg: unknown) { const s = JSON.stringify(msg); for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s); }
// balPayload + leadersFor now live in ./ledger.ts (imported). pushBalance stays — it needs `clients`.
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
  { const st = stat(aid); st.matches++; if (r.winner === "bull") st.winsA++; else st.winsB++; }
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

// settle an N-team round: entry ids are "wallet|team", payouts land in that team's token
async function onSettleN(aid: string, r: any, s: any) {
  const def = NARENAS[aid]; const touched = new Set<string>();
  for (const [key, amount] of Object.entries(r.settlement as Record<string, number>)) {
    const [wallet, teamStr] = key.split("|");
    const a = ledger.get(wallet); if (!a) continue;
    const teamIdx = Number(teamStr) || 0;
    const tok = def.teams === 0 ? def.toks[0] : def.toks[teamIdx] || def.toks[0];
    a[FIELD[tok]] += amount as number; a.games++; a.ret += amount as number;
    if (!a.isBot) touched.add(wallet);
  }
  const realPlaying = s.entries.filter((e: any) => !String(e.id).includes(":bot:")).length;
  let busted = 0;
  const BUST = Number(process.env.BOT_BUST || Math.min(5, BOT_BANK_MIN * 0.4));
  for (const a of botsFor(aid)) if (a.bull + a.uwu + a.sol < BUST) { ledger.delete(a.id); busted++; }
  roundsByArena[aid] = (roundsByArena[aid] || 0) + 1;
  { const st = stat(aid); st.matches++; if (r.winnerTeam === 0) st.winsA++; else st.winsB++; }
  const popCap = Math.min(POP_MAX, POP_START + Math.floor((roundsByArena[aid] || 0) * POP_GROWTH));
  const target = Math.max(Number(process.env.POP_MIN || 12), popCap - realPlaying * 2);
  let joined = 0;
  while (botsFor(aid).length < target) { newBotN(aid); joined++; }
  broadcast({ t: "roundStartN", phase: "settled", arena: aid, round: s.round, winnerTeam: r.winnerTeam,
              winnerId: r.winnerId, seed: s.seed, seedHash: s.seedHashPublished, teamTotals: r.teamTotals });
  for (const w of touched) pushBalance(w);
  persist();
}
// bots for N arenas: pick a team slot, bank in that team's token
function newBotN(aid: string): Account {
  const def = NARENAS[aid];
  const id = `${aid}:bot:${++seq}`;
  const name = Math.random() < 0.34 ? walletish() : NAMES[(Math.random()*NAMES.length)|0] + "_" + seq;
  const bank = BOT_BANK_MIN + Math.random() * (BOT_BANK_MAX - BOT_BANK_MIN);
  const team = def.teams === 0 ? 0 : Math.floor(Math.random() * def.teams);
  const a: Account = { id, name, side: team === 1 ? "uwu" : "bull", bull: 0, uwu: 0, sol: 0,
                       isBot: true, dep: 0, ret: 0, games: 0, wins: 0 };
  (a as any).nteam = team;
  a[FIELD[def.toks[def.teams === 0 ? 0 : team]]] = bank;
  ledger.set(id, a); return a;
}
function botsEnterN(aid: string) {
  const rn = runnersN[aid]; if (rn.state.phase !== "lobby") return;
  const def = NARENAS[aid];
  let pool = botsFor(aid);
  if (PLAY_MAX > 0) pool = pool.sort(() => Math.random() - 0.5).slice(0, PLAY_MIN + Math.floor(Math.random() * Math.max(1, PLAY_MAX - PLAY_MIN + 1)));
  for (const a of pool) {
    if (PLAY_MAX === 0 && Math.random() < 0.25) continue;
    const team = (a as any).nteam ?? 0;
    const tok = def.toks[def.teams === 0 ? 0 : team] || def.toks[0];
    if (a[FIELD[tok]] < BOT_STAKE_MIN) {            // swap raided enemy coin back to our army's token
      for (const other of def.toks) {
        if (other === tok) continue;
        if (a[FIELD[other]] > BOT_STAKE_MIN) {
          const swap = a[FIELD[other]] * (0.5 + Math.random() * 0.5);
          const fee = swap * CONVERT_FEE;
          a[FIELD[other]] -= swap; a[FIELD[tok]] += swap - fee; addConvFees(fee);
          break;
        }
      }
    }
    const bankroll = a[FIELD[tok]];
    const stake = BOT_STAKE_MAX > 0
      ? Math.min(BOT_STAKE_MIN + Math.random() * (BOT_STAKE_MAX - BOT_STAKE_MIN), bankroll)
      : Math.min(Math.max(BOT_STAKE_MIN, bankroll * (0.18 + Math.random() * 0.37)), CAP, bankroll);
    if (stake < BOT_STAKE_MIN) continue;
    a[FIELD[tok]] -= stake;
    const eco = NARENAS[aid].eco;
    a.dep += stake; treasury[eco] += stake * FEE; totalDeployed[eco] += stake;
    stat(aid).deployed += stake; stat(aid).take += stake * FEE;
    rn.enter(`${a.id}|${def.teams === 0 ? 0 : team}`, def.teams === 0 ? 0 : team, stake * (1 - FEE));
  }
}

const runners: Record<string, RoundRunner> = {};
for (const aid of ARENA_IDS) runners[aid] = new RoundRunner(arenaEco(aid), (r, s) => onSettle(aid, r, s));
const runnersN: Record<string, RoundRunnerN> = {};
for (const aid of NARENA_IDS) runnersN[aid] = new RoundRunnerN(NARENAS[aid].eco, NARENAS[aid].teams, (r, s) => onSettleN(aid, r as any, s as any));
restore();
// SOLVENCY: what real players could withdraw, per asset. Bots are internal credit (never paid to
// a real wallet) so they are NOT a liability. bull/uwu are whole tokens; sol is USD units.
function ledgerLiabilities() {
  let bull = 0, uwu = 0, solUsd = 0;
  // `|| 0` guards accounts that predate a field (e.g. older rows have no `sol`) — otherwise
  // Math.max(0, undefined) is NaN and poisons the whole liability figure.
  for (const a of ledger.values()) { if (a.isBot) continue; bull += Math.max(0, a.bull || 0); uwu += Math.max(0, a.uwu || 0); solUsd += Math.max(0, a.sol || 0); }
  return { bull, uwu, solUsd };
}
startReconcile(ledgerLiabilities, solUsd, Number(process.env.RECONCILE_MS || 15_000));
// prune bots whose arena no longer exists (ids from before the arena registry) so they stop
// bloating the ledger and the persisted snapshot
{
  const live = new Set([...ARENA_IDS, ...NARENA_IDS]);
  let dropped = 0;
  for (const [id, a] of [...ledger.entries()])
    if (a.isBot && !live.has(id.split(":")[0])) { ledger.delete(id); dropped++; }
  if (dropped) console.log(`pruned ${dropped} orphaned bot accounts from retired arenas`);
}
const SEED = Number(process.env.SEED_BOTS || 18);
for (const aid of ARENA_IDS) if (botsFor(aid).length === 0) seedBots(aid, SEED);
for (const aid of NARENA_IDS) { let guard = 0; while (botsFor(aid).length < SEED && guard++ < 500) newBotN(aid); }

// bots auto-enter each lobby (a fraction, with a fee taken on deploy)
function botsEnter(aid: string) {
  const rn = runners[aid]; if (rn.state.phase !== "lobby") return;
  const [tokA, tokB] = arenaTokens(aid);
  let pool = botsFor(aid);
  if (PLAY_MAX > 0) {   // cap entrants per side: pick a random slice of the community each round
    const want = () => PLAY_MIN + Math.floor(Math.random() * Math.max(1, PLAY_MAX - PLAY_MIN + 1));
    const pick = (side: Side) => {
      const arr = pool.filter(b => b.side === side).sort(() => Math.random() - 0.5);
      return arr.slice(0, want());
    };
    pool = [...pick("bull"), ...pick("uwu")];
  }
  for (const a of pool) {
    if (PLAY_MAX === 0 && Math.random() < 0.25) continue;   // legacy behaviour when uncapped
    const myTok = a.side === "bull" ? tokA : tokB;
    const otherTok = a.side === "bull" ? tokB : tokA;
    // top up the side we actually play from whatever we raided off the enemy
    if (a[FIELD[myTok]] < BOT_STAKE_MIN && a[FIELD[otherTok]] > BOT_STAKE_MIN) {
      const swap = a[FIELD[otherTok]] * (0.5 + Math.random() * 0.5);
      const fee = swap * CONVERT_FEE;
      a[FIELD[otherTok]] -= swap; a[FIELD[myTok]] += swap - fee; addConvFees(fee);
    }
    const bankroll = a[FIELD[myTok]];
    const stake = BOT_STAKE_MAX > 0
      ? Math.min(BOT_STAKE_MIN + Math.random() * (BOT_STAKE_MAX - BOT_STAKE_MIN), bankroll)
      : Math.min(Math.max(BOT_STAKE_MIN, bankroll * (0.18 + Math.random()*0.37)), CAP, bankroll);
    if (stake < BOT_STAKE_MIN) continue;
    a[FIELD[myTok]] -= stake;
    const mode = arenaEco(aid);
    a.dep += stake; treasury[mode] += stake * FEE; totalDeployed[mode] += stake;
    stat(aid).deployed += stake; stat(aid).take += stake * FEE; depSide[mode][a.side] += stake;
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
    if (rn.state.phase === "lobby" && lastPhase[aid] !== "lobby") botsEnter(aid);   // fires the instant the lobby opens
    const was = rn.state.phase;
    lastPhase[aid] = rn.state.phase;
    const settled = await rn.tick();
    if (settled && rn.state.phase === "lobby") { botsEnter(aid); lastPhase[aid] = "lobby"; }
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

// N-team arenas tick on the same cadence
const lastPhaseN: Record<string, string> = {};
setInterval(async () => {
  for (const aid of NARENA_IDS) {
    const rn = runnersN[aid];
    if (rn.state.phase === "lobby" && lastPhaseN[aid] !== "lobby") botsEnterN(aid);
    const was = rn.state.phase;
    lastPhaseN[aid] = rn.state.phase;
    const settledN = await rn.tick();
    if (settledN && rn.state.phase === "lobby") { botsEnterN(aid); lastPhaseN[aid] = "lobby"; }
    if (was === "lobby" && rn.state.phase === "battle" && rn.state.result) {
      const st = rn.state, def = NARENAS[aid];
      broadcast({ t: "roundStartN", arena: aid, teams: def.teams, toks: def.toks,
        round: st.round, multiplier: st.multiplier, seed: st.seed, seedHash: st.seedHashPublished,
        entries: st.entries.map(e => ({ id: e.id, wallet: String(e.id).split("|")[0], team: e.team,
          stake: e.stake, name: nameFor(String(e.id).split("|")[0]) })),
        cfg: cfgN(def.eco, def.teams, st.multiplier),
        hitCount: st.result.hits.length, winnerTeam: st.result.winnerTeam, winnerId: st.result.winnerId,
        settlement: st.result.settlement, teamTotals: st.result.teamTotals,
        startedAt: Date.now(), battleMs: st.battleMs });
    }
  }
}, 500);

// broadcast a light state snapshot for the UI
setInterval(() => {
  const snap = (aid: string) => { const mode = arenaEco(aid); const s = runners[aid].state; return { arena: aid, tokens: arenaTokens(aid), round: s.round, phase: s.phase, multiplier: s.multiplier, entries: s.entries.length, seedHash: s.seedHashPublished, closesInMs: Math.max(0, s.closesAt - Date.now()),
    // who's already in the lobby, so the arena shows fighters gathering instead of sitting empty
    list: s.phase === "lobby" ? s.entries.slice(0, 40).map(e => ({ id: e.id, name: nameFor(e.id), side: e.side, stake: e.stake })) : [],
    leaders: leadersFor(aid),
    stats: stat(aid),
    house: { take: treasury[mode], conv: getConvFees(), deployed: totalDeployed[mode],
             depBull: depSide[mode].bull, depUwu: depSide[mode].uwu,
             accounts: botsFor(aid).length,
             bulls: botsFor(aid).filter(a => a.side === "bull").length,
             unis: botsFor(aid).filter(a => a.side === "uwu").length,
             created: created[mode], busted: bustedCount[mode] } }; };
  const arenas: Record<string, unknown> = {};
  for (const aid of ARENA_IDS) arenas[aid] = snap(aid);
  for (const aid of NARENA_IDS) { const rn = runnersN[aid]; const st = rn.state;
    arenas[aid] = { arena: aid, teams: NARENAS[aid].teams, toks: NARENAS[aid].toks, round: st.round,
      phase: st.phase, multiplier: st.multiplier, entries: st.entries.length,
      seedHash: st.seedHashPublished, closesInMs: Math.max(0, st.closesAt - Date.now()),
      stats: stat(aid), accounts: botsFor(aid).length }; }
  broadcast({ t: "state", arenas, normal: snap("au-normal"), extraction: snap("au-extraction") });
}, 1000);

// ---- http + websocket on one port ----
// The engine speaks ws for the game, but hosts (Fly/Railway/VPS) need a plain HTTP liveness probe,
// and the solvency report should be publicly readable (proof-of-reserves). So we own an http.Server
// for GET /health and GET /solvency and attach the ws server to it.
const bootAt = Date.now();
const httpServer = createServer((req, res) => {
  const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
  const url = (req.url || "/").split("?")[0];
  if (req.method !== "GET") { res.writeHead(405, cors); return res.end('{"error":"GET only"}'); }
  if (url === "/health" || url === "/") {
    // 200 only when solvent — a frozen book is unhealthy so a host can page on it
    const body = { ok: !isFrozen(), chain: chainReady(), vault: chainReady() ? vaultPubkey() : null,
                   arenas: ARENA_IDS.length + NARENA_IDS.length, frozen: isFrozen(),
                   uptimeSec: Math.floor((Date.now() - bootAt) / 1000) };
    res.writeHead(isFrozen() ? 503 : 200, cors); return res.end(JSON.stringify(body));
  }
  if (url === "/solvency") {
    res.writeHead(200, cors);
    return res.end(JSON.stringify({ frozen: isFrozen(), vault: chainReady() ? vaultPubkey() : null, report: reconLatest() }));
  }
  res.writeHead(404, cors); res.end('{"error":"not found"}');
});
httpServer.on("error", (e) => {
  const err = e as NodeJS.ErrnoException;
  // Never limp along on a taken port: a second engine writing the same ledger file would
  // clobber real balances. Die loudly instead.
  if (err.code === "EADDRINUSE") {
    console.error(`FATAL: port ${PORT} is already in use — another engine is running. Exiting so the ledger stays consistent.`);
    process.exit(1);
  }
  console.error("http error:", err.message);
});
const wss = new WebSocketServer({ server: httpServer });
wss.on("error", (e) => console.error("wss error:", (e as Error).message));
httpServer.listen(PORT);
wss.on("connection", (ws, req) => {
  // Cap concurrent sockets per address before doing any work for this client. Behind a proxy this
  // sees the proxy's address, so a hosted deploy should also rate-limit at the edge.
  const ip = String(req?.socket?.remoteAddress || "unknown");
  if (!connectionAllowed(ip)) {
    ws.close(1013, "too many connections");   // 1013 = try again later
    return;
  }
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
  // ...and the same for N-team arenas (3-WAY / FFA). Without this, loading the page while a 3-way
  // or FFA round is mid-battle showed an EMPTY arena until the next round opened (up to ~60s).
  for (const aid of NARENA_IDS) {
    const def = NARENAS[aid];
    const st = runnersN[aid].state;
    if (st.phase !== "battle" || !st.result) continue;
    const cfg = cfgN(def.eco, def.teams, st.multiplier);
    ws.send(JSON.stringify({ t: "roundStartN", arena: aid, teams: def.teams, toks: def.toks,
      round: st.round, multiplier: st.multiplier, seed: st.seed, seedHash: st.seedHashPublished,
      entries: st.entries.map(e => ({ id: e.id, wallet: String(e.id).split("|")[0], team: e.team,
        stake: e.stake, name: nameFor(String(e.id).split("|")[0]) })),
      cfg, hitCount: st.result.hits.length, winnerTeam: st.result.winnerTeam, winnerId: st.result.winnerId,
      settlement: st.result.settlement, teamTotals: st.result.teamTotals,
      startedAt: st.closesAt - (st.battleMs || cfg.battleMs),   // true start, so a joiner syncs mid-battle
      battleMs: st.battleMs || cfg.battleMs, resumed: true }));
  }
  const cleanup = () => { clients.delete(ws); walletOf.delete(ws); authForget(ws); releaseConnection(ws, ip); };
  ws.on("error", cleanup);
  ws.on("close", cleanup);
  ws.on("message", async (raw) => {
    let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
    // Over-budget messages are dropped silently — answering would hand an attacker free amplification.
    if (!allowMessage(ws, typeof m?.t === "string" ? m.t : undefined)) return;
    try {
      if (m.wallet) walletOf.set(ws, m.wallet);
      // gate every wallet-scoped, side-effectful message behind proof of ownership (see auth.ts)
      if (GUARDED.has(m.t) && !isAuthed(ws, m.wallet)) {
        return ws.send(JSON.stringify({ t: "authRequired", msg: "Sign in with your wallet first." }));
      }
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
        stat(aid).deployed += stake; stat(aid).take += fee;
        rn.enter(`${m.wallet}|${m.side}`, m.side, stake * (1 - FEE));
        ws.send(JSON.stringify({ t: "entered", arena: aid, mode: arenaEco(aid), side: m.side, stake }));
        pushBalance(m.wallet); persist();
      } else if (m.t === "resync") {          // { arenas: ["au-normal", ...] } -> in-flight rounds
        for (const aid of (m.arenas || ARENA_IDS)) {
          const rn = runners[aid]; if (!rn) continue;
          const st = rn.state;
          if (st.phase === "battle" && st.result) {
            const cfg = newRoundConfig(arenaEco(aid), st.multiplier);
            ws.send(JSON.stringify({ t: "roundStart", arena: aid, mode: arenaEco(aid), round: st.round,
              multiplier: st.multiplier, seed: st.seed, seedHash: st.seedHashPublished,
              entries: st.entries.map(e => ({ id: e.id, wallet: e.id.split("|")[0], side: e.side,
                stake: e.stake, name: nameFor(e.id), avatar: ledger.get(e.id.split("|")[0])?.avatar,
                bot: e.id.includes(":bot:") })),
              cfg, hitCount: st.result.hits.length, winner: st.result.winner, settlement: st.result.settlement,
              startedAt: st.closesAt - (st.battleMs || cfg.battleMs), battleMs: st.battleMs || cfg.battleMs, resumed: true }));
          }
        }
      } else if (m.t === "enterN") {     // { wallet, arena, team, stake }
        const aid = String(m.arena || ""); const rn = runnersN[aid];
        if (!rn) return ws.send(JSON.stringify({ t: "error", msg: "unknown arena" }));
        if (rn.state.phase !== "lobby") return ws.send(JSON.stringify({ t: "error", msg: "Deploys closed — next lobby soon." }));
        const def = NARENAS[aid];
        const team = def.teams === 0 ? 0 : Math.max(0, Math.min(def.teams - 1, Number(m.team) || 0));
        const tok = def.toks[def.teams === 0 ? 0 : team] || def.toks[0];
        const a = acct(m.wallet, "bull");
        const bank = a[FIELD[tok]];
        const already = rn.state.entries.filter(e => e.id === `${m.wallet}|${team}`).reduce((n, e) => n + e.stake / (1 - FEE), 0);
        const stake = Math.min(Number(m.stake) || 0, bank, Math.max(0, CAP - already));
        if (stake < MIN_ENTRY) return ws.send(JSON.stringify({ t: "error", msg: "Insufficient balance for that arena's token." }));
        a[FIELD[tok]] -= stake; a.dep += stake;
        const eco = def.eco;
        treasury[eco] += stake * FEE; totalDeployed[eco] += stake;
        stat(aid).deployed += stake; stat(aid).take += stake * FEE;
        rn.enter(`${m.wallet}|${team}`, team, stake * (1 - FEE));
        ws.send(JSON.stringify({ t: "enteredN", arena: aid, team, stake }));
        pushBalance(m.wallet); persist();
      } else if (m.t === "faucet") {                          // { t:'faucet', wallet, side }
        if (!FAUCET_ON) return ws.send(JSON.stringify({ t: "error", msg: "Faucet is disabled on this network — deposit real tokens instead." }));
        if (!chainReady()) return ws.send(JSON.stringify({ t: "error", msg: "chain not configured" }));
        const sig = await faucet(m.wallet, m.side, 500);
        ws.send(JSON.stringify({ t: "faucetDone", side: m.side, sig, amount: 500 }));
      } else if (m.t === "fundMe") {
        if (!FAUCET_ON) return ws.send(JSON.stringify({ t: "error", msg: "Faucet is disabled on this network — deposit real tokens instead." }));                          // one-click: SOL for fees + both tokens
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
        // NOTE: no ledger credit here. The faucet funds the wallet; balance only moves on a
        // verified on-chain deposit (see depositSol) so every unit is backed by vault holdings.
        ws.send(JSON.stringify({ t: "fundMeDone", steps }));
      } else if (m.t === "solBalance") {
        if (!chainReady()) return;
        ws.send(JSON.stringify({ t: "solBalance", sol: await solBalance(m.wallet) }));
      } else if (m.t === "buildSolDeposit") {   // { wallet, sol } -> unsigned system transfer
        const px = solUsd();
        if (!px) return ws.send(JSON.stringify({ t: "error", msg: "SOL price unavailable right now — try again in a moment." }));
        const txB64 = await buildSolDepositTx(m.wallet, Number(m.sol) || 0);
        ws.send(JSON.stringify({ t: "solDepositTx", sol: Number(m.sol) || 0, priceUsd: px, txB64 }));
      } else if (m.t === "depositSol") {        // { wallet, sig } -> credit USD units at live price
        const px = solUsd();
        if (!px) return ws.send(JSON.stringify({ t: "error", msg: "SOL price unavailable — deposit not credited yet, retry shortly." }));
        const sol = await verifySolDeposit(String(m.sig));
        if (sol > 0) { const a = acct(m.wallet, "bull"); const units = sol * px;
          a.sol += units; a.depIn = (a.depIn || 0) + units; a.depInSol = (a.depInSol || 0) + units; persist(); }
        ws.send(JSON.stringify({ t: "depositSolDone", sol, priceUsd: px, credited: sol * px }));
        pushBalance(m.wallet);
      } else if (m.t === "withdrawSol") {       // { wallet, units } -> pay out native SOL
        if (isFrozen()) return ws.send(JSON.stringify({ t: "error", msg: "Withdrawals are temporarily paused (solvency check). Try again shortly." }));
        const px = solUsd();
        if (!px) return ws.send(JSON.stringify({ t: "error", msg: "SOL price unavailable — withdrawal paused." }));
        const a = acct(m.wallet, "bull");
        const units = Math.min(Number(m.units) || 0, a.sol);
        if (units < MIN_ENTRY) return ws.send(JSON.stringify({ t: "error", msg: "Nothing to withdraw." }));
        const sol = units / px;
        a.sol -= units; pushBalance(m.wallet);
        try { const sig = await withdrawSol(m.wallet, sol); a.wOut = (a.wOut || 0) + units; a.wOutSol = (a.wOutSol || 0) + units; persist();
              ws.send(JSON.stringify({ t: "withdrawSolDone", units, sol, priceUsd: px, sig })); }
        catch (e) { a.sol += units; pushBalance(m.wallet);
              ws.send(JSON.stringify({ t: "error", msg: "SOL withdraw failed: " + (e as Error).message })); }
      } else if (m.t === "prices") {
        ws.send(JSON.stringify({ t: "prices", prices: allPrices(), solUsd: solUsd() }));
      } else if (m.t === "solvency") {          // public proof-of-reserves: last reconciliation report
        ws.send(JSON.stringify({ t: "solvency", frozen: isFrozen(), report: reconLatest() }));
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
        if (isFrozen()) return ws.send(JSON.stringify({ t: "error", msg: "Withdrawals are temporarily paused (solvency check). Try again shortly." }));
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
        addConvFees(fee);
        ws.send(JSON.stringify({ t: "converted", to, amount: amt, fee }));
        pushBalance(m.wallet); persist();
      } else if (m.t === "chainBalance") {                    // on-chain (Phantom) balances
        if (!chainReady()) return;
        const [bull, uwu] = await Promise.all([walletTokenBalance(m.wallet, "bull"), walletTokenBalance(m.wallet, "uwu")]);
        ws.send(JSON.stringify({ t: "chainBalance", bull, uwu }));
      } else if (m.t === "setName") {          // { wallet, name, avatar } — X identity
        const a = acct(m.wallet, "bull");
        // sanitised here (not at render): names/avatars are broadcast to every client and
        // interpolated into the DOM — see cleanDisplayName/cleanAvatarUrl in ledger.ts
        a.name = cleanDisplayName(m.name) || a.name;
        if (m.avatar) a.avatar = cleanAvatarUrl(m.avatar);
        ws.send(JSON.stringify({ t: "named", name: a.name }));
      } else if (m.t === "authChallenge") {          // { wallet } -> a nonce to sign
        ws.send(JSON.stringify({ t: "authChallenge", nonce: authChallenge(ws) }));
      } else if (m.t === "authVerify") {             // { wallet, signature (base64) }
        // closed-beta gate: on a live chain, only whitelisted wallets may authenticate. Refuse
        // BEFORE checking the signature so a valid non-listed wallet still can't get in.
        if (!walletAllowed(m.wallet)) {
          return ws.send(JSON.stringify({ t: "authResult", ok: false, wallet: m.wallet, msg: "This wallet isn't on the launch whitelist yet." }));
        }
        const r = authVerify(ws, m.wallet, m.signature);
        ws.send(JSON.stringify({ t: "authResult", ...r }));
      } else if (m.t === "getBalance") {
        if (!isAuthed(ws, m.wallet)) return;         // balances are private; only the owner may read
        ws.send(JSON.stringify(balPayload(m.wallet)));
      }
    } catch (e) { ws.send(JSON.stringify({ t: "error", msg: (e as Error).message })); }
  });
});
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => { flush(); console.log("ledger flushed to disk"); process.exit(0); });
process.on("exit", () => flush());
console.log(`⚔  engine live on ws://localhost:${PORT}  (authoritative rounds + hybrid bots) chain=${chainReady()}`);
