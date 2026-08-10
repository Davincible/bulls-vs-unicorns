// THE JUDGEMENTS `useAutoDeploy.ts` MAKES THAT ARE NOT REACT — what a failed send means, which rounds
// have been lost, and what a confirmed deposit does to the books. They live as plain functions for the reason
// `historyScan.ts` gives at length: this project has no React testing library (vitest, oxlint and
// typescript are the entire devDependency list), so a decision that lived inside the hook would be a
// decision nothing could ever assert. A rule that spends money with nobody watching it has to be
// provable by a plain Node test rather than by leaving a tab open overnight and hoping.
//
// TWO OF THE THREE ARE REGRESSIONS AGAINST DEFECTS THAT WERE SHIPPED:
//
//   · "ONE ERROR PER LOST ROUND, ALWAYS" WAS NOT TRUE. Three paths can write a round off and only one
//     of them said so. The silent one was `expireStaleAttempt`, which produces `round-moved-on` and
//     is produced by nothing else — and whose realistic trigger is exactly the case this feature
//     exists for: a suspended or backgrounded tab that resumes several rounds later. So the rounds
//     lost while nobody was watching were precisely the rounds nobody was ever told about. `lostRound`
//     is asked of the TRANSITION rather than of the call site, so the promise is kept by construction
//     and a fourth path added later is reported without anybody remembering to report it.
//   · A LAPSED SESSION WAS TREATED AS AN ORDINARY FAILURE, which bought three identical refusals per
//     round — each a real devnet fee — to learn a fact the first one had established, and then asked
//     `runSigned` to fix it by replacing the session: two Phantom approvals, at an empty chair, every
//     round. `classifySendFailure` is the fork that routes it to `noteSessionRefused` instead.
//
// NO TEST HERE STATES HOW LONG A SESSION LASTS, for the reason `autoPolicy.test.ts` gives: the
// constant is moving, and a fixture holding the old value would keep passing while the behaviour it
// checks became wrong by a factor of twenty-four.

import { describe, expect, it } from "vitest";
import {
  INITIAL_AUTO_DEPLOY,
  abandonAttempt,
  attemptFailed,
  attemptLanded,
  beginAttempt,
  expireStaleAttempt,
  noteSessionRefused,
  type AutoDeployState,
} from "./autoDeploy.ts";
import { UNATTENDED_REFUSED } from "./autoPolicy.ts";
import {
  applySendOutcome,
  bookConfirmedDeposit,
  classifySendFailure,
  lostRound,
  lostRoundText,
  walletSwapped,
} from "./useAutoDeploy.ts";
import { STOPPED_WAITING } from "./useActions.ts";
import { classifyWalletError } from "./walletFault.ts";

const ARMED: AutoDeployState = { ...INITIAL_AUTO_DEPLOY, armed: true, side: 0 };

/** The account every deposit below is made from. A run's books belong to the wallet that paid for
 *  them — see `RunPnl.wallet` — so a fixture that left this blank would be exercising the
 *  "no owner yet" branch rather than the ordinary one. */
const YOU_WALLET = "You1111111111111111111111111111111111111111";

/** A round mid-retry — the only state `expireStaleAttempt` acts on, and the one a tab that went to
 *  sleep during a lobby wakes up holding. */
function retryingOn(roundNo: bigint): AutoDeployState {
  return attemptFailed(beginAttempt(ARMED, roundNo), roundNo, "connection closed", 1_000);
}

// =============================================================================================
// What a failed send means
// =============================================================================================

/** The chain's own words when a session token has lapsed — `verify-session-base.mjs` step 5 proves
 *  an expired token fails exactly this way. */
const CHAIN_REFUSED_THE_SESSION = new Error(
  "failed to send transaction: custom program error: InvalidToken",
);

describe("classifySendFailure", () => {
  it("calls a refused session what it is, so the round is not retried into a certainty", () => {
    expect(classifySendFailure(CHAIN_REFUSED_THE_SESSION)).toBe("session-lapsed");
  });

  // THE ROUND TRIP, AND IT IS A REAL COUPLING RATHER THAN A HYPOTHETICAL ONE. `useActions`'s
  // `rethrow` REWRITES a session refusal into the sentence a player reads before this ever sees it —
  // so the classification has to survive the rewrite. Written as a round trip rather than as a
  // hard-coded paragraph so that editing the copy either keeps working or fails HERE, loudly, rather
  // than quietly turning every lapse back into three paid retries and two wallet dialogs.
  it("still recognises a refused session after `useActions` has rewritten it for a player", () => {
    const rewritten = new Error(classifyWalletError(CHAIN_REFUSED_THE_SESSION).detail);
    expect(classifySendFailure(rewritten)).toBe("session-lapsed");
  });

  it("gives an ordinary chain failure another go inside the same lobby", () => {
    expect(classifySendFailure(new Error("custom program error: RoundFull"))).toBe("retry");
    expect(classifySendFailure(new Error("Blockhash not found"))).toBe("retry");
    expect(classifySendFailure(new Error(""))).toBe("retry");
    expect(classifySendFailure("connection closed")).toBe("retry");
  });

  // A REFUSAL TO SEND IS NOT A FAILED SEND. Nothing left this page, nothing was spent, and the round
  // has not been damaged — so it must not end the round. The ladder asks how a deposit would be
  // signed before anything can write a round off, so the next evaluation simply holds and says why.
  it("does not treat a refusal to raise a wallet dialog as a lapsed session", () => {
    expect(classifySendFailure(new Error(UNATTENDED_REFUSED))).toBe("retry");
  });

  // THE UNATTENDED PATH IS BOUNDED TOO, and what a timeout means to the rule is "try again", not
  // "your session is gone". `blockhashForAccounts` is a bare `fetch` with no timeout and runs before
  // a blockhash exists, so a stall there used to park the attempt in `sending` forever — which
  // `expireStaleAttempt` refuses to expire on purpose, leaving the rule permanently silent under a
  // status line reading "Depositing…". This is the seam that lets it recover instead.
  it("treats a send this page stopped waiting for as another go, not as a dead session", () => {
    const gaveUp = new Error("The deposit into round 41 did not come back within 2 minutes");
    gaveUp.name = STOPPED_WAITING;
    expect(classifySendFailure(gaveUp)).toBe("retry");
  });
});

// =============================================================================================
// What one unattended send did to the run
// =============================================================================================

const SENT = { roundNo: 41n, amountUsd: 25, sessionEpochAtSend: 3,
      walletAtSend: YOU_WALLET, nowMs: 1_000 };

describe("applySendOutcome", () => {
  it("books a confirmed deposit against the budget, at the amount the transaction carried", () => {
    const sending = beginAttempt(ARMED, 41n);
    const after = applySendOutcome(sending, { ...SENT, signature: "sig-1", error: null });
    expect(after.attempt?.outcome).toBe("landed");
    expect(after.attempt?.signature).toBe("sig-1");
    expect(after.tally.entered).toBe(1);
    expect(after.tally.spentUsd).toBe(25);
  });

  it("ends the round and latches the lapse when the chain refuses the session", () => {
    const sending = beginAttempt(ARMED, 41n);
    const after = applySendOutcome(sending, { ...SENT, signature: null, error: CHAIN_REFUSED_THE_SESSION });
    expect(after.attempt?.abandonedBecause).toBe("session-lapsed");
    expect(after.deadSessionEpoch).toBe(3);
    // Terminal, and counted — a lapse is a round the run lost, not a round it declined.
    expect(after.tally.missed).toBe(1);
  });

  // THE CAPTURE, WHICH IS THE WHOLE REASON THIS FUNCTION TAKES AN EPOCH INSTEAD OF READING ONE. A
  // player pressing Start while the refusal is still in flight opens a fresh session and advances the
  // count; latching THAT would tell the rule its brand-new key was already dead, and the run would
  // stay silent for the rest of the tab's life with a working session in hand.
  it("latches the session that was refused, not whichever one exists by the time it hears back", () => {
    const sending = beginAttempt(ARMED, 41n);
    const after = applySendOutcome(sending, {
      ...SENT,
      sessionEpochAtSend: 3,
      walletAtSend: YOU_WALLET,
      signature: null,
      error: CHAIN_REFUSED_THE_SESSION,
    });
    // The tab has since opened a fourth session. The latch is on the third, so it can never match.
    expect(after.deadSessionEpoch).toBe(3);
    expect(after.deadSessionEpoch).not.toBe(4);
  });

  it("gives an ordinary failure another go, and keeps the chain's own words for it", () => {
    const sending = beginAttempt(ARMED, 41n);
    const after = applySendOutcome(sending, {
      ...SENT,
      signature: null,
      error: new Error("custom program error: RoundFull"),
    });
    expect(after.attempt?.outcome).toBe("retrying");
    expect(after.attempt?.error).toBe("custom program error: RoundFull");
    expect(after.deadSessionEpoch).toBeNull();
    expect(after.tally.missed).toBe(0);
  });

  it("never quotes a bare object back at a player as the reason a round failed", () => {
    const sending = beginAttempt(ARMED, 41n);
    const after = applySendOutcome(sending, { ...SENT, signature: null, error: {} });
    expect(after.attempt?.error).not.toContain("[object Object]");
    expect(after.attempt?.error.length).toBeGreaterThan(0);
  });
});

// =============================================================================================
// A confirmed deposit, from any surface
// =============================================================================================

describe("bookConfirmedDeposit", () => {
  it("records the side a repeat should follow", () => {
    expect(bookConfirmedDeposit(INITIAL_AUTO_DEPLOY, 1, 41n).side).toBe(1);
  });

  it("marks the round as had, so a hand deploy is not doubled before the roster catches up", () => {
    const after = bookConfirmedDeposit(ARMED, 0, 41n);
    expect(after.attempt?.roundNo).toBe(41n);
    expect(after.attempt?.outcome).toBe("landed");
  });

  // THE REGRESSION, AND IT WAS LOSING MONEY OUT OF THE BUDGET. This fires before `attemptLanded` for
  // the rule's own deposit. Booking a DIFFERENT round here overwrote the single attempt slot, so
  // `attemptLanded` found a record for another round, returned unchanged, and `tallyEntered` never
  // ran — a confirmed, paid-for deposit never charged against the budget.
  it("stands aside while the rule's own transaction is still in flight", () => {
    const sending = beginAttempt(ARMED, 41n);
    // The poll has moved on to 42 by the time the deposit into 41 confirms.
    const booked = bookConfirmedDeposit(sending, 0, 42n);
    expect(booked.attempt?.roundNo).toBe(41n);
    expect(booked.attempt?.outcome).toBe("sending");

    // …so `attemptLanded` still finds its own round, and the budget is charged exactly once.
    const landed = applySendOutcome(booked, { ...SENT, signature: "sig-1", error: null });
    expect(landed.tally.entered).toBe(1);
    expect(landed.tally.spentUsd).toBe(25);
  });

  it("still records the side while standing aside", () => {
    expect(bookConfirmedDeposit(beginAttempt(ARMED, 41n), 1, 42n).side).toBe(1);
  });

  it("records only the side when no round number is knowable", () => {
    const after = bookConfirmedDeposit(ARMED, 1, null);
    expect(after.side).toBe(1);
    expect(after.attempt).toBeNull();
  });

  // THE HAZARD THIS CALLBACK ACQUIRED THE DAY IT STARTED BEING TOLD THE TRUTH. While it derived the
  // round from the current poll it could not be handed an old one; taking the round the transaction
  // was actually written to makes a stale round reachable for the first time. The path is a
  // confirmation that outlives `SEND_PATIENCE_MS`: the page stops waiting, the rule moves on to round
  // 45, and then the abandoned transaction resolves and books round 41.
  //
  // Unguarded that costs a round and then a stake. The single attempt slot would be overwritten with
  // round 41, so the rule would stop seeing `deployed-this-round` for 45 and — while the roster poll
  // caught up — send a SECOND deposit into a round it had already entered; `tallyEntered` would then
  // drop that second confirmation as a duplicate, so the second real stake would never be charged
  // against the budget.
  it("refuses a confirmation for a round older than the one being worked on", () => {
    const working = attemptLanded(beginAttempt(ARMED, 45n), 45n, "sig-45", 25, YOU_WALLET);
    const late = bookConfirmedDeposit(working, 1, 41n);
    expect(late.attempt?.roundNo).toBe(45n);
    expect(late.attempt?.outcome).toBe("landed");
    expect(late.attempt?.signature).toBe("sig-45");
    // The side is still learned from it: a confirmed deposit is evidence of which side this browser
    // plays whatever round it landed in.
    expect(late.side).toBe(1);
  });

  it("still books a round newer than the last one, which is the ordinary case", () => {
    const done = attemptLanded(beginAttempt(ARMED, 41n), 41n, "sig-41", 25, YOU_WALLET);
    expect(bookConfirmedDeposit(done, 0, 42n).attempt?.roundNo).toBe(42n);
  });
});

// =============================================================================================
// One error per lost round, whichever path loses it
// =============================================================================================

describe("lostRound", () => {
  it("reports a round the decision ladder wrote off", () => {
    const before = ARMED;
    const after = abandonAttempt(before, 41n, "entries-closed");
    expect(lostRound(before, after)?.roundNo).toBe(41n);
    expect(lostRound(before, after)?.abandonedBecause).toBe("entries-closed");
  });

  // THE ONE THAT WAS SILENT, and the reason this function exists. `round-moved-on` is produced here
  // and nowhere else, and the tab that produces it is the tab that was asleep.
  it("reports a round abandoned because the chain moved past it while nobody was watching", () => {
    const before = retryingOn(41n);
    const after = expireStaleAttempt(before, 42n);
    const lost = lostRound(before, after);
    expect(lost?.roundNo).toBe(41n);
    expect(lost?.abandonedBecause).toBe("round-moved-on");
  });

  it("reports a round ended by a lapsed session", () => {
    const before = beginAttempt(ARMED, 41n);
    const after = noteSessionRefused(before, 41n, 1);
    expect(lostRound(before, after)?.abandonedBecause).toBe("session-lapsed");
  });

  // ONCE, NOT ONCE A SECOND. The rule is re-asked on a one-second clock and every tick runs this
  // comparison, so a lost round that kept answering here would be a red toast per second for as long
  // as the round stayed on screen.
  it("says nothing about a round that was already written off", () => {
    const settled = abandonAttempt(ARMED, 41n, "entries-closed");
    expect(lostRound(settled, settled)).toBeNull();
    expect(lostRound(settled, expireStaleAttempt(settled, 42n))).toBeNull();
  });

  it("says nothing about a round that landed, or about a round still being tried", () => {
    const sending = beginAttempt(ARMED, 41n);
    expect(lostRound(ARMED, sending)).toBeNull();
    expect(lostRound(sending, attemptLanded(sending, 41n, "sig-1", 25, YOU_WALLET))).toBeNull();
    expect(lostRound(sending, attemptFailed(sending, 41n, "rpc blip", 1_000))).toBeNull();
  });

  it("reports the next lost round even though the last one was also lost", () => {
    const first = abandonAttempt(ARMED, 41n, "entries-closed");
    const second = abandonAttempt(first, 42n, "phase-moved-on");
    expect(lostRound(first, second)?.roundNo).toBe(42n);
  });

  // THE STATEMENT A PLAYER READS LONG AFTERWARDS is the other half of "it said so at the time", and a
  // round reported as an error but missing from the account of the run would be a contradiction the
  // player meets hours later with nothing to check it against.
  it("counts every silently-lost round in the run's own tally", () => {
    const after = expireStaleAttempt(retryingOn(41n), 42n);
    expect(after.tally.missed).toBe(1);
    expect(after.tally.firstRound).toBe(41n);
  });
});

describe("lostRoundText", () => {
  it("names the round and hands the reason its own words", () => {
    const lost = lostRound(retryingOn(41n), expireStaleAttempt(retryingOn(41n), 42n));
    const text = lostRoundText(lost as NonNullable<typeof lost>);
    expect(text).toContain("41");
    expect(text).toContain("a newer round opened while it was still retrying");
  });

  it("carries the chain's last words through a round that ran out of tries", () => {
    const exhausted = abandonAttempt(retryingOn(41n), 41n, "retries-exhausted");
    const lost = lostRound(retryingOn(41n), exhausted);
    expect(lostRoundText(lost as NonNullable<typeof lost>)).toContain("connection closed");
  });
});

// =============================================================================================
// A different wallet inherits nothing
// =============================================================================================

describe("walletSwapped", () => {
  // THE ONE WAY THIS RULE'S LEDGER CAN READ A REAL LOSS AS NO LOSS AND NEVER CORRECT ITSELF.
  // `ChainArena` does not remount when Phantom's account changes — `youPubkey` simply becomes a
  // different string while the rule keeps every byte of its state. An armed run would carry on under
  // the new account with the old account's books, and worse: `bookSettledRounds` would find the run's
  // outstanding round settled, see no row for the NEW wallet, book it as zero, and advance the cursor
  // past a loss that really happened. A booked round is never revisited, so that one is permanent.
  it("ends the run when the account under it is swapped for a different one", () => {
    expect(walletSwapped("wallet-a", "wallet-b")).toBe(true);
  });

  it("does not end it on a disconnect, or on a reconnect of the same account", () => {
    // `""` is "nobody". A wallet that drops and comes back is the same player with the same books;
    // the run holds harmlessly on `no-signer` in between. Reading that as a switch would end a
    // perfectly good overnight run on one dropped provider event.
    expect(walletSwapped("wallet-a", "")).toBe(false);
    expect(walletSwapped("", "wallet-a")).toBe(false);
    expect(walletSwapped("wallet-a", "wallet-a")).toBe(false);
    expect(walletSwapped("", "")).toBe(false);
  });
});

// =============================================================================================
// WHAT THE RUN IS UP OR DOWN NO LONGER LIVES HERE
// =============================================================================================
//
// `runPnlUsd` was in this file: re-scan the round log over the run's whole span, sum this player's
// rows, and refuse to answer unless the span was covered without a hole. Both of its rules were
// right and the pair of them capped the feature — the log is a window of about
// `MIN_RETAINED_ROUNDS`, so a run that lasted longer than the window could not be measured over its
// own span at all, and the drawdown stop held every overnight run after about half an hour.
//
// A run's realised P&L is a RUNNING TOTAL the rule owns and accumulates as its rounds settle, so it
// is now `RunPnl` in `autoPolicy.ts` and its tests are in `autoPolicy.test.ts` beside the limit it
// feeds. What stayed here is the wiring, which is what this file is for.
