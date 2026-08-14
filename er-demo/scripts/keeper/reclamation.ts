// IS RENT STILL COMING BACK? — the instrument, and the brake, as pure functions.
//
// PURE FUNCTIONS ONLY — no chain, no I/O, no `process.env`, and no clock READ anywhere in this file.
// The observation instant arrives as `observedAtSec` the same way `roundNo` arrives in
// `roundCloser.ts` and an instant arrives in `houseSizing.ts`, and for the same reason: a judgement
// you cannot run on its own is one nobody will ever argue with. This one decides whether the arena
// keeps spending, so it is the last judgement in this repo that should be reachable only by running a
// keeper against devnet for two hours and watching what happens.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// From COST-MODEL.md §0 and §4, in three numbers:
//
//     steady state, reclamation working        ~0.030 SOL/day
//     gross flow through the operator          ~11.4  SOL/day, almost all of it returning
//     steady state, reclamation STOPPED        ~9.96  SOL/day, which empties 14.95 SOL in ~36 hours
//
// The distance between the first and the third is 330x, and the only thing holding the arena on the
// right side of it is `close_round_account` returning 0.023497 SOL per round. That mechanism is
// built, tested — and, at `MAX_FIGHTERS = 48`, NEVER OBSERVED RUNNING. Rent at this account size is
// 2.7x what it was the last time reclamation was seen working. So the arena is about to run
// continuously on a figure that is a projection, and the failure mode is silent in the way that
// matters most: nothing throws, no transaction fails, the keeper's own status stays green, and the
// balance drains at the rate rounds are opened.
//
// This module is the instrument that would notice, and the brake that would stop it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO INDEPENDENT WITNESSES, DELIBERATELY
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `sweepGap` (`Arena.round_counter` minus `Treasury.rounds_swept`) is what COST-MODEL §4 names in as
// many words as the thing to watch. It is a DIRECT observation of the chain's own bookkeeping, it
// needs no history and no arithmetic, and it is right immediately.
//
// `burnBrake` is the other end of the same question asked from the operator's wallet, and it exists
// because the sweep gap answers a NARROWER question than the one that matters. A sweep is a
// precondition of a close, not a close; a keeper that sweeps perfectly and then fails every
// `close_round_account` has a sweep gap of zero and is burning 9.96 SOL/day. The balance cannot be
// fooled that way — see `burnBrake` for the full argument — but it is a LAGGING measurement and it
// cannot say anything at all for the first `armAfter` rounds.
//
// Neither one subsumes the other, so the report carries both and the brake is wired to the one that
// cannot be fooled. That is not redundancy; they fail in different directions.

/** WHAT ONE ROUND'S `Round` PDA HOLDS, in lamports — 0.023497 SOL, measured against v8 at
 *  `MAX_FIGHTERS = 48` (COST-MODEL.md §1, from a real 44-fighter round).
 *
 *  IT IS A MEASUREMENT, NOT A CHAIN CONSTANT, and that is why it lives here and is used for nothing
 *  but reporting. The true figure is `Rent::minimum_balance(8 + Round::INIT_SPACE)` evaluated by the
 *  runtime at the moment the account was created, and it moves with the seat cap: the same number was
 *  0.008561 SOL at sixteen fighters. Deriving it here would mean this file holding a copy of the
 *  account layout, which would be a second source of truth for a fact the chain already owns and
 *  would be wrong the first time a field is added to `Round`.
 *
 *  So it is used ONLY to turn a count of lost rounds into the SOL figure that makes that count
 *  actionable — "2 rounds skipped" and "0.047 SOL you are never getting back" are the same fact, and
 *  only one of them makes anybody do something. Nothing decides anything on this number, so being a
 *  few thousand lamports out costs a rounding error in a report and not a wrong action. */
export const ROUND_RENT_LAMPORTS = 23_497_000;

/** One SOL, in lamports. Written out rather than imported from `@solana/web3.js` because this module
 *  is pure arithmetic over numbers the keeper already read, and importing a chain SDK for one integer
 *  would put a dependency with a `Connection` in it inside a file whose entire discipline is that it
 *  has none. */
const LAMPORTS_PER_SOL = 1_000_000_000;

// ---------------------------------------------------------------------------------------------
// What the keeper observed
// ---------------------------------------------------------------------------------------------

/**
 * THE OBSERVED STATE — everything this module is allowed to know, filled in by the keeper and handed
 * over. Nothing here is computed; every field is something the keeper read or counted.
 */
export interface ReclamationState {
  observedAtSec: number;
  /** Arena.round_counter, and Treasury.rounds_swept as of the last poll. Null before the first poll,
   *  or when the treasury account does not exist on this program. */
  arena: { roundCounter: number; roundsSwept: number | null; polledAtSec: number } | null;
  closer: {
    cursor: number;
    /** close_round_account calls that succeeded this run. */
    reclaimed: number;
    /** Rounds the cursor stepped past after CLOSE_ATTEMPTS_PER_ROUND failures. Every one is
     *  0.023497 SOL gone permanently. */
    skipped: number[];
    /** Rounds that can never be closed: non-terminal past retention, or terminal but still owned by
     *  the Delegation Program. */
    strandedNeverTerminal: number[];
    strandedStillDelegated: number[];
    /** HOW MANY ROUNDS EACH LIST ABOVE HAS RECORDED, INCLUDING THE ONES IT NO LONGER HOLDS. Each list
     *  is a BOUNDED SAMPLE and the total beside it is the truth; the pairing is the suffix, so the
     *  reader of one is never far from the other.
     *
     *  THE SPLIT EXISTS BECAUSE THIS PAYLOAD IS RE-RENDERED EVERY PASS AND SERVED TO ANYBODY WHO ASKS.
     *  The keeper is meant to run for weeks and its close cursor walks every round the arena ever
     *  opened, so a run whose reclamation has genuinely failed would append one entry per round
     *  forever — see `CLOSE_LOSS_SAMPLE` in keeper.ts, which owns the bound and the size of it. Nothing
     *  is lost by capping the list: every individual loss is logged, uncapped, at the instant it
     *  happens, so the log is the complete record and the list is only the shape of it.
     *
     *  WHAT MUST NOT BE CAPPED IS THE COUNT, and that is the whole reason these three exist. This
     *  endpoint answers "how much have I permanently lost". Deriving that from a list length would
     *  understate it exactly when the loss is largest — a run that skipped 200 rounds would report 50
     *  and ~1.17 SOL against a true ~4.70 — and it would do it silently, with the numbers still
     *  internally consistent and nothing anywhere to say otherwise. A bounded list is an honest
     *  sample; a bounded total is a wrong answer to the only question being asked. */
    skippedTotal: number;
    strandedNeverTerminalTotal: number;
    strandedStillDelegatedTotal: number;
  };
  /** Operator lamports at each open_round, newest last, at most BURN_SAMPLE_ROUNDS entries. */
  burnSamplesLamports: number[];
  operatorLamports: number | null;
}

// ---------------------------------------------------------------------------------------------
// The brake
// ---------------------------------------------------------------------------------------------

export interface BurnVerdict {
  /** Enough samples to have an opinion at all — `samplesObserved >= armAfter`. While this is false
   *  the mean below is still reported, and still true, but nothing may act on it. */
  armed: boolean;
  /** The `n` of the mean beside it: how many samples the average was actually taken over, which is
   *  `min(observed, windowSamples)`. Deliberately NOT the number observed — a mean's sample size is
   *  the number that qualifies it, and the observed count is what `armed` already speaks for. */
  samples: number;
  /** Null when there is no sample at all, or when a sample was not a finite number. Full precision:
   *  the report rounds it, the comparison does not. */
  meanLamportsPerRound: number | null;
  tripped: boolean;
}

/**
 * HAS THE ARENA STARTED BURNING RENT INSTEAD OF LENDING IT? — the safety stop, as a decision over a
 * window of balance samples.
 *
 * Each sample is the NET lamports one round cost, measured as the difference between two consecutive
 * `open_round` balance readings of the operator wallet.
 *
 * WHY CONSECUTIVE OPEN-TO-OPEN BALANCE SAMPLES ARE THE RIGHT MEASUREMENT. They are the ground truth,
 * and they are the only measurement here that requires no accounting: whatever left the wallet and
 * whatever came back into it between two rounds is in the difference, including every close that
 * landed in between, every fee, every refill of a house wallet and every delegation escrow that did
 * or did not return. That is what makes them subsume failure modes NOBODY HAS THOUGHT OF. A counter
 * of close failures only catches the ones that were predicted — it says nothing about a close that
 * succeeds and returns less than it should, about rent that is reclaimed to the wrong account, about
 * a fifth kind of stranding that arrives with the next program version, or about a cost this arena
 * has never had before. COST-MODEL §7 records this exact lesson at one remove: the first cost figure
 * in that document summed fees on transactions touching the round PDA, which is a defensible-looking
 * proxy that silently excluded everything the operator paid elsewhere. The balance excludes nothing.
 *
 * WHY THE BRAKE CANNOT ARM EARLY, AND WHY THAT IS TWO SEPARATE NUMBERS. Rent comes back
 * `MIN_RETAINED_ROUNDS` rounds AFTER it leaves — the chain refuses `close_round_account` before that
 * — so a young arena legitimately pays the full ~0.0268 SOL for every one of its first twenty rounds
 * and gets none of it back yet. Those samples are, to a balance watcher, indistinguishable from a
 * total reclamation outage, because for those rounds the arena genuinely is not reclaiming anything.
 *
 * That is why `armAfter` and `windowSamples` are different knobs rather than one. The mean is taken
 * over the last `windowSamples` samples of `samplesObserved`, so the oldest sample in the window is
 * number `samplesObserved - windowSamples + 1`, and the window is clean only once that number is past
 * the retention turnover:
 *
 *     armAfter - windowSamples >= ROUND_RETENTION
 *
 * THIS FILE CANNOT CHECK THAT RELATION AND DELIBERATELY DOES NOT TRY. It would have to hold its own
 * copy of the chain's retention window to do so — a second source of truth for a number
 * `src/chain/constants.ts` already owns and `config.ts` already validates — in a module that decides
 * nothing about the chain. It is stated here because it is the constraint that makes the two
 * constants correct together, and neither one is checkable on its own: `config.ts` sets them and its
 * doc block carries the arithmetic. Get it wrong in the cheap-looking direction and the window at the
 * moment of arming still contains pre-turnover rounds, the mean reads several times the threshold,
 * and a perfectly healthy keeper stops itself in its first two hours — a false positive that is
 * INDISTINGUISHABLE FROM THE FAULT IT DETECTS, which is worse than having no brake.
 *
 * WHY A TOP-UP CANNOT CAUSE A FALSE STOP. An `airdrop` or a manual transfer into the operator, or a
 * house-bank refill netting the other way, shows up as a NEGATIVE sample — the balance went up across
 * that round — and a negative sample only pulls the mean DOWN. So the brake can be fooled into
 * staying open, and never into closing. That is the correct direction for this mechanism and it is
 * worth being explicit about why: a false positive stops an arena that was working, silently, in a
 * way that looks exactly like the outage it was meant to catch; a false negative costs SOL that a
 * human is already watching, in a report they already have open, with `sweepGap` sitting beside it
 * saying the same thing from the chain's side. The asymmetry is not an accident of the arithmetic —
 * it is the property that makes it safe to wire this to a stop.
 *
 * The same asymmetry decides both degenerate cases: a non-positive `armAfter` or `windowSamples` is a
 * misconfiguration, and a misconfigured brake NEVER ARMS rather than arming on everything. A
 * non-finite sample — which cannot come from `getBalance` and could only come from arithmetic against
 * something that was `undefined` — voids the mean rather than being quietly dropped, because a brake
 * that silently discards the samples it cannot read is measuring something other than what it says.
 *
 * STRICTLY GREATER THAN THE THRESHOLD. At exactly the threshold nothing has gone wrong yet; the
 * threshold is a ceiling that has to be crossed, not one that has to be reached.
 */
export function burnBrake(
  samples: readonly number[],
  thresholdLamports: number,
  armAfter: number,
  windowSamples: number,
): BurnVerdict {
  const observed = samples.length;
  const armed = armAfter > 0 && observed >= armAfter;
  if (windowSamples <= 0) return { armed: false, samples: 0, meanLamportsPerRound: null, tripped: false };

  const window = samples.slice(-windowSamples);
  if (window.length === 0) return { armed, samples: 0, meanLamportsPerRound: null, tripped: false };

  const mean = window.reduce((sum, s) => sum + s, 0) / window.length;
  if (!Number.isFinite(mean)) {
    return { armed: false, samples: window.length, meanLamportsPerRound: null, tripped: false };
  }
  return { armed, samples: window.length, meanLamportsPerRound: mean, tripped: armed && mean > thresholdLamports };
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

/**
 * WHAT `GET /reclamation.json` SAYS. A plain, JSON-serialisable object with one audience — a human
 * with `curl`, during the first day of continuous running — and no programmatic consumer at all.
 *
 * TWO NUMBER FORMATS, AND THE RULE IS UNIFORM SO THAT NOBODY HAS TO REMEMBER IT FIELD BY FIELD.
 *
 *   * EVERY LAMPORT FIGURE IS A WHOLE NUMBER AS A DECIMAL STRING. Lamports are u64s and a JSON number
 *     cannot hold one without silently rounding it — the same rule `pot` and `KeeperLowBalance`
 *     follow in `src/v2/data/keeperStatus.ts`, and it is money for the same reason. An operator
 *     balance genuinely reaches past 2^53 in the domain even if this arena's does not, and a rule
 *     with an exception in it is a rule somebody applies wrongly to the next field. `mean` is rounded
 *     to whole lamports to join it: sub-lamport precision in a per-round average is a fiction (half a
 *     lamport a round is 212 lamports a day), and the full-precision value is what the brake compares
 *     against, not what the report prints.
 *
 *   * EVERY SOL, DAY AND RATIO FIGURE IS A JSON NUMBER, ROUNDED. These are magnitudes a human reads,
 *     never amounts anything moves, and printing `0.0297321` to nine places would be precision that
 *     the underlying estimate does not have.
 *
 * EVERY LOSS BLOCK CARRIES `listed` BESIDE `count`, AND IT IS A NUMBER RATHER THAN A `sampled` FLAG.
 * The lists are bounded and the counts are not, so a block reading `count: 200` above fifty round
 * numbers is correct and looks broken; something has to say which. A boolean would say that the two
 * are allowed to differ and then stop, at exactly the moment it went true — and by then the reader's
 * question is no longer "is this a sample" but "how much is missing", which a flag cannot answer and
 * `count - listed` answers exactly. The number does both jobs, since `listed < count` IS the flag,
 * derived by the reader rather than published twice. It is on both blocks even though `skipped` has
 * only one list, on the same uniformity argument as the two number formats above — a rule with an
 * exception in it is a rule somebody applies wrongly to the next field.
 */
export interface ReclamationReport {
  observedAtSec: number;
  /** `round_counter - rounds_swept`. COST-MODEL §4 names this, in as many words, as the thing to
   *  watch for the first day of continuous running: if the gap grows, the burn is 330x the headline
   *  and the balance is gone in a day and a half. Null when the treasury has not been read — see
   *  `arena` for why that is reported rather than defaulted to zero. */
  sweepGap: number | null;
  /** Null before the first treasury poll, or on a program with no treasury account.
   *
   *  `pollAgeSec` IS PUBLISHED BESIDE THE COUNTS BECAUSE THE GAP IS ONLY AS FRESH AS THE POLL. The
   *  treasury is read on its own slower interval, so a reader comparing a gap of zero against a
   *  round counter that has moved eleven times since the poll would be reading a fact about the past
   *  as a fact about now. */
  arena: {
    roundCounter: number;
    roundsSwept: number | null;
    polledAtSec: number;
    pollAgeSec: number;
  } | null;
  closer: {
    cursor: number;
    reclaimed: number;
    /** Rounds the cursor gave up on after `CLOSE_ATTEMPTS_PER_ROUND` failures. GONE PERMANENTLY —
     *  nothing revisits them, by design, because one unfixable round must not hold every older
     *  round's rent behind it. The round NUMBERS as well as the count, because a list of round
     *  numbers is something an operator can go and look at and a count is not.
     *
     *  `count` IS THE RUN'S TOTAL AND `rounds` IS A BOUNDED SAMPLE OF IT, so the two can legitimately
     *  disagree — see `ReclamationState.closer` for why the loss must be counted past the bound.
     *  `listed` is how many the sample actually holds, and it is here so that disagreement reads as
     *  design rather than as a bug. */
    skipped: { rounds: number[]; count: number; listed: number; lamports: string; sol: number };
    /** Rounds no instruction can close: wedged before a terminal phase, or still owned by the
     *  Delegation Program. REPORTED SEPARATELY FROM `skipped`, not summed into it, because the two
     *  are different kinds of loss. A skipped round was closeable and was given up on. A stranded
     *  one was never closeable — and the still-delegated half is not even certainly lost, since
     *  forced undelegation exists in the delegation program's v3.1.0 API and is merely not deployed
     *  on the devnet this runs against (COST-MODEL §4.3). Adding them together would turn a number
     *  that might come back into a number that never will. */
    stranded: {
      neverTerminal: number[];
      stillDelegated: number[];
      count: number;
      /** Entries across BOTH lists above, against a `count` that is the run's total. Summing the two
       *  is what makes this worth publishing here and not only in `skipped`: a reader can compare one
       *  list's length against a count by eye, but two lists against one count is arithmetic done in
       *  the head of somebody reading a report during an incident. */
      listed: number;
      lamports: string;
      sol: number;
    };
  };
  /** The brake's verdict, in the unit it decides in AND in the unit the question was asked in. The
   *  owner's question is "how much SOL a day", so a reader should not have to multiply by
   *  `roundsPerDay` and divide by 1e9 to answer it — that arithmetic done in somebody's head at 3am
   *  is where a factor of a thousand comes from. */
  burn: {
    armed: boolean;
    tripped: boolean;
    /** How many samples exist, against how many are needed to arm. Published so the operator
     *  watching the first hour can see the brake approaching its opinion rather than wondering
     *  whether it is broken. */
    samplesObserved: number;
    armAfterSamples: number;
    /** How many the mean was taken over, against the configured window. */
    samplesInWindow: number;
    windowSamples: number;
    meanLamportsPerRound: string | null;
    /** THE THREE FIGURES THAT NEED A RATE, AND THEY ARE NULL TOGETHER. Each one is a per-round
     *  quantity multiplied by `roundsPerDay`, so none of them can be stated before the keeper has
     *  MEASURED that rate — see `summariseReclamation` for why an unmeasured rate is not zero. They
     *  null as a set rather than one at a time, because a reader given two of the three would simply
     *  reconstruct the missing one. */
    solPerDay: number | null;
    thresholdLamportsPerRound: string;
    thresholdSolPerDay: number | null;
    roundsPerDay: number | null;
  };
  operator: { lamports: string | null; sol: number | null };
  /** THE ONE NUMBER THIS WHOLE ENDPOINT IS FOR: the operator balance divided by the observed daily
   *  burn. Null rather than `Infinity` when the burn is zero, negative or unknown — see
   *  `summariseReclamation` for the argument. */
  runwayDays: number | null;
}

/**
 * Build the report.
 *
 * `runwayDays` IS NULL RATHER THAN INFINITE ON A NON-POSITIVE OR UNKNOWN BURN, and the reason is not
 * fastidiousness about IEEE754. `JSON.stringify(Infinity)` emits `null` anyway, so the choice is
 * between a null that was decided and a null that arrived by accident through a serializer — and only
 * one of those is a thing the reader can trust. The alternative of clamping to a huge finite number
 * is worse: a healthy arena reporting "runway: 1e308 days" is noise that a reader has to learn to
 * ignore, and a field a reader has learned to ignore is a field that will not be read on the day it
 * says something. "runway: null" beside "meanLamportsPerRound: -4210" is honest — the arena took more
 * in than it paid out over that window, which happens on any window containing a top-up, and no
 * number of days is the right answer to it.
 *
 * IT IS COMPUTED FROM THE OBSERVED MEAN WHETHER OR NOT THE BRAKE IS ARMED. "This is what you are
 * spending right now" is true and useful in the first hour, which is exactly when somebody is
 * watching; `armed: false` sitting beside it says the brake will not ACT on the same number, which is
 * a different question and is answered separately.
 *
 * A NON-POSITIVE `roundsPerDay` MEANS NOBODY HAS MEASURED THE RATE YET, AND A RATE NOBODY HAS MEASURED
 * IS NOT ZERO. The keeper measures it from its own opens and has no honest value until it has seen two
 * of them, so it says so with a non-positive number — and multiplying by that would print
 * "0.00 SOL/day" beside a keeper that has opened one round, which is exactly the confidently-wrong
 * number this repo keeps deleting. Every figure that needs the rate is null in that case, on the same
 * argument `runwayDays` is null rather than infinite: a null that was decided is a thing a reader can
 * trust, and a plausible zero in a report about burn is worse than a blank.
 */
export function summariseReclamation(
  state: ReclamationState,
  thresholdLamports: number,
  armAfter: number,
  windowSamples: number,
  roundsPerDay: number,
): ReclamationReport {
  const verdict = burnBrake(state.burnSamplesLamports, thresholdLamports, armAfter, windowSamples);

  // PRICED OFF THE TOTALS, NEVER OFF THE LIST LENGTHS. The lists are bounded samples; see
  // `ReclamationState.closer`. Counting the sample would understate the loss precisely when it is
  // largest, which is the one moment this endpoint exists for.
  const skippedRounds = state.closer.skippedTotal;
  const skippedLamports = skippedRounds * ROUND_RENT_LAMPORTS;
  const strandedRounds = state.closer.strandedNeverTerminalTotal + state.closer.strandedStillDelegatedTotal;
  const strandedLamports = strandedRounds * ROUND_RENT_LAMPORTS;

  const meanLamports = verdict.meanLamportsPerRound;
  // See the doc comment: a rate the caller has not measured is reported as absent, not as zero.
  const rateIsMeasured = roundsPerDay > 0;
  const burnLamportsPerDay = meanLamports === null || !rateIsMeasured
    ? null
    : meanLamports * roundsPerDay;

  return {
    observedAtSec: state.observedAtSec,
    sweepGap: sweepGapOf(state.arena),
    arena: state.arena === null ? null : {
      roundCounter: state.arena.roundCounter,
      roundsSwept: state.arena.roundsSwept,
      polledAtSec: state.arena.polledAtSec,
      pollAgeSec: state.observedAtSec - state.arena.polledAtSec,
    },
    closer: {
      cursor: state.closer.cursor,
      reclaimed: state.closer.reclaimed,
      skipped: {
        rounds: [...state.closer.skipped],
        count: skippedRounds,
        listed: state.closer.skipped.length,
        lamports: lamportString(skippedLamports),
        sol: sol(skippedLamports),
      },
      stranded: {
        neverTerminal: [...state.closer.strandedNeverTerminal],
        stillDelegated: [...state.closer.strandedStillDelegated],
        count: strandedRounds,
        listed: state.closer.strandedNeverTerminal.length + state.closer.strandedStillDelegated.length,
        lamports: lamportString(strandedLamports),
        sol: sol(strandedLamports),
      },
    },
    burn: {
      armed: verdict.armed,
      tripped: verdict.tripped,
      samplesObserved: state.burnSamplesLamports.length,
      armAfterSamples: armAfter,
      samplesInWindow: verdict.samples,
      windowSamples,
      meanLamportsPerRound: meanLamports === null ? null : lamportString(meanLamports),
      solPerDay: burnLamportsPerDay === null ? null : sol(burnLamportsPerDay),
      thresholdLamportsPerRound: lamportString(thresholdLamports),
      thresholdSolPerDay: rateIsMeasured ? sol(thresholdLamports * roundsPerDay) : null,
      roundsPerDay: rateIsMeasured ? roundsPerDay : null,
    },
    operator: {
      lamports: state.operatorLamports === null ? null : lamportString(state.operatorLamports),
      sol: state.operatorLamports === null ? null : sol(state.operatorLamports),
    },
    runwayDays: runwayDays(state.operatorLamports, burnLamportsPerDay),
  };
}

/** THE HEALTH METRIC, and the one place in this file where "null" and "zero" must not be confused. A
 *  treasury that has never been read and a treasury that is perfectly caught up both look like
 *  nothing has gone wrong; only one of them is evidence. */
function sweepGapOf(arena: ReclamationState["arena"]): number | null {
  if (arena === null || arena.roundsSwept === null) return null;
  return arena.roundCounter - arena.roundsSwept;
}

/** Days of runway, or null. See `summariseReclamation` for why this is not `Infinity`. */
function runwayDays(operatorLamports: number | null, burnLamportsPerDay: number | null): number | null {
  if (operatorLamports === null || burnLamportsPerDay === null) return null;
  if (!(burnLamportsPerDay > 0)) return null;
  const days = operatorLamports / burnLamportsPerDay;
  return Number.isFinite(days) ? round(days, 2) : null;
}

/** A lamport quantity as the payload carries it: whole lamports, decimal, as a string. See
 *  `ReclamationReport` for why every one of them is a string and why the rule has no exceptions. */
function lamportString(lamports: number): string {
  return String(Math.round(lamports));
}

/** Lamports as SOL, to six places — micro-SOL, which is three orders finer than any figure in this
 *  report is accurate to and still short enough to read at a glance. */
function sol(lamports: number): number {
  return round(lamports / LAMPORTS_PER_SOL, 6);
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * The report as bytes, pretty-printed with a trailing newline.
 *
 * ONE SERIALIZER, HERE, for the same reason `statusFile.ts` insists on one: the module that owns the
 * shape owns how it is written, and a caller that builds its own `JSON.stringify` call is a second
 * opinion about formatting that will drift from this one silently. Pretty-printed because the entire
 * audience for this endpoint is somebody `curl`ing it during an incident, and a single line of
 * minified JSON is a diagnostic nobody can use.
 */
export function serializeReclamationReport(report: ReclamationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
