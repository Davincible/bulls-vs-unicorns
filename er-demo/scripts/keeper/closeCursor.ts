// GETTING THE CLOSE CURSOR PAST HISTORY IT HAS ALREADY CLOSED — one batched existence probe, as a
// routine whose I/O and clock are arguments.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS EXISTS FOR, WITH THE NUMBERS OFF THE LIVE ARENA
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `keeper.ts` seeds `closeCursor` at #1 on every boot, and that is deliberate and stays — see the
// field's own comment and the seed's, both of which this module is an AMENDMENT to rather than a
// replacement for. Starting at #1 is what makes a pre-existing backlog get drained rather than only
// the rounds this process happens to open.
//
// What was wrong was never the start. It was the WALK. `closeOneFinishedRound` advances one round per
// pass, and for a round that is already closed the whole pass is an RPC that comes back `null` and a
// `+ 1n`. So after a restart the keeper spends hundreds of passes re-discovering rounds it closed
// hours ago, and during that walk no `close_round_account` runs — which means the burn samples taken
// across it measure rent going OUT with none coming back. On 2026-08-19 that produced, on a healthy
// arena:
//
//     burn        23,911,960 lamports/round   (healthy, measured over 206 rounds, is ~420,000)
//     solPerDay   9.52                        (COST-MODEL §4's total-failure figure is ~9.96)
//     runway      2.39 days                   (128 the pass before the restart)
//     reclaimed   0
//     cursor      315                          against a round_counter of 636
//
// Every one of those numbers was true and every one was about a transient. A full scan at the same
// instant found 612 rounds already closed, 0.61 SOL of rent standing (the expected ~20-round float)
// and exactly ONE genuinely stranded round, #295, still owned by the Delegation Program.
//
// THE RISK IT CREATED, WHICH IS WHY THIS IS NOT A COSMETIC FIX. `burnBrake` arms after
// `BURN_ARM_AFTER_ROUNDS` samples and then compares the mean of the last `BURN_SAMPLE_ROUNDS`
// against `MAX_BURN_LAMPORTS_PER_ROUND` (5,000,000). A catch-up sample is ~23,900,000 — 4.8x the
// ceiling. A catch-up that ran long enough to still be in the window at the moment of arming would
// therefore STOP A HEALTHY ARENA, which `reclamation.test.ts`'s header calls the failure that is
// "worse than no brake" precisely because it is indistinguishable from the fault it detects. Today's
// arithmetic makes that unlikely rather than impossible — 45 samples at ~204s/round is ~2.6 hours
// against a catch-up measured in minutes — and "unlikely because of a ratio nobody chose" is luck.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS DOES INSTEAD, AND WHY IT IS THE SAME BEHAVIOUR MINUS THE WASTE
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// It finds the OLDEST ROUND THAT STILL EXISTS at or after some starting round, by asking the chain
// about a hundred rounds at a time instead of one, and hands that back as the cursor.
//
// THE DRAIN-THE-BACKLOG INTENT IS PRESERVED EXACTLY, and the argument is one line: a round whose
// account is GONE has nothing left to drain. `decideClose` answers `advance: "already-closed"` for
// it, records nothing, costs nothing and moves on — so starting at the oldest EXISTING round reaches
// precisely the same set of rounds the walk from #1 would have reached, minus the passes spent
// proving that closed rounds are closed. Nothing is skipped on a guess: every round below the cursor
// this returns was OBSERVED absent, in a reply from the chain, in this process.
//
// THAT IS ALSO WHY THERE IS NO BINARY SEARCH HERE, and it was the first thing tried. A bisection over
// "does this round exist" assumes the closed rounds are a PREFIX, and they are not: #295 above is a
// hole — a stranded round sitting below three hundred closed ones. A bisection would land past it,
// the cursor would never visit it, and three things would follow. Its entry would vanish from
// `/reclamation.json`'s `closer.stranded.stillDelegated`, which is the only place an operator learns
// it exists. Its ~0.0235 SOL would stop being reclaimable on the day forced undelegation is deployed
// (COST-MODEL §4.3 — it exists in the delegation program's v3.1.0 API and is merely not on this
// devnet). And nothing anywhere would say so. A contiguous scan cannot skip a hole; a strided one
// cannot help it. The cost of contiguity is bounded below, and the bound is honest.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IT IS RUN AT BOOT *AND* PER PASS, WHICH WAS A DECISION AND NOT A CONVENIENCE
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// A boot-only fast-forward does not fix the arena above. It would land the cursor on #295 — correctly
// — and then leave rounds #296 through #616, all of them closed, to be walked one per pass all over
// again: 321 passes, ~10 minutes, with the same distorted samples in them. The hole is what makes
// boot-only insufficient, and holes are exactly what this arena has.
//
// So `keeper.ts` calls this routine in two configurations rather than writing two mechanisms:
//
//   AT BOOT      from #1, up to `CLOSE_CURSOR_SCAN_MAX_BATCHES` reads inside
//                `CLOSE_CURSOR_SCAN_SECONDS`. Runs before the first `open_round`, so the first burn
//                sample of the run is taken with the cursor already in position.
//   PER PASS     from the cursor, ONE read, and only on an idle pass with at least a full batch of
//                closeable rounds ahead of it. In steady state the cursor sits within a round or two
//                of the retention boundary, so the guard is false and this costs nothing at all; the
//                moment a run of closed rounds opens up in front of it — after a hole, after a
//                bounded boot scan, after any stretch where housekeeping yielded to live fights —
//                it collapses at 100 rounds per pass instead of 1.
//
// REJECTED: a background task that fast-forwards the cursor while the loop runs. It would be racing
// the one field `closeOneFinishedRound` mutates, for a saving measured in seconds, and the failure
// mode of losing that race is a cursor that goes BACKWARDS over a round it already decided about.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// EVERY WAY OUT LEAVES THE CURSOR SOMEWHERE THE CHAIN PROVED IS SAFE
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The bounds and the failure path share ONE rule, which is why there are no special cases below: the
// cursor returned is always `from + (the number of rounds observed absent)`. A scan that found a
// living round returns it. A scan that ran out of batches, ran out of time, or had its third read
// rejected by the RPC returns the round after the last one it PROVED was gone — which is correct on
// exactly the same argument as the found case, and strictly better than starting over. A scan that
// proved nothing returns `from` unchanged, which for the boot call is `1n`: the behaviour that
// shipped, unchanged, on the day the optimisation cannot run. A keeper that will not boot because a
// speed-up failed is worse than a slow keeper.
//
// NOTHING HERE THROWS. `probe` rejecting is an outcome (`"failed"`), carried out in the result with
// the error beside it, because both callers are places where throwing would be wrong: at boot it
// would abort a start that has no need to abort, and per pass it would land in the main loop's catch
// and publish `stalledSince` about a keeper that is fine.

/** HOW MANY ROUNDS GO IN ONE READ.
 *
 *  A HUNDRED BECAUSE THAT IS THE JSON-RPC's OWN CEILING on `getMultipleAccounts`, not a tuning:
 *  asking for 101 comes back `-32602 Too many inputs provided`. `fundHouseBank` and the boot banner
 *  in `keeper.ts` both rely on the same figure, and both were rewritten onto it after per-item
 *  `getBalance` calls earned `429 Connection rate limits exceeded` from api.devnet.solana.com at 48
 *  wallets and killed the process before the HTTP server bound. This is the third place in the
 *  keeper to learn that lesson and the first to learn it from the other two.
 *
 *  `chainClient.roundsExist` REFUSES a longer list rather than silently truncating or chunking it,
 *  so this number and that guard are the two halves of one rule. They are written out in both places
 *  on purpose: one is the chunk size and one is the assertion that the chunker got it right, and an
 *  assertion that reads its bound from the thing it is checking asserts nothing. */
export const CLOSE_CURSOR_PROBE_BATCH = 100;

/**
 * IS A BATCHED READ WORTH SPENDING ON THIS PASS? — the guard on the per-pass skip, as a pure function
 * because the first version of it was wrong in the one regime that matters.
 *
 * TWO CONDITIONS, AND THE FIRST ONE IS THE CORRECTION. A probe can only ever tell the caller that
 * rounds are GONE. If the round under the cursor is already known to be THERE, the probe finds it at
 * index zero and hands the cursor straight back — a hundred-key read that cannot change anything.
 *
 * THAT IS NOT A HYPOTHETICAL WASTE, IT IS THE RECLAMATION-OUTAGE PATH. `closeOneFinishedRound` parks
 * the cursor on a terminal UNSWEPT round on purpose (`sweep-first` — the one case it can fix, so it
 * comes back to the same round next pass), and it parks on a round whose close keeps failing. Both
 * are rounds that demonstrably exist. If sweeping is broken the cursor stays parked while
 * `round_counter` climbs, so within ~100 rounds — under six hours — the second condition below goes
 * true and STAYS true, and without the first condition this would issue one hundred-key read per
 * idle pass, at 1Hz, for as long as the fault lasts. Against api.devnet.solana.com that is the `429
 * Connection rate limits exceeded` this module's own header cites twice, arriving during the outage
 * the brake exists to survive.
 *
 * THE GUARD THIS REPLACED WAS `closeAttempts > 0`, WHICH WAS THE SAME IDEA AND HALF THE CASES.
 * `closeAttempts` is incremented only in the close `catch`; the `sweep-first` branch holds the cursor
 * and never touches it. Naming the OBSERVATION ("the chain said this round is there") rather than one
 * of the two counters that happen to imply it is what makes this cover both — and any third way the
 * cursor comes to rest on a living round.
 *
 * `knownLiveAt` IS A ROUND NUMBER RATHER THAN A BOOLEAN, AND THAT IS THE WHOLE ANTI-DRIFT ARGUMENT.
 * A boolean would have to be cleared at every site that advances the cursor — four of them in
 * keeper.ts — and the one somebody forgets is the one that silently disables this guard forever.
 * Compared against the cursor, it invalidates itself the instant the cursor moves, so there is one
 * place that writes it and no place that has to remember to unwrite it.
 *
 * THE SECOND CONDITION IS A FULL BATCH OF WORK OR NOTHING. Firing on a smaller run would spend a
 * batched read to save a handful of one-second passes, on the endpoint whose rate limit already
 * shapes this process. It is also what keeps the skip from ever running the cursor more than one
 * round past `through`: a cursor at or near the boundary has no batch ahead of it. Both terms are
 * `bigint`s and both are allowed to come out negative — on an arena younger than its own retention
 * window `through` is below zero and the comparison is simply false.
 */
export function probeIsWorthARead(
  cursor: bigint,
  knownLiveAt: bigint | null,
  through: bigint,
  batch: number = CLOSE_CURSOR_PROBE_BATCH,
): boolean {
  if (knownLiveAt === cursor) return false;
  return through - cursor + 1n >= BigInt(batch);
}

/** WHY THE SCAN STOPPED. Carried out rather than reduced to a boolean because the six cases want
 *  different log lines and two of them mean the cursor has an unknown stretch of history still in
 *  front of it — see `catchUpAhead`, which is derived from this and from nothing else. */
export type CloseCursorStop =
  /** A round that still exists was found. `cursor` is it. The ordinary outcome. */
  | "found"
  /** Every round from `from` to `through` was observed absent. `cursor` is `through + 1`, which
   *  `isPastRetention` will hold the walk at until the arena opens more rounds. Nothing is left to
   *  drain and nothing was skipped. */
  | "caught-up"
  /** `through < from` — there is no round old enough for the closer to touch. A young arena, or an
   *  arena with no rounds at all. */
  | "no-rounds"
  /** `maxBatches` reads were spent without reaching a living round. */
  | "batch-cap"
  /** `budgetMs` elapsed without reaching a living round. */
  | "deadline"
  /** A read was rejected. `error` carries what by. */
  | "failed";

export interface CloseCursorScan {
  /** WHERE THE CURSOR SHOULD BE. Never behind `from`, never past `through + 1`, and every round
   *  between `from` and this one was observed absent by a reply from the chain during this scan. */
  cursor: bigint;
  stoppedBecause: CloseCursorStop;
  /** How many rounds were observed absent — the passes the one-per-pass walk no longer has to spend.
   *  A plain number rather than a bigint: it is bounded by `maxBatches * batch` and it is only ever
   *  printed. */
  skipped: number;
  /** Reads actually issued, for the log line. Zero is a legitimate value on all three of the
   *  degenerate exits. */
  batches: number;
  elapsedMs: number;
  /** Null unless `stoppedBecause` is `"failed"`. */
  error: unknown;
  /** IS THERE STILL AN UNKNOWN STRETCH OF ALREADY-CLOSED HISTORY IN FRONT OF THE CURSOR?
   *
   *  True only when the scan (a) did not reach a living round and (b) proved at least one round
   *  absent and (c) stopped short of `through`. That conjunction is what makes this EVIDENCE rather
   *  than a suspicion: it says the chain was asked about a run of consecutive rounds, answered
   *  "gone" to every single one, and was cut off before the run ended.
   *
   *  `keeper.ts` reads it to decide whether to suspend burn sampling until the closer reaches a round
   *  that exists — see `KeeperContext.closeCatchUpAhead`, which argues at length why THAT predicate
   *  is safe and why the obvious one ("the cursor is behind") is not. It is computed here, beside the
   *  scan that is the only thing that can know it, rather than reconstructed by the caller from
   *  `stoppedBecause` and two comparisons it would have to get right. */
  catchUpAhead: boolean;
}

export interface CloseCursorScanOptions {
  /** The oldest round to consider. `1n` at boot; the live cursor for the per-pass skip. */
  from: bigint;
  /** The NEWEST round to consider, inclusive — the retention boundary, `round_counter -
   *  ROUND_RETENTION`, computed by the caller.
   *
   *  THE BOUNDARY AND NOT `round_counter`, because probing above it would find the live round and
   *  hand back a cursor `isPastRetention` immediately refuses to act on. Correct, and a read spent to
   *  learn nothing. It also keeps every mention of the retention window in `config.ts` and
   *  `roundCloser.ts`, where the chain's own rule already lives, rather than adding a third. */
  through: bigint;
  /** Do these rounds still have an account? Same order, same length, at most `batch` entries.
   *  Rejecting is an outcome and not a crash — see this file's header. */
  probe(roundNos: readonly bigint[]): Promise<readonly boolean[]>;
  /** A monotonic-enough millisecond clock. An ARGUMENT, for the reason `observedAtSec` is one in
   *  `reclamation.ts`: the deadline is the only thing standing between a long history and a boot that
   *  hangs, and a bound nothing can execute is a bound nobody will ever argue with. */
  nowMs(): number;
  /** Wall-clock ceiling on the whole scan. Non-positive disables it — zero reads, `from` back
   *  unchanged — which is the direction every degenerate case in this file takes. */
  budgetMs: number;
  /** Ceiling on reads issued. Non-positive disables the scan for the same reason. */
  maxBatches: number;
  /** Rounds per read. Defaults to `CLOSE_CURSOR_PROBE_BATCH`; an argument only so the tests can drive
   *  the batching arithmetic without building hundred-element expectations. */
  batch?: number;
}

/**
 * FIND THE OLDEST ROUND AT OR AFTER `from` WHOSE ACCOUNT STILL EXISTS.
 *
 * SERIAL, ONE READ AT A TIME, AND THAT IS THE POINT RATHER THAN AN OVERSIGHT. `Promise.all` over the
 * batches would finish a 200-read scan in one round trip's worth of wall clock and earn
 * `429 Connection rate limits exceeded` doing it — which is the exact failure `fundHouseBank`'s
 * comment records at 30 wallets and the boot banner's records at 48, both of which killed the process
 * during boot. api.devnet.solana.com allows ~10 requests/second per IP; awaiting each read makes the
 * request rate the reciprocal of the round-trip time (~3-7/s on that endpoint), so the concurrency
 * limit is respected by construction instead of by a semaphore somebody has to maintain.
 *
 * THE TWO BOUNDS ARE CHECKED BEFORE EACH READ, NOT AFTER, so a budget or a cap of zero issues no read
 * at all and gives `from` straight back. See the header on why every exit is safe.
 *
 * WHICH MEANS `budgetMs` BOUNDS READS ISSUED AND NOT WALL CLOCK, and the difference is worth stating
 * rather than discovering. Nothing here can interrupt a read that has already started: a `Connection`
 * in @solana/web3.js carries no default HTTP timeout, so an endpoint that accepts the socket and never
 * answers hangs this routine for as long as it hangs, whatever the budget says. The honest reading of
 * `budgetMs` is "stop STARTING reads once this much time has gone", and `maxBatches` is the bound that
 * holds unconditionally.
 *
 * NOT SPECIALLY GUARDED, AND THAT IS A DECISION. `Promise.race` against a timer would return control
 * while leaving the request in flight, so `withReadRetry` would stack a second request on top of a
 * first that may still land — trading a bounded hang for an unbounded pile of requests against the
 * endpoint that was already unwell. The exposure is boot's existing shape rather than something this
 * routine introduces: the arena fetch, `readProgramFeatures` and `fundHouseBank` all carry it, and the
 * status server is bound long before any of them, so `/health` keeps answering throughout. The one
 * place in this keeper with an explicit read timeout is `acceptsWrites`, and its comment says why it
 * is the exception: it runs before the HTTP server exists.
 */
export async function findOldestLivingRound(opts: CloseCursorScanOptions): Promise<CloseCursorScan> {
  const { from, through, probe, nowMs, budgetMs, maxBatches } = opts;
  const batch = opts.batch ?? CLOSE_CURSOR_PROBE_BATCH;
  const startedAtMs = nowMs();
  const done = (cursor: bigint, stoppedBecause: CloseCursorStop, batches: number, error: unknown = null): CloseCursorScan => ({
    cursor,
    stoppedBecause,
    skipped: Number(cursor - from),
    batches,
    elapsedMs: nowMs() - startedAtMs,
    error,
    // THE THREE CONDITIONS, WRITTEN OUT RATHER THAN LISTED AS STOP REASONS, so that a seventh stop
    // reason added later cannot silently opt itself into suspending the brake's samples. "Did not
    // reach a living round", "proved something", "stopped short" — see the field's own comment.
    catchUpAhead: stoppedBecause !== "found" && cursor > from && cursor <= through,
  });

  if (through < from) return done(from, "no-rounds", 0);
  // A batch of zero or less would loop forever asking about nothing; a negative one would build a
  // window running backwards. Neither is reachable from either call site, and both are the kind of
  // silent hang that a boot would show as "the keeper printed its banner and stopped".
  if (batch < 1) return done(from, "batch-cap", 0);

  let cursor = from;
  let batches = 0;
  while (cursor <= through) {
    if (batches >= maxBatches) return done(cursor, "batch-cap", batches);
    if (nowMs() - startedAtMs >= budgetMs) return done(cursor, "deadline", batches);

    const window: bigint[] = [];
    for (let n = cursor; n <= through && window.length < batch; n += 1n) window.push(n);

    // COUNTED BEFORE THE READ, NOT AFTER IT, because this counts READS ISSUED and a read that was
    // rejected was still issued — it still cost a round trip and it still counts against the RPC's
    // rate limit. Counting after would under-report the boot log by one on the failure path and, worse,
    // would let a run of failing reads sit outside `maxBatches` entirely.
    batches += 1;
    let exists: readonly boolean[];
    try {
      exists = await probe(window);
    } catch (e) {
      // The cursor stays where the last SUCCESSFUL read left it. Nothing this read might have learned
      // is assumed in either direction.
      return done(cursor, "failed", batches, e);
    }

    // A SHORT OR OVERLONG REPLY IS NOT READ PAST ITS OWN LENGTH. `getMultipleAccountsInfo` returns
    // one entry per key, so this cannot happen against a healthy RPC — but the cursor is money, and
    // "trust the array length the network handed me" is how an off-by-one becomes a round that was
    // never looked at. Only the prefix both agree on is believed.
    const answered = Math.min(exists.length, window.length);
    const living = exists.slice(0, answered).indexOf(true);
    if (living >= 0) return done(window[living]!, "found", batches);
    if (answered === 0) return done(cursor, "failed", batches, new Error(
      `the round-existence probe answered nothing for ${window.length} round(s) starting at #${cursor} — ` +
      `treating it as a failed read rather than as ${window.length} closed rounds`,
    ));
    cursor += BigInt(answered);
  }
  return done(cursor, "caught-up", batches);
}
