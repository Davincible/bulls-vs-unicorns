// The toast stack. Bottom-left, above the bottom chrome, column-reverse so the newest is nearest
// the eye — the same placement the original used. `aria-live="polite"` rather than "assertive":
// these announce raids and confirmations, and a fight produces enough of them that an assertive
// region would interrupt a screen reader continuously.

import { useArena } from "../data/useArena.ts";

const KIND_CLASS: Record<string, string> = {
  error: " toast--err",
  a: " toast--a",
  b: " toast--b",
  info: "",
};

export function ToastRail() {
  const { toasts } = useArena();

  return (
    <div className="toasts" aria-live="polite" aria-label="Notifications">
      {toasts.items.map((t) => (
        <div key={t.id} className={`toast${KIND_CLASS[t.kind] ?? ""}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
