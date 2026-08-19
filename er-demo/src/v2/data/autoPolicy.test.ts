// THE RULES AN UNATTENDED RULE IS UNDER, proved without a wallet, a chain, or a night of waiting.
//
// Three of these suites are regressions against defects or against decisions that would be expensive
// to lose, and they are the three worth reading first:
//
//   · `runUnattendedEntry` — the write path used to answer a lapsed session with `renew-and-retry`,
//     which is revoke-then-create, which is two Phantom approvals raised at a screen nobody is
//     watching, every round, forever. The tests here assert an ABSENCE: given a plan that would cost
//     an approval, nothing is sent at all. They do NOT hold spies for the recovery callbacks, and the
//     reason is worth stating once — that function takes no such callbacks, so a spy on one could
//     never be called by any implementation of its signature. An unfalsifiable assertion reads as
//     coverage and is not any. The absence of the parameters is the guarantee; the tests assert the
//     one thing that can actually be witnessed, which is that the send was never reached.
//   · ONE INSTRUCTION, AND IT IS AN ENTRY. `SOCIAL.md` §1.1 makes "never ship auto-extract" a hard
//     rule, and a rule that lives only in prose is one hurried afternoon from being wired around.
//     There is a test below that fails the day a second unattended sender appears.
//   · `runway` — `FEE_BPS` was hardcoded as THE fee and was moved 20 → 100 on devnet while the site
//     was serving, so every surface holding the constant quoted a rate five times off until the next
//     build. A projection of somebody's whole night is the last place that mistake should be made
//     again, so there is a test asserting that changing the live rate changes the answer.
//
// NO TEST HERE STATES HOW LONG A SESSION LASTS. The constant is moving (`SOCIAL.md` §5.2), and a
// fixture that hard-coded the old value would keep passing while the copy it is checking became
// wrong by a factor of twenty-four. Where a full session's length is genuinely the subject, it comes
// from `sessionExpiry.ts`'s `ASSUMED_SESSION_MINUTES`, which is the single mirror of it.

import { describe, expect, it, vi } from "vitest";
import { MIN_RETAINED_ROUNDS } from "../../chain/constants.ts";
import {
  FEE_BPS,
  MIN_STAKE_USD,
  STAKE_CAP_USD,
  feeRate,
  usdToUnits,
  type FeeRate,
  type PhaseName,
  type RoundPlayer,
  type RoundSummary,
} from "../contract.ts";
import type { SessionOffReason, SigningPlan } from "./autoSession.ts";
import { ASSUMED_SESSION_MINUTES } from "./sessionExpiry.ts";
import * as policy from "./autoPolicy.ts";
import {
  ASSUMED_ROUND_SECONDS,
  DEFAULT_LIMITS,
  EMPTY_RUN_PNL,
  EMPTY_TALLY,
  UNATTENDED_REFUSED,
  bookSettledRounds,
  chooseSide,
  clampToLimits,
  drawdownStopUsd,
  isUnattendedRefusal,
  limitBlock,
  pnlEntered,
  provenLossUsd,
  readRunPnl,
  runUnattendedEntry,
  runway,
  runwayNote,
  tallyEntered,
  tallyMissed,
  tallyReport,
  unattendedSigning,
  type AutoLimits,
  type RunPnlReading,
  type RunTally,
  type UnattendedEntry,
} from "./autoPolicy.ts";

/** One deposit into one round — the only thing this module can be asked to send. */
const ENTRY: UnattendedEntry = { roundNo: 41n, side: 0, amountUsd: 25 };

// =============================================================================================
// Who may sign with nobody watching
// =============================================================================================

/**
 * EVERY SHAPE `SigningPlan` HAS, and the compiler is what keeps it complete.
 *
 * A HAND-WRITTEN ARRAY WOULD NOT DO. The property under test is TOTALITY, and a list somebody has to
 * remember to extend proves nothing on the day they forget — a seventh plan would simply never be
 * asked whether it costs an approval, and the arm that answers "silent" is the dangerous default.
 * The `Record` below fails the build if a `SessionOffReason` is added, which is the same enforcement
 * `unattendedSigning`'s `default`-less switch gets, one level up.
 */
const EVERY_OFF_REASON: Record<SessionOffReason, true> = {
  burner: true,
  fixture: true,
  stopped: true,
  unaffordable: true,
  blocked: true,
};

const EVERY_PLAN: SigningPlan[] = [
  { kind: "session" },
  { kind: "open-then-session" },
  ...(Object.keys(EVERY_OFF_REASON) as SessionOffReason[]).map(
    (reason): SigningPlan => ({ kind: "wallet", reason }),
  ),
];

describe("unattendedSigning sorts every way this page can sign", () => {
  it("calls exactly three plans silent, and they are the three that raise no dialog", () => {
    // A live session key signs with no prompt; a burner is a local keypair that never had a wallet to
    // prompt; a fixture signs nothing at all. Excluding the last two would make this whole feature
    // untestable on the two setups it can be exercised on without a wallet in front of them.
    expect(unattendedSigning({ kind: "session" })).toEqual({ kind: "silent" });
    expect(unattendedSigning({ kind: "wallet", reason: "burner" })).toEqual({ kind: "silent" });
    expect(unattendedSigning({ kind: "wallet", reason: "fixture" })).toEqual({ kind: "silent" });

    const silent = EVERY_PLAN.filter((p) => unattendedSigning(p).kind === "silent");
    expect(silent).toHaveLength(3);
  });

  it("blocks opening a session, because opening one costs an approval", () => {
    // The move that opens a session belongs to somebody who pressed a button a second ago. A timer is
    // not that somebody.
    expect(unattendedSigning({ kind: "open-then-session" })).toEqual({
      kind: "blocked",
      reason: "needs-session",
    });
  });

  it("keeps the three wallet-signing reasons apart, because they need different sentences", () => {
    // A player who pressed Stop, a wallet that cannot afford the top-up and a page that cannot sign
    // anything at all are three different things to be told, and three different presses to fix.
    expect(unattendedSigning({ kind: "wallet", reason: "stopped" })).toEqual({
      kind: "blocked",
      reason: "session-stopped",
    });
    expect(unattendedSigning({ kind: "wallet", reason: "unaffordable" })).toEqual({
      kind: "blocked",
      reason: "session-unaffordable",
    });
    expect(unattendedSigning({ kind: "wallet", reason: "blocked" })).toEqual({
      kind: "blocked",
      reason: "no-signer",
    });
  });
});

// =============================================================================================
// runUnattendedEntry — the recovery paths that are not there, and the instruction that is
// =============================================================================================

describe("the unattended surface sends one kind of instruction", () => {
  it("exposes exactly one unattended sender, and it is an entry", () => {
    // `SOCIAL.md` §1.1: auto-play enters and never extracts, because an extraction is the judgement
    // the player came back to make and a robot that made it would be playing the whole game. This
    // test fails the day a `runUnattendedExtract` appears beside it — which is the point, because by
    // then the argument will have been forgotten and only the shape will be left to defend it.
    const senders = Object.keys(policy).filter((k) => k.startsWith("runUnattended"));
    expect(senders).toEqual(["runUnattendedEntry"]);
  });

  it("carries a round, a side and a stake — a shape an extraction cannot fit", () => {
    // AGAINST THE TYPE, NOT AGAINST THE FIXTURE. Written as `Object.keys(ENTRY)` this read the test's
    // own literal back to itself: a field added to `UnattendedEntry` would not appear in `ENTRY`, and
    // the assertion would keep passing while the thing it claims to defend had changed. The `Record`
    // fails the build instead — an extract names a fighter and a moment, and the day either appears
    // here somebody has to come and delete this sentence deliberately.
    const everyEntryField: Record<keyof UnattendedEntry, true> = {
      roundNo: true,
      side: true,
      amountUsd: true,
    };
    expect(Object.keys(everyEntryField).sort()).toEqual(["amountUsd", "roundNo", "side"]);
  });
});

describe("runUnattendedEntry will not ask for permission", () => {
  it("sends nothing at all on a plan that would cost an approval", async () => {
    const send = vi.fn(async () => "sent");

    for (const plan of EVERY_PLAN.filter((p) => unattendedSigning(p).kind === "blocked")) {
      await expect(runUnattendedEntry(plan, "a-session", ENTRY, send)).rejects.toThrow(UNATTENDED_REFUSED);
    }

    // THE ASSERTION THAT MATTERS: not that it returned an error, but that nothing happened.
    //
    // AND THE ONLY ONE WORTH MAKING HERE. An earlier version of this test also held spies for `open`,
    // `renew` and a wallet signature and asserted none had been called — which sounds like the
    // stronger claim and is in fact an unfalsifiable one, because `runUnattendedEntry` takes no such
    // callbacks and no implementation of its signature could reach them. The absence of those
    // parameters IS the guarantee; a spy cannot witness a parameter that does not exist. What can be
    // witnessed is that `send` was never reached, and that is asserted.
    expect(send).not.toHaveBeenCalled();
  });

  it("does not replace a session the chain refuses — it lets the refusal out", async () => {
    // `runSigned`'s answer to this is a renewal, and a renewal is revoke-then-create: two approvals.
    // That is the right answer for somebody who just pressed Deploy and is watching. Here the
    // refusal is the ANSWER — it is what tells the rule the session is gone. One call, and the error
    // comes straight back out: a second call would be the retry that has nowhere to go but a dialog.
    const send = vi.fn(async () => {
      throw new Error("custom program error: InvalidToken");
    });

    await expect(runUnattendedEntry({ kind: "session" }, "lapsed-session", ENTRY, send)).rejects.toThrow(
      "InvalidToken",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses a session plan with no session behind it rather than falling back to the wallet", async () => {
    // Reachable, and it is the dangerous one: the plan is an inference from `sessionActive`, the
    // handle is the fact, and a null session means "ask the wallet to sign it" — the exact popup this
    // exists to prevent.
    const send = vi.fn(async () => "sent");
    await expect(runUnattendedEntry({ kind: "session" }, null, ENTRY, send)).rejects.toThrow(UNATTENDED_REFUSED);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends once, with the session and with the entry it was given", async () => {
    const send = vi.fn(async (entry: UnattendedEntry, session: string | null) => `${entry.amountUsd}-by-${session}`);
    await expect(runUnattendedEntry({ kind: "session" }, "live-session", ENTRY, send)).resolves.toBe(
      "25-by-live-session",
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(ENTRY, "live-session");
  });

  it("signs directly on the two paths where direct means no wallet at all", async () => {
    // A burner keypair and the fixture. A null session here is "sign it yourself", which for both of
    // those reaches no wallet.
    const send = vi.fn(async (_entry: UnattendedEntry, session: string | null) => session);
    await expect(runUnattendedEntry({ kind: "wallet", reason: "burner" }, "ignored", ENTRY, send)).resolves.toBeNull();
    await expect(runUnattendedEntry({ kind: "wallet", reason: "fixture" }, "ignored", ENTRY, send)).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("makes its own refusal distinguishable from a chain error", async () => {
    // The caller has to tell them apart: a refusal is a hold whose reason is already on screen, and a
    // chain error is a failed attempt that earns a retry. Treating the first as the second is how a
    // rule ends up retrying something it has decided not to do.
    const refusal = await runUnattendedEntry({ kind: "open-then-session" }, null, ENTRY, async () => "sent").catch(
      (e) => e,
    );
    expect(isUnattendedRefusal(refusal)).toBe(true);
    expect(isUnattendedRefusal(new Error("blockhash not found"))).toBe(false);
    expect(isUnattendedRefusal("blockhash not found")).toBe(false);
    expect(isUnattendedRefusal(null)).toBe(false);
  });
});

// =============================================================================================
// The limits
// =============================================================================================

/** Nothing set that binds. Each suite below moves the one figure it is about. */
const NO_LIMIT: AutoLimits = {
  budgetUsd: 1_000_000,
  perRoundCapUsd: STAKE_CAP_USD,
  drawdownStopPct: null,
  maxRounds: null,
};

/** WHAT THE RUN'S LEDGER SAYS, in the three shapes it can say it. Spelled out as helpers because the
 *  difference between them is the subject of half the suite below: `at` is a figure, `UNREADABLE` is
 *  a pause that lifts on the next poll, and `lost` is a settled round the chain has thrown away and
 *  will never return. Reading any of the last two as a figure of zero is the defect these guard. */
const at = (usd: number): RunPnlReading => ({ kind: "known", usd });
const UNREADABLE: RunPnlReading = { kind: "unreadable", bookedUsd: 0 };
const lost = (fromRound: bigint, bookedUsd = 0): RunPnlReading => ({ kind: "gap", fromRound, bookedUsd });

/** A tally that has spent `spentUsd` over `entered` rounds — the only two fields the limits read. */
const spent = (spentUsd: number, entered = 1): RunTally => ({
  ...EMPTY_TALLY,
  spentUsd,
  entered,
  firstRound: 1n,
  lastRound: BigInt(entered),
  // A tally that has entered rounds has a cursor pointing at one of them. The limits do not read it,
  // but a fixture in a state the real transitions cannot produce is a test lying about its world.
  lastOutcome: "entered",
});

describe("clampToLimits declines rather than degrades", () => {
  it("sends the armed amount when every bound has room for it", () => {
    expect(clampToLimits(25, NO_LIMIT, 0)).toBe(25);
  });

  it("clamps to whichever bound is tightest, one at a time", () => {
    expect(clampToLimits(25, { ...NO_LIMIT, perRoundCapUsd: 10 }, 0)).toBe(10);
    expect(clampToLimits(25, { ...NO_LIMIT, budgetUsd: 100 }, 90)).toBe(10);
    // And to the arena's own per-side cap, whatever the player's limits say — a deposit the product
    // refuses is not something to send and find out about.
    expect(clampToLimits(5_000, { ...NO_LIMIT, perRoundCapUsd: 1_000 }, 0)).toBe(STAKE_CAP_USD);
  });

  it("never rounds its way up to a sendable amount", () => {
    // THE DEFECT THIS EXISTS TO PREVENT, in its second incarnation. The rule it mirrors —
    // `resolveAmountUsd` — used to clamp UP to a one-cent floor, so a percentage of an empty wallet
    // did not stop the feature; it quietly became a $0.01 deposit every round, each one paying a real
    // devnet fee to stake a tenth of a cent. Half a cent of budget is not a deposit.
    expect(clampToLimits(25, { ...NO_LIMIT, budgetUsd: 0.005 }, 0)).toBeNull();
    expect(clampToLimits(25, { ...NO_LIMIT, budgetUsd: 100 }, 99.995)).toBeNull();
    expect(clampToLimits(0.009, NO_LIMIT, 0)).toBeNull();
  });

  it("accepts exactly the minimum, and not a hundredth under it", () => {
    expect(clampToLimits(MIN_STAKE_USD, NO_LIMIT, 0)).toBe(MIN_STAKE_USD);
    expect(clampToLimits(MIN_STAKE_USD - 0.001, NO_LIMIT, 0)).toBeNull();
  });

  it("never returns more than the room it was given", () => {
    // Rounding is a convenience and must not carry a figure back over the bound it was just clamped
    // to. A budget exceeded by half a cent is a budget somebody has to explain.
    for (const budget of [10.004, 10.005, 10.006, 10.999, 0.294, 0.295]) {
      const out = clampToLimits(25, { ...NO_LIMIT, budgetUsd: budget }, 0);
      expect(out).not.toBeNull();
      expect(out ?? 0).toBeLessThanOrEqual(budget);
      // Still whole cents, and still not shaved by a float artefact: 0.295 of room must not become
      // 0.28, which is what flooring the scaled value produces.
      expect(Math.round((out ?? 0) * 100) / 100).toBe(out);
    }
    expect(clampToLimits(25, { ...NO_LIMIT, budgetUsd: 0.295 }, 0)).toBe(0.29);
  });

  it("sends nothing on a number that is not one", () => {
    // A control mid-edit, a stored value that is no longer a number. The answer to "how much should I
    // send" on a NaN is nothing at all.
    expect(clampToLimits(Number.NaN, NO_LIMIT, 0)).toBeNull();
    expect(clampToLimits(25, { ...NO_LIMIT, budgetUsd: Number.NaN }, 0)).toBeNull();
    expect(clampToLimits(-5, NO_LIMIT, 0)).toBeNull();
  });
});

describe("limitBlock names which bound stopped it", () => {
  it("tells the three stopping conditions apart, because they are three different sentences", () => {
    expect(limitBlock({ ...NO_LIMIT, budgetUsd: 50 }, spent(50), at(0))).toBe("budget-spent");
    expect(limitBlock({ ...NO_LIMIT, maxRounds: 4 }, spent(50, 4), at(0))).toBe("round-ceiling");
    expect(limitBlock({ ...NO_LIMIT, budgetUsd: 200, drawdownStopPct: 50 }, spent(50), at(-100))).toBe(
      "drawdown-stopped",
    );
    expect(limitBlock(NO_LIMIT, spent(50), at(0))).toBeNull();
  });

  it("reports the protective stop first, because it is different news from a finished run", () => {
    // A run that spent what it was given did what it was told. A run that is down more than the
    // player said they would accept is the thing they would want to hear first.
    expect(
      limitBlock({ budgetUsd: 100, perRoundCapUsd: 100, drawdownStopPct: 50, maxRounds: 1 }, spent(100, 4), at(-90)),
    ).toBe("drawdown-stopped");
  });

  it("measures the drawdown against the committed budget, so the setting keeps its meaning", () => {
    // A percentage of the budget rather than an absolute figure: doubling the budget doubles the loss
    // the same setting will tolerate, which is what a player means by "half".
    const half = { ...NO_LIMIT, budgetUsd: 400, drawdownStopPct: 50 };
    expect(drawdownStopUsd(half)).toBe(200);
    expect(limitBlock(half, spent(200), at(-199.99))).toBeNull();
    expect(limitBlock(half, spent(200), at(-200))).toBe("drawdown-stopped");
    expect(drawdownStopUsd({ ...NO_LIMIT, drawdownStopPct: null })).toBeNull();
  });

  it("does not read a profit as a small loss", () => {
    expect(limitBlock({ ...NO_LIMIT, budgetUsd: 100, drawdownStopPct: 50 }, spent(50), at(900))).toBeNull();
  });

  it("refuses to pass a drawdown stop it cannot evaluate", () => {
    // THE ONE THAT WOULD BE INVISIBLE IF IT WERE WRONG. A missing P&L is not a P&L of zero: a safety
    // limit that silently reads as satisfied is a no-op at exactly the moment it is supposed to fire.
    expect(limitBlock({ ...NO_LIMIT, drawdownStopPct: 50 }, spent(50), UNREADABLE)).toBe("drawdown-unknown");
    expect(limitBlock({ ...NO_LIMIT, drawdownStopPct: 50 }, spent(50), at(Number.NaN))).toBe("drawdown-unknown");
    // With no stop set there is nothing to evaluate, so an unreadable ledger stops nothing.
    expect(limitBlock({ ...NO_LIMIT, drawdownStopPct: null }, spent(50), UNREADABLE)).toBeNull();
  });

  it("does not let a limit that is not a number disable itself in silence", () => {
    // THE FAILURE MODE THIS WHOLE FUNCTION EXISTS TO PREVENT, arriving through the door nobody was
    // watching. Every comparison against a NaN is false, so a NaN threshold sails through `>=`, a NaN
    // budget reads as "plenty of room", and a NaN ceiling reads as "not reached yet" — a run with no
    // limits at all, reported as a run in perfect health. `clampToLimits` has defended against a
    // control mid-edit since it was written; this is the same guard on the function whose entire job
    // is the limits.
    expect(limitBlock({ ...NO_LIMIT, drawdownStopPct: Number.NaN }, spent(50), at(-1_000))).toBe("drawdown-unknown");
    expect(drawdownStopUsd({ ...NO_LIMIT, drawdownStopPct: Number.NaN })).toBeNull();
    expect(limitBlock({ ...NO_LIMIT, budgetUsd: Number.NaN }, spent(50), at(0))).toBe("budget-spent");
    expect(limitBlock({ ...NO_LIMIT, maxRounds: Number.NaN }, spent(50, 3), at(0))).toBe("round-ceiling");
    // And a spend that has become unreadable is a budget nobody can show room in.
    expect(limitBlock({ ...NO_LIMIT, budgetUsd: 500 }, spent(Number.NaN), at(0))).toBe("budget-spent");
  });

  it("reads a zero-percent stop as 'the moment I am down', not as 'before you start'", () => {
    // Degenerate but reachable from any control that goes to zero. `0 >= 0` would fire at a flat
    // ledger and stop the run before it deposited anything, under a status line reading "this run is
    // down more than the 0% you said you would accept — $0.00", which is not a sentence about
    // anything that happened.
    const zero = { ...NO_LIMIT, budgetUsd: 200, drawdownStopPct: 0 };
    expect(limitBlock(zero, spent(0, 0), at(0))).toBeNull();
    expect(limitBlock(zero, spent(0, 0), at(50))).toBeNull();
    expect(limitBlock(zero, spent(25), at(-0.01))).toBe("drawdown-stopped");
  });

  it("widens with a raised budget, because the stop is a share of what is committed", () => {
    // A stated consequence rather than a discovered one: `setLimits` names only the budget, and
    // raising it also raises the dollar loss the same percentage tolerates. Asserted so that if the
    // decision is ever reversed — snapshotting the budget at arm time — it is reversed deliberately
    // and not by a refactor.
    const at200 = { ...NO_LIMIT, budgetUsd: 200, drawdownStopPct: 50 };
    const at400 = { ...at200, budgetUsd: 400 };
    expect(limitBlock(at200, spent(100), at(-100))).toBe("drawdown-stopped");
    expect(limitBlock(at400, spent(100), at(-100))).toBeNull();
    expect(drawdownStopUsd(at400)).toBe(2 * (drawdownStopUsd(at200) ?? 0));
  });

  it("does not report an unreadable ledger over a run that has already finished", () => {
    // "Your drawdown cannot be checked" would send a player chasing a figure for a run whose budget
    // ran out an hour ago. An inability is not a fact about the run, and it is reported last.
    expect(limitBlock({ ...NO_LIMIT, budgetUsd: 50, drawdownStopPct: 50 }, spent(50), UNREADABLE)).toBe("budget-spent");
    expect(limitBlock({ ...NO_LIMIT, maxRounds: 3, drawdownStopPct: 50 }, spent(50, 3), UNREADABLE)).toBe("round-ceiling");
  });

  it("counts the round ceiling in rounds ENTERED, not rounds gone by", () => {
    // "For people who think in rounds rather than hours" — and a round the lobby closed on is not one
    // this played.
    expect(limitBlock({ ...NO_LIMIT, maxRounds: 5 }, spent(50, 4), at(0))).toBeNull();
    expect(limitBlock({ ...NO_LIMIT, maxRounds: 5 }, spent(50, 5), at(0))).toBe("round-ceiling");
  });

  it("treats a fraction of a cent of budget as spent, not as running", () => {
    expect(limitBlock({ ...NO_LIMIT, budgetUsd: 50 }, spent(49.995), at(0))).toBe("budget-spent");
    expect(limitBlock({ ...NO_LIMIT, budgetUsd: 50 }, spent(49.98), at(0))).toBeNull();
  });
});

describe("the shipped limits are a real bound", () => {
  it("commits ten rounds of budget, caps the round at the arena's cap, and stops at half", () => {
    expect(DEFAULT_LIMITS.perRoundCapUsd).toBe(STAKE_CAP_USD);
    expect(DEFAULT_LIMITS.budgetUsd).toBe(250);
    expect(DEFAULT_LIMITS.drawdownStopPct).toBe(50);
    // Ten rounds at the $25 the presets sit around — a bound that actually binds, which is what
    // separates a limit from a control that lies about existing. It matters more than it did: a
    // session used to run out first and no longer does.
  });

  it("ships no round ceiling, because a number nobody asked for is not a safety property", () => {
    expect(DEFAULT_LIMITS.maxRounds).toBeNull();
  });
});

// =============================================================================================
// What came back — the running total, and the two ways it can decline to answer
// =============================================================================================
//
// THE DEFECT THIS SUITE IS THE REGRESSION FOR. The run's P&L used to be re-derived on demand by
// re-scanning the round log over the run's whole span, and refusing to answer unless that span was
// covered without a hole. The log is a WINDOW — the chain keeps about `MIN_RETAINED_ROUNDS` — so a
// run that lasted longer than the window could no longer be measured at all, the figure went
// permanently unknown, and the drawdown stop held the rule forever. With the default stop set, every
// overnight run stopped after about half an hour, silently. The first test below is that run.
//
// THE INVARIANT THAT MUST SURVIVE THE FIX is the reason the old code refused: a settlement nobody
// read may never be counted as no loss. So the suite is written as a pair — the window test proves
// the run keeps going, and the gap tests prove it still stops when a round is genuinely lost.

const YOU_KEY = "you-wallet";
const THEM_KEY = "them-wallet";

function rowFor(wallet: string, pnlUsd: number): RoundPlayer {
  return {
    wallet,
    short: wallet.slice(0, 4),
    side: 0,
    stake: usdToUnits(25),
    final: usdToUnits(25 + pnlUsd),
    pnl: usdToUnits(pnlUsd),
    dead: false,
    isYou: wallet === YOU_KEY,
  };
}

/** One round as the log reports it. `phase` is a parameter because the difference between a round
 *  that has finished and one that is still fighting is the difference between a figure that may be
 *  booked forever and one that may not — see `readRunPnl`. */
function logRound(roundNo: bigint, pnlUsd: number | null, phase: PhaseName = "Settled"): RoundSummary {
  return {
    roundNo,
    phase,
    winner: 0,
    pot: usdToUnits(50),
    fighterCount: 2,
    tickCount: 0n,
    penaltiesCollected: 0n,
    feesCollected: 0n,
    players: pnlUsd === null ? [rowFor(THEM_KEY, 5)] : [rowFor(YOU_KEY, pnlUsd), rowFor(THEM_KEY, -pnlUsd)],
  };
}

/** The newest `MIN_RETAINED_ROUNDS` rounds ending at `newest`, each one a $10 loss for this player —
 *  the window a caught-up keeper leaves behind, which is the whole shape of the original defect. */
function windowEndingAt(newest: bigint, pnlUsd = -10): RoundSummary[] {
  const rounds: RoundSummary[] = [];
  for (let n = newest; n > newest - BigInt(MIN_RETAINED_ROUNDS); n -= 1n) rounds.push(logRound(n, pnlUsd));
  return rounds;
}

/** Arm, enter `roundNo`, and let the log settle it — one round of an ordinary run, wired in the
 *  order the hook wires it. */
function playRound(p: policy.RunPnl, roundNo: bigint, log: RoundSummary[]): policy.RunPnl {
  return bookSettledRounds(pnlEntered(p, roundNo, YOU_KEY), log, YOU_KEY);
}

describe("the run's P&L is a running total, so the run outlives the log that fed it", () => {
  it("keeps measuring a run that has outlived the chain's retention window", () => {
    // THE ORIGINAL DEFECT, END TO END. Nine hundred rounds, a log that never holds more than twenty
    // of them, and a figure that has to stay exact and stay answerable the whole way. Under the
    // derived version this run reported "cannot say" from round 21 onward and never deposited again.
    let pnl = EMPTY_RUN_PNL;
    for (let n = 1n; n <= 900n; n += 1n) {
      pnl = playRound(pnl, n, windowEndingAt(n));
    }
    // Every round it entered is accounted for, from a log that could only ever show it twenty.
    expect(readRunPnl(pnl, windowEndingAt(900n), YOU_KEY)).toEqual({ kind: "known", usd: -9_000 });
    expect(pnl.bookedThrough).toBe(900n);
  });

  it("adds a settled round exactly once however many times a poll shows it", () => {
    // The log is re-read whenever `round_counter` moves and the rule re-evaluates once a second, so
    // the same settled round is offered to this code over and over. A total that took it each time
    // would report a run four times further down than it was and trip the stop on a flat evening.
    const log = [logRound(40n, -25)];
    let pnl = pnlEntered(EMPTY_RUN_PNL, 40n, YOU_KEY);
    for (let i = 0; i < 5; i += 1) pnl = bookSettledRounds(pnl, log, YOU_KEY);
    expect(readRunPnl(pnl, log, YOU_KEY)).toEqual({ kind: "known", usd: -25 });
  });

  it("returns the state it was given when there is nothing new to book", () => {
    // Identity is part of the contract: this runs once a second beside a `commit` that compares by
    // reference and repaints on a change, so an equal-but-fresh object would be a render loop with a
    // running total inside it.
    const log = [logRound(40n, -25)];
    const booked = bookSettledRounds(pnlEntered(EMPTY_RUN_PNL, 40n, YOU_KEY), log, YOU_KEY);
    expect(bookSettledRounds(booked, log, YOU_KEY)).toBe(booked);
    expect(bookSettledRounds(EMPTY_RUN_PNL, log, YOU_KEY)).toBe(EMPTY_RUN_PNL);
  });

  it("keeps the sum exact over a night's worth of rounds", () => {
    // Accumulated in chain units and converted once, at the edge. In floating-point dollars a
    // thousand additions of an awkward figure drifts, and the figure a safety limit is compared
    // against is the last place to be approximately right.
    let pnl = EMPTY_RUN_PNL;
    for (let n = 1n; n <= 1_000n; n += 1n) pnl = playRound(pnl, n, [logRound(n, -0.07)]);
    expect(readRunPnl(pnl, [logRound(1_000n, -0.07)], YOU_KEY)).toEqual({ kind: "known", usd: -70 });
  });
});

describe("the run's P&L tells a round that has not settled from one that was never read", () => {
  it("carries a fighting round at its mark-to-market rather than holding the rule", () => {
    // Early rather than wrong, and early is the direction a protective stop should err in. It is
    // added transiently rather than booked: a mid-fight number is not a fact yet, and freezing one
    // into a running total would be a guess nothing could ever correct.
    const pnl = bookSettledRounds(pnlEntered(EMPTY_RUN_PNL, 41n, YOU_KEY), [logRound(41n, -12, "Fight")], YOU_KEY);
    expect(readRunPnl(pnl, [logRound(41n, -12, "Fight")], YOU_KEY)).toEqual({ kind: "known", usd: -12 });
    // Nothing was booked, so when it settles at a different number the settled one is what counts.
    expect(pnl.bookedThrough).toBe(40n);
    expect(readRunPnl(bookSettledRounds(pnl, [logRound(41n, -3)], YOU_KEY), [], YOU_KEY)).toEqual({
      kind: "known",
      usd: -3,
    });
  });

  it("treats a round the log has not caught up to as pending, not as missing", () => {
    // `useHistory` re-reads when `round_counter` moves, so it trails the chain by up to a round. A
    // deposit that has just confirmed into a round nobody has read yet has not settled as far as
    // anything here can tell — and a rule held on that would stop itself on every round it entered.
    const pnl = pnlEntered(EMPTY_RUN_PNL, 41n, YOU_KEY);
    expect(readRunPnl(pnl, [logRound(40n, -5)], YOU_KEY)).toEqual({ kind: "known", usd: 0 });
  });

  it("books rounds the run entered while an earlier one was still fighting", () => {
    // The rule can enter round 41 before the log has answered for round 40 — the log only refreshes
    // when a round opens, so a round that settles late is answered a round late. A register with a
    // single pending slot would have dropped round 40's outcome on the floor here, so this is the
    // test that says the outstanding range is a range.
    let pnl = pnlEntered(EMPTY_RUN_PNL, 40n, YOU_KEY);
    pnl = bookSettledRounds(pnl, [logRound(40n, -30, "Fight")], YOU_KEY);
    pnl = pnlEntered(pnl, 41n, YOU_KEY);
    expect(pnl.bookedThrough).toBe(39n);
    pnl = bookSettledRounds(pnl, [logRound(40n, -30), logRound(41n, -20)], YOU_KEY);
    expect(readRunPnl(pnl, [], YOU_KEY)).toEqual({ kind: "known", usd: -50 });
  });

  it("steps over the rounds a long pause went past, because the run entered none of them", () => {
    // The advertised shape of an overnight run: a session lapses, the rule goes quiet, the player
    // opens a fresh one hours later and it picks up. A cursor that had to walk rounds 41 to 299
    // would stall on the first one the chain had reclaimed and report an unrecoverable gap over
    // rounds this rule never touched — stopping a run for losses that were never its own.
    let pnl = playRound(EMPTY_RUN_PNL, 40n, [logRound(40n, -10)]);
    pnl = pnlEntered(pnl, 300n, YOU_KEY);
    expect(pnl.bookedThrough).toBe(299n);
    expect(readRunPnl(pnl, windowEndingAt(300n), YOU_KEY)).toEqual({ kind: "known", usd: -20 });
  });

  it("does not book a hand deposit into a round the run never entered", () => {
    // The budget is charged only for what this rule sent (`attemptLanded`), so the drawdown measured
    // against that budget covers the same rounds. A player who deploys $500 by hand after the run's
    // last round has not put the run down a penny.
    const pnl = playRound(EMPTY_RUN_PNL, 40n, [logRound(40n, -10)]);
    expect(readRunPnl(pnl, [logRound(40n, -10), logRound(41n, -500)], YOU_KEY)).toEqual({
      kind: "known",
      usd: -10,
    });
  });
});

describe("a settlement nobody read is never counted as no loss", () => {
  it("reports a gap when a round the run entered has aged out of the chain's window", () => {
    // THE INVARIANT THE OLD CODE WAS RIGHT ABOUT, kept. The tab was not reading the chain while round
    // 40 settled, and by the time it looked again the account had been reclaimed. What that round did
    // is unknowable — so the answer is "I cannot say", never a confident zero.
    const pnl = pnlEntered(EMPTY_RUN_PNL, 40n, YOU_KEY);
    expect(readRunPnl(pnl, windowEndingAt(200n), YOU_KEY)).toEqual({ kind: "gap", fromRound: 40n, bookedUsd: 0 });
  });

  it("calls a round missing from inside the retention window unreadable, not lost", () => {
    // `scanRoundLog` drops a rate-limited fetch and reports the partial read as a success, so one 429
    // silently removes a round from the middle of the window. `close_round_account` cannot touch a
    // round that recent, so the record still exists and the next poll will have it — telling that
    // reader their evidence is gone forever would be a false and unfixable-sounding claim.
    const holed = windowEndingAt(50n).filter((r) => r.roundNo !== 45n);
    const pnl = pnlEntered(EMPTY_RUN_PNL, 45n, YOU_KEY);
    expect(readRunPnl(pnl, holed, YOU_KEY)).toEqual({ kind: "unreadable", bookedUsd: 0 });
    // …and answers again the moment the next fetch fills the hole.
    expect(readRunPnl(bookSettledRounds(pnl, windowEndingAt(50n), YOU_KEY), [], YOU_KEY)).toEqual({
      kind: "known",
      usd: -10,
    });
  });

  it("refuses to answer off an empty log or with nobody connected", () => {
    // An empty log is a log that has not loaded or one whose every read failed, not an empty history.
    // `""` is how this page spells "nobody" (`ArenaContextValue.you`), and no wallet is ever the
    // empty string — so summing its rows would report a confident zero over no rows at all.
    const pnl = pnlEntered(EMPTY_RUN_PNL, 40n, YOU_KEY);
    expect(readRunPnl(pnl, [], YOU_KEY)).toEqual({ kind: "unreadable", bookedUsd: 0 });
    expect(readRunPnl(pnl, windowEndingAt(40n), "")).toEqual({ kind: "unreadable", bookedUsd: 0 });
    expect(bookSettledRounds(pnl, windowEndingAt(40n), "")).toBe(pnl);
  });

  it("is zero, not unknown, before the run has entered anything", () => {
    // Otherwise a freshly armed rule holds on `drawdown-unknown` forever and never takes its first
    // round. Nothing has been deposited, so there is genuinely nothing to be down.
    expect(readRunPnl(EMPTY_RUN_PNL, [], "")).toEqual({ kind: "known", usd: 0 });
    expect(readRunPnl(EMPTY_RUN_PNL, windowEndingAt(40n), YOU_KEY)).toEqual({ kind: "known", usd: 0 });
  });

  it("treats an abandoned lobby as finished, because it is", () => {
    // A lobby that reached its deadline holding fewer than two fighters can never fight. Waiting for
    // it to settle would stall the cursor until the round aged out of the window and turn an
    // ordinary empty lobby into an unrecoverable gap.
    const log = [logRound(40n, 0, "Abandoned"), logRound(41n, -15)];
    const pnl = bookSettledRounds(pnlEntered(pnlEntered(EMPTY_RUN_PNL, 40n, YOU_KEY), 41n, YOU_KEY), log, YOU_KEY);
    expect(readRunPnl(pnl, log, YOU_KEY)).toEqual({ kind: "known", usd: -15 });
    expect(pnl.bookedThrough).toBe(41n);
  });

  it("counts only this player's rows, however many wallets were in the round", () => {
    const log = [logRound(40n, null), logRound(41n, -6)];
    const pnl = bookSettledRounds(pnlEntered(pnlEntered(EMPTY_RUN_PNL, 40n, YOU_KEY), 41n, YOU_KEY), log, YOU_KEY);
    expect(readRunPnl(pnl, log, YOU_KEY)).toEqual({ kind: "known", usd: -6 });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // THE ONE MIS-BOOKING IN THIS DESIGN THAT CANNOT HEAL, and the reason the register knows whose it
  // is. `ChainArena` does not remount when Phantom's account changes — `youPubkey` simply becomes a
  // different string — and `useHistory` keeps the OLD rounds array until its refetch resolves. So
  // for a moment the run's outstanding round is still present and still final in the log while the
  // wallet being looked for in it is a wallet that was never in it. Without an owner on the register
  // that books a real loss as zero AND advances the cursor past it, and a booked round is never
  // revisited. Every other way this figure can be wrong clears on a later poll; this one latches.
  it("refuses to book a settled round under an account that did not make the deposit", () => {
    const settled = [logRound(40n, -80)];
    const mine = pnlEntered(EMPTY_RUN_PNL, 40n, YOU_KEY);
    const underSomebodyElse = bookSettledRounds(mine, settled, THEM_KEY);

    // Not booked, not advanced, not zero — the loss is still outstanding and still findable.
    expect(underSomebodyElse).toBe(mine);
    expect(readRunPnl(mine, settled, THEM_KEY)).toEqual({ kind: "unreadable", bookedUsd: 0 });
    // And the account that actually paid still gets the truth.
    expect(readRunPnl(bookSettledRounds(mine, settled, YOU_KEY), [], YOU_KEY)).toEqual({
      kind: "known",
      usd: -80,
    });
  });

  it("claims the register for the first account to deposit, and admits no second one", () => {
    // A confirmation outlives the render that started it, so the wallet comes off the SEND rather
    // than off whoever happens to be connected when it lands. Two accounts' rounds added together is
    // not a figure about either of them.
    const mine = pnlEntered(EMPTY_RUN_PNL, 40n, YOU_KEY);
    expect(mine.wallet).toBe(YOU_KEY);
    expect(pnlEntered(mine, 41n, THEM_KEY)).toBe(mine);
    expect(pnlEntered(mine, 41n, YOU_KEY).lastEnteredRound).toBe(41n);
  });
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it("drops a repeat booking of a round already entered", () => {
    // Rounds only increase, so a booking at or below the newest entered round is one already
    // recorded — the same guard `tallyEntered` applies, for the same reason.
    const once = pnlEntered(EMPTY_RUN_PNL, 40n, YOU_KEY);
    expect(pnlEntered(once, 40n, YOU_KEY)).toBe(once);
    expect(pnlEntered(once, 39n, YOU_KEY)).toBe(once);
  });
});

describe("the drawdown stop still binds, and says which kind of silence it is", () => {
  it("fires on a run that is down more than the share of the budget it committed", () => {
    const limits: AutoLimits = { ...NO_LIMIT, budgetUsd: 250, drawdownStopPct: 50 };
    let pnl = EMPTY_RUN_PNL;
    for (let n = 1n; n <= 4n; n += 1n) pnl = playRound(pnl, n, [logRound(n, -30)]);
    expect(limitBlock(limits, spent(100, 4), readRunPnl(pnl, [], YOU_KEY))).toBeNull();
    pnl = playRound(pnl, 5n, [logRound(5n, -30)]);
    expect(limitBlock(limits, spent(125, 5), readRunPnl(pnl, [], YOU_KEY))).toBe("drawdown-stopped");
  });

  it("holds on a lost settlement, and on a ledger that has merely not loaded", () => {
    // Both are inabilities and both hold. They are ONE verdict and two sentences — see `LimitBlock`'s
    // note for why the permanent one is not a second member of that union.
    const stopSet: AutoLimits = { ...NO_LIMIT, drawdownStopPct: 50 };
    expect(limitBlock(stopSet, spent(50), lost(40n))).toBe("drawdown-unknown");
    expect(limitBlock(stopSet, spent(50), UNREADABLE)).toBe("drawdown-unknown");
    // With no stop set there is nothing to evaluate, so even a hole in the ledger stops nothing.
    expect(limitBlock({ ...NO_LIMIT, drawdownStopPct: null }, spent(50), lost(40n))).toBeNull();
  });

  it("fires the stop on a loss it has already proved, even with the ledger incomplete", () => {
    // WHAT IS BOOKED IS EXACT AND FINAL, so a run that has already lost more than it was allowed to
    // is over — the unreadable rounds can only make that worse. Reporting "your ledger has a hole in
    // it" to somebody whose run had demonstrably blown through its stop is true, less useful, and
    // considerably less alarming than the sentence they had earned.
    const stopSet: AutoLimits = { ...NO_LIMIT, budgetUsd: 250, drawdownStopPct: 50 };
    expect(limitBlock(stopSet, spent(50), lost(40n, -200))).toBe("drawdown-stopped");
    expect(limitBlock(stopSet, spent(50), { kind: "unreadable", bookedUsd: -200 })).toBe("drawdown-stopped");
    // A FLOOR MAY FIRE A STOP AND NEVER PASS ONE: short of the threshold it is still an inability.
    expect(limitBlock(stopSet, spent(50), lost(40n, -124))).toBe("drawdown-unknown");
    expect(provenLossUsd(lost(40n, -200))).toBe(200);
    expect(provenLossUsd(at(30))).toBe(0);
  });

  it("does not report a lost settlement over a run that had already finished", () => {
    // Same tiering as before: an inability is a fact about what this page can read, and sending
    // somebody after a ledger for a run whose budget ran out an hour ago wastes their time.
    expect(limitBlock({ ...NO_LIMIT, budgetUsd: 50, drawdownStopPct: 50 }, spent(50), lost(40n))).toBe(
      "budget-spent",
    );
  });
});

// =============================================================================================
// The account of the run
// =============================================================================================

describe("the tally is what the player reads when they come back", () => {
  it("counts confirmed dollars and the span of rounds it touched", () => {
    let t = tallyEntered(EMPTY_TALLY, 40n, 25);
    t = tallyEntered(t, 41n, 10);
    t = tallyMissed(t, 42n);
    expect(t).toEqual({
      ...EMPTY_TALLY, entered: 2, spentUsd: 35, missed: 1, firstRound: 40n, lastRound: 42n,
      lastOutcome: "missed",
    });
  });

  it("books each round once, whichever of the two callbacks gets there first", () => {
    // `attemptLanded` and the page-wide confirmed-enter path both fire for one automatic deposit, in
    // an order nothing guarantees. A tally that trusted its callers would double the spend, and the
    // spend is what the budget is enforced against — so it would also halve the run.
    const once = tallyEntered(EMPTY_TALLY, 40n, 25);
    expect(tallyEntered(once, 40n, 25)).toBe(once);
    // And nothing downgrades a confirmed deposit to a miss. There is no un-spending it.
    expect(tallyMissed(once, 40n)).toBe(once);
    // A booking for a round older than the cursor is history the books have closed over.
    expect(tallyEntered(tallyEntered(once, 41n, 25), 39n, 25).spentUsd).toBe(50);
  });

  it("charges a deposit that confirmed after its round was written off", () => {
    // ROUTINE ON DEVNET, AND IT COST THE BUDGET ITS ACCURACY. A deposit is sent; the client's
    // confirmation times out ("Transaction was not confirmed in 30.00 seconds"); the lobby deadline
    // passes and the round is written off `entries-closed`; and then the transaction turns out to
    // have landed. Booked strictly first-writer-wins, the run carried a missed round whose stake it
    // had actually spent — the attempt record on screen saying the round landed, the statement beside
    // it saying $0.00 into 0 rounds, and the budget never charged, so the run outspent what it was
    // given by one stake every time it happened. The chain confirming is the strongest fact there is
    // about a round, so it corrects the books.
    const writtenOff = tallyMissed({ ...EMPTY_TALLY, armedAtMs: 1_000 }, 40n);
    expect(writtenOff.missed).toBe(1);

    const corrected = tallyEntered(writtenOff, 40n, 25);
    expect(corrected.missed).toBe(0);
    expect(corrected.entered).toBe(1);
    expect(corrected.spentUsd).toBe(25);
    expect(corrected.lastOutcome).toBe("entered");
    // Corrected once, not twice: the second report of the same confirmation changes nothing.
    expect(tallyEntered(corrected, 40n, 25)).toBe(corrected);
  });

  it("says something true before anything has happened", () => {
    // This string is rendered from the moment the rule is armed, so its first job is to read as an
    // account of a run that has not done anything yet rather than as an empty one.
    const text = tallyReport({ ...EMPTY_TALLY, armedAtMs: 1_000 }, 1_000);
    expect(text).toContain("Nothing has been deposited");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
    expect(text).toContain("next round");
  });

  it("prices the run in dollars and names the rounds it covered", () => {
    let t: RunTally = { ...EMPTY_TALLY, armedAtMs: 0 };
    t = tallyEntered(t, 40n, 25);
    t = tallyEntered(t, 41n, 25);
    t = tallyMissed(t, 42n);

    const text = tallyReport(t, 60_000 * 42);
    expect(text).toContain("$50.00");
    expect(text).toContain("2 rounds");
    expect(text).toContain("1 round");
    expect(text).toContain("rounds 40 to 42");
  });

  it("counts the time in the units the reader was away for", () => {
    const t = tallyEntered({ ...EMPTY_TALLY, armedAtMs: 1_000_000 }, 5n, 5);
    expect(tallyReport(t, 1_000_000 + 30_000)).toContain("in the last minute");
    expect(tallyReport(t, 1_000_000 + 60_000 * 7)).toContain("7 minutes");
    expect(tallyReport(t, 1_000_000 + 60_000 * 130)).toContain("2 hours");
  });

  it("does not invent a duration for a run with no arming stamp", () => {
    // A tally that was never stamped has no clock, and "over the last 56 years" is what a zero
    // becomes if nobody checks.
    const t = tallyEntered(EMPTY_TALLY, 5n, 5);
    const text = tallyReport(t, Date.now());
    expect(text).toContain("since it was armed");
    expect(text).not.toMatch(/\d+ (hours|minutes)/);
  });

  it("says one round in the singular, because a report that says '1 rounds' is not read as careful", () => {
    const t = tallyEntered({ ...EMPTY_TALLY, armedAtMs: 1_000 }, 7n, 5);
    const text = tallyReport(t, 1_000);
    expect(text).toContain("1 round");
    expect(text).not.toContain("1 rounds");
    expect(text).toContain("in round 7");
  });
});

// =============================================================================================
// Runway
// =============================================================================================

const KNOWN_1_PCT: FeeRate = { bps: 100, known: true };

/** HALF AN HOUR OF SESSION LEFT — a plain quantity of minutes, deliberately not "a session".
 *  How long a whole session lasts is moving and is mirrored in exactly one place; a fixture that
 *  encoded it here would keep passing while the sentence it checks became wrong by a factor of
 *  twenty-four. Where the full length is genuinely the subject, `ASSUMED_SESSION_MINUTES` is used. */
const HALF_AN_HOUR = 30;
const A_LONG_TIME = 6_000;

/** A $500 budget, nothing spent, nothing else set. */
const BUDGET_500: AutoLimits = { ...NO_LIMIT, budgetUsd: 500 };

describe("runway prices the door at the LIVE rate", () => {
  it("follows the arena's current fee rather than the constant this build was cut against", () => {
    // THE INCIDENT, in one assertion. `FEE_BPS` was hardcoded as THE fee and was moved 20 → 100 on
    // devnet while the site was serving; every surface holding it quoted a rate five times off until
    // the next Vercel build. A projection of somebody's night computed against a build-time copy is
    // that defect with a night's money behind it.
    const args = { stakeUsd: 100, limits: NO_LIMIT, tally: EMPTY_TALLY, sessionMinutesLeft: null };
    const atOnePct = runway({ ...args, fee: { bps: 100, known: true } });
    const atFivePct = runway({ ...args, fee: { bps: 500, known: true } });

    expect(atOnePct.feePerRoundUsd).toBe(1);
    expect(atFivePct.feePerRoundUsd).toBe(5);
    expect(atFivePct.roundsIfBreakEven).toBeLessThan(atOnePct.roundsIfBreakEven ?? 0);
  });

  it("uses the pre-read fallback only through feeRate, and says nothing different about it", () => {
    // `FeeRate.known` is what a SURFACE renders differently; the arithmetic is the same either way,
    // because the fallback is a real rate that the door may well be charging.
    expect(runway({
      stakeUsd: 100, fee: feeRate(null), limits: NO_LIMIT, tally: EMPTY_TALLY, sessionMinutesLeft: null,
    }).feePerRoundUsd).toBe((100 * FEE_BPS) / 10_000);
  });

  it("prices the fee with the program's own floor division", () => {
    // `feeOn` is `stake * fee_bps / BPS` in lib.rs, integer division and all, so the figure here is
    // what `split_entry` will actually credit rather than a rounded guess at it. A fee smaller than
    // one raw unit is genuinely zero to the program — 500 units at 1bp is 0, not 5e-8 — and float
    // arithmetic on the dollars would have quoted the door a take it does not get.
    expect(runway({
      stakeUsd: 0.0005, fee: { bps: 1, known: true }, limits: NO_LIMIT, tally: EMPTY_TALLY,
      sessionMinutesLeft: null,
    }).feePerRoundUsd).toBe(0);
    // And one unit above that threshold it is a unit, not a rounding of one.
    expect(runway({
      stakeUsd: 0.01, fee: { bps: 1, known: true }, limits: NO_LIMIT, tally: EMPTY_TALLY,
      sessionMinutesLeft: null,
    }).feePerRoundUsd).toBe(0.000001);
  });

  it("states two bounds and never a number between them", () => {
    const r = runway({
      stakeUsd: 25, fee: KNOWN_1_PCT, limits: BUDGET_500, tally: EMPTY_TALLY, sessionMinutesLeft: null,
    });
    // A $500 budget at $25 a round is 20 rounds if every one is lost; at $0.25 of fee it is 2,000 if
    // they break even. Nothing on this page knows which, and the distance between them is why a
    // single figure would be a fabrication rather than a rounding.
    expect(r.roundsIfAllLost).toBe(20);
    expect(r.roundsIfBreakEven).toBe(2_000);
  });

  it("counts what is left of the committed budget, not what is in the wallet", () => {
    // A budget is capital committed at arm time that drains and never tops itself up, so what is left
    // of it is exactly what the run has left to spend. Quoting the wallet would count money the
    // player did not commit — and would keep quoting it after the budget was gone.
    const r = runway({
      stakeUsd: 25, fee: KNOWN_1_PCT, limits: { ...NO_LIMIT, budgetUsd: 100 }, tally: spent(75, 3),
      sessionMinutesLeft: null,
    });
    expect(r.roundsIfAllLost).toBe(1);
  });

  it("has no fee bound at all when the arena is charging nothing", () => {
    // A real rate the authority may set, and there is no division by it anywhere on this path.
    expect(runway({
      stakeUsd: 25, fee: { bps: 0, known: true }, limits: BUDGET_500, tally: EMPTY_TALLY,
      sessionMinutesLeft: null,
    }).roundsIfBreakEven).toBeNull();
  });

  it("turns the session's remaining minutes into rounds at the assumed cadence", () => {
    // 90 seconds is the shape of `NORMAL_ROUND` in `autoDeploy.test.ts`'s driver — a 45s lobby, the
    // dead window after it, the draw, the fight and the settle come to 87 — rounded to a figure
    // nobody will mistake for a measurement. Half an hour is twenty rounds.
    expect(ASSUMED_ROUND_SECONDS).toBe(90);
    expect(runway({
      stakeUsd: 25, fee: KNOWN_1_PCT, limits: NO_LIMIT, tally: EMPTY_TALLY,
      sessionMinutesLeft: HALF_AN_HOUR,
    }).roundsThisSession).toBe(20);
  });

  it("says the session length is unknown rather than assuming a full one", () => {
    // A session restored from a previous visit has no local record of when it began — a common state,
    // not an edge one. Null is the honest answer, it takes no part in the comparison, and the copy
    // says so in words.
    const r = runway({
      stakeUsd: 25, fee: KNOWN_1_PCT, limits: BUDGET_500, tally: EMPTY_TALLY, sessionMinutesLeft: null,
    });
    expect(r.roundsThisSession).toBeNull();
    expect(r.binding).toBe("money");
    expect(runwayNote(r)).toContain("not known in this tab");
  });
});

describe("runway names whichever bound actually binds", () => {
  it("names the session when the session is the shortest", () => {
    const r = runway({
      stakeUsd: 5, fee: KNOWN_1_PCT, limits: { ...NO_LIMIT, budgetUsd: 5_000 }, tally: EMPTY_TALLY,
      sessionMinutesLeft: HALF_AN_HOUR,
    });
    expect(r.roundsThisSession).toBe(20);
    expect(r.roundsIfAllLost).toBe(1_000);
    expect(r.binding).toBe("session");
    expect(runwayNote(r)).toContain("play session is the first thing to run out");
  });

  it("names the money when the session outlasts it", () => {
    // THE FLIP, and it is why this is computed rather than asserted in prose. While a session lasted
    // an hour it was almost always the shorter of the two, and a note that said so was right by
    // accident; the moment a session outlives the budget the same sentence becomes a lie about which
    // control a player should be looking at.
    const r = runway({
      stakeUsd: 25, fee: KNOWN_1_PCT, limits: BUDGET_500, tally: EMPTY_TALLY,
      sessionMinutesLeft: A_LONG_TIME,
    });
    expect(r.roundsIfAllLost).toBe(20);
    expect(r.roundsThisSession).toBeGreaterThan(r.roundsIfAllLost);
    expect(r.binding).toBe("money");
    expect(runwayNote(r)).toContain("budget is the first thing to run out");
  });

  it("names the round ceiling when the player set one that gets there first", () => {
    const r = runway({
      stakeUsd: 25, fee: KNOWN_1_PCT, limits: { ...BUDGET_500, maxRounds: 6 }, tally: spent(50, 2),
      sessionMinutesLeft: A_LONG_TIME,
    });
    expect(r.roundsToCeiling).toBe(4);
    expect(r.binding).toBe("rounds");
    expect(runwayNote(r)).toContain("round ceiling you set");
  });

  it("has no ceiling to report when none was set", () => {
    expect(runway({
      stakeUsd: 25, fee: KNOWN_1_PCT, limits: BUDGET_500, tally: EMPTY_TALLY, sessionMinutesLeft: null,
    }).roundsToCeiling).toBeNull();
  });

  it("leaves the shipped limits binding over a whole session", () => {
    // Read from the single mirror rather than written down, so this keeps its meaning when the
    // session's length moves — which is the point: whatever it becomes, the money is what stops a
    // default run, and that is where the bound belongs now that a key can be delegated for a day
    // (`SOCIAL.md` §5.5).
    const r = runway({
      stakeUsd: 25, fee: KNOWN_1_PCT, limits: DEFAULT_LIMITS, tally: EMPTY_TALLY,
      sessionMinutesLeft: ASSUMED_SESSION_MINUTES,
    });
    expect(r.roundsIfAllLost).toBe(10);
    expect(r.binding).toBe("money");
  });
});

describe("runwayNote states bounds as bounds", () => {
  it("quotes both ends and never one number between them", () => {
    const note = runwayNote(runway({
      stakeUsd: 25, fee: KNOWN_1_PCT, limits: BUDGET_500, tally: EMPTY_TALLY,
      sessionMinutesLeft: HALF_AN_HOUR,
    }));
    expect(note).toContain("20 rounds");
    expect(note).toContain("2000");
    expect(note).toContain("if every fight is lost");
    expect(note).toContain("break even");
  });

  it("prices the door in the sentence, from the live rate", () => {
    const note = runwayNote(runway({
      stakeUsd: 100, fee: { bps: 250, known: true }, limits: BUDGET_500, tally: EMPTY_TALLY,
      sessionMinutesLeft: HALF_AN_HOUR,
    }));
    expect(note).toContain("$2.50");
  });

  it("promises the same thing about a lapsing session in every branch", () => {
    // SPEC's rule: what is true, what to do, when it changes. The last part is what a reader of a
    // runway is really asking, and "it stops depositing rather than asking you to approve anything"
    // is the promise the whole feature rests on — so it cannot be a sentence that only appears when
    // the session happens to be the binding bound.
    for (const sessionMinutesLeft of [null, HALF_AN_HOUR, A_LONG_TIME, 5]) {
      for (const limits of [BUDGET_500, { ...BUDGET_500, maxRounds: 3 }]) {
        const note = runwayNote(runway({
          stakeUsd: 25, fee: KNOWN_1_PCT, limits, tally: EMPTY_TALLY, sessionMinutesLeft,
        }));
        expect(note).toContain("rather than asking you to approve anything");
        expect(note).toContain("next round");
        expect(note).not.toContain("undefined");
        expect(note).not.toContain("NaN");
      }
    }
  });

  it("does not price a door that is charging nothing", () => {
    const note = runwayNote(runway({
      stakeUsd: 25, fee: { bps: 0, known: true }, limits: BUDGET_500, tally: EMPTY_TALLY,
      sessionMinutesLeft: HALF_AN_HOUR,
    }));
    expect(note).toContain("the door takes nothing at all");
    expect(note).not.toContain("$0.00 a round");
  });

  it("states no duration in words, so it survives the session length moving", () => {
    // `SOCIAL.md` §5.2: the session constant is a chosen figure that is going up by a factor of
    // twenty-four. Copy that said "the hour" would have been wrong the day it moved, and nobody
    // re-reads copy.
    for (const sessionMinutesLeft of [null, HALF_AN_HOUR, A_LONG_TIME]) {
      const note = runwayNote(runway({
        stakeUsd: 25, fee: KNOWN_1_PCT, limits: BUDGET_500, tally: EMPTY_TALLY, sessionMinutesLeft,
      }));
      expect(note).not.toMatch(/\ban hour\b|\b24 hours\b|\ba day\b|\b60 minutes\b/);
    }
  });
});

// =============================================================================================
// The strategy seam
// =============================================================================================

describe("chooseSide is the seam the later strategies drop into", () => {
  it("repeats whichever side was played last", () => {
    expect(chooseSide({ kind: "repeat" }, 0)).toBe(0);
    expect(chooseSide({ kind: "repeat" }, 1)).toBe(1);
  });

  it("has nothing to repeat before the first deposit, and does not pick one", () => {
    // A side chosen for a player who never chose one is money placed on a coin toss we made for
    // them. Null is a hold with its own words, not a default.
    expect(chooseSide({ kind: "repeat" }, null)).toBeNull();
  });
});
