// The two write paths: `enter()` and `extract()`. Built exactly as `src/ui/EnterForm.tsx` and
// `src/ui/ExtractButton.tsx` build them — `chain/round.ts`'s instruction builders into
// `chain/sendTx.ts`'s proven, account-aware send path, never `AnchorProvider.rpc()` (see sendTx.ts's
// "SDK SURPRISE #1" for what that costs).
//
// THE PLAYER/SIGNER SPLIT, once, for both. `player` is the fighter identity the chain credits —
// the burner's pubkey, or the connected wallet's — session or not. `signer` is whoever actually
// signs: the session key when a session is live, otherwise the identity's own signer (a raw
// `Keypair` in burner mode, the wallet's async `signTransaction` in wallet mode; `sendTx` accepts
// either). `sessionToken` must be an EXPLICIT `null` in the second case, not an omitted key
// (chain/program.ts's `MethodsBuilder` doc comment explains why Anchor's resolver needs it that way).
//
// THE SESSION IS RESOLVED PER PRESS, NOT PER RENDER, and that is what makes it the DEFAULT path
// rather than an opt-in one. `autoSession.ts`'s `runSigned` decides — open one first, use the live
// one, renew a lapsed one, or sign directly — and hands the answer to the builders below. Reading it
// out of the render closure instead would be subtly, expensively wrong: gum's `createSession`
// resolves `void` and the new session only reaches this component on a LATER render, so the very
// first deploy after opening a session would still be built with `sessionToken: null` and would open
// a second Phantom popup — the exact defect this path exists to remove.
//
// NOBODY MAY BE PLAYING AT ALL, and that is the state this file gained when the page stopped minting
// a burner for every visitor. `player`/`fallbackSigner` are null until a wallet connects, and every
// path out of that is a REFUSAL WITH A SENTENCE rather than a crash: `blocked` carries the same copy
// the disabled controls are already showing, so a press that slips past a disabled button (a stale
// render, a keyboard shortcut, the repeat rule firing) answers the player instead of throwing a
// TypeError into a toast.
//
// ERRORS COME BACK AS THE CHAIN'S OWN WORDS, WITH TWO SETS OF EXCEPTIONS. A presenter can read
// "custom program error: NothingToExtract" aloud and no paraphrase is more useful, so `unknown`
// failures are re-thrown verbatim. What IS re-written is anything whose real message names a symptom
// and hides the cause:
//
//   · Three WALLET faults — a cancelled popup, an expired blockhash, a lapsed session key. The
//     `REWRITTEN` set below, worded by `walletFault.ts`.
//   · Three PROGRAM refusals of `enter`, and only of `enter` — the round moved on, the lobby closed,
//     the room filled. Worded by `entryWindow.ts`, which also refuses to SEND the ones it can see
//     coming. Those three are re-written for a reason none of the others share: through the Magic
//     Router the chain's own words are `custom program error: 0x1772` and nothing else — no logs, no
//     error name (see that module's header for the measurement). There is no verbatim message worth
//     keeping, and the player did nothing and can do nothing about any of them.
//
// A PRESS IS BOUNDED, AND IT DID NOT USED TO BE. `entering`/`extracting` shut every Deploy and
// Extract control on the page for the whole of a press, which is right — the press now spans a
// wallet dialog and a second press landing mid-approval would raise a second one. What made it a
// defect was that the whole of a press had no end: `wallet.signTransaction()` resolves when the
// player answers the dialog and NEVER resolves if they don't. A dialog dismissed by a browser
// restart, lost behind a window, or simply ignored therefore left both flags true for the lifetime
// of the tab — every button dead, the repeat rule holding on `busy` forever, and nothing on screen
// saying why. The page was wedged until a reload. `stopWaiting` below is the bound, and the third
// answer it gives is the honest one: not a success, not a failure, but "we stopped waiting".
//
// THE UNATTENDED SENDER IS A SEPARATE FUNCTION, AND IT IS BOUNDED TOO. `enterUnattended` routes
// through `autoPolicy.ts`'s `runUnattendedEntry`, which cannot open a session, cannot renew one, and
// cannot fall back to the wallet — see that module's header for the incident, and this file's
// `enterUnattended` for why the absence of those paths is the specification rather than a setting.
// There is no `extractUnattended` and there must never be one (`SOCIAL.md` §5, §1.1).
//
// An earlier draft of this file argued that the unattended path needed no bound, because it raises
// no dialog and everything left in it is bounded by the blockhash. That was wrong on its first step
// and is worth recording as a wrong turn rather than quietly correcting: the blockhash FETCH comes
// before the blockhash exists, and it is a bare `fetch` with no timeout. On the one path that runs
// with nobody watching, a hang there left `entering` true for the tab's lifetime AND parked the rule
// on a `sending` attempt that `expireStaleAttempt` deliberately refuses to expire — a rule that goes
// permanently silent under a status line reading "Depositing into round 42…", with no toast and no
// error. The path with nobody watching it is the last one that may be left unbounded.

import { useCallback, useMemo, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";
import { AnchorError } from "@coral-xyz/anchor";
import { enter as buildEnter, extract as buildExtract, tick as buildTick } from "../../chain/round.ts";
import { MAX_STEPS_PER_CALL, PHASE_NAME, finalCursor } from "../../chain/constants.ts";
import { loadIdl } from "../../chain/idl.ts";
import { sendTx, type TxSigner } from "../../chain/sendTx.ts";
import { bnOr0, type BullsArenaProgram } from "../../chain/program.ts";
import type { ActiveSession } from "../../chain/session/useSessionKeyManager.ts";
// `MAX_FIGHTERS` comes from the sim rather than `chain/constants.ts`, which does not carry it — the
// same import `data/combatFeed.ts` makes, for the same reason.
import { MAX_FIGHTERS } from "../../sim/erSim.ts";
import { unitsToUsd, type LiveRound, type Side } from "../contract.ts";
import { runUnattendedEntry } from "./autoPolicy.ts";
import { runSigned, type SessionSigning, type SigningPlan } from "./autoSession.ts";
import {
  enterErrorCodes,
  entryRefusal,
  entryRefusedError,
  refusalFromProgramError,
  refusalOf,
  type EntryWindow,
} from "./entryWindow.ts";
import { extractEligibility } from "./extractTerms.ts";
import { NO_WALLET_MESSAGE } from "./identity.ts";
import type { PlayBlock } from "./playGate.ts";
import { errorCodeOf, errorText, failedWith } from "./programError.ts";
import type { ArenaContextValue, ToastKind } from "./types.ts";
import { classifyWalletError } from "./walletFault.ts";

/** The three whose original text is NOT the answer — everything else is re-thrown verbatim. */
const REWRITTEN = new Set(["rejected", "wrong-network", "session-expired"]);

/**
 * HOW LONG ANY SEND ON THIS PAGE MAY TAKE BEFORE THIS PAGE STOPS WAITING FOR IT — one bound, one
 * argument, and it covers both an unanswered dialog and a request that never comes back.
 *
 * THE ARGUMENT IS THE BLOCKHASH, and it lands on the same answer from both ends. A signed
 * transaction is only good for as long as the blockhash it was built against: `sendTx` fetches one
 * BEFORE it asks anyone to sign, and binds the confirmation to that blockhash's
 * `lastValidBlockHeight`, so the clock is already running while a dialog sits open. Two minutes
 * later there are exactly two possibilities, and neither is worth waiting on — either the
 * transaction was never built (a hung request; see below), so nothing was sent and nothing was
 * spent, or it was built against a blockhash the cluster now refuses as expired. Patience past this
 * point cannot buy a landed transaction. It can only hold the page shut.
 *
 * THREE THINGS IN A SEND CAN WAIT FOREVER, and only one of them is a human:
 *
 *   · `wallet.signTransaction()` resolves when the player answers the dialog, and never if they
 *     don't — the defect at the top of this file.
 *   · `blockhashForAccounts` (`chain/sendTx.ts`) is a bare `fetch` with no `AbortController` and no
 *     timeout, and neither is the `res.json()` after it. A TCP black hole, a captive portal or a
 *     router endpoint that accepts and never answers hangs it indefinitely. NOTE that this one
 *     precedes the blockhash rather than following it, so the expiry above cannot bound it — which
 *     is exactly why this constant applies to the unattended path too, where there is no dialog at
 *     all and an earlier draft of this file wrongly reasoned that none was needed.
 *   · `confirmTransaction` is bounded by block height only while its websocket is delivering. A
 *     socket that connects and then goes quiet is not.
 */
export const SEND_PATIENCE_MS = 120_000;

/** `Error.name` on the one error this module raises about itself rather than about the chain.
 *
 *  A NAME RATHER THAN A MESSAGE MATCH, because the alternative is a regex over copy: `rethrow` and
 *  `classifyWalletError` both read the message, and the sentence below deliberately talks about
 *  wallets and transactions, which is exactly the text those matchers are looking for. Marking the
 *  error instead means the copy can be rewritten by anybody, for any reason, without silently
 *  reclassifying a timeout as a cancelled popup. */
export const STOPPED_WAITING = "StoppedWaiting";

/** How many bounded catch-ups it can take to bring the worst possible backlog to the present.
 *
 *  DERIVED, because it is not a tuning knob — it is the program's own arithmetic. The deepest backlog
 *  that can exist is a full board left untouched until the bell (`finalCursor(MAX_FIGHTERS)`, 17,280
 *  steps) and one call clears at most `MAX_STEPS_PER_CALL` of it, so six calls is the ceiling by
 *  construction. Written as the division rather than as `6` so that raising the fighter cap, moving
 *  the bell or re-measuring the compute bound moves this with them; every one of those three has
 *  already moved once. */
export const CATCH_UP_CALLS = Math.ceil(finalCursor(MAX_FIGHTERS) / MAX_STEPS_PER_CALL);

/**
 * Did the program refuse this because the fight is behind the clock? See the call site in `extract`.
 *
 * THIS USED TO BE `/Error Code: FightBehind\b/` AND NOTHING ELSE, AND THAT MADE IT DEAD CODE ON THE
 * ONLY PATH IT RUNS ON. The argument for name-only was sound as far as it went — `#[error_code]`
 * numbers start at 6000 and shift whenever a variant is inserted above, so a client with `6022`
 * written into it silently starts catching a different error the next time the program grows one, and
 * `scripts/keeper/log.ts` follows the same rule for the same reason. What it missed is WHERE this
 * runs. Every extract goes through `ConnectionMagicRouter` into the ER (`chain/sendTx.ts`), and the
 * rollup answers a refusal with `custom program error: 0x1786` — no logs, no `Error Code:` line, no
 * name at all. See `programError.ts`'s header for the devnet capture. So the branch below this one —
 * the tick-and-retry that is the page's entire answer to a fight nobody has been ticking — could not
 * be reached in production, while its tests, every one of them written out of base-layer strings,
 * went on passing. That is the defect, and the tests were half of it.
 *
 * THE FIX IS NOT TO MATCH THE NUMBER; IT IS TO STOP WRITING THE NUMBER DOWN. `code` comes from
 * `fightBehindCode()` below, which reads it out of the IDL FETCHED AT RUNTIME — a contract with the
 * deployed program rather than a memory of one. A variant inserted above `FightBehind` moves the
 * number in lib.rs, in the IDL and here together. `undefined` (no IDL, no `errors` array) degrades to
 * the name alone, which is exactly the behaviour this function used to have and refuses nothing that
 * used to work.
 *
 * A PARAMETER RATHER THAN AN `await` INSIDE, so this stays pure and synchronous — a plain Node test
 * can call it, which is the discipline `entryWindow.ts` and `walletFault.ts` are held to and the only
 * reason a classifier in this codebase is testable at all. It also keeps the happy path untouched:
 * the call site resolves the code only after something has already failed.
 *
 * THE TYPED CHECK STAYS FIRST AND IS NOT REDUNDANT. Anchor builds an `AnchorError` when it can parse
 * simulation logs, which is the base layer and the scripts under `scripts/`; the text match covers
 * everything else. Both really arrive, so both are checked.
 */
export function isFightBehind(e: unknown, code: number | undefined): boolean {
  if (e instanceof AnchorError && e.error.errorCode.code === "FightBehind") return true;
  // `\b` inside `failedWith` so the match is the whole variant name: a future `FightBehindBy` would
  // otherwise be read as this one, and the page would answer it by grinding the fight.
  return failedWith(errorText(e), "FightBehind", code);
}

export function isStoppedWaiting(e: unknown): boolean {
  return e instanceof Error && e.name === STOPPED_WAITING;
}

/** THE DEPLOYED PROGRAM'S ERROR NUMBERS, resolved once per page and only when something has already
 *  failed.
 *
 *  Module-level rather than hook state because it is a property of the DEPLOY, not of a component: it
 *  cannot change while the page is open, every caller wants the same answer, and `loadIdl()` is
 *  itself cached — so after the first `createProgram` this is a resolved promise and costs a
 *  microtask. It is awaited only on the failure path, so the happy path is byte-for-byte unchanged.
 *
 *  A FAILURE TO READ IT IS NOT A FAILURE TO REPORT THE ERROR. If the IDL cannot be re-read, the map
 *  is empty, `refusalFromProgramError` falls back to matching Anchor's error NAMES, and anything it
 *  cannot claim keeps the chain's own words — which is exactly what this page did before. */
let enterCodesCache: Promise<ReadonlyMap<string, number>> | null = null;
function enterCodes(): Promise<ReadonlyMap<string, number>> {
  enterCodesCache ??= loadIdl()
    .then((idl) => enterErrorCodes(idl.errors))
    .catch(() => enterErrorCodes(undefined));
  return enterCodesCache;
}

/** `FightBehind`'s number on THIS deploy, resolved the same way and on the same terms as the three
 *  above — and deliberately not folded into that map.
 *
 *  ONE CACHE PER QUESTION, NOT ONE CACHE. Widening `enterCodes()` to carry a fourth name would cost
 *  nothing at the fetch (`loadIdl()` is itself cached, so this is a second `.then` over a resolved
 *  promise and a microtask) and would quietly change what `refusalFromProgramError` claims: that
 *  function ITERATES the map it is handed, so every name in it is a failure this page rewrites into
 *  entry copy. `entryWindow.test.ts`'s `0x1771` case is the standing assertion about what belongs in
 *  there. An extract that is behind the clock is not an entry refusal and must never be worded as one.
 *
 *  A FAILURE TO READ THE IDL IS NOT A FAILURE TO REPORT THE ERROR — `undefined`, and `isFightBehind`
 *  falls back to the name, which is what this page did before the rollup. */
let fightBehindCodeCache: Promise<number | undefined> | null = null;
function fightBehindCode(): Promise<number | undefined> {
  fightBehindCodeCache ??= loadIdl()
    .then((idl) => errorCodeOf(idl.errors, "FightBehind"))
    .catch(() => undefined);
  return fightBehindCodeCache;
}

/**
 * THE ROUND AS `enter`'S GUARDS SEE IT, READ FRESH — the boundary between a decoded account and
 * `entryWindow.ts`'s four plain fields.
 *
 * `fetchNullable`, and `bnOr0` on the deadline, for the reasons `chain/useRound.ts` gives at length:
 * a round mid-undelegation is briefly readable through neither route, a closed round is simply gone,
 * and `lobbyClosesAt` is absent altogether on a program revision that predates it. None of those is
 * an error and none of them is evidence that a deposit would be refused — so all three come back
 * `null` here and the caller sends anyway.
 */
async function readEntryWindow(
  program: BullsArenaProgram,
  roundPda: PublicKey,
  roundNo: bigint | null,
): Promise<EntryWindow | null> {
  const raw = await program.account.round.fetchNullable(roundPda);
  if (raw === null) return null;
  // `<= 0n` and not merely `undefined`: a round opened by an older `open_round` carries a ZERO
  // deadline, which means the same thing as an absent field — this round has no deposit deadline.
  // `data/liveRound.ts`'s `lobbyClosesAtMsOf` makes the identical judgement on the polled account.
  const closesAtSec = bnOr0(raw.lobbyClosesAt);
  return {
    roundNo,
    // `?? "Lobby"` READS AN UNKNOWN PHASE BYTE AS ENTERABLE, and it has to, because that is what the
    // page's own decoder does (`chain/useRound.ts`'s `toPlainRound`, same expression). A guard that
    // disagreed with the decoder would refuse a deposit under a live Deploy button — the two surfaces
    // contradicting each other is a worse failure than either policy, and the chain still has the
    // last word either way.
    phase: PHASE_NAME[raw.phase] ?? "Lobby",
    lobbyClosesAtMs: closesAtSec <= 0n ? null : Number(closesAtSec) * 1000,
    fighterCount: raw.fighterCount,
  };
}

function stoppedWaiting(message: string): Error {
  const e = new Error(message);
  e.name = STOPPED_WAITING;
  return e;
}

/** Minutes, for the copy, so no sentence in this file states the bound independently of the bound. */
const patienceMinutes = Math.round(SEND_PATIENCE_MS / 60_000);

/**
 * STOP WAITING — WITHOUT DECIDING WHAT HAPPENED.
 *
 * This is the whole of the fix for a wedged page, and the important half of it is what it does NOT
 * do. It does not cancel anything: there is nothing to cancel, because the press is sitting inside
 * a wallet extension this page has no handle on. It does not report a failure, because the player
 * may be reading the dialog right now and about to approve it. And it does not report a success,
 * for the obvious reason. It reports the third thing, which is the only true one: we are no longer
 * waiting, and the buttons come back.
 *
 * SO THE PRESS IS STILL RUNNING AFTER THIS RETURNS, and that is deliberate rather than tolerated.
 * A deploy approved late still lands, still confirms, and is still a real fighter in a real round —
 * so `onLate` is how the page finds out and says so. Without it a player would be told "we stopped
 * waiting", would deploy again, and would end up in one round twice having been warned about
 * neither transaction.
 *
 * BOTH ARMS OF `work` ARE HANDLED HERE, before the race, and that is not tidiness: a rejection
 * arriving after the race has already settled has nowhere else to go, and an unhandled rejection in
 * a browser is a console error nobody sees and, under some bundlers' error overlays, a full-screen
 * one everybody does.
 */
export async function stopWaiting(
  work: Promise<string>,
  patienceMs: number,
  message: string,
  onLate: (late: { signature: string | null; error: unknown }) => void,
): Promise<string> {
  let stopped = false;
  // Assigned by the executor below, which runs synchronously — the handle exists before the first
  // `await` and therefore before anything can reach the `finally`.
  let timer: ReturnType<typeof setTimeout>;
  const patience = new Promise<string>((_resolve, reject) => {
    timer = setTimeout(() => {
      stopped = true;
      reject(stoppedWaiting(message));
    }, patienceMs);
  });

  void work.then(
    (signature) => { if (stopped) onLate({ signature, error: null }); },
    (error) => { if (stopped) onLate({ signature: null, error }); },
  );

  try {
    return await Promise.race([work, patience]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ActionsParams {
  program: BullsArenaProgram | null;
  router: ConnectionMagicRouter;
  /** The fighter identity the chain credits. `null` when nobody has connected. */
  player: PublicKey | null;
  /** Signs when no session is live. `null` when nobody has connected. */
  fallbackSigner: TxSigner | null;
  arena: PublicKey;
  roundPda: PublicKey | null;
  /** The round AS DISPLAYED, not the raw account — eligibility now has to quote a price as well as a
   *  verdict, and the price is a function of the CANONICAL cursor (`LiveRound.stepsNow`), which is
   *  derived here in `data/` and does not exist on `RoundState`. See `extractTerms.ts`. */
  live: LiveRound | null;
  /** THE ROUND `roundPda` IS DERIVED FROM — the round every deposit here is actually written to, and
   *  the round a confirmed deposit must be booked against. Distinct from `live.roundNo`, which is the
   *  round the poll has most recently read; see `targetRoundNoRef`. */
  targetRoundNo: bigint | null;
  /** HOW THE NEXT MOVE GETS SIGNED — see `autoSession.ts`. Decided in the provider from the wallet,
   *  the gate, the balance and whether the player has pressed Stop; acted on here. */
  plan: SigningPlan;
  /** Opening, renewing and classifying, injected so this file holds no session machinery of its own
   *  and `autoSession.test.ts` can drive the same orchestration with fakes. */
  signing: SessionSigning<ActiveSession>;
  /** Why the player cannot act, or null. The single verdict every disabled control renders — see
   *  `playGate.ts`. It is checked here too, so the button and the transaction cannot disagree. */
  blocked: PlayBlock | null;
  /** Fires only after a CONFIRMED enter. The simulated ledger books the deploy and the house fee off
   *  this — never off the attempt, so a failed transaction can't debit play money for a fighter that
   *  never entered.
   *
   *  IT CARRIES THE ROUND, AND IT HAS TO. It fans out to `AutoDeployHandle.noteDeploy`, and the round
   *  a confirmed deposit belongs to is the one `roundPda` was derived from at SEND time — read here
   *  off `targetRoundNoRef`, never off `live.roundNo`, which is the round the poll last fetched and
   *  lags by up to a poll whenever a new round opens. This used to carry only a side, leaving the
   *  listener to derive the round on the far side of a confirmation; a deposit confirming inside that
   *  window was booked against a round it never touched. Null where no round is knowable — the
   *  listener then records the side and nothing else. */
  onEntered(side: Side, stakeUnits: bigint, roundNo: bigint | null): void;
  /** For the one thing this file has to say on its own account: a press that outlived our patience
   *  and then settled anyway. Every other outcome is thrown to whoever pressed the button. */
  push(text: string, kind?: ToastKind): void;
}

/**
 * WHAT THE WRITE PATH OFFERS, and it is deliberately WIDER than `ArenaContextValue["actions"]`.
 *
 * `enterUnattended` is not on the context and must not be put there. Everything on the context is
 * something a view may call, and the unattended sender is the one write on this page that is
 * defined by having nobody in front of it: it belongs to the repeat rule, is handed to it once by
 * the provider, and is reachable from nowhere else. A view that could call it would be a view that
 * could deposit without a press — which is the thing the whole of `autoPolicy.ts` is built to make
 * impossible, and a seam somebody would eventually use for exactly that.
 *
 * (The narrower context type has a second, mechanical benefit worth knowing: `useFixtureArena.ts`
 * supplies `actions` through `Pick<ArenaContextValue, "actions">`, so anything added to the context
 * shape has to be answerable by a fixture that sends nothing at all.)
 */
export type WriteActions = ArenaContextValue["actions"] & {
  /** THE ONLY THING THIS PAGE SENDS WITH NOBODY WATCHING — see the definition below. */
  enterUnattended(side: Side, stakeUnits: bigint): Promise<string>;
};

export function useActions(params: ActionsParams): WriteActions {
  const { program, router, player, fallbackSigner, arena, roundPda, live, targetRoundNo, plan, signing, blocked,
    onEntered, push } = params;
  const [entering, setEntering] = useState(false);
  const [extracting, setExtracting] = useState(false);

  // THE ROUND THE WRITE PATH IS TARGETING, MIRRORED — the same device as `signing.current()`, for the
  // same reason: a press spans seconds of chain confirmation, and every consumer of "which round did
  // this deposit go into" must be told the answer that was true when it was SENT.
  //
  // IT IS `targetRoundNo`, NOT `live.roundNo`, AND THE TWO ARE NOT THE SAME NUMBER. `roundPda` — the
  // account every deposit on this page is actually written to — is derived from `targetRoundNo`;
  // `live.roundNo` is whatever the round poll most recently FETCHED, and it lags by up to a poll
  // whenever a new round opens. Booking a confirmed deposit against the round that was read rather
  // than the round that was written is how a real, paid-for deposit ends up recorded against a round
  // it never touched.
  const targetRoundNoRef = useRef(targetRoundNo);
  targetRoundNoRef.current = targetRoundNo;

  /** The one place a resolved session becomes a signer, shared by both instructions. `null` is the
   *  direct path — the identity's own signer, and an explicit `sessionToken: null` on the builder. */
  const signerFor = useCallback(
    (session: ActiveSession | null): TxSigner | null =>
      session ? { publicKey: session.signerPubkey, signTransaction: session.signTransaction } : fallbackSigner,
    [fallbackSigner],
  );

  /** Everything both instructions need to be true BEFORE either opens a session or builds a
   *  transaction, returned narrowed so neither call site needs a non-null assertion. Throws the copy
   *  the page is already showing, so there is exactly one account of why an action is unavailable.
   *
   *  It runs first, and that ordering is load-bearing now that a press can spend money on a session:
   *  a refusal must cost nothing, and every reason to refuse is known here. */
  const requireReady = useCallback((): {
    program: BullsArenaProgram;
    player: PublicKey;
  } => {
    if (!program) throw new Error("the program is not loaded yet — nothing can be sent to the chain");
    // The gate outranks the local null checks: it has the sentence that says what to DO, where
    // "player is null" only says what is missing.
    if (blocked) throw new Error(blocked.detail);
    // `fallbackSigner` is checked even on the session path: no wallet means nothing can AUTHORIZE a
    // session either, so this is the honest refusal rather than a failed `createSession`.
    if (player === null || fallbackSigner === null) throw new Error(NO_WALLET_MESSAGE);
    return { program, player };
  }, [program, blocked, player, fallbackSigner]);

  /**
   * Re-throw with the useful message. See this file's header on which three are rewritten.
   *
   * THE VERBATIM RULE INVERTS WHEN THERE ARE NO WORDS, which is not a hypothetical: every
   * `WalletError` subclass in `@solana/wallet-adapter-base` is `constructor() { super(...arguments) }`
   * and the adapter throws them with no arguments, so `.message` is `""`. Re-throwing one of those
   * "verbatim" hands the toast an empty string — a blank red box, which is worse than any paraphrase
   * and was exactly what a mid-round disconnect produced. `classifyWalletError` always yields a real
   * sentence (see its `BARE_WALLET_ERROR` branch), so an empty message defers to it. Errors that
   * genuinely carry text — every program error, which is the case the rule was written for — are
   * still passed through untouched.
   */
  const rethrow = useCallback((e: unknown): never => {
    const fault = classifyWalletError(e);
    if (REWRITTEN.has(fault.code)) throw new Error(fault.detail);
    if (e instanceof Error && e.message.trim() !== "") throw e;
    throw new Error(fault.detail);
  }, []);

  /**
   * One `enter`, built and sent. Shared by the attended and the unattended paths so that the
   * transaction they send is provably the same one and only the way it is SIGNED differs.
   *
   * IT IS ALSO WHERE THE ROUND IS RE-READ, AND THIS IS THE ONE PLACE THAT CAN BE. `runSigned` calls
   * this AFTER every wallet dialog it was going to open has closed — after the session was opened, or
   * after a lapsed one was replaced — so this is the last instant before the transaction exists, and
   * it is the only instant at which "is the round still taking deposits" is worth asking. Asking at
   * the top of `enter()` instead would answer a question about a round twenty seconds and two Phantom
   * popups ago, which is precisely the race this is here to close.
   *
   * A REFUSAL COSTS THE PLAYER NOTHING AND THE CHAIN SEES NOTHING. Nothing is built, nothing is
   * signed, nothing is sent; `onEntered` never fires, so the simulated ledger books no deploy; and
   * the dock's staged amount is state a thrown error does not touch, so "press again" really is one
   * press. Sending anyway would spend a fee to be told a fact this page already knew, and hand back
   * the wall of simulation text this whole module exists to replace.
   *
   * IT FAILS OPEN, DELIBERATELY. `readEntryWindow` returning null — a round mid-undelegation, a
   * closed account, an RPC that answered badly — is NOT evidence that a deposit would be refused, and
   * neither is a read that throws. In both cases the press proceeds and the chain gets the last word,
   * which is the correct authority. The only thing this may do is decline to send something it has
   * just seen the chain refusing.
   */
  const sendEnter = useCallback(
    async (
      p: BullsArenaProgram,
      from: PublicKey,
      round: PublicKey,
      roundNo: bigint | null,
      session: ActiveSession | null,
      side: Side,
      stakeUnits: bigint,
    ): Promise<string> => {
      const signer = signerFor(session);
      if (signer === null) throw new Error(NO_WALLET_MESSAGE);

      // NOT `window`, which is the global this module runs inside. A local of that name compiles,
      // reads correctly, and is one careless edit away from shadowing the DOM.
      const snapshot = await readEntryWindow(p, round, roundNo).catch((e: unknown) => {
        // SAID OUT LOUD, THEN IGNORED. Failing open is the policy and it is not changing — but a
        // router that has quietly stopped answering `getAccountInfo` would otherwise turn this whole
        // guard off with no trace anywhere, on a page whose author is debugging it at 3am. One line,
        // on a path that runs once per press.
        console.warn("[enter] could not re-read the round before sending; sending anyway", e);
        return null;
      });
      const refusal = snapshot === null ? null : entryRefusal(snapshot, Date.now());
      if (refusal !== null) throw entryRefusedError(refusal);

      const builder = buildEnter(p, {
        arena,
        round,
        player: from,
        signer: signer.publicKey,
        sessionToken: session?.sessionTokenPda ?? null,
        side,
        stake: stakeUnits,
      });
      try {
        return (await sendTx(router, builder, signer, `enter side ${side}`)).signature;
      } catch (e) {
        // THE REST OF THE RACE. The read above is already the past by the time this transaction is
        // signed and submitted, so the round can still close inside that window — and when it does,
        // the chain says so in the least useful way available (see `entryWindow.ts`'s header for what
        // the rollup actually returns, which is a hex code and nothing else). Answered here with the
        // SAME sentence the pre-check would have used, so a player cannot tell which of the two
        // caught it and never has to.
        //
        // Anything that is not one of those three refusals is re-thrown exactly as it arrived, and
        // `rethrow` upstream still has the last word on it.
        const late = refusalFromProgramError(e, await enterCodes(), roundNo);
        if (late !== null) throw entryRefusedError(late);
        throw e;
      }
    },
    [arena, router, signerFor],
  );

  const enter = useCallback(
    async (side: Side, stakeUnits: bigint): Promise<string> => {
      const { program: p, player: from } = requireReady();
      if (!roundPda) throw new Error("there is no open round to deploy into");
      if (stakeUnits <= 0n) throw new Error("stake must be greater than zero");
      // READ HERE, NOT IN THE `then`. This press spans a Phantom dialog and a confirmation — minutes,
      // in the worst case this file already bounds — and `targetRoundNoRef` tracks the newest render.
      // Reading it after the transaction resolves would name whichever round the poll had reached by
      // then, which is exactly the mistake booking off `live.roundNo` used to make. `roundPda` is
      // captured in this closure from the same render, so the two describe one round.
      const bookedRoundNo = targetRoundNoRef.current;
      // Set BEFORE the session is opened, not after: the press now spans a Phantom dialog, and the
      // buttons have to be shut for the whole of it or a second press lands mid-approval and opens
      // a second one. `pendingNote(session.work)` is what the dock says during that window.
      setEntering(true);
      try {
        // BOOKED WHERE IT CONFIRMS, NOT WHERE IT IS AWAITED, and the difference only shows up on the
        // press we stopped waiting for. A deploy approved after our patience ran out still lands,
        // and the simulated ledger's job is to book what the chain actually charged — so the booking
        // rides the transaction rather than the wait.
        //
        // AFTER `runSigned`, deliberately: it can send twice (a lapsed session is renewed and the
        // move re-sent), and the simulated ledger must book one confirmed deploy, not two.
        const work = runSigned(plan, signing, (session) =>
          sendEnter(p, from, roundPda, bookedRoundNo, session, side, stakeUnits),
        ).then((signature) => {
          onEntered(side, stakeUnits, bookedRoundNo);
          return signature;
        });
        return await stopWaiting(
          work,
          SEND_PATIENCE_MS,
          `Your wallet was asked to approve this deploy and has not come back after ${patienceMinutes} ` +
            "minutes, so this page has stopped waiting for it and the buttons are live again. Nothing " +
            "here can tell whether you approved it: if you did, the deploy may still land, and you will " +
            "be told when it does. Check the lobby before deploying again so you do not enter the same " +
            "round twice.",
          ({ signature, error }) =>
            signature !== null
              ? push(`The deploy this page had stopped waiting for landed after all — ${signature}`, "info")
              : push(
                  "The deploy this page had stopped waiting for did not land — " +
                    `${classifyWalletError(error).short}. Nothing was deposited.`,
                  "error",
                ),
        );
      } catch (e) {
        // OURS, ALREADY WORDED. `rethrow` exists to improve on what the chain and the wallet say;
        // running it over this page's own sentence would classify a timeout by reading its copy.
        if (isStoppedWaiting(e)) throw e;
        return rethrow(e);
      } finally {
        setEntering(false);
      }
    },
    [roundPda, plan, signing, sendEnter, requireReady, onEntered, rethrow, push],
  );

  const extract = useCallback(async (): Promise<string> => {
    const { program: p, player: from } = requireReady();
    if (!roundPda) throw new Error("there is no open round to extract from");
    setExtracting(true);
    try {
      const work = runSigned(plan, signing, async (session) => {
        const signer = signerFor(session);
        if (signer === null) throw new Error(NO_WALLET_MESSAGE);
        const sendExtract = async (): Promise<string> => {
          const builder = buildExtract(p, {
            round: roundPda,
            player: from,
            signer: signer.publicKey,
            sessionToken: session?.sessionTokenPda ?? null,
          });
          return (await sendTx(router, builder, signer, "extract")).signature;
        };
        // `FightBehind` IS AN INSTRUCTION TO THIS PAGE, NOT NEWS FOR THE PLAYER.
        //
        // `extract` catches the fight up before it prices anything, and that catch-up is bounded at
        // `MAX_STEPS_PER_CALL`. On a round nobody has been ticking, one call cannot reach the present,
        // and the program refuses rather than pay out at a stale cursor — correctly, because a cursor
        // short of the truth pays out MORE hp than the player still holds. Its message says "tick it
        // first, then extract", which is exact advice for a keeper and a dead end for a player, who
        // has no tick button and should not need one.
        //
        // So the page does what the message says. `tick` is permissionless and takes the session
        // signer already in hand, so this costs the player no extra dialog — only the sends.
        //
        // BOUNDED BY THE PROGRAM'S OWN WORST CASE, DERIVED RATHER THAN GUESSED: the deepest backlog
        // that can exist is a full board left untouched to the bell, and each tick clears at most one
        // call's worth. Looping past that would mean something other than a backlog is wrong, and the
        // honest response to that is to surface the error rather than keep spending fees. In the
        // normal case — any client at all ticking — this branch never runs.
        //
        // TWO TRANSACTIONS, AND THEY MUST NOT BE BUNDLED INTO ONE. This is the optimisation a reader
        // will reach for — two round-trips to do one thing looks wasteful, and Anchor makes
        // `.preInstructions()` the obvious way to fuse them. Measured under LiteSVM against the
        // compiled program, the fused bundle costs 1,278,835 CU: 91.3% of the 1.4M ceiling. It FITS,
        // which is what makes it dangerous — it would work in testing and keep working until a fight
        // state sent more steps down the damage branch than the measured one, and then it would fail
        // on the single instruction where running out of budget means a player cannot get their money
        // out. Apart they are comfortable: tick 645,685 and extract 651,018, both about 46%.
        //
        // Splitting costs nothing real. The backlog grows at `2n` = 96 steps a second at a full board
        // while one tick clears 3,000, so the extract that follows is never meaningfully behind the
        // tick that preceded it. `programs/bulls-arena/tests/compute.rs`'s
        // `the_tick_then_extract_bundle_fits_but_only_just` keeps that number on the record, and
        // `extract`'s own doc comment in lib.rs prescribes separate transactions.
        for (let caught = 0; ; caught++) {
          try {
            return await sendExtract();
          } catch (e) {
            // `await` INSIDE THE CATCH, NOT BEFORE THE LOOP, so the happy path never waits on the
            // IDL at all — the same rule `enterCodes()` follows and states. By the time this runs a
            // send has already failed, so a microtask over an already-resolved promise is free.
            //
            // AND IT CANNOT SWALLOW `e`. Awaiting inside a `catch` is normally a way to lose the
            // error you were handling — a rejection here would replace it and the player would be
            // shown the IDL fetch instead of the chain's refusal. `fightBehindCode()` ends in
            // `.catch(() => undefined)`, so it has no rejected state to hand back. That `.catch` is
            // load-bearing for this line, not just for the degradation it documents.
            if (caught >= CATCH_UP_CALLS || !isFightBehind(e, await fightBehindCode())) throw e;
            // Its own `sendTx`, i.e. its own transaction — see the note above before merging these.
            const tick = buildTick(p, { round: roundPda, steps: MAX_STEPS_PER_CALL });
            await sendTx(router, tick, signer, "tick (catching the fight up for extract)");
          }
        }
      });
      // THE SAME BOUND, AND IT MATTERS MORE HERE. An extract is a race against whoever settles the
      // round, so an unanswered dialog costs the player the round whatever this page does — but a
      // wedged Extract button also costs them every round after it, which is the part that is ours.
      return await stopWaiting(
        work,
        SEND_PATIENCE_MS,
        `Your wallet was asked to approve this extract and has not come back after ${patienceMinutes} ` +
          "minutes, so this page has stopped waiting for it and the buttons are live again. If you " +
          "approve it now it may still go through at whatever the penalty has decayed to by then, and " +
          "you will be told either way. Your fighter is still in the round until it does.",
        ({ signature, error }) =>
          signature !== null
            ? push(`The extract this page had stopped waiting for landed after all — ${signature}`, "info")
            : push(
                "The extract this page had stopped waiting for did not land — " +
                  `${classifyWalletError(error).short}. Your fighter is still in the round.`,
                "error",
              ),
      );
    } catch (e) {
      if (isStoppedWaiting(e)) throw e;
      return rethrow(e);
    } finally {
      setExtracting(false);
    }
  }, [roundPda, router, plan, signing, signerFor, requireReady, rethrow, push]);

  /**
   * A DEPOSIT SENT WITH NOBODY IN THE ROOM — the repeat rule's only way to spend money, and a
   * separate function from `enter` rather than a flag on it.
   *
   * WHAT IS MISSING FROM IT IS THE SPECIFICATION. `enter` opens a session when there is none,
   * replaces one the chain has refused, and falls back to a wallet signature when the optional half
   * fails; each of those is a Phantom dialog, each is right in front of somebody who just pressed a
   * button, and each is a bug here. They are not behind a condition in this function — they are not
   * in it at all. `runUnattendedEntry` is what enforces that, and `autoPolicy.ts`'s header is the
   * account of the incident it was written for: two approvals raised at an empty chair, every round,
   * for as long as the tab stayed open.
   *
   * IT ENTERS AND IT NEVER EXTRACTS (`SOCIAL.md` §5, §1.1 — a hard rule). That is written here as a
   * shape rather than a promise: this takes a side and a stake, which is what an entry is and what
   * an extract cannot be described by, and `runUnattendedEntry`'s payload type accepts nothing else.
   * There is no `extractUnattended` in this file and there must never be one. `enter` is a rule — a
   * side and a size, decided in advance, losing nothing by being automatic. `extract` is a judgement
   * made against a live fight under time pressure, racing whoever settles the round, and it is where
   * the money actually is; automating it would be playing the game on the player's behalf rather
   * than holding their place in it.
   *
   * IT IS BOUNDED, AND THE PATH WITH NOBODY WATCHING IS THE LAST ONE THAT SHOULD NOT BE. There is no
   * dialog on this path, which is why an earlier draft argued no bound was needed — but the hang
   * that matters here is not a human. `blockhashForAccounts` runs before any blockhash exists and has
   * no timeout (see `SEND_PATIENCE_MS`), so a stalled request left `entering` true forever and, worse,
   * left the rule's attempt in `sending` — which `expireStaleAttempt` refuses to expire on purpose,
   * so the rule went silent for every round afterwards with "Depositing…" on screen and nothing said.
   *
   * A TIMEOUT HERE IS A FAILED ATTEMPT, NOT A LOST ROUND, and that is the right side to err on. If
   * the hang was the blockhash fetch then nothing was ever built, let alone sent, and another go
   * costs nothing. If a transaction did go out, the retry is two minutes later — past the end of any
   * lobby the program permits — so the next evaluation writes the round off with a stated reason
   * instead of depositing into it twice, and the roster poll holds it on `already-in` regardless.
   */
  const enterUnattended = useCallback(
    async (side: Side, stakeUnits: bigint): Promise<string> => {
      const { program: p, player: from } = requireReady();
      // BOTH, NOT JUST THE PDA. The payload below NAMES the round it is depositing into, and the
      // whole point of that name is that it is the round the PDA actually targets — so it comes off
      // the same source `roundPda` is derived from, read at send time, rather than off the round the
      // poll has most recently fetched.
      const roundNo = targetRoundNoRef.current;
      if (!roundPda || roundNo === null) throw new Error("there is no open round to deploy into");
      if (stakeUnits <= 0n) throw new Error("stake must be greater than zero");
      setEntering(true);
      try {
        const work = runUnattendedEntry(
          plan,
          // THE FACT, READ AT SEND TIME, not the plan's inference about it and not a session
          // captured when this callback was built. Where the two disagree `runUnattendedEntry`
          // refuses rather than quietly signing with the wallet instead.
          signing.current(),
          { roundNo, side, amountUsd: unitsToUsd(stakeUnits) },
          (entry, session) => sendEnter(p, from, roundPda, roundNo, session, entry.side, stakeUnits),
        ).then((signature) => {
          onEntered(side, stakeUnits, roundNo);
          return signature;
        });
        return await stopWaiting(
          work,
          SEND_PATIENCE_MS,
          `The deposit into round ${roundNo} did not come back within ${patienceMinutes} minutes, so ` +
            "this page stopped waiting for it",
          ({ signature, error }) =>
            signature !== null
              ? push(
                  `The automatic deposit into round ${roundNo} landed after this page had stopped ` +
                    `waiting for it — ${signature}`,
                  "info",
                )
              : push(
                  `The automatic deposit into round ${roundNo} did not land — ` +
                    `${classifyWalletError(error).short}. Nothing was deposited.`,
                  "error",
                ),
        );
      } catch (e) {
        // A REFUSAL WORDED FOR NOBODY, WHICH IS NOT THE SAME SENTENCE A PLAYER GETS.
        //
        // `sendEnter` is shared, so the refusal that reaches here is the one written for somebody who
        // just pressed a button: "while your wallet was open… press the same button again when the
        // next lobby opens". Nothing about that is true here. No wallet was open — this path cannot
        // raise a dialog at all, by construction (`runUnattendedEntry`) — and there is no button and
        // nobody to press it. Left alone it would surface verbatim through `attemptFailed` into
        // `abandonText`'s "3 attempts failed — …" and out to a toast, telling an absent player to do
        // something they are not there to do.
        //
        // `short` is the clause built for exactly this: it names no round (the rule's own frame
        // already does — "Repeat missed round 42 — …") and it instructs nobody.
        const refused = refusalOf(e);
        if (refused !== null) throw new Error(refused.short);
        // NOT `isStoppedWaiting` HERE, unlike the two attended paths. There is no player reading
        // this sentence — it goes into the attempt record and, if the round is eventually written
        // off, into `abandonText`'s account of it — and `rethrow` leaves a message that names no
        // wallet fault exactly as it found it.
        return rethrow(e);
      } finally {
        setEntering(false);
      }
    },
    [roundPda, plan, signing, sendEnter, requireReady, onEntered, rethrow, push],
  );

  // Recomputed on every `live` identity change, which during Fight is the 250ms clock in
  // `useLiveRound` — deliberately, because the penalty this quotes decays with the cursor. A price
  // that only moved when the chain poll landed would be stale by up to a poll interval, in the
  // direction that overstates what the house takes.
  //
  // THE GATE IS THE FIRST REASON OFFERED. "connect a wallet" outranks "you have no fighter in this
  // round", which is technically also true of someone who has not connected and is useless to them.
  const extractEligible = useMemo(
    () =>
      extractEligibility(
        live,
        blocked?.short ?? (!program ? "loading program…" : !roundPda ? "no round selected" : null),
      ),
    [program, roundPda, live, blocked],
  );

  return { enter, enterUnattended, extract, entering, extracting, extractEligible };
}
