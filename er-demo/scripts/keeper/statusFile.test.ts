// THE COUNTDOWN RULE — the two properties a real run violated, pinned so they cannot come back.
//
// Both were found by sampling `public/keeper-status.json` every two seconds against a live keeper,
// and neither threw anything or failed to parse. That is why they are worth a test: the failure mode
// of this file is a page that draws a confident, wrong number, which no exception and no schema check
// will ever catch.
//
//   ONE — the countdown ran BACKWARDS. Sampled through a single twelve-second result hold:
//   0:11, 0:09, 0:07, 0:05, 0:11, 0:09, 0:07, 0:11 … sawtoothing for about fifty seconds. Every reset
//   is one more observer freshly computing "now + RESULT_HOLD_SECONDS" for a round that had already
//   been promised a time. The whole justification for the result hold is that it is the ONE interval
//   where that number is honest; a clock that jumps backwards is not honest, it is an invented number
//   with extra steps.
//
//   TWO — the file contradicted itself. A sample caught `nextLobbyOpensAt` set beside a round whose
//   published phase still read `Fight`, because the phase snapshot is taken at the top of a pass and
//   the countdown is set during it. `keeperCountdown` happens to ignore a countdown in that phase, so
//   nothing reached a user — but the FILE asserted something untrue, and the next person to read it
//   has no way to know that.
//
// `honestNextLobbyOpensAt` is where both rules live, as a pure function, so both can be checked here
// without a chain, a filesystem or a clock.

import { describe, expect, it } from "vitest";
import { PHASE_NAME, Phase } from "../../src/chain/constants.ts";
import type { KeeperRoundStatus } from "../../src/v2/data/keeperStatus.ts";
import { honestNextLobbyOpensAt, type CountdownLatch } from "./statusFile.ts";
import { RESULT_HOLD_SECONDS } from "./config.ts";

const NOW = 1_800_000_000;

function roundIn(phase: number, no = 7): KeeperRoundStatus {
  return {
    no,
    pda: "R0undPdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    phase: PHASE_NAME[phase]!,
    phaseCode: phase,
    lobbyOpenedAt: NOW - 60,
    lobbyClosesAt: NOW,
    fightStartedAt: NOW + 2,
    fighterCount: 4,
    houseFighterCount: 4,
    realFighterCount: 0,
    winner: 1,
    pot: "4000000",
  };
}

describe("a countdown is only published beside a round that is genuinely holding", () => {
  it("publishes it for a settled round", () => {
    const { at } = honestNextLobbyOpensAt(roundIn(Phase.Settled), NOW + 12, null);
    expect(at).toBe(NOW + 12);
  });

  it("publishes it for an abandoned round, which also holds before the next one opens", () => {
    const { at } = honestNextLobbyOpensAt(roundIn(Phase.Abandoned), NOW + 3, null);
    expect(at).toBe(NOW + 3);
  });

  it("refuses it beside a round still reading Fight, however sure the caller is", () => {
    // The exact contradiction observed live: `resolve` had landed and set the countdown, but the
    // round snapshot in the file was still the pre-resolve read.
    expect(honestNextLobbyOpensAt(roundIn(Phase.Fight), NOW + 11, null).at).toBeNull();
  });

  it("refuses it during Lobby and Drawing too", () => {
    // Lobby has the chain's own `lobby_closes_at`; Drawing has no honest answer at all.
    expect(honestNextLobbyOpensAt(roundIn(Phase.Lobby), NOW + 11, null).at).toBeNull();
    expect(honestNextLobbyOpensAt(roundIn(Phase.Drawing), NOW + 11, null).at).toBeNull();
  });

  it("refuses it when there is no round to attach it to", () => {
    expect(honestNextLobbyOpensAt(null, NOW + 12, null).at).toBeNull();
  });
});

describe("the countdown counts down", () => {
  it("keeps the first time promised for a round, however many passes re-propose one", () => {
    // Six passes through the hold, each one arriving a second later and each one — as an unlatched
    // keeper did — proposing "now + RESULT_HOLD_SECONDS" all over again.
    const round = roundIn(Phase.Settled);
    let latch: CountdownLatch | null = null;
    const published: number[] = [];
    for (let pass = 0; pass < 6; pass++) {
      const now = NOW + pass;
      const decided = honestNextLobbyOpensAt(round, now + RESULT_HOLD_SECONDS, latch);
      latch = decided.latch;
      published.push(decided.at!);
    }
    expect(published).toEqual(Array(6).fill(NOW + RESULT_HOLD_SECONDS));
  });

  it("loses exactly one second per second — the sawtooth, stated as the property", () => {
    // Asserted as an exact ladder rather than as "never increases", because "never increases" is also
    // satisfied by a countdown frozen at 0:12 forever, which is a different lie. What a viewer is owed
    // is a number that tracks the clock: twelve passes, one second apart, counting 12 down to 1.
    const round = roundIn(Phase.Settled);
    let latch: CountdownLatch | null = null;
    const remaining: number[] = [];
    for (let pass = 0; pass < RESULT_HOLD_SECONDS; pass++) {
      const now = NOW + pass;
      const decided = honestNextLobbyOpensAt(round, now + RESULT_HOLD_SECONDS, latch);
      latch = decided.latch;
      remaining.push(decided.at! - now);
    }
    expect(remaining).toEqual(
      Array.from({ length: RESULT_HOLD_SECONDS }, (_, pass) => RESULT_HOLD_SECONDS - pass),
    );
  });

  it("does not carry one round's promise onto the next", () => {
    const first = honestNextLobbyOpensAt(roundIn(Phase.Settled, 7), NOW + 12, null);
    const second = honestNextLobbyOpensAt(roundIn(Phase.Settled, 8), NOW + 40, first.latch);
    expect(second.at).toBe(NOW + 40);
  });

  it("holds the latched time even when the caller proposes nothing", () => {
    // The pass after `close_round` proposes nothing new; the promise already made must survive it.
    const latched = honestNextLobbyOpensAt(roundIn(Phase.Settled), NOW + 12, null);
    expect(honestNextLobbyOpensAt(roundIn(Phase.Settled), null, latched.latch).at).toBe(NOW + 12);
  });

  it("lets the promised time simply pass rather than sliding it later", () => {
    // `close_round` overran the hold. The honest answer is that the time has come and gone —
    // `keeperCountdown` draws nothing once it is in the past — not a promise moved because the keeper
    // was slow, which would be the same lie in the other direction.
    const latched = honestNextLobbyOpensAt(roundIn(Phase.Settled), NOW + 12, null);
    const late = honestNextLobbyOpensAt(roundIn(Phase.Settled), NOW + 45, latched.latch);
    expect(late.at).toBe(NOW + 12);
  });
});
