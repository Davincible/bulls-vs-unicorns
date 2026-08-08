// Bulls ⚔ Unicorns engine server — AUTHORITATIVE.
// The engine owns: the round lifecycle (commit-reveal), the battle simulation, and the
// game-wallet ledger. Clients are renderers + verifiers: they replay the broadcast hit log
// and can independently recompute the round from the revealed seed.
// On-chain: real SPL deposits credit the ledger; withdrawals are paid out of the vault.
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { readFile } from "node:fs";
import { resolve as pathResolve, join as pathJoin, extname, sep as pathSep, posix as pathPosix, dirname as pathDirname } from "node:path";
import { fileURLToPath as toPath } from "node:url";
import { RoundRunner, newRoundConfig } from "./round.ts";
import type { RoundResult, RoundState } from "./round.ts";
import type { Mode, Side } from "./game.ts";
import { chainReady, vaultPubkey, mints, faucet, verifyDeposit, withdraw, buildDepositTx, walletTokenBalance, airdropSol, solBalance, broadcastSigned,
         buildSolDepositTx, verifySolDeposit, withdrawSol, inspectRelayTx } from "./chain-ops.ts";
// ER FORK: devnet-only. This asserts BEFORE anything else can initialise a connection, a vault or
// a swap. Import order matters here — a guard that runs after the chain module has already picked
// up a mainnet RPC is decoration.
// NO FORK COUPLING IN PRODUCTION.
//
// This file previously called assertForkIsDevnetOnly() at boot — a guard belonging to the MagicBlock
// ER fork, which is devnet-only by construction. On this app, which runs on mainnet by design, it
// threw on startup and the process exited code 1 in a restart loop until the machine gave up. The
// live game was down until the image was rolled back.
//
// The guard is not wrong; it is simply not ours. A devnet fork's safety rail must never be able to
// stop the mainnet product from booting, and the fork's own files stay untouched for its own use.
import { priceUSD, startPriceLoop, allPrices, refreshPrices } from "./prices.ts";
import { RPC, loadVaultKeypair } from "./chain.ts";
import { swapExact } from "./swap.ts";
import { anchorRound, memoStats, resultsPayload, resultsHash, setMemoFeeSink, setAnchorSink } from "./memo.ts";
import { redact, redactDeep } from "./redact.ts";
import { GUARDED, isAuthed, challenge as authChallenge, verify as authVerify, forget as authForget,
         mintSession, resume as authResume } from "./auth.ts";
import { isAllowed as walletAllowed } from "./allowlist.ts";
import { start as startReconcile, isFrozen, latest as reconLatest } from "./reconcile.ts";
import { allowMessage, connectionAllowed, releaseConnection, LIMITS } from "./limits.ts";
import { initBotBank, drawBank, returnBank, takeExact, poolBalance, botBankReady, type Field } from "./bot-bank.ts";
import { recoverInPlace, resyncPoolToChain, writeDownOverclaim } from "./recover-float.ts";
import { getFloatRecoveredAt, markFloatRecovered } from "./ledger.ts";
import { poolPubkeys } from "./bot-wallets.ts";
import { vaultTokenBalance } from "./chain-ops.ts";
import { hallOfFame, walletHistory } from "./ledger.ts";
import { type Account, ledger, rounds, roundsByArena, statsA, stat, treasury, totalDeployed, depSide,
         created, bustedCount, getConvFees, addConvFees, persist, restore, flush, bankFee, TREASURY_ID,
         acct, balPayload, leadersFor, accountUsd, cleanDisplayName, cleanAvatarUrl,
         pushRound, roundHistory, markAnchored, resetLifetimeStats, treasuryAcct, standingsFromLog,
         publicName, setInRingReader } from "./ledger.ts";
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
// The browser submits its OWN signed transactions, so it needs an RPC endpoint — but it must never
// be handed ours when ours carries an API key (a keyed URL in the `chain` message is published to
// every visitor, and to the banner). Detect a keyed URL and substitute the public endpoint for that
// cluster; PUBLIC_RPC overrides. The keyed URL stays server-side only.
const RPC_HAS_SECRET = /[?&](api-key|apikey|key|token)=/i.test(RPC) || /\/v2\//i.test(RPC);
const CLIENT_RPC = process.env.PUBLIC_RPC
  || (RPC_HAS_SECRET ? (IS_TEST_CHAIN ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com") : RPC);
if (RPC_HAS_SECRET) console.log(`rpc: keyed endpoint kept server-side; clients get ${CLIENT_RPC}`);

const solUsd = () => SOL_USD_FIXED > 0 ? SOL_USD_FIXED : priceUSD("sol");
// Convert is now a REAL on-chain swap (swap.ts), so it is rate limited to one per round per wallet:
// each costs gas and crosses a spread. One lobby + one battle is the natural window.
const CONVERT_COOLDOWN_MS = Number(process.env.CONVERT_COOLDOWN_MS || 65_000);
// INTERNAL OTC. A convert does not have to touch Jupiter: if the house pool already holds the token
// the player wants, the treasury can be the counterparty. Ledger ownership moves, the vault's
// on-chain holdings do not, and the fee stays in-house instead of being paid to a pool.
//
// The fee is set to what the REAL route would have cost, so the player is never worse off and the
// house keeps the spread. A thin memecoin pair costs ~2% round trip (pool fee + spread + slippage),
// so we charge 1%; anything routed through SOL is cheap and liquid, so we charge the standard 0.3%.
// If the pool is short of the destination token we fall through to a genuine swap.
const OTC_FEE_TOKEN = Number(process.env.OTC_FEE_TOKEN || 0.01);   // token <-> token (e.g. UWU<->ANSEM)
const OTC_FEE_SOL = Number(process.env.OTC_FEE_SOL || 0.003);      // anything involving SOL
const OTC_ENABLED = process.env.OTC_DISABLE !== "1";
// The largest share of the vault's SPARE holdings (what is left after every other player is paid)
// that any ONE internal convert may consume. Beyond this we route to a genuine swap so the
// liquidity is really sourced rather than borrowed from the house's own book.
const OTC_MAX_FRACTION = Number(process.env.OTC_MAX_FRACTION || 0.25);
// How much of a player's stake the opposing army answers with. 1.0 = match it exactly, which keeps
// the matched book full so the player's whole entry is live rather than mostly refunded.
const MATCH_RATIO = Number(process.env.MATCH_RATIO || 1.0);
// How many fighters the house spreads a matched position across. Numbers are the house's edge:
// SMALL_EDGE tilts play toward smaller positions, so a swarm beats one whale holding the same total.
const SWARM_SIZE = Number(process.env.SWARM_SIZE || 8);
// What share of its bank a fighter commits per round. The old 18-55% produced dust in a thin arena.
const BOT_COMMIT_MIN = Number(process.env.BOT_COMMIT_MIN || 0.35);
const BOT_COMMIT_MAX = Number(process.env.BOT_COMMIT_MAX || 0.85);
const otcFeeFor = (a: Field, b: Field) => (a === "sol" || b === "sol") ? OTC_FEE_SOL : OTC_FEE_TOKEN;
const lastConvertAt = new Map<string, number>();
// load once - the vault signs every swap
let _vaultKp: ReturnType<typeof loadVaultKeypair> | null = null;
const vaultKeypair = () => (_vaultKp ||= loadVaultKeypair());
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
// Bot sizing is expressed in USD, not token counts. A flat "6 units" meant $1.03 of ANSEM but
// $0.18 of UWU and $6.00 of SOL - which is why SOL bots could never afford to deploy and that
// arena sat one-sided until everyone busted. Convert USD -> token units at the live price.
const BOT_BANK_USD_MIN = Number(process.env.BOT_BANK_USD_MIN || 8);
const BOT_BANK_USD_MAX = Number(process.env.BOT_BANK_USD_MAX || 20);
const BOT_STAKE_USD_MIN = Number(process.env.BOT_STAKE_USD_MIN || 0.5);
/** USD value of ONE ledger unit of a field. `sol` is already denominated in USD. */
function usdPerUnit(field: Field): number {
  if (field === "sol") return 1;
  const px = priceUSD(field === "bull" ? "ansem" : "uwu");
  return px && px > 0 ? px : 0;
}
// Every money value arriving from a client passes through here. `Number("Infinity") || 0` is
// Infinity, not 0 — so the usual `Number(m.x) || 0` idiom lets Infinity reach transaction
// construction, where Math.round(Infinity) produces a nonsense amount or throws. Reject rather than
// rely on each call site remembering to clamp.
const money = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const unitsForUsd = (field: Field, usd: number) => { const px = usdPerUnit(field); return px > 0 ? usd / px : 0; };
// A round is entered in USD and settled ~60s later. If the feed goes stale in between, converting
// the payout back at a zero price would divide by zero and wipe the winnings, so remember the last
// good price per field and settle against that rather than destroying money.
const lastGoodPx: Record<string, number> = { sol: 1 };
function usdPerUnitSafe(field: Field): number {
  const px = usdPerUnit(field);
  if (px > 0) { lastGoodPx[field] = px; return px; }
  return lastGoodPx[field] || 0;
}
/** Convert a USD amount back into units of `field`. Used on the settlement boundary. */
const unitsFromUsd = (field: Field, usd: number) => { const px = usdPerUnitSafe(field); return px > 0 ? usd / px : 0; };

// A ROUND IS PRICED ONCE. The sim runs in USD, so a stake is converted in at entry and the payout
// converted back out at settlement ~60s later. Using the live price at both ends let any move in
// between mint or burn tokens: measured against the live arena that was worth +10% of the book in
// five rounds, dwarfing the 0.2% fee and making the float wander in both directions. Freezing one
// price per arena-round makes a round token-neutral - what goes in comes out, outcome aside - and
// stops players being silently exposed to a 60-second price move they never opted into.
const roundPx = new Map<string, Record<string, number>>();
function pxForRound(aid: string, round: number, f: Field): number {
  const k = `${aid}:${round}`;
  let m = roundPx.get(k);
  if (!m) {
    m = {};
    roundPx.set(k, m);
    // keep this from growing forever; a handful of arenas x a few rounds is all we ever need
    if (roundPx.size > 64) for (const old of [...roundPx.keys()].slice(0, 32)) roundPx.delete(old);
  }
  if (!(m[f] > 0)) m[f] = usdPerUnitSafe(f);
  return m[f];
}
// PER-ROUND CONSERVATION AUDIT. Reading the code could not explain why the float moved ~9% of
// stake per round in BOTH tokens at once, so the engine now shows its own working: every token
// debited at entry and credited at settlement is tallied per round and any gap is logged. A round
// should only ever lose the deploy fee.
const roundFlow = new Map<string, Record<string, { out: number; in: number }>>();
/** Tokens of `f` currently staked in unsettled rounds (out of accounts, still ours). */
function openStakes(f: Field): number {
  let n = 0;
  for (const m of roundFlow.values()) { const v = m[f]; if (v) n += Math.max(0, v.out - v.in); }
  return n;
}
function flow(aid: string, round: number, f: Field) {
  const k = `${aid}:${round}`;
  let m = roundFlow.get(k);
  if (!m) { m = {}; roundFlow.set(k, m); if (roundFlow.size > 64) for (const o of [...roundFlow.keys()].slice(0, 32)) roundFlow.delete(o); }
  return (m[f] ||= { out: 0, in: 0, fee: 0 });
}
function auditRound(aid: string, round: number): void {
  const m = roundFlow.get(`${aid}:${round}`);
  if (!m) return;
  for (const [f, v] of Object.entries(m)) {
    if (v.out < 1e-9 && v.in < 1e-9) continue;
    const gap = v.in - v.out;                       // negative = burned, positive = minted
    const expected = -(v.fee || 0);                 // fees actually KEPT are the only allowed shrinkage
    if (Math.abs(gap - expected) > Math.max(1e-6, v.out * 0.001)) {
      console.warn(`CONSERVATION ${aid} r${round} ${f}: staked ${v.out.toFixed(6)} paid ${v.in.toFixed(6)} ` +
                   `gap ${gap >= 0 ? "+" : ""}${gap.toFixed(6)} (expected ${expected.toFixed(6)})`);
    }
  }
  roundFlow.delete(`${aid}:${round}`);
}

const unitsAtRound = (aid: string, round: number, f: Field, usd: number) => {
  const px = pxForRound(aid, round, f);
  return px > 0 ? usd / px : 0;
};
// legacy token-count knobs still respected if explicitly set
const BOT_BANK_MIN = Number(process.env.BOT_BANK_MIN || 0), BOT_BANK_MAX = Number(process.env.BOT_BANK_MAX || 0), BOT_STAKE_MIN = Number(process.env.BOT_STAKE_MIN || 0);
// Bots draw their bank from REAL deposited money (bot-bank.ts). Inventing it made every bot
// payout to a real player an unbacked liability. BOT_FAKE_BANK=1 restores the old behaviour for
// local testing only - it is refused on a live chain.
const FAKE_BANK_OK = process.env.BOT_FAKE_BANK === "1" && IS_TEST_CHAIN;
let poolWarned = false;
/** What the bot pool is worth right now, in dollars, across every token. */
function floatUsd(): number {
  // The whole house float, not just the loose part. Counting only the POOL meant that once the
  // money was distributed into bots the target population collapsed - $250 of UWU sitting in bots
  // with $0.75 loose sized the arena at TWO fighters. Retiring a bot returns its balance to the
  // pool, so money in bots is every bit as available as money in the pool.
  let total = 0;
  for (const f of ["bull", "uwu", "sol"] as const) {
    let held = poolBalance(f);
    for (const a of ledger.values()) if (a.isBot && !(a as any).retired) held += a[f] || 0;
    total += f === "sol" ? held : held * usdPerUnit(f);
  }
  return total;
}
// How many bots the CURRENT float can actually field. The population used to follow a fixed
// schedule (POP_START -> POP_MAX) regardless of how much real money backed it. Against a small
// float that produced the worst possible outcome: ~68 bots each drawing pool/40, every one landing
// a hair under the minimum stake, so nobody deployed and the whole population busted and respawned
// every round (joined 50 / busted 49 / entries 0). Sizing the crowd to the money keeps each bot
// solvent enough to actually play.
const BOT_MIN_RUNWAY = Number(process.env.BOT_MIN_RUNWAY || 3);   // stakes a new bot should afford
// How many fighters one funding draw is spread over. Not the whole theoretical population: dividing
// by that starved every bot at birth (pool/79 on a $43 pool = $0.55 each).
const BOT_FUND_SPREAD = Number(process.env.BOT_FUND_SPREAD || 8);
// Share of the pool routine funding may never touch, held back so the house can still ANSWER a
// player's bet. Matching is allowed to use the whole pool; only the routine top-up is limited.
const POOL_RESERVE_FRAC = Number(process.env.POOL_RESERVE_FRAC || 0.35);
function popAffordable(): number {
  // fake banks (test chains only) have no pool to afford anything from - population is uncapped
  // there, or dev arenas would seed once and never replace a busted bot
  if (!botBankReady() && FAKE_BANK_OK) return Infinity;
  const perBot = Math.max(BOT_BANK_USD_MIN, BOT_STAKE_USD_MIN * BOT_MIN_RUNWAY);
  if (!(perBot > 0)) return 0;
  return Math.floor(floatUsd() / perBot);
}
function bankFor(field: Field, want: number, spread?: number): number {
  if (botBankReady()) {
    const got = drawBank(field, want, spread);
    if (got < want * 0.5 && !poolWarned) { poolWarned = true; console.warn(`bot-bank: ${field} pool running low - seed more wallets (npm run seed:bots)`); }
    return got;
  }
  return FAKE_BANK_OK ? want : 0;   // no real backing available -> bot simply cannot deploy
}
// how many bots actually enter a round, per side (keeps a huge population from flooding one lobby)
const PLAY_MIN = Number(process.env.PLAY_MIN || 0), PLAY_MAX = Number(process.env.PLAY_MAX || 0);
const BOT_STAKE_MAX = Number(process.env.BOT_STAKE_MAX || 0);
const B58 = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789";
/** What an account's holdings are actually WORTH, in dollars. Summing bull+uwu+sol raw compares
 *  unlike units: 1 ANSEM is ~6x a UWU, and `sol` is already USD. */
/** Retire a busted bot, returning whatever it still holds to the pool.
 *  Deleting the account outright DESTROYED that money: it was drawn from real deposits, so every
 *  bust silently shrank the float while the vault still held the tokens. Recycle instead. */
function retireBot(a: Account): void {
  for (const f of ["bull", "uwu", "sol"] as const) {
    const left = a[f] || 0;
    if (left > 0) { returnBank(f, left); a[f] = 0; }
  }
  // KEEP THE RECORD. Deleting the account returned its money correctly but threw away its lifetime
  // stats, so the leaderboard only ever saw whoever had not busted yet — a survey of survivors,
  // which skews negative by construction and is why nothing ever looked profitable.
  (a as any).retired = true;
}

// accountUsd lives in ledger.ts — ONE definition, because two copies of "what is this worth" is
// precisely how the leaderboard came to disagree with the wallet.
const walletish = () => { let s=""; for(let i=0;i<4;i++) s += B58[(Math.random()*B58.length)|0]; return s + "…" + B58[(Math.random()*B58.length)|0] + B58[(Math.random()*B58.length)|0] + B58[(Math.random()*B58.length)|0]; };
let seq = 0;
function newBot(aid: string, side: Side): Account | null {
  const id = `${aid}:bot:${++seq}`;
  // a third of newcomers show up as raw addresses — fresh wallets, no handle yet
  const name = Math.random() < 0.34 ? walletish() : NAMES[(Math.random()*NAMES.length)|0] + "_" + seq;
  const a: Account = { id, name, side, bull: 0, uwu: 0, sol: 0, isBot: true, dep: 0, ret: 0, games: 0, wins: 0 };
  // TEMPERAMENT. Every fighter drew its stake from the same distribution, so a lobby was a row of
  // near-identical bets — it read as generated, because it was. A persistent per-bot multiplier
  // gives the book a natural shape: a few whales, a long tail of minnows, and the same wallet
  // recognisably playing the same way round after round.
  (a as any).temper = 0.35 + Math.pow(Math.random(), 2.2) * 2.6;   // skewed: most modest, few large
  (a as any).skip = Math.random() * 0.30;                          // some sit rounds out
  // bank in the arena's token for this bot's slot, drawn from real deposited money
  const toks = arenaTokens(aid) || (["ansem", "uwu"] as [Tok, Tok]);
  const field = FIELD[toks[side === "bull" ? 0 : 1]] as Field;
  const want = BOT_BANK_MIN > 0
    ? BOT_BANK_MIN + Math.random() * (BOT_BANK_MAX - BOT_BANK_MIN)
    : unitsForUsd(field, BOT_BANK_USD_MIN + Math.random() * (BOT_BANK_USD_MAX - BOT_BANK_USD_MIN));
  // spread the draw across the number of bots the float can support, not a fixed 40
  // A NEW BOT WAS BORN BROKE. The spread here divided the pool by how many bots the float could
  // THEORETICALLY support (~79), so a new fighter drew pool/79 - roughly $0.55 out of a $43 pool -
  // and then staked a fraction of that. It is the reason rounds looked like dust however much float
  // we added. Spread across a realistic lobby instead, still bounded by the per-bot ceiling.
  const spreadN = Math.max(1, Math.min(popAffordable(), BOT_FUND_SPREAD));
  a[field] = bankFor(field, want, spreadN);
  // A bot that cannot afford one minimum stake is not a participant, it is churn: it busts on the
  // next settle and takes a respawn slot with it. Hand the money back and don't create it.
  const minStake = BOT_STAKE_MIN > 0 ? BOT_STAKE_MIN : unitsForUsd(field, BOT_STAKE_USD_MIN);
  if (!(a[field] >= minStake)) { returnBank(field, a[field]); return null; }
  ledger.set(id, a); created[arenaEco(aid)]++; return a;
}
function seedBots(aid: string, n: number) { for (let i=0;i<n;i++) if (!newBot(aid, i%2 ? "uwu":"bull")) break; }
// Rotate the scan order. Every selection path — funding, matching, the per-side minimum — walked
// this list front to back, so the same handful of bots were always chosen and everything behind them
// stayed idle. Combined with returnBank dumping into one wallet, 3 of 21 wallets ended up holding
// 82% of the stake. A rotating offset spreads participation without changing any economics.
let botScanOffset = 0;
const botsFor = (aid: string) => {
  const all = [...ledger.values()].filter(a => a.isBot && !(a as any).retired && a.id.startsWith(aid + ":"));
  if (all.length < 2) return all;
  const k = botScanOffset++ % all.length;
  return all.slice(k).concat(all.slice(0, k));
};

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
  // A5 — accumulate raided value per side, from the authoritative server-side hit log rather than
  // from whatever a browser happened to see. `tk` names the side the value was taken FROM, and the
  // sim runs in USD, so these are USD and are labelled as such at the point of display.
  {
    const st = stat(aid);
    for (const h of (r.hits || [])) {
      if (!(h.amt > 0)) continue;
      if (h.tk === "bull") st.stolenA = (st.stolenA || 0) + h.amt;
      else st.stolenB = (st.stolenB || 0) + h.amt;
    }
  }
  const touched = new Set<string>();
  for (const [key, bal] of Object.entries(r.settlement)) {
    const id = key.split("|")[0];
    const a = ledger.get(id); if (!a) continue;
    // the sim runs in USD (see the enter path); credit each side in ITS OWN token, at the SAME
    // price the stake went in at, so the round cannot mint or burn tokens on a price move
    const retA = unitsAtRound(aid, s.round, FIELD[tokA] as Field, bal.bull);
    const retB = unitsAtRound(aid, s.round, FIELD[tokB] as Field, bal.uwu);
    a[FIELD[tokA]] += retA; a[FIELD[tokB]] += retB; a.games++;
    // ret/dep are lifetime P&L accumulators so they must be DOLLARS. Adding retA (slot A's token)
    // to retB (slot B's) added two different currencies and made every bot's P/L fiction.
    a.ret += retA * pxForRound(aid, s.round, FIELD[tokA] as Field)
           + retB * pxForRound(aid, s.round, FIELD[tokB] as Field);
    flow(aid, s.round, FIELD[tokA] as Field).in += retA;
    flow(aid, s.round, FIELD[tokB] as Field).in += retB;
    if (a.side === r.winner) a.wins++;
    const f = r.fighters.find(x => x.id === key);
    if (f) { a.raided = (a.raided||0) + f.raided; if (f.bestHit > (a.best||0)) a.best = f.bestHit; }
    if (!a.isBot) touched.add(id);
  }
  // Hybrid bots as a *community that grows*: broke wallets leave, new wallets arrive every
  // round, and the population target creeps up over time — while still throttling down as
  // real players fill the arena, so bots never crowd out humans.
  auditRound(aid, s.round);
  // Engine-side history: the same for every viewer and it survives a restart, unlike the browser's
  // in-memory list which started empty on every reconnect.
  try {
    const pxA = pxForRound(aid, s.round, FIELD[tokA] as Field);
    const pxB = pxForRound(aid, s.round, FIELD[tokB] as Field);
    pushRound({
      at: Date.now(), arena: aid, round: s.round, winner: r.winner,
      pot: s.entries.reduce((t: number, e: any) => t + (e.stake || 0) / (1 - FEE), 0),
      seedHash: s.seedHashPublished || "", seed: s.seed || "", secret: (s as any).secretRevealed || "",
      players: s.entries.map((e: any) => {
        const id = String(e.id).split("|")[0];
        const bal = (r.settlement as any)[e.id] || {};
        // record the TOKEN amounts too: USD alone cannot tell a won round from a coin that pumped
        const side = e.side as Side;
        const tk = side === "bull" ? tokA : tokB;
        const fld = FIELD[tk] as Field;
        const pxTok = pxForRound(aid, s.round, fld);
        const inUsd = (e.stake || 0) / (1 - FEE);
        const outUsd = (bal.bull || 0) + (bal.uwu || 0);
        return { id, name: nameFor(id), side: e.side, bot: String(e.id).includes(":bot:"),
                 inUsd, outUsd,
                 tok: String(tk).toUpperCase(),
                 inTok: pxTok > 0 ? inUsd / pxTok : 0,
                 outTok: pxTok > 0 ? outUsd / pxTok : 0 };
      }),
    });
  } catch { /* history must never break a settlement */ }
  // Anchor the round on-chain: seed commitment, revealed seed, winner, and every wallet's entry and
  // exit in both tokens. Best-effort and non-blocking — settlement must never wait on the network.
  try {
    const pot = s.entries.reduce((t: number, e: any) => t + (e.stake || 0) / (1 - FEE), 0);
    const anchor = {
      arena: aid, round: s.round, seedHash: s.seedHashPublished || "", seed: s.seed || "", secret: (s as any).secretRevealed || "",
      winner: r.winner, pot,
      players: s.entries.map((e: any) => {
        const bal = (r.settlement as any)[e.id] || {};
        const pid = String(e.id).split("|")[0];
        return { id: pid, name: nameFor(pid), side: e.side, bot: String(e.id).includes(":bot:"),
                 inTok: (e.stake || 0) / (1 - FEE), outA: bal.bull || 0, outB: bal.uwu || 0 };
      }),
    };
    anchorRound(anchor);
    lastAnchors.set(`${aid}:${s.round}`, anchor);
    if (lastAnchors.size > 300) for (const k of [...lastAnchors.keys()].slice(0, 100)) lastAnchors.delete(k);
  } catch { /* anchoring must never break a settlement */ }
  const realPlaying = s.entries.filter(e => !e.id.includes(":bot:")).length;
  let busted = 0, switched = 0;
  // Busted = can no longer afford the minimum stake, so it can never deploy again.
  // This MUST NOT sit below the minimum stake. At 0.8x it opened a dead band: a bot holding $0.487
  // against a $0.50 minimum could neither deploy nor be retired, so it sat on its share of the
  // float forever. Enough of them and the entire pool is trapped in wallets that never play - which
  // is exactly what emptied the arena (joined 50 / busted 49 / entries 0). Retire at the stake
  // minimum so unplayable money always returns to the pool.
  const BUST_USD = Number(process.env.BOT_BUST_USD || BOT_STAKE_USD_MIN);
  // Judge a bot on the token it actually plays. Total portfolio value would keep a bot alive on a
  // pile of the ENEMY's coin it can never stake - a zombie holding float nobody can use.
  const ownFieldOf = (b: Account) => FIELD[b.side === "bull" ? tokA : tokB] as Field;
  const foeFieldOf = (b: Account) => FIELD[b.side === "bull" ? tokB : tokA] as Field;
  for (const a of botsFor(aid)) {
    const own = ownFieldOf(a), foe = foeFieldOf(a);
    // A WINNER in extraction ends the round holding the ENEMY's coin — that is what raiding IS.
    // Judging bust on own-token alone therefore retired the winners and deleted their profit with
    // them, so the leaderboard could only ever show losers ("nobody is profitable", -50% aggregate).
    // Let a bot convert its raided coin through the treasury first, exactly like a player: the house
    // is the counterparty, it is a pure ledger move, and the vault already holds both tokens.
    // FIGHT FOR THE COIN YOU ACTUALLY HOLD. Blind-flipping the side stranded money on the wrong
    // army: in us-extraction side "bull" plays UWU and side "uwu" plays SOL, so a bot flipped onto
    // the SOL side while holding UWU could not use a penny of it — $6.95 of float sat idle in bots
    // that read as broke. Pick the side by holdings instead, which is also self-correcting.
    const usdA = (a[FIELD[tokA] as Field] || 0) * usdPerUnitSafe(FIELD[tokA] as Field);
    const usdB = (a[FIELD[tokB] as Field] || 0) * usdPerUnitSafe(FIELD[tokB] as Field);
    const want: Side = usdA >= usdB ? "bull" : "uwu";
    if (a.side !== want && Math.max(usdA, usdB) >= BUST_USD) { a.side = want; switched++; }
    if (a[own] * usdPerUnitSafe(own) < BUST_USD) { retireBot(a); busted++; bustedCount[mode]++; }
  }
  rounds[mode]++; roundsByArena[aid] = (roundsByArena[aid] || 0) + 1;
  { const st = stat(aid); st.matches++; if (r.winner === "bull") st.winsA++; else st.winsB++; }
  const popCap = Math.min(POP_MAX, POP_START + Math.floor((roundsByArena[aid] || 0) * POP_GROWTH));
  // POP_MIN is a floor on ambition, never on affordability - the float has the final say
  const wanted = Math.max(Number(process.env.POP_MIN || 12), popCap - realPlaying * 2);
  const target = Math.min(wanted, popAffordable());
  let joined = 0;
  while (botsFor(aid).length < target) {
    const made = newBot(aid, botsFor(aid).filter(b=>b.side==="bull").length <= botsFor(aid).filter(b=>b.side==="uwu").length ? "bull":"uwu");
    if (!made) break;      // pool exhausted - stop, or this loop never terminates
    joined++;
  }
  broadcast({ t: "roundLogged", round: roundHistory(1)[0] });
  broadcast({ t: "settled", arena: aid, mode, round: s.round, winner: r.winner, seed: s.seed, seedHash: s.seedHashPublished, secret: (s as any).secretRevealed, secret: (s as any).secretRevealed,
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
    // the N sim runs in USD too - credit the team's own token at the round's frozen price
    const ret = unitsAtRound(aid, s.round, FIELD[tok] as Field, amount as number);
    a[FIELD[tok]] += ret; a.games++;
    a.ret += ret * pxForRound(aid, s.round, FIELD[tok] as Field);   // dollars, to match dep
    if (!a.isBot) touched.add(wallet);
  }
  const realPlaying = s.entries.filter((e: any) => !String(e.id).includes(":bot:")).length;
  let busted = 0;
  const BUST_USD_N = Number(process.env.BOT_BUST_USD || BOT_STAKE_USD_MIN);   // same dead-band rule as the 2-team path
  for (const a of botsFor(aid)) {
    const t = def.toks[def.teams === 0 ? 0 : ((a as any).nteam ?? 0)] || def.toks[0];
    const f = FIELD[t] as Field;
    if (a[f] * usdPerUnitSafe(f) < BUST_USD_N) { retireBot(a); busted++; }   // own token, not portfolio
  }
  roundsByArena[aid] = (roundsByArena[aid] || 0) + 1;
  { const st = stat(aid); st.matches++; if (r.winnerTeam === 0) st.winsA++; else st.winsB++; }
  const popCap = Math.min(POP_MAX, POP_START + Math.floor((roundsByArena[aid] || 0) * POP_GROWTH));
  const wanted = Math.max(Number(process.env.POP_MIN || 12), popCap - realPlaying * 2);
  const target = Math.min(wanted, popAffordable());
  let joined = 0;
  while (botsFor(aid).length < target) { if (!newBotN(aid)) break; joined++; }
  broadcast({ t: "roundStartN", phase: "settled", arena: aid, round: s.round, winnerTeam: r.winnerTeam,
              winnerId: r.winnerId, seed: s.seed, seedHash: s.seedHashPublished, secret: (s as any).secretRevealed, teamTotals: r.teamTotals });
  for (const w of touched) pushBalance(w);
  persist();
}
// bots for N arenas: pick a team slot, bank in that team's token
function newBotN(aid: string): Account | null {
  const def = NARENAS[aid];
  const id = `${aid}:bot:${++seq}`;
  const name = Math.random() < 0.34 ? walletish() : NAMES[(Math.random()*NAMES.length)|0] + "_" + seq;
  const team = def.teams === 0 ? 0 : Math.floor(Math.random() * def.teams);
  const a: Account = { id, name, side: team === 1 ? "uwu" : "bull", bull: 0, uwu: 0, sol: 0,
                       isBot: true, dep: 0, ret: 0, games: 0, wins: 0 };
  (a as any).nteam = team;
  const fieldN = FIELD[def.toks[def.teams === 0 ? 0 : team]] as Field;
  // this used the legacy token-count knobs, which default to 0 - so `want` was 0 and every N-arena
  // bot drew an empty bank. Denominate in USD like the 2-team path.
  const want = BOT_BANK_MIN > 0
    ? BOT_BANK_MIN + Math.random() * (BOT_BANK_MAX - BOT_BANK_MIN)
    : unitsForUsd(fieldN, BOT_BANK_USD_MIN + Math.random() * (BOT_BANK_USD_MAX - BOT_BANK_USD_MIN));
  a[fieldN] = bankFor(fieldN, want, Math.max(1, popAffordable()));
  const minStakeN = BOT_STAKE_MIN > 0 ? BOT_STAKE_MIN : unitsForUsd(fieldN, BOT_STAKE_USD_MIN);
  if (!(a[fieldN] >= minStakeN)) { returnBank(fieldN, a[fieldN]); return null; }
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
    // no bot conversion here either - see the 2-team path for why it was both mispriced and unbacked
    const bankroll = a[FIELD[tok]];
    const minStakeN = BOT_STAKE_MIN > 0 ? BOT_STAKE_MIN : unitsForUsd(FIELD[tok] as Field, BOT_STAKE_USD_MIN);
    const stake = BOT_STAKE_MAX > 0
      ? Math.min(minStakeN + Math.random() * (BOT_STAKE_MAX - minStakeN), bankroll)
      : Math.min(Math.max(minStakeN, bankroll * (0.18 + Math.random() * 0.37)), CAP, bankroll);
    if (!(minStakeN > 0) || stake < minStakeN) continue;
    a[FIELD[tok]] -= stake;
    const eco = NARENAS[aid].eco;
    const usdA = stake * pxForRound(aid, rn.state.round, FIELD[tok] as Field);
    if (!(usdA > 0)) { a[FIELD[tok]] += stake; continue; }   // no price -> undo the debit, sit out
    returnBank(FIELD[tok] as Field, stake * FEE);            // house does not charge itself
    a.dep += usdA; totalDeployed[eco] += usdA;      // dollars, to match ret
    stat(aid).deployed += usdA;
    rn.enter(`${a.id}|${def.teams === 0 ? 0 : team}`, def.teams === 0 ? 0 : team, usdA * (1 - FEE));
  }
}

// RESTORE FIRST. The runners below are seeded from roundsByArena, and restore() is what fills it.
// It used to run three lines AFTER them, so every runner was seeded from an empty record and
// started at 0+1 - the round counter reset to #1 on every single deploy, exactly the behaviour the
// comment below says this is here to prevent. The intent was right; the ordering defeated it.
// Nothing between here and the runners touches the ledger, so this is a pure move.
restore();

const runners: Record<string, RoundRunner> = {};
// start each arena where it left off, so a redeploy never resets the match history
for (const aid of ARENA_IDS) runners[aid] = new RoundRunner(arenaEco(aid), (r, s) => onSettle(aid, r, s), (roundsByArena[aid] || 0) + 1);
const runnersN: Record<string, RoundRunnerN> = {};
for (const aid of NARENA_IDS) runnersN[aid] = new RoundRunnerN(NARENAS[aid].eco, NARENAS[aid].teams, (r, s) => onSettleN(aid, r as any, s as any), (roundsByArena[aid] || 0) + 1);
// One-off float repair, BEFORE the bot bank reads balances and before anything can persist over it.
// Running the standalone CLI against a live engine loses the race: it writes the snapshot file and
// the running process overwrites it from stale memory on the next save.
// On-chain holdings, refreshed on a slow timer. /float reads this rather than hitting the RPC per
// request - a public endpoint must not be a way to burn our rate limit.
const lastChain = { uwu: 0, bull: 0, sol: 0, at: 0 };
// the exact anchors we hashed, so /round can serve byte-identical data for verification
const lastAnchors = new Map<string, any>();
// SEC-M7. Two problems lived in the old three-line version of this.
//
// It assigned each balance as it arrived, so a failure on the SECOND read left uwu fresh, bull and
// sol stale, and `at` never updated - a record that was internally inconsistent (one token read now,
// another read ten minutes ago) while still claiming the older timestamp. Anything comparing tokens
// against each other was then comparing two different moments. Reads now land in locals and commit
// together or not at all.
//
// And nothing downstream checked the age. A vault reading is a claim about NOW; the arena moves
// money continuously, so an hour-old reading is not a slightly worse answer, it is a different
// question. Consumers that spend money on the answer must refuse a stale one rather than act on it.
const CHAIN_MAX_AGE_MS = Number(process.env.CHAIN_MAX_AGE_MS || 5 * 60_000);
function chainStale(): boolean { return !lastChain.at || (Date.now() - lastChain.at) > CHAIN_MAX_AGE_MS; }
async function refreshChainHoldings() {
  if (!chainReady()) return;
  try {
    const uwu = await vaultTokenBalance("uwu");
    const bull = await vaultTokenBalance("bull");
    const sol = await solBalance(vaultPubkey());
    // commit as one snapshot, so the three figures are always from the same moment
    lastChain.uwu = uwu; lastChain.bull = bull; lastChain.sol = sol; lastChain.at = Date.now();
  } catch { /* leave the last good reading, and its real age, in place */ }
}
setInterval(refreshChainHoldings, 60_000).unref?.();

// D1 — AUTO-REBALANCE. A convert moves the vault's token mix on-chain but leaves the ledger pool
// untouched, so the float silently strands: 1,588 UWU once sat in the vault owned by nobody while
// the arena could only field three fighters. This has needed a manual RESYNC_POOL_ON_BOOT three
// times, which is three times too many for something a daemon can see.
//
// It re-anchors the HOUSE float only, never player balances, and it can only ever credit UP TO what
// the chain backs — resyncPoolToChain refuses to write down an over-claiming ledger, because that
// would conceal a real shortfall rather than fix one.
const AUTO_REBALANCE = process.env.AUTO_REBALANCE !== "0";
// The deadband exists so the daemon is not rewriting the book over rounding dust. $5 was set when
// the float was much larger; against ~$100 it is 5%, and stranded float accumulated to just UNDER
// it and then sat there permanently — 149 UWU ($4.05) and 0.061 SOL ($4.50), each individually
// below the bar, together nearly a tenth of the float owned by nobody. A threshold that a leak can
// hide beneath is not a safety margin, it is a blind spot.
// PAUSE. Stopping the machine pauses the game too, but takes the whole site down with it — no
// withdrawals, no proof of reserves, no way for anyone holding a balance to see their money.
// PAUSED=1 halts the ROUNDS only: no lobby opens, no bot enters, no fee is taken, nothing moves.
// Everything a player needs in order to inspect or withdraw stays up.
//
// Declared here, above every reader. My first attempt put it next to the round loop at ~1190 while
// autoRebalance reads it at ~647 — a module-level const read before its declaration, which is a TDZ
// crash on boot. That is the exact rule the client test enforces, and I broke it in the engine
// twenty minutes after writing the test for it.
export const PAUSED = process.env.PAUSED === "1";

const REBALANCE_MIN_GAP_USD = Number(process.env.REBALANCE_MIN_GAP_USD || 1);
async function autoRebalance(): Promise<void> {
  if (!AUTO_REBALANCE || !chainReady() || isFrozen()) return;
  // NEVER sample the books mid-round. A stake leaves the account the moment it is placed but the
  // vault still holds the coin, so accounts read low against unchanged chain holdings and the gap
  // this daemon measures is inflated by the entire open stake:
  //     gap = (chain - ledger) + open
  // Crediting that would mint house balance out of money already on the table. It is also why the
  // log was full of "INSOLVENT" refusals that /solvency flatly contradicted - both were reading a
  // book caught mid-settlement, which is not a state the comparison is meaningful in. Between
  // rounds every stake is back in an account and the two sides are comparable again.
  try {
    await refreshChainHoldings();
    // SEC-M7: if that read failed, lastChain still holds an OLDER snapshot. Crediting the house
    // from it would be acting on what the vault held some time ago, while the arena has been
    // settling rounds since. Skip the cycle - the next one runs in five minutes.
    if (chainStale()) {
      console.warn(`auto-rebalance: skipped — chain reading is ${Math.round((Date.now() - (lastChain.at || 0)) / 1000)}s old`);
      return;
    }
    const px = solUsd();
    const held: Record<string, number> = { uwu: lastChain.uwu, bull: lastChain.bull, sol: px ? lastChain.sol * px : 0 };
    const pool = new Set(poolPubkeys());
    for (const f of ["uwu", "bull", "sol"] as const) {
      if (f === "sol" && !(px > 0)) continue;                 // cannot value SOL without a price
      if (!(held[f] > 0)) continue;
      const usdPerTok = f === "sol" ? 1 : usdPerUnitSafe(f);
      if (!(usdPerTok > 0)) continue;
      // only act on a gap big enough to matter, so we are not rewriting the book every minute.
      // The threshold is passed IN so the decision happens before the mutation, not after it.
      // open stakes are passed in rather than skipped: they are subtracted from what the house may
      // claim, so the comparison is valid mid-round and the daemon can actually run
      const r = resyncPoolToChain(ledger, pool, f, held[f], REBALANCE_MIN_GAP_USD / usdPerTok, openStakes(f));
      if (r.moved > 0) {
        console.log(`auto-rebalance: ${f} ${r.from.toFixed(4)} -> ${r.to.toFixed(4)} (+${r.moved.toFixed(4)}, $${(r.moved * usdPerTok).toFixed(2)})`);
        persist(); flush();
      } else if (r.reason && r.reason.startsWith("INSOLVENT")) {
        console.error(`auto-rebalance: ${f} REFUSED — ${r.reason}`);
      }
    }
  } catch (e) { console.error("auto-rebalance failed:", redact((e as Error).message)); }
}
setInterval(() => { if (!PAUSED) void autoRebalance(); }, Number(process.env.REBALANCE_MS || 5 * 60_000)).unref?.();

// WHY IT CLUMPS, AND WHAT TO DO ABOUT IT.
//
// Fixing returnBank stopped the float being FUNNELLED into one wallet, but it does not stop
// clumping on its own, because a bot that WINS keeps its winnings in its own account. In a zero-sum
// game variance alone concentrates: the lucky few accumulate, the unlucky bust and recycle. Left
// running, a handful of fat bots end up holding everything and the arena has nothing to field.
//
// A player's winnings are theirs and are never touched. But the house's bots are OUR capital, and
// we want it working across many fighters rather than parked in three. So skim anything a bot holds
// above a ceiling back into the pool, where it funds new fighters. Pure house-internal reallocation:
// no player balance is involved and the total is unchanged.
const BOT_MAX_BANK_USD = Number(process.env.BOT_MAX_BANK_USD || 12);
// THE MIRROR OF levelBots. That one skims a bot ABOVE a ceiling back to the pool; nothing ever
// filled one UP TO a floor, because the pool only reached a bot when the bot was CREATED. So a bot
// that lost a few rounds stayed permanently poor, and since a routine stake is a fraction of the
// bank, poor bots field dust forever. The measured result: bots holding ~$6 UWU and ~$4 SOL while
// the pool sat on $43 and $57 - about 90% of the float idle, and rounds worth ~$3 on a ~$100 book.
//
// This is house money moving between house wallets. It never touches a player balance, never
// creates balance (every token comes out of the pool), and is bounded by BOT_MAX_BANK_USD, the
// same ceiling levelBots enforces from the other direction.
// CAPITAL FRAGMENTATION. Bots used to bust constantly, so the population policed itself. Once
// funding was fixed they stopped dying and nothing culled them: the count reached 77 accounts
// holding ~$1.04 each while only 10 can enter a round. Sixty-seven wallets sat out every round
// holding ~$70 of idle float, and because each bank was ~$1, the per-fighter stake was pinned to
// the MINIMUM rather than driven by the commit fraction — the arena fielded $6.50 rounds on a $114
// float, 5.7% utilisation.
//
// More accounts is not more depth. Past a couple of rotations' worth of entrants it is just the
// same money cut into thinner pieces. Retire the excess back into the pool, where it funds the
// fighters that DO play. retireBot already returns balance safely and keeps the account's record.
const POP_ROTATIONS = Number(process.env.BOT_POP_ROTATIONS || 3);
function capPopulation(aid: string): void {
  const perSideCap = PLAY_MAX > 0 ? PLAY_MAX : 9;
  const target = Math.max(6, perSideCap * 2 * POP_ROTATIONS);   // both sides, a few rotations deep
  const alive = botsFor(aid).filter(a => !(a as any).retired);
  if (alive.length <= target) return;
  // retire the POOREST first: they are the ones whose banks are too thin to field real size, and
  // their capital does more work consolidated behind a fighter that actually enters.
  const px = (f: Field) => (f === "sol" ? 1 : usdPerUnitSafe(f));
  const worth = (a: any) => (a.bull || 0) * px("bull") + (a.uwu || 0) * px("uwu") + (a.sol || 0);
  const excess = alive.sort((x, y) => worth(x) - worth(y)).slice(0, alive.length - target);
  let freed = 0;
  for (const a of excess) { freed += worth(a); retireBot(a); }
  if (freed > 0.01) console.log(`population: retired ${excess.length} thin account(s), $${freed.toFixed(2)} back to the pool (${alive.length} -> ${target})`);
}

function levelBots(): void {
  if (!botBankReady()) return;
  const pxOf = (f: Field) => (f === "sol" ? 1 : usdPerUnitSafe(f));
  for (const a of ledger.values()) {
    if (!a.isBot || (a as any).retired) continue;
    if (poolPubkeys().includes(a.id)) continue;          // pool wallets ARE the reservoir
    for (const f of ["bull", "uwu", "sol"] as const) {
      const px = pxOf(f as Field);
      if (!(px > 0)) continue;
      const usd = (a[f] || 0) * px;
      if (usd <= BOT_MAX_BANK_USD) continue;
      const skimTok = (usd - BOT_MAX_BANK_USD) / px;
      a[f] -= skimTok;
      returnBank(f as Field, skimTok);                   // goes to the emptiest wallet
    }
  }
}
setInterval(levelBots, Number(process.env.LEVEL_MS || 30_000)).unref?.();

// B6 — KEEP WATCHING THE BOOK. matchPlayerStake fires the moment a player enters, which answers
// that entry but nothing after it: a whale arriving later in the same lobby faced whatever the
// house had already committed, and the rest of their stake went unmatched and was refunded. The
// house wants that action. Over-committing costs nothing, because the matched book refunds any
// excess anyway — so re-checking every second while a lobby is open is free upside.
const WATCH_MS = Number(process.env.BOOK_WATCH_MS || 1200);
setInterval(() => {
  for (const aid of ARENA_IDS) {
    const rn = runners[aid];
    if (!rn || rn.state.phase !== "lobby" || !rn.state.entries.length) continue;
    const [tokA, tokB] = arenaTokens(aid);
    // How much REAL money sits on each side? Only humans are worth answering — bots matching bots
    // would ratchet the book upward forever on both sides.
    let human: Record<string, number> = { bull: 0, uwu: 0 };
    for (const e of rn.state.entries) {
      if (String(e.id).includes(":bot:")) continue;
      human[e.side] = (human[e.side] || 0) + (e.stake || 0) / (1 - FEE);
    }
    for (const side of ["bull", "uwu"] as Side[]) {
      const stake = human[side] || 0;
      if (stake <= MIN_ENTRY) continue;
      matchPlayerStake(aid, side, stake);   // it already subtracts what the other army has committed
    }
  }
}, WATCH_MS).unref?.();
refreshChainHoldings();

if (process.env.RECOVER_FLOAT_ON_BOOT === "1") {
  await (async () => {
    try {
      // the price loop fires async at startup and has not resolved this early, so pull a fresh
      // quote first - otherwise the SOL leg cannot be verified and recovery (correctly) refuses
      await refreshPrices().catch(() => {});
      const pool = new Set(poolPubkeys());
      const held = { uwu: await vaultTokenBalance("uwu"), solUsd: 0 };
      const px = solUsd();
      held.solUsd = px ? (await solBalance(vaultPubkey())) * px : 0;
      const r = await recoverInPlace(ledger, pool, held, !!getFloatRecoveredAt());
      if (r.credited) { markFloatRecovered(); persist(); flush();
        console.log(`float recovery: credited ${r.credited} wallet(s) — ${r.uwu.toFixed(2)} UWU, $${r.sol.toFixed(2)} SOL`);
      } else console.log(`float recovery: skipped — ${r.reason}`);
    } catch (e) { console.error("float recovery failed:", (e as Error).message); }
  })();
}

// ONE-SHOT correction for phantom house float. Deliberately NOT a daemon and NOT on by default:
// a scheduled write-down is how a genuine loss gets papered over. Set WRITEDOWN_OVERCLAIM=1 for a
// single boot, read the log, then remove the flag. It refuses outright if players are not fully
// backed (that is a real shortfall, not phantom float), if the excess is too large to be a rounding
// artefact, or if the pool cannot absorb it.
if (process.env.WRITEDOWN_OVERCLAIM === "1") {
  await (async () => {
    try {
      await refreshPrices().catch(() => {});
      await refreshChainHoldings();
      if (chainStale()) { console.error("writedown: REFUSED — chain reading is stale"); return; }
      const pool = new Set(poolPubkeys());
      const px = solUsd();
      let moved = false;
      for (const f of ["uwu", "bull", "sol"] as const) {
        // sol is held in the ledger as USD, so compare in USD on both sides
        const chainHeld = f === "sol" ? (px > 0 ? lastChain.sol * px : 0) : lastChain[f];
        if (!(chainHeld > 0)) { console.log(`writedown: ${f} skipped — no chain reading`); continue; }
        const r = writeDownOverclaim(ledger, pool, f, chainHeld, openStakes(f));
        if (r.wrote > 0) {
          moved = true;
          console.log(`writedown: ${f} ${r.from.toFixed(4)} -> ${r.to.toFixed(4)} (wrote off ${r.wrote.toFixed(4)})`);
        } else console.log(`writedown: ${f} — ${r.reason}`);
      }
      if (moved) { persist(); flush(); console.log("writedown: persisted"); }
    } catch (e) { console.error("writedown failed:", redact((e as Error).message)); }
  })();
}

// Re-anchor the house float to the vault's real contents. Safe to leave on: it only ever moves the
// house UP TO what the chain backs, never past it, and refuses outright if the books already claim
// more than the vault holds.
// One-shot: clear lifetime P&L counters that were accumulated in mixed units before the USD fix.
// Balances are untouched — these are display statistics only.
if (process.env.RESET_STATS_ON_BOOT === "1") {
  const n = resetLifetimeStats();
  if (n) { persist(); flush(); }
  console.log(`lifetime stats reset on ${n} account(s) — balances untouched`);
}

if (process.env.RESYNC_POOL_ON_BOOT === "1") {
  await (async () => {
    try {
      await refreshPrices().catch(() => {});
      await refreshChainHoldings();
      const pool = new Set(poolPubkeys());
      const held: Record<string, number> = { uwu: lastChain.uwu, bull: lastChain.bull, sol: lastChain.sol * solUsd() };
      let any = false;
      for (const f of ["uwu", "bull", "sol"] as const) {
        if (f === "sol" && !(solUsd() > 0)) { console.log("pool resync: sol skipped — no price"); continue; }
        const r = resyncPoolToChain(ledger, pool, f, held[f]);
        if (r.moved > 0.0001) { any = true; console.log(`pool resync: ${f} ${r.from.toFixed(4)} -> ${r.to.toFixed(4)} (+${r.moved.toFixed(4)})`); }
        else console.log(`pool resync: ${f} unchanged — ${r.reason}`);
      }
      if (any) { persist(); flush(); }
    } catch (e) { console.error("pool resync failed:", (e as Error).message); }
  })();
}
// Book every anchoring fee against the TREASURY's own SOL. The lamports physically leave the vault
// (it holds the only server-side key) but they must not be taken from the float that backs players:
// the house pays for its own anchoring out of fee revenue. If the treasury has not earned enough
// yet the balance simply goes negative, which is honest — it is a real cost we owe ourselves.
// stamp each history row with the signature that anchored it, and tell everyone watching
// A3 — sum this wallet's unsettled stakes across every arena, in dollars.
setInRingReader((wallet) => {
  let usd = 0;
  for (const aid of ARENA_IDS) {
    const st = runners[aid]?.state; if (!st?.entries?.length) continue;
    const [tokA, tokB] = arenaTokens(aid);
    for (const e of st.entries) {
      if (String(e.id).split("|")[0] !== wallet) continue;
      usd += (e.stake || 0) / (1 - FEE);      // entries are already USD, gross of the deploy fee
    }
  }
  for (const aid of NARENA_IDS) {
    const st = runnersN[aid]?.state; if (!st?.entries?.length) continue;
    for (const e of st.entries) {
      if (String(e.id).split("|")[0] !== wallet) continue;
      usd += (e.stake || 0) / (1 - FEE);
    }
  }
  return usd;
});

setAnchorSink((rounds, sig) => {
  for (const r of rounds) markAnchored(r.arena, r.round, sig);
  broadcast({ t: "roundAnchored", rounds, sig });
});

setMemoFeeSink((lamports) => {
  const px = solUsd();
  if (!(px > 0)) return;
  const t = treasuryAcct();
  t.sol = (t.sol || 0) - (lamports / 1e9) * px;    // `sol` is USD units
});

// Adopt the seeded bot wallets as house accounts — their real deposits become the bots' bankroll.
{
  const p = initBotBank();
  if (p.wallets > 0) console.log(`bot-bank: ${p.wallets} funded wallet(s) — bull ${p.bull.toFixed(1)}, uwu ${p.uwu.toFixed(1)}, sol ${p.sol.toFixed(1)}`);
  else if (!FAKE_BANK_OK) console.warn(`bot-bank: NO funded wallets — bots cannot deploy. Run: npm run seed:bots`);
}

// ONE-SHOT LEDGER CORRECTION. Used to repay a player whose balance was wrong through OUR fault —
// here, the convert decimals bug that credited 1000x too little while the swap itself executed
// correctly and the proceeds stayed in the vault.
//
// This MOVES money from the house pool to a player. It never mints: the amount is taken out of the
// pool with takeExact, so if the house is short it does nothing at all. The vault already holds the
// tokens (they arrived from the real swap), so backing is unchanged.
//
//   CREDIT_WALLET=<pubkey> CREDIT_FIELD=uwu CREDIT_AMOUNT=262 CREDIT_NOTE="convert decimals bug"
if (process.env.CREDIT_WALLET && process.env.CREDIT_AMOUNT) {
  await (async () => {
    try {
      const w = String(process.env.CREDIT_WALLET);
      const f = (process.env.CREDIT_FIELD || "uwu") as Field;
      const amount = Number(process.env.CREDIT_AMOUNT);
      const note = process.env.CREDIT_NOTE || "operator correction";
      if (!(amount > 0)) { console.log("credit: refused — amount must be positive"); return; }
      const acc = ledger.get(w);
      if (!acc) { console.log(`credit: refused — no ledger account for ${w}`); return; }
      const before = acc[f] || 0;
      const poolBefore = poolBalance(f);
      if (!takeExact(f, amount)) {
        console.log(`credit: refused — house pool holds ${poolBefore.toFixed(4)} ${f}, needs ${amount}`);
        return;
      }
      acc[f] = before + amount;
      persist(); flush();
      console.log(`credit: ${w} ${f} ${before.toFixed(4)} -> ${acc[f].toFixed(4)} (+${amount}) | pool ${poolBefore.toFixed(2)} -> ${poolBalance(f).toFixed(2)} | ${note}`);
    } catch (e) { console.error("credit failed:", (e as Error).message); }
  })();
}

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
  for (const [id, a] of [...ledger.entries()]) {
    // ONLY arena bots ("<arena>:bot:<n>") are prunable. The funded bot-pool wallets are also
    // flagged isBot, but their ids are plain pubkeys — this used to delete all 20 of them on every
    // boot, seconds after initBotBank logged their balance, wiping the float and emptying the
    // arenas (and losing the ledger record of real deposited money).
    if (!a.isBot || !id.includes(":bot:")) continue;
    if (!live.has(id.split(":")[0])) { retireBot(a); dropped++; }
  }
  if (dropped) console.log(`pruned ${dropped} orphaned bot accounts from retired arenas`);
}
const SEED = Number(process.env.SEED_BOTS || 18);
for (const aid of ARENA_IDS) if (botsFor(aid).length === 0) seedBots(aid, SEED);
for (const aid of NARENA_IDS) { let guard = 0; while (botsFor(aid).length < SEED && guard++ < 500) if (!newBotN(aid)) break; }

// bots auto-enter each lobby (a fraction, with a fee taken on deploy)
/** Answer a player's deploy on the OPPOSING side.
 *
 *  Bots entered once per lobby on their own schedule, so a \$7 human entry sat against ~\$0.50 of
 *  bots: the matched book refunded almost all of it and the round was a non-event. The house should
 *  take the other side of real action whenever it can afford to — that is the whole point of holding
 *  a float. Capped by what the pool actually has, so it can never promise money it does not hold. */
// How much the house has committed IN RESPONSE to human stake, per arena-round and per side.
// Deliberately separate from the routine bot book: that money would have been deployed anyway, so
// counting it as an answer means the house never actually responds to a player.
const matchedBook = new Map<string, { bull: number; uwu: number }>();

function matchPlayerStake(aid: string, playerSide: Side, stakeUsd: number): void {
  const rn = runners[aid]; if (!rn || rn.state.phase !== "lobby") return;
  const foe: Side = playerSide === "bull" ? "uwu" : "bull";
  const [tokA, tokB] = arenaTokens(aid);
  const foeTok = foe === "bull" ? tokA : tokB;
  const f = FIELD[foeTok] as Field;
  const px = pxForRound(aid, rn.state.round, f);
  if (!(px > 0)) return;

  // WHAT COUNTS AS "ALREADY MATCHED".
  //
  // This used to subtract everything the opposing army held, including the routine bot book the
  // runners deploy on both sides every round regardless of who is playing. So a $5 human entry
  // against a foe side already holding $30 of ordinary bot money computed need = 5 - 30 and did
  // NOTHING - the routine book silently absorbed the player's action and the house never answered
  // it. From the player's seat that reads as "I added money and nobody came", which is exactly the
  // report that found this.
  //
  // Matching is a RESPONSE to human stake, so it has to be measured against what was committed in
  // response, not against the whole book. Tracked per arena-round so the 1.2s watcher can re-run
  // freely without ever answering the same stake twice.
  const mk = `${aid}:${rn.state.round}`;
  let m = matchedBook.get(mk);
  if (!m) {
    m = { bull: 0, uwu: 0 };
    matchedBook.set(mk, m);
    if (matchedBook.size > 64) for (const k of [...matchedBook.keys()].slice(0, 32)) matchedBook.delete(k);
  }
  let need = stakeUsd * MATCH_RATIO - m[foe];
  if (need <= MIN_ENTRY) return;

  // Spread the answer across bots, TOPPING THEM UP from the pool when they are short. Matching only
  // from what bots happened to be holding meant a $7.60 entry drew a $4.53 answer and the rest went
  // unmatched — the player's money sat idle and the round was smaller than it should have been.
  // The float exists to take this action, so draw on it directly, capped by what it really holds.
  // SWARM MATCHING. Filling one bot to the cap answered the stake but produced a single fat
  // counterparty, which is both boring to fight and fragile: that one fighter carries the whole
  // position. Spreading the same money over many fighters at VARIED sizes gives the house the
  // numbers advantage it should have — SMALL_EDGE tilts play toward smaller positions, so a swarm
  // of modest fighters beats one whale holding the identical total.
  // ROSTER. This used to EXCLUDE every bot that already had an entry on the foe side. The runners
  // deploy bots on both sides every round as ordinary play, so by the time a human enters, nearly
  // every bot is already on the book and the roster came back empty - the house could not answer at
  // all, with $100 sitting in the pool, because it had nobody left it was willing to use.
  //
  // There was never a reason for that filter: enter() MERGES a repeat id into the existing fighter
  // (round.ts) rather than rejecting it or spawning a duplicate, so topping up an already-deployed
  // bot has always been supported. Prefer bots with no entry yet, because more distinct fighters is
  // a better book and SMALL_EDGE favours a swarm of modest positions - but never refuse to answer
  // just because they are all already in.
  const _all = botsFor(aid);
  const _fresh = _all.filter(b => !rn.state.entries.some(e => e.id === `${b.id}|${foe}`));
  const _used = _all.filter(b => rn.state.entries.some(e => e.id === `${b.id}|${foe}`));
  const roster = _fresh.concat(_used);
  const spread = Math.max(1, Math.min(roster.length, SWARM_SIZE));
  let idx = 0;
  for (const b of roster) {
    if (need <= MIN_ENTRY) break;
    // uneven slices so the book does not look machine-generated: each takes 60%-140% of a fair share
    const left = spread - idx;
    const fair = need / Math.max(1, left);
    const want = Math.min(need, fair * (0.6 + Math.random() * 0.8));
    idx++;
    let have = (b[f] || 0) * px;
    if (have < want) {
      const drawn = drawBank(f, (want - have) / px, 1);   // the house answering, not funding a bot
      if (drawn > 0) { b[f] = (b[f] || 0) + drawn; have += drawn * px; }
    }
    const give = Math.min(want, have, CAP);
    if (give < MIN_ENTRY) continue;
    const tokens = give / px;
    b[f] -= tokens;
    const feeTok = tokens * FEE;
    bankFee(f, feeTok);
    treasury[arenaEco(aid)] += feeTok * px;
    flow(aid, rn.state.round, f).out += tokens;
    flow(aid, rn.state.round, f).in += feeTok;
    b.dep += give;
    totalDeployed[arenaEco(aid)] += give;
    stat(aid).deployed += give;
    depSide[arenaEco(aid)][foe] += give;
    rn.enter(`${b.id}|${foe}`, foe, give * (1 - FEE));
    m[foe] += give;            // credited against THIS side's answer, so the watcher stays idempotent
    need -= give;
  }
}

// Every round should have a real fight in it. Left to chance a thin pool produced one-fighter
// rounds, which look broken whatever the economics say. This tops each side up to a floor, drawing
// from the float only as far as it genuinely stretches.
const MIN_PER_SIDE = Number(process.env.MIN_PER_SIDE || 3);
function ensureMinimumEntries(aid: string): void {
  const rn = runners[aid]; if (!rn || rn.state.phase !== "lobby") return;
  const [tokA, tokB] = arenaTokens(aid);
  for (const side of ["bull", "uwu"] as Side[]) {
    const tok = side === "bull" ? tokA : tokB;
    const f = FIELD[tok] as Field;
    const px = pxForRound(aid, rn.state.round, f);
    if (!(px > 0)) continue;
    let have = rn.state.entries.filter(e => e.side === side).length;
    if (have >= MIN_PER_SIDE) continue;
    const minUsd = BOT_STAKE_USD_MIN;
    // Defection can leave an army with no fighters at all while the float sits in the other one.
    // Create what the side is missing; newBot draws from the pool and returns null if it truly
    // cannot be funded, so this can never invent money.
    let guard = 0;
    while (botsFor(aid).filter(b => b.side === side).length < MIN_PER_SIDE && guard++ < MIN_PER_SIDE * 2) {
      if (!newBot(aid, side)) break;
    }
    for (const b of botsFor(aid)) {
      if (have >= MIN_PER_SIDE) break;
      // A fighter may take EITHER army, exactly like a player — what matters is holding that side's
      // coin, not a label. A bot with both can field on both, which puts stranded money to work and
      // fills the arena. It cannot attack itself: the friendly-fire rule keys on the wallet.
      if (rn.state.entries.some(e => e.id === `${b.id}|${side}`)) continue;   // already on THIS side
      let bal = (b[f] || 0) * px;
      if (bal < minUsd) {                       // top the fighter up from the float
        const drawn = drawBank(f, (minUsd - bal) / px, 1);
        if (drawn > 0) { b[f] = (b[f] || 0) + drawn; bal += drawn * px; }
      }
      if (bal < minUsd) continue;               // the float genuinely cannot cover it
      const tokens = minUsd / px;
      b[f] -= tokens;
      const feeTok = tokens * FEE;
      bankFee(f, feeTok);
      treasury[arenaEco(aid)] += feeTok * px;
      flow(aid, rn.state.round, f).out += tokens;
      flow(aid, rn.state.round, f).in += feeTok;
      b.dep += minUsd;
      totalDeployed[arenaEco(aid)] += minUsd;
      stat(aid).deployed += minUsd;
      depSide[arenaEco(aid)][side] += minUsd;
      rn.enter(`${b.id}|${side}`, side, minUsd * (1 - FEE));
      have++;
    }
  }
}

function botsEnter(aid: string) {
  capPopulation(aid);   // keep the float behind fighters that can actually enter
  const rn = runners[aid]; if (rn.state.phase !== "lobby") return;
  const [tokA, tokB] = arenaTokens(aid);
  let pool = botsFor(aid);
  if (PLAY_MAX > 0) {   // cap entrants per side: pick a random slice of the community each round
    // LOBBY SIZE FOLLOWS THE ROOM. An empty lobby does not need a full arena — it is house money
    // paying house fees to entertain nobody, and it makes the arena look busier than it is. So the
    // floor is small when no human is in, and the cap opens up as real players arrive.
    //
    // Scaled on HUMAN STAKE rather than headcount: one person deploying $50 deserves a bigger room
    // than five deploying a dollar between them, and headcount alone would let a handful of dust
    // entries pull the whole arena open.
    const humanUsd = rn.state.entries
      .filter(e => !String(e.id).includes(":bot:"))
      .reduce((n, e) => n + (e.stake || 0) / (1 - FEE), 0);
    const IDLE_MAX = Math.max(1, Number(process.env.PLAY_IDLE_MAX || 3));
    // every ~$10 of human money on the table opens the room by one more fighter per side
    const opened = humanUsd > 0 ? IDLE_MAX + Math.ceil(humanUsd / Number(process.env.PLAY_SCALE_USD || 10)) : IDLE_MAX;
    const hiCap = Math.min(PLAY_MAX, Math.max(IDLE_MAX, opened));
    const loCap = Math.min(PLAY_MIN, hiCap);
    const want = () => loCap + Math.floor(Math.random() * Math.max(1, hiCap - loCap + 1));
    const pick = (side: Side) => {
      const arr = pool.filter(b => b.side === side).sort(() => Math.random() - 0.5);
      return arr.slice(0, want());
    };
    pool = [...pick("bull"), ...pick("uwu")];
  }
  for (const a of pool) {
    // each fighter has its own appetite for sitting out, rather than one flat 25% for everyone
    if (PLAY_MAX === 0 && Math.random() < ((a as any).skip ?? 0.25)) continue;
    // PLAY WHAT YOU HOLD. Side used to be fixed at creation, so a fighter sitting on SOL but
    // assigned to the UWU army simply sat out - the float looked exhausted while the money was
    // right there in the wrong pocket. A real player in that position switches sides, so these do
    // too. This is also why no top-up is needed: the float does not run down, it moves, and
    // whoever is holding it is who plays. Refilling a wallet from a house reservoir is the single
    // most obvious tell that it is not a person, so we do not do it.
    {
      // NOBODY IS A LOYALIST. Side is a per-round choice, not an identity. A real player holding
      // both coins picks whichever they feel like that round, so these do the same: any side they
      // can afford is eligible, and where both are affordable it is a genuine coin-flip weighted
      // by what they are actually holding. Only affordability constrains it.
      //
      // Switching ONLY when broke would have been its own tell - a wallet that never changes army
      // until the exact round it runs dry reads as a rule, not a person.
      const canPlay = (t: typeof tokA) => {
        const f = FIELD[t] as Field;
        const min = BOT_STAKE_MIN > 0 ? BOT_STAKE_MIN : unitsForUsd(f, BOT_STAKE_USD_MIN);
        return (a[f] || 0) >= min;
      };
      const okA = canPlay(tokA), okB = canPlay(tokB);
      if (okA && okB) {
        // both affordable: lean toward the heavier bag, but never deterministically
        const vA = (a[FIELD[tokA]] || 0) * usdPerUnitSafe(FIELD[tokA] as Field);
        const vB = (a[FIELD[tokB]] || 0) * usdPerUnitSafe(FIELD[tokB] as Field);
        const pA = vA + vB > 0 ? vA / (vA + vB) : 0.5;
        a.side = Math.random() < (0.25 + 0.5 * pA) ? "bull" : "uwu";
      } else if (okA) a.side = "bull";
      else if (okB) a.side = "uwu";
    }
    const myTok = a.side === "bull" ? tokA : tokB;
    // Bots do NOT convert. This used to move raw units 1:1 between the two sides' tokens, so
    // swapping 100 UWU ($2.95) produced 100 `sol` units ($100) - a ~34x mint that drained the UWU
    // float into an invented SOL balance and left one side with no army at all. Pricing the swap
    // correctly would still be wrong: a bot's convert is ledger-only, with no on-chain counterpart,
    // so the vault would owe SOL it never received. Instead a bot that can no longer stake in its
    // OWN token is retired and everything it holds returns to the pool, which hands it to bots on
    // the side that can actually use it. Same circulation, fully backed, no swap.
    const bankroll = a[FIELD[myTok]];
    // minimum stake is a DOLLAR amount converted to this token, so every army can afford to play
    const minStake = BOT_STAKE_MIN > 0 ? BOT_STAKE_MIN : unitsForUsd(FIELD[myTok] as Field, BOT_STAKE_USD_MIN);
    // Fight with real size. Staking 18-55% of a small bank meant cent-sized fighters that could not
    // hurt anyone and made every round look like dust. The house's edge comes from NUMBERS
    // (SMALL_EDGE favours smaller positions), so it can afford to commit a large share of each
    // bank — the swarm still out-positions a single large opponent.
    const stake = BOT_STAKE_MAX > 0
      ? Math.min(minStake + Math.random() * (BOT_STAKE_MAX - minStake), bankroll)
      : Math.min(Math.max(minStake, bankroll * (BOT_COMMIT_MIN + Math.random() * (BOT_COMMIT_MAX - BOT_COMMIT_MIN)) * ((a as any).temper ?? 1)), CAP, bankroll);
    if (!(minStake > 0) || stake < minStake) continue;
    a[FIELD[myTok]] -= stake;
    const mode = arenaEco(aid);
    const usdN = stake * pxForRound(aid, rn.state.round, FIELD[myTok] as Field);
    if (!(usdN > 0)) { a[FIELD[myTok]] += stake; continue; }   // no price -> undo the debit, sit out
    flow(aid, rn.state.round, FIELD[myTok] as Field).out += stake;
    // Bots pay the fee exactly like a real player — they are meant to behave identically, and the
    // treasury is real revenue on their volume too. This is only safe because the fee now lands in
    // a real treasury ACCOUNT: as a bare counter it deleted the tokens and drained the float.
    const feeTok = stake * FEE;
    bankFee(FIELD[myTok] as Field, feeTok);
    treasury[mode] += feeTok * pxForRound(aid, rn.state.round, FIELD[myTok] as Field);
    flow(aid, rn.state.round, FIELD[myTok] as Field).in += feeTok;
    a.dep += usdN; totalDeployed[mode] += usdN;     // dollars, to match ret
    stat(aid).deployed += usdN; depSide[mode][a.side] += usdN;
    // Enter in USD, not token counts. Handing the sim 49.7 UWU for one side and 1.6 USD for the
    // other made army size depend on a token's unit price: the cheaper coin fielded a ~30x larger
    // force and won every round. CAP and MIN_ENTRY were already dollar amounts, so USD is the unit
    // the rest of the economy assumes.
    rn.enter(`${a.id}|${a.side}`, a.side, usdN * (1 - FEE));   // net of deploy fee
  }
}

// name lookup so clients can label fighters
// ONE naming rule everywhere — arena, standings, history and the on-chain memo. A fighter shows an
// X handle only if they connected one; otherwise a shortened address, which is what they are.
// Invented handles like "liqLarry_3" read as house bots the moment anyone looks twice.
const nameFor = (key: string) => {
  const id = key.split("|")[0];
  const a = ledger.get(id);
  if (a) return publicName(a);
  return id.length > 8 ? id.slice(0, 4) + "…" + id.slice(-4) : id;
};

// ---- tick loop ----
const lastPhase: Record<string, string> = {};
setInterval(async () => {
  if (PAUSED) return;                      // no rounds while paused
  for (const aid of ARENA_IDS) {
    const mode = arenaEco(aid);
    const rn = runners[aid];
    if (rn.state.phase === "lobby" && lastPhase[aid] !== "lobby") { botsEnter(aid); ensureMinimumEntries(aid); }   // fires the instant the lobby opens
    const was = rn.state.phase;
    lastPhase[aid] = rn.state.phase;
    const settled = await rn.tick();
    if (settled && rn.state.phase === "lobby") { botsEnter(aid); ensureMinimumEntries(aid); lastPhase[aid] = "lobby"; }
    if (was === "lobby" && rn.state.phase === "battle" && rn.state.result) {
      const s = rn.state;
      broadcast({ t: "roundStart", arena: aid, mode, round: s.round, multiplier: s.multiplier,
        seed: s.seed, seedHash: s.seedHashPublished, secret: (s as any).secretRevealed,
        entries: s.entries.map(e => ({ id: e.id, wallet: e.id.split("|")[0], side: e.side, stake: e.stake, name: nameFor(e.id), avatar: ledger.get(e.id.split("|")[0])?.avatar, bot: e.id.includes(":bot:") })),
        cfg: newRoundConfig(mode, s.multiplier),
        hitCount: s.result.hits.length, winner: s.result.winner, settlement: s.result.settlement,
        startedAt: Date.now(), battleMs: s.battleMs || newRoundConfig(mode, s.multiplier).battleMs });
    }
  }
}, 250);

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
}, 250);

// broadcast a light state snapshot for the UI
setInterval(() => {
  const snap = (aid: string) => { const mode = arenaEco(aid); const s = runners[aid].state; return { arena: aid, tokens: arenaTokens(aid), round: s.round, phase: s.phase, multiplier: s.multiplier, entries: s.entries.length, seedHash: s.seedHashPublished, closesInMs: Math.max(0, s.closesAt - Date.now()),
    // who's already in the lobby, so the arena shows fighters gathering instead of sitting empty
    list: s.phase === "lobby" ? s.entries.slice(0, 40).map(e => ({ id: e.id, name: nameFor(e.id),
              avatar: ledger.get(e.id.split("|")[0])?.avatar, side: e.side, stake: e.stake })) : [],
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
  // `normal`/`extraction` are legacy top-level fields the client still reads. They must point at an
  // arena that is actually RUNNING — hardcoding au-* crashed the whole engine the moment
  // ENABLED_ARENAS excluded au-normal (snap() dereferenced an undefined runner every second).
  const firstOf = (eco: Mode) => ARENA_IDS.find(a => arenaEco(a) === eco);
  const nAid = firstOf("normal"), xAid = firstOf("extraction");
  broadcast({ t: "state", arenas,
              normal: nAid ? snap(nAid) : null,
              extraction: xAid ? snap(xAid) : null });
}, 1000);

// ---- http + websocket on one port ----
// The engine speaks ws for the game, but hosts (Fly/Railway/VPS) need a plain HTTP liveness probe,
// and the solvency report should be publicly readable (proof-of-reserves). So we own an http.Server
// for GET /health and GET /solvency and attach the ws server to it.
const bootAt = Date.now();
// Where the player-facing files live. In the container the image puts them at /app/web (set via
// WEB_DIR); locally they sit next to the engine folder.
const WEB_DIR = pathResolve(process.env.WEB_DIR || pathJoin(pathDirname(toPath(import.meta.url)), "..", "..", "web"));
// SEC-M3 — per-IP rate limit on the HTTP surface. The WebSocket already had one; these endpoints
// did not, and they are not all cheap: /standings walks the entire round log per request and
// /solvency and /float read cached chain state. An unauthenticated caller could pin the event loop
// for free, which starves the round runners — the part that has to keep time for real money.
//
// A token bucket rather than a fixed window, so an ordinary page load can burst (the UI hits
// several endpoints at once) while a sustained flood still gets throttled. Bounded map, swept on
// write, because a rate limiter that grows a table per source IP is itself a memory DoS.
const RL_BURST = Number(process.env.RL_BURST || 30);        // requests available instantly
const RL_PER_SEC = Number(process.env.RL_PER_SEC || 8);     // sustained refill
const RL_MAX_KEYS = 5000;
const buckets = new Map<string, { tokens: number; at: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    if (buckets.size >= RL_MAX_KEYS) {
      // drop the stalest half rather than growing without bound
      for (const [k, v] of [...buckets].sort((x, y) => x[1].at - y[1].at).slice(0, RL_MAX_KEYS / 2)) buckets.delete(k);
    }
    b = { tokens: RL_BURST, at: now };
    buckets.set(ip, b);
  }
  b.tokens = Math.min(RL_BURST, b.tokens + ((now - b.at) / 1000) * RL_PER_SEC);
  b.at = now;
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}
/** Client IP, preferring the proxy header Fly sets — otherwise every request looks like one peer. */
function clientIp(req: any): string {
  const fwd = String(req.headers["fly-client-ip"] || req.headers["x-forwarded-for"] || "");
  return (fwd.split(",")[0] || "").trim() || req.socket?.remoteAddress || "?";
}

const httpServer = createServer((req, res) => {
  const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
  const url = (req.url || "/").split("?")[0];
  if (req.method !== "GET") { res.writeHead(405, cors); return res.end('{"error":"GET only"}'); }
  // /live is exempt: it is the platform's liveness probe and must never be throttled, or a burst
  // of traffic would make the host believe the engine is down and restart it mid-round.
  if (url !== "/live" && rateLimited(clientIp(req))) {
    res.writeHead(429, { ...cors, "retry-after": "1" });
    return res.end('{"error":"rate limited"}');
  }
  // LIVENESS — "is the process up?" only. The host's health check must point HERE, not at
  // /health: a solvency freeze is a money problem that restarting cannot fix, and wiring the
  // platform check to it would just restart-loop the engine during an incident.
  if (url === "/live") {
    res.writeHead(200, cors);
    return res.end(JSON.stringify({ ok: true, uptimeSec: Math.floor((Date.now() - bootAt) / 1000) }));
  }
  // NOTE: "/" is deliberately NOT handled here — it must fall through to the static game page.
  if (url === "/health") {
    // 200 only when solvent — a frozen book is unhealthy so a host can page on it
    const body = { ok: !isFrozen(), paused: PAUSED, chain: chainReady(), vault: chainReady() ? vaultPubkey() : null,
                   arenas: ARENA_IDS.length + NARENA_IDS.length, frozen: isFrozen(),
                   uptimeSec: Math.floor((Date.now() - bootAt) / 1000) };
    res.writeHead(isFrozen() ? 503 : 200, cors); return res.end(JSON.stringify(body));
  }
  // FLOAT — where the bot bankroll actually sits, against what the vault really holds.
  // /solvency deliberately ignores house accounts (bot money is ours, not a player liability), so
  // it stayed green while a mispriced bot swap was inventing SOL out of UWU. This is the view that
  // would have caught it: every token, ledger-side vs chain-side, with the gap named.
  // Serve the rows the on-chain `results` hash commits to. Anyone can re-hash this and check it
  // matches what was anchored — which is what makes the proof complete for a 200-player lobby that
  // could never fit in a transaction.
  if (url.startsWith("/round/")) {
    const key = url.slice("/round/".length);
    const a = lastAnchors.get(key);
    if (!a) { res.writeHead(404, cors); return res.end('{"error":"round not held"}'); }
    res.writeHead(200, cors);
    return res.end(JSON.stringify({ hash: resultsHash(a), payload: JSON.parse(resultsPayload(a)) }));
  }
  // Standings derived from the permanent round log — survivorship-free, restart-proof, and
  // reconstructible from the on-chain `results` hashes plus /round by anyone who does not trust us.
  if (url.startsWith("/standings")) {
    const q = new URL(req.url || "/", "http://x").searchParams;
    res.writeHead(200, cors);
    return res.end(JSON.stringify({
      source: "round-log", rounds: roundHistory(1000).length,
      standings: standingsFromLog(q.get("arena") || undefined, Math.min(Number(q.get("limit")) || 40, 200)),
    }));
  }
  // redact at the SINK as well — a future field must not be able to leak by being added
  // Per-wallet float. "Is it fairly spread?" is not answerable from a total, and the answer drives
  // whether the arena can field a crowd or just a couple of fat bots.
  if (url === "/wallets") {
    const poolSet = new Set(poolPubkeys());
    const px = { bull: usdPerUnitSafe("bull"), uwu: usdPerUnitSafe("uwu"), sol: 1 };
    const rows: any[] = [];
    for (const a of ledger.values()) {
      if (!poolSet.has(a.id)) continue;
      const usd = (a.bull || 0) * px.bull + (a.uwu || 0) * px.uwu + (a.sol || 0);
      rows.push({ id: a.id.slice(0, 6) + "…" + a.id.slice(-4), bull: +(a.bull || 0).toFixed(4),
                  uwu: +(a.uwu || 0).toFixed(2), sol: +(a.sol || 0).toFixed(4), usd: +usd.toFixed(2) });
    }
    rows.sort((x, y) => y.usd - x.usd);
    const total = rows.reduce((t, r) => t + r.usd, 0);
    const top3 = rows.slice(0, 3).reduce((t, r) => t + r.usd, 0);
    res.writeHead(200, cors);
    return res.end(JSON.stringify({
      wallets: rows.length, totalUsd: +total.toFixed(2),
      top3SharePct: total > 0 ? +(100 * top3 / total).toFixed(1) : 0,
      emptyWallets: rows.filter(r => r.usd < 0.01).length,
      rows,
    }));
  }
  if (url === "/memo") { res.writeHead(200, cors); return res.end(JSON.stringify(redactDeep(memoStats()))); }
  if (url === "/float") {
    const per = (f: Field) => {
      let pool = 0, bots = 0, real = 0;
      const poolSet = new Set(poolPubkeys());
      for (const a of ledger.values()) {
        const v = a[f] || 0;
        if (poolSet.has(a.id)) pool += v; else if (a.isBot) bots += v; else real += v;
      }
      // the treasury is house money too, but break it out: if fees are not landing there, the
      // ledger quietly stops adding up to the vault and that is invisible in a single total
      const tre = (ledger.get(TREASURY_ID) as any)?.[f] || 0;
      const accounts = pool + bots + real;
      const open = openStakes(f);                       // staked in unsettled rounds — still ours
      // `total` is accounts-only (kept for back-compat); `trueTotal` adds money on the table, which
      // is what should be compared against chain holdings. A mid-round snapshot of accounts alone
      // reads low because the stakes are out — that is sampling, not a leak.
      return { pool, bots, real, treasury: tre, total: accounts, open, trueTotal: accounts + open,
               usd: (accounts + open) * usdPerUnitSafe(f) };
    };
    // UNITS. These blocks are NOT all in the same denomination and the numbers alone do not say so:
    // the ledger keeps bull/uwu in whole tokens but SOL in USD, while `chain` is what the vault
    // literally holds — so chain.sol is SOL while sol.pool is dollars. Both are correct; reading one
    // as the other is a ~75x error. Every block now states its own unit rather than relying on the
    // reader knowing the ledger's internal convention.
    const solPx = solUsd();   // real $/SOL — via the helper, so SOL_USD_FIXED is respected
    const s = per("sol");
    const out = { at: Date.now(), price: { bull: usdPerUnitSafe("bull"), uwu: usdPerUnitSafe("uwu"), sol: solPx || null },
                  units: { bull: "BULL tokens", uwu: "UWU tokens", sol: "USD", chain: "native units held by the vault" },
                  bull: { ...per("bull"), unit: "BULL" }, uwu: { ...per("uwu"), unit: "UWU" },
                  // sol is ledger-USD; also give the SOL-denominated view so it can be compared to
                  // chain.sol and to /solvency without the reader doing the conversion themselves
                  sol: { ...s, unit: "USD",
                         sol: solPx > 0 ? { pool: s.pool / solPx, bots: s.bots / solPx, real: s.real / solPx,
                                            treasury: s.treasury / solPx, open: s.open / solPx,
                                            trueTotal: s.trueTotal / solPx, unit: "SOL" } : null },
                  chain: { uwu: lastChain.uwu, bull: lastChain.bull, sol: lastChain.sol,
                           // a vault reading is a claim about a MOMENT — publish which one
                           at: lastChain.at || null,
                           ageSec: lastChain.at ? Math.round((Date.now() - lastChain.at) / 1000) : null,
                           stale: chainStale(),
                           units: { uwu: "UWU", bull: "BULL", sol: "SOL" } } };
    res.writeHead(200, cors); return res.end(JSON.stringify(out));
  }
  // ONE LEDGER. The browser used to derive both of these itself and keep them in localStorage, so
  // they reset on reload, carried local-sim rounds from before the engine existed, and could never
  // include a round the tab was closed for. Served from the permanent round log they are the same
  // kind of fact as the leaderboard: identical for every viewer and recomputable from the anchors.
  // `url` is the PATH only (line 1250 strips the query), so params must come off req.url — parsing
  // the stripped path silently gave every request the defaults, which is why ?limit=5 returned 20.
  if (url === "/hall") {
    const q = new URL(req.url || "/", "http://x").searchParams;
    const arena = q.get("arena") || undefined;
    const limit = Math.min(100, Math.max(1, Number(q.get("limit") || 20)));
    res.writeHead(200, cors);
    return res.end(JSON.stringify({ at: Date.now(), hall: hallOfFame(arena, limit) }));
  }
  if (url === "/history") {
    const q = new URL(req.url || "/", "http://x").searchParams;
    const id = q.get("id") || "";
    if (!id) { res.writeHead(400, cors); return res.end('{"error":"id required"}'); }
    const limit = Math.min(100, Math.max(1, Number(q.get("limit") || 40)));
    res.writeHead(200, cors);
    return res.end(JSON.stringify({ at: Date.now(), id, history: walletHistory(id, limit, q.get("arena") || undefined) }));
  }
  if (url === "/solvency") {
    res.writeHead(200, cors);
    return res.end(JSON.stringify({ frozen: isFrozen(), vault: chainReady() ? vaultPubkey() : null, report: reconLatest() }));
  }
  // ---- static frontend ----------------------------------------------------------------
  // Serves web/ so the game has a real page instead of only a JSON API. Hardened the same way
  // serve-web.mjs had to be: decode FIRST, normalise, resolve, then refuse anything that escapes
  // WEB_DIR. This process holds the vault key, so a traversal here would be catastrophic.
  let rel;
  try { rel = decodeURIComponent(url); } catch { res.writeHead(400, cors); return res.end('{"error":"bad path"}'); }
  if (rel.includes("\0")) { res.writeHead(400, cors); return res.end('{"error":"bad path"}'); }
  if (rel === "/") rel = "/index.html";
  const file = pathResolve(WEB_DIR, "." + pathPosix.normalize(rel));
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + pathSep)) {
    res.writeHead(403, cors); return res.end('{"error":"forbidden"}');
  }
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
                 ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
                 ".ico": "image/x-icon", ".webp": "image/webp" };
  readFile(file, (err, data) => {
    if (err) { res.writeHead(404, cors); return res.end('{"error":"not found"}'); }
    const ext = extname(file);
    // The app is ONE html file with everything inlined, so a cached copy means the player keeps
    // running an old build after every deploy — which looked exactly like "you changed nothing".
    // Never cache html; let genuinely static assets cache normally.
    const cache = ext === ".html"
      ? "no-cache, no-store, must-revalidate"
      : "public, max-age=3600";
    // SEC-L3 — CSP on the HTML only. Be honest about what this does and does not buy: the app is
    // one enormous inline script, so 'unsafe-inline' is unavoidable without a build step, and that
    // means this does NOT stop injected script from RUNNING.
    //
    // What it does stop is the part that turns an injection into a loss. connect-src and img-src
    // confine where anything can send data, so injected code cannot beacon a wallet address or a
    // signature out to an attacker's host; script-src stops it pulling further code from anywhere
    // we do not already trust; base-uri 'none' blocks a <base> tag from silently re-pointing every
    // relative URL on the page. Given this file has already carried a stored-XSS bug, containing
    // the blast radius is worth more than the clean policy we cannot have yet.
    //
    // The origins are exactly the ones the page really uses - unpkg (web3.js, pinned by SRI),
    // esm.sh (a dynamic import), dexscreener (prices), privy (login), unavatar (profile images).
    // solscan and twitter appear only as anchor hrefs, which are navigation, not subresources.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://unpkg.com https://esm.sh",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://unavatar.io",
      "connect-src 'self' ws: wss: https://api.dexscreener.com https://auth.privy.io https://esm.sh",
      "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
    ].join("; ");
    const head: Record<string, string> = {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": cache, "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    };
    if (ext === ".html") head["content-security-policy"] = csp;
    res.writeHead(200, head);
    res.end(data);
  });
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
// One in-flight N-team round, in the shape the client expects. Used both when a socket connects
// and when it switches arena, so a joiner never stares at an empty arena waiting up to a full round.
function roundStartNPayload(aid: string) {
  const def = NARENAS[aid]; const st = runnersN[aid]?.state;
  if (!def || !st || st.phase !== "battle" || !st.result) return null;
  const cfg = cfgN(def.eco, def.teams, st.multiplier);
  return { t: "roundStartN", arena: aid, teams: def.teams, toks: def.toks,
    round: st.round, multiplier: st.multiplier, seed: st.seed, seedHash: st.seedHashPublished,
    entries: st.entries.map(e => ({ id: e.id, wallet: String(e.id).split("|")[0], team: e.team,
      stake: e.stake, name: nameFor(String(e.id).split("|")[0]) })),
    cfg, hitCount: st.result.hits.length, winnerTeam: st.result.winnerTeam, winnerId: st.result.winnerId,
    settlement: st.result.settlement, teamTotals: st.result.teamTotals,
    startedAt: st.closesAt - (st.battleMs || cfg.battleMs), battleMs: st.battleMs || cfg.battleMs, resumed: true };
}

wss.on("connection", (ws, req) => {
  // Cap concurrent sockets per address before doing any work for this client. Behind a proxy this
  // sees the proxy's address, so a hosted deploy should also rate-limit at the edge.
  const ip = String(req?.socket?.remoteAddress || "unknown");
  if (!connectionAllowed(ip)) {
    ws.close(1013, "too many connections");   // 1013 = try again later
    return;
  }
  clients.add(ws);
  ws.send(JSON.stringify({ t: "roundHistory", rounds: roundHistory(40) }));
  ws.send(JSON.stringify({ t: "chain", ready: chainReady(), vault: chainReady() ? vaultPubkey() : null, mints: mints(), rpc: CLIENT_RPC }));
  // send the in-flight round immediately so a joiner isn't staring at an empty arena
  for (const aid of ARENA_IDS) {
    const mode = arenaEco(aid);
    const s = runners[aid].state;
    if (s.phase === "battle" && s.result) ws.send(JSON.stringify({ t: "roundStart", arena: aid, mode, round: s.round, multiplier: s.multiplier,
      seed: s.seed, seedHash: s.seedHashPublished, secret: (s as any).secretRevealed,
      // avatar was only on the RECONNECT payload, so a player's X picture never reached their
      // fighter in a live round — it appeared only if you refreshed mid-battle
      entries: s.entries.map(e => ({ id: e.id, wallet: e.id.split("|")[0], side: e.side, stake: e.stake,
                                     name: nameFor(e.id), avatar: ledger.get(e.id.split("|")[0])?.avatar,
                                     bot: e.id.includes(":bot:") })),
      cfg: newRoundConfig(mode, s.multiplier), hitCount: s.result.hits.length, winner: s.result.winner, settlement: s.result.settlement,
      startedAt: s.closesAt - (s.battleMs || newRoundConfig(mode, s.multiplier).battleMs),   // true start, so a joiner syncs mid-battle
      battleMs: s.battleMs || newRoundConfig(mode, s.multiplier).battleMs, resumed: true }));
  }
  // ...and the same for N-team arenas (3-WAY / FFA). Without this, loading the page while a 3-way
  // or FFA round is mid-battle showed an EMPTY arena until the next round opened (up to ~60s).
  for (const aid of NARENA_IDS) {
    const p = roundStartNPayload(aid);
    if (p) ws.send(JSON.stringify(p));
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
        // entries are USD, so the cap is genuinely $CAP per side rather than CAP-of-whatever-token
        const usdP = pxForRound(aid, rn.state.round, FIELD[myTok] as Field);
        if (!(usdP > 0)) return ws.send(JSON.stringify({ t: "error", msg: "Price feed unavailable — try again in a moment." }));
        const already = rn.state.entries.filter(e => e.id === `${m.wallet}|${m.side}`)
                          .reduce((n, e) => n + e.stake / (1 - FEE), 0);
        const headroom = Math.max(0, CAP - already);                      // USD
        const stake = Math.min(money(m.stake), bank, headroom / usdP); // token units
        const stakeUsd = stake * usdP;
        if (headroom < MIN_ENTRY) return ws.send(JSON.stringify({ t: "error", msg: `You're at the $${CAP} cap on that side this round.` }));
        if (stakeUsd < MIN_ENTRY) return ws.send(JSON.stringify({ t: "error", msg: `Minimum entry is $${MIN_ENTRY}.` }));
        a[FIELD[myTok]] -= stake;                                      // debit the arena token
        flow(aid, rn.state.round, FIELD[myTok] as Field).out += stake;
        flow(aid, rn.state.round, FIELD[myTok] as Field).fee += stake * FEE;   // real revenue, kept
        a.dep += stakeUsd; a.side = m.side;         // dollars, to match ret
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
        bankFee(FIELD[myTok] as Field, fee - refCut);          // the tokens, not just the number
        treasury[eco] += (fee - refCut) * usdP; totalDeployed[eco] += stakeUsd;
        depSide[eco][m.side as Side] += stakeUsd;
        stat(aid).deployed += stakeUsd; stat(aid).take += fee * usdP;
        rn.enter(`${m.wallet}|${m.side}`, m.side, stakeUsd * (1 - FEE));
        matchPlayerStake(aid, m.side as Side, stakeUsd);   // the house takes the other side
        ws.send(JSON.stringify({ t: "entered", arena: aid, mode: arenaEco(aid), side: m.side, stake }));
        pushBalance(m.wallet); persist();
      } else if (m.t === "resync") {          // { arenas: ["au-normal", ...] } -> in-flight rounds
        // N arenas (3-way / FFA) go first: switching to one mid-battle used to show an empty arena
        // until the next round opened, because resync only knew about the 2-team runners.
        for (const aid of (m.arenas || NARENA_IDS)) {
          if (!runnersN[aid]) continue;
          const p = roundStartNPayload(aid);
          if (p) ws.send(JSON.stringify(p));
        }
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
        const usdE1 = pxForRound(aid, rn.state.round, FIELD[tok] as Field);
        if (!(usdE1 > 0)) return ws.send(JSON.stringify({ t: "error", msg: "Price feed unavailable — try again in a moment." }));
        const already = rn.state.entries.filter(e => e.id === `${m.wallet}|${team}`).reduce((n, e) => n + e.stake / (1 - FEE), 0);
        const stake = Math.min(money(m.stake), bank, Math.max(0, CAP - already) / usdE1);
        const usdE = stake * usdE1;
        if (usdE < MIN_ENTRY) return ws.send(JSON.stringify({ t: "error", msg: "Insufficient balance for that arena's token." }));
        a[FIELD[tok]] -= stake; a.dep += usdE;      // dollars, to match ret
        const eco = def.eco;
        bankFee(FIELD[tok] as Field, stake * FEE);
        treasury[eco] += usdE * FEE; totalDeployed[eco] += usdE;
        stat(aid).deployed += usdE; stat(aid).take += usdE * FEE;
        rn.enter(`${m.wallet}|${team}`, team, usdE * (1 - FEE));
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
        if (sol < 0.05) {
          // Try the public devnet faucet first; it's almost always rate-limited/dry, so fall back
          // to sending a little gas FROM THE VAULT. On a test chain the vault SOL is disposable and
          // this makes the faucet actually usable without depending on Solana's broken faucet.
          let funded = false;
          try { await airdropSol(m.wallet, 1); steps.push("1 SOL (airdrop)"); funded = true; } catch { /* faucet dry */ }
          if (!funded) {
            try { await withdrawSol(m.wallet, 0.03); steps.push("0.03 SOL (gas, from vault)"); }
            catch (e) { steps.push("SOL unavailable for fees: " + (e as Error).message); }
          }
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
        const solIn = money(m.sol);
        if (!(solIn > 0)) return ws.send(JSON.stringify({ t: "error", msg: "Enter an amount above zero." }));
        const txB64 = await buildSolDepositTx(m.wallet, solIn);
        ws.send(JSON.stringify({ t: "solDepositTx", sol: solIn, priceUsd: px, txB64 }));
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
        const units = Math.min(money(m.units), a.sol);
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
      } else if (m.t === "relayTx") {
        // { wallet, signedB64, kind:'deposit'|'depositSol', side? } -> broadcast + credit in one go.
        //
        // The browser used to submit the signed tx itself, but public mainnet RPCs return 403 to
        // browser origins, so every real deposit died with "Access forbidden" AFTER the user had
        // already approved it in Phantom. The engine has a working keyed endpoint, so it relays.
        // We only BROADCAST bytes the user already signed — the vault key is never involved, and
        // crediting still goes through the same verify* path that checks the vault actually received
        // the money, so a hostile client cannot get credit for a tx that did not pay us.
        if (!chainReady()) return ws.send(JSON.stringify({ t: "error", msg: "chain not configured" }));
        // Relaying is a capability of its own: refuse anything that is not a deposit into our vault
        // from the wallet that authenticated. Otherwise this is an open relay on our paid RPC.
        const bad = await inspectRelayTx(String(m.signedB64 || ""), String(m.wallet || ""));
        if (bad) return ws.send(JSON.stringify({ t: "error", msg: "Refused to relay: " + bad }));
        let sig: string;
        try {
          sig = await broadcastSigned(String(m.signedB64 || ""));
        } catch (e) {
          return ws.send(JSON.stringify({ t: "error", msg: "Broadcast failed: " + (e as Error).message.slice(0, 160) }));
        }
        if (m.kind === "depositSol") {
          const px = solUsd();
          if (!px) return ws.send(JSON.stringify({ t: "error", msg: "SOL price unavailable — deposit not credited yet, retry shortly.", sig }));
          const sol = await verifySolDeposit(sig);
          if (sol > 0) { const a = acct(m.wallet, "bull"); const units = sol * px;
            a.sol += units; a.depIn = (a.depIn || 0) + units; a.depInSol = (a.depInSol || 0) + units; persist(); }
          ws.send(JSON.stringify({ t: "depositSolDone", sol, priceUsd: px, credited: sol * px, sig }));
        } else {
          const side: Side = m.side === "bull" ? "bull" : "uwu";
          const credited = await verifyDeposit(sig, side);
          if (credited > 0) { const a = acct(m.wallet, side);
            if (side === "bull") a.bull += credited; else a.uwu += credited;
            a.depIn = (a.depIn || 0) + credited; persist(); }
          ws.send(JSON.stringify({ t: "depositDone", side, credited, sig }));
        }
        pushBalance(m.wallet);
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
        if (m.side !== "bull" && m.side !== "uwu") return ws.send(JSON.stringify({ t: "error", msg: "Unknown side." }));
        const a = acct(m.wallet, m.side);
        const bank = m.side === "bull" ? a.bull : a.uwu;
        const amt = Math.min(money(m.amount), bank);
        if (amt < 0.01) return ws.send(JSON.stringify({ t: "error", msg: "Nothing to withdraw on that side." }));
        if (m.side === "bull") a.bull -= amt; else a.uwu -= amt;       // debit first, refund on failure
        pushBalance(m.wallet);
        try { const sig = await withdraw(m.wallet, m.side, amt); a.wOut = (a.wOut||0) + amt; persist(); ws.send(JSON.stringify({ t: "withdrawDone", side: m.side, amount: amt, sig })); }
        catch (e) { if (m.side === "bull") a.bull += amt; else a.uwu += amt; pushBalance(m.wallet);
                    ws.send(JSON.stringify({ t: "error", msg: "Withdraw failed: " + (e as Error).message })); }
      } else if (m.t === "convert") {          // { wallet, to:'bull'|'uwu'|'sol', from?, amount? }
        // You raid the ENEMY's coin, so your own side's token drains while theirs piles up. Convert
        // swaps a raided coin back so you can keep deploying. Token-GENERAL now: the old handler only
        // knew bull<->uwu, so on the live UWU/SOL arena a player holding raided SOL had no way back
        // and the button did nothing. `from` may be explicit; else we take the largest other balance.
        // A convert changes what the vault owes per asset, so it must respect a solvency freeze —
        // otherwise the one moment the books are known-bad is the moment a player can rotate into
        // whichever asset is better backed and withdraw once the freeze lifts.
        if (isFrozen()) return ws.send(JSON.stringify({ t: "error", msg: "Converts are paused (solvency check). Try again shortly." }));
        const CFIELDS = ["bull", "uwu", "sol"] as const;
        const to = (CFIELDS.includes(m.to) ? m.to : "uwu") as Field;
        const a = acct(m.wallet, (to === "sol" ? "uwu" : to) as Side);
        let from = (CFIELDS.includes(m.from) && m.from !== to ? m.from : null) as Field | null;
        if (!from) from = CFIELDS.filter(f => f !== to).sort((x, y) => (a[y] || 0) - (a[x] || 0))[0] as Field;
        const avail = a[from] || 0;
        const amt = Math.min(money(m.amount) > 0 ? money(m.amount) : avail, avail);
        if (amt < 0.01) return ws.send(JSON.stringify({ t: "error", msg: "Nothing to convert." }));
        // ONE conversion per round. Each one is a real on-chain swap costing gas and crossing a
        // spread, so unlimited converting would both drain the vault's SOL and let someone farm the
        // route. The window matches a full lobby+battle cycle.
        const sinceConv = Date.now() - (lastConvertAt.get(m.wallet) || 0);
        if (sinceConv < CONVERT_COOLDOWN_MS) {
          return ws.send(JSON.stringify({ t: "error",
            msg: `One convert per round — try again in ${Math.ceil((CONVERT_COOLDOWN_MS - sinceConv) / 1000)}s.` }));
        }
        lastConvertAt.set(m.wallet, Date.now());

        // Debit first so the balance can't be spent twice while the swap is in flight.
        a[from] -= amt;
        pushBalance(m.wallet);
        // Leave the vault enough SOL to keep paying transaction fees. Swapping the float down to
        // nothing would strand every later withdrawal.
        const SOL_FEE_RESERVE = Number(process.env.SOL_FEE_RESERVE || 0.02);

        // map a ledger field to its on-chain mint + price token. `sol` is native, swapped as wSOL.
        const mi = mints();
        const WSOL = "So11111111111111111111111111111111111111112";
        const mintOf = (f: Field) => f === "bull" ? mi?.bull : f === "uwu" ? mi?.uwu : WSOL;
        const priceTokOf = (f: Field) => (f === "bull" ? "ansem" : f) as "ansem" | "uwu" | "sol";
        const decOf = (f: Field) => f === "sol" ? 9 : (mi?.decimals ?? 6);   // wSOL 9 dp, our tokens 6
        const fromMint = mintOf(from), toMint = mintOf(to);
        // ---- INTERNAL OTC FIRST -------------------------------------------------------------
        // If the house already holds what the player wants, be the counterparty ourselves: no
        // Jupiter, no gas, no slippage, and the fee stays in the treasury. Purely a ledger move —
        // the vault's on-chain holdings are untouched, so backing is unchanged by construction.
        const pxFrom = usdPerUnitSafe(from), pxTo = usdPerUnitSafe(to);
        if (OTC_ENABLED && pxFrom > 0 && pxTo > 0) {
          const otcFee = otcFeeFor(from, to);
          const usdIn = amt * pxFrom;
          const outUnits = (usdIn * (1 - otcFee)) / pxTo;
          // LIQUIDITY GUARD. An OTC hands the player house tokens and leaves the house holding the
          // token they gave up. If they then withdraw everything, the vault must actually have it —
          // and the token they gave us is NOT the one they will withdraw. So never let a single
          // convert take more than a fraction of what the vault holds of the destination token, and
          // never below what everyone else is already owed. Large orders fall through to a real
          // swap, which genuinely sources the liquidity instead of borrowing it from the house.
          const heldOnChain = to === "sol" ? lastChain.sol * solUsd()
                            : to === "uwu" ? lastChain.uwu : lastChain.bull;
          let owedToOthers = 0;
          for (const o of ledger.values()) {
            if (o.id === m.wallet || o.isBot) continue;
            owedToOthers += o[to] || 0;
          }
          const spare = Math.max(0, heldOnChain - owedToOthers);
          const cap = spare * OTC_MAX_FRACTION;
          const withinLiquidity = outUnits <= cap;
          if (!withinLiquidity) {
            console.log(`otc: ${outUnits.toFixed(4)} ${to} exceeds the ${cap.toFixed(4)} liquidity cap — routing to a real swap`);
          }
          if (outUnits > 0 && withinLiquidity && takeExact(to, outUnits)) {
            returnBank(from, amt);                       // the house takes in what the player gave
            a[to] += outUnits;
            addConvFees(usdIn * otcFee);                 // the spread we would have paid a pool
            ws.send(JSON.stringify({ t: "converted", to, from, amount: amt, got: outUnits,
                                     fee: outUnits * otcFee / (1 - otcFee), otc: true,
                                     priceImpact: 0, simulated: false }));
            pushBalance(m.wallet); persist();
            return;
          }
        }

        // LEDGER UNITS vs TOKENS. Every field except `sol` is held as whole tokens; `sol` is held in
        // USD units. The swap deals in tokens, so cross the boundary here and back again below.
        const solPx = priceUSD("sol") || 0;
        if ((from === "sol" || to === "sol") && !(solPx > 0)) {
          a[from] += amt; lastConvertAt.delete(m.wallet); pushBalance(m.wallet);
          return ws.send(JSON.stringify({ t: "error", msg: "SOL price unavailable — try again in a moment." }));
        }
        let amtTokens = from === "sol" ? amt / solPx : amt;
        if (from === "sol") {
          const held = await solBalance(vaultPubkey()).catch(() => 0);
          const spendable = Math.max(0, held - SOL_FEE_RESERVE);
          if (amtTokens > spendable) {
            a[from] += amt; lastConvertAt.delete(m.wallet); pushBalance(m.wallet); persist();
            return ws.send(JSON.stringify({ t: "error",
              msg: `Convert too large right now — the vault can swap up to ${(spendable * solPx).toFixed(2)} of SOL.` }));
          }
        }
        let res: Awaited<ReturnType<typeof swapExact>>;
        try {
          res = (fromMint && toMint)
            ? await swapExact(vaultKeypair(), fromMint, toMint, amtTokens, decOf(from),
                              { from: priceTokOf(from), to: priceTokOf(to) }, decOf(to))
            : { ok: false, outAmount: 0, priceImpactPct: 0, simulated: false, error: "mints not configured" };
        } catch (e) {
          res = { ok: false, outAmount: 0, priceImpactPct: 0, simulated: false, error: (e as Error).message };
        }

        if (!res.ok) {
          // put it straight back — the player must never lose money to a failed swap
          a[from] += amt;
          lastConvertAt.delete(m.wallet);          // a failed attempt shouldn't burn their turn
          pushBalance(m.wallet); persist();
          return ws.send(JSON.stringify({ t: "error", msg: "Convert failed: " + (res.error || "swap unavailable") }));
        }

        // The player receives what the swap ACTUALLY returned, so pool fees and slippage come out of
        // their amount rather than the vault's. Our house cut is taken on top of that.
        // res.outAmount is whole TOKENS of `to`; convert back into that field's ledger units
        const outUnits = to === "sol" ? res.outAmount * solPx : res.outAmount;
        const fee = outUnits * CONVERT_FEE;
        const credited = Math.max(0, outUnits - fee);
        a[to] += credited;
        addConvFees(fee * usdPerUnit(to));
        ws.send(JSON.stringify({ t: "converted", to, from, amount: amt, got: credited, fee,
                                 priceImpact: res.priceImpactPct, simulated: res.simulated, sig: res.sig }));
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
      } else if (m.t === "authResume") {             // { wallet, token } -> no signature prompt
        // Lets a reconnect or refresh restore a session that was already proven by signature.
        const ok = authResume(ws, String(m.wallet || ""), String(m.token || ""));
        ws.send(JSON.stringify({ t: "authResult", ok, resumed: true, msg: ok ? undefined : "session expired" }));
        if (ok) pushBalance(String(m.wallet));
      } else if (m.t === "authVerify") {             // { wallet, signature (base64) }
        // closed-beta gate: on a live chain, only whitelisted wallets may authenticate. Refuse
        // BEFORE checking the signature so a valid non-listed wallet still can't get in.
        if (!walletAllowed(m.wallet)) {
          return ws.send(JSON.stringify({ t: "authResult", ok: false, wallet: m.wallet, msg: "This wallet isn't on the launch whitelist yet." }));
        }
        const r = authVerify(ws, m.wallet, m.signature);
        // Hand back a session token so reconnects and refreshes do NOT re-prompt for a signature.
        // Deploying into a round is not a chain operation and must never cost the player a signature.
        const token = r.ok ? mintSession(m.wallet) : undefined;
        ws.send(JSON.stringify({ t: "authResult", ...r, token }));
      } else if (m.t === "standings") {
        ws.send(JSON.stringify({ t: "standings", standings: standingsFromLog(m.arena, Math.min(Number(m.limit) || 40, 200)) }));
      } else if (m.t === "roundHistory") {
        ws.send(JSON.stringify({ t: "roundHistory", rounds: roundHistory(Math.min(Number(m.limit) || 40, 200),
                                                                        m.mine ? String(m.wallet || "") : undefined) }));
      } else if (m.t === "getBalance") {
        if (!isAuthed(ws, m.wallet)) return;         // balances are private; only the owner may read
        ws.send(JSON.stringify(balPayload(m.wallet)));
      }
    } catch (e) { ws.send(JSON.stringify({ t: "error", msg: redact((e as Error).message) })); }
  });
});
/** Give every open stake back before we die.
 *
 *  A round lives only in memory. Entering debits the account immediately, so a restart between
 *  entry and settlement destroyed the whole pot: the tokens stayed in the vault while the ledger
 *  simply forgot who owned them. Across a day of deploys that is where the float went - measured at
 *  ~$19 of a $27 book in a single restart, and 1520 UWU down to 995 over an afternoon.
 *
 *  Refunds are GROSS: the deploy fee was taken on the way in, and a round that never happened has
 *  no business keeping it. */
function refundOpenRounds(): number {
  let refunded = 0;
  const give = (aid: string, round: number, entries: any[], fieldFor: (e: any) => Field) => {
    for (const e of entries) {
      const a = ledger.get(String(e.id).split("|")[0]);
      if (!a) continue;
      const f = fieldFor(e);
      const gross = (e.stake || 0) / (1 - FEE);          // undo the fee taken at entry
      const units = unitsAtRound(aid, round, f, gross);
      if (units > 0) { a[f] += units; refunded++; }
    }
  };
  for (const aid of ARENA_IDS) {
    // Refund in ANY phase. Bots and players enter during the LOBBY, so skipping it left those
    // stakes debited and unreturned - the restart test lost ~$2.50 of SOL exactly that way.
    // Settlement swaps in a fresh lobby (round.ts), so `entries` only ever holds unsettled stakes.
    const st = runners[aid]?.state;
    if (!st || !st.entries?.length) continue;
    const [tokA, tokB] = arenaTokens(aid);
    give(aid, st.round, st.entries, (e) => FIELD[e.side === "bull" ? tokA : tokB] as Field);
  }
  for (const aid of NARENA_IDS) {
    const st = runnersN[aid]?.state;
    if (!st || !st.entries?.length) continue;
    const def = NARENAS[aid];
    give(aid, st.round, st.entries, (e) => {
      const t = Number(String(e.id).split("|")[1]) || 0;
      return FIELD[def.teams === 0 ? def.toks[0] : (def.toks[t] || def.toks[0])] as Field;
    });
  }
  return refunded;
}

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    const n = refundOpenRounds();
    if (n) console.log(`refunded ${n} open stake(s) from the in-flight round`);
    // persist() BEFORE flush(). persist() serialises the live ledger into the snapshot; flush()
    // only writes whatever was already staged. Without the persist, the refund above was computed
    // correctly, applied to the in-memory accounts, and then thrown away on exit - the stakes came
    // back to nobody. Every other call site pairs them; this one, the only one that runs while the
    // process is dying, did not.
    //
    // It hid because the money is not LOST: the coin never leaves the vault, so the ledger simply
    // stops claiming it and the rebalance daemon re-credits the house from chain a few minutes
    // later. That is the oscillation - claim collapsing on restart, then being restored in one
    // large correction (+1260 UWU in a single cycle).
    persist();
    flush();
    console.log("ledger persisted and flushed to disk");
    process.exit(0);
  });
process.on("exit", () => { persist(); flush(); });   // same reason: stage the live ledger, then write
console.log(`⚔  engine live on ws://localhost:${PORT}  (authoritative rounds + hybrid bots) chain=${chainReady()}`);
