// What the page is allowed to promise a player about leaving the fight.
//
// The unit under test is a UNIT CONVERTER AND A CURSOR PICKER — the curve itself belongs to
// `sim/erSim.ts` (which the Rust's own parity test parses), so these tests deliberately do NOT
// restate the decay formula. Restating it here would mean a wrong constant could be wrong in two
// places and agree with itself. What they do check is everything a UI can get wrong on top of a
// correct curve: quoting it at the wrong cursor, splitting money in a way that invents or destroys
// some, claiming a rate outside Fight, and promising that waiting is cheaper when it isn't.

import { describe, expect, it } from "vitest";
import { MAX_FIGHTERS, extractPenaltyBps, penaltyHorizonSteps, splitExtraction } from "../../sim/erSim.ts";
import { EXTRACT_PENALTY_START_BPS, stepsPerSecond, type FighterView, type LiveRound } from "../contract.ts";
import { extractEligibility, extractSplit, extractTerms } from "./extractTerms.ts";

const N = 9;                                    // the fixture's lineup
const HORIZON = Number(penaltyHorizonSteps(N)); // 675 steps
const RATE = stepsPerSecond(N);                 // 18 steps/s

function fighters(over: Partial<FighterView> = {}): FighterView[] {
  const base = (id: number, isYou: boolean): FighterView => ({
    id,
    wallet: `w${id}`,
    house: false,
    short: `w${id}`,
    name: `W${id}`,
    side: (id % 2) as 0 | 1,
    stake: 1_000_000n,
    hp: 1_000_000n,
    banked: 0n,
    dead: false,
    isYou,
    avatarSrc: null,
  });
  return Array.from({ length: N }, (_, i) => (i === 0 ? { ...base(0, true), ...over } : base(i, false)));
}

/** `fighters()` at an arbitrary count. `fighters()` itself is pinned to the fixture's nine, which is
 *  the right default for every test about quoting a rate and the wrong one for the sweep across
 *  lineup sizes below. */
function lineupOf(count: number): FighterView[] {
  const nine = fighters();
  return Array.from({ length: count }, (_, i) => ({
    ...nine[i % nine.length],
    id: i,
    wallet: `w${i}`,
    short: `w${i}`,
    name: `W${i}`,
    side: (i % 2) as 0 | 1,
    isYou: i === 0,
  }));
}

function liveRound(over: Partial<LiveRound> = {}): LiveRound {
  const fs = over.fighters ?? fighters();
  const stepsNow = over.stepsNow ?? 0;
  const phase = over.phase ?? "Fight";
  return {
    roundNo: 1n,
    phase,
    winner: null,
    pot: fs.reduce((s, f) => s + f.stake, 0n),
    fighters: fs,
    seedHex: "00",
    seedCommitHex: "00",
    fightStartedAtMs: 0,
    lobbyClosesAtMs: 0,
    tickCount: 0n,
    elapsedSec: stepsNow / RATE,
    stepsNow,
    resolvable: false,
    extractTerms: extractTerms({ phase, fighters: fs, stepsNow }),
    ...over,
  };
}

describe("extractSplit", () => {
  it("is the program's own split, not a second opinion", () => {
    for (const cursor of [0, 1, 137, HORIZON - 1, HORIZON, 4_000]) {
      const { kept, penalty } = splitExtraction(999_999n, N, BigInt(cursor));
      expect(extractSplit(999_999n, N, cursor)).toEqual({ keep: kept, forfeit: penalty });
    }
  });

  it("never invents or destroys value — keep + forfeit is exactly what left the ring", () => {
    for (const hp of [1n, 7n, 499_000n, 12_345_678n]) {
      for (const cursor of [0, 200, HORIZON]) {
        const { keep, forfeit } = extractSplit(hp, N, cursor);
        expect(keep + forfeit).toBe(hp);
        expect(forfeit).toBeLessThanOrEqual(hp / 5n); // the 20% opening rate is the ceiling
      }
    }
  });

  it("floors a negative or fractional cursor rather than passing it to a bigint", () => {
    expect(extractSplit(100n, N, -5)).toEqual(extractSplit(100n, N, 0));
    expect(extractSplit(100n, N, 10.9)).toEqual(extractSplit(100n, N, 10));
  });
});

describe("extractTerms", () => {
  it("quotes the opening rate at the opening bell and nothing at the horizon", () => {
    expect(extractTerms({ phase: "Fight", fighters: fighters(), stepsNow: 0 }).penaltyBps).toBe(
      Number(EXTRACT_PENALTY_START_BPS),
    );
    expect(extractTerms({ phase: "Fight", fighters: fighters(), stepsNow: HORIZON }).penaltyBps).toBe(0);
    expect(extractTerms({ phase: "Fight", fighters: fighters(), stepsNow: HORIZON + 500 }).penaltyBps).toBe(0);
  });

  it("only ever gets cheaper — the claim the panel makes to a player deciding whether to wait", () => {
    let previous = Number(EXTRACT_PENALTY_START_BPS) + 1;
    for (let cursor = 0; cursor <= HORIZON + 50; cursor += 7) {
      const { penaltyBps } = extractTerms({ phase: "Fight", fighters: fighters(), stepsNow: cursor });
      expect(penaltyBps).toBeLessThanOrEqual(previous);
      previous = penaltyBps;
    }
    expect(previous).toBe(0);
  });

  it("counts down to free in this lineup's steps AND in the seconds the fight clock shows", () => {
    const t = extractTerms({ phase: "Fight", fighters: fighters(), stepsNow: 225 });
    expect(t.freeAtStep).toBe(HORIZON);
    expect(t.stepsToFree).toBe(HORIZON - 225);
    expect(t.secondsToFree).toBeCloseTo((HORIZON - 225) / RATE, 10);

    const free = extractTerms({ phase: "Fight", fighters: fighters(), stepsNow: HORIZON + 1 });
    expect(free.stepsToFree).toBe(0);
    expect(free.secondsToFree).toBe(0);
  });

  it("scales the horizon with the lineup, strictly, all the way to the program's ceiling", () => {
    // It used to compare exactly two points, a duel against a sixteen-way, which is the whole claim
    // only while sixteen IS the ceiling. It is not — `MAX_FIGHTERS` is 48 — and a two-point check
    // sitting a third of the way up the table would have gone on passing while the entries above it
    // were never quoted at all. So this walks the range instead and asserts the property the two
    // points were standing in for: the horizon is STRICTLY increasing in the lineup, and the value
    // this converter quotes is the one `sim/erSim.ts` holds, at every size the program will field.
    let previous = 0;
    for (let n = 2; n <= MAX_FIGHTERS; n++) {
      const terms = extractTerms({ phase: "Fight", fighters: lineupOf(n), stepsNow: 0 });
      expect(terms.freeAtStep, `lineup of ${n}`).toBe(Number(penaltyHorizonSteps(n)));
      expect(terms.freeAtStep, `lineup of ${n}`).toBeGreaterThan(previous);
      previous = terms.freeAtStep;
    }
  });

  it("previews nothing outside Fight, where waiting does not move the cursor", () => {
    // A lobby second is not a fight second: the cursor sits at 0 until the bell, so "in 10s, 14.7%"
    // would be offering a discount for waiting out a phase in which nothing decays.
    expect(extractTerms({ phase: "Lobby", fighters: fighters(), stepsNow: 0 }).decay).toEqual([]);
    expect(extractTerms({ phase: "Drawing", fighters: fighters(), stepsNow: 0 }).decay).toEqual([]);
  });

  it("previews the rate ahead in seconds, at this lineup's pace", () => {
    const t = extractTerms({ phase: "Fight", fighters: fighters(), stepsNow: 90 });
    expect(t.decay.map((d) => d.inSeconds)).toEqual([10, 20, 30]);
    for (const d of t.decay) {
      expect(d.penaltyBps).toBe(Number(extractPenaltyBps(N, BigInt(90 + d.inSeconds * RATE))));
      expect(d.penaltyBps).toBeLessThan(t.penaltyBps);
    }
  });

  it("splits your own ring value, and only yours", () => {
    const fs = fighters({ hp: 500_000n });
    const t = extractTerms({ phase: "Fight", fighters: fs, stepsNow: 0 });
    expect(t.youKeep).toBe(400_000n);   // 20% of 500,000 stays with the house at the opening bell
    expect(t.youForfeit).toBe(100_000n);
  });

  it("quotes no split when there is nothing of yours to split", () => {
    const dead = extractTerms({ phase: "Fight", fighters: fighters({ dead: true, hp: 0n }), stepsNow: 10 });
    expect(dead.youKeep).toBeNull();
    expect(dead.youForfeit).toBeNull();

    const notIn = extractTerms({
      phase: "Fight",
      fighters: fighters().map((f) => ({ ...f, isYou: false })),
      stepsNow: 10,
    });
    expect(notIn.youKeep).toBeNull();
  });

  it("prices nothing outside Fight, where extract() cannot be called at all", () => {
    for (const phase of ["Lobby", "Drawing", "Settled"] as const) {
      const t = extractTerms({ phase, fighters: fighters(), stepsNow: 0 });
      expect(t.youKeep).toBeNull();
      expect(t.youForfeit).toBeNull();
      // The curve itself is still described — it is a property of the round, not of your ability to
      // act on it, and the lobby is exactly where a player wants to know what leaving early costs.
      expect(t.freeAtStep).toBe(HORIZON);
    }
  });

  it("survives an empty lobby without dividing by a zero pace", () => {
    const t = extractTerms({ phase: "Lobby", fighters: [], stepsNow: 0 });
    expect(Number.isFinite(t.secondsToFree)).toBe(true);
    expect(t.penaltyBps).toBe(Number(EXTRACT_PENALTY_START_BPS));
  });
});

describe("extractEligibility", () => {
  it("states the price alongside the verdict when the button is live", () => {
    const live = liveRound({ fighters: fighters({ hp: 500_000n }), stepsNow: 0 });
    const e = extractEligibility(live);
    expect(e.ok).toBe(true);
    expect(e.reason).toBeNull();
    expect(e.hp).toBe(500_000n);
    expect(e.keep).toBe(400_000n);
    expect(e.forfeit).toBe(100_000n);
    // The button and the panel headline must never disagree: same fighter, same cursor, same split.
    expect(e.keep).toBe(live.extractTerms.youKeep);
    expect(e.forfeit).toBe(live.extractTerms.youForfeit);
  });

  it("charges less the longer the fighter stood there", () => {
    const early = extractEligibility(liveRound({ stepsNow: 0 }));
    const late = extractEligibility(liveRound({ stepsNow: HORIZON - 1 }));
    const free = extractEligibility(liveRound({ stepsNow: HORIZON }));
    expect(early.forfeit!).toBeGreaterThan(late.forfeit!);
    expect(free.forfeit).toBe(0n);
    expect(free.keep).toBe(1_000_000n);
  });

  it("carries no price when it carries no permission", () => {
    for (const e of [
      extractEligibility(null),
      extractEligibility(null, "loading program…"),
      extractEligibility(liveRound({ phase: "Lobby" })),
      extractEligibility(liveRound({ fighters: fighters().map((f) => ({ ...f, isYou: false })) })),
      extractEligibility(liveRound({ fighters: fighters({ dead: true, hp: 0n }) })),
    ]) {
      expect(e.ok).toBe(false);
      expect(e.reason).not.toBeNull();
      expect(e.keep).toBeNull();
      expect(e.forfeit).toBeNull();
    }
  });

  it("says WHY it is unavailable, in words a reader can act on", () => {
    expect(extractEligibility(null, "no round selected").reason).toBe("no round selected");
    expect(extractEligibility(null).reason).toBe("loading round…");
    expect(extractEligibility(liveRound({ phase: "Settled" })).reason).toContain("only available during Fight");
    expect(
      extractEligibility(liveRound({ fighters: fighters({ dead: true, hp: 0n }) })).reason,
    ).toBe("your fighter is already out");
  });

  it("still reports the hp of a fighter who is already out, so the panel can show what was lost", () => {
    const e = extractEligibility(liveRound({ fighters: fighters({ dead: true, hp: 42n }) }));
    expect(e.hp).toBe(42n);
    expect(e.keep).toBeNull();
  });
});
