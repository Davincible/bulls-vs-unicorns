// Phase 6, snug-floating-mitten.md — the "start session" affordance. One click, one signature from
// the burner wallet, and every `enter()`/`extract()` after it signs silently through the session
// key instead: chain/session/useSessionKeyManager.ts explains the mechanism, this component is just
// the button and its three states (no session / creating / active).
//
// Deliberately dumb: takes a `SessionManager` (already built by App.tsx, which owns the
// wallet/connection/program-id wiring EnterForm.tsx and ExtractButton.tsx also need) and renders it.
// No chain calls of its own.

import { useState } from "react";
import type { SessionManager } from "../chain/session/useSessionKeyManager.ts";

function truncate(base58: string): string {
  return `${base58.slice(0, 4)}...${base58.slice(-4)}`;
}

export interface SessionButtonProps {
  session: SessionManager;
}

export function SessionButton({ session }: SessionButtonProps) {
  const { active, isLoading, error, createSession, revokeSession } = session;
  // `void createSession()` would drop a thrown error as an unhandled rejection — including the
  // useful pre-flight one ("wallet has X SOL but starting a session needs Y... fund it first"),
  // which would then be invisible to exactly the person who needs it. Caught and shown.
  const [localError, setLocalError] = useState<string | null>(null);
  const run = (fn: () => Promise<void>) => async () => {
    setLocalError(null);
    try { await fn(); } catch (e) { setLocalError(e instanceof Error ? e.message : String(e)); }
  };
  const shown = localError ?? error;

  return (
    <section aria-label="session">
      <h2>
        Session
        {/* State first, as a chip in the panel's own title bar. Whether a session is live changes
            what pressing Enter/Extract will DO (silent vs. a signature prompt), so it belongs where
            it can be read without parsing the sentence underneath. */}
        <span className={active ? "chip chip--ok" : "chip chip--muted"}>
          <span className="chip__dot" />
          {active ? "active" : "none"}
        </span>
      </h2>
      {active ? (
        <>
          <div className="session-row">
            <span className="prose">
              signing as <code title={active.signerPubkey.toBase58()}>{truncate(active.signerPubkey.toBase58())}</code> on
              behalf of your wallet
            </span>
            <button type="button" disabled={isLoading} onClick={() => void run(revokeSession)()}>
              {isLoading ? "revoking…" : "revoke session"}
            </button>
          </div>
          <p className="note">Enter and Extract no longer prompt for a signature.</p>
        </>
      ) : (
        <>
          {/* Deliberately NOT the gold primary treatment. Gold marks "the action that matters right
              now", and in this rail that is Enter (in Lobby) or Extract (in Fight) — a session is a
              precondition that makes those two quieter, not a third thing competing with them. Two
              gold buttons stacked in one rail would spend the accent and stop it meaning anything. */}
          <button
            type="button"
            className="btn--block"
            disabled={isLoading}
            onClick={() => void run(createSession)()}
          >
            {isLoading ? "starting…" : "Start session"}
          </button>
          <p className="note">
            One signature now, then Enter and Extract sign silently for the rest of this round.
          </p>
        </>
      )}
      {shown && (
        <p className="status-error" role="alert">
          {/* `String(...)` is not redundant defensiveness: gum types this channel as `string | null`
              and actually returns a SendTransactionError object, which React refuses to render and
              which took the whole page down before useSessionKeyManager started normalising it.
              Belt and braces — this component must not be the thing that white-screens a demo. */}
          session error: {String(shown)}
        </p>
      )}
    </section>
  );
}
