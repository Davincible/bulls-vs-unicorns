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
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { PHASE_NAME, Phase } from "../../src/chain/constants.ts";
import {
  KEEPER_STATUS_SCHEMA, parseKeeperStatus, type KeeperRoundStatus,
} from "../../src/v2/data/keeperStatus.ts";
import {
  honestEntriesCloseAt, honestNextLobbyOpensAt, roundStatusFrom, type CountdownLatch,
} from "./statusFile.ts";
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
    heldOpen: false,
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

describe("what the keeper writes is what the browser can read", () => {
  // ONE MODULE, BOTH ENDS — checked rather than asserted. `roundStatusFrom` is the writer and
  // `parseKeeperStatus` is the reader, and until now nothing ran the first through the second. A
  // field the writer stops emitting, or emits under a different name, makes the whole file parse as
  // `null` and the page say "keeper down" while the keeper is running perfectly: the exact silent
  // failure both modules are covered in warnings about, with no test standing between them. It costs
  // one JSON round trip to close, and it is what makes adding a field to the contract safe.
  const roundAccount = {
    roundNo: new BN(9),
    phase: Phase.Lobby,
    winner: 0,
    fighterCount: 2,
    pot: new BN("18446744073709551615"), // u64::MAX — the value a JSON number would silently round
    lobbyOpenedAt: new BN(NOW - 30),
    lobbyClosesAt: new BN(NOW + 3_570),
    fightStartedAt: new BN(0),
  } as unknown as Parameters<typeof roundStatusFrom>[0];
  const pda = new PublicKey("11111111111111111111111111111112");

  it("round-trips a held-open round through JSON and the reader's own parser", () => {
    const written = roundStatusFrom(roundAccount, pda, 1, 1, true);
    const document = {
      schema: KEEPER_STATUS_SCHEMA,
      keeper: {
        startedAt: NOW - 60, heartbeatAt: NOW, heartbeatIntervalSeconds: 2, staleAfterSeconds: 15,
        stalledSince: null, roundsCompleted: 0, lastError: null, wedgedRounds: [],
      },
      chain: { cluster: "devnet", programId: "P", arenaPda: "A", erValidator: null },
      round: written,
      entriesCloseAt: NOW + 18,
      nextLobbyOpensAt: null,
      house: { wallets: [], disclosure: "" },
    };
    const parsed = parseKeeperStatus(JSON.parse(JSON.stringify(document)) as unknown);
    expect(parsed).not.toBeNull();
    expect(parsed?.round?.heldOpen).toBe(true);
    expect(parsed?.entriesCloseAt).toBe(NOW + 18);
    // The pot survives as a u64 rather than as a double that is 2,048 away from itself.
    expect(BigInt(parsed!.round!.pot)).toBe(2n ** 64n - 1n);
  });

  it("round-trips a lobby that is not held open, so the flag is genuinely carried either way", () => {
    const written = roundStatusFrom(roundAccount, pda, 2, 0, false);
    expect(written.heldOpen).toBe(false);
    expect(JSON.parse(JSON.stringify(written)).heldOpen).toBe(false); // survives, not dropped
  });
});

describe("the keeper's own close time is only published beside a lobby", () => {
  it("publishes it for a round still taking entries", () => {
    expect(honestEntriesCloseAt(roundIn(Phase.Lobby), NOW + 18)).toBe(NOW + 18);
  });

  it("refuses it in every phase where entries are already closed", () => {
    // THE SAME CONTRADICTION `honestNextLobbyOpensAt` WAS WRITTEN FOR, arriving from the other side.
    // The phase snapshot is taken at the top of a pass and the close time is set during it, so the
    // pass that sends the early close can leave the file claiming entries close in eight seconds
    // beside a round already reading `Drawing`. `keeperCountdown` ignores it there — the FILE would
    // still be asserting something untrue, and the next reader has no way to know.
    for (const phase of [Phase.Drawing, Phase.Fight, Phase.Settled, Phase.Abandoned]) {
      expect(honestEntriesCloseAt(roundIn(phase), NOW + 18), PHASE_NAME[phase]).toBeNull();
    }
  });

  it("refuses it when there is no round to attach it to", () => {
    expect(honestEntriesCloseAt(null, NOW + 18)).toBeNull();
  });

  it("passes a null straight through, which is most of a keeper's life", () => {
    // Null is the normal value: nobody has arrived, or the hold-open policy is off entirely.
    expect(honestEntriesCloseAt(roundIn(Phase.Lobby), null)).toBeNull();
  });

  it("does not latch, because the value it is given is already latched upstream", () => {
    // Stated as a test so the absence is deliberate rather than forgotten. `nextLobbyOpensAt` has to
    // be latched because its candidate is recomputed as `now + hold` every pass. This candidate is
    // `firstRealEntryObservedAt + grace`, and that stamp is latched per round in the keeper's
    // timeline — so the same value is proposed on every pass, and a second latch here would guard an
    // invariant that already holds one layer up while hiding a regression in the layer that holds it.
    const round = roundIn(Phase.Lobby);
    for (const pass of [0, 1, 2, 3]) {
      expect(honestEntriesCloseAt(round, NOW + 18), `pass ${pass}`).toBe(NOW + 18);
    }
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
