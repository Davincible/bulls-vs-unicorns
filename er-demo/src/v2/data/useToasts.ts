// Transient messages. Deliberately NOT `src/state/store.ts` (zustand): v2 shares `chain/` and `sim/`
// with the original app by import, and nothing else — a shared mutable store would be a second,
// invisible coupling between two pages that are supposed to be independent.
//
// Capped at MAX_VISIBLE and auto-dismissed. Every pending timer is tracked so unmounting can't leave
// a `setState` scheduled against a dead component.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArenaContextValue, ToastItem, ToastKind } from "./types.ts";

const DISMISS_MS = 6000;
const MAX_VISIBLE = 5;

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
    }, DISMISS_MS);
    timersRef.current.add(timer);
  }, []);

  return { items, push };
}
