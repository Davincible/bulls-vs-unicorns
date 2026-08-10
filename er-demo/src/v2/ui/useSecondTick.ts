// A ONE-HERTZ CLOCK, for the handful of places that show a countdown.
//
// A deadline is a time, not a phase, and nothing else on this page re-renders on time alone: `live`
// only changes when a poll lands or, during Fight, on the provider's 250ms clock — neither of which
// runs down a lobby. Without a tick of its own a countdown would sit frozen at whatever second the
// last poll happened to arrive on.
//
// ONE SECOND, NOT A FRAME. The figures are read at second resolution (`clock()`), so a
// `requestAnimationFrame` loop would re-render the world sixty times a second to change a string
// once. Same pattern and the same reasoning as `data/useAutoDeploy.ts`'s evaluation clock.
//
// `active` gates the tick so a settled round with nothing counting down costs nothing.
//
// ---------------------------------------------------------------------------------------------
// ONE INTERVAL FOR THE WHOLE PAGE, AND WHY THAT IS A CORRECTNESS PROPERTY RATHER THAN A SAVING.
//
// This used to be `useState` + `setInterval` PER CALLER. Each consumer therefore started its own
// interval at its own mount time, and two intervals started 700ms apart stay 700ms apart forever —
// so the same countdown, rendered by two components, would step at two different instants and sit a
// full second apart in between. Every consumer reads `Date.now()`, so the two were never WRONG; they
// were just never simultaneously right.
//
// That was survivable while the surfaces showing a countdown showed DIFFERENT countdowns. It stopped
// being survivable when the round clock started counting the bell down: the bell is now the figure in
// 00-1's hero, in the top bar, painted a foot wide across the middle of the field, on the sticky
// strip and beside the Extract button, and those are on screen together. Photographed at 1440x950
// mid-fight, before this changed: `1:50` on the field and `1:49` in the extract panel, four inches
// apart. A reader cannot tell a one-second skew from a broken readout, and the page's whole claim is
// that its figures are checkable.
//
// So the tick is a single module-level interval with a shared instant, read through
// `useSyncExternalStore` — which is the hook that exists for exactly this: every subscriber renders
// from ONE snapshot, and React guarantees they cannot tear. The interval starts with the first active
// subscriber and stops with the last, so an idle page still costs nothing.

import { useSyncExternalStore } from "react";

/** The shared instant. Every consumer of this module reads this same number on any given render. */
let nowMs = Date.now();

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  nowMs = Date.now();
  // Copied before iterating: a listener is free to unsubscribe as a result of the re-render this
  // notification causes, and mutating the set under its own `for…of` is how that becomes a skipped
  // subscriber rather than an unsubscription.
  for (const listener of [...listeners]) listener();
}

/** Subscribe for an ACTIVE consumer. Stable identity, which `useSyncExternalStore` requires — a new
 *  function per render would tear the subscription down and build it again every second. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    // THE INSTANT IS REFRESHED WITH THE INTERVAL, not left at whatever it was when the tick last
    // stopped. Otherwise a page that sat on a settled round for five minutes and then opened a lobby
    // would render one frame of a five-minute-old `Date.now()` — a visibly wrong countdown, for up to
    // a second, at the exact moment somebody started reading it. Safe to mutate here: React re-reads
    // the snapshot after `subscribe` returns and re-renders if it moved, which is the contract this
    // hook is built on. While the interval is already running there is nothing to refresh — the
    // shared instant is at most a second old, and being a second behind IN STEP with every other
    // surface is the property this module exists to provide.
    nowMs = Date.now();
    timer = setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** …and for an inactive one. It still reads the shared instant — so a component that switches
 *  `active` on is already correct on the paint that switches it, exactly as the old initial
 *  `Date.now()` was — it simply never asks to be woken. */
function subscribeNever(): () => void {
  return () => {};
}

function getSnapshot(): number {
  return nowMs;
}

/**
 * THE STORE, EXPORTED, BECAUSE IT IS THE HALF THAT CAN BE TESTED.
 *
 * Everything above is a `useSyncExternalStore` store in the ordinary sense — a `subscribe` and a
 * `getSnapshot` — and the hook below is four tokens of adapter over it. That split is deliberate: the
 * risky logic here is the interval's lifecycle (start on the first subscriber, stop on the last,
 * refresh the instant on restart) and the shared-instant invariant (two subscribers can never read
 * two different numbers), and NEITHER of those is a rendering question.
 *
 * This repo's unit suite is pure — no jsdom, no testing-library — so a hook cannot be rendered in it,
 * and a shared clock whose only coverage is "the arena screen looked right in Playwright" is a shared
 * clock with no coverage of the case that actually bites: the second subscriber. Exporting the store
 * puts the whole of that under `useSecondTick.test.ts` with fake timers and no browser.
 *
 * NOT a general-purpose API. Nothing in the app should import this — components want the hook, which
 * is the thing that keeps them subscribed and re-rendered. It is exported for the test and for the
 * reader who wants to see that the two halves are separable.
 */
export const SECOND_TICK = { subscribe, getSnapshot } as const;

export function useSecondTick(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : subscribeNever, getSnapshot, getSnapshot);
}
