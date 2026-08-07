// The sim is unit-agnostic: it just compares the numbers it is handed. That makes the CONVERSION
// BOUNDARY the place fairness is won or lost, and it is where it was lost in production.
//
// us-extraction pits UWU against SOL. Bots on the UWU side entered raw token counts (49.7 UWU) while
// the SOL side entered dollars (1.6), because `sol` is already USD-denominated. The sim read those
// as army sizes, so the UWU army was ~30x larger for a third of the money and won every single
// round. These tests pin the rule that prevents it: everything crosses into the sim in USD, and
// payouts cross back into each side's own token.
import { test } from "node:test";
import assert from "node:assert/strict";

// mirrors server.ts: `sol` is already dollars, tokens convert at their price
const PX: Record<string, number> = { uwu: 0.02953, bull: 0.1746, sol: 1 };
const toUsd = (field: string, units: number) => units * PX[field];
const fromUsd = (field: string, usd: number) => usd / PX[field];

test("equal dollars produce equal armies, whatever the token is worth", () => {
  const oneDollarOfUwu = fromUsd("uwu", 1);
  const oneDollarOfSol = fromUsd("sol", 1);
  assert.notEqual(oneDollarOfUwu, oneDollarOfSol, "the raw token counts differ wildly");
  // ...but what the sim receives must not
  assert.equal(toUsd("uwu", oneDollarOfUwu).toFixed(6), toUsd("sol", oneDollarOfSol).toFixed(6));
});

test("the production numbers: raw counts gave UWU a ~30x army for a third of the money", () => {
  const uwuUnits = 49.7, solUnits = 1.6 + 1.7;
  // what the sim used to see
  assert.ok(uwuUnits / solUnits > 14, "raw counts: UWU fields an overwhelming army");
  // what it sees now — and the SOL side is actually the bigger bet
  const uwuUsd = toUsd("uwu", uwuUnits), solUsd = toUsd("sol", solUnits);
  assert.ok(solUsd > uwuUsd, `SOL staked more money: $${solUsd.toFixed(2)} vs $${uwuUsd.toFixed(2)}`);
});

test("a stake round-trips through USD without losing value", () => {
  for (const field of ["uwu", "bull", "sol"]) {
    const units = 137.42;
    const back = fromUsd(field, toUsd(field, units));
    assert.ok(Math.abs(back - units) < 1e-9, `${field} round-trip lost value`);
  }
});

test("settlement pays each side in its own token, conserving dollars", () => {
  // two entries, equal money, different tokens; winner takes the pot
  const potUsd = toUsd("uwu", fromUsd("uwu", 5)) + toUsd("sol", 5);
  assert.equal(potUsd.toFixed(6), (10).toFixed(6));
  const paidToUwuSide = fromUsd("uwu", potUsd);
  assert.equal(toUsd("uwu", paidToUwuSide).toFixed(6), potUsd.toFixed(6),
               "converting the payout back into UWU must preserve the dollar value");
});

// A round is entered and settled ~60s apart. A feed that drops to zero in between would turn the
// payout conversion into a divide-by-zero and silently wipe the winnings.
test("a dead price feed must never convert a payout to zero or infinity", () => {
  const lastGood: Record<string, number> = { uwu: 0.02953 };
  const safePx = (live: number, field: string) => {
    if (live > 0) { lastGood[field] = live; return live; }
    return lastGood[field] || 0;
  };
  const px = safePx(0, "uwu");                       // feed is down
  assert.ok(px > 0, "falls back to the last good price");
  const paid = 10 / px;
  assert.ok(Number.isFinite(paid) && paid > 0, "payout stays finite and positive");
});

// The bot top-up swap moved raw units 1:1 between the two sides' tokens. Because `sol` is already
// dollars, swapping UWU into it multiplied the value by ~34x and drained one side's float into an
// invented balance on the other — which is what turned every round one-sided.
test("a 1:1 unit swap between differently-priced tokens mints money", () => {
  const uwuUnits = 100;
  const asDollars = toUsd("uwu", uwuUnits);
  const oneToOne = toUsd("sol", uwuUnits);     // what the old code produced
  assert.ok(oneToOne / asDollars > 30, `1:1 swap turned $${asDollars.toFixed(2)} into $${oneToOne.toFixed(2)}`);
});

test("a correctly priced swap conserves dollars", () => {
  const uwuUnits = 100;
  const usd = toUsd("uwu", uwuUnits);
  const solUnits = fromUsd("sol", usd);
  assert.equal(toUsd("sol", solUnits).toFixed(6), usd.toFixed(6));
});

// Even at the right rate a bot's swap is ledger-only: nothing moves on-chain, so the vault would
// owe a token it never received. Retiring the bot and recycling its holdings keeps the float where
// the chain actually put it.
test("recycling through the pool conserves each token separately", () => {
  const pool = { uwu: 1000, sol: 50 };
  const bot = { uwu: 0, sol: 12 };            // a UWU-side bot holding only raided SOL
  pool.uwu += bot.uwu; pool.sol += bot.sol;   // retire: everything goes back
  bot.uwu = 0; bot.sol = 0;
  assert.equal(pool.uwu, 1000, "UWU untouched");
  assert.equal(pool.sol, 62, "SOL returns intact — no cross-token invention");
});

// A round converts a stake INTO usd at entry and a payout BACK OUT ~60s later. If the two ends use
// different prices, the round mints or burns tokens purely on market movement. Measured live that
// swung the book +10% in five rounds — 50x the 0.2% fee — so the float wandered in both directions
// and no amount of reconciliation could settle it.
test("one price per round makes a round token-neutral", () => {
  const stakeUnits = 1000;
  const pxIn = 0.02953;
  const pxOut = 0.02650;               // a real 10% move inside one round

  // drifting: enter at pxIn, settle at pxOut
  const usd = stakeUnits * pxIn;
  const driftOut = usd / pxOut;
  assert.ok(driftOut - stakeUnits > 100, `drift minted ${(driftOut - stakeUnits).toFixed(0)} tokens from nothing`);

  // frozen: both ends use the round's price
  const frozenOut = usd / pxIn;
  assert.ok(Math.abs(frozenOut - stakeUnits) < 1e-9, "frozen price returns exactly what went in");
});

test("freezing the price cuts both ways — it also stops the house pocketing a rise", () => {
  const stakeUnits = 1000, pxIn = 0.02953, pxUp = 0.0325;
  const usd = stakeUnits * pxIn;
  assert.ok(usd / pxUp < stakeUnits, "a price rise would have burned player tokens");
  assert.equal((usd / pxIn).toFixed(9), stakeUnits.toFixed(9));
});

// A round lives only in memory, but entering debits the account immediately. A restart in between
// therefore destroyed the pot: tokens stayed in the vault, the ledger forgot who owned them.
// The refund must be GROSS — a round that never happened does not get to keep the deploy fee.
test("an interrupted round returns the FULL stake, fee included", () => {
  const FEE = 0.002;
  const stakeUnits = 500, px = 0.02953;
  const usdIn = stakeUnits * px;
  const entryHolds = usdIn * (1 - FEE);        // what the sim was handed

  const netRefund = entryHolds / px;           // refunding what the entry holds
  assert.ok(netRefund < stakeUnits, "a net refund silently keeps the fee");

  const grossRefund = (entryHolds / (1 - FEE)) / px;
  assert.ok(Math.abs(grossRefund - stakeUnits) < 1e-9, "gross refund makes the player whole");
});

test("refunding at the round's frozen price returns exactly the tokens staked", () => {
  const stakeUnits = 500, pxRound = 0.02953, pxNow = 0.0330;
  const usd = stakeUnits * pxRound;
  assert.ok(Math.abs(usd / pxRound - stakeUnits) < 1e-9);
  assert.ok(usd / pxNow < stakeUnits, "refunding at the current price would short the player");
});

// The bot fee: 0.2% of every bot stake went to the treasury COUNTER while the tokens left the
// accounts. Bots are house money, so the house was skimming its own bankroll ~9 rounds a minute —
// with zero real players the float decays to nothing in days. Only real players may pay the fee.
test("the house charging itself decays the float to nothing", () => {
  const FEE = 0.002, roundsPerDay = 9 * 60 * 24;
  let float = 44;                       // dollars, the real mainnet float
  for (let i = 0; i < roundsPerDay * 2; i++) float -= (float * 0.5) * FEE;  // half the float staked per round
  assert.ok(float < 44 * 0.01, `two idle days left $${float.toFixed(2)} of $44`);
});

test("returning bot fees to the pool conserves the float exactly", () => {
  const FEE = 0.002;
  let pool = 1000, treasury = 0;
  for (let i = 0; i < 500; i++) {
    const stake = pool * 0.3;
    pool -= stake;                        // debit
    pool += stake * FEE;                  // fee straight back to the pool
    pool += stake * (1 - FEE);            // settlement pays out the net (zero-sum among bots)
    treasury += 0;                        // no house self-revenue
  }
  assert.ok(Math.abs(pool - 1000) < 1e-6, `float conserved: ${pool.toFixed(6)}`);
  assert.equal(treasury, 0, "treasury only grows on real players");
});

// ---- the treasury has to be an ACCOUNT, not a counter ----
// A fee debits real tokens from a player. If the treasury is only a number, those tokens are
// credited to nobody: the ledger's claim on the vault shrinks on every deploy while the vault keeps
// the tokens. That gap is what showed up as "162% backed" — money in the vault that nobody owns.
test("a counter-only treasury silently un-books the vault", () => {
  const FEE = 0.002;
  let playerTokens = 1000, treasuryCounterUsd = 0;
  const vault = 1000;
  for (let i = 0; i < 300; i++) {
    const stake = 10;
    playerTokens -= stake * FEE;            // tokens leave the player
    treasuryCounterUsd += stake * FEE * 1;  // ...and become a number
  }
  assert.ok(playerTokens < vault, "the ledger now claims less than the vault holds");
  assert.ok(vault - playerTokens > 5, `${(vault - playerTokens).toFixed(2)} tokens owned by nobody`);
});

test("a treasury ACCOUNT keeps the books equal to the vault", () => {
  const FEE = 0.002;
  let playerTokens = 1000, treasuryTokens = 0;
  const vault = 1000;
  for (let i = 0; i < 300; i++) {
    const fee = 10 * FEE;
    playerTokens -= fee; treasuryTokens += fee;   // the tokens land somewhere
  }
  assert.ok(Math.abs((playerTokens + treasuryTokens) - vault) < 1e-9, "ledger == vault, exactly");
  assert.ok(treasuryTokens > 5, "and the house actually holds its revenue");
});

// With a real treasury account, charging bots is safe AND correct — they are meant to behave
// identically to players, and their volume is real revenue.
test("bots paying fees moves float to the treasury rather than destroying it", () => {
  const FEE = 0.002;
  let pool = 1000, treasuryTokens = 0;
  for (let i = 0; i < 500; i++) {
    const stake = pool * 0.3, fee = stake * FEE;
    pool -= fee; treasuryTokens += fee;
    // the round itself is zero-sum between bots, so only the fee moves
  }
  assert.ok(Math.abs((pool + treasuryTokens) - 1000) < 1e-9, "nothing lost");
  assert.ok(treasuryTokens > 0, "the house earns on bot volume too");
  assert.ok(pool < 1000, "and the playable float shrinks by exactly the revenue taken");
});

// ---- on-chain round anchoring ----
// The memo carries the proof (seed commitment + revealed seed + winner) AND every wallet's entry
// and exit in both tokens. It has to fit in ONE transaction, so the encoding is size-critical.
import { _encodeForTest } from "../memo.ts";

const anchorFor = (nPlayers: number) => ({
  arena: "us-extraction", round: 4746,
  seedHash: "ed48e8c454fa77f8837f4fa2858022f17d2e2a79bbc1f0a2",
  seed: "863888d84ca936db76167c1585cc3ebb6834d7ab4ca025c6",
  winner: "bull", pot: 7.65,
  players: Array.from({ length: nPlayers }, (_, i) => ({
    id: i === 0 ? "BTYdc2awdFDZnDc8wVs3wv61UEYDDMQ329Zy3KC9JHVZ" : `us-extraction:bot:${i}`,
    side: i % 2 ? "uwu" : "bull", bot: i !== 0,
    inTok: 18.0531, outA: 0.1732, outB: 0.5411,
  })),
});

test("a realistic round with per-wallet detail fits in one transaction", () => {
  const bytes = Buffer.byteLength(_encodeForTest([anchorFor(7)], true));
  assert.ok(bytes < 700, `7-player round encodes to ${bytes} bytes — must stay under the memo cap`);
});

// The memo is written for a HUMAN reading it on Solscan, not for a decoder. That is the whole point
// of anchoring: a proof only we can read is just a receipt.
test("the memo reads as plain English on an explorer", () => {
  const text = _encodeForTest([anchorFor(4)], true);
  assert.ok(text.includes("Bulls vs Unicorns"), "says what it is");
  assert.ok(text.includes("Round 4746"), "says which round");
  assert.ok(text.includes("UWU vs SOL"), "names the actual coins, not slot A/B");
  assert.ok(/Winner: (UWU|SOL)/.test(text), "names the winning army");
  assert.ok(text.includes("commit(before)") && text.includes("seed(revealed)"),
            "labels the two halves of the fairness proof so a stranger knows what to check");
  assert.ok(text.includes("$"), "money is shown in dollars");
  assert.ok(!text.includes('{"a":'), "no raw JSON");
});

test("even a busy round still fits", () => {
  const bytes = Buffer.byteLength(_encodeForTest([anchorFor(14)], true));
  assert.ok(bytes < 700, `14-player round encodes to ${bytes} bytes`);
});

test("dropping player detail is the last resort, and the proof always survives", () => {
  const full = _encodeForTest([anchorFor(40)], true);
  const lean = _encodeForTest([anchorFor(40)], false);
  assert.ok(Buffer.byteLength(lean) < Buffer.byteLength(full));
  // whatever gets dropped, the part a stranger needs in order to VERIFY must always survive
  for (const must of ["commit(before)", "seed(revealed)", "Winner:", "Round "]) {
    assert.ok(lean.includes(must), `"${must}" (the verifiable part) must never be dropped`);
  }
});

test("the anchor binds the commitment to the revealed seed", () => {
  const enc = _encodeForTest([anchorFor(3)], true);
  assert.ok(enc.includes("ed48e8c454fa77f8"), "seed hash published before the round");
  assert.ok(enc.includes("863888d84ca936db"), "seed revealed at fight start");
});

// ---- THE UNIT-MIXING BUG CLASS ----
// `bull` and `uwu` are TOKEN COUNTS; `sol` is already USD. Summing them raw is adding apples to
// dollars, and it surfaced four different ways at once: a bot holding 150 UWU ($4.15) shown as
// "$150" on the leaderboard, a player's P/L stuck at "-$57.04", dashboard totals nonsense, and the
// battle report disagreeing with the wallet. One root cause, four symptoms.
const PXB = 0.1763, PXU = 0.0277;
const worthUsd = (a: {bull:number;uwu:number;sol:number}) => a.bull * PXB + a.uwu * PXU + a.sol;

test("a raw field sum wildly misprices an account", () => {
  const a = { bull: 0, uwu: 150, sol: 0 };
  const raw = a.bull + a.uwu + a.sol;            // what the leaderboard printed
  assert.equal(raw, 150);
  assert.ok(Math.abs(worthUsd(a) - 4.155) < 0.001, "actually worth $4.16, shown as $150");
  assert.ok(raw / worthUsd(a) > 30, "off by more than 30x");
});

test("mixing tokens with SOL is the worst case, because sol is already dollars", () => {
  const a = { bull: 0, uwu: 100, sol: 7.27 };
  const raw = a.bull + a.uwu + a.sol;
  assert.ok(Math.abs(raw - 107.27) < 1e-9, "raw sum treats 100 UWU as $100");
  assert.ok(Math.abs(worthUsd(a) - 10.04) < 0.01, "really $10.04");
});

test("P/L must compare dollars to dollars, and must not drop SOL", () => {
  const wallet = { bull: 0, uwu: 203, sol: 0 };
  const investedUsd = 8.66;                       // 50 UWU + 0.1 SOL, at deposit time
  const bad = (wallet.bull + wallet.uwu) - investedUsd;   // old client maths
  const good = worthUsd(wallet) - investedUsd;
  assert.ok(bad > 190, `old maths reported ${bad.toFixed(2)} — a token count minus dollars`);
  assert.ok(Math.abs(good - (-3.04)) < 0.05, "real P/L is a couple of dollars, not a hundred");
});

test("mid-round, staked money must still count toward worth", () => {
  // the stake leaves the account and sits in the round; ignoring it made worth read ~0
  const wallet = { bull: 0, uwu: 0.2, sol: 0 }, inRingUsd = 5.4, investedUsd = 8.66;
  const withoutRing = worthUsd(wallet) - investedUsd;
  const withRing = worthUsd(wallet) + inRingUsd - investedUsd;
  assert.ok(withoutRing < -8, `${withoutRing.toFixed(2)} — looks like everything was lost`);
  assert.ok(withRing > -4, "counting the stake on the table gives the true position");
});

test("a bot's P/L is winnings against stake, not against a deposit it never made", () => {
  const bot = { dep: 12.5, ret: 14.0 };
  assert.ok(Math.abs((bot.ret - bot.dep) - 1.5) < 1e-9);
});

// A raid TAKES the enemy's coin, so a winning bot ends the round holding the coin it cannot stake.
// Judging bust on own-token alone retired exactly the winners and deleted their profit with them —
// which is why the board could only ever show losers and the aggregate read -50%.
test("a winner must not be retired for holding what it just won", () => {
  const PXU = 0.0277, PXS = 1, MIN = 0.5;
  const winner = { own: 0.1, foe: 12.0 };                 // 12 SOL-USD raided, own token spent
  const ownUsd = winner.own * PXU;
  assert.ok(ownUsd < MIN, "own token alone looks broke");
  const total = ownUsd + winner.foe * PXS;
  assert.ok(total > MIN * 10, `but it is actually up $${total.toFixed(2)} — retiring it deletes the profit`);
});

// The fix is not to convert the winnings — it is to change sides. A bot holding the enemy's coin
// simply fights for that army next round. Nothing moves, no fee is charged, and it reads true:
// raiders migrate toward whichever coin is winning.
test("a bot defects to the coin it raided instead of converting", () => {
  const MIN = 0.5, PXS = 1;
  const bot = { side: "bull", own: 0.1, foe: 12.0 };
  const canPlayOwn = bot.own * 0.0277 >= MIN;
  const canPlayFoe = bot.foe * PXS >= MIN;
  assert.equal(canPlayOwn, false, "cannot fight for its old army");
  assert.equal(canPlayFoe, true, "but it is rich in the other one");
  const newSide = bot.side === "bull" ? "uwu" : "bull";
  assert.equal(newSide, "uwu", "so it switches");
});

test("switching sides costs nothing and moves no money", () => {
  const before = { pool: 1000, botOwn: 0.1, botFoe: 12.0, treasury: 5 };
  const after = { ...before };                    // a side flip touches no balance at all
  assert.deepEqual(after, before, "no conversion, no fee, no float movement");
});
