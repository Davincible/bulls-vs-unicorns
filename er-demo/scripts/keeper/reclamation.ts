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
// Neither one subsumes the other, so the report carries both. That is not redundancy; they fail in
// different directions.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// BOTH WITNESSES ARE NOW WIRED TO A STOP, AND THE SECOND ONE EXISTS BECAUSE THE FIRST HAS NO MEMORY
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// This used to end "and the brake is wired to the one that cannot be fooled", with `burnBrake` the
// only thing that could stop the arena. That was correct about which measurement is harder to fool
// and wrong about what a safety device has to do first, which is EXIST WHEN THE FAILURE HAPPENS.
//
// The brake's ring is process memory. It needs `armAfter` samples — 45 rounds, ~2.6 hours — and a
// restart empties it, so every deploy, every crash and every Fly machine migration buys the arena
// another 2.6 unprotected hours. That is not a hypothetical: after two restarts on the day this was
// written the live endpoint read `armed: false, samplesObserved: 0 of 45` while the arena ran at
// ~430 rounds/day, which is the exact window in which the failure being guarded against costs
// ~9.96 SOL/day against a 14.9 SOL balance — about thirty-six hours to empty.
//
// `sweepGapStop` needs almost no history. Its measurement is a subtraction between two numbers the
// chain itself maintains, so it is right on the first successful treasury poll — within
// `TREASURY_POLL_SECONDS` of boot, rather than within 2.6 hours of it. It answers the narrower
// question, and a narrow answer available immediately is worth more than a complete one that arrives
// after the balance is gone. The two are complements in TIME as well as in what they can be fooled
// by: the sweep gap covers the window the brake cannot see into, and the brake covers the failures a
// sweep gap of zero is compatible with.
//
// "ALMOST" IS THE ALLOWANCE BELOW, AND THE HONEST VERSION OF THIS CLAIM IS WORTH THE EXTRA LINES.
// The stop subtracts the rounds the CLOSER has proved unsweepable, and that ledger is process memory
// exactly like the brake's ring — empty on every boot, refilled by re-walking history. The difference
// is that THIS STOP NEVER STOPS DECIDING WHILE ITS MEMORY REFILLS. The brake genuinely has no opinion
// until it has 45 samples, which is 45 ROUNDS and ~2.6 hours, whatever else happens. This one keeps
// comparing throughout: while the ledger is still filling it simply grants the largest allowance it
// could ever owe — the cap — and asks whether the gap is wide enough to trip anyway.
//
// THAT WAS A CORRECTION, AND IT IS THE MOST IMPORTANT LINE IN THIS HEADER. The first version refused
// to trip at all until the walk finished, which reads as the careful choice and is not one: the walk
// is finished by the CLOSER, and the closer is the component whose failure this stop exists to catch.
// One round below the retention boundary that cannot be read wedges the cursor there permanently, and
// under that design the sweep-gap stop was disabled for the life of the process. A safety device
// whose arming condition depends on the thing it is watching is not a safety device.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND THE SWEEP GAP IS NOT THE RAW SUBTRACTION ANY MORE, BECAUSE SOME ROUNDS CAN NEVER BE SWEPT
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `round_counter - rounds_swept` counts every unswept round, including the ones no instruction on
// chain could ever sweep — a round wedged before a terminal phase, or a terminal round the Delegation
// Program still owns. Those never come out of the subtraction. Each one permanently spends a round of
// the twenty-four between a healthy gap of 1 and a stop at 25, and the live arena has already spent
// one on round #295. Left alone, this stop eventually latches a perfectly healthy arena for no reason
// but arithmetic — the false positive that is worse than no brake, arriving on a schedule.
//
// So the stop compares `gap - allowance`, where the allowance is the rounds the CLOSER HAS PROVED are
// unsweepable, capped — and, until the closer has walked this arena's history once, replaced by a
// provisional grant of that same cap rather than waited for. `sweepGapStop` below owns all three and
// argues each; `STRANDED_ALLOWANCE_ROUNDS` in `config.ts` owns the cap's number. The one thing worth
// carrying up here is the shape of the mistake being avoided: an allowance with no ceiling would file
// a total stranding outage as an excuse and never fire at all.

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
    /** IS THE CLOSER RUNNING AT ALL? `--close-rounds` and the IDL's `close_round_account` together,
     *  as the keeper resolved them at boot.
     *
     *  IT IS HERE BECAUSE THE SWEEP-GAP STOP'S ALLOWANCE IS BUILT OUT OF WHAT THE CLOSER FOUND, and a
     *  keeper with no closer finds nothing — forever, on a healthy arena and on a broken one alike.
     *  Without this field `strandedLedgerIsComplete` would read "this process has never caught up"
     *  about a cursor that is never going to move, and would provision the full allowance for the life
     *  of the process — 25 rounds of headroom handed to the one keeper that is reclaiming nothing at
     *  all. See that function; this is the first of its two terms and the only one that is a
     *  configuration rather than an observation. */
    closing: boolean;
    /** HAS THE CLOSE CURSOR REACHED THE RETENTION BOUNDARY AT LEAST ONCE IN THIS PROCESS? A LATCH the
     *  keeper sets and never clears, not a live comparison — `KeeperContext.closeCursorCaughtUp` owns
     *  the argument, and it is the whole reason this crosses the boundary as an observation rather
     *  than being derived here from `cursor` and a retention window.
     *
     *  IN ONE LINE: asking "is the cursor past the boundary NOW" is the exact complement of
     *  `isPastRetention`, and a cursor wedged below the boundary is the STEADY STATE OF A SWEEP
     *  OUTAGE — so the live question calls the fault "still rebuilding" for the length of the fault. */
    caughtUpOnce: boolean;
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
  /** ONE SAMPLE PER ROUND, NEWEST LAST, AND EACH ONE IS A DIFFERENCE RATHER THAN A BALANCE: the net
   *  lamports the previous round cost, taken between two consecutive `open_round` readings of the
   *  operator wallet. `burnBrake` averages these directly, so a field holding the readings themselves
   *  would report a mean balance as a mean burn.
   *
   *  CAPPED AT `BURN_ARM_AFTER_ROUNDS`, WHICH IS NOT THE WINDOW THE MEAN IS TAKEN OVER, and this line
   *  used to name the other one. That is not a typo with a cosmetic cost. `burnBrake` arms on
   *  `samples.length >= armAfter` and only then averages the last `windowSamples`, so a ring capped at
   *  the WINDOW — `BURN_SAMPLE_ROUNDS`, the smaller number — can never reach the arming threshold and
   *  the brake never forms an opinion at all. Nothing would say so: the report shows `armed: false`
   *  beside a sample count that has silently stopped growing, which is what a young arena also looks
   *  like. Naming the wrong constant HERE is the dangerous direction, because this is the interface the
   *  keeper fills in — anyone reconciling the two would shrink the keeper's ring to match this doc and
   *  disable the brake while tidying. `recordBurnSample` below owns the cap; fill this field with it. */
  burnSamplesLamports: number[];
  /** IS THE KEEPER DELIBERATELY NOT TAKING SAMPLES RIGHT NOW? An OBSERVATION handed over like every
   *  other field here — this module does not decide it, it reports it.
   *
   *  IT EXPLAINS A READING THAT OTHERWISE LOOKS BROKEN AND IS NOT. The keeper suspends sampling while
   *  its close cursor is still walking rounds it has already closed, because across such a round no
   *  `close_round_account` runs and the balance difference is rent leaving with nothing returning —
   *  4.8x the brake's ceiling, on a healthy arena. `KeeperContext.closeCatchUpAhead` in keeper.ts owns
   *  the predicate and the argument that it cannot hide a real outage.
   *
   *  WITHOUT IT THE REPORT WOULD SAY `armed: false, samplesObserved: 0 of 45` AND STOP, which is
   *  indistinguishable from a young arena and from a keeper that has just restarted — and this
   *  endpoint's entire audience is somebody reading it during an incident. `BurnVerdict.armed`'s own
   *  doc already names that ambiguity and points at `samplesObserved` to resolve it; this is the third
   *  state that count cannot separate on its own, so it is stated rather than left to be inferred.
   *
   *  IT DOES NOT DISARM ANYTHING. `sweepGapStop` needs no samples — see this file's header on why the
   *  two witnesses are complements in TIME as well as in what they can be fooled by. This is the
   *  window the sweep gap already covers.
   *
   *  IT IS THE ONLY SUSPENSION IN THIS FILE, AND THAT IS WORTH SAYING BECAUSE THERE WAS NEARLY A
   *  SECOND. The sweep-gap stop's stranded allowance also depends on the closer having finished
   *  walking, and it was briefly written to withhold the stop until it had — which
   *  `strandedLedgerIsComplete` now argues at length was wrong, because that stop's whole value is
   *  being right immediately and a keeper whose closer is wedged would never have released it. It
   *  grants a bounded allowance instead and never stops deciding.
   *
   *  THIS SUSPENSION IS DIFFERENT IN THE ONE WAY THAT MATTERS: what it withholds is a SAMPLE, not a
   *  verdict, and the brake it feeds has no opinion for its first 45 rounds anyway. Withholding
   *  evidence from an instrument that is not yet armed costs nothing; withholding a verdict from the
   *  instrument that is armed costs everything. `closeCatchUpAhead` also clears the moment the cursor
   *  touches any living round, which is early — right for a sample, far too early to have concluded
   *  that a LEDGER is finished. Two mechanisms, one window, deliberately not one predicate. */
  burnSamplingSuspended: boolean;
  operatorLamports: number | null;
  /** Chain second at which the SWEEP-GAP STOP first latched in this process, or null while it has
   *  not. An OBSERVATION the keeper hands over, exactly like every other field here — this module
   *  does not own the latch, it reports it and it honours it.
   *
   *  IT IS AN INPUT TO THE VERDICT AND NOT ONLY TO THE REPORT, which is the whole reason it crosses
   *  this boundary rather than staying in `keeper.ts`. `sweepGapStop` takes the latch and returns it
   *  back out as `tripped`, so the stop's own "once stopped, stay stopped" rule is a property of a
   *  pure function that a test can execute, instead of two lines inside `openNextRound` that only a
   *  keeper and a devnet could ever reach. `recordBurnSample` was extracted from that same function
   *  for that same reason and its doc comment prices what leaving it there cost. */
  sweepStoppedSinceSec: number | null;
}

// ---------------------------------------------------------------------------------------------
// The brake
// ---------------------------------------------------------------------------------------------

/**
 * ONE SAMPLE INTO THE RING THE BRAKE READS — newest last, oldest dropped once the ring is `cap` long.
 *
 * IT IS A FUNCTION BECAUSE THE CAP IS LOAD-BEARING AND WAS UNREACHABLE WHERE IT LIVED. This was two
 * lines of push-and-shift inside the keeper's `openNextRound`, between a balance read and a
 * transaction send, where nothing can exercise it without a chain. Every plausible slip there is
 * silent and permanent: the wrong constant disarms the brake forever (see
 * `ReclamationState.burnSamplesLamports`), `pop` for `shift` averages a run's OLDEST rounds — the
 * pre-turnover ones that legitimately read as a total outage — and `<` for `>` grows the ring without
 * bound. Not one of those three fails a test, throws, or shows up in the report. Given a name, all
 * three are swept in `reclamation.test.ts`.
 *
 * PURE, RETURNING A NEW ARRAY, in a file whose whole discipline is that every judgement in it can be
 * run on its own. Mutating the caller's array would save one 45-element allocation per round — once
 * every ~204 seconds, which is not a cost worth an argument — and would make "does it keep the
 * newest" and "did the caller happen to be holding an alias" the same test.
 *
 * A NON-POSITIVE `cap` KEEPS NOTHING, which is the direction every degenerate case in this file
 * takes. `burnBrake` refuses to arm on a non-positive `armAfter`, and an empty ring cannot arm it
 * either, so a misconfigured brake stays open rather than stopping an arena that was working.
 */
export function recordBurnSample(samples: readonly number[], lamports: number, cap: number): number[] {
  if (cap <= 0) return [];
  return [...samples, lamports].slice(-cap);
}

export interface BurnVerdict {
  /** Enough samples to have an opinion at all — `samplesObserved >= armAfter`. While this is false the
   *  mean below is usually still reported, and when reported it is still true; nothing may act on it.
   *  NOT ALWAYS REPORTED, THOUGH, which is the correction to what this used to claim: three states null
   *  the mean outright rather than merely disqualifying it — no sample yet, a non-positive
   *  `windowSamples`, and a window holding a non-finite sample. All three also leave this false, so
   *  `armed: false` beside a null mean does not distinguish a young arena from a misconfigured brake.
   *  `samplesObserved` in the report is what separates them. */
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
// The other stop — the one that is armed the instant the process starts
// ---------------------------------------------------------------------------------------------

export interface SweepGapVerdict {
  /** `Arena.round_counter - Treasury.rounds_swept` as of the last poll, or null when it cannot be
   *  COMPUTED — no poll has landed, or this program has no Treasury account. Null is never a gap of
   *  zero; see `sweepGapOf`.
   *
   *  THE RAW SUBTRACTION, AND NOT WHAT THE STOP COMPARES. It counts every unswept round including the
   *  ones no instruction could ever sweep. `effectiveGap` is the one wired to the decision. */
  gap: number | null;
  /** HOW MANY ROUNDS OF THE GAP WERE EXCUSED as structurally unsweepable — already capped at
   *  `strandedAllowanceRounds`, so this is what was actually subtracted and never what was claimed.
   *
   *  IT IS THE WHOLE CAP — CLAMPED BY THE GAP — RATHER THAN THE RECORDED LEDGER WHILE `ledgerComplete`
   *  IS FALSE. The keeper has not finished finding the rounds this is made of, so it grants the most
   *  it could ever owe instead of the little it has counted. See `sweepGapStop`. */
  allowance: number;
  /** Did the closer record MORE unsweepable rounds than the cap allows? The allowance is pinned at the
   *  cap from here on, so every further stranded round spends a round of this stop's headroom exactly
   *  as it did before the allowance existed. It is the operator's warning that the arena is walking
   *  back toward the defect this mechanism removed — see `sweepGapStop` on why the cap has to exist. */
  allowanceCapped: boolean;
  /** HAS THE CLOSER FINISHED FINDING THE ROUNDS THE ALLOWANCE IS MADE OF? False until this process's
   *  close cursor has reached the retention boundary at least once — normally the first seconds of a
   *  run, and indefinitely for a keeper whose cursor is wedged on a round it cannot get past.
   *
   *  IT CHANGES WHAT `allowance` IS, AND NOTHING ELSE. The stop keeps deciding on every pass in either
   *  state — this is not a suspension, for the reason `strandedLedgerIsComplete` gives at length: the
   *  thing that would have had to end a suspension is the closer, which is the component whose failure
   *  this stop exists to catch. False here means the allowance is the full cap rather than a count. */
  ledgerComplete: boolean;
  /** THE ROUNDS THAT SHOULD HAVE BEEN SWEPT AND WERE NOT — `gap - allowance`, and the only number in
   *  here the stop compares against its threshold.
   *
   *  IT IS NOT CLAMPED AT ZERO AND THAT IS DELIBERATE. A negative value means the allowance exceeded
   *  the gap, which is the one visible symptom of the allowance over-counting — a stranded round that
   *  the chain nonetheless recorded as swept (see `sweepGapStop` on why a still-delegated round is
   *  taken to be unswept). Clamping would delete the only evidence of the one way this arithmetic can
   *  be too generous, and a negative number cannot trip anything. */
  effectiveGap: number | null;
  tripped: boolean;
}

/**
 * HAS SWEEPING FALLEN SO FAR BEHIND THAT RENT HAS STOPPED COMING BACK? — the second safety stop, and
 * the one whose measurement is right on the first poll rather than after 45 rounds of samples.
 *
 * `sweep_house_take` is the PRECONDITION of `close_round_account`: the chain refuses a close on an
 * unswept round (`RoundNotSwept`), because the round account is the only place that round's fees and
 * penalties are recorded and closing it unswept would forfeit them silently. So a keeper that stops
 * sweeping stops reclaiming, whatever else is working, and the ~0.0235 SOL each round parks stops
 * coming back at exactly the rate rounds are opened.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE GAP IS THE RIGHT INSTRUMENT, AND WHAT IT IS NOT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `rounds_swept` is a COUNT and not a watermark, and lib.rs argues that choice at length beside the
 * field: a watermark (`sweep round n only if n == swept + 1`) would prove the total was COMPLETE,
 * and was rejected on liveness, because one round that can never be swept would block every later
 * round's fees forever. A count makes one stuck round cost exactly one stuck round.
 *
 * TWO CONSEQUENCES FOLLOW FROM THAT AND BOTH MATTER HERE.
 *
 * The good one: a backlog DRAINS. `closeOneFinishedRound`'s `sweep-first` branch sweeps any terminal
 * unswept round the close cursor walks onto — at least two idle passes each, and none at all during
 * `Drawing` or `Fight` — so twenty-five rounds clear in well under a minute of idle passes. A gap
 * still past the threshold a whole round later is not a queue being worked off; it is one that has
 * stopped.
 *
 * THAT FALLBACK IS ITSELF RETENTION-GATED, WHICH IS THE REGIME THIS STOP IS TIGHTEST IN. The cursor
 * never looks at a round newer than `ROUND_RETENTION`, so a round whose SETTLE-TIME sweep missed
 * (`driveSettled`, the only prompt sweeper) waits twenty rounds for the fallback and contributes 1 to
 * the gap throughout. Consistent settle-sweep failure therefore parks the gap at ~21 on an arena that
 * is losing nothing — the rent could not have come back before the retention boundary in any case.
 * `SWEEP_GAP_STOP_ROUNDS` in `config.ts` owns that argument and the decision to stay at 25 through it.
 *
 * The bad one, and it used to be the standing caveat on this whole mechanism: THE RAW GAP HAS A
 * PERMANENT FLOOR EQUAL TO THE NUMBER OF ROUNDS NOTHING CAN EVER SWEEP. Sweeping requires `Settled`
 * or `Abandoned` and an account the program can read, so a round wedged in `Lobby` or in the
 * `Drawing` hole `abandon_round` documents, and a terminal round the Delegation Program still owns,
 * can never be swept and their units of gap never come back. Each one permanently spent one round of
 * the headroom between healthy and the stop. That caveat is now a mechanism, and the rest of this
 * comment is it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ALLOWANCE — WHY THE STOP MEASURES `gap - allowance` AND NOT `gap`
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * IT WAS OBSERVED, NOT PREDICTED, AND IT IS ALREADY COSTING HEADROOM. Round #295 of the live arena is
 * terminal and still owned by the Delegation Program — `closeCursor.ts`'s header records finding it,
 * alone among 612 closed rounds, on 2026-08-19. Nothing can sweep it and nothing can close it, so
 * `rounds_swept` can never catch `round_counter` again: the live endpoint reads `roundCounter 669,
 * roundsSwept 667`, a gap of 2 where "healthy is 1" and a 2 that will never be a 1. Twenty-three
 * rounds of headroom are left. Every future permanently stranded round takes another, and when they
 * are gone this stop latches a perfectly healthy arena — the false positive `burnBrake`'s own doc
 * calls worse than having no brake, arriving on its own schedule with nothing to trigger it.
 * ARENA-VAULT.md §5.1 names it as a custody prerequisite and §8.1 files it as S0.
 *
 * SO THE QUESTION THE STOP ASKS IS NARROWED TO THE ONE IT ACTUALLY CARES ABOUT: not "how many rounds
 * are unswept" but "how many rounds SHOULD HAVE BEEN SWEPT AND WERE NOT". The difference is exactly
 * the rounds the closer has proved no instruction can sweep, and the closer already counts them —
 * `closer.stranded` in this same report, recorded by `closeOneFinishedRound` as it walks past them.
 *
 * ONLY THE TWO STRANDED LEDGERS COUNT, AND `skipped` DELIBERATELY DOES NOT. A skipped round is one
 * `close_round_account` failed on `CLOSE_ATTEMPTS_PER_ROUND` times — and `decideClose` sends
 * `sweep-first` before it ever reaches a close, so a round that got as far as being skipped WAS
 * SWEPT. It is already inside `rounds_swept`, it contributes nothing to the gap, and excusing it
 * would subtract a round from the gap that was never in it. That is the one way this arithmetic
 * could quietly hand out free headroom, so it is written down rather than left to the shape of the
 * code.
 *
 * A STILL-DELEGATED ROUND IS TAKEN TO BE UNSWEPT, WHICH IS A JUDGEMENT AND NOT A CERTAINTY.
 * `sweep_house_take` writes the base-layer `Treasury`, and the only prompt sweeper (`driveSettled`)
 * runs after a round has come home from the ER — a round that never came home was never swept. The
 * live numbers agree: one stranded round, one round of gap above healthy. If it were ever wrong the
 * allowance would exceed the gap and `effectiveGap` would go NEGATIVE, which is published rather
 * than clamped precisely so that the one over-generous case has a symptom.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE CAP — BECAUSE AN UNBOUNDED ALLOWANCE IS THE OUTAGE FILED AS AN EXCUSE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * THE FAILURE TO DEFEND AGAINST IS NOT AN ARITHMETIC SLIP, IT IS A MISCLASSIFICATION. A MagicBlock
 * validator that stops returning rounds strands every round in flight — ARENA-VAULT §5.1's own
 * scenario — so a total outage arrives as a PILE OF STRANDED ROUNDS growing at one per round. Against
 * an uncapped allowance the gap and the excuse grow together and the difference between them never
 * moves. Worked through: the closer cannot record a round until the cursor reaches it and the cursor
 * never looks inside `ROUND_RETENTION`, so the allowance trails the gap by exactly twenty rounds and
 * the effective gap PLATEAUS AT 21 — four short of the stop, forever, while the arena strands
 * 0.023497 SOL a round at ~430 rounds/day. That is COST-MODEL §4's ~10 SOL/day, reported as a
 * healthy effective gap of 21. An allowance with no ceiling is not a safety device with a caveat; it
 * is the brake wired to the accelerator.
 *
 * SO THE ALLOWANCE IS CAPPED AT `strandedAllowanceRounds`, and past the cap every further stranded
 * round spends headroom exactly as it did before this mechanism existed. `STRANDED_ALLOWANCE_ROUNDS`
 * in `config.ts` owns the number (25) and the trade: it doubles what a healthy arena can absorb
 * before this stop needs a human (from 24 permanently dead rounds to 49), and it bounds the worst
 * case at `stopAtGapRounds + cap` ≈ 50 rounds of a total outage — ~2.8 hours and ~1.17 SOL, against
 * ~25 rounds and ~0.59 SOL with no allowance at all. That half-SOL is the price of not stopping a
 * healthy arena, and 50 rounds beside `BURN_ARM_AFTER_ROUNDS`'s 45 means that even in its worst case
 * the two witnesses form their opinions at about the same moment rather than this one arriving after
 * the stop it was built to precede.
 *
 * REJECTED: A RATE. "At most N stranded rounds per day" is the natural-looking bound and it is
 * exactly wrong here, because the rate that matters is per ROUND OF HISTORY and the clock is what
 * breaks on restart: a keeper that has just booted re-walks and re-discovers years of legitimate
 * stranding in a couple of minutes, which every wall-clock rate limiter on earth reads as a flood.
 * It would refuse the true allowance at exactly the moment the allowance is needed. The retention
 * lag above is already a rate limiter that costs nothing and cannot be fooled by a restart — it is
 * what makes a fast outage outrun its own excuse — and the cap is what stops a slow one hiding
 * inside it. REJECTED ALSO: a share of history ("allow 5% of the rounds walked"). It is restart-safe
 * and it grows: 5% of a 10,000-round history is a 500-round budget, so a long and healthy run would
 * buy a licence for a 11.7 SOL outage. A bound that grows with good behaviour is not a bound.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE LEDGER IS PROCESS STATE, AND A RESTART MUST NOT LOOK LIKE AN OUTAGE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `closer.stranded` lives on `KeeperContext` and starts EMPTY on every boot. The rounds it describes
 * do not: they are still stranded, still in the gap, still counted by the chain. So for the first
 * minutes of every process the raw gap is its true self and the recorded allowance is zero, and an
 * arena with twenty-four dead rounds would latch its stop on the first `open_round` after a restart —
 * a healthy arena, stopped by a number the keeper had simply not finished reading. That is the same
 * class of defect as the close-cursor walk in 9d53b99, where transient process state made a healthy
 * arena publish a 2.39-day runway and could have stopped it.
 *
 * So while the ledger is incomplete the stop GRANTS THE WHOLE CAP instead of the little it has
 * counted, and goes on deciding. It does not wait, and the reasoning for that is in the body below
 * and at length in `strandedLedgerIsComplete`: waiting would have made this stop's arming condition
 * depend on the closer, and the closer is what it is watching.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT A STALE OR MISSING POLL IS ALLOWED TO DO, DECIDED RATHER THAN INHERITED
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * THIS FUNCTION HAS NO CLOCK IN ITS SIGNATURE, AND THAT ABSENCE IS THE STATEMENT. Staleness cannot
 * enter the decision because there is nothing here to compute it from. Three separate positions,
 * each taken on purpose:
 *
 *   * A MISSING POLL IS NOT EVIDENCE. `arena === null` (nothing polled yet, or a program with no
 *     `sweep_house_take` at all) and `roundsSwept === null` (no Treasury account yet — `init_treasury`
 *     runs on the first sweep, so a young arena legitimately has none) both mean the gap cannot be
 *     computed. Not computed is not "zero" and it is certainly not "leaking": the stop stays open,
 *     which is the direction every degenerate case in this file takes.
 *   * STALENESS CANNOT MANUFACTURE A GAP, because `pollTreasury` stores BOTH terms together and takes
 *     the counter FIRST. This is the failure that would have mattered: a fresh `round_counter`
 *     differenced against a stale `rounds_swept` would grow without bound purely from a telemetry read
 *     failing, and would stop the arena over a problem that was never about money. What actually
 *     protects against it is that `ctx.treasury` is replaced as a whole or not at all — a failed poll
 *     leaves the previous PAIR standing, so an ageing reading freezes rather than drifts.
 *
 *     THE TWO READS ARE NOT LITERALLY SIMULTANEOUS AND THE DIRECTION OF THAT SKEW IS THE POINT.
 *     `roundCounter` comes from the pass's chain state, read before the awaited `fetchTreasury()`, so
 *     the counter term is always the OLDER of the two. The gap can therefore only be UNDER-reported,
 *     never over-reported, which is the safe direction for a number wired to a stop. Anyone reordering
 *     those two reads inverts that, silently, into a stop that can fire on skew alone.
 *   * A STALE READING THAT IS ALREADY PAST THE THRESHOLD STILL TRIPS, and this is the one that was a
 *     genuine choice. REJECTED: gating the trip on `pollAgeSec` below some ceiling. It buys almost
 *     nothing — every reading is evaluated while fresh (the poll runs every 30s, the stop is asked
 *     once per ~200s round) so a gap this large has already been seen at age ~0 and has already
 *     latched — and it costs the one case where it would have acted: a correlated failure in which
 *     the treasury read and the sweeps break together, where the gate would disable the stop
 *     precisely when the fire started. A frozen reading of 25+ also cannot decay into a false alarm
 *     on any timescale that matters: it would take 24 sweeps landing unseen, which is 24 rounds,
 *     which is ~80 minutes of the poll failing while transactions succeed. `pollAgeSec` is published
 *     beside the gap so a human can see how old the evidence was; it is not a veto over it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE LATCH IS AN ARGUMENT, NOT A FLAG
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `burnBrake` latches by accident of physics: samples are taken at `open_round`, a stopped keeper
 * opens nothing, so the mean freezes at the value that tripped it and the stop cannot clear itself.
 * THIS ONE HAS NO SUCH LUCK AND THE DIFFERENCE IS DANGEROUS. The treasury keeps being polled while
 * the keeper is stopped, and `round_counter` freezes while `rounds_swept` can still rise as the
 * closer drains what it can — so the gap SHRINKS on its own after the stop, and a verdict recomputed
 * from the gap alone would clear, reopen the arena, let the gap climb again, and trip again. An
 * arena flapping between stopped and spending is not a safety device; it is the leak with a duty
 * cycle.
 *
 * So the latch is an INPUT — `state.sweepStoppedSinceSec`, the keeper's own record of when it fired —
 * and the rule is unconditional: once stopped, stopped for the life of the process, whatever the gap
 * does afterwards and whatever the configuration says. It is deliberately not conditioned on
 * `stopAtGapRounds` being sane either — a latch that a misconfiguration could release would not be a
 * latch — and, since the allowance arrived, not on the ledger either: that number keeps GROWING after
 * the stop fires, because the closer goes on walking while the keeper is stopped, so an allowance
 * that turned up a minute late would otherwise release a stop that had already fired. Clearing it is
 * a person: read this report, work out which rounds
 * stopped being swept and why, fix it, restart. `rentIsComingBack` in keeper.ts makes the same
 * argument for the same reason — a restart is not a workaround here, it is the assertion that
 * somebody looked.
 *
 * `>=` RATHER THAN `burnBrake`'S STRICT `>`, and the two are right for different reasons rather than
 * inconsistent. The brake compares a MEAN — a continuous quantity where "exactly at the ceiling" is
 * a real state in which nothing has gone wrong yet, so the ceiling has to be crossed. This compares
 * a COUNT OF ROUNDS. There is no fractional round between 24 and 25; reaching the count IS the
 * event, and `>` would simply mean a stop at 26 written as 25.
 *
 * IT TAKES THE WHOLE OBSERVED STATE RATHER THAN THREE ARGUMENTS, and the latch comes out of it
 * rather than beside it. The stop now reads the closer's ledger as well as the treasury poll, and
 * `summariseReclamation` and `sweepIsKeepingUp` in keeper.ts must be asking about the same keeper —
 * a stop that judged one set of observations while the endpoint rendered another would publish a
 * report that disagreed with the decision it was written to explain. One record built by one
 * function (`reclamationStateOf`) makes that unrepresentable rather than merely unlikely, which is
 * the argument `ReclamationThresholds` already makes about positional numbers.
 */
export function sweepGapStop(state: ReclamationState, thresholds: ReclamationThresholds): SweepGapVerdict {
  const { stopAtGapRounds, strandedAllowanceRounds } = thresholds;
  const gap = sweepGapOf(state.arena);

  // PRICED OFF THE TOTALS, NEVER OFF THE LIST LENGTHS — `ReclamationState.closer` argues it for the
  // report and the argument is sharper here, because this decides. The lists are capped at
  // `CLOSE_LOSS_SAMPLE` (50); an allowance read off them would silently stop growing at fifty and
  // this stop would start spending headroom again with every published number still agreeing.
  const stranded = wholeCount(state.closer.strandedNeverTerminalTotal)
    + wholeCount(state.closer.strandedStillDelegatedTotal);
  // A CAP THAT CANNOT BE READ EXCUSES NOTHING. Every other degenerate case in this file leaves the
  // stop OPEN, and this one is the exception that proves the rule rather than a break in it: those
  // protect against a misconfigured safety device firing on a healthy arena, and this is not the
  // device — it is the allowance that WEAKENS it. A weakening derived from a number nobody can read
  // is applied at zero, which is exactly the behaviour that shipped before it existed. `config.ts`
  // refuses a negative or fractional value at module load, so this is the second of two lines.
  const cap = Number.isFinite(strandedAllowanceRounds) && strandedAllowanceRounds > 0
    ? Math.floor(strandedAllowanceRounds)
    : 0;
  const ledgerComplete = strandedLedgerIsComplete(state.closer);
  // WHILE THE CLOSER IS STILL LOOKING, THE ARENA GETS THE BENEFIT OF EVERY DOUBT THAT IS STILL OPEN —
  // AND NOT ONE ROUND MORE. See `strandedLedgerIsComplete` for the window and why it exists; this
  // line is what the keeper DOES about it, and the choice of what to do here is the whole design.
  //
  // REJECTED, AND IT IS WHAT THIS CODE DID FIRST: refusing to trip at all while the ledger is
  // incomplete. It reads as the cautious option and it is the dangerous one, because "incomplete" is
  // a state a broken keeper can be stuck in — a round the closer cannot READ wedges the cursor below
  // the retention boundary with no way out, so a veto would have disabled this stop for the life of
  // that process, on the one instrument that is meant to be right immediately. A suspension whose end
  // condition depends on the closer making progress is a suspension the closer can fail to end.
  //
  // WHAT THIS DOES INSTEAD NEEDS NOTHING TO GO RIGHT. The most the ledger could still add is the cap,
  // by definition — so during a rebuild the stop assumes it WILL, grants `cap` outright, and compares
  // what is left. Nothing is suspended and nothing waits on the closer: the stop keeps deciding
  // throughout, on a number that is deliberately biased toward the arena by a bounded, published,
  // already-priced amount. A gap wide enough to trip even after the largest allowance the keeper
  // could ever grant is a gap no amount of further looking can excuse.
  //
  // AND THE WORST CASE COMES OUT UNIFORM, WHICH IS THE PROPERTY THAT MAKES IT ARGUABLE. With the
  // ledger complete a total outage trips at `stopAtGapRounds + cap` rounds because the allowance
  // saturates; with the ledger incomplete it trips at `stopAtGapRounds + cap` because the cap is
  // granted up front. Same number, ~50 rounds, whatever state the keeper is in — so the bound
  // `config.ts` argues for `STRANDED_ALLOWANCE_ROUNDS` is the bound in every case rather than in the
  // lucky one, and a keeper that never finishes its walk is simply a keeper permanently paying the
  // cap's already-argued price.
  //
  // THE PROVISION IS ALSO CAPPED BY THE GAP ITSELF, WHICH IS NOT THE SAME KIND OF CAP AND IS NOT
  // COSMETIC. You cannot excuse more rounds than are actually unswept, so granting `cap` against a gap
  // of 2 would publish `effectiveGap: -23` on a perfectly ordinary arena for the first minutes of
  // EVERY restart. That matters because a negative effective gap is a real signal — it is the one
  // visible symptom of the allowance over-counting (see `SweepGapVerdict.effectiveGap`) — and a signal
  // that fires routinely is a signal nobody reads on the day it means something. `runwayDays` refuses
  // to publish a plausible-looking number for the same reason.
  //
  // IT CHANGES NO DECISION. Where the gap is at or below the cap the stop could not have tripped
  // anyway (the whole gap might be stranded rounds); above it, `gap - cap` is what both forms give.
  // The clamp is deliberately NOT applied to the counted branch, where a negative result is exactly
  // the evidence worth keeping. A null gap decides nothing and is provisioned at zero rather than at
  // the cap, so a keeper that has not polled yet publishes an allowance it has not claimed.
  const allowance = ledgerComplete
    ? Math.min(stranded, cap)
    : Math.max(0, Math.min(cap, gap ?? 0));
  const effectiveGap = gap === null ? null : gap - allowance;
  // `cap > 0` IS PART OF THE QUESTION, not a guard against dividing by it. With the allowance turned
  // off there is no ceiling to have reached, so `capped` stays false rather than going true on the
  // first stranded round and shouting "CAPPED at 0" from the stop's own banner for the rest of the
  // run. The field means "the allowance was working and ran out", which is a thing to act on; an
  // operator who set the knob to zero already knows what they did.
  const verdict = {
    gap, allowance, allowanceCapped: cap > 0 && stranded > cap, ledgerComplete, effectiveGap,
  };

  // THE LATCH FIRST AND UNCONDITIONALLY, before the allowance can have an opinion. Once stopped,
  // stopped for the life of the process — see the block above on why this stop's input recovers on
  // its own and why a verdict recomputed from it would flap. The allowance is a live number that
  // GROWS as the closer keeps walking after the stop fires, so without this line a latched stop could
  // be released by the very ledger that was supposed to have prevented it.
  if (latchedIn(state)) return { ...verdict, tripped: true };

  // A non-positive threshold is a misconfiguration, and a misconfigured stop does nothing rather
  // than stopping everything — `burnBrake`'s asymmetry, for its reason. `config.ts` refuses such a
  // value at module load, so this is the second of the two lines that make that unreachable.
  if (effectiveGap === null || !Number.isFinite(effectiveGap) || stopAtGapRounds <= 0) {
    return { ...verdict, tripped: false };
  }
  // NO BRANCH ON `ledgerComplete` HERE, AND ITS ABSENCE IS THE CORRECTION. It has already had its
  // say — in the allowance, where it is worth a bounded number of rounds — and giving it a second
  // say here would be the veto argued against above. The stop decides on every pass in every state.
  return { ...verdict, tripped: effectiveGap >= stopAtGapRounds };
}

/** The stop's own latch, read from the keeper's record of when it fired. A function rather than the
 *  comparison written inline, because `sweepGapStop` reads it once and `summariseReclamation`
 *  publishes the underlying second, and "is it latched" must mean the same thing in both. */
function latchedIn(state: ReclamationState): boolean {
  return state.sweepStoppedSinceSec !== null;
}

/** A count from the keeper, believed only when it is a whole non-negative number. Nothing can produce
 *  anything else — these are `+= 1` counters — but they feed a SUBTRACTION from a safety threshold,
 *  and a NaN there would silently null the effective gap and open the stop. Unreadable means zero,
 *  which means no allowance, which means the stop behaves as it did before this existed. */
function wholeCount(total: number): number {
  return Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
}

/**
 * HAS THE CLOSER FINISHED FINDING THE ROUNDS THE ALLOWANCE IS MADE OF?
 *
 * THE STRANDED LEDGER IS PROCESS STATE AND THE ROUNDS IT DESCRIBES ARE NOT. After a restart the
 * keeper re-walks its history and re-discovers every stranded round — `closeCursor.ts` makes that
 * fast, a hundred rounds a pass — but for the minutes in between, the allowance is zero while the
 * gap those rounds cause is at its full size. An arena with twenty-four permanently dead rounds
 * would latch its stop on the first `open_round` of every restart, which is the same class of defect
 * as the close-cursor walk in 9d53b99: transient process state, read as a permanent fact about a
 * healthy arena.
 *
 * WHAT THIS IS AND — MORE IMPORTANTLY — WHAT IT IS NOT. It is a statement about the KEEPER'S
 * KNOWLEDGE, and the only thing that turns on it is HOW MUCH ALLOWANCE THE STOP GRANTS: the recorded
 * ledger when true, a bounded provision when false. IT IS NOT A VETO OVER THE STOP. That was the
 * first design and it was wrong in a way worth recording, because it is the more cautious-looking of
 * the two:
 *
 *   A SUSPENSION NEEDS SOMETHING TO END IT, AND THE THING THAT WOULD HAVE ENDED THIS ONE IS THE
 *   CLOSER — the same component whose failure this stop exists to catch. `closeOneFinishedRound`
 *   awaits `fetchRound` and `isDelegated` outside any `try`; `withReadRetry` rethrows once its
 *   attempts are gone. One round below the retention boundary that cannot be read wedges the cursor
 *   there permanently. Under a veto that keeper's sweep-gap stop is disabled for the life of the
 *   process, silently, on the instrument whose whole reason for existing is that the burn brake has
 *   no opinion for its first 2.6 hours. A safety device that a read failure can switch off is not a
 *   safety device.
 *
 * SO THE PREDICATE IS ALLOWED TO BE WRONG IN EITHER DIRECTION AND COST ONLY A BOUNDED NUMBER OF
 * ROUNDS, and `sweepGapStop` is where that bound is applied. Which lets it be the simplest thing that
 * is actually true — two facts the keeper already holds, no arithmetic:
 *
 *   * THE CLOSER IS NOT RUNNING. No `--close-rounds`, or an IDL with no `close_round_account`. The
 *     cursor will never move and the ledger will never fill, so there is nothing to wait for. The
 *     allowance is permanently zero in this configuration and this stop is exactly the stop that
 *     shipped before the allowance existed — correct rather than a regression: a keeper that closes
 *     nothing is not reclaiming rent at all, and is the one keeper that should be easiest to stop.
 *   * THE CURSOR HAS REACHED THE RETENTION BOUNDARY AT LEAST ONCE IN THIS PROCESS. Not "is past it
 *     now" — HAS BEEN, ever, as a latch the keeper sets and never clears
 *     (`KeeperContext.closeCursorCaughtUp`). The boundary is the newest round the closer will ever
 *     look at, so reaching it once means every round that could be stranded has been decided about.
 *
 * WHY THE LATCH AND NOT THE LIVE COMPARISON, WHICH IS THE MISTAKE THIS REPLACED AND THE MOST
 * EXPENSIVE ONE IN THIS FILE'S HISTORY. `cursor + retention > roundCounter` needs no state, reads as
 * obviously correct, and is the exact complement of `isPastRetention` — so it answers "not finished"
 * whenever the cursor is behind, FOR ANY REASON. And a cursor wedged below the boundary is the steady
 * state of a sweep outage: sweeps start failing, the cursor reaches the oldest unswept round, takes
 * `sweep-first`, the sweep is refused, and it sits there for the length of the fault while
 * `round_counter` climbs away from it. Read live, that keeper is "still rebuilding" for as long as it
 * is broken — granted the full provision throughout, tripping at a raw gap of 50 instead of the 25
 * `SWEEP_GAP_STOP_ROUNDS` is derived for. ~85 extra minutes and ~0.587 SOL of rent overdue, in the
 * precise fault this stop exists to catch, arrived at by a predicate that looked like a tidy
 * one-liner. The latch separates "below the boundary having never been past it" (a keeper that has
 * genuinely not read this arena's history) from "below the boundary having already been past it" (a
 * keeper that walked everything and is now stuck, which is an OUTAGE and must be judged on the ledger
 * it built).
 *
 * IT ALSO STOPS THE PUBLISHED ALLOWANCE FLAPPING, which the live comparison did every single round:
 * the instant `round_counter` increments, one more round falls past the boundary and the cursor is
 * behind again until an idle pass disposes of it — never during `Drawing` or `Fight`. A healthy arena
 * would show `allowance.rounds` toggling forever, and a field that changes for no reason is a field
 * nobody reads on the day it means something.
 *
 * ALSO NOT A TERM: "the cursor did not advance this pass". It sounds like the signature of an outage
 * and it is the signature of ORDINARY HOUSEKEEPING — `sweep-first` is one pass on a healthy arena
 * (swept now, closed next), and one close failure is what `CLOSE_ATTEMPTS_PER_ROUND` exists to ride
 * out. Either, landing mid-rebuild, would have declared an empty ledger finished. No single-pass
 * observation separates "did not advance" from "is stuck"; the latch above does it with what the
 * process has already ACHIEVED instead.
 *
 * ALSO NOT A TERM: a deadline. "Complete after N seconds of uptime, whatever the cursor says" grants
 * the real allowance on the strength of having waited, which is not evidence — the same wall-clock
 * reasoning `STRANDED_ALLOWANCE_ROUNDS` rejects for the rate bound.
 */
function strandedLedgerIsComplete(closer: ReclamationState["closer"]): boolean {
  return !closer.closing || closer.caughtUpOnce;
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
/** WHEN THIS REPORT WAS BUILT, AND HOW OFTEN A HEALTHY KEEPER BUILDS ONE.
 *
 *  THE FAILURE THIS EXISTS FOR, WHICH IS SILENT WITHOUT IT. `/reclamation.json` serves a STRING the
 *  keeper rendered on its last successful pass — `StatusServerDeps.reclamation` argues at length why
 *  the route must not compute, and that argument stands. But the render happens at the END of the
 *  pass, after `pollTreasury` and `closeOneFinishedRound`, and `closeOneFinishedRound` awaits
 *  `fetchRound` and `isDelegated` OUTSIDE any `try` (see the comment above `pollTreasury`'s call site
 *  in keeper.ts, which is about this same ordering). So one round the chain will not answer for —
 *  a deterministic case, since such a round sits below the retention boundary forever — throws out
 *  of the pass BEFORE the render, on every pass, and this endpoint serves the same bytes until the
 *  process is restarted. The main loop catches, backs off and retries correctly; the STOPS are
 *  unaffected, because they are decided in the keeper from live state and not from this string. What
 *  breaks is only the report, and it breaks by looking perfectly healthy.
 *
 *  WHY NOT `observedAtSec`, WHICH IS ALREADY A TIMESTAMP. Because it answers a different question and
 *  a reader who used it for this one would be right by luck. `observedAtSec` is when the CHAIN STATE
 *  every figure below is derived from was sampled, and a reader is entitled to expect it to lag —
 *  `arena.pollAgeSec` exists precisely because parts of this report are older than the report. This
 *  one is when the REPORT was made, sampled after the pass's work rather than before it, and its
 *  contract is much tighter: a healthy keeper renders one every `everySec`, so anything more than a
 *  few multiples of that older than the reader's own clock means passes are failing.
 *
 *  `everySec` IS BESIDE IT BECAUSE AN INSTANT WITHOUT A BUDGET CANNOT BE JUDGED. This report's
 *  standing rule is that no number is published a reader cannot calibrate — `samplesObserved` has
 *  `armAfterSamples`, `samplesInWindow` has `windowSamples`, `allowance.rounds` has `capRounds`. An
 *  age of 40 seconds is fine on a keeper that renders every 30 and an emergency on one that renders
 *  every second, and the reader has no way to know which this is.
 *
 *  IT IS AN ABSOLUTE INSTANT AND NOT AN AGE, deliberately. An age would have to be computed when the
 *  request is served, and that is the one thing this route may not do. An absolute stamp is computed
 *  once, where the state already is, and the subtraction is done by the reader against their own
 *  clock — which is also the only clock that can detect a keeper whose loop has stopped entirely,
 *  since a self-computed age would freeze along with everything else. */
export interface ReclamationRender {
  /** Unix seconds on the CHAIN's clock — `chainClient.ts`'s `nowSec()`, the same clock every other
   *  instant in this report is stamped with. Within a second or two of any correct wall clock; see
   *  that file's header for why the keeper does not trust its host's. */
  atSec: number;
  /** `LOOP_INTERVAL_SECONDS` — one render per pass of the main loop, on the success path only. */
  everySec: number;
}

export interface ReclamationReport {
  observedAtSec: number;
  /** IS THIS REPORT ITSELF FRESH? — see `ReclamationRender`. Every other field describes the arena;
   *  this one describes the report, and it is the only field that can tell a reader the rest of them
   *  stopped being refreshed hours ago. */
  render: ReclamationRender;
  /** `round_counter - rounds_swept`. COST-MODEL §4 names this, in as many words, as the thing to
   *  watch for the first day of continuous running: if the gap grows, the burn is 330x the headline
   *  and the balance is gone in a day and a half. Null when the treasury has not been read — see
   *  `arena` for why that is reported rather than defaulted to zero.
   *
   *  THE RAW SUBTRACTION, WHICH IS NO LONGER WHAT THE STOP COMPARES. It includes the rounds nothing
   *  can ever sweep, so on an arena with permanently stranded history it is a number that can never
   *  come back down to 1 — the live arena reads 2 and always will. `sweep.effectiveGap` is the one
   *  wired to the decision and `sweep.allowance` is the difference. It stays here, first and
   *  unadjusted, because it is the chain's own bookkeeping and the only figure in this report a
   *  reader can check against `getAccountInfo` by hand. */
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
    /** WHY `samplesObserved` MAY HAVE STOPPED GROWING, when it has. True while the keeper is holding
     *  samples back on purpose — its close cursor is walking rounds it already closed, across which
     *  no rent comes back and every sample would read as a total outage. See
     *  `ReclamationState.burnSamplingSuspended`.
     *
     *  PUBLISHED BESIDE `samplesObserved` RATHER THAN INSTEAD OF ANY FIGURE, because the mean and the
     *  daily burn below stay TRUE about the samples that exist — they are simply about a shorter
     *  history than the reader assumes. Nulling them would hide a measurement that is correct; this
     *  says what the measurement is of. */
    samplingSuspended: boolean;
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
  /** THE SWEEP-GAP STOP, beside the brake because they answer the same owner's question from two
   *  sides — see this file's header on why both exist and why this one is the one that is armed
   *  during the first 2.6 hours of every process.
   *
   *  THE MEASUREMENT IS DELIBERATELY NOT REPEATED IN HERE. The gap itself is the top-level
   *  `sweepGap` and its freshness is `arena.pollAgeSec`; copying either into this block would be two
   *  fields for one fact, which is how a reader ends up comparing a report against itself. What this
   *  block adds is what the keeper MADE OF IT and what it DID about it — `effectiveGap` and
   *  `allowance` are the arithmetic between the chain's number and the decision, which is a different
   *  fact from the number and is the part nobody can reconstruct from the endpoint without them.
   *
   *  THE TWO FIELDS ANSWER TWO DIFFERENT QUESTIONS AND THE PAIR IS WHAT A READER WANTS. `tripped` is
   *  the stop's verdict as of this render — `latched || gap >= stopAtGapRounds`. `stoppedSinceSec` is
   *  whether the KEEPER has acted on it yet, and when.
   *
   *  SO THE TWO CAN LEGITIMATELY DISAGREE, IN BOTH DIRECTIONS, and each disagreement means something
   *  precise rather than being a wrinkle to apologise for:
   *    * `tripped: true, stoppedSinceSec: null` — the gap has just crossed and no `open_round` has
   *      been attempted since. The stop is asked in `openNextRound`, which is reached once per round,
   *      so this window is up to a full round wide (longer across a fight) and the keeper is still
   *      finishing what it started. `keeper-status.json` still says rounds are coming, correctly.
   *    * `tripped: true, stoppedSinceSec: <t>` beside a `sweepGap` back down at 1 — the keeper is
   *      latched. Its input recovers once it stops opening (see `sweepGapStop`), so a healthy-looking
   *      gap here is the CONSEQUENCE of the stop and not evidence against it.
   *  This is the one place this block reads differently from `burn`, whose samples freeze when it
   *  stops, so that block's `tripped` and its latch are the same fact. */
  sweep: {
    tripped: boolean;
    stopAtGapRounds: number;
    /** THE NUMBER THE STOP ACTUALLY COMPARES — the top-level `sweepGap` minus `allowance.rounds`,
     *  which is the count of rounds that SHOULD have been swept and were not.
     *
     *  THIS IS NOT THE MEASUREMENT REPEATED, WHICH IS WHAT THE BLOCK ABOVE FORBIDS. The raw gap is
     *  published once, at the top level, and its freshness once, as `arena.pollAgeSec`. This is a
     *  DERIVED figure and it has to be here rather than left to the reader, because the alternative
     *  is an operator during an incident subtracting one published number from another to work out
     *  which side of the threshold the keeper thinks it is on. The three — raw, allowance, effective
     *  — are what make the decision auditable; any two of them leave the third to be trusted.
     *
     *  Null exactly when `sweepGap` is. May be NEGATIVE — see `SweepGapVerdict.effectiveGap`. */
    effectiveGap: number | null;
    /** WHAT THE STOP EXCUSED AND WHY IT IS ALLOWED TO. An allowance nobody can see is one nobody can
     *  audit, and this one deliberately weakens a safety device — so it is published beside the
     *  decision it changed rather than left to be inferred from `closer.stranded`, which counts the
     *  same rounds for a different purpose (money lost, not headroom spent) and is capped differently
     *  (a 50-round SAMPLE, against a total). */
    allowance: {
      /** Rounds excused, after the cap. Never more than `capRounds` — and never more than the closer
       *  has actually recorded ONLY WHEN `ledgerComplete` IS TRUE. While it is false this is a
       *  provision rather than a count: the whole cap, clamped by the gap, granted because the keeper
       *  has not yet walked this arena's history and is assuming the worst case for itself. */
      rounds: number;
      /** `STRANDED_ALLOWANCE_ROUNDS`, published for `stopAtGapRounds`' reason: the keeper is the only
       *  party that knows what it excuses, and a reader inventing the number would read a saturated
       *  allowance as a healthy one. */
      capRounds: number;
      /** TRUE ONCE THE CLOSER HAS FOUND MORE UNSWEEPABLE ROUNDS THAN THE CAP ALLOWS, which is the
       *  operator's warning that this stop is walking back toward the defect the allowance removed:
       *  from here on every further stranded round spends a round of real headroom. It is the field
       *  to alert on. */
      capped: boolean;
      /** FALSE UNTIL THIS PROCESS'S CLOSE CURSOR HAS REACHED THE RETENTION BOUNDARY ONCE — the first
       *  seconds of an ordinary run, and indefinitely for a keeper whose cursor is wedged on a round
       *  it cannot get past. While it is false, `rounds` above is the whole cap granted provisionally
       *  rather than a count of anything found.
       *
       *  PUBLISHED FOR `burn.samplingSuspended`'s REASON: it is why a published number is not what a
       *  reader expects. Here it says that `allowance.rounds` is a PROVISION and not an observation,
       *  which is the difference between "the keeper found 25 dead rounds" and "the keeper has not
       *  finished looking and is assuming the worst case for itself". Without it those two render
       *  identically, and this endpoint's entire audience is somebody reading it during an incident. */
      ledgerComplete: boolean;
    };
    /** Unix SECONDS, or null while the stop has not fired. */
    stoppedSinceSec: number | null;
  };
  operator: { lamports: string | null; sol: number | null };
  /** THE ONE NUMBER THIS WHOLE ENDPOINT IS FOR: the operator balance divided by the observed daily
   *  burn. Null rather than `Infinity` when the burn is zero, negative or unknown — see
   *  `summariseReclamation` for the argument. */
  runwayDays: number | null;
}

/**
 * THE CONFIGURED KNOBS THE REPORT AND THE TWO STOPS RUN ON, as a named record rather than a run of
 * positional numbers. `config.ts` owns every value; this is the shape they arrive in.
 *
 * IT IS A RECORD BECAUSE TWO OF THESE FIELDS ARE THE SAME TYPE AND THE SAME UNIT, and swapping them
 * is silent in both directions AND wrong in the expensive one. `armAfterSamples` is 45 rounds and
 * `stopAtGapRounds` is 25 rounds; passed positionally, transposing them compiles, runs, and produces
 * a burn brake that arms after 25 samples — inside the retention turnover, so it trips on a healthy
 * young arena, which `burnBrake`'s own doc calls the failure worse than having no brake — beside a
 * sweep stop that waits for a gap of 45, by which time twenty-five rounds of rent are already
 * overdue. Neither one throws, neither shows up in the report as anything but a number that looks
 * plausible. Named fields make the transposition unrepresentable rather than merely unlikely.
 */
export interface ReclamationThresholds {
  /** `MAX_BURN_LAMPORTS_PER_ROUND` — the mean net cost per round the brake stops at. */
  burnLamportsPerRound: number;
  /** `BURN_ARM_AFTER_ROUNDS` — samples that must exist before the brake may have an opinion. */
  armAfterSamples: number;
  /** `BURN_SAMPLE_ROUNDS` — how many of them the mean is taken over. */
  windowSamples: number;
  /** `SWEEP_GAP_STOP_ROUNDS` — the sweep gap at which the keeper stops opening rounds. */
  stopAtGapRounds: number;
  /** `STRANDED_ALLOWANCE_ROUNDS` — the CEILING on how many permanently unsweepable rounds the stop
   *  above will excuse before it starts counting them against itself again. See `sweepGapStop` for
   *  why an allowance without a ceiling is a total outage filed as an excuse, and `config.ts` for the
   *  number and what it costs in both directions. */
  strandedAllowanceRounds: number;
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
  thresholds: ReclamationThresholds,
  roundsPerDay: number,
  // AN ARGUMENT, LIKE EVERY OTHER INSTANT IN THIS FILE, and for the reason the header gives: no clock
  // is READ anywhere in here, so every judgement can be run on its own. It is passed alongside
  // `state` rather than folded into it because it is not a fact about the arena — `ReclamationState`
  // is what the keeper OBSERVED, and this is a fact about the act of reporting it. Folding it in
  // would also have put it behind `reclamationStateOf`, which is built from `state.nowSec` taken at
  // the TOP of the pass, and the whole point of this stamp is that it is taken at the bottom.
  render: ReclamationRender,
): ReclamationReport {
  // Renamed on the way in only where this function's own prose already had a name for the thing —
  // `thresholdLamports` and `armAfter` appear in the arithmetic and the doc comment below, and
  // renaming them here would have made a fifteen-line block disagree with the code under it.
  const {
    burnLamportsPerRound: thresholdLamports, armAfterSamples: armAfter, windowSamples, stopAtGapRounds,
    strandedAllowanceRounds,
  } = thresholds;
  const verdict = burnBrake(state.burnSamplesLamports, thresholdLamports, armAfter, windowSamples);
  // THE STOP ITSELF, ASKED RATHER THAN RECONSTRUCTED. It reads the latch out of the same state it
  // reads the gap and the ledger out of — a report that recomputed `tripped` from the gap would say
  // `false` about a keeper that is stopped, on the one endpoint somebody reads to find out why it
  // stopped, and one that recomputed the ALLOWANCE would be a second implementation of the arithmetic
  // that decides. Everything published in the `sweep` block below is this one verdict, unpicked.
  const sweep = sweepGapStop(state, thresholds);

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
    // COPIED THROUGH RATHER THAN REBUILT, so the only place this pair of numbers is decided is the
    // caller. A `{ ...render }` here would be the same object with a second author.
    render,
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
      samplingSuspended: state.burnSamplingSuspended,
      samplesInWindow: verdict.samples,
      windowSamples,
      meanLamportsPerRound: meanLamports === null ? null : lamportString(meanLamports),
      solPerDay: burnLamportsPerDay === null ? null : sol(burnLamportsPerDay),
      thresholdLamportsPerRound: lamportString(thresholdLamports),
      thresholdSolPerDay: rateIsMeasured ? sol(thresholdLamports * roundsPerDay) : null,
      roundsPerDay: rateIsMeasured ? roundsPerDay : null,
    },
    sweep: {
      tripped: sweep.tripped,
      stopAtGapRounds,
      effectiveGap: sweep.effectiveGap,
      allowance: {
        rounds: sweep.allowance,
        capRounds: strandedAllowanceRounds,
        capped: sweep.allowanceCapped,
        ledgerComplete: sweep.ledgerComplete,
      },
      stoppedSinceSec: state.sweepStoppedSinceSec,
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
