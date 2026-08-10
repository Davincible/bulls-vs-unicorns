// A PRESS THAT NOBODY ANSWERS MUST NOT WEDGE THE PAGE — the one decision in `useActions.ts` that is
// not React, tested where it can be.
//
// THE DEFECT. `entering`/`extracting` shut every Deploy and Extract control for the whole of a press,
// and `setEntering(false)` lived in a `finally` — so it ran when the press settled, and a press that
// spans a wallet dialog does not settle until somebody answers the dialog. `signTransaction()` never
// resolves for a dialog that is ignored, lost behind a window, or killed with the browser. Both flags
// therefore stayed true for the lifetime of the tab: every button dead, the repeat rule holding on
// `busy` forever, nothing on screen saying why, and a reload the only way out.
//
// WHAT IS ASSERTED HERE IS THE THIRD ANSWER. A bound that reported failure would be a lie about a
// dialog the player may be reading right now, and one that reported success would be worse. The tests
// below pin all three halves of "we stopped waiting": the wait ends, the caller is told in words it
// can act on, and the press that outlives the wait is still watched — because a deploy approved two
// minutes late lands, and a player who was told "we stopped waiting" and then nothing would deploy
// again and enter one round twice.
//
// NOT TESTED HERE, AND SAID PLAINLY RATHER THAN PAPERED OVER: the wiring of this bound into the two
// hooks' `entering`/`extracting` state is React, and this project has no React testing library
// (vitest, oxlint and typescript are the whole devDependency list — see `historyScan.ts`'s header for
// the same note). What is provable without one is that the wait is bounded and honest, which is the
// part that was wrong.

import { describe, expect, it, vi } from "vitest";
import {
  CATCH_UP_CALLS, STOPPED_WAITING, SEND_PATIENCE_MS, isFightBehind, isStoppedWaiting, stopWaiting,
} from "./useActions.ts";
import { MAX_STEPS_PER_CALL, finalCursor } from "../../chain/constants.ts";
import { MAX_FIGHTERS } from "../../sim/erSim.ts";

/** A press whose outcome the test decides, standing in for a wallet dialog. */
function pending(): {
  promise: Promise<string>;
  land(signature: string): void;
  fail(error: unknown): void;
} {
  let land: (signature: string) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    land = resolve;
    fail = reject;
  });
  return { promise, land, fail };
}

/** Nothing at all — the dialog nobody ever answers, which is the whole subject of this file. One per
 *  test rather than a shared module constant, so no test can leave handlers attached to another's. */
function never(): Promise<string> {
  return new Promise<string>(() => {});
}

const MESSAGE = "this page has stopped waiting for your wallet";

type Late = { signature: string | null; error: unknown };

describe("stopWaiting", () => {
  it("hands back the press's own answer when it settles inside the wait", async () => {
    const late: Late[] = [];
    const signature = await stopWaiting(Promise.resolve("sig-1"), 50_000, MESSAGE, (l) => late.push(l));
    expect(signature).toBe("sig-1");
    // The press was never late, so there is nothing to say about it afterwards. A toast here would
    // narrate every ordinary deploy on the page.
    expect(late).toEqual([]);
  });

  it("lets a failure inside the wait through untouched, rather than dressing it as a timeout", async () => {
    const late: Late[] = [];
    const chainSaid = new Error("custom program error: RoundFull");
    const caught = await stopWaiting(Promise.reject(chainSaid), 50_000, MESSAGE, (l) => late.push(l)).catch(
      (e: unknown) => e,
    );
    expect(caught).toBe(chainSaid);
    expect(isStoppedWaiting(caught)).toBe(false);
    expect(late).toEqual([]);
  });

  // THE REGRESSION. Before the bound, this promise never settling meant the page never came back.
  it("stops waiting on a dialog nobody answers, and says so in words that are not a verdict", async () => {
    vi.useFakeTimers();
    try {
      const caught = stopWaiting(never(), SEND_PATIENCE_MS, MESSAGE, () => {}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SEND_PATIENCE_MS);
      const e = await caught;
      expect(isStoppedWaiting(e)).toBe(true);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe(MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is still waiting one tick before its patience runs out", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      void stopWaiting(never(), SEND_PATIENCE_MS, MESSAGE, () => {}).catch(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(SEND_PATIENCE_MS - 1);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // A DEPLOY APPROVED LATE STILL LANDS. Without this the player is told "we stopped waiting" and then
  // never told anything else — so they deploy again, and are in one round twice having been warned
  // about neither transaction.
  it("reports a press that lands after the wait was given up on", async () => {
    vi.useFakeTimers();
    try {
      const press = pending();
      const late: Late[] = [];
      const caught = stopWaiting(press.promise, SEND_PATIENCE_MS, MESSAGE, (l) => late.push(l)).catch(
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(SEND_PATIENCE_MS);
      expect(isStoppedWaiting(await caught)).toBe(true);
      expect(late).toEqual([]);

      press.land("sig-late");
      await vi.advanceTimersByTimeAsync(0);
      expect(late).toEqual([{ signature: "sig-late", error: null }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a press that fails after the wait was given up on", async () => {
    vi.useFakeTimers();
    try {
      const press = pending();
      const late: Late[] = [];
      const walletSaid = new Error("User rejected the request.");
      void stopWaiting(press.promise, SEND_PATIENCE_MS, MESSAGE, (l) => late.push(l)).catch(() => {});
      await vi.advanceTimersByTimeAsync(SEND_PATIENCE_MS);

      press.fail(walletSaid);
      await vi.advanceTimersByTimeAsync(0);
      expect(late).toEqual([{ signature: null, error: walletSaid }]);
    } finally {
      vi.useRealTimers();
    }
  });

  // A TIMER LEFT RUNNING IS THE SAME CLASS OF DEFECT ONE LAYER DOWN: it holds a reference to the
  // press and fires into a page that stopped caring about it minutes ago.
  it("leaves no timer behind when the press settles first", async () => {
    vi.useFakeTimers();
    try {
      await stopWaiting(Promise.resolve("sig-2"), SEND_PATIENCE_MS, MESSAGE, () => {});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isStoppedWaiting", () => {
  // MARKED, NOT MATCHED. `rethrow` and `classifyWalletError` both read an error's MESSAGE, and the
  // sentences this page raises about a timeout necessarily talk about wallets and transactions —
  // which is exactly the text those matchers hunt for. Keying on the name means the copy can be
  // rewritten by anybody without silently reclassifying a timeout as a cancelled popup.
  it("recognises the marker rather than the words", () => {
    const marked = new Error("anything at all");
    marked.name = STOPPED_WAITING;
    expect(isStoppedWaiting(marked)).toBe(true);
  });

  it("claims nothing that came from the wallet or the chain", () => {
    expect(isStoppedWaiting(new Error("User rejected the request."))).toBe(false);
    expect(isStoppedWaiting(new Error("Blockhash not found"))).toBe(false);
    expect(isStoppedWaiting("stopped waiting")).toBe(false);
    expect(isStoppedWaiting(null)).toBe(false);
    expect(isStoppedWaiting(undefined)).toBe(false);
  });
});

describe("the patience itself", () => {
  // A BOUND HAS TO BE ONE. This is the assertion that a later "just make it a bit longer" edit has to
  // walk past on its way to being infinite, and the ceiling is argued from the blockhash: past about
  // a minute and a half an approval produces a transaction the cluster refuses as expired, so waiting
  // beyond that cannot buy a landed deploy — it can only hold the page shut.
  it("is finite, and long enough to be generous without being open-ended", () => {
    expect(Number.isFinite(SEND_PATIENCE_MS)).toBe(true);
    expect(SEND_PATIENCE_MS).toBeGreaterThanOrEqual(60_000);
    expect(SEND_PATIENCE_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe("recognising a fight the chain says is behind the clock", () => {
  // WHY THIS IS TESTED AND THE OTHER PROGRAM ERRORS ARE NOT: every other program error this page can
  // provoke is shown to the player verbatim, so getting the classification wrong costs nothing but a
  // slightly worse sentence. `FightBehind` is the one the page ACTS on — it answers by sending a tick
  // and retrying the extract. A false positive spends the player's fees on a round that was never
  // behind; a false negative shows them "tick it first" and no tick button. Both are worth a test.

  it("recognises the plain error the router surfaces, with the name in the logs", () => {
    expect(isFightBehind({
      message: "failed to send transaction: custom program error: 0x1786",
      logs: [
        "Program ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe invoke [1]",
        "Program log: AnchorError occurred. Error Code: FightBehind. Error Number: 6022. Error Message: the fight has not been advanced to the present — tick it first, then extract.",
      ],
    })).toBe(true);
  });

  it("recognises it when the name is only in the message", () => {
    expect(isFightBehind(new Error("Error Code: FightBehind. Error Number: 6022."))).toBe(true);
  });

  it("does not answer to any OTHER program error, however similar the shape", () => {
    // `FightNotOverYet` is the near neighbour and the dangerous one: it is also about the fight's
    // progress, it is also raised on a payout path, and answering it with a tick-and-retry would be a
    // client quietly grinding a fight in order to settle a round early.
    for (const name of ["FightNotOverYet", "NotInFight", "RoundFull", "AlreadySwept"]) {
      expect(isFightBehind({ logs: [`Program log: AnchorError occurred. Error Code: ${name}. Error Number: 6019.`] }), name)
        .toBe(false);
    }
    // Matched on the whole name, not a prefix of it.
    expect(isFightBehind(new Error("Error Code: FightBehindSomethingElse."))).toBe(false);
  });

  it("reads a thrown string too, since not everything that throws builds an Error", () => {
    expect(isFightBehind("Error Code: FightBehind. Error Number: 6022.")).toBe(true);
  });

  it("survives every shape a thrown value can take without a name in it", () => {
    for (const junk of [null, undefined, "", "FightBehind", 6022, {}, new Error(""), { logs: null }]) {
      expect(isFightBehind(junk), String(junk)).toBe(false);
    }
  });
});

describe("the catch-up bound", () => {
  // The number itself is derived (see `CATCH_UP_CALLS`); what is asserted here is that the derivation
  // still lands somewhere a player would wait through. If a future change to the bell or the compute
  // bound made this twenty, the extract button would silently become a twenty-transaction operation.
  it("is the program's own worst case, and small enough to sit through", () => {
    expect(CATCH_UP_CALLS).toBe(Math.ceil(finalCursor(MAX_FIGHTERS) / MAX_STEPS_PER_CALL));
    expect(CATCH_UP_CALLS).toBe(6);
    expect(CATCH_UP_CALLS).toBeGreaterThanOrEqual(1);
    expect(CATCH_UP_CALLS).toBeLessThanOrEqual(10);
  });
});
