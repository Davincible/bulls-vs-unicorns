// The visible end of `state/store.ts`'s toast list — pulled out of App.tsx so the composition root
// stays wiring, and so the one behaviour a toast actually has (an info toast disappears by itself,
// an error one doesn't) lives next to the markup it governs.
//
// Scope, per snug-floating-mitten.md's 80/20 cuts: "one toast with the raw error message is enough,
// no per-error-type recovery flows." So this is a list, a colour, a role, and a timer — not a
// notification system. There is no queueing, no positioning API, no severity taxonomy beyond the
// info/error the store already has.
//
// Errors persist until dismissed on purpose: a failed `enter()` during a live demo is the exact
// message a presenter needs to still be able to read thirty seconds later, when they've finished
// talking and turned back to the screen. Successes are the opposite — they're confirmation of
// something you just watched happen, and they're the ones that accumulate across rounds.

import { useEffect } from "react";
import { useDemoStore, type Toast } from "../state/store.ts";

const INFO_TOAST_TTL_MS = 12_000;

interface ToastItemProps {
  toast: Toast;
  dismiss: (id: number) => void;
}

function ToastItem({ toast, dismiss }: ToastItemProps) {
  const { id, kind } = toast;

  useEffect(() => {
    if (kind !== "info") return;
    const handle = setTimeout(() => dismiss(id), INFO_TOAST_TTL_MS);
    return () => clearTimeout(handle);
  }, [id, kind, dismiss]);

  return (
    <li
      className={`toast toast--${kind}`}
      // `alert` interrupts a screen reader, `status` waits for a pause — which is the right split
      // here: a failure needs to be heard now, a signature confirmation does not.
      role={kind === "error" ? "alert" : "status"}
    >
      <span className="toast__message">{toast.message}</span>
      <button type="button" className="toast__dismiss" onClick={() => dismiss(id)} aria-label="dismiss">
        ×
      </button>
    </li>
  );
}

export function Toasts() {
  const toasts = useDemoStore((s) => s.toasts);
  // A zustand action, referentially stable for the store's lifetime — safe as an effect dependency
  // above without needing a `useCallback` wrapper here.
  const dismissToast = useDemoStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <ul className="toasts" aria-label="toasts">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} dismiss={dismissToast} />
      ))}
    </ul>
  );
}
