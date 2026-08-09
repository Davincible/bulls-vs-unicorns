// THE COPY IS LOGIC, so it is tested like logic.
//
// These assertions are deliberately about PROPERTIES rather than sentences: pinning exact wording
// would make every rewrite a test edit and would test nothing a reader could not see. What they hold
// is the contract SPEC.md's "every state answers 'what now?'" section states — that every state a
// player can land in says what is true, what they can do, and when it changes — plus the two rules
// that were actually broken:
//
//   1. No countdown to an event with no cause. A Settled round with no keeper running must say so,
//      not tick down to a lobby nobody is going to open.
//   2. No control offered that the chain would refuse. `entriesOpen()`, never `phase === "Lobby"`.
//   3. No BACKSTOP rendered as a schedule. Under the keeper's hold-open policy a lobby's on-chain
//      `lobby_closes_at` is an hour away and means nothing; the only states allowed to count it down
//      are the ones where no keeper is holding anything open. See `lobbyTiming` in the module.
//
// THE CADENCE IS AN INPUT, so all of this is still a pure function of the round and the clock: the
// keeper's file is parsed and judged in `data/keeperStatus.ts`, converted in `ui/keeperCadence.ts`,
// and arrives here already reduced to what may be SAID. Tests here therefore name a `Cadence` kind
// directly rather than building a status file — the mapping from file to kind is that module's suite.

import { describe, expect, it } from "vitest";
import { FIGHT_TIMEOUT_SECONDS, type FighterView, type LiveRound, type PhaseName } from "../contract.ts";
import { roundPhaseCopy, type RoundPhaseCopy, type RoundPhaseInput } from "./roundPhaseCopy.ts";

const NOW = 1_700_000_000_000;

function fighter(over: Partial<FighterView> = {}): FighterView {
  return {
    id: 0,
    wallet: "w0",
    short: "w0",
    name: "W0",
    side: 0,
    stake: 1_000_000n,
    hp: 1_000_000n,
    banked: 0n,
    dead: false,
    isYou: false,
    ...over,
  };
}

function round(over: Partial<LiveRound> & { phase: PhaseName }): LiveRound {
  return {
    roundNo: 17n,
    winner: null,
    pot: 0n,
    fighters: [],
    seedHex: null,
    seedCommitHex: "00",
    fightStartedAtMs: null,
    lobbyClosesAtMs: null,
    tickCount: 0n,
    elapsedSec: 0,
    stepsNow: 0,
    resolvable: false,
    extractTerms: {
      penaltyBps: 0,
      freeAtStep: 0,
      stepsToFree: 0,
      secondsToFree: 0,
      decay: [],
      youKeep: null,
      youForfeit: null,
    },
    ...over,
  };
}

function copy(over: Partial<RoundPhaseInput> = {}): RoundPhaseCopy {
  return roundPhaseCopy({
    live: null,
    nowMs: NOW,
    programError: false,
    loading: false,
    // The default is the pre-keeper page: nothing is publishing a schedule, so the chain's own
    // deadline is both the schedule and the backstop and every existing assertion below still
    // describes the page an operator gets when they open a round by hand.
    cadence: { kind: "no-keeper" },
    ...over,
  });
}

/** Every state, including the ones that only exist for an instant. If a branch is added without a
 *  row here, the "answers all three questions" sweep below stops covering it. */
const EVERY_STATE: { name: string; input: Partial<RoundPhaseInput> }[] = [
  { name: "no program", input: { programError: true } },
  { name: "loading", input: { loading: true } },
  { name: "no round", input: {} },
  {
    name: "lobby, entries open",
    input: { live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 60_000 }) },
  },
  { name: "lobby, no deadline published", input: { live: round({ phase: "Lobby" }) } },
  {
    name: "lobby, deadline passed",
    input: { live: round({ phase: "Lobby", lobbyClosesAtMs: NOW - 1 }) },
  },
  {
    // The hold-open lobby: an hour of on-chain backstop, the house already in the room, and no clock
    // running because the keeper is waiting for a person rather than for a time.
    name: "lobby, held open for players",
    input: {
      live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 3_600_000 }),
      cadence: { kind: "waiting-for-players" },
    },
  },
  {
    // Same lobby, same hour of backstop, keeper gone quiet — the state this repo is in whenever the
    // keeper is blocked, and the one where borrowing `lobby_closes_at` would print "closes in 59:47".
    name: "lobby, keeper silent",
    input: {
      live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 3_600_000 }),
      cadence: { kind: "keeper-silent" },
    },
  },
  {
    name: "settled, next lobby scheduled",
    input: { live: round({ phase: "Settled" }), cadence: { kind: "next-lobby", seconds: 9 } },
  },
  { name: "drawing", input: { live: round({ phase: "Drawing" }) } },
  { name: "fight", input: { live: round({ phase: "Fight", fighters: [fighter({ isYou: true })] }) } },
  { name: "fight, not yours", input: { live: round({ phase: "Fight", fighters: [fighter()] }) } },
  { name: "fight, settleable", input: { live: round({ phase: "Fight", resolvable: true }) } },
  { name: "settled", input: { live: round({ phase: "Settled" }) } },
  { name: "abandoned", input: { live: round({ phase: "Abandoned" }) } },
];

describe("every state answers what now", () => {
  for (const { name, input } of EVERY_STATE) {
    it(`${name}: says what is true, what to do, and when it changes`, () => {
      const c = copy(input);

      // (1) and (2): one clause each, and a sentence — not a fragment, not a label reused as prose.
      // The floor is deliberately LOW. It used to be 15 characters, which quietly made verbosity a
      // requirement: "One moment." and "Nothing to do." are the right answers for their states and
      // both would have failed it. What matters is that a clause exists and is a sentence; being
      // short is the goal, not a defect. (Max: "ELI5, as simple and short as possible".)
      for (const clause of [c.now, c.action]) {
        expect(clause.length).toBeGreaterThan(5);
        expect(clause.endsWith(".")).toBe(true);
      }
      expect(c.label.length).toBeGreaterThan(0);

      // (3): either a real number, or a stated reason there is none. Never nothing, and never a
      // countdown whose seconds are unknown.
      if (c.timing.kind === "countdown") {
        expect(Number.isFinite(c.timing.seconds)).toBe(true);
        expect(c.timing.seconds).toBeGreaterThanOrEqual(0);
        expect(c.timing.before.length).toBeGreaterThan(0);
      } else {
        expect(c.timing.text.length).toBeGreaterThan(10);
      }
    });
  }

  it("never repeats itself: no two states read the same", () => {
    // Whole rendering, not `now` alone — several states legitimately share a clause and differ only
    // in when they change (an open lobby with a deadline and one without; a fight before and after
    // the bell). What must never happen is two distinct situations a player cannot tell apart.
    const lines = EVERY_STATE.map(({ input }) => {
      const c = copy(input);
      const when = c.timing.kind === "waiting" ? c.timing.text : `${c.timing.before} … ${c.timing.after}`;
      return `${c.label} | ${c.now} ${c.action} ${when}`;
    });
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("has retired the sentence this module was written to replace", () => {
    for (const { input } of EVERY_STATE) {
      const c = copy(input);
      const all = `${c.now} ${c.action} ${c.timing.kind === "waiting" ? c.timing.text : c.timing.before}`;
      expect(all).not.toMatch(/reopen at the next lobby/i);
    }
  });
});

describe("settled", () => {
  it("does NOT count down to a lobby nobody has scheduled", () => {
    const c = copy({ live: round({ phase: "Settled" }) });
    expect(c.control).toBe("none");
    expect(c.timing.kind).toBe("waiting");
    // The honest version says WHY there is no number, and that the way back in needs nothing from
    // the player. Both halves of that are the whole point of the state.
    if (c.timing.kind !== "waiting") throw new Error("unreachable");
    expect(c.timing.text).toMatch(/no timer/i);
    expect(c.timing.text).toMatch(/when we start it/i);
  });

  it("counts down the moment a cadence exists, with no other change to the state", () => {
    // THE OPERATOR'S COMPLAINT, AS AN ASSERTION. A settled round with a keeper running behind it is
    // the one state that used to print "No timer for the next one" no matter what the keeper knew,
    // because nothing was feeding this field.
    const withKeeper = copy({
      live: round({ phase: "Settled" }),
      cadence: { kind: "next-lobby", seconds: 9 },
    });
    const without = copy({ live: round({ phase: "Settled" }) });

    expect(withKeeper.timing).toEqual({ kind: "countdown", before: "Next lobby in", seconds: 9, after: "." });
    // Everything a player reads about the round itself is identical either way — the cadence is new
    // information about the NEXT round, not a different fact about this one.
    expect(withKeeper.now).toBe(without.now);
    expect(withKeeper.action).toBe(without.action);
    expect(withKeeper.label).toBe(without.label);
  });

  it("says the honest sentence for every silence, rather than holding a countdown at zero", () => {
    // A next-lobby time that has passed, a keeper that died, a keeper wedged and retrying, a keeper
    // that was never here: `keeperCadence.ts` reduces all four to a state with no number in it, and
    // the copy's job is to have ONE true sentence for them rather than four readings a player cannot
    // act on. `seconds: 0` never reaches this module, which is why no branch here can render it.
    for (const kind of ["keeper-silent", "no-keeper"] as const) {
      const c = copy({ live: round({ phase: "Settled" }), cadence: { kind } });
      expect(c.timing).toEqual({
        kind: "waiting",
        text: "No timer for the next one — it opens when we start it.",
      });
    }
  });

  it("an abandoned round is not a settled one, and says why it never fought", () => {
    const c = copy({ live: round({ phase: "Abandoned" }) });
    expect(c.label).not.toMatch(/settled/i);
    expect(c.now).toMatch(/two players/i);
    // Same way back in, same honesty about it.
    expect(c.timing).toEqual(copy({ live: round({ phase: "Settled" }) }).timing);
  });
});

describe("lobby", () => {
  it("offers deposits from the deadline it can actually count, not from the phase", () => {
    const open = copy({ live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 60_000 }) });
    expect(open.control).toBe("deploy");
    expect(open.timing).toMatchObject({ kind: "countdown", seconds: 60 });
  });

  it("closes the controls in the window where the phase still says Lobby", () => {
    // `enter` is refused from `lobby_closes_at`; the phase only moves when an operator's
    // `close_lobby_and_draw` lands. A dock keyed on the phase offers a button the chain rejects.
    const late = copy({ live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 500 }) });
    expect(late.control).toBe("none");
    // Not "a deposit gets rejected", which was the old wording and told a reader nothing they could
    // act on. What they need is the way back in.
    expect(late.action).toMatch(/next lobby/i);
    if (late.timing.kind !== "waiting") throw new Error("expected no deadline to count");
    expect(late.timing.text).toMatch(/seed/i);
  });

  // THE QUESTION THIS STATE EXISTS TO ANSWER. Between `lobby_closes_at` and the draw, the single
  // most useful fact is whether the reader is in the round that is about to fight — one of them
  // should sit still and watch, the other has nothing to wait for and wants the next lobby.
  it("tells a player who got in apart from one who did not", () => {
    const at = { phase: "Lobby" as const, lobbyClosesAtMs: NOW + 500 };
    const mine = copy({ live: round({ ...at, fighters: [fighter({ isYou: true })] }) });
    const theirs = copy({ live: round({ ...at, fighters: [fighter()] }) });

    expect(mine.now).toMatch(/you are in/i);
    expect(mine.action).toMatch(/watch/i);
    expect(theirs.now).not.toMatch(/you are in/i);
    expect(theirs.action).toMatch(/not in this one/i);
    // Same round, same instant: only the reader's position in it differs.
    expect(mine.control).toBe(theirs.control);
    expect(mine.timing).toEqual(theirs.timing);
  });

  it("prefers the keeper's own close time over the chain's, when the keeper has named one", () => {
    // The two deadlines are an hour apart and both are on the table: the chain will accept a deposit
    // for another hour, and the keeper intends to close entries in twelve seconds because somebody
    // arrived. Twelve is the number a player needs; sixty minutes is the number that reads as a dead
    // room. Same sentence either way — the source is invisible and should be.
    const c = copy({
      live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 3_600_000 }),
      cadence: { kind: "entries-close", seconds: 12 },
    });
    expect(c.control).toBe("deploy");
    expect(c.timing).toEqual({ kind: "countdown", before: "Closes in", seconds: 12, after: "." });
  });

  it("NEVER counts an hour-away backstop down, in either state where one is sitting there", () => {
    // RULE 3, AND THE REGRESSION THE WHOLE KEEPER CHAIN EXISTS TO PREVENT. Both of these rounds carry
    // a real, live, in-the-future `lobbyClosesAtMs` that `entrySecondsLeft` would happily turn into
    // "59:47" — technically true (the chain really would take a deposit) and completely useless. The
    // only thing standing between that and a player is the cadence being consulted first.
    for (const kind of ["waiting-for-players", "keeper-silent"] as const) {
      const c = copy({
        live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 3_600_000 }),
        cadence: { kind },
      });
      expect(c.control).toBe("deploy"); // entries really are open — this is not a disabled state
      expect(c.timing.kind).toBe("waiting");
    }
  });

  it("reads as an invitation while the lobby is held open, not as a fault or a stuck timer", () => {
    // The state has to say: the room is not empty, YOU are what it is waiting for, and here is what
    // changes it. A player who reads this and does nothing has misread it.
    const c = copy({
      live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 3_600_000 }),
      cadence: { kind: "waiting-for-players" },
    });
    expect(c.label).toBe("Open");
    expect(c.now).toMatch(/house fighters/i);
    expect(c.action).toMatch(/deploy/i);
    if (c.timing.kind !== "waiting") throw new Error("a held-open lobby has no number to count");
    // NAMES THE TRIGGER, not just the absence of a clock. Every surface showing an OPEN lobby prints
    // the timing clause ALONE (`detail="timing"`), so this one sentence is the entire state as a
    // player reads it — "no countdown" by itself would read as a fault rather than as an invitation.
    expect(c.timing.text).toMatch(/starts when a real player joins/i);
    // Nothing in it may read as broken, stalled or errored — this is the healthy resting state of an
    // arena between players, and the copy is the only thing distinguishing it from a dead one.
    const all = `${c.now} ${c.action} ${c.timing.text}`;
    expect(all).not.toMatch(/\b(error|failed|offline|unavailable|stuck|broken|sorry)\b|0:00/i);
  });

  it("says so plainly when the round carries no deadline at all", () => {
    // Null is a real state, not a missing read: a round opened by a program revision without
    // `lobby_closes_at` accepts deposits for the whole of its Lobby phase.
    const c = copy({ live: round({ phase: "Lobby", lobbyClosesAtMs: null }) });
    expect(c.control).toBe("deploy");
    expect(c.timing.kind).toBe("waiting");
    if (c.timing.kind !== "waiting") throw new Error("unreachable");
    expect(c.timing.text).toMatch(/no close time/i);
  });
});

describe("drawing and fight", () => {
  it("drawing offers nothing and invents no deadline for the draw", () => {
    const c = copy({ live: round({ phase: "Drawing" }) });
    expect(c.control).toBe("none");
    expect(c.action).toMatch(/nothing/i);
    expect(c.timing.kind).toBe("waiting");
  });

  it("fight counts the bell down from the round's own elapsed clock", () => {
    const c = copy({ live: round({ phase: "Fight", elapsedSec: 12.4 }) });
    expect(c.control).toBe("extract");
    expect(c.timing).toMatchObject({ kind: "countdown", seconds: Math.ceil(FIGHT_TIMEOUT_SECONDS - 12.4) });
  });

  it("fight names extract — but only to a player who has a fighter in it", () => {
    const yours = copy({ live: round({ phase: "Fight", fighters: [fighter({ isYou: true })] }) });
    expect(yours.action).toMatch(/extract/i);

    const theirs = copy({ live: round({ phase: "Fight", fighters: [fighter()] }) });
    expect(theirs.action).toMatch(/not in this one/i);
    expect(theirs.control).toBe("extract"); // the button still shows, disabled, with its own reason
  });

  it("stops counting once the round is settleable, because the deadline is then a transaction", () => {
    const c = copy({ live: round({ phase: "Fight", elapsedSec: FIGHT_TIMEOUT_SECONDS, resolvable: true }) });
    expect(c.timing.kind).toBe("waiting");
    if (c.timing.kind !== "waiting") throw new Error("unreachable");
    expect(c.timing.text).toMatch(/any second/i);
  });
});

describe("the chain being unreachable outranks the phase", () => {
  it("offers no control even in an open lobby", () => {
    const c = copy({
      live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 60_000 }),
      programError: true,
    });
    expect(c.control).toBe("none");
    expect(c.now).toMatch(/can't reach/i);
  });
});
