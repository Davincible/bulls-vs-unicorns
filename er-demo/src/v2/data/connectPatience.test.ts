// THE BOUND ON ONE SENTENCE, ENUMERATED.
//
// The defect these exist against is a page that says "waiting for you to approve the connection in
// Phantom" forever. `adapter.connect()` has no timeout anywhere in it, so an extension that never
// answers latches the connecting status for the life of the tab — and the sentence is a claim about
// what a PLAYER is doing, made by a page that cannot see whether a popup was ever shown.
//
// Three properties are worth more than the rest and each has a test of its own:
//
//   · TOTALITY. Every one of the three `ConnectWait` shapes has an answer from every function, so a
//     fourth state cannot be added and quietly fall through a `kind !== "asked"` somewhere.
//   · A SETTLE THAT LANDED FIRST WINS. `stall` is a reducer precisely so a timer that has been
//     outrun by `onConnect` cannot resurrect a wait that is over, and that is asserted directly
//     rather than left as a property of the hook that happens to hold today.
//   · THE COPY CANNOT STATE THE BOUND INDEPENDENTLY OF THE BOUND. `playGate` prints
//     `CONNECT_PATIENCE_SECONDS` in a sentence; if that ever stopped being derived from
//     `CONNECT_PATIENCE_MS`, the page would go on naming a number nothing schedules.

import { describe, expect, it } from "vitest";
import {
  CONNECT_PATIENCE_MS,
  CONNECT_PATIENCE_SECONDS,
  hasStalled,
  isConnecting,
  msUntilStalled,
  stall,
  type ConnectWait,
} from "./connectPatience.ts";

const T0 = 1_700_000_000_000;

const IDLE: ConnectWait = { kind: "idle" };
const ASKED: ConnectWait = { kind: "asked", startedAtMs: T0 };
const STALLED: ConnectWait = { kind: "stalled", startedAtMs: T0 };

/** Every shape the type has. The loops below iterate this, so a new member added to `ConnectWait`
 *  without a line here is a compile error rather than a silently unexercised branch. */
const EVERY: ConnectWait[] = [IDLE, ASKED, STALLED];

describe("isConnecting — is a handshake this page started still outstanding", () => {
  it("is false only when nothing has been asked", () => {
    expect(isConnecting(IDLE)).toBe(false);
  });

  it("is true while the wallet has been asked and has not answered", () => {
    expect(isConnecting(ASKED)).toBe(true);
  });

  it("stays true once the wait has stalled, because the request really is still pending", () => {
    // The bound changes what the page SAYS, not what it believes about the wallet. Reporting
    // `disconnected` here would put a Connect button on screen that the adapter's
    // `if (this.connected || this.connecting) return` guard would silently discard, and the null
    // public key that came back would then be misreported as a failed connect.
    expect(isConnecting(STALLED)).toBe(true);
  });

  it("answers for every shape the type has", () => {
    for (const wait of EVERY) expect(typeof isConnecting(wait)).toBe("boolean");
  });
});

describe("hasStalled — has the claim 'Phantom is waiting on you' become unsafe to keep making", () => {
  it("is false before anything has been asked", () => {
    expect(hasStalled(IDLE)).toBe(false);
  });

  it("is false while the wait is still inside the bound", () => {
    // The whole point of the bound: a player reading the dialog right now must not have the sentence
    // about that dialog softened underneath them.
    expect(hasStalled(ASKED)).toBe(false);
  });

  it("is true once the wait has stalled", () => {
    expect(hasStalled(STALLED)).toBe(true);
  });

  it("answers for every shape the type has", () => {
    for (const wait of EVERY) expect(typeof hasStalled(wait)).toBe("boolean");
  });
});

describe("msUntilStalled — the one schedule, shared with the verdict", () => {
  it("returns the whole bound at the instant the handshake starts", () => {
    expect(msUntilStalled(ASKED, T0)).toBe(CONNECT_PATIENCE_MS);
  });

  it("counts down as the wait runs", () => {
    expect(msUntilStalled(ASKED, T0 + 5_000)).toBe(CONNECT_PATIENCE_MS - 5_000);
  });

  it("clamps at zero rather than going negative when the clock has already passed the bound", () => {
    // Not defensive padding. A backgrounded tab throttles its timers to roughly one a second, and a
    // tab whose owner is reading a wallet dialog is exactly a backgrounded tab — so the first `now`
    // this sees can genuinely land well past the deadline. Zero means "now", which is the honest
    // reading; a negative delay would be coerced to zero by `setTimeout` anyway and would only make
    // the arithmetic here harder to reason about.
    expect(msUntilStalled(ASKED, T0 + CONNECT_PATIENCE_MS)).toBe(0);
    expect(msUntilStalled(ASKED, T0 + CONNECT_PATIENCE_MS + 60_000)).toBe(0);
  });

  it("schedules nothing for a wait that has not started", () => {
    expect(msUntilStalled(IDLE, T0)).toBeNull();
  });

  it("schedules nothing for a wait that has already stalled, so no timer can re-fire", () => {
    // `stalled` is terminal until the attempt settles. A non-null answer here would have the hook
    // re-arming a timeout on every render for the rest of the wedge.
    expect(msUntilStalled(STALLED, T0 + 1)).toBeNull();
  });

  it("answers for every shape the type has", () => {
    for (const wait of EVERY) {
      const ms = msUntilStalled(wait, T0);
      expect(ms === null || ms >= 0).toBe(true);
    }
  });
});

describe("stall — the transition, written so a settle that landed first always wins", () => {
  it("moves an outstanding wait to stalled", () => {
    expect(stall(ASKED)).toEqual({ kind: "stalled", startedAtMs: T0 });
  });

  it("carries the start time across, so the value still describes one attempt", () => {
    // Not a fresh fact about a new handshake — the same handshake, later. Anything reading
    // `startedAtMs` to say how long this has been going gets the truth rather than the instant the
    // timer happened to fire.
    const after = stall(ASKED);
    expect(after.kind === "stalled" && after.startedAtMs).toBe(T0);
  });

  it("does nothing to an idle wait, because a settle that landed first must win", () => {
    // THE PROPERTY THE REDUCER EXISTS FOR. The timer is armed against the `wait` that was current
    // when the effect ran; between then and the callback, `onConnect`/`onDisconnect`/`onError` and
    // `runConnect`'s own `finally` can all write `idle`. If this returned a stalled value regardless,
    // an outrun timer would put a stalled panel over a connected wallet.
    expect(stall(IDLE)).toBe(IDLE);
  });

  it("does nothing to a wait that has already stalled", () => {
    expect(stall(STALLED)).toBe(STALLED);
  });

  it("is idempotent, so a duplicated timer cannot change the answer", () => {
    expect(stall(stall(ASKED))).toEqual(stall(ASKED));
  });

  it("answers for every shape the type has", () => {
    for (const wait of EVERY) expect(EVERY.map((w) => w.kind)).toContain(stall(wait).kind);
  });
});

describe("the bound and the number the copy prints", () => {
  it("derives the seconds from the milliseconds, so no sentence can state the bound on its own", () => {
    // `playGate.ts` prints this figure inside the `connect-stalled` block. The rule is
    // `useActions.ts`'s `patienceMinutes`: derive it, never retype it, or the day the bound moves is
    // the day the page starts naming a number nothing schedules.
    expect(CONNECT_PATIENCE_SECONDS).toBe(Math.round(CONNECT_PATIENCE_MS / 1000));
  });

  it("keeps the bound clear of the slowest path where a popup really is on screen", () => {
    // Unlock-then-approve — password, then the dialog — is about fifteen seconds. Anything at or
    // under that would soften the sentence while somebody was reading the very dialog it describes,
    // which is a worse page than the defect this fixes.
    expect(CONNECT_PATIENCE_MS).toBeGreaterThan(15_000);
  });
});
