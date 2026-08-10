// HOW LONG THIS PAGE MAY GO ON SAYING "PHANTOM IS WAITING ON YOU" — one bound, one argument, and a
// state for the moment that sentence stops being one we are entitled to.
//
// THE DEFECT THIS EXISTS AGAINST. `usePhantom.ts#runConnect` awaits `adapter.connect()` with nothing
// bounding it. Read off the compiled adapter itself
// (`node_modules/@solana/wallet-adapter-phantom/lib/cjs/adapter.js`, v0.9.29): there is no timeout,
// no `AbortSignal` and no race anywhere on the path from `adapter.connect()` down to
// `window.phantom.solana.connect()`. So when the extension never answers — a dead MV3
// content-script bridge after a Phantom auto-update, a request queued behind a popup another tab
// owns, a locked wallet whose unlock screen was dismissed — that promise simply never settles.
// `runConnect`'s `finally` never runs, the connecting flag latches true for the life of the tab, and
// `playGate` returns "waiting for you to approve the connection in Phantom" permanently, with no
// route out but a page reload nobody has been told to perform. The owner hit exactly this.
//
// SO THIS IS `useActions.ts#stopWaiting`'S DOCTRINE APPLIED TO THE ONE HAZARD THAT FILE'S OWN HEADER
// LISTS FIRST AND LEAVES UNCOVERED. Read the argument there (`stopWaiting`, and the note above
// `SEND_PATIENCE_MS`) before changing anything here; it is the same argument and it is made better
// there. It cancels nothing, because there is nothing to cancel: the request is sitting inside an
// extension this page holds no handle on. It reports neither a success nor a failure, because it
// knows neither. It reports the third thing, which is the only true one — we are no longer waiting.
//
// WHAT THE BOUND IS NOT. It is not "how long a human takes to approve a dialog". That is unbounded,
// and it is none of this page's business: a player can read the popup, go and make coffee, approve
// it four minutes later, and that approval still lands (`onConnect` fires and clears this on its
// own). The bound answers a different and much smaller question — HOW LONG BEFORE THE CLAIM
// *PHANTOM IS WAITING ON YOU* IS A CLAIM THIS PAGE CAN NO LONGER MAKE. It is a statement about the
// player, and this page cannot verify that a popup was ever shown to anybody. It asked; it has heard
// nothing back; whether there is a dialog on that screen is precisely the fact it does not have.
//
// TWENTY SECONDS, AND WHERE THAT COMES FROM. It has to clear the slowest path on which the popup IS
// visible and the player IS engaged, because softening the sentence while somebody is reading the
// very dialog it describes would be a worse page than the defect. Read-and-approve is about five
// seconds. Unlock-then-approve — password first, then the dialog — is about fifteen. Twenty is
// comfortably past both, and it is nowhere near the coffee break, which this deliberately does not
// try to bound and does not need to.
//
// WHY THIS IS A SIXTH OF `SEND_PATIENCE_MS`, WHICH IS PRINCIPLED RATHER THAN CARELESS. A send has
// money in it. Giving up early on a signature invites a player to deploy twice into one round, so
// there patience is cheap and haste is expensive, and 120s buys the whole life of the blockhash the
// transaction was built against. A connect has nothing at stake, nothing that can double, and —
// because stopping the wait cancels nothing — no second attempt for a late answer to race. Being
// EARLY here costs one softened sentence and one button. Being LATE costs a player a false sentence
// with no way out of it. The asymmetry in the numbers is the asymmetry in those two costs.
//
// AND IT FIRES LATE RATHER THAN EARLY, WHICH IS THE SAFE DIRECTION. A backgrounded tab throttles its
// timers to roughly one a second — `ArenaProvider.tsx:822-824` makes the same allowance for the same
// reason, and a tab whose owner is reading a wallet dialog is exactly a backgrounded tab. So the
// wall-clock time elapsed when this fires is at least the bound and may be a little more. It can
// never be less, so this can never overtake a player who is genuinely being asked something.
//
// PURE AND REACT-FREE, so `connectPatience.test.ts` drives every branch in Node. The hook holds one
// timer and asks this module both WHEN to set it and WHAT IT MEANS when it goes off, so the schedule
// and the verdict are the same arithmetic and cannot drift into disagreeing.

/** @see this file's header for the whole argument. Twenty seconds is a bound on a SENTENCE, not on a
 *  person. */
export const CONNECT_PATIENCE_MS = 20_000;

/** The same bound in the unit the copy states it in, so no sentence on this page can name a number
 *  the code does not use. The rule `patienceMinutes` already follows in `useActions.ts`: derive it,
 *  never retype it, or the day the bound moves is the day the page starts lying about it. */
export const CONNECT_PATIENCE_SECONDS = Math.round(CONNECT_PATIENCE_MS / 1000);

/**
 * ONE HANDSHAKE, THREE READINGS — and deliberately ONE value rather than a boolean with a second
 * boolean beside it.
 *
 * `usePhantom` already carries two refs whose whole job is to stop two facts about one action from
 * disagreeing (`selfDisconnecting`, `inFlight`), and both cost real incidents to learn. A parallel
 * `stalled` flag would be a third of those: two pieces of state describing one attempt, with a
 * window in which they say different things. So the state that already existed is WIDENED instead.
 *
 *   `idle`    — no handshake this page started is outstanding.
 *   `asked`   — we asked, and we are within our rights to say the player is being asked.
 *   `stalled` — we asked, nothing has come back, and we have stopped claiming to know why.
 *
 * `stalled` IS STILL PENDING. It is not a failure and must never be rendered as one: the promise is
 * still live, and a late approval settles it through `onConnect` exactly as an early one would, at
 * which point this returns to `idle` on its own. `startedAtMs` is carried through the transition so
 * the value remains a description of one attempt rather than a fresh fact about a new one.
 */
export type ConnectWait =
  | { kind: "idle" }
  | { kind: "asked"; startedAtMs: number }
  | { kind: "stalled"; startedAtMs: number };

/** True while a handshake this page started has not settled — feeds `statusForReadyState`.
 *
 *  STALLED COUNTS. The attempt really is outstanding, `adapter.connect()` really will resolve if the
 *  extension ever answers, and reporting `disconnected` here would offer a Connect button that the
 *  adapter's `if (this.connected || this.connecting) return` guard would silently discard. What
 *  changes at the bound is what the page SAYS, not what it believes about the wallet. */
export function isConnecting(wait: ConnectWait): boolean {
  return wait.kind !== "idle";
}

/** Has the wallet been silent long enough that "waiting for you" is a claim we can no longer make? */
export function hasStalled(wait: ConnectWait): boolean {
  return wait.kind === "stalled";
}

/**
 * Milliseconds until `asked` becomes `stalled`, or `null` when nothing is scheduled.
 *
 * IT DRIVES THE ONE TIMER, so the schedule and the verdict come out of the same arithmetic and
 * cannot disagree — the alternative is a hook that sets a timeout from one constant and a gate that
 * decides from another, which agree until somebody edits one of them.
 *
 * CLAMPED AT ZERO, because a `nowMs` past the deadline is a real arrival rather than a bug: a
 * throttled tab can hand us the first tick well after the bound (see the header), and a negative
 * delay handed to `setTimeout` is coerced to zero anyway. Saying zero is saying "now", which is the
 * honest reading.
 */
export function msUntilStalled(wait: ConnectWait, nowMs: number): number | null {
  if (wait.kind !== "asked") return null;
  return Math.max(0, wait.startedAtMs + CONNECT_PATIENCE_MS - nowMs);
}

/**
 * THE TRANSITION, AS A REDUCER OVER THE CURRENT VALUE — `asked` becomes `stalled` and everything
 * else is handed back untouched.
 *
 * A REDUCER RATHER THAN A VALUE, AND THAT IS THE LOAD-BEARING PART. The timer is set against the
 * `wait` that was current when the effect ran, and between then and the callback the handshake can
 * settle: `onConnect`, `onDisconnect`, `onError` and `runConnect`'s `finally` all write `idle`.
 * Passing a captured value would let a timer that has already been outrun resurrect a wait that
 * finished — a stalled panel over a connected wallet. Passing the transition instead means a settle
 * that landed first always wins, because by then there is no `asked` left to stall.
 */
export function stall(wait: ConnectWait): ConnectWait {
  return wait.kind === "asked" ? { kind: "stalled", startedAtMs: wait.startedAtMs } : wait;
}
