// THE FIXTURE ROUND — a full lifecycle, on a loop, with no network involved.
//
// It exists for two situations, both real: the views and the canvas have to be buildable and
// design-reviewable when devnet has no round open (a round only exists while an operator has one
// running, and "the page is unstyleable unless someone runs the admin script" is not a way to build
// a front end), and a demo has to survive the RPC being down.
//
// IT IS PACED BY THE PROGRAM'S OWN RULES, not by whatever looks good. Same `fightPace()` the chain
// path uses, same per-fighter rate, same bell — so a reviewer watching the fixture is watching the
// real thing's timing, and the moment the fight becomes unwinnable the fixture settles for the same
// reason the chain would. The fight itself was never faked either: `mockData.ts` runs the same
// `sim/hitEvents.ts` replay off a fixed seed.

import { useEffect, useMemo, useState } from "react";
import { stepsPerSecond } from "../../chain/constants.ts";
import type { HitEvent } from "../../sim/hitEvents.ts";
import { finalCursor, sideTotals, type LiveRound, type PhaseName, type Side } from "../contract.ts";
import { extractTerms } from "./extractTerms.ts";
import { fightPace } from "./fightPace.ts";
import { MOCK_HIT_EVENTS, MOCK_SEED, mockFightersAt } from "./mockData.ts";

const LOBBY_SECONDS = 8;
const DRAW_SECONDS = 2;
const FIGHT_STARTS_AT = LOBBY_SECONDS + DRAW_SECONDS;

/** The fixture's round number. Deliberately not 1 — a reviewer should never mistake the fixture for
 *  "the first real round" while reading a screenshot. */
const FIXTURE_ROUND_NO = 17n;

/** A committed hash the fixture's seed does NOT open. It cannot: the commitment scheme is the VRF
 *  oracle's, and inventing a matching pair here would fake the one thing the provably-fair strip
 *  exists to demonstrate. It is a plausible-looking 32-byte hex string and nothing more. */
const FIXTURE_SEED_COMMIT = "b1c4a2f0d3e58697a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";

const FIXTURE_FIGHTERS = mockFightersAt(0);
const RATE = stepsPerSecond(FIXTURE_FIGHTERS.length);

/** Where the fight actually ends: the last exchange the replay produced. `runFullFight` runs to
 *  `finalCursor(FIXTURE_FIGHTERS.length)` but stops emitting once one side has nobody left, so this
 *  IS the fight's real length — the same instant `fight_is_over()` would let anyone settle it on
 *  chain. */
const LAST_EVENT_STEP = MOCK_HIT_EVENTS.length
  ? Number(MOCK_HIT_EVENTS[MOCK_HIT_EVENTS.length - 1].step)
  : finalCursor(FIXTURE_FIGHTERS.length);
const FIGHT_SECONDS = LAST_EVENT_STEP / RATE;
const SETTLE_STEP = Math.min(LAST_EVENT_STEP, finalCursor(FIXTURE_FIGHTERS.length));

const CLOCK_MS = 250;

function phaseAt(sinceMountSec: number): PhaseName {
  if (sinceMountSec < LOBBY_SECONDS) return "Lobby";
  if (sinceMountSec < FIGHT_STARTS_AT) return "Drawing";
  if (sinceMountSec < FIGHT_STARTS_AT + FIGHT_SECONDS) return "Fight";
  return "Settled";
}

export interface FixtureRound {
  live: LiveRound;
  hitEvents: HitEvent[];
}

/** `active` is false while the chain provider holds the fixture in reserve. It matters: the clock
 *  below re-renders the whole context four times a second, and doing that behind a live round that
 *  isn't even in Fight would be four wasted re-renders a second of every panel on the page. */
export function useFixtureRound(active: boolean): FixtureRound {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(startedAt);

  // Restart the round whenever the fixture comes into play, so it always opens on its lobby — a page
  // that had been watching devnet for an hour before the RPC dropped should not fall back to a round
  // that finished fifty-nine minutes ago.
  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    setStartedAt(now);
    setNowMs(now);
    // Runs through Settled too, unlike the chain path: the fixture's clock is also what advances it
    // from one phase to the next, so stopping it outside Fight would strand it in the lobby.
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, [active]);

  const phase = phaseAt((nowMs - startedAt) / 1000);

  return useMemo<FixtureRound>(() => {
    const fightStartedAtMs = phase === "Lobby" || phase === "Drawing"
      ? null
      : startedAt + FIGHT_STARTS_AT * 1000;
    const tickCount = phase === "Settled" ? BigInt(SETTLE_STEP) : 0n;

    const pace = fightPace({ phase, fightStartedAtMs, fighters: FIXTURE_FIGHTERS, tickCount, nowMs });
    const fighters = phase === "Lobby" || phase === "Drawing"
      ? FIXTURE_FIGHTERS
      : mockFightersAt(pace.stepsNow);
    const [a, b] = sideTotals(fighters);

    return {
      live: {
        roundNo: FIXTURE_ROUND_NO,
        phase,
        winner: phase === "Settled" ? ((a >= b ? 0 : 1) as Side) : null,
        pot: fighters.reduce((sum, f) => sum + f.stake, 0n),
        fighters,
        seedHex: phase === "Lobby" || phase === "Drawing" ? null : MOCK_SEED.toString("hex"),
        seedCommitHex: FIXTURE_SEED_COMMIT,
        fightStartedAtMs,
        // The fixture's lobby is `LOBBY_SECONDS` long and its deadline is real within the fixture:
        // entries stop being offered at the same instant the phase leaves Lobby. The chain's own
        // deadline lands EARLIER than its phase change (see `LiveRound.lobbyClosesAtMs`), which the
        // fixture cannot model without inventing an operator — so this is the optimistic end of that
        // window, and nothing on the fixture path spends anything either way.
        lobbyClosesAtMs: startedAt + LOBBY_SECONDS * 1000,
        tickCount,
        elapsedSec: pace.elapsedSec,
        stepsNow: pace.stepsNow,
        resolvable: pace.resolvable,
        // The SAME derivation the chain path uses, off the same cursor — so the extract penalty a
        // reviewer reads off the fixture is the one the program would charge on a nine-fighter
        // round: 20% at the opening bell, zero from step 675 (37.5s in, at this lineup's 18
        // steps/s). Faking or omitting it here would put the page back to promising a costless
        // exit on the very screenshot people review it from.
        extractTerms: extractTerms({ phase, fighters, stepsNow: pace.stepsNow }),
      },
      hitEvents: phase === "Lobby" || phase === "Drawing" ? [] : MOCK_HIT_EVENTS,
    };
  }, [phase, nowMs, startedAt]);
}
