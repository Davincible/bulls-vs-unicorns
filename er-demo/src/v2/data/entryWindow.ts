// THE ROUND CLOSING UNDERNEATH A PRESS — one module, asked in both tenses.
//
// THE COMPLAINT, IN THE OWNER'S WORDS: "I click Deposit and then the Phantom pop-ups pop up because
// the site is not approved yet. It takes about 20 seconds to get through all of the pop-ups and by
// the time you approve the transaction, of course it fails. The error you get is very technical and
// crazy."
//
// It is a real race with a real cause, and half of the cause is ours. A first deploy now opens a
// session key first (`autoSession.ts`), so the press spans two Phantom dialogs and tens of seconds of
// human time. Meanwhile the keeper holds a lobby open for nobody at zero cost, and then — the moment
// the FIRST real player enters — commits to closing it `REAL_PLAYER_GRACE_SECONDS` later
// (`scripts/keeper/config.ts`, 20s). So a newcomer whose approval chain starts a beat after somebody
// else's entry is racing a twenty-second fuse with a twenty-second chain of dialogs, and loses.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE CHAIN ACTUALLY SAYS, MEASURED RATHER THAN ASSUMED — and the measurement changed the
// design, so it is recorded here rather than left as a paragraph in a report.
//
// `enter`'s guards, in the program's own order (lib.rs, `pub fn enter`):
//
//     require!(r.phase == Phase::Lobby as u8,        ArenaError::NotInLobby);   // 6002
//     require!(side == 0 || side == 1,               ArenaError::BadSide);      // 6005
//     require!(stake > 0,                            ArenaError::ZeroStake);    // 6006
//     require!((r.fighter_count as usize) < MAX,     ArenaError::RoundFull);    // 6007
//     require!(lobby_is_open(r.lobby_closes_at, now),ArenaError::LobbyClosed);  // 6014
//
// THE ONE THAT ACTUALLY FIRES IN PRODUCTION IS `NotInLobby`, NOT `LobbyClosed`, and reading the names
// the other way round would have produced copy about a deadline nobody ever reaches. Under the
// hold-open policy `lobby_closes_at` is a ONE-HOUR backstop (`HOLD_OPEN_LOBBY_SECONDS`); what really
// ends a lobby is the keeper's AUTHORITY early close, which moves the phase to `Drawing` with
// fifty-nine minutes still on the chain's clock. So the round a late deposit lands on is in `Drawing`
// or `Fight`, and the guard it trips is the FIRST one. `LobbyClosed` is reachable only where nobody
// closes early — a hand-opened round, or a keeper that is down while the backstop runs out — and
// `RoundFull` needs the lobby to have reached `MAX_FIGHTERS` (48). All three are answered here;
// only the first is common.
//
// AND THE ROLLUP SENDS BACK NO LOGS AND NO NAMES. This is the finding that decided how the classifier
// below is keyed, and it was arrived at by sending doomed `enter`s at the deployed program on devnet
// (v8, ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe) and printing the thrown object:
//
//   · Base layer, a settled round — `simulateTransaction` returns
//         err: {"InstructionError":[0,{"Custom":6002}]}
//         Program log: AnchorError thrown in .../lib.rs:1557. Error Code: NotInLobby.
//         Error Number: 6002. Error Message: round is not in the lobby phase.
//     i.e. the NAME is there, and a name-keyed matcher works.
//
//   · Through the Magic Router into the ER — the path every real `enter` takes, because a live round
//     is delegated — `sendRawTransaction` throws a `SendTransactionError` whose ENTIRE content is
//         transactionMessage: "solana rpc request error: RPC response error -32003: transaction
//                              verification error: Error processing Instruction 0:
//                              custom program error: 0x1775; "
//         transactionLogs:    undefined
//     No logs. No `Error Code:` line. No name. THE HEX CODE IS THE ONLY SIGNAL THERE IS.
//
// That is why this module matches on the NUMBER as well as the name, and why `useActions.ts`'s
// `isFightBehind` — which matches `Error Code: FightBehind` and nothing else — cannot fire on the
// rollup path at all. Matching a number is exactly the thing that file's comment warns against
// ("a client keyed on 6022 silently starts catching a different error the next time the program grows
// one"), and the warning is right. The answer is not to match names we will never see; it is to stop
// hard-coding the number: `enterErrorCodes()` reads name → code out of the IDL THAT WAS FETCHED AT
// RUNTIME, which is a contract with the DEPLOYED program. A variant inserted above `NotInLobby` moves
// the number in lib.rs, in the IDL, and here, together, with nothing to remember.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// ONE OBJECT, TWO TENSES, AND THAT IS THE WHOLE POINT OF PUTTING BOTH HALVES IN ONE FILE.
// `entryRefusal()` asks the question BEFORE the transaction is built, off a fresh read of the round;
// `refusalFromProgramError()` asks it AFTER, off whatever the chain threw. Both return the same
// `EntryRefusal`, so the player reads the identical sentence whether this page caught the race or the
// program did — and the pre-check can never drift into being kinder or harsher than the chain,
// because the two are one set of words with one test over them.
//
// WHY THIS IS NOT IN `walletFault.ts`. That module opens by stating, at length, that NOTHING IN IT
// PARAPHRASES A PROGRAM ERROR, and it is right to: "custom program error: NothingToExtract" is a
// sentence a presenter can read aloud. This is the case its own rule carves out — a failure whose
// original text names a symptom and hides the cause — but answering it needs two things that module
// deliberately does not have: the ROUND NUMBER (so the copy can say which round, which is most of
// what makes it human) and the IDL's error table. It also has to say what happens to the money, and
// that answer belongs beside the guard that decides whether to send at all. So the shape is copied
// exactly — `{ code, short, detail }`, `short` a lower-case clause, `detail` full sentences per
// SPEC.md — and the words live here.
//
// PURE AND REACT-FREE, like `walletFault.ts`, `autoSession.ts` and `feeCopy.ts`, for the reason this
// project keeps repeating: there is no browser test harness here, so a decision that matters is a
// decision a plain Node test can call.

import { ENTRY_CLOSE_GUARD_MS, type PhaseName } from "../contract.ts";
import { MAX_FIGHTERS } from "../../sim/erSim.ts";
import { unattendedSigning } from "./autoPolicy.ts";
import type { SigningPlan } from "./autoSession.ts";

/** WHY A DEPOSIT CANNOT LAND, in the only three terms `enter` can refuse one for a reason a player
 *  had no control over. Named after what is TRUE of the round, never after the Rust variant — the
 *  variant is an implementation of the fact, and two of these are reachable from more than one. */
export type EntryRefusalCode =
  /** `NotInLobby`. The round left Lobby — drawing its seed, fighting, or already over. THE COMMON
   *  ONE, and the one the keeper's authority early close produces. */
  | "round-moved-on"
  /** `LobbyClosed`. The chain's own `lobby_closes_at` passed. Only where nobody closed early. */
  | "entries-closed"
  /** `RoundFull`. `MAX_FIGHTERS` already in the ring. */
  | "round-full";

/** Same three-field contract as `walletFault.ts`'s `WalletFault` and `playGate.ts`'s `PlayBlock`, so
 *  every surface that renders one of those renders this without learning a new shape. */
export interface EntryRefusal {
  code: EntryRefusalCode;
  /** ONE CLAUSE: what is true. Lower-case, no trailing period — it is dropped inside sentences the
   *  caller owns, exactly as `WalletFault.short` and `PlayBlock.short` are.
   *
   *  IT DOES NOT NAME THE ROUND, and `detail` does. The caller that uses this one has already named
   *  it: the repeat rule's own frame is `Repeat missed round 42 — …`, and a clause that named it
   *  again would read "round 42 — … round 42 started fighting". Context belongs to whoever owns the
   *  sentence. */
  short: string;
  /** WHAT IS TRUE, WHAT IT COST, AND WHAT TO DO NEXT. Full sentences, SPEC.md's order. This is the
   *  string a toast shows and the string a thrown `Error` carries. */
  detail: string;
}

/** The round as `enter`'s guards see it. Deliberately the four fields the guards read and nothing
 *  else: a caller can build this from a fresh account fetch, from the polled `LiveRound`, or from a
 *  literal in a test, and none of those has to agree about anything else. */
export interface EntryWindow {
  /** Null where no round number is knowable. The copy then says "this round" instead of naming one,
   *  which is worse and is still better than printing a wrong number. */
  roundNo: bigint | null;
  phase: PhaseName;
  /** Epoch ms, or null on a program revision that carries no deadline — see
   *  `LiveRound.lobbyClosesAtMs`, which makes the same distinction for the same reason. */
  lobbyClosesAtMs: number | null;
  fighterCount: number;
}

/** "Round 42" or "This round" — SENTENCE-LEADING in both cases, because `detail` opens on it and a
 *  paragraph that begins in lower case reads as a rendering fault. `short` lower-cases it back, per
 *  its own contract of being a clause dropped inside somebody else's sentence. One helper, so no
 *  sentence below has to hold the null case itself. */
function name(roundNo: bigint | null): string {
  return roundNo === null ? "This round" : `Round ${roundNo}`;
}

/** WHAT HAPPENED TO THE MONEY — the sentence the owner's complaint is really about, and it is
 *  unconditionally true rather than reassuring.
 *
 *  `sendTx` sends with `skipPreflight: false`, so a doomed `enter` is refused by simulation and never
 *  reaches the cluster: the thrown `SendTransactionError` carries an EMPTY signature, no fee is
 *  charged and no state moves. The pre-send check refuses even earlier, before a transaction is
 *  built. And `enter` is atomic in any case — a refused instruction credits no fighter — so this
 *  claim holds even in the sliver of a window where a transaction passes preflight and then fails on
 *  chain. Nothing here has to know which of the three happened. */
const NOTHING_MOVED = "Nothing was deposited and nothing was taken.";

/**
 * WHERE THE PRESS GOES INSTEAD — and this sentence is a PROMISE ABOUT THE UI, which is why it is
 * worth this comment rather than being obvious.
 *
 * "Still set here" is a claim that the amount survives the round that just ended, and it did not use
 * to: the staged stake lived inside the dock's deploy body, which unmounts the moment a lobby closes,
 * so it reset to the $20 default in exactly the situation this sentence appears in. `StakeDock.tsx`
 * now holds it one level up so the claim is true; if that ever moves back down, this sentence has to
 * go with it.
 *
 * IT NAMES NO NUMBER, deliberately. There may be no countdown to the next lobby at all — the keeper
 * holds one open for players with no deadline running (`roundPhaseCopy.ts` prints `OPEN` where a
 * clock would go) — and inventing one here would be the same class of lie the phase copy refuses
 * everywhere else on this page.
 *
 * AND IT SAYS "BUTTON", NOT "SIDE". The side is not staged anywhere: it IS the button, chosen at the
 * instant of the press. Promising a preserved side would be describing state that does not exist.
 */
const PRESS_AGAIN = "Your stake is still set here — press the same button again when the next lobby opens.";

/** THE WORDS FOR ONE REFUSAL, wherever it was noticed. Called by both halves of this module so the
 *  pre-check and the chain's own refusal cannot say different things about the same event. */
export function entryRefusalCopy(code: EntryRefusalCode, roundNo: bigint | null): EntryRefusal {
  const n = name(roundNo);
  switch (code) {
    case "round-moved-on":
      return {
        code,
        short: "the round started fighting before your deposit arrived",
        detail:
          `${n} started fighting while your wallet was open, so your deposit arrived too late and ` +
          `was refused. ${NOTHING_MOVED} ${PRESS_AGAIN}`,
      };
    case "entries-closed":
      return {
        code,
        short: "the lobby stopped taking deposits before yours arrived",
        detail:
          `${n}'s entry deadline passed while your wallet was open, so it is no longer taking ` +
          `deposits and yours was refused. ${NOTHING_MOVED} ${PRESS_AGAIN}`,
      };
    case "round-full":
      return {
        code,
        // A FULL ROOM IS NOT A SLOW PLAYER, and the program checks it before the deadline for exactly
        // that reason (see `enter`'s own comment). Being told you were late when you were not would
        // send somebody off to press faster at a problem pressing cannot solve.
        short: "the round filled up before your deposit arrived",
        // The only one that does not end on `PRESS_AGAIN` verbatim: this state has a fact the other
        // two do not — the next room will not be full — and naming the next lobby twice to keep the
        // shared string would read as a stutter.
        detail:
          `${n} took its last seat while your wallet was open, so there was no room left and your ` +
          `deposit was refused. ${NOTHING_MOVED} The next lobby starts empty — your stake is still ` +
          "set here, so press the same button again when it opens.",
      };
  }
}

/**
 * `Error.name` ON A REFUSAL, so a caller can tell one from every other failure — and the reason a
 * NAME is used rather than a message match is `useActions.ts`'s `STOPPED_WAITING`'s reason: the
 * alternative is a regex over copy, and the copy is deliberately full of words (`wallet`,
 * `deposit`, `refused`) that other classifiers in this codebase are already looking for.
 */
export const ENTRY_REFUSED = "EntryRefused";

/**
 * A REFUSAL AS A THROWN ERROR — carrying the whole verdict, not just one of its two strings.
 *
 * ONE THROW, TWO AUDIENCES, AND THAT IS WHY THE OBJECT TRAVELS. `sendEnter` is shared by the press a
 * player just made and by the repeat rule depositing with nobody in the room, and the same refusal
 * has to read differently to each: `detail` says "your wallet was open… press the same button again",
 * which is true of a person and false of a timer. The message defaults to `detail` — the attended
 * case, which is the common one and needs no work at the call site — and the unattended caller reads
 * `refusalOf(e).short` instead and words its own sentence. Throwing only a string would have forced
 * whichever caller lost that argument to parse copy.
 */
export function entryRefusedError(refusal: EntryRefusal): Error & { refusal: EntryRefusal } {
  const e = new Error(refusal.detail) as Error & { refusal: EntryRefusal };
  e.name = ENTRY_REFUSED;
  e.refusal = refusal;
  return e;
}

/** The verdict back off a thrown error, or null if this is not one of ours. */
export function refusalOf(e: unknown): EntryRefusal | null {
  if (!(e instanceof Error) || e.name !== ENTRY_REFUSED) return null;
  const carried = (e as Error & { refusal?: unknown }).refusal;
  return typeof carried === "object" && carried !== null ? (carried as EntryRefusal) : null;
}

/**
 * COULD A DEPOSIT SENT RIGHT NOW LAND? — asked of a FRESH read, immediately before the transaction is
 * built, and answered in the program's own words.
 *
 * THE GUARDS ARE IN `enter`'S ORDER, WHICH IS NOT TIDINESS. The program checks the phase, then the
 * room, then the deadline, and it orders the last two deliberately — "a player who arrives at a full
 * lobby is told the lobby is FULL rather than that they were too slow". Mirroring that order is what
 * makes this function's answer and the chain's answer the SAME answer rather than two answers that
 * usually agree.
 *
 * THE DEADLINE USES `ENTRY_CLOSE_GUARD_MS`, i.e. the exact predicate `entriesOpen()` uses, conceding
 * the last two seconds of a lobby rather than racing the validator's clock with the browser's. One
 * definition of "can a deposit land" for the whole page.
 *
 * THIS IS NOT A GUARANTEE AND MUST NOT BE READ AS ONE. Whatever this reads is already the past by the
 * time the transaction is signed and submitted — a second or two later, and longer if a dialog opens.
 * It turns a CERTAIN failure into an unlikely one; `refusalFromProgramError` is what covers the rest,
 * with the same words.
 */
export function entryRefusal(window: EntryWindow, nowMs: number): EntryRefusal | null {
  if (window.phase !== "Lobby") return entryRefusalCopy("round-moved-on", window.roundNo);
  if (window.fighterCount >= MAX_FIGHTERS) return entryRefusalCopy("round-full", window.roundNo);
  if (window.lobbyClosesAtMs !== null && nowMs + ENTRY_CLOSE_GUARD_MS >= window.lobbyClosesAtMs) {
    return entryRefusalCopy("entries-closed", window.roundNo);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The same question, asked of what the chain threw
// ---------------------------------------------------------------------------------------------

/** Anchor error NAMES, in `enter`'s own guard order, paired with the state each one describes. The
 *  names are the stable half of an `#[error_code]`; the numbers are looked up per deploy — see
 *  `enterErrorCodes`. */
const REFUSAL_BY_ERROR: ReadonlyArray<readonly [name: string, code: EntryRefusalCode]> = [
  ["NotInLobby", "round-moved-on"],
  ["RoundFull", "round-full"],
  ["LobbyClosed", "entries-closed"],
];

/** name → error number, as the DEPLOYED program defines them.
 *
 *  Built from `loadIdl()`'s `errors` array rather than written down, because a hard-coded 6002 is a
 *  number that silently means something else after the next variant is inserted, while the IDL is
 *  fetched at runtime and cannot be ahead of the program it describes. An IDL with no `errors` array
 *  yields an empty map, and the matcher below degrades to name-only — which is the pre-rollup
 *  behaviour and refuses nothing that used to work. */
export function enterErrorCodes(errors: ReadonlyArray<{ name: string; code: number }> | undefined):
  ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const [errorName] of REFUSAL_BY_ERROR) {
    const found = errors?.find((e) => e.name === errorName);
    if (found !== undefined) map.set(errorName, found.code);
  }
  return map;
}

/** Everything readable off a thrown chain error, flattened once.
 *
 *  FOUR FIELDS, AND EVERY ONE OF THEM REALLY ARRIVES. `@solana/web3.js`'s `SendTransactionError` puts
 *  the RPC's sentence in `transactionMessage` and the simulation logs in `transactionLogs`, and
 *  inlines the last ten log lines into `message`; `logs` is its own deprecated accessor for the same
 *  array, and is the field `useActions.ts`'s `isFightBehind` reads. On the ER path measured above,
 *  only `message`/`transactionMessage` are populated at all. Reading all four costs nothing and is
 *  the difference between working in a test and working in the browser. */
function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e === null || e === undefined || typeof e !== "object") return "";
  const o = e as { message?: unknown; transactionMessage?: unknown; logs?: unknown; transactionLogs?: unknown };
  const parts: string[] = [];
  for (const v of [o.message, o.transactionMessage]) if (typeof v === "string") parts.push(v);
  for (const v of [o.logs, o.transactionLogs]) {
    if (Array.isArray(v)) for (const l of v) if (typeof l === "string") parts.push(l);
  }
  return parts.join("\n");
}

/**
 * Did the chain refuse this `enter` for reason `errorName`?
 *
 * THREE ANCHORED FORMS, because the same refusal arrives written three different ways depending on
 * which layer answered — all three observed on devnet, none of them inferred:
 *
 *   `Error Code: NotInLobby.`      the Anchor log line. Base layer only; the router strips logs.
 *   `Error Number: 6002.`          the same log line's other half.
 *   `custom program error: 0x1772` the RPC's own sentence, and on the ROLLUP PATH THE ONLY ONE THERE
 *                                  IS. Lower-case hex, hence the case-insensitive match.
 *
 * Each is anchored to its surrounding phrase rather than matched bare: a loose `/6002/` would find a
 * lamport figure, a slot, or half a signature. `\b` on the name so a future `NotInLobbyYet` is not
 * read as this one — the same rule `isFightBehind` follows and for the same reason.
 */
function refusedWith(text: string, errorName: string, code: number | undefined): boolean {
  if (new RegExp(`Error Code: ${errorName}\\b`).test(text)) return true;
  if (code === undefined) return false;
  if (new RegExp(`Error Number: ${code}\\b`).test(text)) return true;
  return new RegExp(`custom program error: 0x${code.toString(16)}\\b`, "i").test(text);
}

/**
 * THE CHAIN'S REFUSAL, IN THE SAME WORDS THE PRE-CHECK WOULD HAVE USED — or null when this error is
 * not one of the three and should be left exactly as it is.
 *
 * NULL IS THE IMPORTANT RETURN. Every other program error on this path keeps the chain's own text,
 * because `walletFault.ts` is right that a paraphrase of "NothingToExtract" is worth less than the
 * original. This function claims only the three failures a player caused nothing and can do nothing
 * about, and hands everything else back untouched.
 */
export function refusalFromProgramError(
  e: unknown,
  codes: ReadonlyMap<string, number>,
  roundNo: bigint | null,
): EntryRefusal | null {
  const text = errorText(e);
  if (text === "") return null;
  for (const [errorName, code] of REFUSAL_BY_ERROR) {
    if (refusedWith(text, errorName, codes.get(errorName))) return entryRefusalCopy(code, roundNo);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Saying it BEFORE the dialogs open, which is worth more than any error after them
// ---------------------------------------------------------------------------------------------

/**
 * ROUGHLY HOW LONG A PRESS TAKES TO REACH THE CHAIN, per signing plan, in seconds.
 *
 * ESTIMATES, AND LABELLED AS SUCH — the same discipline `autoSession.ts` applies to
 * `ASSUMED_SESSION_TOP_UP_SOL`. The 20-second figure in the report that produced this feature covers
 * a cold first visit (approve the connection, then approve the session), so the session-opening plan
 * is put a little under it and a plain wallet signature at about half. Nothing is measured here and
 * nothing pretends to be.
 *
 * THEY DECIDE WHETHER A SENTENCE APPEARS AND NOTHING ELSE. No button is ever disabled off these
 * numbers — see `firstDeployWarning`. So being wrong costs a warning shown a few seconds early or
 * late, which is why a rough number is allowed to live here at all.
 */
export const APPROVAL_SECONDS: Readonly<Record<SigningPlan["kind"], number>> = {
  /** Unreachable — a live session is `silent` and `firstDeployWarning` returns before reading this.
   *  Kept so the record stays TOTAL over `SigningPlan["kind"]`: a new plan kind must be priced here
   *  or the build fails, rather than defaulting to some number nobody chose. */
  session: 0,
  /** One Phantom approval to open the session, and then the deposit goes through silently. */
  "open-then-session": 15,
  /** One Phantom approval for the deposit itself. */
  wallet: 8,
};

/**
 * "YOU PROBABLY WILL NOT MAKE THIS ONE" — said before the dialogs open, or not said at all.
 *
 * THIS IS THE HALF THAT IS WORTH MORE THAN THE ERROR MESSAGE. A player who knows the round is about
 * to close can decide to wait for the next one; a player who finds out afterwards has spent twenty
 * seconds and a wallet dialog learning it. And the case it fires in is not an edge: the keeper closes
 * a lobby `REAL_PLAYER_GRACE_SECONDS` (20s) after the FIRST real entry, so a newcomer who arrives a
 * beat after somebody else is racing twenty seconds with an approval chain that takes about twenty.
 *
 * IT IS A WARNING AND NEVER A DISABLED BUTTON, deliberately, and the argument is not squeamishness:
 *
 *   · The estimate is an estimate. Disabling a control off a number nobody measured would refuse a
 *     player a deposit that would have landed.
 *   · The deposit is now SAFE TO ATTEMPT. The pre-send check refuses a doomed transaction before it
 *     is built, and the refusal costs nothing and keeps the staged stake. There is no fee to protect
 *     anybody from, so there is nothing left for a disabled button to buy.
 *   · SPEC.md's rule is that a control a player cannot press must say why. It does not say to take
 *     controls away from players who might still succeed.
 *
 * `secondsLeft` MUST BE NULL WHERE NO COUNTDOWN EXISTS, and the caller has to honour that: a lobby
 * the keeper is holding open for players has no deadline at all (`roundPhaseCopy.ts` prints `OPEN`
 * where a clock would go, and an E2E test holds it there). Reaching past that for the chain's
 * hour-away backstop would put "closes in 59:47" into this sentence, which is the exact lie that
 * whole mechanism exists to delete.
 */
export function firstDeployWarning(plan: SigningPlan, secondsLeft: number | null): string | null {
  if (secondsLeft === null) return null;
  // NO DIALOG, NOTHING TO WARN ABOUT — and `unattendedSigning` is asked rather than re-derived,
  // because "does this plan raise an approval" is EXACTLY the question it already answers, its switch
  // has no `default` so a new `SessionOffReason` breaks the build there and is decided once, and a
  // second copy of the classification here would drift.
  //
  // IT IS THREE PLANS AND NOT ONE, WHICH IS THE PART A HAND-ROLLED VERSION GETS WRONG. A live session
  // is the obvious one. `?signer=burner` signs with a local keypair that never had a wallet to prompt
  // and `?fixture=1` signs nothing whatsoever — both would otherwise have been told, over invented
  // data, that a Phantom approval was about to be too slow. `ArenaProvider` routes the fixture through
  // `signingPlan` specifically so the page stops quoting a first approval that is never coming; this
  // is the same rule, and it must not be the exception to it.
  if (unattendedSigning(plan).kind === "silent") return null;
  const budget = APPROVAL_SECONDS[plan.kind];
  if (budget === 0 || secondsLeft > budget) return null;

  const closes = `Deposits here close in about ${secondsLeft}s`;
  const approval =
    plan.kind === "open-then-session"
      ? "your first deploy needs one Phantom approval before it can be sent"
      : "this deploy needs one Phantom approval before it can be sent";
  return (
    `${closes}, and ${approval} — which usually takes longer than that. If the round closes first, ` +
    "nothing is lost: press the same button again and it goes into the next lobby."
  );
}
