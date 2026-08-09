// The fixture's data, checked against the rules the PROGRAM enforces.
//
// The fixture is not decoration: it is what the arena renders whenever devnet has no round open, it
// is what design review screenshots, and `useFixtureArena` feeds it through the very same
// `deriveStandings`/`deriveHall`/`extractTerms` the chain path uses. So a fixture that describes a
// round the program could not produce is not "close enough" — it teaches the page to render a state
// that cannot happen, and it feeds impossible input to real aggregation code.
//
// These tests therefore assert PROGRAM invariants against fixture output, not fixture internals.
// Every one of them cites the rule in `programs/bulls-arena/src/lib.rs` it is enforcing.
//
// This module reads `?fighters=<n>` at import time and there is no URL under vitest, so everything
// here runs at the DEFAULT lineup. That is the point: the default is what everyone else's work is
// built on, and it is the configuration that must never regress.

import { describe, expect, it } from "vitest";
import {
  MOCK_FIGHTER_SEEDS,
  MOCK_HISTORY,
  MOCK_HIT_EVENTS,
  MOCK_HOUSE_DISCLOSURE,
  MOCK_HOUSE_WALLETS,
  MOCK_TREASURY,
  MOCK_YOU,
  mockFightersAt,
} from "./mockData.ts";
import { DEFAULT_LINEUP, MAX_LINEUP, MIN_LINEUP } from "./fixtureLineup.ts";
import { MAX_STEPS, worth } from "../contract.ts";

describe("the live fixture round", () => {
  it("fields the default lineup when no flag is present", () => {
    expect(MOCK_FIGHTER_SEEDS).toHaveLength(DEFAULT_LINEUP);
  });

  it("stays inside the program's own bounds", () => {
    // `MAX_FIGHTERS = 16`, and `run_fight` clamps to a floor of 2.
    expect(MOCK_FIGHTER_SEEDS.length).toBeGreaterThanOrEqual(MIN_LINEUP);
    expect(MOCK_FIGHTER_SEEDS.length).toBeLessThanOrEqual(MAX_LINEUP);
  });

  it("seats each wallet at most once per side, as `enter` does", () => {
    const seats = MOCK_FIGHTER_SEEDS.map((f) => `${f.wallet}/${f.side}`);
    expect(new Set(seats).size).toBe(seats.length);
  });

  it("has exactly one local player", () => {
    expect(MOCK_FIGHTER_SEEDS.filter((f) => f.isYou)).toHaveLength(1);
    expect(MOCK_FIGHTER_SEEDS.find((f) => f.isYou)?.wallet).toBe(MOCK_YOU);
  });

  it("conserves value through the whole replay — `sum(hp + banked)` never leaves the pot", () => {
    // `advance_fight` only ever moves value: `fighters[d].hp -= dmg; fighters[a].banked += dmg`.
    // Nobody extracts in the fixture, so the pre-penalty identity has to hold at EVERY cursor, not
    // just at the end. A drift here would mean the fixture is inventing or destroying money.
    const pot = MOCK_FIGHTER_SEEDS.reduce((s, f) => s + f.stake, 0n);
    for (const step of [0, 1, 17, 120, 500, 1_219, 2_508, MAX_STEPS]) {
      const total = mockFightersAt(step).reduce((s, f) => s + worth(f), 0n);
      expect(total, `at step ${step}`).toBe(pot);
    }
  });

  it("never lets a fighter's ring go negative or a corpse come back", () => {
    let deadSoFar = new Set<string>();
    for (const step of [0, 50, 200, 600, 1_200, 2_600, MAX_STEPS]) {
      const now = mockFightersAt(step);
      for (const f of now) {
        expect(f.hp, `${f.name} hp at ${step}`).toBeGreaterThanOrEqual(0n);
        expect(f.banked, `${f.name} banked at ${step}`).toBeGreaterThanOrEqual(0n);
        if (f.dead) expect(f.hp, `${f.name} dead but holding ring at ${step}`).toBe(0n);
      }
      // Death is monotonic: `advance_fight` sets `dead` and nothing clears it.
      const deadNow = new Set(now.filter((f) => f.dead).map((f) => f.wallet));
      for (const w of deadSoFar) expect(deadNow.has(w), `${w} resurrected by step ${step}`).toBe(true);
      deadSoFar = deadNow;
    }
  });

  it("emits a hit stream in non-decreasing step order, within the cursor ceiling", () => {
    let last = -1n;
    for (const ev of MOCK_HIT_EVENTS) {
      expect(ev.step).toBeGreaterThanOrEqual(last);
      expect(Number(ev.step)).toBeLessThanOrEqual(MAX_STEPS);
      expect(ev.amount).toBeGreaterThan(0n);
      expect(ev.attackerId).not.toBe(ev.defenderId);
      last = ev.step;
    }
  });

  it("only ever has fighters raid the OTHER side", () => {
    // `advance_fight` pairs across sides. A same-side hit would be the fixture showing friendly fire
    // the program cannot produce.
    for (const ev of MOCK_HIT_EVENTS) {
      const a = MOCK_FIGHTER_SEEDS[ev.attackerId];
      const d = MOCK_FIGHTER_SEEDS[ev.defenderId];
      expect(a, `attacker ${ev.attackerId}`).toBeDefined();
      expect(d, `defender ${ev.defenderId}`).toBeDefined();
      expect(a.side, `step ${ev.step}`).not.toBe(d.side);
    }
  });
});

describe("the fixture's past rounds", () => {
  it("logs sixteen settled rounds, newest first", () => {
    expect(MOCK_HISTORY).toHaveLength(16);
    for (let i = 1; i < MOCK_HISTORY.length; i++) {
      expect(MOCK_HISTORY[i].roundNo).toBeLessThan(MOCK_HISTORY[i - 1].roundNo);
    }
  });

  it("seats each wallet at most once per side — the rule `enter` enforces", () => {
    // THE REGRESSION THIS EXISTS FOR. The recurring-faces draw picks wallets with replacement, and
    // before it merged repeats it was producing rounds holding two separate seats for one wallet on
    // one side. `enter` cannot do that: a second entry from a wallet already on that side tops up the
    // row it has. Left alone it also fed `deriveStandings`/`deriveHall` the same wallet twice inside a
    // single round while computing that wallet's record.
    for (const round of MOCK_HISTORY) {
      const seats = round.players.map((p) => `${p.wallet}/${p.side}`);
      expect(new Set(seats).size, `round ${round.roundNo} has a duplicate seat`).toBe(seats.length);
    }
  });

  it("still allows one wallet to hold a seat on BOTH sides", () => {
    // Legal on chain — `enter` keys on (wallet, side), so hedging both camps is two `Fighter` rows.
    // Asserting it stays possible keeps the de-duplication above from quietly becoming "unique
    // wallets per round", which would be a different and equally wrong rule.
    const hedged = MOCK_HISTORY.some((round) => {
      const sides = new Map<string, Set<number>>();
      for (const p of round.players) {
        if (!sides.has(p.wallet)) sides.set(p.wallet, new Set());
        sides.get(p.wallet)!.add(p.side);
      }
      return [...sides.values()].some((s) => s.size > 1);
    });
    expect(hedged).toBe(true);
  });

  it("never seats more players than the program allows", () => {
    for (const round of MOCK_HISTORY) {
      expect(round.players.length, `round ${round.roundNo}`).toBeGreaterThanOrEqual(MIN_LINEUP);
      expect(round.players.length, `round ${round.roundNo}`).toBeLessThanOrEqual(MAX_LINEUP);
    }
  });

  it("keeps `fighterCount` equal to the rows it actually carries", () => {
    // `roundLog.ts` reads a chain round as `raw.fighters.slice(0, raw.fighterCount)`. If the fixture's
    // count and its row list ever disagreed, the fixture would be exercising a different slice than
    // the chain path does.
    for (const round of MOCK_HISTORY) {
      expect(round.fighterCount, `round ${round.roundNo}`).toBe(round.players.length);
    }
  });

  it("keeps the pot equal to the sum of what was deployed", () => {
    for (const round of MOCK_HISTORY) {
      const staked = round.players.reduce((s, p) => s + p.stake, 0n);
      expect(round.pot, `round ${round.roundNo}`).toBe(staked);
    }
  });

  it("reports P/L as `final - stake` on every row, and death as exactly `final === 0`", () => {
    for (const round of MOCK_HISTORY) {
      for (const p of round.players) {
        expect(p.pnl, `${p.name} in round ${round.roundNo}`).toBe(p.final - p.stake);
        expect(p.dead, `${p.name} in round ${round.roundNo}`).toBe(p.final === 0n);
        expect(p.stake).toBeGreaterThan(0n);
        expect(p.final).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it("declares the winner as the side holding the most value", () => {
    for (const round of MOCK_HISTORY) {
      let a = 0n;
      let b = 0n;
      for (const p of round.players) {
        if (p.side === 0) a += p.final;
        else b += p.final;
      }
      expect(round.winner, `round ${round.roundNo}`).toBe(a >= b ? 0 : 1);
    }
  });

  // BOTH SOURCES OF THE HOUSE'S TAKE, and the same rule for each: the fixture may not claim revenue
  // that no round in it produced. Nobody extracts in these rounds, so there is no penalty; the stakes
  // are handed to the roster directly with no `enter()` anywhere, so there is no fee and `pot` is
  // already the gross. The Dashboard sums both across history and puts the total on screen under a
  // heading a reader is invited to check against real round accounts — a non-zero figure here would
  // be an invented number in the one place the page asks to be trusted.
  it("claims no house take, because nobody extracted and nobody was charged to enter", () => {
    for (const round of MOCK_HISTORY) {
      expect(round.penaltiesCollected, `round ${round.roundNo}`).toBe(0n);
      expect(round.feesCollected, `round ${round.roundNo}`).toBe(0n);
    }
  });

  it("keeps both sides populated, so no round was won by default", () => {
    for (const round of MOCK_HISTORY) {
      expect(round.players.some((p) => p.side === 0), `round ${round.roundNo}`).toBe(true);
      expect(round.players.some((p) => p.side === 1), `round ${round.roundNo}`).toBe(true);
    }
  });
});

// THE FIXTURE'S HOUSE, and the fixture's books. Both exist so the disclosure and the treasury tile
// are reviewable with no keeper and no network — and both are held to the same rule as everything
// else here: invented is fine, unfalsifiable is fine, INCONSISTENT WITH THE REST OF THE PAGE is not.
describe("the fixture's house disclosure", () => {
  it("never marks the local player as one of ours", () => {
    // A roster that called "you" a bot would be teaching the page a state the keeper cannot produce
    // — it seats house wallets, and the local wallet is by definition not one of them.
    const you = MOCK_FIGHTER_SEEDS.find((f) => f.isYou);
    expect(you?.house).toBe(false);
  });

  it("seats a house, and leaves real players in the room", () => {
    // Both ends matter. All-house would make the disclosure trivially uniform and hide the mixed
    // roster the marks exist to distinguish; no house at all would leave the UI unreviewable.
    const house = MOCK_FIGHTER_SEEDS.filter((f) => f.house);
    expect(house.length).toBeGreaterThan(0);
    expect(house.length).toBeLessThan(MOCK_FIGHTER_SEEDS.length);
  });

  it("puts the house on both sides of the field", () => {
    // The keeper fills whichever side is short, so a fixture with every bot on one side would be a
    // lineup shape the real thing does not produce — and the one the side-strength bar renders.
    const sides = new Set(MOCK_FIGHTER_SEEDS.filter((f) => f.house).map((f) => f.side));
    expect(sides.size).toBe(2);
  });

  it("agrees with the wallet list the resolver is given", () => {
    // `useFixtureArena` counts the disclosure off a `HouseRoster` built from `MOCK_HOUSE_WALLETS`
    // while the canvas and the rosters read the marks on the lineup. Two derivations of one fact —
    // they have to be the same fact.
    const marked = MOCK_FIGHTER_SEEDS.filter((f) => f.house).map((f) => f.wallet);
    expect([...marked].sort()).toEqual([...MOCK_HOUSE_WALLETS].sort());
  });

  it("says FIXTURE first, in the sentence the page quotes", () => {
    // This string is rendered as the keeper's own disclosure. It is the one place on this path where
    // a plausible sentence could read as though a real process wrote it.
    expect(MOCK_HOUSE_DISCLOSURE.startsWith("Fixture")).toBe(true);
  });

  it("keeps the marks stable across a replay", () => {
    // `mockFightersAt` rebuilds the roster at a cursor on every clock tick; a mark that moved with
    // the fight would flicker under a reviewer.
    expect(mockFightersAt(600).map((f) => f.house)).toEqual(
      MOCK_FIGHTER_SEEDS.map((f) => f.house),
    );
  });
});

describe("the fixture's treasury", () => {
  it("is exactly the sum of the take the log records, over every round in it", () => {
    // `sweep_house_take` books one finished round's two totals onto the arena, so a treasury covering
    // the whole log is that sum and nothing else. Derived rather than written down so it cannot drift
    // from the rounds a reader can check it against.
    const fees = MOCK_HISTORY.reduce((s, r) => s + r.feesCollected, 0n);
    const penalties = MOCK_HISTORY.reduce((s, r) => s + r.penaltiesCollected, 0n);
    expect(MOCK_TREASURY.feesAccrued).toBe(fees);
    expect(MOCK_TREASURY.penaltiesAccrued).toBe(penalties);
    expect(MOCK_TREASURY.roundsSwept).toBe(BigInt(MOCK_HISTORY.length));
  });

  it("claims nothing, because no round in this fixture charged anything", () => {
    // The same rule the rounds themselves are held to, one aggregation up: a plausible-looking house
    // take here would be a fabricated figure in the one tile UI-SPEC ordered fixed for showing a
    // modelled number where a chain one belongs.
    expect(MOCK_TREASURY.feesAccrued).toBe(0n);
    expect(MOCK_TREASURY.penaltiesAccrued).toBe(0n);
  });
});
