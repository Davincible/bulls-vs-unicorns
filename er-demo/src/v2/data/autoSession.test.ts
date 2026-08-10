// THE SESSION IS NOW THE DEFAULT SIGNING PATH, so what these tests hold is not a convenience — it is
// how much money moves, how many approval dialogs a stranger is shown, and whether a cancelled popup
// can quietly turn into a signed deploy.
//
// The order of operations is asserted as an ORDER, from a recorded log, because "opens the session
// FIRST and then sends the move" is the entire claim: a version that sent first and opened after
// would satisfy every assertion about outcomes and none about behaviour.

import { describe, expect, it } from "vitest";
import {
  ASSUMED_SESSION_START_SOL,
  ASSUMED_SESSION_TOP_UP_SOL,
  afterFailedOpen,
  afterRefusal,
  canAffordSession,
  pendingNote,
  runSigned,
  sessionNote,
  sessionPanelNote,
  sessionStatus,
  signingPlan,
  type SessionSigning,
  type SigningPlanInput,
} from "./autoSession.ts";
import { classifyWalletError } from "./walletFault.ts";
import type { PlayBlock } from "./playGate.ts";
import type { SessionLife } from "./sessionExpiry.ts";

/** A connected wallet with money, no session yet, nothing in the way — the state a first-time player
 *  is in when they press Deploy. */
const FRESH: SigningPlanInput = {
  fixture: false,
  mode: "wallet",
  auto: true,
  sessionActive: false,
  gate: null,
  solBalance: 1.5,
};

const GATE: PlayBlock = {
  code: "not-connected",
  short: "no wallet is connected",
  detail: "Connect your Phantom wallet to deploy into a round.",
  cta: { kind: "connect", label: "Connect Phantom" },
};

const NO_LIFE: SessionLife = { known: false };
const LAPSING: SessionLife = { known: true, startedAtMs: 0, minutesLeft: 6, lapsing: true, lapsed: false };
const FRESH_LIFE: SessionLife = { known: true, startedAtMs: 0, minutesLeft: 52, lapsing: false, lapsed: false };

describe("signingPlan — who signs the next move", () => {
  it("opens a session first when a connected, funded wallet has none", () => {
    expect(signingPlan(FRESH)).toEqual({ kind: "open-then-session" });
  });

  it("goes straight through when a session is already live", () => {
    expect(signingPlan({ ...FRESH, sessionActive: true })).toEqual({ kind: "session" });
  });

  it("never opens one in fixture mode, where nothing is signed at all", () => {
    // `?fixture=1` renders a provider that constructs no program and reaches no chain. Quoting
    // "0.02 SOL to fund the key that signs for you" over invented data would be the page describing
    // a cost nobody is being charged.
    expect(signingPlan({ ...FRESH, fixture: true })).toEqual({ kind: "wallet", reason: "fixture" });
    expect(signingPlan({ ...FRESH, fixture: true, sessionActive: true })).toEqual({
      kind: "wallet",
      reason: "fixture",
    });
  });

  it("never opens one in burner mode, where a local keypair signs with no popup", () => {
    // The burner path has nothing to gain — it never showed a dialog in the first place — and would
    // pay 0.02 SOL for the privilege.
    expect(signingPlan({ ...FRESH, mode: "burner" })).toEqual({ kind: "wallet", reason: "burner" });
  });

  it("still uses a session a burner developer started by hand", () => {
    expect(signingPlan({ ...FRESH, mode: "burner", sessionActive: true })).toEqual({ kind: "session" });
  });

  it("does not silently restart after an explicit Stop, session or no session", () => {
    // The whole meaning of the Stop button. If the next press re-opened one, the control would be a
    // lie and the 0.02 SOL would be spent by somebody who had just said not to.
    expect(signingPlan({ ...FRESH, auto: false })).toEqual({ kind: "wallet", reason: "stopped" });
  });

  it("refuses to use a live session the player asked to stop", () => {
    // Reachable: `end()` revokes on chain, and a revoke that failed leaves a usable session behind
    // an instruction to stop using it. The instruction wins.
    expect(signingPlan({ ...FRESH, auto: false, sessionActive: true })).toEqual({
      kind: "wallet",
      reason: "stopped",
    });
  });

  it("defers to the play gate rather than opening a session nobody could use", () => {
    expect(signingPlan({ ...FRESH, gate: GATE })).toEqual({ kind: "wallet", reason: "blocked" });
  });

  it("does not attempt one a wallet demonstrably cannot afford", () => {
    // playGate blocks at a balance of exactly zero, so 0.005 SOL passes it, can deploy perfectly
    // well, and cannot cover a 0.02 SOL top-up. That player plays — with a prompt per move.
    expect(signingPlan({ ...FRESH, solBalance: 0.005 })).toEqual({ kind: "wallet", reason: "unaffordable" });
  });

  it("treats an unread balance as affordable — not-read-yet is not zero", () => {
    // The same rule `playGate` and `shouldDriveFight` already apply to the same null. Refusing here
    // would send a funded player down the popup-per-move path for their first move, every load.
    expect(canAffordSession(null)).toBe(true);
    expect(signingPlan({ ...FRESH, solBalance: null })).toEqual({ kind: "open-then-session" });
  });

  it("puts the affordability threshold above the top-up, not at it", () => {
    // `createSession` needs the top-up PLUS headroom for fees and rent, and pre-flights against
    // exactly that figure. A page that attempted at 0.02 would open a dialog destined to fail.
    expect(ASSUMED_SESSION_START_SOL).toBeGreaterThan(ASSUMED_SESSION_TOP_UP_SOL);
    expect(canAffordSession(ASSUMED_SESSION_TOP_UP_SOL)).toBe(false);
    expect(canAffordSession(ASSUMED_SESSION_START_SOL)).toBe(true);
  });
});

describe("afterFailedOpen — a cancelled approval is not consent to sign something else", () => {
  it("abandons the press when the player cancelled", () => {
    expect(afterFailedOpen("rejected")).toEqual({ kind: "abandon" });
  });

  it("abandons when there is no wallet left to sign anything with", () => {
    expect(afterFailedOpen("disconnected")).toEqual({ kind: "abandon" });
    expect(afterFailedOpen("not-installed")).toEqual({ kind: "abandon" });
  });

  it("still plays the move when the session failed for its own reasons", () => {
    // An unfunded wallet, a dropped RPC, a gum error. None of them is a reason to refuse somebody
    // the deploy they pressed — they only cost the ergonomics.
    expect(afterFailedOpen("unknown")).toEqual({ kind: "sign-with-wallet" });
    expect(afterFailedOpen("wrong-network")).toEqual({ kind: "sign-with-wallet" });
  });

  it("classifies Phantom's own cancel as a rejection, end to end", () => {
    // The link that makes the branch above reachable: gum swallows this error into its own channel,
    // so the string it produces has to survive `classifyWalletError` to get here.
    const phantomCancel = { code: 4001, message: "User rejected the request." };
    expect(afterFailedOpen(classifyWalletError(phantomCancel).code)).toEqual({ kind: "abandon" });
  });
});

describe("afterRefusal — an expired session is a renewal, not an error", () => {
  it("renews and retries when the chain says the token is no longer valid", () => {
    expect(afterRefusal("session-expired", false)).toEqual({ kind: "renew-and-retry" });
  });

  it("renews at most once per press", () => {
    // The bound that stops a genuinely broken session turning one Deploy into an unbounded run of
    // approval dialogs.
    expect(afterRefusal("session-expired", true)).toEqual({ kind: "report" });
  });

  it("reports every other failure verbatim", () => {
    // `NothingToExtract`, `NotFighting`, a rejected deploy — the chain's own words are the answer.
    expect(afterRefusal("unknown", false)).toEqual({ kind: "report" });
    expect(afterRefusal("rejected", false)).toEqual({ kind: "report" });
  });

  it("classifies the chain's InvalidToken as an expired session, end to end", () => {
    // What an expired token actually fails with — proved on devnet by verify-session-base.mjs's
    // step 5, which mints an already-expired token and asserts `enter()` fails exactly this way.
    const refusal = new Error("Error Code: InvalidToken. Error Number: 6001");
    expect(afterRefusal(classifyWalletError(refusal).code, false)).toEqual({ kind: "renew-and-retry" });
  });
});

// ---------------------------------------------------------------------------------------------
// runSigned — the order of operations, recorded
// ---------------------------------------------------------------------------------------------

interface Rig {
  log: string[];
  signing: SessionSigning<string>;
  /** Sessions handed out by `open`/`renew`, in order. */
  minted: string[];
}

function rig(
  options: {
    current?: string | null;
    openFails?: unknown;
    renewFails?: boolean;
  } = {},
): Rig {
  const log: string[] = [];
  const minted: string[] = [];
  let live = options.current ?? null;
  let n = 0;
  return {
    log,
    minted,
    signing: {
      current: () => live,
      open: async () => {
        log.push("open");
        if (options.openFails !== undefined) throw options.openFails;
        n += 1;
        live = `session-${n}`;
        minted.push(live);
        return live;
      },
      renew: async () => {
        log.push("renew");
        if (options.renewFails) return null;
        n += 1;
        live = `session-${n}`;
        minted.push(live);
        return live;
      },
      classify: (e) => classifyWalletError(e).code,
      onFallback: () => log.push("fallback"),
    },
  };
}

describe("runSigned — no session, connected, Deploy pressed", () => {
  it("opens the session first and then sends the move, in that order", async () => {
    const r = rig();
    const signedWith: (string | null)[] = [];
    const result = await runSigned({ kind: "open-then-session" }, r.signing, async (s) => {
      r.log.push("send");
      signedWith.push(s);
      return "signature";
    });

    expect(r.log).toEqual(["open", "send"]);
    expect(result).toBe("signature");
    // And the move is signed by the session that was just opened — not by the wallet, and not by a
    // stale `null` captured before it existed. This is the bug the whole design turns on: gum's
    // `createSession` resolves void and the new session only reaches the component on a later
    // render, so a path that read the session from the render closure would sign the FIRST deploy
    // with the wallet and open a popup anyway.
    expect(signedWith).toEqual(["session-1"]);
  });
});

describe("runSigned — a session is already live", () => {
  it("sends straight through, opening nothing", async () => {
    const r = rig({ current: "live" });
    const signedWith: (string | null)[] = [];
    await runSigned({ kind: "session" }, r.signing, async (s) => {
      r.log.push("send");
      signedWith.push(s);
      return "signature";
    });

    expect(r.log).toEqual(["send"]);
    expect(signedWith).toEqual(["live"]);
  });

  it("uses a session that arrived since the callback was built", async () => {
    // `current()` is read at press time on purpose. A session opened by the rail's Start button a
    // second ago must sign this move; capturing it at render time would miss it.
    const r = rig({ current: "arrived-late" });
    const signedWith: (string | null)[] = [];
    await runSigned({ kind: "open-then-session" }, r.signing, async (s) => {
      signedWith.push(s);
      return "signature";
    });
    expect(r.log).toEqual([]);
    expect(signedWith).toEqual(["arrived-late"]);
  });
});

describe("runSigned — the player cancels the session approval", () => {
  it("sends nothing at all, and throws what the wallet said", async () => {
    const cancel = { code: 4001, message: "User rejected the request." };
    const r = rig({ openFails: cancel });
    let sends = 0;

    await expect(
      runSigned({ kind: "open-then-session" }, r.signing, async () => {
        sends += 1;
        return "signature";
      }),
    ).rejects.toBe(cancel);

    // NOTHING WAS SENT. The stake and side the player chose are untouched in the dock, because the
    // press threw before it built a transaction — nothing resets them, so pressing Deploy again
    // deploys exactly what they staged.
    expect(sends).toBe(0);
    expect(r.log).toEqual(["open"]);
  });
});

describe("runSigned — the session could not be opened for its own reasons", () => {
  it("plays the move with the wallet, and says so once", async () => {
    const broke = new Error("wallet has 0.0050 SOL but starting a session needs about 0.021");
    const r = rig({ openFails: broke });
    const signedWith: (string | null)[] = [];

    const result = await runSigned({ kind: "open-then-session" }, r.signing, async (s) => {
      r.log.push("send");
      signedWith.push(s);
      return "signature";
    });

    expect(result).toBe("signature");
    expect(r.log).toEqual(["open", "fallback", "send"]);
    // `null` is the direct-wallet signer: one approval, for this one move.
    expect(signedWith).toEqual([null]);
  });
});

describe("runSigned — the session lapses mid-play", () => {
  const expired = new Error("Error Code: InvalidToken. Error Number: 6001");

  it("renews and re-sends the same move, without the caller ever seeing the refusal", async () => {
    const r = rig({ current: "hour-old" });
    const signedWith: (string | null)[] = [];
    let sends = 0;

    const result = await runSigned({ kind: "session" }, r.signing, async (s) => {
      r.log.push("send");
      signedWith.push(s);
      sends += 1;
      if (sends === 1) throw expired;
      return "signature";
    });

    expect(result).toBe("signature");
    expect(r.log).toEqual(["send", "renew", "send"]);
    // The retry is signed by the NEW session, not the one the chain just refused.
    expect(signedWith).toEqual(["hour-old", "session-1"]);
  });

  it("gives up after one renewal rather than looping on approvals", async () => {
    const r = rig({ current: "hour-old" });
    await expect(
      runSigned({ kind: "session" }, r.signing, async () => {
        r.log.push("send");
        throw expired;
      }),
    ).rejects.toBe(expired);
    expect(r.log).toEqual(["send", "renew", "send"]);
  });

  it("reports the original refusal when the renewal itself fails", async () => {
    // The renewal needs the wallet (a revoke and a create), so it can be cancelled. The refusal is
    // the more useful of the two errors: it names the session as the cause, which is the thing the
    // player can act on.
    const r = rig({ current: "hour-old", renewFails: true });
    await expect(
      runSigned({ kind: "session" }, r.signing, async () => {
        throw expired;
      }),
    ).rejects.toBe(expired);
    expect(r.log).toEqual(["renew"]);
  });

  it("does not renew when the chain refused for any other reason", async () => {
    const nothingToExtract = new Error("custom program error: NothingToExtract");
    const r = rig({ current: "live" });
    await expect(
      runSigned({ kind: "session" }, r.signing, async () => {
        throw nothingToExtract;
      }),
    ).rejects.toBe(nothingToExtract);
    expect(r.log).toEqual([]);
  });
});

describe("runSigned — signing without a session", () => {
  it("goes straight to the wallet and never touches the session at all", async () => {
    const r = rig();
    const signedWith: (string | null)[] = [];
    for (const reason of ["stopped", "burner", "unaffordable", "fixture", "blocked"] as const) {
      await runSigned({ kind: "wallet", reason }, r.signing, async (s) => {
        signedWith.push(s);
        return "signature";
      });
    }
    expect(r.log).toEqual([]);
    expect(signedWith).toEqual([null, null, null, null, null]);
    expect(r.minted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------------------------

describe("sessionNote — what the deploy and extract surfaces say", () => {
  it("names the approval, the cost and the hour before the first one is asked for", () => {
    const note = sessionNote({ kind: "open-then-session" }, NO_LIFE);
    expect(note).not.toBeNull();
    // The three facts a player needs in order to read the Phantom dialog that is about to open and
    // recognise it as the thing they just pressed a button for. Without them it looks like the
    // wrong transaction and gets cancelled.
    expect(note).toContain("one Phantom approval");
    expect(note).toContain(`${ASSUMED_SESSION_TOP_UP_SOL} SOL`);
    expect(note).toContain("hour");
    expect(note).toContain("no prompt");
  });

  it("says nothing at all once a session is live", () => {
    // It describes something that happens once. A page still explaining it forty minutes later is
    // charging rent on its own cleverness.
    expect(sessionNote({ kind: "session" }, FRESH_LIFE)).toBeNull();
    expect(sessionNote({ kind: "session" }, NO_LIFE)).toBeNull();
  });

  it("warns before the hour runs out, without claiming to know when", () => {
    const note = sessionNote({ kind: "session" }, LAPSING);
    expect(note).toContain("About 6 minutes left");
    // Hedged, because the countdown is an inference from a mirrored constant — see sessionExpiry.ts.
    // "When it runs out" is true whenever it happens to be true.
    expect(note).toContain("When it runs out");
    expect(note).not.toContain("expires at");
  });

  it("explains the popups when the player stopped sessions, and how to end them", () => {
    const note = sessionNote({ kind: "wallet", reason: "stopped" }, NO_LIFE);
    expect(note).toContain("every move asks Phantom");
    expect(note).toContain("wallet panel");
  });

  it("names the balance as the reason when a session cannot be afforded", () => {
    const note = sessionNote({ kind: "wallet", reason: "unaffordable" }, NO_LIFE);
    expect(note).toContain("devnet SOL");
    expect(note).toContain("Top up");
  });

  it("says nothing where there is nothing to say", () => {
    // A burner sees no dialogs to explain, the fixture signs nothing, and a blocked reader is
    // already looking at playGate's account of why — which is the better one, and the only one.
    expect(sessionNote({ kind: "wallet", reason: "burner" }, NO_LIFE)).toBeNull();
    expect(sessionNote({ kind: "wallet", reason: "fixture" }, NO_LIFE)).toBeNull();
    expect(sessionNote({ kind: "wallet", reason: "blocked" }, NO_LIFE)).toBeNull();
  });

  it("never promises that nothing has to be approved", () => {
    // The one oversell that would make this worse than the popup-per-move page it replaces: opening
    // a session IS a transaction and always costs one signature.
    for (const plan of [
      { kind: "open-then-session" } as const,
      { kind: "session" } as const,
      { kind: "wallet", reason: "stopped" } as const,
      { kind: "wallet", reason: "unaffordable" } as const,
    ]) {
      const note = sessionNote(plan, LAPSING) ?? "";
      expect(note.toLowerCase()).not.toContain("never approve");
      expect(note.toLowerCase()).not.toContain("no approvals");
      expect(note.toLowerCase()).not.toContain("without approving");
    }
  });
});

describe("sessionStatus — the rail's one-line state", () => {
  it("says what happens next rather than what has not happened", () => {
    // It used to read `NOT STARTED`, which was true, useless, and sat above a button nobody pressed.
    expect(sessionStatus({ kind: "open-then-session" })).toBe("OPENS ON YOUR NEXT MOVE");
  });

  it("has a distinct, non-empty line for every plan", () => {
    const plans = [
      { kind: "session" } as const,
      { kind: "open-then-session" } as const,
      ...(["fixture", "burner", "stopped", "unaffordable", "blocked"] as const).map(
        (reason) => ({ kind: "wallet", reason }) as const,
      ),
    ];
    const lines = plans.map(sessionStatus);
    for (const line of lines) expect(line.trim()).not.toBe("");
    // "STOPPED" and "OPENS ON YOUR NEXT MOVE" are opposite instructions; a reader who cannot tell
    // them apart cannot tell whether the next press will cost them an approval.
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe("pendingNote — what the disabled buttons are waiting on", () => {
  it("names the session approval while it is the thing being waited for", () => {
    // The press now spans a wallet dialog the player has to go and find. "Sending…" over a Phantom
    // popup describes the wrong half of the wait.
    expect(pendingNote("opening")).toContain("Phantom");
    expect(pendingNote(null)).toContain("Sending");
  });

  it("says TWO approvals while renewing, because that is what a renewal costs", () => {
    // AND THIS IS THE ONLY STRING GUARANTEED TO BE ON SCREEN WHEN ONE STARTS. `sessionNote`'s
    // warning needs `life.known`, and a session restored from a previous visit has no local record
    // of when it began — `sessionExpiry.ts` calls that a common state, not an edge one. Without the
    // count here, a second dialog arrives mid-extract with nothing having mentioned it.
    expect(pendingNote("renewing")).toContain("two approvals");
    expect(pendingNote("opening")).not.toContain("two approvals");
  });

  it("does not tell a player their session ran out when they closed it themselves", () => {
    expect(pendingNote("stopping")).toContain("Closing");
    expect(pendingNote("stopping")).not.toContain("ran out");
  });
});

describe("sessionPanelNote — the wallet rail's account of itself", () => {
  const PLANS = [
    { kind: "session" } as const,
    { kind: "open-then-session" } as const,
    ...(["fixture", "burner", "stopped", "unaffordable", "blocked"] as const).map(
      (reason) => ({ kind: "wallet", reason }) as const,
    ),
  ];

  it("never tells a reader a move will open a session when no move ever will", () => {
    // THE BUG THIS REPLACES. The paragraph branched on `auto` alone, so it read "the first move you
    // make opens it" directly beneath a Status row saying NOT NEEDED — THE BURNER KEY SIGNS
    // SILENTLY, and again beneath NOT USED IN FIXTURE MODE. Two lines of one panel, contradicting
    // each other, four lines apart.
    for (const reason of ["fixture", "burner"] as const) {
      const note = sessionPanelNote({ kind: "wallet", reason });
      expect(note.toLowerCase()).not.toContain("your next move opens one");
      expect(note.toLowerCase()).not.toContain("your first move opens one");
    }
  });

  it("says what a session is doing, not what to do about it, once one is live", () => {
    const note = sessionPanelNote({ kind: "session" });
    expect(note).toContain("is signing your deploys and extracts");
    // No chore. The renewal happens by itself; this panel is here to be read, not obeyed.
    expect(note.toLowerCase()).not.toContain("press start");
  });

  it("gives every plan a non-empty paragraph, and no two the same", () => {
    const notes = PLANS.map(sessionPanelNote);
    for (const note of notes) expect(note.trim().length).toBeGreaterThan(40);
    expect(new Set(notes).size).toBe(notes.length);
  });

  it("quotes the top-up wherever it claims a session costs something", () => {
    // One mirrored constant, one figure. Six hand-typed "0.02"s is how one of them survives the
    // number moving — the defect `feeCopy.ts` was written to close for the entry fee.
    for (const plan of PLANS) {
      const note = sessionPanelNote(plan);
      if (/SOL/.test(note)) expect(note).toContain(`${ASSUMED_SESSION_TOP_UP_SOL} SOL`);
    }
  });
});
