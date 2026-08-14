// THE ERROR SHAPES HERE ARE MEASURED, NOT INVENTED, and that is what makes this file worth having.
//
// Each `SendTransactionError`-alike was captured by sending a doomed `enter` at the deployed program
// on devnet (v8, ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe) and printing the thrown object — once
// against the base layer, once through the Magic Router into the ER, which is the path every real
// deposit takes. They differ in the one way that decides how this module can possibly work: the base
// layer returns Anchor's logs and therefore the error's NAME, and the rollup returns no logs at all
// and nothing but a hex code. A test written against hand-typed strings would have passed for a
// classifier that only ever worked on the layer players never touch.
//
// THE TWO BUILDERS MOVED OUT, to `chainErrorShapes.ts`, and that module's header argues why at
// length. Short version: they stopped being this file's fixtures the moment two more classifiers
// turned out to need them, and three hand-copies of one capture is the same defect this file's
// paragraph above is about, with more places to make it.

import { describe, expect, it } from "vitest";
import { ENTRY_CLOSE_GUARD_MS } from "../contract.ts";
import { MAX_FIGHTERS } from "../../sim/erSim.ts";
import type { SigningPlan } from "./autoSession.ts";
import {
  APPROVAL_SECONDS,
  enterErrorCodes,
  entryRefusal,
  entryRefusalCopy,
  entryRefusedError,
  firstDeployWarning,
  refusalFromProgramError,
  refusalOf,
  type EntryWindow,
} from "./entryWindow.ts";
import { classifyWalletError } from "./walletFault.ts";
import { baseLayerError, routerError } from "./chainErrorShapes.ts";

/** The deployed program's numbers, straight out of `public/idl/bulls_arena.json`. Written as the IDL
 *  shape rather than as a map so the test exercises `enterErrorCodes` the way the app does. */
const IDL_ERRORS = [
  { code: 6002, name: "NotInLobby", msg: "round is not in the lobby phase" },
  { code: 6005, name: "BadSide", msg: "side must be 0 or 1" },
  { code: 6007, name: "RoundFull", msg: "round is full" },
  { code: 6014, name: "LobbyClosed", msg: "the lobby deadline has passed — this round is no longer taking entries" },
  { code: 6022, name: "FightBehind", msg: "the fight has not been advanced to the present" },
];
const CODES = enterErrorCodes(IDL_ERRORS);

const NOW = 1_700_000_000_000;

function lobby(over: Partial<EntryWindow> = {}): EntryWindow {
  return { roundNo: 42n, phase: "Lobby", lobbyClosesAtMs: NOW + 60_000, fighterCount: 3, ...over };
}

// ---------------------------------------------------------------------------------------------

describe("entryRefusal — the question asked before the transaction is built", () => {
  it("lets an open lobby with room and time through", () => {
    expect(entryRefusal(lobby(), NOW)).toBeNull();
  });

  it("refuses every phase that is not Lobby as the round having moved on", () => {
    // `NotInLobby` is the guard the keeper's authority early close actually trips, and it does not
    // care WHICH of the four it moved to — a player gets the same answer and the same next step.
    for (const phase of ["Drawing", "Fight", "Settled", "Abandoned"] as const) {
      expect(entryRefusal(lobby({ phase }), NOW)?.code, phase).toBe("round-moved-on");
    }
  });

  it("calls a full round FULL even when it is also past its deadline", () => {
    // THE ORDERING IS THE POINT, and it is the program's, not a preference: `enter` checks
    // `RoundFull` BEFORE `LobbyClosed` so that "a player who arrives at a full lobby is told the
    // lobby is FULL rather than that they were too slow". If this file and the chain disagreed here,
    // the sentence a player read would depend on which of the two happened to notice first.
    const w = lobby({ fighterCount: MAX_FIGHTERS, lobbyClosesAtMs: NOW - 1 });
    expect(entryRefusal(w, NOW)?.code).toBe("round-full");
  });

  it("refuses at the fighter cap and not one below it", () => {
    expect(entryRefusal(lobby({ fighterCount: MAX_FIGHTERS - 1 }), NOW)).toBeNull();
    expect(entryRefusal(lobby({ fighterCount: MAX_FIGHTERS }), NOW)?.code).toBe("round-full");
  });

  it("concedes the last `ENTRY_CLOSE_GUARD_MS` of a lobby, exactly as `entriesOpen` does", () => {
    // One definition of "can a deposit land" for the whole page. If this drifted from `entriesOpen`
    // the dock would offer a button that this guard then refused, which is a worse experience than
    // either behaviour on its own.
    const closesAt = NOW + ENTRY_CLOSE_GUARD_MS;
    expect(entryRefusal(lobby({ lobbyClosesAtMs: closesAt }), NOW)?.code).toBe("entries-closed");
    expect(entryRefusal(lobby({ lobbyClosesAtMs: closesAt + 1 }), NOW)).toBeNull();
  });

  it("treats a round with no deadline as open — the older program revision, not an error", () => {
    // A round opened before `lobby_closes_at` existed takes deposits for the whole of its Lobby
    // phase, so `Lobby` is the entire truth. Refusing here would break this page against every arena
    // running a revision behind it.
    expect(entryRefusal(lobby({ lobbyClosesAtMs: null }), NOW + 10_000_000)).toBeNull();
  });
});

describe("refusalFromProgramError — the same question asked of what the chain threw", () => {
  it("reads the rollup's hex code, which on that path is the only signal there is", () => {
    // The measured shape. No logs, no `Error Code:` line, nothing but `0x1772`. A classifier keyed on
    // Anchor's error NAMES — which is what this repo does everywhere else — matches nothing here, and
    // this is the path every real deposit takes.
    expect(refusalFromProgramError(routerError("0x1772"), CODES, 42n)?.code).toBe("round-moved-on");
    expect(refusalFromProgramError(routerError("0x1777"), CODES, 42n)?.code).toBe("round-full");
    expect(refusalFromProgramError(routerError("0x177e"), CODES, 42n)?.code).toBe("entries-closed");
  });

  it("reads the base layer's Anchor logs too", () => {
    const e = baseLayerError("NotInLobby", 6002, "round is not in the lobby phase");
    expect(refusalFromProgramError(e, CODES, 42n)?.code).toBe("round-moved-on");
  });

  it("still matches by name when the IDL could not be read at all", () => {
    // `enterCodes()` in `useActions.ts` degrades to an empty map rather than throwing. That must cost
    // the base-layer path nothing — it is the pre-rollup behaviour, and it refuses nothing that used
    // to work.
    const empty = enterErrorCodes(undefined);
    expect(refusalFromProgramError(baseLayerError("LobbyClosed", 6014, "deadline"), empty, 1n)?.code)
      .toBe("entries-closed");
    // And it honestly gives up on the rollup shape rather than guessing a number.
    expect(refusalFromProgramError(routerError("0x177e"), empty, 1n)).toBeNull();
  });

  it("leaves every other program error exactly as it found it", () => {
    // `walletFault.ts`'s rule, kept: "custom program error: NothingToExtract" is a sentence somebody
    // can act on, and a paraphrase of it is worth less than the original. This module claims three
    // failures and nothing else.
    expect(refusalFromProgramError(routerError("0x1786"), CODES, 42n)).toBeNull();
    expect(refusalFromProgramError(baseLayerError("FightBehind", 6022, "tick it first"), CODES, 42n)).toBeNull();
    for (const junk of [null, undefined, 0, "", {}, [], new Error("")]) {
      expect(refusalFromProgramError(junk, CODES, 42n), String(junk)).toBeNull();
    }
  });

  it("does not claim 0x1771, which two different programs both use", () => {
    // A SHARP EDGE, AND THE ONLY THING STANDING ON IT IS THIS ASSERTION. Through the router the error
    // is a NUMBER with no program attached to it — and 6001 is `RoundOutOfOrder` in this program's
    // IDL AND `SessionError::InvalidToken` in `gpl_session`, which is what a lapsed session key
    // refuses `enter` with. If a future variant ever landed this module's three names on index 1, or
    // if somebody widened the list, a session refusal would be rewritten as "the round moved on" —
    // and `autoSession.ts`'s `afterRefusal` would stop renewing sessions, silently, on the only path
    // players use. Nothing else in the codebase would notice.
    expect(refusalFromProgramError(routerError("0x1771"), CODES, 42n)).toBeNull();
    expect([...CODES.values()]).not.toContain(6001);
  });

  it("does not fire on a bare number that happens to appear in unrelated text", () => {
    // The reason every form this matches is anchored to its surrounding phrase. A signature, a slot
    // or a lamport figure containing "6002" must not be read as a closed round.
    const e = new Error("Transaction 3n6002Kq... failed after 6002 slots at height 6014");
    expect(refusalFromProgramError(e, CODES, 42n)).toBeNull();
  });

  it("says the same words the pre-send check would have said", () => {
    // THE INVARIANT THE WHOLE MODULE IS BUILT AROUND. A player must not be able to tell whether this
    // page caught the race or the program did — if the two ever said different things, one of them
    // would be the wrong one and nobody would know which.
    const ahead = entryRefusal(lobby({ phase: "Fight" }), NOW);
    const behind = refusalFromProgramError(routerError("0x1772"), CODES, 42n);
    expect(behind).toEqual(ahead);
  });
});

describe("the words", () => {
  const all = (["round-moved-on", "entries-closed", "round-full"] as const).map((c) => entryRefusalCopy(c, 42n));

  it("answers all three of SPEC.md's questions in every state", () => {
    for (const r of all) {
      // (1) what is true — and which round, because "this round" is what the raw error already said.
      expect(r.detail, r.code).toMatch(/^Round 42/);
      // (2) what it cost. The whole of the owner's complaint is that the old error never said.
      expect(r.detail, r.code).toMatch(/Nothing was deposited/);
      // (3) what to do, and when.
      expect(r.detail, r.code).toMatch(/press the same button again/i);
      expect(r.detail, r.code).toMatch(/next lobby/i);
      // AND THE PROMISE THAT MAKES "press again" ONE PRESS. `StakeDock.tsx` holds the staged amount
      // above the deploy body precisely so this claim is true across the round change this copy is
      // about; a refusal that said it without that lift was telling a player something false.
      expect(r.detail, r.code).toMatch(/stake is still set here/i);
    }
  });

  it("never states a countdown, because a held-open lobby has none", () => {
    // `roundPhaseCopy.ts` prints `OPEN` rather than a clock for a lobby the keeper is holding for
    // players, and an E2E test holds it there. A refusal that promised "the next one opens in 30s"
    // would be inventing the number that whole mechanism exists to refuse.
    for (const r of all) expect(r.detail, r.code).not.toMatch(/\d+\s*(s\b|second|minute)/i);
  });

  it("names a full round as full and never as slow", () => {
    const full = entryRefusalCopy("round-full", 42n);
    expect(full.short).toMatch(/filled up/);
    expect(full.detail).toMatch(/no room left/);
    expect(full.detail).not.toMatch(/too late|deadline/i);
  });

  it("gives the unattended rule a clause that instructs nobody and names no round", () => {
    // `short` IS THE UNATTENDED PATH'S COPY — `useActions`' `enterUnattended` throws it in place of
    // `detail`, and it lands inside `abandonText`'s "3 attempts failed — …" and out to a toast. So it
    // must not tell an absent player to press a button, must not claim a wallet was open, and must
    // not name the round the rule's own frame has already named.
    for (const r of all) {
      expect(r.short, r.code).not.toMatch(/press|button|your wallet|Round \d/i);
      expect(r.short, r.code).toMatch(/^[a-z]/);
      expect(r.short, r.code).not.toMatch(/[.!?]$/);
      // And it still has to survive the same classifier the detail does — this is the string the
      // repeat rule hands to `classifySendFailure`.
      expect(classifyWalletError(new Error(r.short)).code, r.code).toBe("unknown");
    }
  });

  it("carries the whole verdict on the thrown error, not just one of its strings", () => {
    // The mechanism that lets one throw serve two audiences. Without it, whichever caller lost the
    // argument over the wording would have had to parse the other's copy back out of a message.
    const refusal = entryRefusalCopy("round-moved-on", 42n);
    const e = entryRefusedError(refusal);
    expect(e.message).toBe(refusal.detail);
    expect(refusalOf(e)).toEqual(refusal);
    // And it must be distinguishable from everything else that can be thrown on this path.
    for (const other of [new Error(refusal.detail), null, "x", { refusal }]) {
      expect(refusalOf(other)).toBeNull();
    }
  });

  it("survives a round nobody could name", () => {
    // `targetRoundNo` is null before the arena has been read once. A refusal in that window must
    // still be a sentence, and must not print "Round null".
    for (const c of ["round-moved-on", "entries-closed", "round-full"] as const) {
      const r = entryRefusalCopy(c, null);
      expect(r.detail, c).toMatch(/^This round/);
      expect(r.short, c).not.toMatch(/null|undefined/);
    }
  });

  it("is not mistaken for a wallet fault by `classifyWalletError`", () => {
    // A REAL HAZARD, NOT A TIDINESS CHECK. `runSigned` classifies whatever `sendEnter` throws, and a
    // message classified `session-expired` makes it REVOKE the session and open a new one — two
    // Phantom dialogs — and re-send the deposit into a round that has already closed. A `rejected`
    // classification would be re-worded by `useActions`' `REWRITTEN` set into copy about a popup
    // nobody cancelled. `useAutoDeploy.test.ts` pins the same coupling for the same reason: these
    // sentences are matched by regexes living in another file, and a copy edit could break it
    // silently.
    for (const r of all) {
      expect(classifyWalletError(new Error(r.detail)).code, r.code).toBe("unknown");
    }
  });
});

describe("enterErrorCodes", () => {
  it("takes the numbers from the IDL rather than from this file", () => {
    // Hard-coding 6002 is the thing `useActions.ts`'s `isFightBehind` rightly warns against: insert a
    // variant above it in lib.rs and the constant silently starts naming a different error. The IDL
    // is fetched at runtime and is a contract with the DEPLOYED program, so it moves when the program
    // moves.
    expect(CODES.get("NotInLobby")).toBe(6002);
    expect(CODES.get("RoundFull")).toBe(6007);
    expect(CODES.get("LobbyClosed")).toBe(6014);
  });

  it("holds only the three it needs, and tolerates an IDL with no errors at all", () => {
    expect([...CODES.keys()].sort()).toEqual(["LobbyClosed", "NotInLobby", "RoundFull"]);
    expect(enterErrorCodes(undefined).size).toBe(0);
    expect(enterErrorCodes([]).size).toBe(0);
  });
});

describe("firstDeployWarning — said before the dialogs open, or not at all", () => {
  const opening: SigningPlan = { kind: "open-then-session" };
  const live: SigningPlan = { kind: "session" };
  const direct: SigningPlan = { kind: "wallet", reason: "stopped" };

  it("says nothing when no countdown exists", () => {
    // THE RULE THE BRIEF IS EMPHATIC ABOUT. A lobby the keeper holds open for players has no
    // deadline; the caller passes null, and inventing one from the chain's hour-away backstop is the
    // lie `roundPhaseCopy.ts` and its E2E test exist to prevent.
    for (const plan of [opening, live, direct]) expect(firstDeployWarning(plan, null)).toBeNull();
  });

  it("says nothing to any signer that raises no dialog", () => {
    // ALL THREE, not just the obvious one. A live session signs in a round trip; `?signer=burner`
    // signs with a local keypair that never had a wallet to prompt; `?fixture=1` signs nothing at
    // all. Warning any of them that "a Phantom approval usually takes longer than that" is a sentence
    // about a dialog that is never coming — and for the fixture it would be that sentence over
    // invented data, which `ArenaProvider` routes through `signingPlan` specifically to prevent.
    const promptless: SigningPlan[] = [
      live,
      { kind: "wallet", reason: "burner" },
      { kind: "wallet", reason: "fixture" },
    ];
    for (const plan of promptless) {
      expect(firstDeployWarning(plan, 1), JSON.stringify(plan)).toBeNull();
    }
  });

  it("warns when the approval chain is longer than the round has left", () => {
    const warned = firstDeployWarning(opening, APPROVAL_SECONDS["open-then-session"]);
    expect(warned).toMatch(/close in about/);
    expect(warned).toMatch(/Phantom approval/);
    // It has to end on the reassurance, or it is just bad news delivered earlier.
    expect(warned).toMatch(/nothing is lost/i);
    expect(warned).toMatch(/next lobby/);
  });

  it("stays quiet while there is comfortably enough time", () => {
    expect(firstDeployWarning(opening, APPROVAL_SECONDS["open-then-session"] + 1)).toBeNull();
    expect(firstDeployWarning(direct, APPROVAL_SECONDS.wallet + 1)).toBeNull();
  });

  it("warns a wallet-signing player too, at their own shorter budget", () => {
    // One approval instead of two, so the threshold is lower — but a single Phantom dialog against a
    // twenty-second grace window is still a race worth naming.
    expect(firstDeployWarning(direct, APPROVAL_SECONDS.wallet)).toMatch(/this deploy needs one Phantom approval/);
    expect(firstDeployWarning(direct, APPROVAL_SECONDS["open-then-session"])).toBeNull();
  });

  it("quotes the number it was given and never one of its own", () => {
    expect(firstDeployWarning(opening, 7)).toMatch(/about 7s/);
  });
});
