// THE CONNECTOR'S NULL-HANDLING, TESTED WITHOUT A BROWSER — which is the point of it being pure.
//
// Almost every case below is a state the keeper only reaches when something has gone wrong: it died,
// it wedged, its file was never written, its schema moved under a page that was already open. Those
// are precisely the states a browser session cannot be relied on to produce on demand, and precisely
// the states where the failure is silent — a number on screen that looks exactly like a correct one.
//
// WHAT IS AND IS NOT BEING TESTED HERE. `keeperCountdown()` already has its own suite next door in
// `data/keeperStatus.test.ts`, and none of its rules are re-asserted here. What this file holds is
// the two judgements `roundCadence` makes that nothing else can:
//
//   1. `stale` from the hook is honoured even when the page's own clock has stopped moving;
//   2. `keeperCountdown`'s single `none` is split into "a keeper is here and silent" and "no keeper
//      is here at all" — the distinction that decides whether the chain's hour-away backstop may be
//      rendered as a countdown.

import { describe, expect, it } from "vitest";
import { KEEPER_STATUS_SCHEMA, type KeeperRoundStatus, type KeeperStatus } from "../data/keeperStatus.ts";
import { PHASE_NAME } from "../../chain/constants.ts";
import { roundCadence, type Cadence } from "./keeperCadence.ts";

/** A fixed unix SECOND, and its millisecond twin. The connector's ONE job that involves arithmetic is
 *  this conversion, so the two are written out separately rather than derived, and a test that got
 *  the factor wrong would have to say so out loud. */
const NOW_SEC = 1_800_000_000;
const NOW_MS = 1_800_000_000_000;
const STALE_AFTER = 10;

const BASE_ROUND: KeeperRoundStatus = {
  no: 7,
  pda: "R0undPdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  phase: "Lobby",
  phaseCode: 0,
  lobbyOpenedAt: NOW_SEC - 30,
  lobbyClosesAt: NOW_SEC + 30,
  fightStartedAt: 0,
  fighterCount: 4,
  heldOpen: false,
  winner: 0,
  pot: "4000000",
};

const BASE: KeeperStatus = {
  schema: KEEPER_STATUS_SCHEMA,
  keeper: {
    startedAt: NOW_SEC - 3_600,
    heartbeatAt: NOW_SEC,
    heartbeatIntervalSeconds: 2,
    staleAfterSeconds: STALE_AFTER,
    stalledSince: null,
    roundsCompleted: 42,
    lastError: null,
    wedgedRounds: [],
    lowBalance: null,
  },
  chain: {
    cluster: "devnet",
    programId: "CH7K8rDXgPQRs9CCHG9EK5kd1YSDZyPkCDGArcz4PSNP",
    arenaPda: "ArenaPdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    erValidator: null,
  },
  round: BASE_ROUND,
  entriesCloseAt: null,
  nextLobbyOpensAt: null,
};

function round(over: Partial<KeeperRoundStatus> = {}): KeeperRoundStatus {
  return { ...BASE_ROUND, ...over };
}

/** Both encodings of a phase at once — the parser checks them against each other, so a fixture that
 *  sets one without the other is not a status the page could ever receive. */
function inPhase(name: KeeperRoundStatus["phase"]): Pick<KeeperRoundStatus, "phase" | "phaseCode"> {
  return { phase: name, phaseCode: PHASE_NAME.indexOf(name) };
}

function status(over: Partial<KeeperStatus> = {}): KeeperStatus {
  return { ...BASE, ...over };
}

function withKeeper(over: Partial<KeeperStatus["keeper"]>): KeeperStatus {
  return { ...BASE, keeper: { ...BASE.keeper, ...over } };
}

/** The connector as the page calls it: exactly what `useKeeperStatus()` returns, plus the page clock.
 *  `stale` defaults to the value the hook would be reporting for a fresh heartbeat. */
function cadence(over: Partial<KeeperStatus> | null, stale = false, nowMs = NOW_MS): Cadence {
  return roundCadence({ status: over === null ? null : status(over), stale }, nowMs);
}

describe("no keeper is publishing here", () => {
  it("is its own answer, and NOT the same one as a keeper that has gone quiet", () => {
    // THE DISTINCTION THE WHOLE TYPE EXISTS FOR. `keeperCountdown` returns `none` for both, correctly
    // — neither yields a number. But they mean opposite things about the chain's own deadline: with
    // nobody holding a lobby open, `lobby_closes_at` is the real schedule and the page should count
    // it; with a keeper here and silent, it is an hour of backstop and counting it is the lie.
    expect(cadence(null)).toEqual({ kind: "no-keeper" });
    expect(cadence({}, true)).toEqual({ kind: "keeper-silent" });
  });

  it("treats a 404 exactly like every other way of having no status, because it is the normal one", () => {
    // A missing `/keeper-status.json` means no keeper has ever run here — an ordinary deployment
    // state, not an error. `useKeeperStatus` collapses the 404, the network failure, the HTML
    // fallback body and the unreadable schema into one `{ status: null }`, and this is the assertion
    // that the connector does not try to tell them apart or treat any of them as a fault.
    expect(cadence(null, true)).toEqual({ kind: "no-keeper" });
    expect(cadence(null, false)).toEqual({ kind: "no-keeper" });
  });
});

describe("a keeper that cannot be believed shows no countdown", () => {
  it("says nothing for a stale keeper even when its file still carries a live deadline", () => {
    // The file is intact, the lobby closes in thirty seconds, and the process that would close it
    // stopped talking four minutes ago. Down outranks every deadline in the file.
    const dead = withKeeper({ heartbeatAt: NOW_SEC - 240 });
    expect(roundCadence({ status: dead, stale: true }, NOW_MS)).toEqual({ kind: "keeper-silent" });
  });

  it("HONOURS THE HOOK'S OWN STALENESS CLOCK WHEN THE PAGE CLOCK HAS STOPPED", () => {
    // THE CASE THAT JUSTIFIES `stale` BEING AN ARGUMENT AT ALL, and the one a reader is most likely
    // to think is redundant. `nowMs` here comes from `useSecondTick`, which is switched OFF whenever
    // nothing is counting down — so on a settled round with no scheduled lobby it is frozen at the
    // second the component mounted. This fixture is that exact situation: a heartbeat that looks
    // perfectly fresh against the frozen page clock, from a keeper the hook's own once-a-second
    // interval has already watched die. Asking `keeperCountdown` alone would call it healthy.
    const frozenPageClock = NOW_MS;
    const looksFreshAtThatInstant = withKeeper({ heartbeatAt: NOW_SEC });
    expect(roundCadence({ status: looksFreshAtThatInstant, stale: false }, frozenPageClock)).toEqual({
      kind: "entries-close",
      seconds: 30,
    });
    expect(roundCadence({ status: looksFreshAtThatInstant, stale: true }, frozenPageClock)).toEqual({
      kind: "keeper-silent",
    });
  });

  it("says nothing for a STALLED keeper, which is a live heartbeat over a loop going nowhere", () => {
    // `stale` is false here and would stay false forever: the heartbeat runs on its own interval and
    // knows nothing about the main loop. This case is delegated whole to `keeperCountdown`, and the
    // assertion is that the connector does not accidentally short-circuit past it.
    const wedged = withKeeper({ stalledSince: NOW_SEC - 90 });
    expect(roundCadence({ status: wedged, stale: false }, NOW_MS)).toEqual({ kind: "keeper-silent" });
  });
});

describe("the cases where a number genuinely exists", () => {
  it("converts the file's SECONDS to the page's MILLISECONDS and not the other way round", () => {
    // A thousand-fold error in either direction is the mistake this conversion is one line to make,
    // and both directions produce a plausible-looking countdown rather than a crash. Thirty seconds
    // of lobby, asked at a millisecond clock, must read as thirty.
    expect(cadence({})).toEqual({ kind: "entries-close", seconds: 30 });
    // Half a second into the page clock: still thirty, because seconds are ceiled — a live countdown
    // must never read 0, since 0 is what it says at the end.
    expect(cadence({}, false, NOW_MS + 500)).toEqual({ kind: "entries-close", seconds: 30 });
  });

  it("passes a held-open lobby through as waiting-for-players, carrying no seconds", () => {
    // The state the operator asked to see, and the one that must not read as broken. It is a distinct
    // kind rather than a silence because the page has something specific and true to say.
    const held = cadence({ round: round({ heldOpen: true, lobbyClosesAt: NOW_SEC + 3_600 }) });
    expect(held).toEqual({ kind: "waiting-for-players" });
    expect("seconds" in held).toBe(false);
  });

  it("counts the next lobby down for a settled round the keeper has committed to reopening", () => {
    // The operator's original complaint, in one assertion: a settled round with a keeper running is
    // the one case that used to say "no timer" and should not have.
    expect(
      cadence({ round: round(inPhase("Settled")), nextLobbyOpensAt: NOW_SEC + 8 }),
    ).toEqual({ kind: "next-lobby", seconds: 8 });
  });

  it("goes silent the instant a committed time passes, rather than holding 0:00 on screen", () => {
    // A latched promise the keeper was slow to keep. It does not slide later, so it simply passes —
    // and a countdown parked at zero is the display this project keeps deleting.
    expect(
      cadence({ round: round(inPhase("Settled")), nextLobbyOpensAt: NOW_SEC - 30 }),
    ).toEqual({ kind: "keeper-silent" });
  });

  it("says nothing mid-Drawing and mid-Fight, because a fight ends when it ends", () => {
    for (const phase of ["Drawing", "Fight"] as const) {
      expect(
        cadence({ round: round(inPhase(phase)), nextLobbyOpensAt: NOW_SEC + 8 }),
      ).toEqual({ kind: "keeper-silent" });
    }
  });

  it("says nothing when the keeper is healthy and simply between rounds", () => {
    expect(cadence({ round: null })).toEqual({ kind: "keeper-silent" });
  });
});

describe("the invariant every caller relies on", () => {
  it("never yields seconds without a kind that promises them, or a kind that promises them without", () => {
    // `waiting-for-players`, `keeper-silent` and `no-keeper` are the three states where a surface must
    // print a sentence rather than a figure; the other two must always carry a usable number. A kind
    // that ever carried the wrong one would put NaN through `clock()` and render "NaN:aN".
    const every: Cadence[] = [
      cadence(null),
      cadence({}, true),
      cadence({}),
      cadence({ round: round({ heldOpen: true }) }),
      cadence({ round: round(inPhase("Settled")), nextLobbyOpensAt: NOW_SEC + 8 }),
    ];
    for (const c of every) {
      if (c.kind === "entries-close" || c.kind === "next-lobby") {
        expect(Number.isInteger(c.seconds)).toBe(true);
        expect(c.seconds).toBeGreaterThan(0);
      } else {
        expect("seconds" in c).toBe(false);
      }
    }
    // And all five kinds are actually reachable through this function — a sweep that only ever
    // produced two of them would pass the loop above and prove nothing.
    expect(new Set(every.map((c) => c.kind)).size).toBe(5);
  });
});
