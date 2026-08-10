// HOW THIS PAGE SIGNS — and why a player approves one thing a session instead of one thing a move.
//
// NO DURATION IS NAMED ANYWHERE BELOW, and that is deliberate rather than vague. A session's length
// is `SESSION_VALID_MINUTES` in `chain/session/useSessionKeyManager.ts` — private, unexported, and
// not ours to read; `sessionExpiry.ts` mirrors it by hand and is emphatic that everything derived
// from the mirror is an inference. This copy therefore says WHAT HAPPENS ("when it runs out the next
// move replaces it") and never HOW LONG, so that moving the constant cannot make a sentence here
// false. It already moved once — from one hour to twenty-four — and every sentence that had named
// the hour was wrong the moment it did, in the fixed chrome of a live site, with nobody re-reading
// it. Say the mechanism; let the countdown in the rail say the number.
//
// THE COMPLAINT THIS MODULE EXISTS TO ANSWER, from somebody playing the live site: "I still need to
// manually confirm every transaction, I thought with magicblock sessions we wouldn't have to." They
// were right. The session path worked — `useActions` has always preferred a session key when one
// exists, and a session-signed extract was measured landing in 424ms with no popup — but NOTHING IN
// THE APP EVER STARTED ONE. The only trigger was a `Start` button in the wallet rail, four clicks
// deep, under a row reading `Status: NOT STARTED`. A visitor connected Phantom, pressed Deploy, and
// approved a popup. Every time. Forever.
//
// SO THE SESSION IS NOT A FEATURE ANY MORE. It is how this app signs. Nothing asks the player
// whether they want one, because "would you like fewer wallet popups" is not a question worth a
// player's attention — it is the answer to a question they already have. The copy here DESCRIBES
// what is about to happen; it never seeks permission.
//
// THE ONE THING IT MUST NOT DO IS OVERSELL. Opening a session is a real transaction: it funds a
// throwaway key with 0.02 SOL so that key can pay for `enter`/`extract` itself, and it needs one
// signature from the real wallet. "No approvals" would be a lie. "One approval, then a session of
// silent play" is the truth and is a better story anyway.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHEN THE SESSION IS OPENED, AND WHY IT IS NOT ON CONNECT.
//
// Both timings cost the same two approvals before silent play begins (connecting Phantom is itself
// an approval), so the only question is where the second one lands. It lands on the first MOVE, and
// the argument is not about the 0.02 SOL — it is about which popups a player can explain:
//
//   · A wallet popup a moment after pressing DEPLOY is the most ordinary thing in this product. It
//     is exactly what pressing Deploy did yesterday. The player is not surprised by a prompt; they
//     are surprised, later and pleasantly, by its ABSENCE on every move after.
//   · A wallet popup a moment after pressing CONNECT is a prompt for a thing they did not ask for.
//     Worse, it would not always follow a press at all: `usePhantom` reconnects a trusted wallet
//     silently on load (see its `onlyIfTrusted` note), so "open a session on connect" would throw an
//     unrequested approval dialog at a returning visitor who has done nothing but open the page —
//     the precise bug that hook's comment records having already been fixed once.
//
// So: first deploy or first extract, and the copy below says so before it happens.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// PURE, AND REACT-FREE, for the reason `historyScan.ts` and `feeCopy.ts` are: this project has no
// browser test harness, so every decision worth trusting lives in a module a plain Node test can
// call. `runSigned` below is the whole orchestration — open, sign, recover — expressed against
// injected callbacks, so the ORDER of those steps is testable without a wallet, a chain or a DOM.

import type { WalletFaultCode } from "./walletFault.ts";
import type { SignerMode } from "./flags.ts";
import type { PlayBlock } from "./playGate.ts";
import type { SessionLife } from "./sessionExpiry.ts";

/**
 * MIRRORED CONSTANT — `SESSION_TOP_UP_LAMPORTS` in `chain/session/useSessionKeyManager.ts`, which is
 * private and which this workstream may not edit.
 *
 * Same discipline as `sessionExpiry.ts`'s `ASSUMED_SESSION_MINUTES`, and for the same reason: it is a
 * hand-copy of a number we do not control. Everything derived from it is COPY, never a gate. If the
 * top-up moves, this page quotes a stale figure in a sentence — it does not refuse anybody a move.
 */
export const ASSUMED_SESSION_TOP_UP_SOL = 0.02;

/** The top-up plus the headroom `createSession` adds for fees and rent before it will even try —
 *  mirrored from the same private function, and used only to decide whether attempting is pointless. */
export const ASSUMED_SESSION_START_SOL = 0.021;

/** Why this page is signing each move with the wallet instead of a session key. */
export type SessionOffReason =
  /** `?fixture=1` — nothing on screen is signed at all. */
  | "fixture"
  /** `?signer=burner` — a local keypair signs with no popup, so a session buys nothing and costs
   *  0.02 SOL. A developer who wants one anyway can still press Start. */
  | "burner"
  /** The player pressed Stop. An explicit instruction, and it outranks everything below. */
  | "stopped"
  /** The wallet cannot cover the top-up. NOT a reason they cannot play — see `signingPlan`. */
  | "unaffordable"
  /** Nothing can be signed at all yet (`playGate`), which has its own, better words. */
  | "blocked";

/** How the next `enter`/`extract` will be signed. */
export type SigningPlan =
  /** A session key is live and will sign it — no prompt. */
  | { kind: "session" }
  /** No session yet: open one (one approval), then sign the move with it. */
  | { kind: "open-then-session" }
  /** The wallet signs it directly, one approval for this one move. */
  | { kind: "wallet"; reason: SessionOffReason };

export interface SigningPlanInput {
  /** `?fixture=1`. The fixture's `enter`/`extract` are local state changes. */
  fixture: boolean;
  mode: SignerMode;
  /** False once the player has pressed Stop — see `SideRail`. */
  auto: boolean;
  sessionActive: boolean;
  /** Why nobody can act at all, or null. `playGate.ts`. */
  gate: PlayBlock | null;
  /** SOL, devnet. `null` means the first poll has not landed, which is NOT zero. */
  solBalance: number | null;
}

/**
 * A KNOWN balance that cannot cover the top-up. Unknown reads as affordable on purpose: the first
 * balance poll can land after the first press, and refusing to open a session over a number nobody
 * has read yet would send a funded player down the popup-per-move path for their first move.
 * `createSession` pre-flights the balance itself against a FRESH read, so the authority is there —
 * this only decides whether attempting is worth a round trip and a doomed approval dialog.
 */
export function canAffordSession(solBalance: number | null): boolean {
  return solBalance === null || solBalance >= ASSUMED_SESSION_START_SOL;
}

/**
 * HOW THE NEXT MOVE GETS SIGNED.
 *
 * THE ORDER IS THE POINT. An explicit Stop outranks every convenience below it; a live session
 * outranks the reasons not to open one, because it is already paid for. And a wallet that cannot
 * afford a session is NOT blocked from playing — `playGate` deliberately does not gate on the
 * top-up (a session is an ergonomic upgrade, not a precondition, and a wallet holding 0.005 SOL can
 * deploy and extract all day by approving each one). It simply gets the popup-per-move path, and
 * copy that says why.
 */
export function signingPlan(input: SigningPlanInput): SigningPlan {
  if (input.fixture) return { kind: "wallet", reason: "fixture" };
  if (input.sessionActive && input.auto) return { kind: "session" };
  // A revoke that failed leaves a usable session behind a player who asked for it to stop. Using it
  // anyway would make the Stop button a lie, which is the one thing it must never be.
  if (!input.auto) return { kind: "wallet", reason: "stopped" };
  if (input.mode === "burner") return { kind: "wallet", reason: "burner" };
  if (input.gate !== null) return { kind: "wallet", reason: "blocked" };
  if (!canAffordSession(input.solBalance)) return { kind: "wallet", reason: "unaffordable" };
  return { kind: "open-then-session" };
}

/** What to do when opening a session failed, given what the wallet said. */
export type OpenFailurePlan =
  /** Send NOTHING. The player cancelled, or the wallet is gone — either way the move they staged is
   *  still staged and the error names the cause. */
  | { kind: "abandon" }
  /** The session was unavailable for a reason that has no bearing on the move itself. The move goes
   *  through, signed by the wallet, one approval. */
  | { kind: "sign-with-wallet" };

/**
 * A CANCELLED SESSION MUST NOT BECOME A SIGNED DEPLOY.
 *
 * The alternative — quietly falling through and asking the wallet to sign the deploy instead — puts
 * a SECOND popup in front of somebody who just pressed Cancel on the first, for a transaction they
 * did not obviously ask for either. They would cancel that too, and be left with two dismissed
 * dialogs and no account of which one was the deploy. So a rejection ends the press exactly as a
 * rejected deploy has always ended a press: nothing sent, nothing spent, the stake and side still
 * sitting in the dock, and `walletFault`'s own "press the button again" copy on screen.
 *
 * `disconnected` and `not-installed` abandon for a different reason: there is no wallet left to sign
 * the move with either, so falling through would only re-throw the same fault one doomed popup later.
 *
 * Everything else — a failed balance pre-flight, an RPC that dropped the create, gum returning
 * without a token — is a failure of the OPTIONAL half of this. The player pressed Deploy; they get
 * their deploy.
 */
export function afterFailedOpen(fault: WalletFaultCode): OpenFailurePlan {
  return fault === "rejected" || fault === "disconnected" || fault === "not-installed"
    ? { kind: "abandon" }
    : { kind: "sign-with-wallet" };
}

/** What to do when the CHAIN refuses a session-signed transaction. */
export type RefusalPlan =
  /** Replace the session and send the same move again. The player sees a renewal, not an error. */
  | { kind: "renew-and-retry" }
  /** Hand the error to the caller. */
  | { kind: "report" };

/**
 * EXPIRY IS THE CASE THAT MATTERS MOST, and it is handled here rather than by the countdown.
 *
 * `sessionExpiry.ts` can only INFER when a session is up (gum carries no timestamp and the length is
 * a private const), and it is emphatic that the inference must never gate an action. This is the other
 * half it names: the AUTHORITATIVE signal, which is the chain itself refusing a session-signed
 * transaction with `InvalidToken` (`verify-session-base.mjs` step 5 proves an expired token fails
 * exactly that way). No constant, no clock, and it cannot be wrong.
 *
 * So a lapsed session is not an error a player has to read and act on — it is a renewal they watch
 * happen. ONE renewal per press: `alreadyRenewed` is what stops a genuinely broken session turning a
 * single Deploy into an unbounded loop of approvals.
 */
export function afterRefusal(fault: WalletFaultCode, alreadyRenewed: boolean): RefusalPlan {
  return fault === "session-expired" && !alreadyRenewed
    ? { kind: "renew-and-retry" }
    : { kind: "report" };
}

/** Everything `runSigned` needs from the outside world, so that none of it is in here.
 *
 *  Generic in the session type purely so the tests can drive it with a string: nothing in this
 *  module reads a field off a session, it only carries one from `open`/`renew` to `send`. */
export interface SessionSigning<S> {
  /** The session live RIGHT NOW — read at press time, never captured at render time. A session that
   *  arrived since this callback was built is one this move should be using. */
  current(): S | null;
  /** Open a fresh session. Throws what the wallet or the SDK said when it could not. */
  open(): Promise<S>;
  /** Close the session the chain has just refused and open a fresh one in its place. `null` when it
   *  could not be replaced — in which case the ORIGINAL refusal is the error worth reporting. */
  renew(): Promise<S | null>;
  classify(error: unknown): WalletFaultCode;
  /** Called when a failed `open` is about to be signed with the wallet instead. The move is not in
   *  danger and no dialog is owed; this is how the page gets to SAY that, once, rather than letting
   *  a silent downgrade look like the feature never existed. */
  onFallback(error: unknown): void;
}

/**
 * OPEN IF NEEDED, SIGN, AND RECOVER — the whole write path's session behaviour, in one place.
 *
 * `send` is handed the session to sign with, or `null` for a direct wallet signature. It is called
 * ONCE per attempt and at most twice in total (the second only after a renewal), so a caller may
 * book a confirmed deploy off its return value without worrying about double counting.
 */
export async function runSigned<S, R>(
  plan: SigningPlan,
  signing: SessionSigning<S>,
  send: (session: S | null) => Promise<R>,
): Promise<R> {
  if (plan.kind === "wallet") return send(null);

  let session = signing.current();
  if (session === null) {
    try {
      session = await signing.open();
    } catch (e) {
      if (afterFailedOpen(signing.classify(e)).kind === "abandon") throw e;
      signing.onFallback(e);
      return send(null);
    }
  }

  // Bounded by `afterRefusal`, which permits exactly one renewal — the second pass through this
  // loop can only report. A `while (true)` here would be one edit away from an approval loop.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send(session);
    } catch (e) {
      if (afterRefusal(signing.classify(e), attempt > 0).kind === "report") throw e;
      const fresh = await signing.renew();
      if (fresh === null) throw e;
      session = fresh;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------------------------

/** THE STATE, IN A WORD OR TWO — the rail's `Status` row, which used to read `NOT STARTED` beside a
 *  Start button nobody pressed. "Not started" was true and useless; what a reader wants to know is
 *  what will happen next, and in the ordinary case the answer is "it opens itself". */
export function sessionStatus(plan: SigningPlan): string {
  if (plan.kind === "session") return "ACTIVE";
  if (plan.kind === "open-then-session") return "OPENS ON YOUR NEXT MOVE";
  switch (plan.reason) {
    case "stopped":
      return "STOPPED";
    case "burner":
      return "NOT NEEDED — THE BURNER KEY SIGNS SILENTLY";
    case "unaffordable":
      return `NEEDS ABOUT ${ASSUMED_SESSION_START_SOL} SOL`;
    case "fixture":
      return "NOT USED IN FIXTURE MODE";
    case "blocked":
      return "NOT STARTED";
  }
}

/**
 * WHAT THE DEPLOY AND EXTRACT SURFACES SAY ABOUT SIGNING, or null when there is nothing worth
 * saying — and null is the common case by design. Once a session is live this copy DISAPPEARS: it
 * describes a thing that happens once, and a page still explaining it long afterwards is a page
 * charging rent on its own cleverness.
 *
 * `life` only ever adds the lapsing sentence, and it is written to survive the countdown being
 * wrong (it is an inference — see `sessionExpiry.ts`): "when it runs out" makes no claim about WHEN.
 */
export function sessionNote(plan: SigningPlan, life: SessionLife): string | null {
  if (plan.kind === "session") {
    if (!life.known || !life.lapsing) return null;
    return (
      `About ${life.minutesLeft} ${life.minutesLeft === 1 ? "minute" : "minutes"} left on this play ` +
      "session. When it runs out the next move renews it — two Phantom approvals, then a fresh one."
    );
  }

  if (plan.kind === "open-then-session") {
    return (
      `Your first move also opens a play session: one Phantom approval, ${ASSUMED_SESSION_TOP_UP_SOL} SOL to fund ` +
      "the key that signs for you. Every deploy and extract after it goes through with no prompt at " +
      "all, for as long as the session lasts."
    );
  }

  switch (plan.reason) {
    case "stopped":
      return (
        "Play sessions are off, so every move asks Phantom to approve it. Start one in the wallet " +
        "panel to go back to signing without prompts."
      );
    case "unaffordable":
      return (
        `Not enough devnet SOL to open a play session — it funds a key with ${ASSUMED_SESSION_TOP_UP_SOL} SOL so that ` +
        "key can sign for you — so every move asks Phantom to approve it. Top up and the prompts stop."
      );
    // Nothing to say. A burner signs with no prompt at all; the fixture signs nothing; and a blocked
    // player is already reading `playGate`'s account of why, which is the better one.
    case "burner":
    case "fixture":
    case "blocked":
      return null;
  }
}

/** WHAT THE SESSION MACHINERY IS DOING, when it is the thing a player is waiting on.
 *
 *  NOT gum's `isLoading`, which is flipped by ordinary session signing as well and is therefore true
 *  a hundred times an hour with nothing to approve — and which, worse, goes momentarily FALSE in the
 *  middle of a revoke, because gum nests one `withLoading` call inside another. Owned by
 *  `useSessionController` so that it means exactly one thing. */
export type SessionWork = "opening" | "renewing" | "stopping" | null;

/** WHAT THE MOVE IS WAITING ON, while it is waiting. The dock disables its buttons for the whole
 *  press — including the wallet dialogs, which the player has to go and find — so "Sending…" alone
 *  would be describing the wrong half of the wait.
 *
 *  A RENEWAL AND AN OPENING ARE DIFFERENT SENTENCES BECAUSE THEY ARE DIFFERENT COSTS: opening is one
 *  approval, replacing is two (the old key has to be closed before a new one can be opened — see
 *  `useSessionController`). This is the only string GUARANTEED to be on screen when a renewal starts:
 *  `sessionNote`'s warning needs `life.known`, and a session restored from a previous visit has no
 *  local record of when it began, which `sessionExpiry.ts` calls out as a common state rather than an
 *  edge one. So the count belongs here, or a player mid-extract meets a second dialog unannounced. */
export function pendingNote(work: SessionWork): string {
  switch (work) {
    case "opening":
      return "Opening your play session — approve it in Phantom and the move goes through straight after.";
    case "renewing":
      return "Your play session ran out. Replacing it takes two approvals in Phantom — the move goes through straight after.";
    // The player pressed Stop in the rail. Rare to be on screen at all (it needs a move in flight at
    // the same moment), but "your session ran out" would be a plain untruth about a dialog they
    // deliberately asked for, and the dialog is what they are looking at.
    case "stopping":
      return "Closing your play session — approve it in Phantom.";
    case null:
      return "Sending — the buttons come back when it lands or fails.";
  }
}

/**
 * THE WALLET RAIL'S ACCOUNT OF ITSELF — the paragraph under Start/Stop.
 *
 * It reads the plan for the same reason the `Status` row two lines above it does: the panel used to
 * branch on `auto` alone, so it told a burner developer and a `?fixture=1` reviewer that "the first
 * move you make opens it" directly beneath a status line saying the opposite. One input, one story.
 */
export function sessionPanelNote(plan: SigningPlan): string {
  const openingCost = `a single approval and ${ASSUMED_SESSION_TOP_UP_SOL} SOL to fund the key`;
  // Why any of this matters, said once and shared: it is the argument for the whole feature.
  const whyItMatters =
    "Extracting mid-fight is a race against whoever settles the round, and a wallet popup in the " +
    "middle of it costs you the round — which is exactly what this removes.";

  if (plan.kind === "session") {
    return (
      "A session key is signing your deploys and extracts, so your wallet is not being asked to. It " +
      `runs until it expires, and when it runs out the next move replaces it. ${whyItMatters}`
    );
  }
  if (plan.kind === "open-then-session") {
    return (
      "A session key signs your deploys and extracts so your wallet does not have to. Your next move " +
      `opens one — ${openingCost} — so you need not touch this panel at all. ${whyItMatters}`
    );
  }

  switch (plan.reason) {
    case "stopped":
      return (
        "Stopped, so every deploy and extract asks your wallet to approve it. Start opens a fresh " +
        `session key — ${openingCost}, and signing without prompts for as long as it lasts — and the page goes back to ` +
        "opening one for you whenever there isn't one."
      );
    case "burner":
      return (
        "The burner key signs your deploys and extracts itself, with no wallet and no popups — so a " +
        `session key would buy nothing here and would cost ${ASSUMED_SESSION_TOP_UP_SOL} SOL to open. Start opens one ` +
        "anyway, which is how the session path gets exercised without a wallet in front of it."
      );
    case "unaffordable":
      return (
        `Not enough devnet SOL to open one — it funds a key with ${ASSUMED_SESSION_TOP_UP_SOL} SOL so that key can sign ` +
        "for you — so every deploy and extract asks your wallet to approve it. Top up and the next " +
        "move opens a session."
      );
    case "fixture":
      return (
        "Nothing on this page is signed while ?fixture=1 is on — the round, the fighters and the " +
        "money are all invented. Start and Stop move a stand-in flag, so the session states can be " +
        "read without a wallet."
      );
    // Not connected, no SOL, no program. The block above already says which, and once it clears this
    // reader is the ordinary one — so they get the ordinary description of what is about to happen.
    case "blocked":
      return (
        "A session key signs your deploys and extracts so your wallet does not have to. Your first " +
        `move opens one — ${openingCost} — so you need not touch this panel at ` +
        `all. ${whyItMatters}`
      );
  }
}
