// The playhead, the clock, and "can this be settled yet" — three numbers a wrong assumption about the
// program would corrupt silently, on a page whose whole claim is that it shows the fight the chain is
// actually running. So the first test checks the playhead against the program's own cursor function
// rather than against a hand-written expectation.

import { describe, expect, it } from "vitest";
import { FIGHT_TIMEOUT_SECONDS, MAX_STEPS, canonicalCursor, type Side } from "../contract.ts";
import { fightIsOver, fightPace, shouldDriveFight, type PaceFighter } from "./fightPace.ts";

function lineup(sides: Side[], dead: boolean[] = []): PaceFighter[] {
  return sides.map((side, i) => ({ side, dead: dead[i] ?? false }));
}

const FOUR = lineup([0, 1, 0, 1]);
/** 4 fighters × STEPS_PER_FIGHTER_PER_SECOND(2) — the program's own rate for this lineup. */
const RATE_FOR_FOUR = 8;

describe("the playhead agrees with the program's own cursor", () => {
  it("lands on canonicalCursor() at every whole second, for every legal lineup", () => {
    // `canonicalCursor` is the TypeScript mirror of the Rust `canonical_cursor()` that `tick`,
    // `extract` and `resolve` all catch the stored cursor up to. The chain only ever moves at whole
    // seconds; `fightPace` interpolates between them for a smooth playhead, so the two must agree
    // exactly at the marks the chain actually visits — otherwise the canvas is drawing a fight the
    // program is not running.
    const startedAtSec = 1_700_000_000;
    for (const n of [2, 4, 8, 16]) {
      for (const sec of [0, 1, 7, 42, 120, 600]) {
        const pace = fightPace({
          phase: "Fight",
          fightStartedAtMs: startedAtSec * 1000,
          fighters: lineup(Array.from({ length: n }, (_, i) => (i % 2) as Side)),
          tickCount: 0n,
          nowMs: (startedAtSec + sec) * 1000,
        });
        expect(pace.stepsNow).toBe(canonicalCursor(startedAtSec, n, startedAtSec + sec));
      }
    }
  });
});

describe("shouldDriveFight", () => {
  // The gate on the one write path that keeps the on-chain fight current. Getting it wrong in either
  // direction is expensive: too closed and every roster on the page sits frozen at entry stakes for
  // the whole fight; too open and an unfunded burner spins a doomed transaction every 400ms against
  // the same RPC the round poll needs.
  const OPEN = { fallback: false, sessionActive: false, solBalance: 1.5, mode: "burner" as const };

  it("drives the fight when the burner can pay for it", () => {
    expect(shouldDriveFight(OPEN)).toBe(true);
  });

  it("never drives anything while the page is on the fixture", () => {
    expect(shouldDriveFight({ ...OPEN, fallback: true })).toBe(false);
  });

  it("stops when the burner is known to be empty and no session is paying", () => {
    expect(shouldDriveFight({ ...OPEN, solBalance: 0 })).toBe(false);
  });

  it("keeps driving on an empty burner when a session key is footing the bill", () => {
    expect(shouldDriveFight({ ...OPEN, solBalance: 0, sessionActive: true })).toBe(true);
  });

  it("gives an unknown balance the benefit of the doubt", () => {
    // The first balance poll can land after the first Fight poll; refusing here would mean a fight
    // that stays frozen for as long as the wallet read takes.
    expect(shouldDriveFight({ ...OPEN, solBalance: null })).toBe(true);
  });

  describe("wallet mode — the session is the only thing that may drive a fight", () => {
    const WALLET = { ...OPEN, mode: "wallet" as const };

    it("never ticks through a connected wallet directly, however much SOL it holds", () => {
      // The ticker polls at 400ms. Signing those with Phantom means an approval popup roughly two
      // and a half times a second for the length of a fight — not a degraded page, an unusable one.
      expect(shouldDriveFight({ ...WALLET, solBalance: 1.5 })).toBe(false);
      expect(shouldDriveFight({ ...WALLET, solBalance: 100 })).toBe(false);
      expect(shouldDriveFight({ ...WALLET, solBalance: null })).toBe(false);
    });

    it("ticks once a session key is signing and paying", () => {
      expect(shouldDriveFight({ ...WALLET, sessionActive: true })).toBe(true);
      // The session key funds itself at creation, so the player's own balance stops being the
      // question — same reasoning the burner path already applies.
      expect(shouldDriveFight({ ...WALLET, sessionActive: true, solBalance: 0 })).toBe(true);
    });

    it("still refuses on the fixture, session or not", () => {
      expect(shouldDriveFight({ ...WALLET, sessionActive: true, fallback: true })).toBe(false);
    });

    it("PROOF: the ticker's placeholder keypair is unreachable in wallet mode", () => {
      // `chain/useFightTicker.ts` requires a `Keypair` and signs with it only when `session` is
      // null. Wallet mode has no keypair to give, so `identity.ts` passes a generated one that holds
      // nothing. This is the guarantee that the branch touching it cannot run: for every input where
      // this function returns true in wallet mode, a session is active — so the ticker takes the
      // session branch, every time. Delete the clause and an empty signer is silently armed.
      for (const solBalance of [null, 0, 0.001, 1.5, 1_000]) {
        for (const fallback of [true, false]) {
          const enabledWithoutSession = shouldDriveFight({
            mode: "wallet",
            sessionActive: false,
            solBalance,
            fallback,
          });
          expect(enabledWithoutSession, `sol=${solBalance} fallback=${fallback}`).toBe(false);
        }
      }
    });
  });
});

describe("fightIsOver", () => {
  it("is false while both sides still have someone standing", () => {
    expect(fightIsOver(FOUR)).toBe(false);
  });

  it("is true once one side has nobody standing", () => {
    expect(fightIsOver(lineup([0, 1, 0, 1], [false, true, false, true]))).toBe(true);
  });

  it("counts an extracted fighter as out of the ring", () => {
    // `extract()` sets `dead = 1` on chain, so pulling the last opponent out really does end it.
    expect(fightIsOver(lineup([0, 1], [false, true]))).toBe(true);
  });
});

describe("fightPace", () => {
  const base = { fighters: FOUR, tickCount: 0n, fightStartedAtMs: 1_000_000, nowMs: 1_000_000 };

  it("is flat at zero in Lobby and Drawing", () => {
    for (const phase of ["Lobby", "Drawing"] as const) {
      expect(fightPace({ ...base, phase })).toEqual({ elapsedSec: 0, stepsNow: 0, resolvable: false });
    }
  });

  it("advances the playhead at the program's PER-FIGHTER rate, not a flat one", () => {
    const pace = fightPace({ ...base, phase: "Fight", nowMs: base.fightStartedAtMs + 10_000 });
    expect(pace.elapsedSec).toBe(10);
    expect(pace.stepsNow).toBe(10 * RATE_FOR_FOUR);
  });

  it("saturates at MAX_STEPS however long the round is left unattended", () => {
    const pace = fightPace({ ...base, phase: "Fight", nowMs: base.fightStartedAtMs + 86_400_000 });
    expect(pace.stepsNow).toBe(MAX_STEPS);
  });

  it("never runs the clock backwards when the chain's clock is ahead of the browser's", () => {
    const pace = fightPace({ ...base, phase: "Fight", nowMs: base.fightStartedAtMs - 5_000 });
    expect(pace.elapsedSec).toBe(0);
    expect(pace.stepsNow).toBe(0);
  });

  it("is resolvable the moment one side is wiped out, long before the bell", () => {
    const pace = fightPace({
      ...base,
      phase: "Fight",
      fighters: lineup([0, 1, 0, 1], [false, true, false, true]),
      nowMs: base.fightStartedAtMs + 3_000,
    });
    expect(pace.resolvable).toBe(true);
  });

  it("is resolvable at the bell even with everyone still standing", () => {
    const atBell = base.fightStartedAtMs + FIGHT_TIMEOUT_SECONDS * 1000;
    expect(fightPace({ ...base, phase: "Fight", nowMs: atBell - 1 }).resolvable).toBe(false);
    expect(fightPace({ ...base, phase: "Fight", nowMs: atBell }).resolvable).toBe(true);
  });

  it("is never resolvable with fewer than two fighters — resolve() refuses", () => {
    const solo = fightPace({
      ...base,
      phase: "Fight",
      fighters: lineup([0]),
      nowMs: base.fightStartedAtMs + FIGHT_TIMEOUT_SECONDS * 1000,
    });
    expect(solo.resolvable).toBe(false);
  });

  it("freezes a settled round at the chain's own tick_count rather than resetting it", () => {
    const pace = fightPace({
      ...base,
      phase: "Settled",
      tickCount: 240n,
      nowMs: base.fightStartedAtMs + 999_999,
    });
    expect(pace.stepsNow).toBe(240);
    expect(pace.elapsedSec).toBe(240 / RATE_FOR_FOUR);
    expect(pace.resolvable).toBe(false);
  });
});
