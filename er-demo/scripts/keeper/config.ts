// KEEPER CADENCE AND THRESHOLDS — every number this process runs on, in one file, each with the
// argument for it rather than a plausible-looking value.
//
// WHAT IS DELIBERATELY NOT HERE. Anything the PROGRAM has an opinion about — the lobby length, the
// fight bell, the fight's step rate, the phase codes, the "is this lobby dead" predicate — lives in
// `src/chain/constants.ts`, which mirrors lib.rs, and is imported rather than restated. A keeper
// holding its own copy of the lobby length would be keeping a private countdown next to the chain's,
// which is precisely the habit `Round.lobby_closes_at` was added to end. `DEFAULT_LOBBY_SECONDS` is
// re-exported below for that reason and that reason only: so every call site in scripts/keeper/ can
// reach it without a second import path, and so nobody is tempted to write `60` here.
//
// What IS here is the cadence BETWEEN rounds and the keeper's own operational thresholds. The program
// has no opinion about those because they are about running an arena CONTINUOUSLY, which is a
// different problem from running one round correctly.
//
// Env overrides exist where an operator plausibly wants a different value for a demo or a soak run.
// They are read once, at module load, so the whole process runs on one set of numbers and the log's
// startup banner describes the run for its entire life.

import { DEFAULT_LOBBY_SECONDS, MAX_LOBBY_SECONDS, MIN_LOBBY_SECONDS } from "../../src/chain/constants.ts";

export { DEFAULT_LOBBY_SECONDS };

/** Read a positive number from the environment, or fall back. Refuses a value it cannot parse rather
 *  than silently using the default: an operator who typed `KEEPER_RESULT_HOLD_SECONDS=twelve` wants to
 *  be told, not to spend an hour wondering why nothing changed. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name}="${raw}" is not a positive number. Unset it or give it a real value.`);
  }
  return parsed;
}

// ---- the pause between rounds ------------------------------------------------------------------

/** THE PAUSE BETWEEN `resolve` AND THE NEXT `open_round`, and the single most consequential number
 *  in this file.
 *
 *  It is the ONLY interval in a round where a "next lobby in 0:08" countdown is honest. During a
 *  Lobby the honest countdown is the chain's own `lobby_closes_at`; during Drawing and Fight there is
 *  no honest answer at all, because a VRF callback lands when it lands and a fight ends when it ends
 *  (see `keeperCountdown` in src/v2/data/keeperStatus.ts, which refuses to draw a number in both).
 *  So this window is what makes the requested countdown possible in the first place — not a delay
 *  tolerated for other reasons that a countdown happens to fit inside.
 *
 *  It buys three things at once, which is why 12 rather than 3 or 30:
 *    * `resolve` commits the settled round to the base layer asynchronously. A next round opened the
 *      instant `resolve` confirmed would be racing that commit for the attention of anything reading
 *      the previous result.
 *    * `close_round` (the commit_and_undelegate) runs INSIDE this window, so undelegating the settled
 *      round costs no additional dead air. That is the main reason it is not shorter.
 *    * a player gets to see who won before the arena moves on. The off-chain engine's own comment on
 *      its lobby gap was "shorter = less dead air", and that pressure is real — but its rounds
 *      settled instantly in memory, with no commit to wait for and no undelegation to run.
 *
 *  It is a FLOOR, not a schedule: `nextLobbyOpensAt` is derived as `<when resolve landed> + this`, and
 *  if `close_round` overruns it the keeper republishes the later time rather than opening early. */
export const RESULT_HOLD_SECONDS = envNumber("KEEPER_RESULT_HOLD_SECONDS", 12);

/** The pause after an ABANDONED round, which is a different thing and deliberately much shorter.
 *
 *  There is no result to show — no winner, no seed, no fight (see `abandon_round` in lib.rs) — so
 *  every second here is pure dead air in front of an empty arena. What it is for is mechanical:
 *  `abandon_round` commits AND undelegates in one call, and this is room for that commit to be on its
 *  way before the next round's `open_round`/`delegate_round` pair starts competing for the same
 *  operator signature. Three seconds, justified as commit room rather than as a display pause. */
export const ABANDON_HOLD_SECONDS = envNumber("KEEPER_ABANDON_HOLD_SECONDS", 3);

// ---- holding one lobby open instead of cycling rounds at nobody ---------------------------------

/** Read a boolean from the environment. Only the words are accepted, and anything else is refused
 *  rather than treated as false — `KEEPER_HOLD_OPEN=yes` silently meaning "no" is how an operator
 *  spends an afternoon wondering why a policy they switched on is not running. */
function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`${name}="${raw}" is not a boolean. Use 1/0 or true/false, or unset it.`);
}

/** IS THE HOLD-OPEN POLICY ON? DEFAULT OFF, AND THE DEFAULT IS THE POINT.
 *
 *  The policy depends on an authority-signed early close that exists in lib.rs and IS NOT DEPLOYED.
 *  A keeper that held a lobby open against the deployed program would watch a real player stand in a
 *  room for the whole backstop with no instruction available to start their fight — the worst version
 *  of this feature's failure, because it hurts precisely the person it exists to serve.
 *
 *  IT IS THE OPERATOR'S SWITCH RATHER THAN A CAPABILITY PROBE, and that is deliberate. The only local
 *  evidence available is the IDL, which is generated from SOURCE and can be regenerated before a
 *  deploy — so a probe would turn "somebody edited Rust" into "the chain will accept this". Whether a
 *  program is deployed is not a question this process can answer; the person who ran `anchor deploy`
 *  and watched an early close land is. `programFeatures.ts` still gets a veto (see it), because the
 *  IDL CAN prove the negative. */
export const HOLD_OPEN_ENABLED_DEFAULT = envFlag("KEEPER_HOLD_OPEN", false);

/** HOW LONG A HELD-OPEN LOBBY'S BACKSTOP RUNS BEFORE THE KEEPER GIVES UP AND OPENS ANOTHER.
 *
 * THE PROBLEM THIS NUMBER IS THE ANSWER TO, MEASURED RATHER THAN ASSERTED. No instruction closes a
 * `Round` account — `close_round` commits and undelegates, it never reclaims — so every round ever
 * opened permanently locks its rent-exempt deposit. Measured on devnet, per round: `open_round` costs
 * the payer 0.008503160 SOL of round-PDA rent that is never coming back (verified rather than
 * inferred: every round PDA from #4 to #18 still holds exactly 0.008498 SOL), and `delegate_round`
 * costs a further 0.003220520 SOL of delegation buffer/record/metadata rent, which IS refunded when
 * undelegation closes those accounts. Reconciled across 28 real rounds, net of a one-time 0.06 SOL
 * house-wallet funding, the all-in figure is **0.00981 SOL per round**.
 *
 * At the old ~1m50s cadence that is **~0.32 SOL/hour to cycle an arena nobody is playing in**,
 * permanently locked. That is the entire justification for holding a lobby open, and the ladder that
 * decides this constant is:
 *
 *     cycling every ~110s     ~0.32     SOL/hour idle
 *     1-hour holds            ~0.0098   SOL/hour idle     — 97% of the saving, and this is the value
 *     1-day holds             ~0.0004   SOL/hour idle
 *     7-day holds             ~0.00006  SOL/hour idle
 *
 * WHY NOT `MAX_LOBBY_SECONDS`, WHICH IS NOW A WEEK. Because the last 3% is not worth what it is
 * bought with. `MAX_LOBBY_SECONDS`'s own doc comment in lib.rs says plainly that nothing has ever
 * verified a round can STAY DELEGATED that long — the longest delegation this repo has exercised is a
 * couple of minutes, and MAGICBLOCK_FEEDBACK.md records ER validators losing state in ways this
 * project has already been bitten by. The ceiling permits a week; it is not evidence that a week
 * works, and it says so.
 *
 * THE TWO FAILURES ARE NOT THE SAME SIZE, which is what settles it. A hold that is too SHORT fails as
 * one 0.0098 SOL rent payment, once an hour, visible in the log. A hold that is too LONG fails as a
 * silently dead arena: the delegation is lost, no round is playable, nothing errors, and nobody finds
 * out until somebody tries to play. Take the cheap failure.
 *
 * WHAT WOULD JUSTIFY RAISING IT: watching a delegation survive longer than this, once, OBSERVED —
 * not reasoned about. Then this is a one-line change. It is clamped below rather than trusted, so a
 * value past the chain's own ceiling is refused here instead of being silently clamped on-chain into
 * something the keeper's own countdown arithmetic no longer matches. */
export const HOLD_OPEN_LOBBY_SECONDS = envNumber("KEEPER_HOLD_OPEN_LOBBY_SECONDS", 3_600);

if (HOLD_OPEN_LOBBY_SECONDS < MIN_LOBBY_SECONDS || HOLD_OPEN_LOBBY_SECONDS > MAX_LOBBY_SECONDS) {
  throw new Error(
    `KEEPER_HOLD_OPEN_LOBBY_SECONDS=${HOLD_OPEN_LOBBY_SECONDS} is outside the range the chain will ` +
    `stamp ([${MIN_LOBBY_SECONDS}, ${MAX_LOBBY_SECONDS}]). open_round would clamp it silently and the ` +
    `keeper would then be reasoning about a deadline the round does not have.`,
  );
}

/** HOW LONG THE KEEPER KEEPS ENTRIES OPEN AFTER THE FIRST REAL PLAYER ARRIVES, before it signs the
 *  early close and the fight begins.
 *
 *  IT IS `MIN_LOBBY_SECONDS`, DELIBERATELY, and that is the whole argument — this is an
 *  already-settled number reused rather than a fresh one invented. 20 seconds is the floor the
 *  PROGRAM itself clamps up to, on the grounds that it is the shortest window in which a human can
 *  see a round and get into it, and it is the length the off-chain engine's online lobby actually ran
 *  at (`engine/src/round.ts`). Both of those are arguments about exactly this quantity: how long an
 *  entry window has to be to be real.
 *
 *  CLOSING THE INSTANT THE FIRST PERSON LANDS WAS THE OBVIOUS DESIGN AND IT IS WRONG. It locks out
 *  the second player arriving a beat later — turning a two-player round into a one-player-plus-bots
 *  round for the sake of a second — and it gives the first player no time to size a stake, since they
 *  are already committed by the time they have arrived. Twenty seconds gives both a genuine chance
 *  while still making the fight feel like a consequence of somebody showing up rather than of a clock
 *  running out.
 *
 *  IT MUST EXCEED `HOUSE_FILL_LEAD_SECONDS`, or the house never gets to size itself against the real
 *  arrivals and the displacement policy is dead code on every held-open round. That invariant is
 *  already enforced below, by the assertion that the fill lead is shorter than `MIN_LOBBY_SECONDS` —
 *  the same comparison, which is one more reason for this to be that constant and not a copy of it. */
export const REAL_PLAYER_GRACE_SECONDS = MIN_LOBBY_SECONDS;

// ---- the Drawing wedge ---------------------------------------------------------------------------

/** How long the keeper waits for the VRF callback before declaring a round WEDGED and walking away.
 *
 *  90 seconds, matching the wait `scripts/verify-session-real.mjs` (step 8) and
 *  `scripts/verify-lifecycle.ts` (step 6) already proved sufficient against real devnet. Not a fresh
 *  guess — the same number, in the same units, for the same event.
 *
 *  `Phase::Drawing` has NO exit in the program: only the VRF program may call `callback_seed`, so if
 *  the callback never lands there is no instruction any signer can send (`abandon_round`'s own doc
 *  comment documents this hole, and the shape of the eventual fix). This timeout is not the keeper
 *  fixing that hole — it cannot be fixed from here — it is the keeper refusing to wedge alongside it. */
export const DRAW_TIMEOUT_SECONDS = envNumber("KEEPER_DRAW_TIMEOUT_SECONDS", 90);

// ---- the heartbeat -------------------------------------------------------------------------------

/** How often the status file's `heartbeatAt` is rewritten, whether or not anything changed. */
export const HEARTBEAT_INTERVAL_SECONDS = envNumber("KEEPER_HEARTBEAT_INTERVAL_SECONDS", 2);

/** How old a heartbeat has to be before a reader calls the keeper down. PUBLISHED in the status file
 *  so the browser never invents its own threshold.
 *
 *  THE RATIO IS THE WHOLE POINT, and both directions of getting it wrong are real:
 *
 *    * too TIGHT and a healthy keeper flickers as down. The threshold has to comfortably exceed the
 *      interval PLUS one slow devnet round-trip — the heartbeat runs on its own `setInterval`, but
 *      the process it shares is doing confirmed transactions against public RPC, and a two-second
 *      timer that fires three seconds late under load is ordinary rather than alarming. 15 is seven
 *      heartbeats: five consecutive misses is a process that has stopped, not a slow one.
 *    * too LOOSE and a dead keeper keeps a countdown on screen. That is the failure this whole
 *      mechanism exists to prevent, and it is the worse of the two, because a flicker is visibly a
 *      glitch while a stale countdown is confidently wrong. 15 seconds is inside the shortest thing
 *      it could be lying about (a 12-second result hold), so a page cannot ride a dead keeper's
 *      countdown all the way to zero.
 *
 *  Change one and think about the other: the pair is the contract, not either number alone. */
export const STALE_AFTER_SECONDS = envNumber("KEEPER_STALE_AFTER_SECONDS", 15);

// ---- the main loop ------------------------------------------------------------------------------

/** How long the main loop sleeps between passes.
 *
 *  One second, fixed by the two things that actually need it rather than chosen for feel. The fight's
 *  on-chain cursor only moves at whole-second boundaries (the program derives it from
 *  `Clock::unix_timestamp`), so a tick loop faster than 1Hz sends transactions that knowingly do
 *  nothing; and the status file is the browser's ONLY view of the round, so a loop slower than this
 *  publishes a fighter count next to a live countdown that disagrees with it. A "sleep until the next
 *  thing is due" loop would be cheaper in RPC calls and would fail the second requirement — the
 *  keeper is not the only reader of what it publishes.
 *
 *  Cost, stated rather than hand-waved: one arena read plus one round read per pass, ~2 requests per
 *  second, against endpoints whose public rate limits are an order of magnitude above that. */
export const LOOP_INTERVAL_SECONDS = envNumber("KEEPER_LOOP_INTERVAL_SECONDS", 1);

/** Backoff after an unhandled error in the main loop, doubling per consecutive failure and capped.
 *
 *  Capped rather than unbounded because the keeper must come back on its own when devnet does: an
 *  exponential with no ceiling turns a two-minute RPC outage into an hour of silence. The cap is a
 *  little above the 20-second lobby floor, so even at full backoff the keeper cannot sleep through an
 *  entire round it should have been running. */
export const ERROR_BACKOFF_BASE_SECONDS = 1;
export const ERROR_BACKOFF_MAX_SECONDS = 30;

/** Bounded exponential backoff for chain READS: the waits before each retry, so a read gets one
 *  attempt plus three retries across ~3.5 seconds before it is allowed to fail upward.
 *
 *  READS ONLY, and that asymmetry is deliberate — see `chainClient.ts`'s own note. A blindly retried
 *  SEND can double-submit a transaction that actually landed but whose confirmation timed out, and
 *  for `enter` that means a fighter with twice the intended stake. The main loop re-deriving from the
 *  chain is a strictly better retry for sends: it cannot double-send, because it looks at what the
 *  chain says happened before deciding what to do next. */
export const READ_RETRY_DELAYS_MS = [500, 1_000, 2_000];

// ---- clocks that are not our clock ----------------------------------------------------------------

/** How often the keeper re-measures the offset between its own clock and the chain's.
 *
 *  IT MEASURES RATHER THAN TRUSTS, and that is not caution — an uncorrected host clock is the one
 *  input to this state machine that does not come from the chain, and it is destructive. Trace a host
 *  running 95 seconds fast: `close_lobby_and_draw` only lands once the ER's clock passes the
 *  deadline, so by the time it succeeds the keeper's own clock reads `lobby_closes_at + 95`. The very
 *  next pass computes `drawingFor = 95`, exceeds `DRAW_TIMEOUT_SECONDS`, and declares a perfectly
 *  healthy VRF request wedged — one second after making it. It then opens the next round and does it
 *  again. Zero rounds ever complete, every one of them strands its ~0.0085 SOL of rent, and the log
 *  says "no VRF callback after 95s", which is a lie the operator cannot disprove from the keeper's
 *  own output. A laptop resumed from sleep or a container with no NTP is well inside that trigger.
 *
 *  `CLOCK_SKEW_MARGIN_SECONDS` does not help: it covers the ER-versus-base-layer skew the PROGRAM
 *  cares about, which is a different quantity and two orders of magnitude smaller.
 *
 *  So the offset is measured at boot and re-measured on this interval, and every comparison in the
 *  phase machine runs on the corrected clock. A minute is chosen against what actually drifts: a
 *  machine whose clock moves meaningfully within a minute has been suspended or stepped, and both of
 *  those are caught on the next resync — while polling for it once a second would add two RPC calls
 *  per pass to defend against a quantity that changes on the order of milliseconds per minute. */
export const CLOCK_RESYNC_SECONDS = envNumber("KEEPER_CLOCK_RESYNC_SECONDS", 60);

/** Ceiling on each boot-time probe of an ER validator. Boot happens BEFORE the heartbeat starts, so
 *  an endpoint that accepts the connection and never answers would hang the process with no status
 *  file and no log line after "choosing an ER validator" — the worst way for a keeper to fail to
 *  start, because it looks like nothing at all. Five seconds is many times any observed response and
 *  a timeout simply moves the probe on to the next route. */
export const VALIDATOR_PROBE_TIMEOUT_MS = 5_000;

/** An offset above this is reported loudly at boot. NOT a refusal — the keeper corrects for whatever
 *  it measures, so refusing would turn a handled condition into an outage — but a host more than a
 *  few seconds from the chain is a machine with something wrong with it, and that is worth saying
 *  out loud once rather than silently compensating for forever. */
export const CLOCK_OFFSET_WARN_SECONDS = 5;

/** Margin added to the lobby deadline before the keeper will send `close_lobby_and_draw` or
 *  `abandon_round`.
 *
 *  `lobby_closes_at` is stamped from the BASE layer's `Clock` in `open_round` and compared against the
 *  ER validator's `Clock` in both of those instructions (see `lobby_opened_at`'s doc comment in
 *  lib.rs). The two are the same wall clock and can still disagree by a second. Overshooting costs two
 *  seconds of an already-expired lobby; waking early costs a failed transaction and a confusing
 *  `LobbyStillOpen`. Same margin, same reasoning, same value as `verify-lifecycle.ts` and
 *  `verify-session-real.mjs` — this is not a third opinion. */
export const CLOCK_SKEW_MARGIN_SECONDS = 2;

/** How long to wait for `delegate_round` to actually flip the round PDA's owner to the Delegation
 *  Program. Ten one-second polls, matching `admin-open-round.mjs` — which is where that script gives
 *  up, not how long the hand-off takes (measured at 1.70s and 1.87s against real devnet). */
export const DELEGATION_WAIT_SECONDS = 10;

/** How long to wait for `close_round`'s commit_and_undelegate to hand the round PDA back to our
 *  program on the base layer.
 *
 *  The verification scripts allow 60 seconds for this. A keeper must not: 60 seconds of blocking is
 *  five times the result hold, and the arena would visibly stall on a step that has already
 *  succeeded. 30 is generous against everything observed, and overrunning it is not a failure — the
 *  loop re-derives, sees a Settled round still owned by the Delegation Program, and sends
 *  `close_round` again. That re-send is the one place in this keeper where a duplicate transaction is
 *  possible; it costs a signature and is handled explicitly rather than pretended away. */
export const UNDELEGATE_WAIT_SECONDS = 30;

// ---- house fighters -------------------------------------------------------------------------------

/** The chain's own threshold for "this round can hold a fight" — `enough_to_fight` in lib.rs, which
 *  `close_lobby_and_draw` requires and `lobby_is_dead` requires the negation of.
 *
 *  Named here because the keeper's SEED stage is defined by it: seeding the arena with two fighters,
 *  one per side, is not a sizing preference, it is the minimum that makes the round capable of
 *  fighting at all. (It coincides with the sizing policy's own HOUSE_FLOOR, which is the same
 *  observation reached from the other direction, not a number copied from it.) */
export const MIN_FIGHTERS_TO_FIGHT = 2;

/** How long before the lobby deadline the house tops up to its full target.
 *
 *  THIS LATENESS IS THE ENTIRE MECHANISM, not a scheduling detail. "Seed early liquidity, throttle
 *  down as real players join" only means anything if the throttling happens after the real players
 *  have had their chance to arrive — a house that committed its full roster at the opening bell would
 *  have nothing left to give up, and a real arrival would ADD to a full lobby rather than displace a
 *  bot from it. Entering late is what makes displacement real.
 *
 *  12 seconds is the smallest window that still fits the work: up to four `enter` transactions, each
 *  a confirmed router round-trip, plus the recount that precedes them. Later than this and a slow
 *  devnet leaves the lobby short; earlier and real players arriving in the last quarter of a
 *  60-second lobby can no longer displace anybody. */
export const HOUSE_FILL_LEAD_SECONDS = envNumber("KEEPER_HOUSE_FILL_LEAD_SECONDS", 12);

// It has to fit INSIDE the shortest lobby the chain will ever stamp, or the fill stage is due from
// the first pass of every round and the seed stage — the two-stage design's whole point — never runs
// at all. Checked here rather than left as a comment because the value is env-configurable, and the
// symptom of getting it wrong is not an error, it is a subtly different product with no bots early in
// the lobby and no displacement later.
if (HOUSE_FILL_LEAD_SECONDS >= MIN_LOBBY_SECONDS) {
  throw new Error(
    `KEEPER_HOUSE_FILL_LEAD_SECONDS=${HOUSE_FILL_LEAD_SECONDS} is not shorter than the shortest lobby the ` +
    `chain will stamp (MIN_LOBBY_SECONDS=${MIN_LOBBY_SECONDS}). The fill stage would be due immediately ` +
    `and the seed stage would never run.`,
  );
}

/** Top a house wallet up when it drops below this, and top it up TO `HOUSE_WALLET_TARGET_SOL`.
 *
 *  THE ARITHMETIC, because a funding number with no arithmetic behind it is a guess. A house wallet
 *  sends exactly one `enter` per round. A base-layer signature costs 5,000 lamports, so 0.01 SOL =
 *  10,000,000 lamports is on the order of two thousand rounds — over a day of continuous play at this
 *  cadence. Nothing else leaves these wallets: this program custodies no balances at all (`enter`
 *  RECORDS a stake, it does not move one — see lib.rs's header), so a house fighter's stake never
 *  debits the wallet that entered it.
 *
 *  The floor is 0.002 SOL rather than "empty" so a wallet is refilled while it can still pay for the
 *  round in progress, not after it has already failed one. */
export const HOUSE_WALLET_MIN_SOL = envNumber("KEEPER_HOUSE_WALLET_MIN_SOL", 0.002);
export const HOUSE_WALLET_TARGET_SOL = envNumber("KEEPER_HOUSE_WALLET_TARGET_SOL", 0.01);

/** How long to wait after a failed house `enter` before planning that entry again.
 *
 *  WITHOUT THIS, A DRAINED HOUSE WALLET IS INVISIBLE AND EXPENSIVE. `enterHouseFighters` deliberately
 *  swallows a failure so one bad entry cannot end the process — but the plan is recomputed from the
 *  chain every pass, so an entry that can NEVER succeed (an empty wallet, most obviously) is re-planned
 *  and re-sent on every pass for the whole lobby. That is on the order of a hundred doomed sends per
 *  round, forever, at 1Hz, with `consecutiveErrors` never rising because nothing throws.
 *
 *  Three seconds is long enough to stop that being a flood and short enough that a genuine blip still
 *  gets several attempts inside a 60-second lobby. It is deliberately much shorter than the fill
 *  window, so a transient failure during the fill stage is still recoverable before the deadline. */
export const HOUSE_ENTRY_RETRY_SECONDS = 3;

// ---- the house's books -----------------------------------------------------------------------

/** How long to wait after a failed `sweep_house_take` before trying that round again.
 *
 *  Same shape and same reasoning as `HOUSE_ENTRY_RETRY_SECONDS`: the sweep is derived from chain
 *  state (`Round.house_swept`) and therefore re-attempted on every pass while the round still reads
 *  unswept, so a sweep that can never succeed would be re-sent at 1Hz for the whole hold. Three
 *  seconds still leaves several attempts inside a 12-second result hold, which is the window a sweep
 *  has to land in before the keeper moves on to the next round.
 *
 *  Missing that window is not a loss of money, which is why this is three seconds and not thirty: the
 *  take stays recorded on the round account, and `sweep_house_take` is permissionless, so anyone can
 *  sweep it afterwards. What it costs is a gap between `Treasury.rounds_swept` and the arena's
 *  `round_counter` until somebody does. */
export const SWEEP_RETRY_SECONDS = 3;

/** How many consecutive failed passes before the keeper publishes itself as STALLED.
 *
 *  THE STATE THIS EXISTS TO EXPRESS. A keeper whose loop is failing every pass is still alive: its
 *  heartbeat runs on an independent timer and keeps writing a fresh `heartbeatAt`, so the browser
 *  reads a perfectly healthy keeper while nothing progresses and no round is coming. "Alive but not
 *  progressing" is a third state, and rendering it as the first one is exactly the confidently-drawn
 *  wrong number this project keeps deleting.
 *
 *  SIX, and the unit matters: a "failed pass" is not a failed RPC. Each pass already absorbs four
 *  failed reads over ~3.5 seconds inside `withReadRetry`, so six consecutive failed passes is roughly
 *  two dozen failed operations. With the error backoff doubling from 1s that spans about a minute —
 *  comfortably past any single devnet wobble, and well inside one round, so a keeper that stalls
 *  mid-round is flagged before the round it was running would have finished. Cleared on the first
 *  clean pass. */
export const STALL_AFTER_CONSECUTIVE_FAILURES = 6;

// ---- resolve -------------------------------------------------------------------------------------

/** `resolve` can legitimately land a second early and be refused with `FightNotOverYet` — the keeper's
 *  clock and the ER's are not the same clock. Three attempts three seconds apart is the shape
 *  `verify-session-real.mjs` step 12 already proved; exhausting them is not an error here, because the
 *  main loop comes back in a second and tries again from freshly-read state. */
export const RESOLVE_RETRY_ATTEMPTS = 3;
export const RESOLVE_RETRY_WAIT_SECONDS = 3;

// ---- arena ---------------------------------------------------------------------------------------

/** The fee `init_arena` is created with, in basis points. 20 bps, matching `admin-open-round.mjs` and
 *  `verify-lifecycle.ts` — this only ever takes effect on a program id whose arena does not exist
 *  yet, since `init_arena` is a one-time account creation. */
export const ARENA_FEE_BPS = 20;

// ---- command line ---------------------------------------------------------------------------------

export interface KeeperCliOptions {
  /** Stop cleanly after this many rounds have been settled AND closed. Null runs forever. */
  rounds: number | null;
  /** Do every read, selection and status write; send no transactions. */
  dryRun: boolean;
  /** Hold ONE lobby open until a real player arrives, instead of cycling rounds on a timer. Requires
   *  a DEPLOYED program with the authority early close — see `HOLD_OPEN_ENABLED_DEFAULT`. */
  holdOpen: boolean;
}

export const CLI_USAGE =
  "usage: bun run scripts/keeper/keeper.ts [--rounds N] [--dry-run] [--hold-open]\n" +
  "  --rounds N   stop cleanly after N rounds have settled and undelegated\n" +
  "  --dry-run    boot, read the chain, decide the next action and write the status file — send nothing\n" +
  "  --hold-open  hold ONE lobby open until a real player joins, then start the fight (needs the\n" +
  "               authority early close DEPLOYED; also settable with KEEPER_HOLD_OPEN=1)";

/** Parses argv, refusing anything it does not recognise.
 *
 *  Refusing rather than ignoring: an unattended process started with a misspelt `--dry-run` would
 *  otherwise spend real SOL while its operator believed it was rehearsing. */
export function parseCliOptions(argv: string[]): KeeperCliOptions {
  const options: KeeperCliOptions = { rounds: null, dryRun: false, holdOpen: HOLD_OPEN_ENABLED_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    // One-way on the command line: the flag turns the policy ON, and the env var is how it is turned
    // on for a long-running deployment. There is deliberately no `--no-hold-open`, because off is the
    // default and the way to get it is to not ask for it.
    if (arg === "--hold-open") { options.holdOpen = true; continue; }
    if (arg === "--rounds" || arg.startsWith("--rounds=")) {
      const raw = arg.startsWith("--rounds=") ? arg.slice("--rounds=".length) : argv[++i];
      const parsed = Number(raw);
      if (raw === undefined || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--rounds needs a positive whole number, got "${raw ?? "nothing"}".\n${CLI_USAGE}`);
      }
      options.rounds = parsed;
      continue;
    }
    throw new Error(`unrecognised argument "${arg}".\n${CLI_USAGE}`);
  }
  return options;
}
