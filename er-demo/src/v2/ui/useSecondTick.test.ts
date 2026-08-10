// THE SHARED ONE-HERTZ CLOCK — the invariant that two surfaces showing the same countdown show the
// same second.
//
// WHY THIS FILE EXISTS. `useSecondTick` used to be `useState` + `setInterval` PER CALLER, so every
// consumer started its own interval at its own mount time and two started 700ms apart stayed 700ms
// apart forever. Both were reading `Date.now()`, so neither was ever WRONG — they were just never
// simultaneously right, and the page had no figure on it that made that visible.
//
// Then the round clock started counting the bell DOWN. The bell is now in 00-1's hero, in the top
// bar, painted a foot wide across the field, on the sticky strip and beside the Extract button, and
// those are on screen together. Photographed at 1440x950 mid-fight, before the tick was unified:
// `1:50` on the field and `1:49` in the extract panel, four inches apart. A reader cannot tell a
// one-second skew from a broken readout.
//
// WHAT IT TESTS AND WHAT IT CANNOT. This suite is pure — no jsdom, no testing-library — so the HOOK
// cannot be rendered here. What can be tested is the store the hook is a four-token adapter over
// (`SECOND_TICK`), and that is where all the risk is: the interval's lifecycle and the shared
// instant. The React binding on top is `useSyncExternalStore(subscribe, getSnapshot)`, whose whole
// contract is that every subscriber renders from one snapshot; asserting React implements its own
// hook is not this file's job. `e2e/clock.e2e.ts` covers the assembled page, and asserts that every
// clock slot on screen reads the same string — which is this invariant, observed from the outside.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECOND_TICK } from "./useSecondTick.ts";

/** Subscribers registered by a test, torn down after it. A leaked subscriber would leave the
 *  module-level interval running into the next test — and because the store IS module state, that
 *  failure would show up somewhere else entirely. */
let cleanups: (() => void)[] = [];

function subscribe(onTick: () => void = () => {}): () => void {
  const unsubscribe = SECOND_TICK.subscribe(onTick);
  cleanups.push(unsubscribe);
  return unsubscribe;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  vi.useRealTimers();
});

describe("the shared second tick", () => {
  it("gives every subscriber the same instant, however far apart they subscribed", () => {
    // THE WHOLE POINT, AS ONE ASSERTION. Two consumers subscribing 700ms apart is the ordinary case —
    // the sticky strip mounts when the page is scrolled, the extract panel when a fight starts — and
    // under the old per-caller interval this is exactly the pair that sat a second apart.
    vi.setSystemTime(new Date("2025-01-01T12:00:00.000Z"));
    subscribe();
    const first = SECOND_TICK.getSnapshot();

    vi.advanceTimersByTime(700);
    subscribe();
    expect(SECOND_TICK.getSnapshot(), "a late subscriber moved the shared instant").toBe(first);

    // And they still agree after the tick fires — one interval, one instant, both readings.
    vi.advanceTimersByTime(300);
    const afterTick = SECOND_TICK.getSnapshot();
    expect(afterTick).toBeGreaterThan(first);
    expect(SECOND_TICK.getSnapshot()).toBe(afterTick);
  });

  it("notifies every subscriber on one tick, exactly once each", () => {
    const calls = [0, 0, 0];
    subscribe(() => calls[0]++);
    subscribe(() => calls[1]++);
    subscribe(() => calls[2]++);

    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([1, 1, 1]);
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([2, 2, 2]);
  });

  it("runs ONE interval for any number of subscribers, not one apiece", () => {
    // The saving is incidental; the reason this matters is that N intervals is N phases, which is the
    // defect. Counted through the timer count rather than by inspecting module internals.
    subscribe();
    subscribe();
    subscribe();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops the interval with the last subscriber and starts it again with the next", () => {
    const stopA = subscribe();
    const stopB = subscribe();
    expect(vi.getTimerCount()).toBe(1);

    stopA();
    expect(vi.getTimerCount(), "the interval stopped while a subscriber was still listening").toBe(1);
    stopB();
    expect(vi.getTimerCount(), "the interval outlived its last subscriber").toBe(0);

    subscribe();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("refreshes the instant when the interval restarts, rather than serving a stale one", () => {
    // THE CASE THAT WOULD SHIP A VISIBLY WRONG COUNTDOWN. A page can sit with nothing counting for
    // minutes — a settled round with no published next lobby — and the tick is stopped throughout. If
    // the instant were left at whatever it was when the last subscriber left, the first render after
    // a lobby opened would be built on a five-minute-old `Date.now()`.
    vi.setSystemTime(new Date("2025-01-01T12:00:00.000Z"));
    const stop = subscribe();
    const before = SECOND_TICK.getSnapshot();
    stop();

    vi.advanceTimersByTime(5 * 60_000);
    expect(SECOND_TICK.getSnapshot(), "a stopped clock kept moving").toBe(before);

    subscribe();
    expect(SECOND_TICK.getSnapshot() - before).toBe(5 * 60_000);
  });

  it("survives a subscriber that unsubscribes from inside its own notification", () => {
    // React 18 batches these into a microtask, so this cannot happen through the hook today — but a
    // set mutated under its own `for…of` skips the NEXT element rather than failing, which would be a
    // surface that silently stopped updating. Cheap to make impossible; expensive to diagnose.
    const seen: string[] = [];
    const stopA = SECOND_TICK.subscribe(() => {
      seen.push("a");
      stopA();
    });
    cleanups.push(stopA);
    subscribe(() => seen.push("b"));

    vi.advanceTimersByTime(1000);
    expect(seen, "the second subscriber was skipped").toEqual(["a", "b"]);
    // A only heard the tick it unsubscribed during.
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(["a", "b", "b"]);
  });

  it("is idempotent under StrictMode's mount, unmount, mount", () => {
    // Both roots render inside `<StrictMode>` (src/v2/main.tsx), which double-invokes effects in dev:
    // subscribe, cleanup, subscribe. A store that leaked a listener or a timer across that pair would
    // do it on every mount of every consumer, in the environment the page is developed in.
    const stop = SECOND_TICK.subscribe(() => {});
    stop();
    expect(vi.getTimerCount()).toBe(0);
    subscribe();
    expect(vi.getTimerCount()).toBe(1);
  });
});
