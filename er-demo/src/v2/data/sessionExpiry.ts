// HOW LONG A SESSION KEY HAS LEFT — inferred, labelled as inferred, and never allowed to stop
// anyone doing anything.
//
// THE PROBLEM. A session key is what makes a mid-fight `extract()` land without a wallet popup, and
// it lasts an hour. Nothing in this app can read that expiry back: gum-react-sdk's session object
// carries no timestamp, and the sixty minutes is a PRIVATE const (`SESSION_VALID_MINUTES`) inside
// `chain/session/useSessionKeyManager.ts`, which this workstream may not edit and which does not
// export it. So a session silently lapses and the next `extract` — mid-fight, in the exact seconds
// this feature exists to keep smooth — fails with `InvalidToken`.
//
// THE ANSWER IS TWO-PART, and the second part is the real one:
//
//   1. ADVISORY (this file). We record when WE started a session and count forward from a mirrored
//      constant. That is an inference from a number we do not control, so everything it produces is
//      hedged ("about"), and it MUST NEVER BLOCK AN ACTION. If this file says a session has lapsed
//      and the chain disagrees, the chain is right; a player who presses Extract anyway gets their
//      transaction sent. Refusing on this evidence would be inventing a rule out of a guess.
//   2. AUTHORITATIVE (`useActions` + `walletFault.ts`). When the chain actually refuses a
//      session-signed transaction, `classifyWalletError` returns `session-expired` and the copy says
//      to start a new one. That path needs no constant and cannot be wrong.
//
// WHY BOTHER WITH (1) AT ALL, then. Because (2) costs a failed transaction inside a running fight,
// and a player who is told "about eight minutes left, start a fresh one before the next round" never
// pays it. A warning that is occasionally early is worth much more here than a diagnosis that is
// always exactly on time.
//
// KEYED BY TOKEN PDA, because that address IS the identity of the session (it is derived from the
// program, the session signer and the authority — see `useSessionKeyManager.ts`). A session restored
// from a previous visit, or minted for a different wallet, therefore reads as `{ known: false }`
// rather than inheriting some other session's clock, which is the honest answer and the one the UI
// can say out loud.

/**
 * MIRRORED CONSTANT — `SESSION_VALID_MINUTES` in `chain/session/useSessionKeyManager.ts`, which
 * passes it to gum's `createSession` as "minutes from now".
 *
 * It is a hand-copy, and this file is built so that the copy going stale is survivable rather than
 * wrong: every number derived from it is presented as approximate, and nothing is gated on it. If
 * the SDK call ever changes, this drifts and the page's countdown becomes imprecise — it does not
 * become a lie about whether you may play.
 */
export const ASSUMED_SESSION_MINUTES = 24 * 60;

/** Under this and the UI starts suggesting a fresh session rather than merely reporting the clock.
 *
 *  IT IS SIZED AGAINST WHAT A PLAYER MIGHT BE IN THE MIDDLE OF, not against the session's length, so
 *  taking the session from one hour to twenty-four did not move it. Ten minutes still comfortably
 *  outlasts one round — a lobby plus a fight capped at 120s — which is the thing the nudge exists to
 *  avoid interrupting. Scaling it with the session (2.4 hours at a day) would start nagging about a
 *  key that has most of a working day left in it. */
export const LAPSING_WITHIN_MINUTES = 10;

const STORAGE_PREFIX = "v2_session_started:";

/** Storage is a privilege, not a guarantee — private mode, embedded frames and hardened profiles all
 *  throw on access. Every read and write here is wrapped for the same reason `App.tsx` wraps its
 *  intro flag: losing the advisory is a small thing, and taking the page down over it is not. */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Called once, after `createSession` actually succeeds — never on the attempt. */
export function noteSessionStarted(tokenPda: string, nowMs: number): void {
  try {
    safeStorage()?.setItem(`${STORAGE_PREFIX}${tokenPda}`, String(nowMs));
  } catch {
    /* Nothing to do: the session still works, its countdown is simply unknown. */
  }
}

/** Epoch ms, or null when this browser has no record of when this particular session began. */
export function readSessionStartedAt(tokenPda: string): number | null {
  try {
    const raw = safeStorage()?.getItem(`${STORAGE_PREFIX}${tokenPda}`);
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    // A hand-edited or corrupted value must read as "unknown", not as a session that began at the
    // epoch and has therefore been expired for fifty years.
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function forgetSession(tokenPda: string): void {
  try {
    safeStorage()?.removeItem(`${STORAGE_PREFIX}${tokenPda}`);
  } catch {
    /* See `noteSessionStarted`. */
  }
}

export type SessionLife =
  /** No record of when this session started — restored from a previous visit, or storage is blocked.
   *  The UI says so plainly rather than inventing a clock. */
  | { known: false }
  | {
      known: true;
      startedAtMs: number;
      /** Rounded up, floored at 0. Approximate by construction — see `ASSUMED_SESSION_MINUTES`. */
      minutesLeft: number;
      /** Time to suggest starting a fresh one, before it matters mid-fight. */
      lapsing: boolean;
      /** Believed to be past its hour. ADVISORY: the chain decides, and it may still work. */
      lapsed: boolean;
    };

/** Pure. `startedAtMs` comes from `readSessionStartedAt`; `nowMs` from the caller's clock. */
export function sessionLife(startedAtMs: number | null, nowMs: number): SessionLife {
  if (startedAtMs === null) return { known: false };
  // A record from the future is a clock change or a corrupted write, not a session with extra life.
  // Treating it as unknown is safer than promising minutes nobody can rely on.
  if (startedAtMs > nowMs) return { known: false };

  const elapsedMinutes = (nowMs - startedAtMs) / 60_000;
  const remaining = ASSUMED_SESSION_MINUTES - elapsedMinutes;
  const minutesLeft = Math.max(0, Math.ceil(remaining));
  return {
    known: true,
    startedAtMs,
    minutesLeft,
    lapsed: remaining <= 0,
    // A lapsed session is also lapsing — a caller checking only `lapsing` to decide whether to nudge
    // must not go quiet at the moment the nudge matters most.
    lapsing: remaining <= LAPSING_WITHIN_MINUTES,
  };
}
