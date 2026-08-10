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

import { LAMPORTS_PER_SOL } from "@solana/web3.js";

import {
  DEFAULT_LOBBY_SECONDS, MAX_LOBBY_SECONDS, MIN_LOBBY_SECONDS, MIN_RETAINED_ROUNDS,
} from "../../src/chain/constants.ts";
import { DEFAULT_HTTP_PORT } from "./statusServer.ts";

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
 *  early close and the fight begins — and, because of what binds on either side of it, THE ENTIRE
 *  RUNWAY THE HOUSE HAS TO ARRIVE IN.
 *
 *  CLOSING THE INSTANT THE FIRST PERSON LANDS WAS THE OBVIOUS DESIGN AND IT IS WRONG. It locks out
 *  the second player arriving a beat later — turning a two-player round into a one-player-plus-bots
 *  round for the sake of a second — and it gives the first player no time to size a stake, since they
 *  are already committed by the time they have arrived. The window gives both a genuine chance while
 *  still making the fight feel like a consequence of somebody showing up rather than of a clock
 *  running out.
 *
 *  IT USED TO BE `MIN_LOBBY_SECONDS` ITSELF, AND THAT WAS A DEGENERATE-VALUE GUARD BEING READ AS A
 *  PRODUCT TIMING. The program's own doc comment on `MIN_LOBBY_SECONDS` says so in as many words:
 *  "The floor exists to make the degenerate value impossible, not to suggest a length; any real lobby
 *  asks for more than this." And the instruction this window actually ends in is the AUTHORITY early
 *  close, whose permission is `by_authority || lobby_may_close(...)` — no minimum-open-duration rule
 *  applies to it at all. So nothing on chain ever asked these to be the same number. The coupling is
 *  incidental as a CEILING and load-bearing only as a FLOOR, which is why this is now its own knob,
 *  VALIDATED against `MIN_LOBBY_SECONDS` rather than equal to it.
 *
 *  WHY 45, AND IT IS AN ARRIVAL-RATE ARGUMENT RATHER THAN AN ENTRY-WINDOW ONE. The house physically
 *  cannot trickle in before a real player arrives: `HOUSE_MAX_WITHOUT_REAL_PLAYER` holds an empty room
 *  at one fighter under every configuration, so the room goes 1 -> N only after that moment and this
 *  window is the ONLY place an arrival pattern can live. Peak house demand is ~47 fighters at the
 *  production board of 48. A room that fills faster than about one and a half fighters a second stops
 *  reading as individual people arriving and becomes a block appearing — which is the complaint this
 *  number exists to answer — so ~47 arrivals want about forty seconds of window, plus
 *  `HOUSE_ARRIVAL_TAIL_SECONDS` of quiet before the bell. Forty-five.
 *
 *  WHAT IT COSTS, HONESTLY: the first real player now waits 45 seconds rather than 20 before the fight
 *  starts. The answer to that is not that 45 is small — it is that they are not waiting at NOTHING.
 *  They are watching the room fill in around them, one fighter at a time, which is the thing this
 *  whole change exists to build. A blank 45-second countdown would be a straightforwardly worse
 *  product than a blank 20-second one.
 *
 *  WHAT IT BUYS BESIDES: a second real player gets 45 seconds to find the round and join it instead of
 *  20. That is the same argument the old value was made of, more than twice as much of it. */
export const REAL_PLAYER_GRACE_SECONDS = envNumber("KEEPER_REAL_PLAYER_GRACE_SECONDS", 45);

/** THE QUIET AT THE END OF THE ARRIVAL WINDOW — the gap between the LAST house fighter's scheduled
 *  arrival and the instant the lobby is drawn. A subdivision of the grace above, not a separate
 *  concern, which is why it is declared beside it.
 *
 *  It pays for two things. First, confirmation: entries go through the ER on a delegated round, which
 *  is sub-second in the normal case, so five seconds is headroom rather than an expectation. Second,
 *  and this is the one it is really for, a beat of stillness before the bell. A fight that starts
 *  while fighters are still walking in reads as a cut-off; a room that finishes filling and then holds
 *  for a moment reads as a room that is ready.
 *
 *  CHECKED AGAINST `CLOCK_SKEW_MARGIN_SECONDS` rather than against zero, and that assertion lives
 *  further down this file beside the margin itself, since the margin is declared after this point.
 *  Below the margin, an entry scheduled at the very end of the window would be dropped unsent by
 *  `enterHouseFighters`'s own per-entry clock check — a board that comes up short for a reason no
 *  operator could see in this value. */
export const HOUSE_ARRIVAL_TAIL_SECONDS = envNumber("KEEPER_HOUSE_ARRIVAL_TAIL_SECONDS", 5);

if (REAL_PLAYER_GRACE_SECONDS < MIN_LOBBY_SECONDS) {
  throw new Error(
    `KEEPER_REAL_PLAYER_GRACE_SECONDS=${REAL_PLAYER_GRACE_SECONDS} is below the chain's own lobby floor ` +
    `(MIN_LOBBY_SECONDS=${MIN_LOBBY_SECONDS}). That floor survives here as a FLOOR and only as one: 20 ` +
    `seconds is the shortest window in which a human can see a round and get into it, which is the ` +
    `argument the program makes for it and the length the off-chain engine's online lobby ran at. A ` +
    `keeper that closed entries sooner would be locking out the second player to answer a question ` +
    `nobody asked.`,
  );
}

if (REAL_PLAYER_GRACE_SECONDS > MAX_LOBBY_SECONDS) {
  throw new Error(
    `KEEPER_REAL_PLAYER_GRACE_SECONDS=${REAL_PLAYER_GRACE_SECONDS} is longer than the longest lobby the ` +
    `chain will stamp (MAX_LOBBY_SECONDS=${MAX_LOBBY_SECONDS}), so the grace could never run to its end ` +
    `before the deadline cut it off. The keeper would be reasoning about a close time no round can have.`,
  );
}

if (HOUSE_ARRIVAL_TAIL_SECONDS >= REAL_PLAYER_GRACE_SECONDS) {
  throw new Error(
    `KEEPER_HOUSE_ARRIVAL_TAIL_SECONDS=${HOUSE_ARRIVAL_TAIL_SECONDS} is not shorter than ` +
    `KEEPER_REAL_PLAYER_GRACE_SECONDS=${REAL_PLAYER_GRACE_SECONDS}. The tail is carved out of the grace, ` +
    `so the arrival window between them would be empty or negative and the house would arrive in one ` +
    `burst at the bell — the exact behaviour the schedule replaces.`,
  );
}

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

// ---- reclaiming rent ------------------------------------------------------------------------------

/** IS THE KEEPER ALLOWED TO CLOSE FINISHED ROUND ACCOUNTS? DEFAULT ON, and the default is the point —
 *  the opposite of `KEEPER_HOLD_OPEN`, for a reason worth stating rather than leaving as an
 *  inconsistency.
 *
 *  A `Round` is 1,102 bytes and its rent-exempt deposit is 0.008561 SOL — 95.4% of the 0.008971 a
 *  whole round costs to run, measured on v6 rounds #3 and #4 — and until v7 nothing ever reclaimed a
 *  lamport of it. Reclaiming it takes the marginal cost of a round to ~0.00041, about 22x. On the
 *  current payer that is the difference between roughly 740 rounds and 16,200. Leaving money on the
 *  floor is not a safe default; it is the expensive one, and it is the one nobody notices because
 *  nothing fails.
 *
 *  WHY IT IS SAFE TO DEFAULT ON WHEN `--hold-open` IS NOT. Hold-open needed the operator because its
 *  precondition — a DEPLOYED early close — is not a question any local file can answer, and getting
 *  it wrong stranded a real player in a lobby. This has no such gap: every condition is enforced ON
 *  CHAIN by `check_close_permitted` (terminal, swept, past the retention window, authority-signed),
 *  so a keeper that asks for something it should not get is refused rather than obeyed. The only
 *  local question is "can this instruction be encoded at all", which `programFeatures.ts` answers in
 *  the direction that is worth something — and its `false` vetoes this outright.
 *
 *  `KEEPER_CLOSE_ROUNDS=0` is the escape hatch, for an operator who wants the round log to outlive
 *  the retention window for a demo or an audit. It costs 0.0086 SOL per round to exercise it. */
export const CLOSE_ROUNDS_ENABLED = envFlag("KEEPER_CLOSE_ROUNDS", true);

/** HOW MANY OF THE NEWEST ROUNDS THE KEEPER LEAVES ALONE.
 *
 *  DEFAULTS TO THE CHAIN'S OWN FLOOR AND IS IMPORTED RATHER THAN RESTATED — `MIN_RETAINED_ROUNDS` in
 *  `src/chain/constants.ts`, which mirrors lib.rs. This file's header says anything the PROGRAM has
 *  an opinion about lives there and is imported, and the program has a very firm opinion here: it
 *  refuses with `RoundTooRecent` below its floor. A `20` written out again in this file would be a
 *  second copy of a chain rule, and the copy is always the one that drifts.
 *
 *  CONFIGURABLE UPWARD ONLY, AND REFUSED BELOW THE FLOOR RATHER THAN CLAMPED. Asking for less than
 *  the chain permits is not a preference the keeper can honour — every attempt would come back
 *  `RoundTooRecent` — so a keeper that silently clamped would be running a retention window its
 *  operator did not choose and would never be told about. Asking for MORE is meaningful and cheap:
 *  it keeps history fetchable for longer, at 0.0086 SOL of standing float per extra round. Same
 *  shape and same argument as `HOLD_OPEN_LOBBY_SECONDS`' range check. */
export const ROUND_RETENTION = envNumber("KEEPER_ROUND_RETENTION", MIN_RETAINED_ROUNDS);

if (!Number.isInteger(ROUND_RETENTION) || ROUND_RETENTION < MIN_RETAINED_ROUNDS) {
  throw new Error(
    `KEEPER_ROUND_RETENTION=${ROUND_RETENTION} is below the chain's own floor ` +
    `(MIN_RETAINED_ROUNDS=${MIN_RETAINED_ROUNDS}) or is not a whole number. close_round_account would ` +
    `refuse every round inside that window with RoundTooRecent, so the keeper would be retrying a ` +
    `close the program is never going to allow. Raise it or unset it.`,
  );
}

/** How long to wait before re-attempting a close that failed on the same round.
 *
 *  Same shape and same reasoning as `SWEEP_RETRY_SECONDS` and `HOUSE_ENTRY_RETRY_SECONDS`: the close
 *  is derived from chain state rather than remembered, so a close that can never succeed would be
 *  re-sent on every pass at 1Hz forever. Longer than the sweep's three seconds because there is no
 *  window to hit — a finished round stays closeable indefinitely, so there is nothing to hurry for,
 *  and the rent is not going anywhere. */
export const CLOSE_RETRY_SECONDS = envNumber("KEEPER_CLOSE_RETRY_SECONDS", 30);

/** How many consecutive failures on one round before the keeper moves past it.
 *
 *  Without this the close cursor is a single point of failure for the whole backlog: one round that
 *  fails for a reason the keeper cannot fix holds every OLDER round's rent hostage behind it,
 *  forever, silently. Three attempts thirty seconds apart is enough to ride out a devnet wobble, and
 *  moving on is strictly better than stopping — the skipped round is logged and stays closeable by
 *  hand, whereas a wedged cursor reclaims nothing at all. */
export const CLOSE_ATTEMPTS_PER_ROUND = 3;

// ---- running out of money -------------------------------------------------------------------------

/** THE BALANCE BELOW WHICH THE KEEPER STOPS OPENING NEW ROUNDS.
 *
 *  IT GUARDS THE OPENING ONLY, AND THAT IS THE WHOLE DESIGN. Running out BETWEEN `delegate_round` and
 *  `resolve` is the expensive failure: the round PDA's rent is already paid, the round is delegated,
 *  and a keeper that stopped there would strand that deposit for nothing while leaving a real
 *  player's fight unfinished. So an in-flight round is always driven to a terminal state, whatever
 *  the balance says — the guard refuses to START work it cannot finish, which is the only point where
 *  refusing costs nothing.
 *
 *  0.05 SOL, chosen against the measured cost rather than picked for roundness. A round costs
 *  0.008971 all-in, of which 0.008561 is rent that now comes back once the round passes the retention
 *  window — so the floor has to cover the rent of every round still inside that window, plus the
 *  signatures. It is deliberately several rounds' worth: a floor of exactly one round's cost would
 *  stop the keeper at the moment it could no longer act, with nothing left to pay for the closes that
 *  would recover the rent it is sitting on.
 *
 *  It is a FLOOR, not a reserve: the keeper does not refuse to spend below it, it refuses to open. */
export const MIN_BALANCE_SOL = envNumber("KEEPER_MIN_BALANCE_SOL", 0.05);

/** The same floor in LAMPORTS, which is the unit every balance in this process is actually in.
 *
 *  Converted once, here, rather than at the comparison — `balance()` returns lamports and
 *  `LAMPORTS_PER_SOL` is 1e9, so a SOL figure multiplied at each call site is a float-to-integer
 *  conversion repeated in several places, each of which is a chance to compare a SOL number against a
 *  lamport number and get an answer a billion times wrong in the direction that never triggers.
 *  Rounded rather than truncated so a floor expressed in SOL cannot land a lamport below what was
 *  asked for. */
export const MIN_BALANCE_LAMPORTS = Math.round(MIN_BALANCE_SOL * LAMPORTS_PER_SOL);

/** How long a blocked keeper waits before re-reading the balance.
 *
 *  The guard is reached on every pass while it is refusing, so without this it is an RPC per second
 *  for as long as the arena is unfunded — which could be days. Fifteen seconds bounds it to one read
 *  per fifteen passes while still resuming within fifteen seconds of a top-up landing, and that is the
 *  responsiveness that matters: the person who just sent the SOL is watching the log. */
export const LOW_BALANCE_RECHECK_SECONDS = 15;

// ---- the status server ---------------------------------------------------------------------------

/** The port the keeper serves `/keeper-status.json` and `/health` on.
 *
 *  IT HAS ITS OWN PARSE RATHER THAN `envNumber`'S, because a port is not just "a positive number":
 *  8080.5 and 70000 both pass that check and both fail at `Bun.serve`, several seconds into a boot,
 *  with a message about the runtime rather than about the value the operator typed. The failure that
 *  matters is a container whose `KEEPER_HTTP_PORT` does not match `fly.toml`'s `internal_port`, and
 *  that is caught here, at module load, before anything else has happened.
 *
 *  0 is refused along with everything else out of range even though it is meaningful to the runtime
 *  ("bind any free port"): a keeper on a port nobody can predict is a keeper the platform's health
 *  check cannot reach, so it is never the intent here even when it is the intent elsewhere.
 *
 *  The default is `DEFAULT_HTTP_PORT` in statusServer.ts, which is where the choice is argued; it is
 *  imported rather than restated so the Dockerfile's `EXPOSE`, fly.toml's `internal_port` and this
 *  fallback cannot drift apart in pairs. */
export const HTTP_PORT = (() => {
  const raw = process.env.KEEPER_HTTP_PORT;
  if (raw === undefined || raw === "") return DEFAULT_HTTP_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`KEEPER_HTTP_PORT="${raw}" is not a port. Use a whole number in [1, 65535], or unset it.`);
  }
  return parsed;
})();

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

// THE HOUSE'S ARRIVAL TAIL IS CHECKED HERE, WHERE THE MARGIN IT DEPENDS ON EXISTS. The tail is
// declared with the grace it is carved out of — that is where an operator reads it and where its
// argument lives — and this is the only place in the file where both halves of the comparison are in
// scope. Moving one of the constants to put them together would file it under the wrong subject.
//
// The failure it prevents is invisible in the log and visible on screen: the last arrival in the
// schedule lands at `drawAt - HOUSE_ARRIVAL_TAIL_SECONDS`, and `enterHouseFighters` re-checks the
// clock immediately before every send and DROPS anything inside the skew margin of `drawAt`. Set the
// tail below the margin and the tail of the schedule is planned, counted, and then quietly never
// sent — a board that draws short with nothing but a `dropped` counter to say why.
if (HOUSE_ARRIVAL_TAIL_SECONDS <= CLOCK_SKEW_MARGIN_SECONDS) {
  throw new Error(
    `KEEPER_HOUSE_ARRIVAL_TAIL_SECONDS=${HOUSE_ARRIVAL_TAIL_SECONDS} is not greater than ` +
    `CLOCK_SKEW_MARGIN_SECONDS=${CLOCK_SKEW_MARGIN_SECONDS}. The last house fighters in the arrival ` +
    `schedule would be planned inside the margin and dropped unsent rather than entered, so the board ` +
    `would draw short every round and the reason would not be in this value.`,
  );
}

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

// ---- how big the house's board is, and what it is exposed to ---------------------------------------
//
// THE FIVE NUMBERS BELOW ARE THE ONLY THINGS THAT DECIDE HOW MUCH THE HOUSE HAS AT RISK IN A ROUND,
// and they are env-configurable for one reason: the number they should be is a MEASUREMENT nobody has
// finished taking yet. A policy that can only be retuned by a deploy is a policy that will not be
// retuned.
//
// WHAT "AT RISK" MEANS HERE, because this program moves no lamports and the phrase is easy to
// dismiss. `enter` records a stake; `Treasury.fees_accrued` is "a ledger the off-chain treasury is
// paid against" (lib.rs, `sweep_house_take`). So nothing debits a house wallet beyond its signature
// fee — but the fight is a zero-sum exchange over those recorded stakes, and the ledger it writes is
// settled for real somewhere else. Two bounds fall straight out of conservation:
//
//     house profit on a round  <=  total REAL stake in it        (they cannot lose more than they brought)
//     house LOSS   on a round  <=  total HOUSE stake in it       (we cannot lose more than we brought)
//
// And the house's expected revenue is `fee_bps` on REAL entries only — the fee its own wallets pay is
// charged by the house to the house. So the asymmetry to keep in view while reading these constants:
//
//     SEATS are what make the arena look alive, and they cost a signature each.
//     STAKE is what creates the downside tail, and it buys nothing that seats do not already buy.
//
// Since `advance_fight`'s `min(ring_a, ring_d)` basis, return is size-neutral AND seat-count-neutral
// to within noise (HOUSE-EDGE-STUDY.md §0: whale -0.31% +- 0.27, minnow +0.51% +- 0.57; an
// eight-wallet split worth $0.30/round). That is what makes the split above legitimate: a $5 house
// fighter is exactly as much of a fighter on screen as a $50 one, and exactly as fair a one to play
// against. THE DEFAULTS THEREFORE BUY THE FULL BOARD WITH SMALL STAKES rather than a full board with
// the old ones — see `HOUSE_STAKE_MAX_USD`.
//
// (That measurement covered eight fighters of comparable size. A board of nine house fighters against
// one real player is outside the regime it sampled. If the edge study now in flight says otherwise,
// these are the five values to move, and none of them needs a deploy.)

/** Read a positive integer from the environment, or fall back. Separate from `envNumber` because
 *  every value below is a COUNT OF FIGHTERS or a COUNT OF DOLLARS: `KEEPER_HOUSE_BOARD_TARGET=7.5`
 *  would otherwise sail through and produce a target the allocator silently floors, and a stake of
 *  $12.50 would break the whole-dollar property `houseStake` is built on. `min` is explicit per knob
 *  because zero is meaningful for one of them (a house that never withdraws) and meaningless for the
 *  rest. */
function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name}="${raw}" is not a whole number of at least ${min}. Unset it or give it a real value.`);
  }
  return parsed;
}

/** HOW MANY WALLETS THE HOUSE BANKS, and therefore the most fighters it could ever field at once.
 *
 *  TEN, RAISED FROM SIX, and the raise is the whole point of this section. `MAX_FIGHTERS` was 16 at
 *  the time — it is 48 now, the 16 -> 48 fighter cap — and live rounds #23, #27 and #28 each ran FOUR
 *  fighters against that old ceiling: a quarter-full board, which is most of why the arena read as
 *  dead. Ten house wallets plus real arrivals is a board that looks like an arena, of the size the
 *  arena used to be; see the note on `HOUSE_BOARD_TARGET` below for whether ten still reads as full
 *  now that the room holds forty-eight.
 *
 *  NOT `MAX_FIGHTERS` (48, up from 16 — the gap only widened), and that gap is deliberate rather than
 *  timid: the house must never be able to fill the room, or a real player arrives to `RoundFull` and
 *  the arena's own liquidity is what shut them out. `plannedHouseEntries` enforces the reservation
 *  against the chain's own seat count; this number just has no business approaching it.
 *
 *  RAISING IT COSTS THE OPERATOR TWO THINGS AND BOTH ARE SMALL. A new wallet is funded to
 *  `HOUSE_WALLET_TARGET_SOL` once (0.01 SOL) and spends 5,000 lamports per round it enters. Going
 *  6 -> 10 parks an extra 0.04 SOL. See `HOUSE_WALLET_TARGET_SOL` for the per-round arithmetic.
 *
 *  RAISING IT ON A DEPLOYMENT IS A TWO-STEP, and `loadOrCreateHouseBank` refuses rather than guesses
 *  if you do only the first: the keeper generates the shortfall locally, then the operator re-issues
 *  `KEEPER_HOUSE_WALLETS` with all of them. Keys from the environment are never written back, so a
 *  container that generated four wallets would fund them and lose them on every restart. */
export const HOUSE_WALLET_COUNT = envInt("KEEPER_HOUSE_WALLET_COUNT", 10, 2);

/** AND A CEILING ON IT, which the fixed pool of six never needed.
 *
 *  IT WAS SIXTEEN, ON TWO ARGUMENTS, AND BOTH HAVE BEEN ANSWERED RATHER THAN OVERRULED.
 *
 *  The first was a packet limit: `fundHouseBank` built ONE transaction from every shortfall, and a
 *  legacy transaction holds roughly twenty transfers, so a count of 25 would have failed at first
 *  boot — the one moment every wallet is short at once — with a transaction-size error that named
 *  nothing about the count. That is now chunked at `FUNDING_CHUNK`, with the payer pre-flight
 *  charging one signature per chunk, so the ceiling no longer encodes a packet size.
 *
 *  The second was that `MAX_FIGHTERS` was sixteen, so "a bank larger than the room is wallets that can
 *  never enter". True of a bank read in index order, which is what it was: `plannedHouseEntries` took
 *  the lowest-numbered free wallets, so wallets past the board size genuinely never played. It now
 *  rotates the starting point by round number, and THAT is what a pool larger than the board is for —
 *  not more fighters per round, which the chain caps at `MAX_FIGHTERS` regardless, but a different cast
 *  between rounds. Nine regulars every round reads as a fixture; thirty wallets seating nine of them
 *  reads as a population.
 *
 *  THIRTY-TWO is therefore about funding cost and disclosure, not mechanics. Every wallet in the pool
 *  is published in the keeper's status file and marked on the leaderboard, and each one holds
 *  `HOUSE_WALLET_TARGET_SOL`, so the pool is a standing capital commitment: at 0.01 SOL a wallet,
 *  thirty is ~0.30 SOL parked. Twice the round's seat count is enough rotation that the cast turns
 *  over completely every few rounds; more than that buys diminishing variety for linear cost.
 *
 *  THE DERIVATION STOPPED MATCHING ITS NUMBER AT THE 16 -> 48 SEAT CAP, and the previous note flagged
 *  that rather than deciding it, correctly — it is an operator call about standing capital. It has now
 *  been made, and 32 became actively blocking rather than merely unmoored:
 *
 *  32 CANNOT STAFF A FULL BOARD. Peak house demand is `HOUSE_BOARD_TARGET - HOUSE_DISPLACEMENT`, so a
 *  target of 48 needs 47 wallets beside one real player. The boot check below refuses that
 *  configuration — and it refuses it by THROWING AT STARTUP, which on Fly means a machine that stays
 *  stopped. Setting the target to 32 against a 30-wallet bank took the keeper down until the bank was
 *  raised; the guard was right and the cost of learning it was an outage.
 *
 *  64 is "the seat count plus rotation headroom", which is the rule that picked 32 when a round held
 *  sixteen. It is deliberately NOT 96: doubling the seat count made sense when the board was small and
 *  the pool turned over every couple of rounds, but at 48 seats a 48-wallet pool already replaces the
 *  entire cast every round, so the second 48 buys nothing a player could perceive. The ceiling sits
 *  above the working number so the target can be tuned without moving this constant again.
 *
 *  Standing capital at 0.01 SOL a wallet: 48 wallets is ~0.48 SOL parked, against ~0.30 at thirty.
 *  Funding is chunked at `FUNDING_CHUNK`, so the transaction-size limit that used to bound this
 *  constant no longer does. */
const HOUSE_WALLET_COUNT_MAX = 64;
if (HOUSE_WALLET_COUNT > HOUSE_WALLET_COUNT_MAX) {
  throw new Error(
    `KEEPER_HOUSE_WALLET_COUNT=${HOUSE_WALLET_COUNT} is above the ceiling of ${HOUSE_WALLET_COUNT_MAX}. ` +
    `Every wallet in the pool is published as house and holds KEEPER_HOUSE_WALLET_TARGET_SOL, so the ` +
    `pool is standing capital, not free variety. Past roughly twice the board size the cast already ` +
    `turns over completely every few rounds and more wallets buy diminishing variety for linear cost.`,
  );
}

/** HOW MANY FIGHTERS THE HOUSE HOLDS THE BOARD AT, counting real players.
 *
 *  Read it with `HOUSE_DISPLACEMENT` = 1, which is what makes the name honest: the house fields
 *  `HOUSE_BOARD_TARGET - realTotal` fighters, so the board sits at this many all through the lobby
 *  and its composition shifts from house to human as people arrive. Ten, one real player, nine bots;
 *  ten real players, none.
 *
 *  THE PREVIOUS POLICY WAS THE OPPOSITE SHAPE AND IT IS WORTH NAMING, because this reverses it. It
 *  targeted FOUR and displaced TWO — the house was scaffolding that left completely once two real
 *  players could fight each other, so the board SHRANK as the arena got busier (0 real: 4 fighters;
 *  2 real: 2 fighters). The operator's judgement is that a market maker that withdraws at the first
 *  sign of a crowd is why the rounds looked empty, and this is that judgement expressed as a number.
 *  `KEEPER_HOUSE_BOARD_TARGET=4` with `KEEPER_HOUSE_DISPLACEMENT=2` restores the old ladder exactly.
 *
 *  ────────────────────────────────────────────────────────────────────────────────────────────────
 *  WHAT EACH SETTING COSTS. MEASURED. DO NOT MOVE THIS NUMBER WITHOUT READING THE ROW.
 *  ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *  Measured over 20,000-round samples against the shipped fight, at `KEEPER_HOUSE_DISPLACEMENT = 1`
 *  and the default $5-$20 band, in a round with ONE real player — the shape almost every live round
 *  has had. "Circular" is the share of treasury intake that is the house paying its own 1% entry fee
 *  to itself: `H / (H + R)`, against a real stake `R` of about $32, the sampled mean.
 *
 *      target   house fighters   capital at risk   worst case   circular fee   house `enter`s/round
 *         4            3              ~$37            $60           54%            3   (0.000015 SOL)
 *         6            5              ~$63           $100           66%            5   (0.000025 SOL)
 *         8            7              ~$88           $140           73%            7   (0.000035 SOL)
 *        10            9             ~$113           $180           78%            9   (0.000045 SOL)  <- default
 *        12           11             ~$138           $220           81%           11   (0.000055 SOL)
 *
 *  THE GAS COLUMN IS NOT THE CONSTRAINT AT ANY OF THESE, and it is worth saying so plainly so nobody
 *  optimises the wrong number: even the largest row is 0.000055 SOL a round against ~0.00041 SOL of
 *  marginal round cost once `close_round_account` is reclaiming rent. The first two columns are the
 *  constraint.
 *
 *  THE THREE THINGS THIS ROW DOES NOT BUY, all measured rather than argued:
 *
 *    * NO EXPECTED REVENUE. Zero, at every setting. Since `advance_fight` reads
 *      `basis = min(ring_a, ring_d)` every exchange is symmetric and the fight is a martingale for
 *      every fighter, so house-wallet P&L came out at −$0.18 to −$0.49 per round — which is exactly
 *      minus the fee those wallets paid, and that fee returns to the treasury the house owns. Net
 *      contribution: nothing. There is no farming edge here to be captured by seating more bots, and
 *      anyone reaching for this dial as a strategy has misread it.
 *    * MORE LOSING ROUNDS. The share of rounds where the house is down went 21% -> 39% moving from
 *      the old policy to this one. Same expectation, fatter tails: the house has more of its own
 *      money on the table and the real player's stake is the only thing it can win.
 *    * A LESS MEANINGFUL TREASURY NUMBER. At 78% circular, four fifths of `fees_accrued` is the house
 *      billing itself, so treasury growth stops being a proxy for revenue. `HOUSE-STRATEGY.md`'s
 *      consolidated form — net house revenue is exactly what real players lose, and nothing else — is
 *      the one to read instead.
 *
 *  So this is a number bought for how the board LOOKS, priced as a cost. That is a legitimate thing to
 *  buy — an arena that reads as dead has no real players to earn from, and sixteen seats running at
 *  four was the complaint that started this. It was 10 because that is where a SIXTEEN-seat room read
 *  as full while the reservation still left six seats for arrivals.
 *
 *  THAT "READS AS FULL" CLAIM IS STALE AND NOT RE-DERIVED HERE, ON PURPOSE. `MAX_FIGHTERS` is now 48
 *  (the 16 -> 48 fighter cap), and ten fighters in a forty-eight-seat room is a fifth full, not full —
 *  arguably the same "arena reads as dead" complaint that motivated raising this off its old default of
 *  four in the first place. Whether the default should rise again, and to what, is the OWNER'S dial and
 *  the owner's judgement call to re-make against the new room size, not something to be silently
 *  reassigned here; this comment exists so that judgement gets made deliberately rather than by
 *  omission. It is the OWNER'S dial, not this file's, which is the whole reason it reads from the
 *  environment. */
export const HOUSE_BOARD_TARGET = envInt("KEEPER_HOUSE_BOARD_TARGET", 10, 1);

/** HOW MANY HOUSE FIGHTERS EACH REAL ENTRANT DISPLACES.
 *
 *  One, so the board holds its size and the house's share of it falls one-for-one — which is exactly
 *  what a market maker seeding a book does, and exactly what "hold the board at `HOUSE_BOARD_TARGET`"
 *  means arithmetically.
 *
 *  Zero is permitted and means the house never withdraws: the board grows past the target as people
 *  arrive, capped by `HOUSE_WALLET_COUNT` and the seat reservation. It is allowed because it is a
 *  coherent thing to want for a launch weekend, and it is not the default because the house should
 *  become a smaller part of a busy arena rather than a constant one.
 *
 *  WHAT IT COSTS, WHICH IS THE SAME CURRENCY `HOUSE_BOARD_TARGET` IS PRICED IN. Read the table on that
 *  constant with `house fighters = HOUSE_BOARD_TARGET - HOUSE_DISPLACEMENT * realPlayers`: raising the
 *  displacement is the cheap way to keep a full board at ONE real player while shedding the house
 *  faster as a crowd builds, and lowering it to 0 means the house never stops paying the capital-at-
 *  risk column no matter how busy the arena gets. At the default of 1 the measured shape is 8 house
 *  fighters at two real players, where the previous policy fielded 0 — that single row is most of the
 *  21% -> 39% rise in losing rounds, and it is the row to move first if the tail turns out to be
 *  unaffordable. `KEEPER_HOUSE_DISPLACEMENT=2` halves the house's presence at every crowd size above
 *  one without touching how a lone arrival's round looks. */
export const HOUSE_DISPLACEMENT = envInt("KEEPER_HOUSE_DISPLACEMENT", 1, 0);

/** The band house stakes are drawn from, in whole dollars — and, multiplied by the board size, the
 *  entire downside tail this arena carries per round.
 *
 *  THE CEILING CAME DOWN FROM $50 TO $20 IN THE SAME CHANGE THAT TRIPLED THE BOARD, and that pairing
 *  is the argument. Exposure is `fighters x mean stake`, so a board of nine drawn from $5-$50 would
 *  put ~$248 of house stake behind a round whose expected fee revenue, at one real player staking
 *  $20, is twenty cents. Nine drawn from $5-$20 is ~$113 — about twice what today's two-bot rounds
 *  risk (~$55), for four and a half times the fighters. The liveliness is bought with seats; the
 *  ceiling is what stops it being bought with exposure.
 *
 *  BOTH EDGES STILL SIT ON THE LADDER REAL PLAYERS ARE OFFERED (`STAKE_PRESETS` = $5/$20/$50/$100),
 *  which is the property `houseSizing.test.ts` pins: a house fighter must neither be dwarfed by a
 *  player at the smallest preset nor dwarf one. $5 is that smallest preset and $20 is the next rung.
 *
 *  To take the old band back: `KEEPER_HOUSE_STAKE_MAX_USD=50`. Nothing else needs to move, and the
 *  round-by-round exposure roughly doubles. */
export const HOUSE_STAKE_MIN_USD = envInt("KEEPER_HOUSE_STAKE_MIN_USD", 5, 1);
export const HOUSE_STAKE_MAX_USD = envInt("KEEPER_HOUSE_STAKE_MAX_USD", 20, 1);

// Checked here rather than left to `houseStake` to produce nonsense, because the symptom of an
// inverted band is not an error — `mix() % span` with a negative span returns NaN, `usdToUnits` turns
// that into a `BigInt` throw deep inside a house entry, and the operator sees a failing bot rather
// than the typo they made.
if (HOUSE_STAKE_MIN_USD > HOUSE_STAKE_MAX_USD) {
  throw new Error(
    `KEEPER_HOUSE_STAKE_MIN_USD=${HOUSE_STAKE_MIN_USD} is above KEEPER_HOUSE_STAKE_MAX_USD=${HOUSE_STAKE_MAX_USD}. ` +
    `The band is a range a stake is drawn from, so the floor has to be the smaller of the two.`,
  );
}

// A target the bank cannot staff is not a target, it is a permanent shortfall: `plannedHouseEntries`
// would ask for fighters every pass, find no free wallet, and quietly field fewer than the policy
// says forever. Refusing at boot makes the operator's arithmetic mistake loud at the one moment they
// are looking at it.
// PEAK HOUSE DEMAND, NOT THE BOARD TARGET, and the difference is a whole fighter. The target counts
// REAL players too, and the house never fields it in full — the busiest it ever gets is one real
// player already in the room, which is `HOUSE_BOARD_TARGET - HOUSE_DISPLACEMENT`. Comparing the raw
// target against the bank refused configurations that are perfectly staffable: at the default
// displacement of 1, a target of 11 needs ten house fighters beside one player, which ten wallets
// staff exactly. `MIN_FIGHTERS_TO_FIGHT` is the other end — the house seeds that many while a lone
// player waits, whatever the target says.
const PEAK_HOUSE_FIGHTERS = Math.max(MIN_FIGHTERS_TO_FIGHT, HOUSE_BOARD_TARGET - HOUSE_DISPLACEMENT);
if (PEAK_HOUSE_FIGHTERS > HOUSE_WALLET_COUNT) {
  throw new Error(
    `KEEPER_HOUSE_BOARD_TARGET=${HOUSE_BOARD_TARGET} with KEEPER_HOUSE_DISPLACEMENT=${HOUSE_DISPLACEMENT} ` +
    `needs up to ${PEAK_HOUSE_FIGHTERS} house fighters, but KEEPER_HOUSE_WALLET_COUNT banks only ` +
    `${HOUSE_WALLET_COUNT}. The house would ask for a wallet that does not exist on every pass and ` +
    `quietly field fewer fighters than the policy says, forever. Raise the wallet count (and re-issue ` +
    `KEEPER_HOUSE_WALLETS with the new keys) or lower the target.`,
  );
}

/** SEATS THE HOUSE MAY NEVER TAKE, held for real players who have not arrived yet.
 *
 *  NOT env-configurable, and that is the difference between a preference and an invariant. Every
 *  other number in this section is a judgement about how the arena should look; this one is the
 *  promise that a person who clicks Enter finds a seat. A house that filled the room would hand a
 *  real player `RoundFull` — the arena's own liquidity locking out the only participant it exists to
 *  attract, which is a strictly worse failure than an empty board.
 *
 *  IT IS AN ARRIVAL RATE, NOT A ROOM SIZE, and that is what makes it derived rather than written down.
 *  The estimate has always been "four people may turn up inside one grace window" — which is why the
 *  16 -> 48 fighter cap did not disturb it. But the grace window is now a knob and its default has
 *  more than doubled, so the same estimate is `4 per 20 seconds` scaled to whatever window is actually
 *  in force. Leaving the literal 4 in place while lengthening the grace would have quietly weakened a
 *  documented promise by exactly the factor the grace grew by, and nothing would have failed.
 *
 *  THE FLOOR OF 4 KEEPS THE OLD VALUE AS A MINIMUM, so no configuration of the grace can reserve less
 *  than this always did. At the default grace of 45 the derived value is 9.
 *
 *  IT IS A WHOLE-WINDOW QUANTITY AND NOT A PER-PASS ONE, which is the reason the scaling is the right
 *  shape rather than a rough one: once the house is at its ceiling it cannot un-seat, so this number
 *  is exactly "how many real players may still arrive after that moment" — and that moment is roughly
 *  the start of the window, whatever the arrival ramp is doing inside it.
 *
 *  WHAT IT COSTS at the production board of 48 seats: the house holds at most 38 of them rather than
 *  43. Five bots out of a board of forty-eight is invisible on screen, and it buys back the promise
 *  the reservation exists for — that a person who clicks Enter finds a seat.
 *
 *  NOT env-configurable even so, and that is the difference between a preference and an invariant. It
 *  is a backstop against a misconfigured target rather than part of the normal arithmetic — which is
 *  exactly why it is applied in `plannedHouseEntries` against the chain's own `fighters.length` rather
 *  than against a copy of `MAX_FIGHTERS` restated here. See this file's header on why program
 *  constants are not mirrored into it. */
export const REAL_SEATS_RESERVED = Math.max(4, Math.ceil(4 * REAL_PLAYER_GRACE_SECONDS / MIN_LOBBY_SECONDS));

// `KEEPER_HOUSE_FILL_LEAD_SECONDS` IS GONE, AND A KEEPER THAT IS STILL BEING GIVEN IT REFUSES TO BOOT.
//
// It named the instant the house jumped from its seed to its full board — "commit late, so a real
// arrival displaces a bot rather than joining a room that is already full". That job now belongs to
// `REAL_PLAYER_GRACE_SECONDS`, which anchors the arrival ramp: the house is planned against the
// instant the lobby will actually be drawn, and the ramp runs backwards from there.
//
// BE HONEST ABOUT WHAT THAT TRADED. The ramp seats house fighters EARLIER in the window than the old
// step did — that is the entire point of a ramp — so some displacement headroom really is gone. What
// is NOT gone is the guarantee: `REAL_SEATS_RESERVED` is applied to the house ceiling on every pass,
// so there are always at least that many seats standing free for people who have not arrived yet.
// Displacement was the soft, aesthetic half of the policy; the reservation is the invariant, and it is
// untouched — and it is bigger now than it was.
//
// The refusal is loud rather than silent because the alternative is worse than a wrong value: a live
// keeper reading a tuning knob that no longer exists, behaving differently from the deployment its
// operator believes they configured, with nothing in the log to say so.
if (process.env.KEEPER_HOUSE_FILL_LEAD_SECONDS !== undefined && process.env.KEEPER_HOUSE_FILL_LEAD_SECONDS !== "") {
  throw new Error(
    `KEEPER_HOUSE_FILL_LEAD_SECONDS is set ("${process.env.KEEPER_HOUSE_FILL_LEAD_SECONDS}") and no longer ` +
    `exists. The house no longer steps up to its full board at a fixed lead — it arrives on a schedule ` +
    `spread across the whole entry window. The two knobs that shape that window are ` +
    `KEEPER_REAL_PLAYER_GRACE_SECONDS (how long the window is) and KEEPER_HOUSE_ARRIVAL_TAIL_SECONDS ` +
    `(how much quiet is left at the end of it). Unset this one.`,
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
 *  round in progress, not after it has already failed one.
 *
 *  WHAT THE WHOLE BANK COSTS, since `HOUSE_WALLET_COUNT` is now a knob and the operator has to fund
 *  whatever they set it to. At the defaults (10 wallets, board of 10):
 *
 *      parked      10 x 0.01 SOL              = 0.10  SOL, once      (6 wallets was 0.06)
 *      per round   up to 10 x 5,000 lamports  = 0.00005 SOL          (2 entries was 0.00001)
 *      refill      (0.01 - 0.002) / 0.000005  = 1,600 rounds per wallet before it drops to the floor
 *
 *  So the added spend is ~0.00004 SOL per round that actually fights, against the ~0.00041 SOL a
 *  round already costs once `close_round_account` is reclaiming rent — a tenth more per round. Rounds
 *  only complete when a real player turns up (see `KEEPER_HOLD_OPEN`), so the daily figure is a
 *  function of traffic rather than of the keeper: 100 rounds/day is +0.004 SOL/day, 1,000 is
 *  +0.04 SOL/day. Against the operator's ~3.6 SOL, the bank is not the cost worth watching. The
 *  exposure in `HOUSE_STAKE_MAX_USD` is. */
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
 *  gets several attempts inside a 60-second lobby. It is deliberately much shorter than the arrival
 *  window, so a transient failure partway through the house's arrival is recoverable long before the
 *  bell — and the window it has to recover inside is now `REAL_PLAYER_GRACE_SECONDS`, more than three
 *  times what the old twelve-second fill stage gave it. */
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
  /** Reclaim finished rounds' rent by closing their accounts. ON by default — see
   *  `CLOSE_ROUNDS_ENABLED` for why this default runs the other way from `holdOpen`'s. */
  closeRounds: boolean;
}

export const CLI_USAGE =
  "usage: bun run scripts/keeper/keeper.ts [--rounds N] [--dry-run] [--hold-open]\n" +
  "  --rounds N   stop cleanly after N rounds have settled and undelegated\n" +
  "  --dry-run    boot, read the chain, decide the next action and write the status file — send nothing\n" +
  "  --hold-open  hold ONE lobby open until a real player joins, then start the fight (needs the\n" +
  "               authority early close DEPLOYED; also settable with KEEPER_HOLD_OPEN=1)\n" +
  "  --no-close-rounds  stop reclaiming finished rounds' rent (~0.0086 SOL each, 95% of a round's\n" +
  "               cost). On by default; also settable with KEEPER_CLOSE_ROUNDS=0";

/** Parses argv, refusing anything it does not recognise.
 *
 *  Refusing rather than ignoring: an unattended process started with a misspelt `--dry-run` would
 *  otherwise spend real SOL while its operator believed it was rehearsing. */
export function parseCliOptions(argv: string[]): KeeperCliOptions {
  const options: KeeperCliOptions = {
    rounds: null,
    dryRun: false,
    holdOpen: HOLD_OPEN_ENABLED_DEFAULT,
    closeRounds: CLOSE_ROUNDS_ENABLED,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    // The NEGATIVE flag, which is the opposite shape to `--hold-open` and for the opposite reason:
    // this policy is on by default, so the thing an operator needs to be able to say on the command
    // line is "not this time". There is deliberately no `--close-rounds`, because on is the default
    // and the way to get it is to not ask for it.
    if (arg === "--no-close-rounds") { options.closeRounds = false; continue; }
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
