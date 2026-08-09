// WHEN A FINISHED ROUND'S ACCOUNT MAY BE CLOSED, AND WHEN THE SCAN MOVES ON — as pure functions,
// because the interesting part of reclaiming rent is not the transaction, it is the decision.
//
// WHY THIS IS ITS OWN MODULE, in the same shape as `lobbyPolicy.ts` and `houseSizing.ts`. The rule is
// almost entirely made of cases where the answer is "do not close this one", and each case has a
// different consequence if it is got wrong — one leaks money, one wedges the whole backlog, one sends
// a transaction the chain refuses. Left inline in an async function with a chain client and a context
// object threaded through it, none of them are reachable by a test, and the only way to find out
// which case a change broke is to run a keeper against devnet for an hour.
//
// THE CHAIN IS THE AUTHORITY AND THIS IS NOT A SECOND COPY OF IT. `check_close_permitted` in lib.rs
// enforces every condition: terminal phase, `house_swept`, the retention window, and
// `has_one = authority`. What this file decides is whether the keeper should BOTHER ASKING. If the two
// ever disagree the chain wins and the cost is one wasted signature — which is the asymmetry that
// makes it safe for the close policy to default ON, and the reason these checks are allowed to be
// approximate where the chain's are not.
//
// THE EXPENSIVE MISTAKE IS STOPPING, NOT SKIPPING. A round the keeper cannot close is worth ~0.0086
// SOL. A round the keeper WAITS on forever is worth that much multiplied by every older round behind
// it in the scan, because the cursor never gets past it — and it is silent, because nothing fails.
// So every terminal state of a candidate advances the cursor, and the only case that holds it is one
// the keeper can actually fix on the next pass.

import { Phase } from "../../src/chain/constants.ts";

/** A candidate round as the chain currently reports it. `null` means the account does not exist —
 *  which for this scan is the ordinary, expected answer while draining a backlog somebody (possibly a
 *  previous run of this keeper) has already worked through. */
export interface CloseCandidate {
  round: { phase: number; houseSwept: boolean } | null;
  /** Is the Delegation Program still the owner? While it is, `Account<'info, Round>` fails its owner
   *  check before the program reads a byte, so nothing can be closed. */
  delegated: boolean;
}

export type CloseAction =
  /** Send `close_round_account`. Every precondition the keeper can see is satisfied. */
  | { kind: "close" }
  /** Terminal and reachable but UNSWEPT — the one case worth fixing rather than skipping. The sweep
   *  is the precondition the chain refuses on, the keeper already has the code, and the instruction is
   *  permissionless. Sweep now, close on a later pass. The cursor does NOT move. */
  | { kind: "sweep-first" }
  /** Move to the next round. Carries WHY, because the three reasons are worth different log lines and
   *  two of them are money the arena is never getting back. */
  | { kind: "advance"; because: AdvanceReason };

export type AdvanceReason =
  /** The account is gone — already closed. The common case, and the only one that is good news. */
  | "already-closed"
  /** Stuck in `Drawing` (or otherwise non-terminal) and past the retention window. `Phase::Drawing`
   *  has NO exit in the program — only the VRF program may call `callback_seed` — so this round can
   *  never become closeable and its rent is unrecoverable. Waiting on it would cost every older
   *  round's rent as well. */
  | "never-terminal"
  /** Terminal, but the Delegation Program still owns it: an undelegation that never completed. The
   *  phase machine only repairs that for the CURRENT round, so from this scan's point of view it is
   *  as unreachable as the case above. */
  | "still-delegated";

/**
 * What to do with one candidate round.
 *
 * The ORDER of these branches is the rule, and it is not interchangeable. Existence first, because
 * every other question is about a round that is there. Then terminality, because a non-terminal round
 * is never coming back regardless of what it is owned by — asking about delegation first would file a
 * permanently wedged round under a reason that implies it might recover. Then delegation, because an
 * account the program cannot even read cannot be swept either, so a `sweep-first` here would be a
 * transaction that fails for a reason the sweep cannot fix. Only then the sweep, which is the single
 * case the keeper can do something about.
 */
export function decideClose(candidate: CloseCandidate): CloseAction {
  const { round, delegated } = candidate;
  if (round === null) return { kind: "advance", because: "already-closed" };
  if (round.phase !== Phase.Settled && round.phase !== Phase.Abandoned) {
    return { kind: "advance", because: "never-terminal" };
  }
  if (delegated) return { kind: "advance", because: "still-delegated" };
  if (!round.houseSwept) return { kind: "sweep-first" };
  return { kind: "close" };
}

/**
 * Is `roundNo` old enough that the chain will permit closing it?
 *
 * The keeper's copy of the program's own retention check, and written the same way round for the same
 * reason. `round_counter` is the highest round number ever opened, so the newest `retention` rounds
 * are those with `roundNo > roundCounter - retention` — and this is that comparison REARRANGED to
 * addition, because the subtraction form underflows while an arena is younger than its own window,
 * which is every arena for its first twenty rounds. On `bigint` an underflow does not wrap, it goes
 * negative, so the subtraction form would not crash — it would simply answer "yes, close it" for
 * every round in a young arena, and the chain would refuse each one. A quiet stream of
 * `RoundTooRecent` is a worse failure than a loud one precisely because it looks like nothing.
 */
export function isPastRetention(roundNo: bigint, roundCounter: bigint, retention: number): boolean {
  return roundNo + BigInt(retention) <= roundCounter;
}

/**
 * Is this a pass on which housekeeping should run at all?
 *
 * NEVER DURING `Drawing` OR `Fight`. Those are the only phases with real work due every second — the
 * keeper sends a `tick` per second of fight — and reclaiming rent must never compete with the round
 * somebody is actually playing, for the operator's one signature or for the RPC's attention. Every
 * other phase is a waiting stretch: a held-open lobby does nothing for an hour, a result hold does
 * nothing for twelve seconds, and an arena between rounds does nothing at all. The backlog has waited
 * this long and is in no hurry; the fight is.
 *
 * `null` — no round account readable at all — counts as idle. That is the state right after an arena
 * is created and briefly during an undelegation, and there is by definition no fight to disturb.
 */
export function housekeepingIsWelcome(phase: number | null): boolean {
  return phase !== Phase.Drawing && phase !== Phase.Fight;
}
