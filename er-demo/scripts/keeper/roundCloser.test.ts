// RECLAIMING RENT — the cases where the answer is "do not close this one", which is most of them.
//
// This rule guards the largest single quantity in running the arena: a round's PDA holds 0.023497 SOL
// of rent deposit against the ~0.00007 SOL of fees a round actually spends, and until v7 nothing ever
// reclaimed it (COST-MODEL §1). Every test here is a case where getting it wrong is SILENT — no
// exception, no failed transaction, just money that quietly stops coming back, or a scan that quietly
// stops scanning.
//
// The two failures are not the same size, which is why the branch order in `decideClose` matters:
// skipping a round costs that round's ~0.0235 SOL, while WAITING on a round costs that much times
// every older round stuck behind the cursor, forever, with nothing in the log to say so — ~9.96
// SOL/day at 424 rounds/day, which is COST-MODEL §4's whole subject.

import { describe, expect, it } from "vitest";
import { Phase } from "../../src/chain/constants.ts";
import {
  decideClose, housekeepingIsWelcome, isPastRetention, type CloseCandidate,
} from "./roundCloser.ts";

const settled = (over: Partial<{ phase: number; houseSwept: boolean }> = {}) => ({
  phase: Phase.Settled, houseSwept: true, ...over,
});

const candidate = (over: Partial<CloseCandidate> = {}): CloseCandidate => ({
  round: settled(), delegated: false, ...over,
});

describe("deciding what to do with one finished round", () => {
  it("closes a settled, swept, undelegated round", () => {
    expect(decideClose(candidate())).toEqual({ kind: "close" });
  });

  it("closes an ABANDONED round too, not just a settled one", () => {
    // An abandoned round holds exactly the same rent, and `check_close_permitted` accepts both
    // terminal phases. Treating only `Settled` as closeable would strand every lobby nobody joined —
    // which under the hold-open policy is the most common way for a round to end.
    expect(decideClose(candidate({ round: settled({ phase: Phase.Abandoned }) }))).toEqual({ kind: "close" });
  });

  it("advances past a round whose account is already gone", () => {
    // The ordinary case while draining a backlog, and the only advance that is good news.
    expect(decideClose(candidate({ round: null }))).toEqual({ kind: "advance", because: "already-closed" });
  });

  it("sweeps an unswept round rather than skipping it", () => {
    // The chain refuses an unswept round with `RoundNotSwept`, and the sweep is the precondition —
    // permissionless, already implemented, one transaction. Skipping here would forfeit both the
    // round's rent AND its house take, which is the exact outcome `check_close_permitted` orders the
    // books before the record to prevent.
    expect(decideClose(candidate({ round: settled({ houseSwept: false }) }))).toEqual({ kind: "sweep-first" });
  });

  for (const phase of [Phase.Lobby, Phase.Drawing, Phase.Fight]) {
    it(`advances past a non-terminal round (${phase}) instead of waiting for it`, () => {
      // `Phase::Drawing` has NO exit in the program — only the VRF program may call `callback_seed` —
      // so a round wedged there can never become closeable. Waiting would hold every OLDER round's
      // rent hostage behind one that is never coming.
      expect(decideClose(candidate({ round: settled({ phase }) })))
        .toEqual({ kind: "advance", because: "never-terminal" });
    });
  }

  it("advances past a terminal round that is still delegated", () => {
    // `Account<'info, Round>` fails its owner check while the Delegation Program owns the account, so
    // nothing can be closed and nothing the closer does will change that — the phase machine only
    // repairs a stuck undelegation for the CURRENT round.
    expect(decideClose(candidate({ delegated: true })))
      .toEqual({ kind: "advance", because: "still-delegated" });
  });

  it("reports a delegated round as delegated even when it is also unswept", () => {
    // ORDER TEST, and the reason the branches are not interchangeable. A delegated account cannot be
    // swept either — the sweep hits the same owner check — so answering `sweep-first` here would send
    // a transaction that fails for a reason sweeping cannot fix, once per pass, forever.
    expect(decideClose({ round: settled({ houseSwept: false }), delegated: true }))
      .toEqual({ kind: "advance", because: "still-delegated" });
  });

  it("reports a non-terminal round as non-terminal even when it is also delegated", () => {
    // The other half of the ordering: a round wedged in Drawing IS delegated, and filing it under
    // "still-delegated" would imply it might recover when it never can.
    expect(decideClose({ round: settled({ phase: Phase.Drawing }), delegated: true }))
      .toEqual({ kind: "advance", because: "never-terminal" });
  });

  it("never answers `close` for anything the chain would refuse", () => {
    // The property behind the individual cases. Every combination that fails `check_close_permitted`
    // must produce something other than `close`, or the keeper burns a signature to be told no.
    for (const phase of [Phase.Lobby, Phase.Drawing, Phase.Fight, Phase.Settled, Phase.Abandoned]) {
      for (const houseSwept of [true, false]) {
        for (const delegated of [true, false]) {
          const action = decideClose({ round: { phase, houseSwept }, delegated });
          const chainWouldAllow =
            (phase === Phase.Settled || phase === Phase.Abandoned) && houseSwept && !delegated;
          expect(action.kind === "close").toBe(chainWouldAllow);
        }
      }
    }
  });
});

describe("the retention window", () => {
  const RETENTION = 20;

  it("permits a round exactly at the boundary", () => {
    // `roundNo + retention <= roundCounter` — round #1 becomes closeable the moment #21 exists.
    expect(isPastRetention(1n, 21n, RETENTION)).toBe(true);
  });

  it("refuses the round one short of the boundary", () => {
    expect(isPastRetention(1n, 20n, RETENTION)).toBe(false);
  });

  it("refuses everything in an arena younger than its own window", () => {
    // THE UNDERFLOW CASE, and the reason the comparison is written as addition. The subtraction form
    // (`roundNo <= roundCounter - retention`) does not crash on bigint — it goes NEGATIVE — so it
    // would answer "closeable" for every round in a young arena, and the keeper would send a stream
    // of transactions the chain refuses with `RoundTooRecent`. Silent, and it looks like nothing.
    for (let counter = 0n; counter < BigInt(RETENTION); counter++) {
      for (let roundNo = 1n; roundNo <= counter; roundNo++) {
        expect(isPastRetention(roundNo, counter, RETENTION)).toBe(false);
      }
    }
  });

  it("never permits a round the chain is still retaining, at any counter", () => {
    // The invariant, stated over a range rather than at one point: the newest `retention` rounds are
    // exactly the ones that must stay fetchable, because `useHistory` reads rounds by address and a
    // closed one drops out of the log silently.
    for (let counter = 1n; counter <= 60n; counter++) {
      for (let roundNo = 1n; roundNo <= counter; roundNo++) {
        const retained = roundNo > counter - BigInt(RETENTION);
        expect(isPastRetention(roundNo, counter, RETENTION)).toBe(!retained);
      }
    }
  });
});

describe("when housekeeping is allowed to run at all", () => {
  it("stays out of the way of a live fight", () => {
    // These are the only phases with work due every second (a `tick` per second of fight). Rent is in
    // no hurry; the fight is.
    expect(housekeepingIsWelcome(Phase.Drawing)).toBe(false);
    expect(housekeepingIsWelcome(Phase.Fight)).toBe(false);
  });

  it("runs during the waiting stretches, which is most of an arena's life", () => {
    // A held-open lobby does nothing for an hour and a result hold does nothing for twelve seconds.
    // If those were excluded too, a keeper under the hold-open policy would essentially never
    // reclaim anything.
    expect(housekeepingIsWelcome(Phase.Lobby)).toBe(true);
    expect(housekeepingIsWelcome(Phase.Settled)).toBe(true);
    expect(housekeepingIsWelcome(Phase.Abandoned)).toBe(true);
  });

  it("treats no readable round as idle", () => {
    // A fresh arena, or the moment mid-undelegation when the round is readable through neither route.
    // There is by definition no fight to disturb.
    expect(housekeepingIsWelcome(null)).toBe(true);
  });
});
