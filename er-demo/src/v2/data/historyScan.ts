// WHICH ROUND ACCOUNTS THE LOG ACTUALLY READS, AND WHERE THE WALK BACK STOPS.
//
// Split out of `useHistory.ts` and kept React-free on purpose. This project has no React testing
// library — vitest, oxlint and typescript are the entire devDependency list — so a scan rule that
// lived inside a hook would be a rule nothing could ever assert. The hook supplies `read` and
// `cancelled` and does nothing else but setState; every judgement about what to fetch is here, where
// `historyScan.test.ts` can drive it directly.
//
// WHY IT STOPS EARLY, WHICH IT DID NOT USED TO. v7 added `close_round_account` and the keeper calls
// it: every round outside the chain's retention window has its ~0.0085 SOL of rent reclaimed and its
// account destroyed. A fixed newest-250 walk against a caught-up keeper therefore spent ~230 of its
// 250 reads on addresses that hold nothing — tolerated (`fetchNullable` resolves to null, the row
// simply isn't there) but pure waste, on every history fetch, against a rate-limited devnet RPC.
//
// WHY NOT SIMPLY READ `MIN_RETAINED_ROUNDS`, AND WHY NOT STOP AT THE FIRST MISS. Both throw away
// real history:
//
//   * THE KEEPER CAN BE BEHIND. Rounds outside the window that it has not closed yet still exist and
//     are still readable — a keeper that has never run leaves every one of them readable — so a scan
//     that only ever asked for the guaranteed window would silently drop history that is right there.
//   * CLOSED ROUNDS ARE A CONTIGUOUS PREFIX IN PRACTICE, NOT BY GUARANTEE. The keeper steps past a
//     round it has failed to close `CLOSE_ATTEMPTS_PER_ROUND` times (scripts/keeper/keeper.ts,
//     scripts/keeper/roundCloser.ts), precisely so that one unfixable round cannot hold every older
//     round's rent hostage forever. So the reclaimed range can have holes in it, and an exit on the
//     FIRST miss would truncate the whole log at the first hole it met.
//
// So: walk newest→oldest, and stop only on a RUN of consecutive confirmed absences. The rules that
// make that safe are written against each line below; the shape of the answer is that a caught-up
// keeper now costs about `MIN_RETAINED_ROUNDS + STOP_AFTER_CONSECUTIVE_MISSES` reads instead of 250,
// and every way this could be wrong errs toward reading more rather than reporting less.

import { MIN_RETAINED_ROUNDS } from "../../chain/constants.ts";
import type { RoundSummary } from "../contract.ts";

/** The ceiling, not the expected read count. A fresh arena's `round_counter` says nothing about what
 *  has been reclaimed, and against a keeper that has never run every round number below it is still
 *  live — so the run-of-misses rule alone would happily walk a year-old arena from the top. Sixteen
 *  fighters × ~937 bytes each is a real payload per round and no screen in v2 reads past a few dozen
 *  rows; this is what stops a page load from becoming a thousand RPC calls. */
export const MAX_ROUNDS = 250;

/** Concurrent account reads. Enough to hide latency, few enough not to trip a public RPC's rate
 *  limit — devnet's is the one that fails first, and it fails as a 429 that looks like a bug. */
export const BATCH = 8;

/** How many CONSECUTIVE confirmed absences end the walk.
 *
 *  One is not enough: the keeper's skip-after-`CLOSE_ATTEMPTS_PER_ROUND` rule means the reclaimed
 *  range can have holes, and stopping at a hole would cut the log off above real rounds. Three is a
 *  run long enough that "the keeper has closed everything from here down" is the only ordinary
 *  explanation, and the cost of being wrong is bounded and one-directional: the scan reads a few
 *  accounts too many, never a few too few. */
export const STOP_AFTER_CONSECUTIVE_MISSES = 3;

export interface RoundLogScanInput {
  /** `Arena.round_counter` — the highest round number that has ever been opened. */
  newest: bigint;
  /** One round account, or null when that PDA holds nothing. MUST NOT swallow its own errors: let it
   *  reject and let the scan catch, so the miss/error distinction is made in exactly one place. */
  read(roundNo: bigint): Promise<RoundSummary | null>;
  /** Checked at batch boundaries so a superseded fetch stops paying for reads nobody will use. */
  cancelled(): boolean;
}

export interface RoundLogScan {
  /** Newest first, holes and reclaimed rounds simply absent. This is what `LogCoverage.rounds`
   *  counts, and it must keep meaning WHAT WAS ACTUALLY READ. */
  summaries: RoundSummary[];
  /** Reads that RESOLVED — a null counts, a rejection does not. The caller's "banner only on a total
   *  failure" rule is `succeeded === 0`. */
  succeeded: number;
  /** The first rejection's message, kept whether or not it ends up being shown. */
  firstError: string | null;
}

/** Walk the round log back from `newest`, newest first, `BATCH` at a time.
 *
 *  THE STOP RULE, IN FULL:
 *
 *  1. A MISS IS A CONFIRMED ABSENCE ONLY — `read` resolving to null. A read that THREW is evidence of
 *     nothing at all (the RPC was rate-limited, the connection dropped), so it RESETS the run instead
 *     of counting toward it. The asymmetry is deliberate and is the safest one available: erring
 *     toward extra reads costs RPC calls, erring toward fewer costs real history, and only the first
 *     of those is recoverable. A flaky RPC therefore degrades to the old behaviour — read the lot —
 *     rather than to a log that is quietly missing its older half.
 *  2. THE EXIT CANNOT FIRE INSIDE THE CHAIN'S RETENTION WINDOW. `close_round_account` refuses to
 *     touch the newest `MIN_RETAINED_ROUNDS` rounds, so those accounts are guaranteed to exist; a
 *     null in there is an anomaly (a stale slot, a program whose rule moved), not the end of history,
 *     and it must never truncate. Absences inside the window are therefore not counted at all, and
 *     because the walk is strictly newest→oldest that single line is what makes the guarantee hold:
 *     the run cannot reach its threshold until every guaranteed round number has been attempted.
 *  3. THE STOP IS EVALUATED AT BATCH BOUNDARIES, on the run's value after the whole batch has been
 *     folded IN ORDER — so a live round later in the same batch correctly resets a run started
 *     earlier in it. The cost of that is bounded at `STOP_AFTER_CONSECUTIVE_MISSES + BATCH - 1`
 *     wasted reads in the worst case: a handful, not the ~230 this replaced.
 *  4. `MAX_ROUNDS` still caps everything above. See its comment — the run-of-misses rule says nothing
 *     at all about an arena whose rent nobody has reclaimed yet. */
export async function scanRoundLog({ newest, read, cancelled }: RoundLogScanInput): Promise<RoundLogScan> {
  const oldest = newest > BigInt(MAX_ROUNDS) ? newest - BigInt(MAX_ROUNDS) + 1n : 1n;
  // The lowest round number the chain still guarantees is fetchable. Imported, never retyped: the
  // Rust side owns this number and a drift test reads it back out of chain/constants.ts.
  const guaranteed = newest > BigInt(MIN_RETAINED_ROUNDS) ? newest - BigInt(MIN_RETAINED_ROUNDS) + 1n : 1n;

  const numbers: bigint[] = [];
  for (let n = newest; n >= oldest; n -= 1n) numbers.push(n);

  const summaries: RoundSummary[] = [];
  let firstError: string | null = null;
  let succeeded = 0;
  let misses = 0;

  for (let i = 0; i < numbers.length; i += BATCH) {
    if (cancelled()) break;
    const batch = numbers.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (roundNo) => {
        try {
          return { ok: true as const, roundNo, summary: await read(roundNo) };
        } catch (e) {
          return { ok: false as const, roundNo, message: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    for (const result of results) {
      if (!result.ok) {
        // Rule 1: not evidence of an absence, so it breaks the run rather than extending it.
        firstError ??= result.message;
        misses = 0;
        continue;
      }
      succeeded += 1;
      if (result.summary) {
        summaries.push(result.summary);
        misses = 0;
        continue;
      }
      // Rule 2: an absence inside the guaranteed window is an anomaly and is not counted. It does not
      // reset the run either — there is nothing to reset, because the run cannot have started yet.
      if (result.roundNo < guaranteed) misses += 1;
    }

    // Rule 3: after the whole batch, never mid-batch.
    if (misses >= STOP_AFTER_CONSECUTIVE_MISSES) break;
  }

  return { summaries, succeeded, firstError };
}
