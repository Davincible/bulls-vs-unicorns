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
import { FIGHT_TIMEOUT_SECONDS, clock, type FighterView, type LiveRound, type PhaseName } from "../contract.ts";
import type { PlayBlock } from "../data/playGate.ts";
import {
  NO_CLOCK,
  asSentence,
  roundPhaseCopy,
  timingText,
  type RoundPhaseCopy,
  type RoundPhaseInput,
} from "./roundPhaseCopy.ts";

const NOW = 1_700_000_000_000;

function fighter(over: Partial<FighterView> = {}): FighterView {
  return {
    id: 0,
    wallet: "w0",
    house: false,
    short: "w0",
    name: "W0",
    side: 0,
    stake: 1_000_000n,
    hp: 1_000_000n,
    banked: 0n,
    dead: false,
    isYou: false,
    avatarSrc: null,
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

// -------------------------------------------------------------------------------------------
// THE PLAYER'S OWN GATE — `data/playGate.ts`, layered over the round's state.
//
// The contract these hold is the one that is easy to get subtly wrong: the gate takes the CONTROL
// away, because offering a button this reader cannot use is the bug SPEC.md names — but it must not
// take the ROUND away with it. A lobby closing in fourteen seconds is closing in fourteen seconds
// whether or not a wallet is connected, and that number is exactly what tells someone whether it is
// worth connecting right now. So `now` and `timing` survive verbatim and only `action` changes.
//
// The other half is that it stays QUIET when it is not the thing in the way. A settled round offers
// nothing to anybody; a wallet nag there is noise, and `blocked` staying null is what stops the dock
// putting a Connect button under a round nobody could have entered.

const NO_WALLET: PlayBlock = {
  code: "not-connected",
  short: "no wallet is connected",
  detail: "Connect your Phantom wallet to deploy into a round.",
  cta: { kind: "connect", label: "Connect Phantom" },
};

/** A block with no control to press — `no-program` and `connecting` are both of this shape. */
const WAITING: PlayBlock = {
  code: "connecting",
  short: "waiting for you to approve the connection in Phantom",
  detail: "Approve it in the extension popup.",
  cta: null,
};

const OPEN_LOBBY: Partial<RoundPhaseInput> = {
  live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 60_000 }),
};

describe("a player who cannot act", () => {
  it("reports `blocked: null` in every ungated state, so no surface mistakes a quiet round for a funnel", () => {
    for (const state of EVERY_STATE) {
      expect(copy(state.input).blocked, state.name).toBeNull();
    }
  });

  it("withdraws the deploy control and names what would restore it", () => {
    const c = copy({ ...OPEN_LOBBY, gate: NO_WALLET });
    expect(c.control).toBe("none");
    expect(c.blocked).toBe("deploy");
    expect(c.action).toMatch(/no wallet is connected/i);
    // The route out, not just the diagnosis — the second half of SPEC.md's rule.
    expect(c.action).toMatch(/connect wallet/i);
  });

  it("keeps the round's own facts, because they are still true and still decide whether to bother", () => {
    const gated = copy({ ...OPEN_LOBBY, gate: NO_WALLET });
    const ungated = copy(OPEN_LOBBY);
    expect(gated.now).toBe(ungated.now);
    expect(gated.timing).toEqual(ungated.timing);
    // The countdown specifically: this is the one a blocked reader is racing.
    expect(gated.timing.kind).toBe("countdown");
  });

  it("withdraws the extract control mid-fight and says so", () => {
    const c = copy({ live: round({ phase: "Fight", elapsedSec: 10 }), gate: NO_WALLET });
    expect(c.control).toBe("none");
    expect(c.blocked).toBe("extract");
  });

  it("takes over the label with a handle-sized word, not the button's sentence", () => {
    const c = copy({ ...OPEN_LOBBY, gate: NO_WALLET });
    expect(c.label).toBe("Connect");
    // `cta.label` is button copy and overflows the dock's one-line handle — the two must not be the
    // same string by accident.
    expect(c.label).not.toBe(NO_WALLET.cta?.label);
  });

  it("keeps the round's label when the block has nothing to press", () => {
    const c = copy({ ...OPEN_LOBBY, gate: WAITING });
    expect(c.control).toBe("none");
    expect(c.label).toBe(copy(OPEN_LOBBY).label);
    expect(c.action).toMatch(/waiting for you to approve/i);
  });

  it("says nothing at all when the round was offering nothing anyway", () => {
    const settled: Partial<RoundPhaseInput> = { live: round({ phase: "Settled" }) };
    const gated = copy({ ...settled, gate: NO_WALLET });
    expect(gated).toEqual(copy(settled));
    expect(gated.blocked).toBeNull();
  });

  it("still answers all three questions in a gated state", () => {
    const c = copy({ ...OPEN_LOBBY, gate: NO_WALLET });
    expect(c.now.length).toBeGreaterThan(0);
    expect(c.action.length).toBeGreaterThan(0);
    expect(c.timing.kind === "waiting" ? c.timing.text : c.timing.before).toBeTruthy();
  });

  /**
   * A GATE MUST NOT EVICT A CONTROL MID-SEND.
   *
   * The gate can close while a transaction this player started is still submitting — Phantom
   * disconnects, or the balance poll lands at zero once the fee is spent. Taking the control away at
   * that instant unmounts the body that is reporting the send, so the reader loses every trace of
   * their transaction at exactly the moment they are watching for it. The buttons inside are already
   * disabled by `entering`/`extracting`, so holding the body is a receipt, never a second offer.
   */
  it("keeps the control while the player's own transaction is still in flight", () => {
    const sending = copy({ ...OPEN_LOBBY, gate: NO_WALLET, inFlight: true });
    expect(sending.control).toBe("deploy");
    expect(sending.blocked).toBeNull();
    // And it is genuinely the ungated round's words — nothing half-swapped.
    expect(sending).toEqual(copy(OPEN_LOBBY));
  });

  it("hands the funnel back the moment the send resolves", () => {
    const settled = copy({ ...OPEN_LOBBY, gate: NO_WALLET, inFlight: false });
    expect(settled.control).toBe("none");
    expect(settled.blocked).toBe("deploy");
  });

  it("treats an absent inFlight exactly as false, so no existing caller changes behaviour", () => {
    expect(copy({ ...OPEN_LOBBY, gate: NO_WALLET })).toEqual(
      copy({ ...OPEN_LOBBY, gate: NO_WALLET, inFlight: false }),
    );
  });
});

// -------------------------------------------------------------------------------------------
// THE COMPACT CLOCK SLOT — `ClockSlot`, and the `0:00` that reached production.
//
// The top bar, 00-1's hero and the overlay on the field each rendered `clock(live.elapsedSec)`
// directly. That is the FIGHT clock, and outside a fight it is zero — so a lobby the keeper was
// deliberately holding open until a real person arrived printed `0:00` in three places at once, over
// a round where nothing whatsoever was up. These hold the two halves of the fix: a slot with no clock
// running never renders anything clock-SHAPED, and a slot with one genuinely running still does.

describe("the compact clock slot", () => {
  it("never renders a clock-shaped string in a state that has no clock", () => {
    // THE REGRESSION ITSELF, as a sweep. `0:00` is the specific string that shipped, but the rule is
    // the general one: a state word must not be able to be read as a stopped timer.
    for (const { name, input } of EVERY_STATE) {
      const c = copy(input);
      if (c.clockSlot.kind !== "state") continue;
      expect(c.clockSlot.word, name).not.toMatch(/^\d+:\d\d$/);
      expect(c.clockSlot.word.length, name).toBeGreaterThan(0);
    }
  });

  it("carries the round's own sentence as its title rather than a paraphrase of it", () => {
    // A slot this size can hold a word and not a reason, so the reason has to be reachable from it —
    // and it has to be THE reason, the one the note under the Deploy button is printing at the same
    // instant. Containment against `timingText` is what makes a second set of words impossible.
    for (const { name, input } of EVERY_STATE) {
      const c = copy(input);
      expect(c.clockSlot.title, name).toContain(timingText(c.timing));
      expect(c.clockSlot.title.endsWith("."), name).toBe(true);
    }
  });

  it("says OPEN over a held-open lobby, where it used to say 0:00", () => {
    const c = copy({
      live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 3_600_000 }),
      cadence: { kind: "waiting-for-players" },
    });
    expect(c.clockSlot.kind).toBe("state");
    if (c.clockSlot.kind !== "state") throw new Error("unreachable");
    expect(c.clockSlot.word).toBe("OPEN");
    // One word for one state: the plate on the field and the dock's handle both print `label`, and a
    // slot naming the same state differently would be two readings of one round.
    expect(c.clockSlot.word).toBe(c.label.toUpperCase());
    // And the sentence behind the word is the one that names the trigger.
    expect(c.clockSlot.title).toMatch(/starts when a real player joins/i);
  });

  it("shows a real countdown the moment one genuinely applies", () => {
    // A real player has arrived, the keeper has committed to a time, and this is the number that
    // matters. The point of the fix is not to delete countdowns — it is to delete the fake one.
    const c = copy({
      live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 3_600_000 }),
      cadence: { kind: "entries-close", seconds: 12 },
    });
    expect(c.clockSlot).toMatchObject({ kind: "clock", seconds: 12 });
  });

  it("counts the chain's own deadline where nobody is holding anything open", () => {
    // The pre-keeper page, the `?fixture=1` page and an operator's hand-opened round: there the
    // backstop IS the schedule, and refusing to count it would delete a correct countdown.
    const c = copy({ live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 60_000 }) });
    expect(c.clockSlot).toMatchObject({ kind: "clock", seconds: 60 });
  });

  it("NEVER counts the hour-away backstop, in either state where one is sitting there", () => {
    // The slot is small enough that `59:47` would fit in it perfectly, which is exactly why it has to
    // be forbidden here as well as in the sentence — a rule enforced in one surface of three is not a
    // rule. Mirrors the sentence's own assertion further up this file.
    for (const kind of ["waiting-for-players", "keeper-silent"] as const) {
      const c = copy({
        live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 3_600_000 }),
        cadence: { kind },
      });
      expect(c.clockSlot.kind, kind).toBe("state");
    }
  });

  it("shows no clock in the window where the phase still says Lobby but entries are shut", () => {
    const c = copy({ live: round({ phase: "Lobby", lobbyClosesAtMs: NOW + 500 }) });
    expect(c.clockSlot.kind).toBe("state");
  });

  it("counts the fight's bell DOWN, on the same number the sentence beside it is counting", () => {
    // IT USED TO COUNT UP, and that was the complaint: "the counter is currently counting up in the
    // round… we need a counter that counts down how much time is still remaining." A clock is read as
    // an answer to "how much longer", and the largest figure on the page was answering "how long so
    // far". The elapsed figure is not lost — 00-1's own tile carries it now (`views/ArenaView.tsx`) —
    // but it is not what a clock is for.
    const c = copy({ live: round({ phase: "Fight", elapsedSec: 12.4 }) });
    expect(c.clockSlot).toMatchObject({
      kind: "clock",
      seconds: Math.ceil(FIGHT_TIMEOUT_SECONDS - 12.4),
    });
    // ONE NUMBER, NOT TWO THAT AGREE. The slot takes the sentence's own seconds rather than
    // subtracting `elapsedSec` from the timeout a second time, which is the whole reason the two
    // cannot drift.
    expect(c.timing).toMatchObject({
      kind: "countdown",
      seconds: Math.ceil(FIGHT_TIMEOUT_SECONDS - 12.4),
    });
    if (c.clockSlot.kind !== "clock" || c.timing.kind !== "countdown") throw new Error("unreachable");
    expect(c.clockSlot.seconds).toBe(c.timing.seconds);
  });

  it("stops being a figure the instant the round is settleable, rather than counting to 0:00", () => {
    // THE HONESTY PROBLEM A COUNTDOWN CREATES, and the place it is answered. Only about three
    // quarters of fights at the 48-fighter cap reach the bell; the rest end early, when one side is
    // wiped out. `resolvable` is true from that instant — and from the bell — so the two readings a
    // countdown could otherwise produce are both unreachable: a figure counting 1:12 down over a
    // fight that is already decided, and a figure parked at `0:00` after the bell while nobody has
    // sent `resolve()`. Both would be the original `0:00` incident with a new cause.
    for (const elapsedSec of [30, FIGHT_TIMEOUT_SECONDS]) {
      const c = copy({ live: round({ phase: "Fight", elapsedSec, resolvable: true }) });
      expect(c.clockSlot.kind, `at ${elapsedSec}s`).toBe("state");
      if (c.clockSlot.kind !== "state") throw new Error("unreachable");
      expect(c.clockSlot.word).toBe("ENDING");
      // NOT "OVER". Extract is still live in this state and is racing exactly this moment; a word
      // that read as finished would talk a player out of the one move still on the table.
      expect(c.clockSlot.title).toMatch(/any second/i);
    }
  });

  it("never hands a zero to a countdown, even where the phase has run past its own deadline", () => {
    // `isResolvable` also requires two fighters (lib.rs's own guard, mirrored in `data/fightPace.ts`),
    // so a Fight phase holding fewer would count past the bell into seconds `Math.max` floors at
    // exactly the string this whole type exists to prevent. Constructed directly, because the round
    // this describes is one the program should never produce — which is why nothing else would catch
    // it.
    const c = copy({
      live: round({ phase: "Fight", elapsedSec: FIGHT_TIMEOUT_SECONDS + 40, resolvable: false }),
    });
    expect(c.clockSlot.kind).toBe("state");
  });

  it("keeps the length a settled round ran, and refuses one for a round that never fought", () => {
    // Both have `elapsedSec` on them and only one of them means anything. An abandoned lobby never
    // started, so its zero is the absence of a fight rather than a fight of no length.
    expect(copy({ live: round({ phase: "Settled", elapsedSec: 44 }) }).clockSlot).toMatchObject({
      kind: "clock",
      seconds: 44,
    });
    expect(copy({ live: round({ phase: "Abandoned" }) }).clockSlot.kind).toBe("state");
  });

  it("cannot produce the string 0:00 from any phase, at any deadline, at any cursor", () => {
    // THE INCIDENT AS AN INVARIANT RATHER THAN AS A LIST OF CASES. Every test above pins one state;
    // this one asserts the rule those states are instances of, over every phase crossed with every
    // second that has ever produced the string — a deadline that has just passed, one that is about
    // to, a fight past its own bell, and a settled round whose cursor floors to nothing.
    //
    // It is a sweep because the branches are not the risk. `clock()` FLOORS, so the numbers that
    // render as `0:00` are a half-open interval and not a value, and a guard written against the
    // obvious one (`seconds > 0`) passes every hand-picked case here while shipping `0.4`. What makes
    // this hold is that `clockSlotFor` asks the formatter what it is about to draw.
    const deadlines = [-5, -0.4, 0, 0.4, 0.9, 1];
    for (const phase of ["Lobby", "Fight", "Settled", "Drawing", "Abandoned"] as const) {
      for (const seconds of deadlines) {
        for (const resolvable of [false, true]) {
          const c = copy({
            live: round({
              phase,
              resolvable,
              elapsedSec: phase === "Fight" ? FIGHT_TIMEOUT_SECONDS - seconds : seconds,
              lobbyClosesAtMs: NOW + seconds * 1000,
            }),
          });
          const where = `${phase} @ ${seconds}s${resolvable ? " settleable" : ""}`;
          if (c.clockSlot.kind === "clock") {
            expect(clock(c.clockSlot.seconds), where).not.toBe("0:00");
          } else {
            expect(c.clockSlot.word, where).not.toMatch(/^\d+:\d\d$/);
          }
        }
      }
    }
  });

  it("refuses a length for a round that settled without advancing a single step", () => {
    // REACHABLE, NOT HYPOTHETICAL. `resolve()` only asks that the fight be over, and `extract()` sets
    // `dead = 1` — so the last fighter on a side leaving at step 0 empties it and the round settles
    // with `tick_count` at zero. `elapsedSec` is derived from that cursor, so the slot would have
    // printed `0:00`: a stopped clock, in five places at once, over a finished round. The same
    // incident this whole type exists for, arriving through the one phase where a static figure is
    // legitimate.
    const c = copy({ live: round({ phase: "Settled", elapsedSec: 0 }) });
    expect(c.clockSlot.kind).toBe("state");
    if (c.clockSlot.kind !== "state") throw new Error("unreachable");
    expect(c.clockSlot.word).toBe(NO_CLOCK);
  });

  it("shows nothing clock-shaped while the seed is being drawn, or with no round at all", () => {
    for (const input of [
      { live: round({ phase: "Drawing" }) },
      {},
      { loading: true },
      { programError: true },
    ] as Partial<RoundPhaseInput>[]) {
      expect(copy(input).clockSlot.kind).toBe("state");
    }
  });

  it("cannot disagree with the sentence beside it about whether a round has a number", () => {
    // The two are one decision, taken once. If they were derived separately, the state that would
    // break first is precisely the one this whole module keeps re-litigating: a slot counting the
    // backstop down beside a sentence refusing to.
    //
    // FIGHT IS IN THIS SWEEP NOW, AND THAT IS THE CHANGE. It used to be Lobby-only, because the
    // fight's slot counted `elapsedSec` up while its sentence counted the bell down — two facts, by
    // design. Now that the slot counts the bell down too, "one number" is a rule the fight has to
    // keep as well, and the bell is the number on this page with the most surfaces stating it.
    //
    // SETTLED IS EXCLUDED, DELIBERATELY. Its sentence counts down to the NEXT LOBBY while its slot
    // holds the length THIS fight ran — genuinely two facts about two different rounds, and the one
    // place where making them agree would be the error.
    for (const { name, input } of EVERY_STATE) {
      if (input.live?.phase !== "Lobby" && input.live?.phase !== "Fight") continue;
      const c = copy(input);
      if (c.timing.kind === "countdown") {
        expect(c.clockSlot, name).toMatchObject({ kind: "clock", seconds: c.timing.seconds });
      } else {
        expect(c.clockSlot.kind, name).toBe("state");
      }
    }
  });

  it("names its own figure in every state, in words no surface has to write for itself", () => {
    // WHY A CAPTION EXISTS AT ALL. While the fight clock counted up, a bare figure under the word
    // FIGHT was self-describing. A figure that counts DOWN names an instant instead, and a reader is
    // owed which one — so the label travels with the decision rather than being written out at each
    // of the four surfaces that draw it. `title` is the whole sentence; this is the version a hero
    // column or an overlay line has room to print.
    const seen = new Set<string>();
    for (const { name, input } of EVERY_STATE) {
      const { caption } = copy(input).clockSlot;
      expect(caption.length, name).toBeGreaterThan(0);
      // A LABEL, NOT A SECOND READING. Anything clock-shaped in here would put two figures in a slot
      // built to hold one, and the page has already shipped that bug once.
      expect(caption, name).not.toMatch(/\d+:\d\d/);
      // Sentence case, no full stop: it is set in `.u` (10px uppercase, tracked), where a trailing
      // period is a stray mark rather than punctuation.
      expect(caption.endsWith("."), name).toBe(false);
      seen.add(caption);
    }
    // NON-VACUITY. One caption reused for every state would pass every assertion above and label
    // nothing — the states this page most needs told apart (a held-open lobby, a running bell, a
    // settleable fight) are exactly the ones a constant would flatten.
    expect(seen.size).toBeGreaterThan(3);
  });

  it("labels the bell as a ceiling rather than as a forecast", () => {
    // THE ONE CAPTION WHOSE WORDING IS LOAD-BEARING. Roughly a quarter of fights at the 48-fighter
    // cap reach the bell and the rest end early, so a descending figure labelled "time left" would be
    // a promise this page has a 24% chance of keeping. "At most" is the disclosure, in two words, at
    // the size a hero column has for it — and the full "or sooner if a side is wiped out" is one hover
    // away in `title`, which is the same sentence `RoundPhaseNote` is printing at that instant.
    const c = copy({ live: round({ phase: "Fight", elapsedSec: 12.4 }) });
    expect(c.clockSlot.caption).toMatch(/at most/i);
    expect(c.clockSlot.title).toMatch(/or sooner/i);
  });

  it("survives the player's gate untouched, exactly as the countdown does", () => {
    // A wallet a reader does not have changes nothing about what the round's clock is doing, and the
    // slot is on all five screens — including the four a blocked reader is most likely to be on.
    expect(copy({ ...OPEN_LOBBY, gate: NO_WALLET }).clockSlot).toEqual(copy(OPEN_LOBBY).clockSlot);
  });
});

describe("timingText", () => {
  it("flattens a countdown into the one string a title attribute can hold", () => {
    // `RoundPhaseNote` splits this around its figure so the number can be marked up as one; a tooltip
    // has no elements to split into, and the alternative was a second, shorter set of words.
    expect(timingText({ kind: "countdown", before: "Closes in", seconds: 12, after: "." })).toBe(
      "Closes in 0:12.",
    );
  });

  it("passes a waiting sentence through unchanged, because it already is one", () => {
    const text = "No timer for the next one — it opens when we start it.";
    expect(timingText({ kind: "waiting", text })).toBe(text);
  });
});

describe("asSentence", () => {
  it("promotes a lower-case clause to a sentence", () => {
    expect(asSentence("no wallet is connected")).toBe("No wallet is connected.");
  });

  it("leaves an existing terminal stop alone, so a verbatim chain error is not edited", () => {
    // `walletFault.ts`'s `unknown` branch reproduces the program's own message; appending a second
    // full stop to it would be rewriting someone else's sentence.
    expect(asSentence("custom program error: NothingToExtract.")).toBe(
      "Custom program error: NothingToExtract.",
    );
    expect(asSentence("is this thing on?")).toBe("Is this thing on?");
  });

  it("survives an empty clause rather than producing a lone full stop", () => {
    expect(asSentence("")).toBe("");
  });
});
