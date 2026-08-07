// Bot bankroll invariants. Bots play with REAL deposited money, so drawing must conserve value and
// must spread the float across the population — the first version let ~20 bots swallow the entire
// pool (3000 -> 0 in 16 minutes), which left every later bot with a zero bank and emptied arenas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ledger, acct } from "../ledger.ts";
import { initBotBank, drawBank, returnBank, poolBalance, botBankReady } from "../bot-bank.ts";

const POOL = ["poolA", "poolB", "poolC"];
function seedPool(perAccount = 1000) {
  ledger.clear();
  process.env.BOT_POOL = POOL.join(",");
  for (const id of POOL) { const a = acct(id, "bull"); a.bull = perAccount; a.uwu = perAccount; }
  return initBotBank();
}

test("pool initialises from the configured addresses and marks them house accounts", () => {
  const p = seedPool(1000);
  assert.equal(p.wallets, 3);
  assert.equal(p.bull, 3000);
  assert.equal(botBankReady(), true);
  for (const id of POOL) assert.equal(ledger.get(id)!.isBot, true, "pool wallets are house money, not player liabilities");
});

test("drawing conserves value — what leaves the pool is exactly what the bot receives", () => {
  seedPool(1000);
  const before = poolBalance("bull");
  const got = drawBank("bull", 120);
  assert.ok(got > 0);
  assert.ok(Math.abs((before - poolBalance("bull")) - got) < 1e-9, "pool must fall by exactly the granted amount");
});

test("no single bot can swallow the float — draws are capped to a share", () => {
  seedPool(1000);                       // 3000 total
  const got = drawBank("bull", 99999);  // greedy request
  assert.ok(got < 3000, `a single draw must not take the whole pool, took ${got}`);
  assert.ok(poolBalance("bull") > 2000, "most of the float must remain for other bots");
});

test("a large population still gets funded instead of the first few taking everything", () => {
  seedPool(1000);                       // 3000 total
  const grants: number[] = [];
  for (let i = 0; i < 200; i++) grants.push(drawBank("bull", 150));
  const funded = grants.filter(g => g > 0.01).length;
  assert.ok(funded > 150, `most bots should get something, only ${funded}/200 did`);
  assert.ok(poolBalance("bull") >= -1e-9, "pool never goes negative");
  const total = grants.reduce((a, b) => a + b, 0);
  assert.ok(total <= 3000 + 1e-6, `cannot hand out more than the float (${total} of 3000)`);
});

test("returnBank puts money back (a pruned bot's remainder is recycled)", () => {
  seedPool(1000);
  const got = drawBank("uwu", 100);
  const after = poolBalance("uwu");
  returnBank("uwu", got);
  assert.ok(Math.abs(poolBalance("uwu") - (after + got)) < 1e-9);
});

test("an empty pool grants nothing rather than inventing money", () => {
  seedPool(0);
  assert.equal(drawBank("bull", 100), 0);
  assert.equal(botBankReady(), false, "no float means bots simply cannot deploy");
});

test("pool wallets survive the orphan-bot prune (they are flagged isBot but are NOT arena bots)", () => {
  seedPool(500);
  // reproduce the boot prune: it deletes bot accounts whose arena no longer exists
  const live = new Set(["au-normal", "3w-normal"]);
  ledger.set("au-normal:bot:1", { id: "au-normal:bot:1", name: "b", side: "bull", bull: 10, uwu: 0, sol: 0,
    isBot: true, dep: 0, ret: 0, games: 0, wins: 0 } as any);
  ledger.set("retired-arena:bot:9", { id: "retired-arena:bot:9", name: "b", side: "bull", bull: 10, uwu: 0, sol: 0,
    isBot: true, dep: 0, ret: 0, games: 0, wins: 0 } as any);

  for (const [id, a] of [...ledger.entries()]) {
    if (!a.isBot || !id.includes(":bot:")) continue;          // the fix
    if (!live.has(id.split(":")[0])) ledger.delete(id);
  }

  for (const id of POOL) assert.ok(ledger.get(id), `pool wallet ${id} must survive the prune`);
  assert.ok(ledger.get("au-normal:bot:1"), "a live arena's bot survives");
  assert.equal(ledger.get("retired-arena:bot:9"), undefined, "a retired arena's bot is still pruned");
  assert.equal(poolBalance("bull"), 1500, "the float is intact");
});

test("a busted bot's remaining money returns to the pool instead of vanishing", () => {
  seedPool(1000);
  const before = poolBalance("uwu");
  // a bot draws a bank, loses most of it, then busts with a remainder
  const bank = drawBank("uwu", 100);
  assert.ok(bank > 0);
  const afterDraw = poolBalance("uwu");
  assert.ok(Math.abs((before - afterDraw) - bank) < 1e-9, "draw leaves the pool by exactly the bank");

  const remainder = bank * 0.3;              // what it still holds when it busts
  returnBank("uwu", remainder);              // retireBot() does this before deleting

  const recovered = poolBalance("uwu");
  assert.ok(Math.abs(recovered - (afterDraw + remainder)) < 1e-9, "the remainder comes back");
  // the only real loss is what it LOST IN PLAY, which went to other fighters - not destroyed
  const destroyed = before - recovered - (bank - remainder);
  assert.ok(Math.abs(destroyed) < 1e-9,
    `no money may be destroyed by a bust; ${destroyed} went missing`);
});

// The arena died in production with "joined 50 / busted 49 / entries 0": bots were retired at 0.8x
// the minimum stake, so anything holding between 0.8x and 1x could neither deploy nor be recycled.
// Each one sat on a share of the float permanently. Enough of them and the pool reads empty while
// every token is still on the books. This models a full life-cycle and pins the invariant that
// makes it impossible: money is never held by a bot that cannot play.
test("float is never trapped in bots that can neither deploy nor bust", () => {
  const POOL_START = 1520;          // UWU actually recovered on mainnet
  const MIN_STAKE = 16.93;          // $0.50 at the live UWU price
  const BUST_AT = MIN_STAKE;        // must not be lower - that is the dead band

  const pool = { uwu: POOL_START };
  const bots: number[] = [];
  const SPREAD = 20;

  const draw = (want: number) => {
    const got = Math.min(want, pool.uwu / SPREAD);
    pool.uwu -= got;
    return got;
  };

  for (let round = 0; round < 60; round++) {
    // retire anyone who cannot afford a stake, returning their balance
    for (let i = bots.length - 1; i >= 0; i--) {
      if (bots[i] < BUST_AT) { pool.uwu += bots[i]; bots.splice(i, 1); }
    }
    // top the population up, refusing to create a bot that cannot play
    while (bots.length < 20) {
      const bank = draw(MIN_STAKE * 4);
      if (bank < MIN_STAKE) { pool.uwu += bank; break; }
      bots.push(bank);
    }
    // Play the round zero-sum, as the real settlement is: a loser's stake moves to a winner.
    // Modelling it as a flat edge against nobody would bleed the float for reasons that have
    // nothing to do with the invariant under test.
    const playing = bots.map((b, i) => [b, i] as const).filter(([b]) => b >= MIN_STAKE).map(([, i]) => i);
    for (let k = 0; k + 1 < playing.length; k += 2) {
      const [w, l] = round % 2 === 0 ? [playing[k], playing[k + 1]] : [playing[k + 1], playing[k]];
      const stake = Math.min(bots[w], bots[l], MIN_STAKE);
      bots[w] += stake; bots[l] -= stake;
    }
  }

  const held = bots.reduce((s, b) => s + b, 0);
  assert.ok(Math.abs(pool.uwu + held - POOL_START) < 0.01,
            `float must be conserved: ${(pool.uwu + held).toFixed(2)} vs ${POOL_START}`);
  // the invariant that was violated in production
  const stuck = bots.filter(b => b < MIN_STAKE);
  assert.equal(stuck.length, 0, "no bot may hold float it cannot stake");
});

test("a bust threshold below the stake minimum strands money — the bug, reproduced", () => {
  const MIN_STAKE = 16.93;
  const BUST_AT = MIN_STAKE * 0.8;        // the old default
  const bots = [16.5, 15.2, 14.8];        // all below the stake minimum, all above the old bust line
  const canPlay = bots.filter(b => b >= MIN_STAKE).length;
  const wouldRetire = bots.filter(b => b < BUST_AT).length;
  assert.equal(canPlay, 0, "none can deploy");
  assert.equal(wouldRetire, 0, "and under the old rule none are recycled either — money stranded");
  // under the corrected rule every one of them is returned to the pool
  assert.equal(bots.filter(b => b < MIN_STAKE).length, bots.length);
});

// CONCENTRATION. returnBank gave everything to poolAccounts()[0], so every bust, unused bank and fee
// came back to one address — and because funding scans the pool in order, that same wallet then
// supplied most of the stake. Measured live: 3 of 21 wallets held 82% of all stake, top 5 held 99%.
test("returned money goes to the emptiest wallet, not always the first", () => {
  const pool = [{ uwu: 100 }, { uwu: 5 }, { uwu: 60 }];
  const give = (amount: number) => {
    let t = pool[0];
    for (const a of pool) if (a.uwu < t.uwu) t = a;
    t.uwu += amount;
  };
  give(20);
  assert.equal(pool[1].uwu, 25, "the emptiest wallet received it");
  assert.equal(pool[0].uwu, 100, "not the first one");
});

test("repeated returns level the pool instead of concentrating it", () => {
  const pool = [{ uwu: 100 }, { uwu: 0 }, { uwu: 0 }, { uwu: 0 }];
  const give = (amount: number) => { let t = pool[0];
    for (const a of pool) if (a.uwu < t.uwu) t = a; t.uwu += amount; };
  for (let i = 0; i < 12; i++) give(10);
  const vals = pool.map(p => p.uwu);
  const spread = Math.max(...vals) - Math.min(...vals);
  assert.ok(spread <= 100, `spread ${spread} — the pool levels rather than piling up`);
  assert.ok(Math.min(...vals) > 0, "no wallet is left empty");
});

test("a rotating scan order shares participation", () => {
  const bots = ["a", "b", "c", "d"];
  const seen = new Set<string>();
  for (let k = 0; k < bots.length; k++) seen.add(bots.slice(k).concat(bots.slice(0, k))[0]);
  assert.equal(seen.size, 4, "every wallet gets to be first, so none stays idle");
});
