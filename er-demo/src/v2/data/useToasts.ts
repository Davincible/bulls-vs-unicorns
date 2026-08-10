// Transient messages. Deliberately NOT `src/state/store.ts` (zustand): v2 shares `chain/` and `sim/`
// with the original app by import, and nothing else — a shared mutable store would be a second,
// invisible coupling between two pages that are supposed to be independent.
//
// Capped at MAX_VISIBLE and auto-dismissed AFTER AS LONG AS IT TAKES TO READ THE THING — see
// `dismissMs`, which is the whole of the interesting behaviour in this file. Every pending timer is
// tracked so unmounting can't leave a `setState` scheduled against a dead component.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArenaContextValue, ToastItem, ToastKind } from "./types.ts";

/** THE FLOOR, and it is the number this file has always used. A receipt is glanceable — "Deployed $20
 *  to ANSEM" is read in under a second — and six seconds of it is already generous. Nothing that fits
 *  in a glance changes behaviour at all. */
export const MIN_DISMISS_MS = 6000;

/** THE CEILING. Past this a message has stopped being a receipt and started being furniture, and the
 *  stack only holds `MAX_VISIBLE`, so one long-lived toast is a slot the next one cannot have. */
export const MAX_DISMISS_MS = 20_000;

/** Roughly 180 words a minute — deliberately under a comfortable prose rate, because nobody reads a
 *  corner toast the way they read a paragraph: they are watching a fight, and the toast is competing
 *  with it. */
const WORDS_PER_MS = 3 / 1000;

/** A second and a half to NOTICE the thing before any of it can be read. */
const NOTICE_MS = 1500;

const MAX_VISIBLE = 5;

/**
 * HOW LONG A MESSAGE STAYS UP, AS A FUNCTION OF HOW LONG IT TAKES TO READ.
 *
 * THE DEFECT THIS CLOSES. Every toast on this page used to hold for six seconds flat, and the copy
 * this page pushes through it is not one length. `walletFault.ts`'s faults and `entryWindow.ts`'s
 * refusals are forty to fifty words each — deliberately, because each carries what is true, what it
 * cost and what to do next, which is SPEC.md's rule and is not compressible below about that. Forty
 * words in six seconds is not a message; it is a glimpse of one. The single most important sentence
 * this app can show somebody — "the round closed while you were approving, nothing was taken, press
 * again" — was the sentence most certain to vanish before it was finished.
 *
 * A FIXED LONGER TIMEOUT WOULD HAVE BEEN THE WRONG FIX, which is why this is a function: it would
 * leave "Deployed $20 to ANSEM" parked in the corner for twenty seconds, hogging one of five slots
 * during a fight that is producing receipts faster than that.
 *
 * EVICTION STILL WINS OVER THE CLOCK, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT. `push` below
 * drops the OLDEST when the stack is full, so five rapid receipts can retire a twenty-second refusal
 * early. Making eviction time-aware was considered and rejected: reaching `MAX_VISIBLE` inside twenty
 * seconds means the reader is pressing things, and the account of what just happened is worth more to
 * them than the account of what happened four presses ago. The fight's own commentary cannot cause it
 * — `useCombatVoice` has its own list precisely so a busy round cannot push a failed transaction off
 * the screen (see `ToastRail.tsx`) — so the only way to lose a refusal early is to generate four more
 * receipts yourself.
 *
 * Exported and pure so the arithmetic is a unit test rather than a stopwatch.
 */
export function dismissMs(text: string): number {
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  const needed = NOTICE_MS + words / WORDS_PER_MS;
  return Math.min(MAX_DISMISS_MS, Math.max(MIN_DISMISS_MS, Math.round(needed)));
}

export function useToasts(): ArenaContextValue["toasts"] {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seqRef = useRef(0);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const push = useCallback((text: string, kind: ToastKind = "info") => {
    const id = ++seqRef.current;
    setItems((current) => [...current.slice(-(MAX_VISIBLE - 1)), { id, text, kind }]);
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      setItems((current) => current.filter((x) => x.id !== id));
    }, dismissMs(text));
    timersRef.current.add(timer);
  }, []);

  return { items, push };
}
