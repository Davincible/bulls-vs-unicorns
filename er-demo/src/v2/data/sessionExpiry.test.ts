// The advisory clock. The arithmetic is trivial; what is worth testing is the edges where a naive
// version would state something false — a session restored from a previous visit, a corrupted
// record, a clock that moved backwards — because this number is rendered as a sentence to a player
// deciding whether to trust it through the next fight.

import { beforeEach, describe, expect, it } from "vitest";
import {
  ASSUMED_SESSION_MINUTES,
  LAPSING_WITHIN_MINUTES,
  forgetSession,
  noteSessionStarted,
  readSessionStartedAt,
  sessionLife,
} from "./sessionExpiry.ts";

const TOKEN = "8s3x42afQ1kTLp5vWq9nZbYcJ4dRhKmXgP2eN7uAvB3F";
const T0 = 1_800_000_000_000;
const minutes = (n: number) => n * 60_000;

/** vitest runs in Node with no DOM, so `localStorage` does not exist — which is also a state the
 *  real app can be in (private mode, an embedded frame). The storage tests install a minimal stub;
 *  the tests that do NOT install one are therefore also proving the no-storage path is survivable. */
function installStorage() {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  return map;
}

describe("sessionLife — the arithmetic", () => {
  it("reports a full hour at the moment a session starts", () => {
    const life = sessionLife(T0, T0);
    expect(life).toMatchObject({ known: true, minutesLeft: ASSUMED_SESSION_MINUTES, lapsed: false, lapsing: false });
  });

  it("counts down", () => {
    expect(sessionLife(T0, T0 + minutes(20))).toMatchObject({ minutesLeft: 40, lapsed: false });
    expect(sessionLife(T0, T0 + minutes(59))).toMatchObject({ minutesLeft: 1, lapsed: false });
  });

  it("starts nudging with ten minutes left — long enough to outlast a whole round", () => {
    // A round is a 60s lobby plus a fight capped at 120s. The warning has to arrive with room to
    // start a fresh session BEFORE the fight it would otherwise die in.
    expect(sessionLife(T0, T0 + minutes(ASSUMED_SESSION_MINUTES - LAPSING_WITHIN_MINUTES)).known).toBe(true);
    expect(sessionLife(T0, T0 + minutes(50))).toMatchObject({ lapsing: true, lapsed: false, minutesLeft: 10 });
    expect(sessionLife(T0, T0 + minutes(49))).toMatchObject({ lapsing: false });
  });

  it("keeps `lapsing` true once it has lapsed", () => {
    // A caller that nudges on `lapsing` alone must not fall silent at the exact moment the nudge
    // matters most.
    expect(sessionLife(T0, T0 + minutes(90))).toMatchObject({ lapsing: true, lapsed: true });
  });

  it("floors at zero rather than reporting negative minutes", () => {
    expect(sessionLife(T0, T0 + minutes(200))).toMatchObject({ minutesLeft: 0, lapsed: true });
  });
});

describe("sessionLife — the states where a clock would be a lie", () => {
  it("is unknown for a session this browser has no record of", () => {
    // gum restores sessions across reloads, so a live session can genuinely predate any record of
    // it. Inventing a start time here would put a confident countdown on a total unknown.
    expect(sessionLife(null, T0)).toEqual({ known: false });
  });

  it("is unknown for a record from the future rather than granting bonus minutes", () => {
    // A clock change or a corrupted write. Either way it is not evidence of a longer session.
    expect(sessionLife(T0 + minutes(5), T0)).toEqual({ known: false });
  });
});

describe("the stored record", () => {
  beforeEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("round-trips a start time, keyed by the session's own token address", () => {
    installStorage();
    noteSessionStarted(TOKEN, T0);
    expect(readSessionStartedAt(TOKEN)).toBe(T0);
    // Keyed by token, so a session minted for a different wallet cannot inherit this one's clock.
    expect(readSessionStartedAt("some-other-token")).toBeNull();
  });

  it("forgets on revoke, so the next session starts from nothing", () => {
    installStorage();
    noteSessionStarted(TOKEN, T0);
    forgetSession(TOKEN);
    expect(readSessionStartedAt(TOKEN)).toBeNull();
  });

  it("reads a corrupted value as unknown, not as a session expired since the epoch", () => {
    const map = installStorage();
    for (const junk of ["", "abc", "0", "-1", "NaN"]) {
      map.set(`v2_session_started:${TOKEN}`, junk);
      expect(readSessionStartedAt(TOKEN), junk).toBeNull();
    }
  });

  it("survives storage being absent entirely, in both directions", () => {
    // No stub installed: this is Node, and it is also private mode / a sandboxed iframe. Losing the
    // advisory is acceptable; throwing on a page load is not.
    expect(() => noteSessionStarted(TOKEN, T0)).not.toThrow();
    expect(() => forgetSession(TOKEN)).not.toThrow();
    expect(readSessionStartedAt(TOKEN)).toBeNull();
  });

  it("survives storage that throws on access", () => {
    // A hardened profile can make the property itself throw, not merely return null.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    expect(() => noteSessionStarted(TOKEN, T0)).not.toThrow();
    expect(readSessionStartedAt(TOKEN)).toBeNull();
    expect(() => forgetSession(TOKEN)).not.toThrow();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
