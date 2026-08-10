// THE CLAIM THIS FILE EXISTS TO STOP BEING AN UNCHECKED ONE.
//
// `sim/erSim.ts`'s own header says it is "a verbatim copy of engine/src/er-sim.ts, kept in sync by
// hand". Until this file, nothing anywhere checked that. The chain of parity tests that covers this
// repo ran Rust <-> engine (`programs/bulls-arena/gen-parity-fixture.mjs` into
// `parity_tests::run_fight_matches_the_typescript_mirror_exactly`) and er-demo <-> the fixture
// (`hitEvents.test.ts`) — two links that happen to meet at a single 4-fighter, 50-step lineup. One
// checked-in fixture is a spot check, not a proof of sameness: any divergence the two copies had on
// a lineup size, a side layout, or a stake ratio that fixture never visits would sail through both.
//
// "Kept in sync by hand" is the entire risk. Two files, one algorithm, edited by different people at
// different times — that is exactly the shape of the DUST-floor bug erSim.ts's own comments describe
// (two copies of the same logic, one of them stale), and it is exactly what the damage-basis and
// draw-pair fixes had to be applied to twice, in lockstep, to avoid re-creating.
//
// So this sweeps: 282 lineups across the whole legal space (2..48 fighters, three distinct side
// layouts, stakes spanning four orders of magnitude including sub-DUST, top-up entries, varying fee
// rates, a few hundred steps each) and asserts the two modules agree on every field of every
// fighter, on the round-level counters, and on who won. It imports the engine module by relative
// path — this is a test, not app code, so the "er-demo does not cross-import from engine/" boundary
// that justifies the copy in the first place is not what is being crossed here.
//
// DETERMINISTIC, NOT RANDOM. Lineups come from a fixed-seed integer PRNG, so a failure reproduces
// exactly and CI never flakes. Widen the sweep by changing LINEUP_COUNT or GENERATOR_SEED, never by
// reaching for Math.random().
import { describe, expect, test } from "vitest";
import * as demo from "./erSim.ts";
import * as engine from "../../../engine/src/er-sim.ts";

/** xorshift32. Integer-only on purpose: this file sits next to fight-path code where a float is a
 *  correctness bug, and a generator that quietly returns one invites the wrong thing to be copied
 *  out of here later. Returns a full 32-bit unsigned word; callers take it modulo a range. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

const GENERATOR_SEED = 0x5eed_1e55;

/** 282 = 6 x 47 x ... — precisely, 6 x (MAX_FIGHTERS - 1), which is also divisible by the 3 side
 *  layouts, so every (lineup size, layout) PAIR is generated exactly twice.
 *
 *  IT IS A MULTIPLE RATHER THAN A ROUND NUMBER because the size sweep below is now cyclic, and a
 *  count that did not divide evenly would field some sizes more often than others for no reason. It
 *  was 200, drawn randomly, back when there were 15 sizes to cover — and raising the cap to 48 is
 *  what made that untenable rather than merely loose: covering 47 sizes by uniform random draw is a
 *  coupon-collector problem needing ~47 x H(47) ~= 209 draws ON AVERAGE, so a 200-lineup random sweep
 *  would have failed its own coverage assertion about as often as it passed. The fix is to stop
 *  drawing and start cycling; see `count` in `generateLineups`. */
const LINEUP_COUNT = 282;

interface Entry {
  wallet: string;
  side: 0 | 1;
  /** GROSS — what the player sent. Both mirrors run it through their own `enter()`, so the net
   *  `stake` each fighter ends up with is a computed result being compared, not a shared input. */
  stake: bigint;
}

interface Lineup {
  seed: Buffer;
  entries: Entry[];
  feeBps: bigint;
  steps: number;
  /** Wallet to pull out mid-fight, or null. Both mirrors extract the same wallet at the same cursor. */
  extractWallet: string | null;
  extractAfter: number;
}

/** Three layouts, cycled rather than randomised, because WHICH ONE is the point.
 *
 *  The draw-pair bias this whole change fixed was a bias on ENTRY ORDER — it favoured slot `a + 1`,
 *  so its size depended entirely on how the two sides were laid out across the fighter array. A
 *  generator that only ever produced one layout would be blind to precisely the class of bug the two
 *  files were just edited to remove. */
function sideFor(layout: number, index: number, count: number): 0 | 1 {
  if (layout === 0) return index < count / 2 ? 0 : 1;   // blocked: each side arrives together
  if (layout === 1) return (index % 2) as 0 | 1;        // interleaved: entries alternate
  return (index === 0 ? 0 : index === count - 1 ? 1 : ((index * 7) % 3 === 0 ? 0 : 1));  // lopsided
}

/** Stakes spanning four orders of magnitude, including values at and below `DUST`.
 *
 *  Both edited branches key on magnitude — `basis = min(A.hp, D.hp)` only differs from the old rule
 *  when the two rings are unequal, and the `dmg === 0n` / `D.hp <= DUST` split only separates on a
 *  ring small enough for `hp * roll / 100` to floor to zero. Equal, comfortable stakes would exercise
 *  neither. */
function stakeFor(rng: () => number): bigint {
  const magnitude = rng() % 4;
  const span = [1_000, 20_000, 500_000, 10_000_000][magnitude];
  return BigInt(1 + (rng() % span));
}

function generateLineups(): Lineup[] {
  const rng = makeRng(GENERATOR_SEED);
  const lineups: Lineup[] = [];

  for (let i = 0; i < LINEUP_COUNT; i++) {
    const seed = Buffer.alloc(32);
    for (let b = 0; b < 32; b += 4) seed.writeUInt32LE(rng(), b);

    // CYCLED, NOT DRAWN — for exactly the reason `sideFor`'s layouts are cycled: WHICH SIZE is the
    // point, so leaving it to the dice makes coverage a thing to hope for and then assert, rather
    // than a thing the generator cannot fail to do. At 15 sizes a random draw covered them all
    // comfortably; at 47 it does not (see LINEUP_COUNT). Cycling also pairs every size with every
    // layout, which a random size never guaranteed even when it did hit all fifteen.
    const count = 2 + (i % (demo.MAX_FIGHTERS - 1));   // 2..48 distinct fighters
    const layout = i % 3;
    const entries: Entry[] = [];
    for (let f = 0; f < count; f++) {
      entries.push({ wallet: `w${f}`, side: sideFor(layout, f, count), stake: stakeFor(rng) });
    }
    // Top-ups: a repeat entry on the same (wallet, side) must ADD rather than seat a second fighter.
    // Appended after the distinct set so the fighter count stays <= MAX_FIGHTERS by construction.
    const topUps = rng() % 3;
    for (let t = 0; t < topUps; t++) {
      const target = entries[rng() % count];
      entries.push({ wallet: target.wallet, side: target.side, stake: stakeFor(rng) });
    }

    // Fee rates including zero (the pre-fee program revision) and a deliberately coarse one, so the
    // `stake * feeBps / BPS` floor division is compared on values where it actually truncates.
    const feeBps = [0n, 20n, 137n, 1_000n][rng() % 4];
    const steps = 200 + (rng() % 400);
    // Extraction on a third of the lineups. It is the one path where the two copies could most
    // plausibly drift without a fixture noticing, and it moves value in a direction `tick()` cannot.
    const extracts = rng() % 3 === 0;
    const extractAfter = rng() % steps;

    lineups.push({
      seed, entries, feeBps, steps,
      extractWallet: extracts ? `w${rng() % count}` : null,
      extractAfter,
    });
  }
  return lineups;
}

/** Everything both modules must agree on, flattened so a failure prints the two rounds side by side
 *  rather than a boolean. `stake` is included because `enter()` computes it (gross minus fee), so it
 *  is a result of the replay and not merely an echo of the input. */
function snapshot(round: demo.ERRound | engine.ERRound, winner: 0 | 1) {
  return {
    winner,
    tickCount: round.tickCount,
    pot: round.pot,
    penaltiesCollected: round.penaltiesCollected,
    feesCollected: round.feesCollected,
    fighters: round.fighters.map((f) => ({
      wallet: f.wallet, side: f.side, dead: f.dead, stake: f.stake, hp: f.hp, banked: f.banked,
    })),
  };
}

/** Drives one module through a whole lineup. Written once against the shared surface both modules
 *  export, so neither can be run through a subtly different call sequence than the other — a parity
 *  test with two bespoke drivers proves less than it appears to. */
function play(mod: typeof demo | typeof engine, lineup: Lineup) {
  const round = mod.newRound(lineup.seed);
  for (const e of lineup.entries) mod.enter(round, e.wallet, e.side, e.stake, lineup.feeBps);

  if (lineup.extractWallet === null) {
    mod.tick(round, lineup.steps);
  } else {
    mod.tick(round, lineup.extractAfter);
    // Only if there is still something to pull out: `extract()` throws on a fighter already dead or
    // at zero hp, and both mirrors must reach that state on the same lineups — which is itself part
    // of what is being compared, since the guard reads `dead`/`hp`.
    const live = round.fighters.some((f) => f.wallet === lineup.extractWallet && f.dead === 0 && f.hp > 0n);
    if (live) mod.extract(round, lineup.extractWallet);
    mod.tick(round, lineup.steps - lineup.extractAfter);
  }

  return snapshot(round, mod.settle(round));
}

describe("er-demo/src/sim/erSim.ts is the same program as engine/src/er-sim.ts", () => {
  const lineups = generateLineups();

  test(`${LINEUP_COUNT} generated lineups settle identically in both mirrors`, () => {
    for (const lineup of lineups) {
      const fromDemo = play(demo, lineup);
      const fromEngine = play(engine, lineup);
      // One assertion over the whole snapshot rather than a loop of field comparisons: on a failure
      // Vitest prints the full diff of both rounds, which is what a divergence investigation needs.
      expect({ seed: lineup.seed.toString("hex"), ...fromDemo })
        .toEqual({ seed: lineup.seed.toString("hex"), ...fromEngine });
    }
  });

  // NON-VACUITY. Every assertion above passes trivially if the generator produces nothing
  // interesting, and a parity sweep that quietly stopped covering the space would be worse than no
  // sweep — it would read as evidence. These pin what the generator actually reached.
  test("the generated lineups actually cover the space the two mirrors have to agree on", () => {
    const counts = new Set<number>();
    let sawExtraction = false, sawSubDustStake = false, sawDeath = false, sawZeroFee = false;

    for (const lineup of lineups) {
      const result = play(demo, lineup);
      counts.add(result.fighters.length);
      if (result.penaltiesCollected > 0n) sawExtraction = true;
      if (result.fighters.some((f) => f.stake <= demo.DUST)) sawSubDustStake = true;
      if (result.fighters.some((f) => f.dead === 1)) sawDeath = true;
      if (lineup.feeBps === 0n) sawZeroFee = true;
    }

    expect(Math.min(...counts)).toBe(2);
    expect(Math.max(...counts)).toBe(demo.MAX_FIGHTERS);
    // Every lineup size 2..48 was generated. Guaranteed by the cyclic `count` rather than hoped for,
    // which makes this assertion a check on the GENERATOR still being cyclic — not on the dice.
    expect(counts.size).toBe(demo.MAX_FIGHTERS - 1);
    expect(sawExtraction).toBe(true);
    expect(sawSubDustStake).toBe(true);
    expect(sawDeath).toBe(true);
    expect(sawZeroFee).toBe(true);
  });

  // THE CONSTANTS, COMPARED DIRECTLY. The sweep above would catch a divergent penalty curve only on
  // a lineup that extracted at a cursor where the two curves disagree; comparing the tables outright
  // costs one assertion and cannot miss.
  test("the tuned constants are the same numbers in both mirrors", () => {
    expect(demo.DUST).toBe(engine.DUST);
    expect(demo.BPS).toBe(engine.BPS);
    expect(demo.MAX_FIGHTERS).toBe(engine.MAX_FIGHTERS);
    expect(demo.EXTRACT_PENALTY_START_BPS).toBe(engine.EXTRACT_PENALTY_START_BPS);
    expect([...demo.PENALTY_HORIZON_STEPS]).toEqual([...engine.PENALTY_HORIZON_STEPS]);
  });
});
