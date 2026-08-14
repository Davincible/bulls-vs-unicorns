#!/usr/bin/env bun
// THE ROUND KEEPER — the process that makes rounds happen continuously instead of when a human runs
// a script.
//
//   bun run scripts/keeper/keeper.ts [--rounds N] [--dry-run]
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE DECISION THAT CARRIES THE WHOLE DESIGN
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// The main loop RE-DERIVES ALL STATE FROM THE CHAIN on every iteration, and then does the ONE next
// thing:
//
//     while (running) {
//       const state = await readChainState();   // arena + current round, always fresh
//       await driveOneStep(state);              // the single next action, then return
//     }
//
// RECOVERY IS THEREFORE NOT A SPECIAL PATH — IT IS THE ONLY PATH. A crash halfway through a round is
// indistinguishable, to the next iteration, from a fresh boot: both arrive at `readChainState` with no
// beliefs at all and are told by the chain what phase the round is in and what is owed. So "the keeper
// never acts from memory" is true BY CONSTRUCTION rather than by anybody's discipline, and there is no
// separate recovery routine to rot — no reconciliation pass that is exercised once a month and is
// therefore wrong when it finally runs. The first thing this keeper does on a fresh boot against a
// dirty arena (a lobby that expired under-subscribed while nothing was running, say) is exactly what
// it would have done had it never stopped.
//
// WHAT LIVES IN MEMORY, STATED HONESTLY. The house wallet keypairs (persisted to disk anyway), the
// pinned ER validator (re-derived at boot), the clock offset (re-measured on a timer), and a per-round
// timeline of wall-clock observations. Most of that timeline is cosmetic — it feeds the summary line —
// but TWO of its fields do gate a branch, and pretending otherwise would be exactly the kind of
// comment this repo exists to not write:
//
//   * `settledObservedAtSec` and `abandonedObservedAtSec` decide when the next round opens, because
//     the program stamps no "when did this settle" field and there is nothing on-chain to derive it
//     from. The error direction is safe and one-directional: a restart mid-hold re-stamps to now,
//     which only ever EXTENDS the hold, once, by at most `RESULT_HOLD_SECONDS`. It can never cause a
//     round to open early, and it is latched per round so it cannot re-stamp while the round stands.
//   * `completedCounted` stops one round being counted twice. It counts THIS PROCESS'S work, which is
//     the one question the chain genuinely cannot answer — `round_counter` counts rounds ever opened,
//     including every round that ran before this keeper booted.
//   * `firstRealEntryObservedAtSec` decides when the keeper closes a held-open lobby, because the
//     program stamps no per-fighter entry time — a `Fighter` row is a wallet, a side, a stake and
//     some hp, and not one field of `Round` moves when somebody enters. Same shape and same safe
//     error direction as the two above: a restart mid-grace re-stamps to now, which EXTENDS the entry
//     window by at most `REAL_PLAYER_GRACE_SECONDS`, once, and can never close a lobby early.
//
// Everything else — every phase branch, every deadline, every fighter count, every "is it delegated" —
// is read out of `KeeperChainState`, which was fetched this second. Including the clock: see
// `chainClient.ts`'s header for why "now" is measured against the chain rather than trusted from the
// host, and `CLOCK_RESYNC_SECONDS` in config.ts for what an uncorrected host clock does to this state
// machine.
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE PHASE MACHINE
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
//   no arena                    -> init_arena (idempotent; the operator becomes the authority)
//   round_counter == 0          -> open_round #1
//   Lobby, not delegated        -> delegate_round (nobody can enter an undelegated round, and
//                                  abandon_round's commit_and_undelegate needs it too)
//   Lobby, clock running        -> field house fighters when a stage is due; otherwise wait
//   Lobby, held open, a player  -> after a grace window, close_lobby_and_draw signed as AUTHORITY
//   Lobby, expired, >= 2        -> close_lobby_and_draw, DIRECT to this round's own ER validator
//   Lobby, expired, < 2         -> abandon_round, then straight on to the next round
//   Drawing                     -> wait for the VRF callback, bounded; then walk away (see the wedge)
//   Fight                       -> tick once a second; resolve once it is over or the bell has rung
//                                  (resolve GRINDS on a badly neglected round — up to MAX_STEPS_PER_CALL
//                                  steps per call, so it can take several passes through this same
//                                  branch before the phase actually moves to Settled)
//   Settled, still delegated    -> close_round
//   Settled / Abandoned, home   -> sweep_house_take if it is owed; hold until nextLobbyOpensAt, then
//                                  open_round for counter + 1
//
// Round numbers always come from `arena.round_counter + 1`. Never from memory: `open_round` requires
// `round_no == round_counter + 1` and the counter is the only thing that knows.
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// TWO LOBBY POLICIES, ONE PHASE MACHINE
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// FIXED CADENCE (the default): a fresh `DEFAULT_LOBBY_SECONDS` lobby every round, ended by its own
// deadline. Every round FLOATS ~0.0235 SOL of rent whether or not anybody played and gets it back
// once `ROUND_RETENTION` newer rounds exist — so what the cadence actually SPENDS is the ~0.00007 SOL
// of fees a round signs, against a standing float of `ROUND_RETENTION` rounds' rent, ~0.470 SOL
// (COST-MODEL §0, §1, §3).
//
// THE PER-DAY FIGURE DEPENDS ON WHETHER ANYBODY IS PLAYING, AND THIS LINE USED TO QUOTE THE WRONG ONE.
// COST-MODEL §2's ~0.030 SOL/day at 424 rounds/day is the CONTINUOUS-PLAY cadence: a 204-second cycle
// of which 124 seconds is a fight. An idle round has no fight in it, so it cycles several times faster
// and signs fewer transactions each — a different arithmetic, not the same one. §5 measures what this
// deployment actually does, which is neither: 4 transactions in a day, because `fly.toml` runs
// hold-open behind a seven-day backstop.
//
// AND NOBODY FIGHTS IN AN IDLE ROUND EITHER, WHICH IS THE OPPOSITE OF WHAT THIS LINE SAID.
// `HOUSE_MAX_WITHOUT_REAL_PLAYER` now governs EVERY empty room rather than only a held-open one, so a
// fixed-cadence lobby nobody joins holds ONE house fighter — below `enough_to_fight` — and is
// ABANDONED at its deadline rather than drawn. There are no house-versus-house fights in any default
// configuration. That is precisely the property `--house-only-rounds` exists to give up, and a keeper
// whose own header claimed the default had already given it up would have made the flag look free.
//
// HOLD OPEN (`--hold-open`): ONE lobby with a long backstop, one house fighter in it so the room is
// not empty, held at zero marginal cost until a real player arrives — then a short grace window and
// an authority-signed early close, so the fight starts because a person showed up. One rent payment
// instead of one per cycle.
//
// THE MONEY ARGUMENT FOR HOLD-OPEN WEAKENED WHEN `close_round_account` SHIPPED, and saying so is more
// useful than restating a number. This header used to price fixed cadence at ~0.32 SOL/hour of rent
// that nothing reclaimed, and against that, holding one lobby instead of cycling was a ~33x cut in
// idle burn all by itself. It is not any more: rent is float, the cadence's real spend is fees, and
// the gap between the two policies is three hundred times smaller than the line that used to be here.
// WHAT HOLD-OPEN STILL BUYS IS EXPOSURE AND THE ROOM, NOT SOL/HOUR — every round opened is one more
// round whose deposit depends on a close landing, and COST-MODEL §4 is about nothing but the ways
// that close fails (a skipped round, a round wedged before a terminal phase, a round left delegated).
// On the failure path fixed cadence is ~9.96 SOL/day and hold-open is one round's rent. That is the
// honest form of the argument, and it is the one to reason with.
//
// The switch is the operator's (`config.ts`'s `HOLD_OPEN_ENABLED_DEFAULT` says why it is not
// auto-detected) and it is OFF until the early close is deployed. What it does NOT do is add a mode
// this process remembers: every branch still reads the round the chain just handed it, so a keeper
// that boots into the middle of a held lobby decides exactly what the one that opened it would.
// `lobbyPolicy.ts` is where that decision lives, as one pure function with its own tests.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, type PublicKey } from "@solana/web3.js";

import {
  FIGHT_TIMEOUT_SECONDS, PHASE_NAME, Phase, PROGRAM_ID,
  canonicalCursor, lobbyIsDead,
} from "../../src/chain/constants.ts";
import { bnOr0, type RawRoundAccount } from "../../src/chain/program.ts";
import { loadIdl } from "../../src/chain/idl.ts";
import { errorCodeOf } from "../../src/v2/data/programError.ts";
import * as roundIx from "../../src/chain/round.ts";
// Whole dollars, because `houseStake` only ever produces whole dollars — the log line reads as a
// roster of stakes a person might have chosen, which is the point of the band it draws from.
import { unitsToUsd } from "../../src/v2/contract.ts";

import {
  ABANDON_HOLD_SECONDS, ARENA_FEE_BPS, CLOCK_SKEW_MARGIN_SECONDS, DEFAULT_LOBBY_SECONDS,
  DELEGATION_WAIT_SECONDS, DRAW_TIMEOUT_SECONDS, ERROR_BACKOFF_BASE_SECONDS, ERROR_BACKOFF_MAX_SECONDS,
  HEARTBEAT_INTERVAL_SECONDS, HOLD_OPEN_LOBBY_SECONDS, HOUSE_BOARD_TARGET, HOUSE_DISPLACEMENT,
  HOUSE_ENTRY_RETRY_SECONDS, HOUSE_STAKE_MAX_USD, HOUSE_STAKE_MIN_USD, HOUSE_WALLET_COUNT,
  LOOP_INTERVAL_SECONDS, REAL_PLAYER_GRACE_SECONDS, REAL_SEATS_RESERVED, RESOLVE_RETRY_ATTEMPTS,
  RESOLVE_RETRY_WAIT_SECONDS, RESULT_HOLD_SECONDS, STALE_AFTER_SECONDS,
  STALL_AFTER_CONSECUTIVE_FAILURES, SWEEP_RETRY_SECONDS, UNDELEGATE_WAIT_SECONDS,
  BURN_ARM_AFTER_ROUNDS, BURN_SAMPLE_ROUNDS, MAX_BURN_LAMPORTS_PER_ROUND, TREASURY_POLL_SECONDS,
  CLOSE_ATTEMPTS_PER_ROUND, CLOSE_RETRY_SECONDS, HTTP_PORT, LOW_BALANCE_RECHECK_SECONDS,
  MIN_BALANCE_LAMPORTS, ROUND_RETENTION, SCHEDULE_CLOSE_RETRY_SECONDS, SWEEP_GAP_STOP_ROUNDS,
  parseCliOptions,
  type KeeperCliOptions,
} from "./config.ts";
import { BASE_RPC_ENDPOINT, ROUTER_ENDPOINT, describeEndpoints } from "./endpoints.ts";
import { assertDevnetUrl } from "../../src/devnet-guard.ts";
import { asSecretKeyBytes, parseSecretJson, readSecretText } from "./secrets.ts";
import {
  BIND_HOSTNAME, HEALTH_PATH, HOUSE_PATH, HOUSE_TOKEN_ENV, RECLAMATION_PATH, STATUS_PATH,
  originPolicyWarnings, resolveAllowedOrigins, resolveHouseTokenPolicy, startStatusServer,
} from "./statusServer.ts";
import {
  HOUSE_MAX_WITHOUT_REAL_PLAYER, houseFighterCount, type EmptyRoomPolicy,
} from "./houseSizing.ts";
import {
  ROUND_RENT_LAMPORTS, burnBrake, recordBurnSample, serializeReclamationReport, summariseReclamation,
  sweepGapStop,
  type ReclamationState, type ReclamationThresholds,
} from "./reclamation.ts";
import { lobbyIsHeldOpen, planLobby, type LobbyPlan } from "./lobbyPolicy.ts";
import { decideClose, housekeepingIsWelcome, isPastRetention } from "./roundCloser.ts";
import { readProgramFeatures, type ProgramFeatures } from "./programFeatures.ts";
import {
  NO_FRESH_VALIDATOR, createChainClient, selectWritableValidator,
  type ChainClient, type ErValidator, type KeeperChainState,
} from "./chainClient.ts";
import {
  enterHouseFighters, fundHouseBank, loadOrCreateHouseBank, plannedHouseEntries,
  type HouseBank,
} from "./houseBank.ts";
import { createStatusPublisher, roundStatusFrom, type StatusPublisher } from "./statusFile.ts";
import {
  c, describeError, error, failedWith, fmtDuration, fmtSol, heading, info, ok, plain,
  setLogRound, sleep, warn,
} from "./log.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** THE OPERATOR KEY, AND WHY IT MUST BE THIS ONE. `open_round` and `delegate_round` are both
 *  `has_one = authority` against the Arena, so the keeper cannot open a round with any other key —
 *  and the arena on this program id was initialised by the fork payer. Loaded from the same path
 *  every other admin script in this repo loads it from; it must never reach a browser bundle. */
const FORK_PAYER_PATH = join(here, "..", "..", "..", ".devnet", "fork-payer.json");

/** The same key's bytes as an environment variable, for a deployment that has no `.devnet/` — see
 *  `secrets.ts` for the precedence rule and for why a key must never be baked into an image.
 *
 *      fly secrets set KEEPER_OPERATOR_KEY="$(cat .devnet/fork-payer.json)" */
const OPERATOR_KEY_ENV = "KEEPER_OPERATOR_KEY";

/** The arena authority, from the environment or from disk, saying which. Refusing to start is the
 *  right answer when neither exists: this key IS the arena, and there is no useful degraded mode. */
function loadOperator(): Keypair {
  const secret = readSecretText(OPERATOR_KEY_ENV, FORK_PAYER_PATH);
  if (secret === null) {
    throw new Error(
      `no operator key. Set ${OPERATOR_KEY_ENV} to the arena authority's secret key (a JSON array of 64 ` +
      `numbers), or put that key at ${FORK_PAYER_PATH}. open_round and delegate_round are both ` +
      `has_one = authority, so without it this process cannot open a single round.`,
    );
  }
  const bytes = asSecretKeyBytes(parseSecretJson(secret, "a JSON array of 64 numbers"), secret);
  // WHERE, never what. The pubkey is printed in the banner below — that is public — and the secret
  // material does not appear in any log line this process writes.
  info(`operator key: loaded from ${secret.where} (${secret.source})`);
  return Keypair.fromSecretKey(bytes);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Per-round memory — see the header for exactly which of these decide anything
// ────────────────────────────────────────────────────────────────────────────────────────────────

interface RoundTimeline {
  roundNo: bigint | null;
  drawRequestedAtMs: number | null;
  fightObservedAtMs: number | null;
  /** LATCHED. Stamped once, the first time this process sees the round settled, and never
   *  re-stamped while the round number stands — because `nextLobbyOpensAt` is derived from it, and a
   *  re-stamp moves a published countdown BACKWARDS. A sampled hold showed exactly that:
   *  0:11, 0:09, 0:07, 0:05, 0:11, 0:09, … sawtoothing for fifty seconds instead of counting twelve
   *  down to zero once. The whole justification for the result hold is that it is the one interval
   *  where that number is honest. */
  settledObservedAtSec: number | null;
  abandonedObservedAtSec: number | null;
  /** LATCHED, and the only piece of memory the hold-open policy adds.
   *
   *  WHY IT CANNOT BE DERIVED, since that was the first thing tried. The program stamps no entry
   *  time: a `Fighter` row is a wallet, a side, a stake, hp and banked, and `Round` carries
   *  `lobby_opened_at`, `lobby_closes_at` and `fight_started_at` — not one of which moves when
   *  somebody enters. The `Entered` event carries the fact but not a timestamp, and it is emitted
   *  inside the rollup, where scanning transaction history for a block time would be a new dependency
   *  on the least reliable thing in the system to answer a question worth one grace window.
   *
   *  So it is stamped when this process first SEES a real fighter standing in the round, and never
   *  re-stamped while that round number stands. A restart mid-grace re-stamps it to now, which
   *  extends the entry window by up to `REAL_PLAYER_GRACE_SECONDS`, once. That error only runs in the
   *  safe direction — a player can never be locked out earlier than they were promised, only later —
   *  which is the same trade `settledObservedAtSec` makes and the same reason it is acceptable. */
  firstRealEntryObservedAtSec: number | null;
  operatorLamportsAtOpen: number | null;
  /** Chain-clock second before which no further house entry should be planned, after one failed.
   *  Without it, an entry that can never succeed — an empty house wallet, most obviously — is
   *  re-planned and re-sent on every pass for the whole lobby, and nothing throws, so nothing is
   *  recorded and nothing backs off. */
  houseRetryAfterSec: number;
  /** The same throttle for `sweep_house_take`, and for the same reason: the sweep is attempted on
   *  every pass of a hold while the round reads unswept, so a sweep that can never succeed — a
   *  treasury on a different arena, an un-deployed instruction — would be re-sent once a second for
   *  the whole hold, every round, forever. */
  sweepRetryAfterSec: number;
  /** The same throttle again, for the authority close that brings an OFF-SCHEDULE lobby onto the
   *  house-only schedule — see `lobbyPolicy.ts`'s header for what that is and
   *  `SCHEDULE_CLOSE_RETRY_SECONDS` for the interval.
   *
   *  THE ONE THAT IS READ SOMEWHERE ELSE. Its two neighbours above are read at the top of the function
   *  that sends, because the plan has no step for the work they guard. This one is handed to
   *  `planLobby` on the view: the work it guards IS a step, and a planner that answers "close it now"
   *  once a second while the keeper means "not for another thirty" is describing a keeper that does not
   *  exist. `scheduleCloseIsDue` argues it at length, and the once-per-round property is pinned in
   *  `lobbyPolicy.test.ts` because it is a decision rather than a detail of sending.
   *
   *  Zero on a fresh round and zero after a restart, both meaning "attempt it now". The failure that
   *  matters is the other direction — a stamp that survives a round change would silence the repair on
   *  a round that needs it — and the timeline is rebuilt on every round-number change, so it cannot. */
  scheduleCloseRetryAfterSec: number;
  /** Has this round already been counted toward `roundsCompleted` and summarised?
   *
   *  NOT a "did I already send close_round" flag — that would be memory deciding a chain action, and
   *  the chain is asked (the round PDA's owner) every pass instead. This exists because `close_round`
   *  can legitimately be sent twice: the undelegate commit reaches the base layer asynchronously, so a
   *  slow one leaves the next pass looking at a Settled round that is still delegated. Without this,
   *  that second send counts the same round twice, prints a second "ROUND #N COMPLETE", and
   *  `--rounds 3` stops after two real rounds. */
  completedCounted: boolean;
}

function freshTimeline(roundNo: bigint | null, operatorLamportsAtOpen: number | null): RoundTimeline {
  return {
    roundNo,
    drawRequestedAtMs: null,
    fightObservedAtMs: null,
    settledObservedAtSec: null,
    abandonedObservedAtSec: null,
    firstRealEntryObservedAtSec: null,
    operatorLamportsAtOpen,
    houseRetryAfterSec: 0,
    sweepRetryAfterSec: 0,
    scheduleCloseRetryAfterSec: 0,
    completedCounted: false,
  };
}

interface KeeperContext {
  client: ChainClient;
  publisher: StatusPublisher;
  bank: HouseBank;
  operator: Keypair;
  validator: ErValidator;
  options: KeeperCliOptions;
  /** WHAT A ROOM WITH NOBODY REAL IN IT IS ALLOWED TO HOLD — `"unfightable"` (the treasury rule) or
   *  `"house-only"`. Derived ONCE, at construction, from `options.houseOnlyRounds`.
   *
   *  CARRIED RATHER THAN RE-DERIVED AT EACH CALL SITE, and the reason is not that a ternary is long.
   *  The policy NAME is what makes `plannedHouseEntries(…, { emptyRoom: ctx.emptyRoom })` readable:
   *  `"house-only"` says which guarantee is in force, where a boolean would say only which flag
   *  somebody set and leave the reader to remember what it implies. And one derivation is one place
   *  the flag and the policy can disagree — none — where a ternary repeated at every call site is
   *  exactly the shape that drifts the day a third policy or a second flag arrives. */
  emptyRoom: EmptyRoomPolicy;
  /** What the IDL this process builds from can encode. Read once at boot — see `programFeatures.ts`
   *  for why a `true` here is not evidence of a deploy and a `false` is evidence of the opposite. */
  features: ProgramFeatures;
  timeline: RoundTimeline;
  roundsCompleted: number;
  roundsAbandoned: number;
  /** Set when `--rounds N` has been satisfied. The loop finishes its current step and exits cleanly. */
  stop: boolean;
  /** The step changed the round's phase, so the snapshot read at the top of this pass is already out
   *  of date. The loop re-reads before publishing, so the file never describes two different instants
   *  in its two halves — a sample once caught `nextLobbyOpensAt` set beside a round still reading
   *  `Fight`, which the contract says never happens. */
  refreshAfterStep: boolean;
  /** Chain second of the last "still drawing" line, so it repeats about every ten seconds rather than
   *  on a modulo that a two-second pass can step straight over. */
  lastDrawLogSec: number;
  /** Same idea, for the held-open lobby's periodic line. A hold can last an hour, and an hour of an
   *  empty log is indistinguishable from a stopped process to the operator reading it. Cosmetic:
   *  nothing branches on it. */
  lastHoldLogSec: number;

  // ---- reclaiming rent — see `closeOneFinishedRound` for why this is the only memory it keeps ----

  /** The oldest round that might still be closeable. Starts at #1 on EVERY boot, which is what makes
   *  a pre-existing backlog get drained rather than only rounds this process opened. Only ever moves
   *  forward, so the scan cannot loop; one round is examined per pass, so the cost is one account
   *  read per second no matter how long the arena's history is. */
  closeCursor: bigint;
  /** Consecutive failures against the round the cursor is on, so one round the keeper cannot fix
   *  cannot hold every older round's rent hostage behind it. */
  closeAttempts: number;
  /** Chain second before which no further close is attempted, after one failed. */
  closeRetryAfterSec: number;
  /** How many accounts this run has closed — for the shutdown summary, so the saving is a number the
   *  operator sees rather than one they have to trust. */
  rentReclaimed: number;
  /** THE ROUNDS THE RENT IS NOT COMING BACK FROM, one ledger per kind of loss.
   *
   *  `closeSkipped` is rounds the cursor gave up on after `CLOSE_ATTEMPTS_PER_ROUND` failures —
   *  0.023497 SOL each, gone permanently, because nothing revisits them and that is deliberate. The
   *  two `stranded` ledgers are rounds no instruction could ever have closed: one never reached a
   *  terminal phase, one was still owned by the Delegation Program. They are kept apart rather than
   *  summed for the reason `ReclamationReport` gives — a skipped round was closeable and was given up
   *  on; a still-delegated one might yet come back if forced undelegation is ever deployed. */
  closeSkipped: CloseLossLedger;
  closeStrandedNeverTerminal: CloseLossLedger;
  closeStrandedStillDelegated: CloseLossLedger;

  // ---- running out of money ----------------------------------------------------------------------

  /** Chain second at which the payer FIRST fell below the floor in the current stretch, or null while
   *  it is funded. Drives the log-once behaviour; the published latch lives in `statusFile.ts`. */
  lowBalanceSince: number | null;
  /** When the balance was last actually read for the funding guard, so a blocked keeper re-checks on
   *  an interval rather than once a second. */
  lowBalanceCheckedAtSec: number;

  // ---- is the rent coming back? see `reclamation.ts` for what each of these is evidence of --------

  /** `Arena.round_counter` and `Treasury.rounds_swept` as of the last treasury poll, or null before
   *  the first one. `roundsSwept` is null in turn for a program with no treasury account, which is a
   *  different fact from a gap of zero and is reported as one. */
  treasury: { roundCounter: number; roundsSwept: number | null; polledAtSec: number } | null;
  /** Chain second the poll above last ran, so it runs on `TREASURY_POLL_SECONDS` rather than at 1 Hz
   *  against a quantity that moves at most once a round. */
  treasuryPolledAtSec: number;
  /** Operator lamports at each open_round this run, newest last.
   *
   *  RETAINED AT `BURN_ARM_AFTER_ROUNDS` (45), NOT AT `BURN_SAMPLE_ROUNDS` (20), AND THE TWO MUST NOT
   *  BE TIDIED INTO ONE NUMBER. `burnBrake` arms on `samples.length >= armAfter` and then takes its
   *  mean over the last `windowSamples`. A ring capped at the WINDOW can never reach the ARMING
   *  threshold, so the brake would never arm — and nothing would say so, because the report would show
   *  `armed: false` beside a sample count that had silently stopped growing at twenty. That is the one
   *  failure in this mechanism invisible from its own telemetry, so the cap is the larger of the two
   *  constants on purpose. `config.ts` explains why they are different; this is what depends on it. */
  burnSamplesLamports: number[];
  /** The operator balance read at the last `open_round` that actually LANDED, or null before the
   *  first. The difference between two of these is one burn sample.
   *
   *  A DEDICATED FIELD RATHER THAN `timeline.operatorLamportsAtOpen`, which happens to hold the same
   *  number today. The timeline is replaced wholesale by the main loop on any round-number change, so
   *  a sampler reading it would depend on a reset it does not own: the day somebody changes when the
   *  timeline is refreshed, the samples would go wrong silently and the brake would be averaging
   *  something other than round-to-round net. This is written in one place and read in one place. */
  lastOpenLamports: number | null;
  /** Chain second at which the burn brake FIRST tripped in this process, or null while it has not.
   *  Drives the log-once-per-stretch behaviour exactly as `lowBalanceSince` does. */
  burnStopSince: number | null;
  /** Chain second at which the SWEEP-GAP STOP first tripped in this process, or null while it has
   *  not. Drives the log-once-per-stretch behaviour as the two fields above it do — AND, UNLIKE
   *  EITHER OF THEM, IS THE LATCH ITSELF RATHER THAN ONLY A RECORD OF ONE.
   *
   *  THE DIFFERENCE IS LOAD-BEARING AND IT IS WHY THIS FIELD IS READ BACK. `burnStopSince` can be a
   *  bookkeeping field because the burn brake latches by physics: samples are taken at `open_round`,
   *  a stopped keeper opens nothing, so its mean freezes and `burnBrake` keeps returning the same
   *  verdict without being told. This stop's input keeps MOVING after it fires — the treasury is
   *  still polled, `round_counter` is frozen because nothing opens, and `rounds_swept` can still rise
   *  as the closer sweeps what it can reach — so the gap falls back toward healthy on its own. A
   *  verdict recomputed from the gap alone would clear the stop, reopen the arena, and let the gap
   *  climb to the threshold again: an arena flapping between stopped and spending, which is the leak
   *  with a duty cycle rather than a brake. So this is handed to `sweepGapStop` as `latched` and the
   *  answer comes back tripped regardless. Nothing in this process ever sets it back to null. */
  sweepStopSince: number | null;
  /** The most recent operator balance ANY part of this process has read. The reclamation report is
   *  rendered once per pass and must not add a chain call to do it, so it reads this rather than the
   *  wallet — written wherever a balance is already being fetched for a decision. */
  operatorLamportsObserved: number | null;
  /** Chain second of the first `open_round` this run, and how many have landed since — the two terms
   *  of the MEASURED rounds/day the report is computed against. See `measuredRoundsPerDay`. */
  firstOpenAtSec: number | null;
  opensObserved: number;
}

/** HOW MANY LOST-ROUND NUMBERS ARE KEPT PER CATEGORY, oldest out of the front.
 *
 *  A BOUND IS NOT OPTIONAL HERE. This process is meant to run for weeks, the close cursor walks every
 *  round the arena has ever opened at ~424 rounds/day, and a run against an arena whose reclamation
 *  has genuinely failed would append one entry per round forever — an unbounded array inside a payload
 *  that is re-rendered every pass and served to anybody who asks for it. Fifty is enough to see the
 *  shape of the loss (which rounds, how close together, recent or historic) and small enough that the
 *  report stays something a person can read in a terminal.
 *
 *  WHAT THE BOUND COSTS, SAID PLAINLY BECAUSE IT ONCE COST MORE THAN THIS. It costs round NUMBERS and
 *  nothing else. Each `CloseLossLedger.total` counts every loss whether or not the sample kept the
 *  entry, `reclamationStateOf` hands those totals over beside the lists, and `summariseReclamation`
 *  prices `count`, `lamports` and `sol` off them — so a run that skipped two hundred rounds publishes
 *  two hundred and the SOL for two hundred, above the fifty most recent numbers, with `listed` saying
 *  which of the two the array is. The count must never be the sample's: this endpoint answers "how
 *  much have I permanently lost", and a bounded answer to that would understate the loss exactly when
 *  it was largest, silently, with every published number still agreeing with every other.
 *
 *  So the fifty are for GOING AND LOOKING, and nothing is accounted on them. Every individual loss is
 *  logged uncapped at the instant it happens, and this file's shutdown banner prints the same totals
 *  the report does. */
const CLOSE_LOSS_SAMPLE = 50;

/** ONE KIND OF PERMANENT LOSS: the bounded sample of round numbers, and the total the sample stops
 *  being once it fills.
 *
 *  THEY ARE ONE FIELD BECAUSE THEY WERE TWO, ALONG THE SEAM THAT ALREADY FAILED ONCE. The totals used
 *  to live in a separate record keyed by category, incremented at each call site beside the push. That
 *  was correct, and it was correct by discipline: a category could be sampled and not counted, and the
 *  published loss would have understated itself with nothing failing anywhere. The bug this file did
 *  ship was one step further along the same seam — the report priced the loss off the LIST — so the
 *  seam is worth closing rather than documenting again. Bundled, there is no call site that can do
 *  half the job: `recordCloseLoss` takes the pair or it takes nothing, and a fourth kind of loss added
 *  later cannot be added wrongly. */
interface CloseLossLedger {
  /** Round numbers, newest last, at most `CLOSE_LOSS_SAMPLE`. */
  sample: number[];
  /** Rounds recorded this run, including the ones the sample has since dropped. */
  total: number;
}

/** Record one round whose rent is not coming back. */
function recordCloseLoss(ledger: CloseLossLedger, roundNo: bigint): void {
  ledger.sample.push(Number(roundNo));
  if (ledger.sample.length > CLOSE_LOSS_SAMPLE) ledger.sample.shift();
  ledger.total += 1;
}

/** How often a held-open lobby says so in the log. A minute — often enough that the process is
 *  visibly alive during an hour of deliberate silence, rare enough that an overnight run is a
 *  readable page rather than three thousand identical lines. */
const HOLD_LOG_INTERVAL_SECONDS = 60;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The phase machine
// ────────────────────────────────────────────────────────────────────────────────────────────────

async function driveOneStep(ctx: KeeperContext, state: KeeperChainState): Promise<void> {
  if (!state.arena) return initArena(ctx);
  if (state.roundCounter === 0n) return openNextRound(ctx, 1n);

  // Destructured before the guard, and used from the locals afterwards: narrowing a property PATH
  // holds only as long as nothing between the check and the use could reassign it, which is a
  // property of the code a later edit can quietly remove. A local cannot be reassigned by anything.
  const { round, roundPda } = state;
  if (!round || !roundPda) {
    // An expected transient, not a fault: a round mid-undelegation is briefly readable through
    // neither route. Warned and skipped rather than thrown, because throwing would put a red
    // `lastError` in the status file and start an exponential backoff for a routine race that the
    // next pass resolves on its own.
    warn(`round #${state.roundCounter} was not readable this pass (likely mid-undelegation) — re-deriving next pass`);
    return;
  }

  switch (round.phase) {
    case Phase.Lobby: return driveLobby(ctx, state, round, roundPda);
    case Phase.Drawing: return driveDrawing(ctx, state, round, roundPda);
    case Phase.Fight: return driveFight(ctx, state, round, roundPda);
    case Phase.Settled: return driveSettled(ctx, state, round, roundPda);
    case Phase.Abandoned: return driveAbandoned(ctx, state, round, roundPda);
    default:
      throw new Error(`round #${round.roundNo} reports phase ${round.phase}, which is not one of ${PHASE_NAME.join("/")}`);
  }
}

async function initArena(ctx: KeeperContext): Promise<void> {
  warn(`no arena account at ${ctx.client.arenaPda.toBase58()} — initialising it with this keeper's operator as authority`);
  await ctx.client.send(
    roundIx.initArena(ctx.client.program, {
      arena: ctx.client.arenaPda,
      authority: ctx.operator.publicKey,
      feeBps: ARENA_FEE_BPS,
    }),
    ctx.operator,
    "init_arena",
  );
}

async function driveLobby(
  ctx: KeeperContext,
  state: KeeperChainState,
  round: RawRoundAccount,
  roundPda: PublicKey,
): Promise<void> {
  // NO NEXT-LOBBY TIME HERE. A lobby's countdown is either the chain's own `lobby_closes_at` or the
  // keeper's `entriesCloseAt`; publishing a next-lobby time as well would be a third countdown
  // competing with whichever of those is authoritative.
  ctx.publisher.setNextLobbyOpensAt(null);
  // CLEARED AT THE TOP, RE-PROPOSED BELOW ONCE THIS ROUND'S PLAN EXISTS — and the clearing is not
  // tidiness. The proposal is a publisher field that survives passes, `honestEntriesCloseAt` only
  // refuses it outside `Lobby`, and this function has early returns above the point where the plan is
  // computed (an undelegated round takes one). Without this, round N's close time would be published
  // beside round N+1's freshly-opened lobby for as long as the delegation took to land: a countdown
  // in the past, attached to a round it was never about.
  ctx.publisher.setEntriesCloseAt(null);

  const lobbyClosesAt = Number(round.lobbyClosesAt.toString());
  const { nowSec } = state;

  if (state.roundDelegated === false) {
    // THE BASE-LAYER OWNER LAGS THE DELEGATION. Before concluding the hand-off was lost, ask the
    // router, which knows the delegation record itself rather than the ownership flip that follows it.
    // Without this check a slow flip meant re-sending `delegate_round` on an already-delegated
    // account, which fails, which puts a red error in the status file for a round that is fine.
    if (await ctx.client.routerSaysDelegated(roundPda)) {
      info(`round #${round.roundNo} is delegated per the router; waiting for the base-layer owner to catch up`);
      return;
    }
    // RECOVERY, and it is the same instruction for two different reasons — both worth naming, because
    // the log is where an operator finds out which one happened.
    if (lobbyIsDead(round.fighterCount, lobbyClosesAt, nowSec)) {
      warn(`round #${round.roundNo} is a DEAD LOBBY that was never delegated. abandon_round ends in a`);
      warn(`commit_and_undelegate CPI, which has nothing to undelegate on a base-layer account and fails`);
      warn(`with an error that says nothing about delegation (scripts/admin-abandon-round.mjs documents`);
      warn(`this). Delegating it now purely so it can reach its terminal state.`);
    } else {
      warn(`round #${round.roundNo} is in Lobby but is NOT delegated — nobody can enter it. delegate_round`);
      warn(`was lost between passes (or the keeper died between it and open_round); sending it now.`);
    }
    return delegateRound(ctx, roundPda, BigInt(round.roundNo.toString()));
  }

  // THE ONE GENUINELY NEW PIECE OF MEMORY IN THIS PROCESS, and it is stamped here because here is
  // where a real fighter is first VISIBLE. The program stamps no per-fighter entry time — a `Fighter`
  // row is a wallet, a side, a stake and some hp — so "when did the first real player arrive" cannot
  // be derived from the round account at any price. It is latched per round, exactly like
  // `settledObservedAtSec`, and it has the same one-directional error: a restart mid-grace re-stamps
  // it to now, which only ever EXTENDS the window a player has to enter. Never shortens it.
  const split = ctx.bank.classify(round);
  if (split.realCount > 0 && ctx.timeline.firstRealEntryObservedAtSec === null) {
    ctx.timeline.firstRealEntryObservedAtSec = nowSec;
    if (ctx.options.holdOpen) {
      ok(`a real player is in round #${round.roundNo} — entries close in ${REAL_PLAYER_GRACE_SECONDS}s, then the fight starts`);
    }
  }

  const plan = planLobby({
    nowSec,
    lobbyClosesAt,
    fighterCount: round.fighterCount,
    realFighterCount: split.realCount,
    firstRealEntryObservedAtSec: ctx.timeline.firstRealEntryObservedAtSec,
    holdOpen: ctx.options.holdOpen,
    houseOnly: ctx.options.houseOnlyRounds,
    scheduleCloseRetryAfterSec: ctx.timeline.scheduleCloseRetryAfterSec,
  });
  ctx.publisher.setEntriesCloseAt(plan.entriesCloseAt);

  switch (plan.step.kind) {
    case "abandon":
      return abandonRound(ctx, state, round, roundPda);
    case "close":
      // The permissionless close — the deadline has passed (or the lobby filled), and the program's
      // own rule is what permits it. `authority: null` says so in the transaction itself.
      return drawSeed(ctx, round, roundPda, { kind: "deadline" });
    case "closeEarly":
      // THE OPERATOR CHOSE THIS MOMENT, and the transaction is self-describing about it: an
      // `authority` account present means a person turned up and the keeper started their fight; the
      // same instruction with it absent means a clock ran out.
      return drawSeed(ctx, round, roundPda, {
        kind: "authority", signer: ctx.operator.publicKey, because: "a real player is in",
      });
    case "closeToSchedule":
      return closeLobbyOntoSchedule(ctx, state, round, roundPda, lobbyClosesAt);
    case "waitForFighters":
      // Not thrown and not sent: `enough_to_fight` binds on the authority path too, so closing now
      // would be a transaction that exists only to be rejected. Logged on a throttle because the
      // realistic cause is a drained house wallet, which fails on every pass — and `lastError` is
      // already carrying that, from `fieldHouseFighters`.
      if (nowSec - ctx.lastHoldLogSec >= HOLD_LOG_INTERVAL_SECONDS) {
        ctx.lastHoldLogSec = nowSec;
        warn(`round #${round.roundNo} has a real player but only ${round.fighterCount} fighter(s) — it cannot be drawn until the house is in`);
      }
      break;
    case "wait":
      if (plan.heldOpen && nowSec - ctx.lastHoldLogSec >= HOLD_LOG_INTERVAL_SECONDS) {
        // A held lobby is silent for as long as an hour, and silence in a log is indistinguishable
        // from a stopped process. This says what is being waited for and what it is costing (nothing).
        ctx.lastHoldLogSec = nowSec;
        const held = nowSec - Number(round.lobbyOpenedAt.toString());
        info(`holding round #${round.roundNo} open for players — ${fmtDuration(held)} so far, ${round.fighterCount} house fighter(s), nothing spent while waiting`);
      }
      break;
  }

  return fieldHouseFighters(ctx, state, round, roundPda, plan);
}

async function delegateRound(ctx: KeeperContext, roundPda: PublicKey, roundNo: bigint): Promise<void> {
  // The validator is PINNED to the one chosen at boot. Not a nicety: MagicBlock's ER validators clone
  // a program's bytecode on first use and do not re-clone it after a base-layer upgrade, so the
  // router's default choice may be running old code. See `delegateRound` in src/chain/round.ts and
  // `pickValidator` in scripts/erValidator.ts.
  const outcome = await ctx.client.send(
    roundIx.delegateRound(ctx.client.program, {
      arena: ctx.client.arenaPda,
      round: roundPda,
      authority: ctx.operator.publicKey,
      roundNo,
      validator: ctx.validator.identity,
    }),
    ctx.operator,
    `delegate_round #${roundNo}`,
  );
  if (!outcome.sent) return;
  if (await ctx.client.waitForDelegation(roundPda, DELEGATION_WAIT_SECONDS)) {
    ok(`round #${roundNo} is ER-delegated — players and the house can enter`);
  } else {
    // Not thrown: the next pass asks the router before concluding anything, so a slow ownership flip
    // costs a log line rather than a duplicate transaction.
    warn(`round #${roundNo}'s delegation has not shown up on the base layer yet — the next pass will re-check`);
  }
}

async function fieldHouseFighters(
  ctx: KeeperContext,
  state: KeeperChainState,
  round: RawRoundAccount,
  roundPda: PublicKey,
  plan: LobbyPlan,
): Promise<void> {
  if (state.nowSec < ctx.timeline.houseRetryAfterSec) return;

  const { entries, split, houseTarget } = plannedHouseEntries(
    ctx.bank, round, state.roundCounter, state.nowSec,
    { drawAt: plan.drawAt, emptyRoom: ctx.emptyRoom },
  );
  if (entries.length === 0) return;

  // ONE LINE PER PASS, AND THERE ARE NOW MANY PASSES. The house arrives on a schedule spread across
  // the whole entry window, so this fires up to forty times in a round that fights instead of once or
  // twice. It is SHORT for that reason, because forty long lines is a log nobody reads and forty short
  // ones is a picture of the room filling up.
  //
  // AND IT IS NOW GATED ON THE MODE, WHICH IS THE SENTENCE DIRECTLY ABOVE IT CEASING TO BE TRUE. This
  // line used to defend forty repetitions on the grounds that a round which actually fights is rare.
  // Under house-only EVERY round fights: at thirty-nine arrivals across ~430 rounds a day that is
  // roughly seventeen thousand lines a day, burying the reclamation signal this mode exists to read
  // under the noise of the mode itself.
  //
  // SO THE GATE IS ABOUT THE POLICY AND NOT ABOUT THE FIGHTER COUNT, and spelling it `realCount > 0`
  // alone would have been a change to the DEFAULT keeper rather than to the mode that motivated it.
  // Under `"unfightable"` the one entry an idle keeper ever plans is the lone treasury-rule fighter
  // walking into an empty room — `realCount` is zero for exactly that entry — so a bare count gate
  // would have silenced the only per-entry line a default keeper produces at all, and "unsetting the
  // flag restores today's behaviour exactly" would have been false. The disjunct keeps it: every entry
  // is logged under `"unfightable"`, as it always was, and under `"house-only"` only the rounds
  // somebody actually walked into are.
  //
  // NOTHING IS LOST THAT WAS NOT ALREADY RECOVERABLE. The forensics this line provides — who went in,
  // on which side, at what stake, how long before the bell — are about a round somebody PLAYED, which
  // is exactly the population this gate keeps under house-only. A house-only round's fill is fully
  // determined by `roundNo` through `mix`, so it is re-derivable from the round number alone months
  // later with no log at all; that is the property `houseStake` and `arrivalsDueBy` were made
  // deterministic for, and this is the first thing to actually spend it.
  //
  // THE SHORT-BOARD WARN BELOW IS NOT GATED. That one is a fault rather than a narration, and a
  // house-only round can come up short exactly as any other can.
  if (split.realCount > 0 || ctx.emptyRoom === "unfightable") {
    const bell = plan.drawAt - state.nowSec;
    const first = split.houseCount + 1;
    const last = split.houseCount + entries.length;
    // The `cover` fighter outranks the target — a one-sided lobby gets a bot on the empty side even
    // when the board policy wants no house fighters at all — so the denominator is whichever is
    // larger, or that entirely correct plan would log itself as "house fighter 1/0".
    const board = Math.max(houseTarget, last);
    info(entries.length === 1
      ? `house fighter ${first}/${board} going in ${c.d}(side ${entries[0]!.side}, $${unitsToUsd(entries[0]!.stake)}) — ${bell}s to the bell${c.x}`
      : `house fighters ${first}-${last}/${board} going in ${c.d}(${entries.length} at once, ${split.realCount} real in the room) — ${bell}s to the bell${c.x}`);
  }
  // SPREAD ACROSS PASSES, DELIBERATELY, WHICH IS THE OPPOSITE OF WHAT THIS USED TO SAY. Bringing the
  // house up to its board was one logical action stepped in at a fixed lead; it is now an arrival
  // schedule, and each pass sends only what has just come due. What has NOT changed is that whatever
  // this pass owes goes out CONCURRENTLY and each entry is individually fault-tolerant — see
  // `enterHouseFighters`, which is also where the catch-up case after a stall is argued.
  //
  // THE RETRY BACKOFF NOW STALLS THE TRICKLE FOR THREE SECONDS RATHER THAN THE WHOLE FILL, and it
  // SELF-HEALS, because the schedule is in absolute time rather than in "how many have I sent". Three
  // seconds of backoff means the next pass finds three seconds' worth of arrivals due and sends them
  // together: a stall COMPRESSES the next batch instead of shifting every later arrival back. The
  // longer window also gives a transient failure many more attempts than the old twelve-second fill did.
  const result = await enterHouseFighters(
    ctx.client,
    ctx.client.program,
    { arenaPda: ctx.client.arenaPda, roundPda, drawAt: plan.drawAt },
    entries,
  );
  // A SHORT BOARD IS AN ERROR, HOWEVER IT CAME UP SHORT. `failed` means a transaction was rejected;
  // `dropped` means the lobby will be drawn before the entry could land, so nothing was sent. They have
  // different causes and the same symptom — an arena thinner than the policy asked for — and only one
  // of them used to be reported. `dropped` was invisible: it warned, `lastError` stayed null, and the
  // status file showed a healthy keeper next to a board that had drawn at six instead of ten, which is
  // indistinguishable from the empty-arena complaint this whole policy exists to answer.
  const short = result.failed + result.dropped;
  if (short > 0) {
    // The retry backoff is keyed on `failed` alone. A dropped entry is not a wallet that has run dry —
    // it is a lobby that ran out of clock — and backing off would only make the NEXT round's fill late
    // as well, for a condition that has already resolved itself by then.
    if (result.failed > 0) ctx.timeline.houseRetryAfterSec = state.nowSec + HOUSE_ENTRY_RETRY_SECONDS;
    // THE DETAIL GOES TO THE LOG; ONLY THE FACT THAT SOMETHING WENT WRONG IS PUBLISHED.
    //
    // The operator signal is real and unchanged: a house wallet that has run dry fails every entry of
    // every round without throwing, so a `lastError` that stayed null would leave the arena quietly
    // emptying while every lobby died under-subscribed — the exact 3am failure this file's design
    // exists to make impossible to have silently. What changed is where the numbers go. The published
    // message used to interpolate `entries.length`, which is a count of the arena's OWN fighters: the
    // same disclosure the round's `houseFighterCount` was removed for, arriving through a field with
    // no "house" in its name. See `recordError` for the rule that came out of that.
    //
    // Nothing is lost internally. Fly logs are the keeper's own and are not published, so the line
    // below carries the whole story — how many, of how many, in what way, on which round.
    const how = result.dropped === 0 ? "failed"
      : result.failed === 0 ? "ran out of lobby time"
      : `failed (${result.failed}) or ran out of lobby time (${result.dropped})`;
    warn(`${short} of ${entries.length} house entries ${how} on round #${round.roundNo}`);
    // `entry-fill`, not `house-enter`. The context string is published, so the VOCABULARY is published
    // too — and a keeper announcing that it has a "house-enter" step is announcing that some of the
    // fighters are its own. It names the keeper's job (filling a lobby's entries) rather than whose
    // entries they are, which is the same fact an operator needs and none of the fact a reader does
    // not get to have.
    ctx.publisher.setLastError({ at: state.nowSec, context: "entry-fill" });
  }
}

/** WHO IS PERMITTED TO CLOSE THIS LOBBY, AND — WHEN THAT IS THE AUTHORITY — WHY IT IS CHOOSING NOW.
 *
 *  ONE PARAMETER RATHER THAN A KEY AND A SEPARATE REASON, so the two cannot disagree. It used to be a
 *  bare `PublicKey | null`, which was enough while a present `authority` meant exactly one thing: a
 *  real player had turned up. There is now a second reason to sign one (`closeLobbyOntoSchedule`), and
 *  a nullable key plus a free-standing sentence is a pair somebody eventually gets the wrong way round
 *  — a log line claiming a player is in the room, on a round nobody has walked into, which is worse
 *  than no line at all. Here the sentence rides WITH the key and the permissionless case has nowhere
 *  to put one. */
type LobbyClose =
  /** THE PERMISSIONLESS CLOSE. The deadline has passed (or the lobby is full) and the program's own
   *  rule permits anyone to send this. Byte-for-byte the call this has always been. */
  | { kind: "deadline" }
  /** THE AUTHORITY EARLY CLOSE. The arena's authority is choosing this moment, and `because` is the
   *  clause the log needs in order to say WHICH choice this was. It bypasses the deadline; it cannot
   *  touch the outcome, because the seed is requested BY this instruction and delivered afterwards by
   *  `callback_seed`, so at the instant of choosing, the seed does not exist for anyone. */
  | { kind: "authority"; signer: PublicKey; because: string };

/** Close the lobby and ask the oracle for the seed.
 *
 *  `close` is the ENTIRE difference between the ways a lobby ends, and it is passed rather than
 *  inferred so the call site has to say which one this is — see `LobbyClose`.
 *
 *  THERE IS NO FALLBACK FROM ONE TO THE OTHER, deliberately. A key that is not the arena's authority
 *  fails with `NotTheAuthority` — a true statement about the key — and retrying without the authority
 *  account would answer it with `LobbyStillOpen`, a statement about the clock, for a problem that has
 *  nothing to do with the clock. The program's authors put a distinct error there on purpose; a
 *  retry here would throw it away. */
async function drawSeed(
  ctx: KeeperContext,
  round: RawRoundAccount,
  roundPda: PublicKey,
  close: LobbyClose,
): Promise<void> {
  // DIRECT TO THIS ROUND'S OWN ER VALIDATOR, never through the generic router. The transaction's
  // writable set includes the ephemeral VRF queue, whose delegation record names the SYSTEM PROGRAM
  // as its authority — the multi-validator router cannot place that and refuses the whole
  // transaction with "accounts delegated to different ER nodes". Full account in
  // src/chain/sendTx.ts's "SDK SURPRISE #2".
  const fqdn = await ctx.client.roundValidatorFqdn(roundPda);
  const authority = close.kind === "authority" ? close.signer : null;
  info(close.kind === "authority"
    ? `closing the lobby early with ${round.fighterCount} fighters — ${close.because} — drawing the seed via ${fqdn}`
    : `lobby closed with ${round.fighterCount} fighters — drawing the seed via ${fqdn}`);
  // Any 32 bytes satisfy the on-chain format: the client seed is mixed into the VRF request, and the
  // seed itself comes from the oracle, not from anything chosen here.
  const clientSeed = crypto.getRandomValues(new Uint8Array(32));
  const outcome = await ctx.client.send(
    roundIx.closeLobbyAndDraw(ctx.client.program, {
      payer: ctx.operator.publicKey,
      round: roundPda,
      arena: ctx.client.arenaPda,
      clientSeed,
      // `undefined` rather than `null` for the permissionless case: the builder turns an absent
      // authority into the explicit `null` Anchor's optional-account resolver requires.
      authority: authority ?? undefined,
    }),
    // The operator signs either way — it is the fee payer on both paths and, on the early one, the
    // arena authority whose signature IS the permission.
    ctx.operator,
    `close_lobby_and_draw #${round.roundNo}${authority ? " (authority early close)" : ""}`,
    { endpoint: fqdn },
  );
  if (outcome.sent) {
    ctx.timeline.drawRequestedAtMs = Date.now();
    ctx.refreshAfterStep = true;
  }
}

/** BRING A LOBBY OPENED UNDER AN OLDER POLICY ONTO THE HOUSE-ONLY SCHEDULE — the authority early close,
 *  sent for the one reason that is not a real player arriving.
 *
 *  THE DECISION IS NOT HERE. `scheduleCloseIsDue` in `lobbyPolicy.ts` owns every condition — the mode,
 *  the deadline comparison, `enough_to_fight`, and the backoff this function stamps — and that file's
 *  header owns the argument and the arena it was written for. What is here is the two things a pure
 *  function cannot do: stamp the backoff, and say so in the log.
 *
 *  STAMPED BEFORE THE SEND, WHICH IS THE SAME ORDERING `pollTreasury` DEFENDS AND FOR ONE MORE REASON
 *  THAN IT HAS. Stamping after would leave a send that THREW un-throttled, which is exactly the case
 *  the throttle exists for. And stamping first also covers the send that SUCCEEDS but whose phase flip
 *  the next pass has not read yet: `close_lobby_and_draw` against a round already in `Drawing` is a
 *  signature spent on an error, and the router's view of an ER write is not instantaneous.
 *
 *  IT IS NOT COUNTED AND NOT CAPPED. See `SCHEDULE_CLOSE_RETRY_SECONDS`: unlike `closeOneFinishedRound`
 *  there is no backlog behind this round to protect, so giving up is not "move on", it is "go back to
 *  being stuck for a week".
 *
 *  THE EXPLANATION IS PRINTED ONCE AND THE RETRIES ARE ONE LINE EACH, which is `wedgeAndMoveOn`'s rule
 *  and it is worth restating rather than just following: a five-line alarm repeated every backoff is
 *  how an operator learns to scroll past the loudest thing in the log, and a close that cannot land
 *  retries forever by design. The "have I already tried" question is answered by the backoff stamp
 *  itself — zero means no attempt has been made for this round — so it costs no extra state and it
 *  re-prints once after a restart, which is right: a fresh process's log has to carry its own reason. */
async function closeLobbyOntoSchedule(
  ctx: KeeperContext,
  state: KeeperChainState,
  round: RawRoundAccount,
  roundPda: PublicKey,
  lobbyClosesAt: number,
): Promise<void> {
  const firstAttempt = ctx.timeline.scheduleCloseRetryAfterSec === 0;
  ctx.timeline.scheduleCloseRetryAfterSec = state.nowSec + SCHEDULE_CLOSE_RETRY_SECONDS;
  const remaining = fmtDuration(lobbyClosesAt - state.nowSec);
  if (firstAttempt) {
    warn(`round #${round.roundNo}'s lobby does not close for another ${remaining}, which is a deadline`);
    warn(`--house-only-rounds would never have stamped — it opens ${DEFAULT_LOBBY_SECONDS}s lobbies, and this round was`);
    warn(`opened before the mode was switched on. open_round stamps lobby_closes_at once and nothing can`);
    warn(`move it, so the arena would stand still until it expired. Signing the authority early close`);
    warn(`instead; every round after this one is opened on the mode's own schedule.`);
  } else {
    warn(`round #${round.roundNo}'s off-schedule close has not landed yet — retrying it (${remaining} still on the lobby)`);
  }
  return drawSeed(ctx, round, roundPda, {
    kind: "authority",
    signer: ctx.operator.publicKey,
    because: "its deadline predates --house-only-rounds",
  });
}

async function abandonRound(
  ctx: KeeperContext,
  state: KeeperChainState,
  round: RawRoundAccount,
  roundPda: PublicKey,
): Promise<void> {
  warn(`round #${round.roundNo} expired with ${round.fighterCount} fighter(s) — it can never fight, abandoning it`);
  const outcome = await ctx.client.send(
    roundIx.abandonRound(ctx.client.program, { payer: ctx.operator.publicKey, round: roundPda }),
    ctx.operator,
    `abandon_round #${round.roundNo}`,
  );
  if (!outcome.sent) return;
  ctx.roundsAbandoned += 1;
  // The hold starts from the abandonment, not from whenever the next pass happens to notice it.
  ctx.timeline.abandonedObservedAtSec = state.nowSec;
  ctx.refreshAfterStep = true;
  // `abandon_round` commits AND undelegates in one call, exactly like `close_round` — so it deserves
  // the same confirmation. An abandoned round that never comes home is stranded and delegated
  // forever, which is the same class of leak as the Drawing wedge and was previously invisible here
  // while the settled path reported it carefully.
  if (!(await ctx.client.waitForUndelegation(roundPda, UNDELEGATE_WAIT_SECONDS))) {
    warn(`round #${round.roundNo} was abandoned but has not come home within ${UNDELEGATE_WAIT_SECONDS}s — it may be stranded and still delegated`);
  }
}

function driveDrawing(
  ctx: KeeperContext,
  state: KeeperChainState,
  round: RawRoundAccount,
  roundPda: PublicKey,
): Promise<void> {
  // No honest countdown exists here: a VRF callback lands when it lands.
  ctx.publisher.setNextLobbyOpensAt(null);

  // HOW LONG HAS THIS BEEN DRAWING? The program does not stamp the moment the draw was REQUESTED —
  // `fight_started_at` stays 0 until `callback_seed` overwrites it, which is precisely the field
  // `abandon_round`'s doc comment proposes reusing when this hole is eventually closed. So the
  // elapsed time is derived from the one timestamp the account does carry: `lobby_closes_at`, which
  // the draw cannot have preceded (`close_lobby_and_draw` refuses before the deadline).
  //
  // Chain-derived on purpose, rather than remembered from the moment this process sent the draw. A
  // remembered timestamp resets on every restart, so a keeper that crash-looped would wait 90 fresh
  // seconds each boot and never conclude anything; this derivation makes a round that has been stuck
  // for an hour visibly stuck on the FIRST pass after a boot, which is the answer an operator needs.
  //
  // Its error is bounded and known in both directions. It over-states the wait by however long the
  // keeper took to send the draw after the deadline (a second or two, so the effective VRF budget is
  // 90 seconds minus that). It under-states it for a round drawn EARLY because the lobby filled to
  // sixteen — `lobby_may_close` permits that — in which case the keeper simply waits longer than 90
  // seconds, which is the safe direction: it can delay declaring a wedge, never cause a false one.
  //
  // It is only sound because "now" is the CHAIN's clock. On an uncorrected host running 95s fast this
  // very line declared healthy draws wedged one second after making them — see `CLOCK_RESYNC_SECONDS`.
  const lobbyClosesAt = Number(round.lobbyClosesAt.toString());
  const drawingFor = state.nowSec - lobbyClosesAt;

  if (drawingFor <= DRAW_TIMEOUT_SECONDS) {
    if (drawingFor >= 10 && state.nowSec - ctx.lastDrawLogSec >= 10) {
      ctx.lastDrawLogSec = state.nowSec;
      info(`waiting on the VRF callback — ${drawingFor}s so far (giving up at ${DRAW_TIMEOUT_SECONDS}s)`);
    }
    return Promise.resolve();
  }

  return wedgeAndMoveOn(ctx, state, round, roundPda, drawingFor);
}

/** THE DRAWING WEDGE — a requirement, not an edge case.
 *
 *  `Phase::Drawing` has NO exit in the program. Only the VRF program may call `callback_seed`, so if
 *  the callback never lands (queue down, callback transaction failed, validator restarted between
 *  request and delivery) there is no instruction ANY signer can send that moves this round. That hole
 *  is documented in `abandon_round`'s own doc comment in lib.rs, along with the shape of the eventual
 *  fix, and it is not something a keeper can close from out here.
 *
 *  What the keeper CAN do is refuse to wedge alongside it. `open_round` only requires
 *  `round_no == round_counter + 1`, and the counter moved past this round the moment it was opened —
 *  so the next round opens perfectly well regardless of what phase this one is stuck in.
 *
 *  WHAT IS LEFT BEHIND, said plainly rather than left to be discovered: the round account stays
 *  DELEGATED to its ER validator forever, because the only instructions that undelegate it
 *  (`close_round`, `abandon_round`) are unreachable from `Drawing`. Its rent — ~0.0235 SOL — is
 *  PERMANENTLY LOST, and that is now the part that makes this round special rather than ordinary. On
 *  every other round the rent is float: `close_round_account` hands it back once `ROUND_RETENTION`
 *  newer rounds exist. This one can never reach a terminal phase, so it can never be swept, so it can
 *  never be closed (COST-MODEL §4.2) — the deposit is gone and the account never comes home. And if
 *  the callback arrives LATE it will move this round to `Fight`, where
 *  nobody is watching: no keeper is following it any more, so nothing will tick it and nothing will
 *  resolve it, and it will sit there past the bell indefinitely. `resolve` is permissionless, so a
 *  human can settle such a round by hand afterwards; the keeper does not, because chasing rounds it
 *  has walked away from is exactly the memory-of-past-state this design refuses to keep. */
async function wedgeAndMoveOn(
  ctx: KeeperContext,
  state: KeeperChainState,
  round: RawRoundAccount,
  roundPda: PublicKey,
  drawingFor: number,
): Promise<void> {
  const roundNo = BigInt(round.roundNo.toString());
  // The alarm is raised ONCE per wedged round. If `open_round` below then fails — an RPC blip, a
  // balance problem — the next pass re-enters this function, and re-printing a six-line alarm on a
  // one-second cadence is how an operator learns to scroll past the loudest line in the log.
  if (ctx.publisher.addWedgedRound(Number(roundNo))) {
    error(`ROUND #${roundNo} IS WEDGED IN Drawing — no VRF callback after ${drawingFor}s (limit ${DRAW_TIMEOUT_SECONDS}s).`);
    error(`  Phase::Drawing has no exit in the program: only the VRF program may call callback_seed, so`);
    error(`  no signer has an instruction left to send for this round. This is the known hole documented`);
    error(`  in abandon_round's doc comment in lib.rs, not something this keeper can fix.`);
    error(`  ${roundPda.toBase58()} stays delegated and its rent is never reclaimed. A late callback would`);
    error(`  move it to Fight with nobody watching; resolve is permissionless, so it can be settled by`);
    error(`  hand afterwards. The keeper is opening the next round and moving on.`);
    ctx.publisher.publish();
  }
  await openNextRound(ctx, state.roundCounter + 1n);
}

async function driveFight(
  ctx: KeeperContext,
  state: KeeperChainState,
  round: RawRoundAccount,
  roundPda: PublicKey,
): Promise<void> {
  // A fight ends when it ends. Publishing a next-lobby guess here is exactly the invented number this
  // project keeps deleting.
  ctx.publisher.setNextLobbyOpensAt(null);

  if (ctx.timeline.fightObservedAtMs === null) {
    ctx.timeline.fightObservedAtMs = Date.now();
    const split = ctx.bank.classify(round);
    ok(`fight is live — ${round.fighterCount} fighters (${split.realCount} real, ${split.houseCount} house), pot ${round.pot}`);
  }

  const fightStartedAt = Number(round.fightStartedAt.toString());
  const elapsed = state.nowSec - fightStartedAt;
  // THE BELL NEEDS THE SKEW MARGIN; THE OTHER BRANCH DOES NOT. `fight_started_at` is stamped by the ER
  // and `elapsed` is measured against our (chain-corrected) clock, so a couple of seconds of residual
  // disagreement at exactly the bell would burn the whole three-attempt retry ladder on every
  // timed-out round. `fightIsOver` is a fact about the fighters rather than about a clock, so it is
  // correct the instant it is true.
  const bellHasRung = elapsed >= FIGHT_TIMEOUT_SECONDS + CLOCK_SKEW_MARGIN_SECONDS;
  if (fightIsOver(round) || bellHasRung) {
    return resolveRound(ctx, round, roundPda, bellHasRung);
  }

  // SEND NOTHING WE DO NOT NEED TO. The on-chain cursor only moves at whole-second boundaries (the
  // program derives it from `Clock::unix_timestamp`), so a tick with no backlog is a transaction that
  // knowingly does nothing — the same dishonesty as a demo firing transactions to look busy. Same
  // check `src/chain/useFightTicker.ts` makes in the browser.
  const cursor = canonicalCursor(fightStartedAt, round.fighterCount, state.nowSec);
  const backlog = cursor - Number(round.tickCount.toString());
  if (backlog <= 0) return;

  try {
    await ctx.client.send(
      roundIx.tick(ctx.client.program, { round: roundPda, steps: backlog }),
      ctx.operator,
      `tick #${round.roundNo} +${backlog} steps -> cursor ${cursor}`,
    );
  } catch (e) {
    // A tick failing is not fatal and must not become one: the next pass covers the same backlog, and
    // `resolve` catches the whole fight up on its own regardless. Ticking is a liveness helper, not a
    // dependency — which is the property that stops it becoming a new way for a round to get stuck.
    warn(`tick failed (harmless — the next pass covers the same backlog): ${describeError(e)}`);
  }
}

/** Mirrors `fight_is_over` in lib.rs: one side has nobody still standing, where an EXTRACTED fighter
 *  counts as out of the ring (`dead == 1`).
 *
 *  Evaluated against the STORED fighters, which can lag the canonical cursor by up to a second. That
 *  error only runs one way, and it is the safe way: fighters only ever leave the ring, so if the
 *  stored state says the fight is over then the chain — which runs its own `catch_up` before
 *  checking — will agree. The converse can be late, which is why the keeper ticks every second: a
 *  current stored state is what keeps `resolve` from waiting for the bell on a fight that is already
 *  decided. */
function fightIsOver(round: RawRoundAccount): boolean {
  let side0 = 0;
  let side1 = 0;
  for (const fighter of round.fighters.slice(0, round.fighterCount)) {
    if (fighter.dead !== 0) continue;
    if (fighter.side === 0) side0 += 1; else side1 += 1;
  }
  return side0 === 0 || side1 === 0;
}

/** `FightNotOverYet`'s number as the DEPLOYED program defines it, or `undefined` when the IDL cannot
 *  answer — the second half of the fix documented on `failedWith` in log.ts.
 *
 *  READ, NEVER WRITTEN DOWN. It is 6013 (`0x177d`) today, and a literal `6013` here would go stale the
 *  moment a variant is inserted above it in `ArenaError` — silently, because the stale number still
 *  matches SOMETHING. `loadIdl()` reads `public/idl/bulls_arena.json`, which `scripts/idlgen.py`
 *  derives from lib.rs's `#[error_code]` enum in DECLARATION ORDER — "which IS their code", as its
 *  own `error_names()` puts it — so the enum and this lookup are generated from one source.
 *
 *  THAT IS BETTER THAN A LITERAL, NOT A GUARANTEE, and the difference is worth stating because it is
 *  easy to read the paragraph above as one. `idlgen.py`'s patch step APPENDS only names the IDL does
 *  not already carry ("appended so no existing code moves"), and its `--verify` pass checks
 *  discriminators and doc comments — NOT error codes. So a variant inserted mid-enum shifts the Rust
 *  numbering while the existing IDL entries stay where they were, and nothing in the toolchain
 *  objects. `src/v2/data/programError.ts`'s header records the same gap from the browser's side and
 *  names the step that closes it (`idlgen.py --deploying`, a human's to remember). What this function
 *  buys is that the number is sourced from the artefact the keeper actually loads rather than from a
 *  reader's memory of lib.rs — which is the failure mode a literal guarantees and this one merely
 *  permits.
 *
 *  NOT CACHED HERE, DELIBERATELY. `loadIdl()` holds its own module-level cache and `createChainClient`
 *  has already populated it via `createProgram` before any round is driven, so this is a read of a
 *  resolved value and costs a microtask. A cache in this directory would also be a second piece of
 *  mutable module state in `scripts/keeper/`, and log.ts's header makes a specific claim that there is
 *  exactly one (its cosmetic round tag). Borrowing a cache that already exists keeps that claim true.
 *
 *  IT CANNOT THROW, and that matters more than it looks: this is called from inside a `catch`, and an
 *  IDL read that rejected there would replace the chain's refusal with a filesystem error — the
 *  original failure lost, and a misleading one propagated into the main loop's error handler. On
 *  `undefined`, `failedWith` degrades to matching the NAME alone, which is precisely the behaviour the
 *  keeper had before this fix: correct on the base layer, blind on the rollup, and never wrong. */
async function fightNotOverYetCode(): Promise<number | undefined> {
  try {
    return errorCodeOf((await loadIdl()).errors, "FightNotOverYet");
  } catch {
    return undefined;
  }
}

async function resolveRound(
  ctx: KeeperContext,
  round: RawRoundAccount,
  roundPda: PublicKey,
  byTimeout: boolean,
): Promise<void> {
  // "resolving", not "settling": a call here can grind rather than finish (see the comment on
  // `outcome.sent` below), so this log fires once per attempt at settling, not once per settle.
  info(byTimeout
    ? `the bell has rung (${FIGHT_TIMEOUT_SECONDS}s) — resolving round #${round.roundNo}`
    : `one side has nobody standing — resolving round #${round.roundNo}`);

  for (let attempt = 1; attempt <= RESOLVE_RETRY_ATTEMPTS; attempt++) {
    try {
      const outcome = await ctx.client.send(
        roundIx.resolve(ctx.client.program, { payer: ctx.operator.publicKey, round: roundPda }),
        ctx.operator,
        `resolve #${round.roundNo}`,
      );
      if (outcome.sent) {
        // `settledObservedAtSec` is NOT stamped here, even though this line only runs after a `resolve`
        // that landed. THE FIX THIS WAS: `resolve` now GRINDS rather than finishing in one call — a
        // neglected round can carry up to `finalCursor(fighterCount)` steps of backlog (17,280 at 48
        // fighters) and each call advances at most `MAX_STEPS_PER_CALL` (3,000), committing only once
        // it genuinely catches the fight up. A "sent" resolve is therefore not "the round is settled";
        // it can be one grind of up to six, and this round is still reading `Fight` on the very next
        // poll. Stamping the result-hold start here would count down a hold for a result that does not
        // exist yet. `driveSettled` below is the honest place: it stamps the first pass that OBSERVES
        // `Settled`, which is exactly the moment a result exists to hold, whether that took one
        // `resolve` or six. `refreshAfterStep` still belongs here — a sent resolve changed on-chain
        // state (tick_count at minimum) even when it did not settle, so the next pass should re-read
        // rather than act on the snapshot this one started with.
        ctx.refreshAfterStep = true;
      }
      return;
    } catch (e) {
      // BY NAME **OR** BY NUMBER, and the number is not optional here. This send goes through the
      // Magic Router against a round that is delegated by construction, so the refusal comes back
      // from the Ephemeral Rollup — which returns NO LOGS, and therefore no `Error Code:` line and no
      // error name anywhere in the throw. The hex code is the only signal there is. Two previous
      // forms of this guard were blind to it and both reduced this three-attempt retry to one:
      // `instanceof anchor.AnchorError` (verify-session-real.mjs step 12) and the log-only regex that
      // replaced it. The full account, with the captured wire shape, is on `failedWith` in log.ts;
      // `fightNotOverYetCode` above is why the 6013 is read off the IDL instead of written here.
      //
      // The `await` is on the FAILURE path only — nothing resolves an error number until something
      // has already failed — and `fightNotOverYetCode` cannot throw, so it cannot displace `e`.
      if (!failedWith(e, "FightNotOverYet", await fightNotOverYetCode())) throw e;
      if (attempt < RESOLVE_RETRY_ATTEMPTS) {
        warn(`resolve refused as too early (attempt ${attempt}/${RESOLVE_RETRY_ATTEMPTS}) — waiting ${RESOLVE_RETRY_WAIT_SECONDS}s`);
        await sleep(RESOLVE_RETRY_WAIT_SECONDS * 1_000);
        continue;
      }
      // Not an error to record: the ER's clock is simply a beat behind ours, and the next pass tries
      // again in a second from freshly-read state. Recording it would put a red line in the status
      // file for something that is about to succeed on its own.
      warn(`resolve still refused after ${RESOLVE_RETRY_ATTEMPTS} attempts — the next pass will try again`);
      return;
    }
  }
}

async function driveSettled(
  ctx: KeeperContext,
  state: KeeperChainState,
  round: RawRoundAccount,
  roundPda: PublicKey,
): Promise<void> {
  // THE ONLY PLACE THIS GETS STAMPED, NOT JUST A FALLBACK FOR IT. `resolveRound` used to stamp it
  // itself the instant a `resolve` transaction landed, with this as a fallback for a keeper that
  // booted into an already-settled round and never saw one land. That stopped being honest once
  // `resolve` started GRINDING (a neglected round needs up to six calls, one `MAX_STEPS_PER_CALL` of
  // backlog per call, to genuinely catch up) — a landed `resolve` no longer implies a settled round,
  // so `resolveRound` no longer stamps at all, and every path to a result now passes through here.
  //
  // LATCHED, NOT RE-STAMPED, regardless: this stamps the first pass that OBSERVES `Settled`, once,
  // and it only ever extends the hold. What it must never do is stamp again on a later pass of the
  // same round: that moves the published countdown backwards, which is the one thing the result hold
  // exists not to do.
  if (ctx.timeline.settledObservedAtSec === null) ctx.timeline.settledObservedAtSec = state.nowSec;
  const opensAt = ctx.timeline.settledObservedAtSec + RESULT_HOLD_SECONDS;

  // THE ROUND STAYS PUBLISHED THROUGHOUT THE HOLD, and that is load-bearing rather than incidental:
  // `keeperCountdown` in src/v2/data/keeperStatus.ts returns `none` when `status.round` is null, so a
  // "next lobby in 0:08" only appears while the just-finished round is still in the file alongside
  // `nextLobbyOpensAt`. Clearing `round` between rounds would still parse, and the countdown would
  // simply never show — a silent failure. The main loop publishes whatever the chain reports, which
  // during the hold is this Settled round; nothing here nulls it out.
  //
  // The value proposed here is reconciled at write time by `honestNextLobbyOpensAt`, which latches it
  // per round and refuses to publish it beside a round that is not in a hold phase. There is
  // deliberately no "slip it later because close_round overran" path: if the hold is overrun the
  // latched time simply passes, the countdown stops being drawn, and the next round opens as soon as
  // the work finishes. Moving the promise later because the keeper was slow is the same lie in the
  // other direction.
  ctx.publisher.setNextLobbyOpensAt(opensAt);

  if (state.roundDelegated === true) {
    const outcome = await ctx.client.send(
      roundIx.closeRound(ctx.client.program, { payer: ctx.operator.publicKey, round: roundPda }),
      ctx.operator,
      `close_round #${round.roundNo}`,
    );
    if (!outcome.sent) return;

    // Waiting for the undelegate commit to reach the base layer, bounded. Overrunning it is not a
    // failure: the next pass sees a Settled round still owned by the Delegation Program and sends
    // `close_round` again. That re-send is the one duplicate transaction this keeper can produce, it
    // costs a signature, and it is named here rather than pretended away.
    if (!(await ctx.client.waitForUndelegation(roundPda, UNDELEGATE_WAIT_SECONDS))) {
      warn(`round #${round.roundNo} has not come home within ${UNDELEGATE_WAIT_SECONDS}s — the next pass may re-send close_round`);
    }

    // Counted once per round, even if this is the second `close_round` for it — see
    // `completedCounted`. Printing the summary twice would be just as wrong as counting it twice.
    if (!ctx.timeline.completedCounted) {
      ctx.timeline.completedCounted = true;
      ctx.roundsCompleted += 1;
      ctx.publisher.setRoundsCompleted(ctx.roundsCompleted);
      await summariseRound(ctx, round, roundPda);
      if (ctx.options.rounds !== null && ctx.roundsCompleted >= ctx.options.rounds) {
        ok(`--rounds ${ctx.options.rounds} satisfied — stopping cleanly`);
        ctx.stop = true;
      }
    }
    return;
  }

  // THE ROUND IS HOME. The undelegation has landed (that is what `roundDelegated === false` means
  // here), so the base layer owns the account again and its house take is finally reachable. Done
  // inside the result hold, which is dead time the keeper already spends waiting.
  await sweepHouseTake(ctx, state, round, roundPda);

  if (state.nowSec < opensAt) return; // holding, so the result can be read before the arena moves on
  return openNextRound(ctx, state.roundCounter + 1n);
}

/** MOVE A FINISHED ROUND'S HOUSE TAKE ONTO THE ARENA'S BOOKS — one more "next thing to do", derived
 *  from the chain rather than remembered.
 *
 *  Both house takes — the entry fee (`fees_collected`) and early-exit penalties
 *  (`penalties_collected`) — are recorded on the ROUND, because a rollup transaction cannot write the
 *  base-layer `Arena`. That is where they have to be COLLECTED and a useless place to READ them:
 *  "what has the house made" would otherwise mean fetching every round account ever opened and adding
 *  them up. `sweep_house_take` is the step that turns them into one number.
 *
 *  IT CANNOT RUN ANY EARLIER THAN THIS, and the reason is the account model rather than a rule
 *  somebody wrote. A delegated round's base-layer account is owned by the Delegation Program, and
 *  `Account<'info, Round>` checks the owner before anything else — so until `close_round`'s
 *  commit_and_undelegate has actually LANDED, the program cannot deserialise the round at all and the
 *  failure is an owner mismatch that says nothing about phases. Hence `state.roundDelegated === false`
 *  here: not "we sent close_round", but "the chain says it is home".
 *
 *  NOTHING IS REMEMBERED. `house_swept` is a flag on the round, so "is this owed?" is a chain read,
 *  the retry is free, and a double sweep is refused by the program rather than by a boolean in this
 *  process. Exactly how `plannedHouseEntries` treats a missing house fighter.
 *
 *  IT NEVER TAKES THE ARENA DOWN. Every failure is caught, recorded and backed off rather than
 *  thrown: this is bookkeeping, and a keeper that stopped running rounds because a ledger update
 *  failed would be trading the product for its own accounting. A round that misses its window keeps
 *  its take on the round account, where it is still readable and still sweepable later — by anyone,
 *  since the instruction is permissionless. */
async function sweepHouseTake(
  ctx: KeeperContext,
  state: KeeperChainState,
  round: RawRoundAccount,
  roundPda: PublicKey,
): Promise<void> {
  if (!ctx.features.houseTakeSweep) return;
  // `?? 0` is the true value, not a default: a program with no sweep instruction has swept nothing.
  // `round.houseSwept` is a `u8` on the wire (bytemuck can't make `bool` Pod — see `houseSwept` in
  // chain/program.ts), so it is compared against `0` here rather than tested for truthiness, matching
  // the type it actually decodes to.
  if ((round.houseSwept ?? 0) !== 0) return;
  if (state.roundDelegated !== false) return; // still delegated, or not asked — see the doc comment
  if (state.nowSec < ctx.timeline.sweepRetryAfterSec) return;

  const treasury = roundIx.treasuryPda(ctx.client.arenaPda);
  try {
    // ONE-TIME, AND ASKED HERE RATHER THAN AT BOOT. The treasury is created once per arena and
    // `sweep_house_take` fails on a missing account until it exists, so this is a precondition of the
    // sweep and belongs beside it — a boot-only check would be this process remembering an
    // observation, which is the one habit the main loop is built to do without. It costs one
    // `getAccountInfo` on the passes where a sweep is actually owed, which is once per round.
    if (!(await ctx.client.accountExists(treasury))) {
      warn(`the arena has no Treasury account yet — opening it, then sweeping round #${round.roundNo} on the next pass`);
      await ctx.client.send(
        roundIx.initTreasury(ctx.client.program, {
          arena: ctx.client.arenaPda,
          treasury,
          authority: ctx.operator.publicKey,
        }),
        ctx.operator,
        "init_treasury",
      );
      return;
    }

    const outcome = await ctx.client.send(
      roundIx.sweepHouseTake(ctx.client.program, {
        arena: ctx.client.arenaPda,
        round: roundPda,
        treasury,
        roundNo: BigInt(round.roundNo.toString()),
      }),
      ctx.operator,
      `sweep_house_take #${round.roundNo}`,
    );
    if (outcome.sent) reportSweptTake(ctx, round);
  } catch (e) {
    ctx.timeline.sweepRetryAfterSec = state.nowSec + SWEEP_RETRY_SECONDS;
    // Recorded rather than thrown — see the doc comment. Surfaced to the status file because the
    // alternative is a treasury that silently stops accruing while every round looks perfect.
    error(`sweep_house_take #${round.roundNo} failed (the take stays on the round and can be swept later): ${describeError(e)}`);
    // `take-sweep`, not `house-sweep`, and this one is renamed for CONSISTENCY rather than because it
    // leaked. The house's fee TAKE is a public on-chain concept — `house_swept` is a field on the
    // Round account and the UI already shows "House fee · per deploy" — so this context never said
    // anything about the fighter split. It is renamed anyway, because a vocabulary with one word that
    // is fine and one that is not is a rule the next person has to remember rather than read. One
    // rule: no context string names the house. The full error text stays in the log line above.
    ctx.publisher.setLastError({ at: state.nowSec, context: "take-sweep" });
  }
}

/** WHAT WAS SWEPT, AND WHOSE MONEY IT ACTUALLY WAS — the second half of which is the whole reason
 *  this is a function rather than one more line in the caller.
 *
 *  A FEE PAID BY A HOUSE WALLET IS A WASH. It moves from a bot wallet the keeper owns to a treasury
 *  the same operator owns, and reporting it as revenue is self-dealing dressed as growth. DEVLOG.md
 *  Bug #20 is exactly this, already made once and already paid for: the off-chain engine counted bot
 *  fees as treasury income, its books "grew" 1520 -> 362 UWU in forty minutes with zero real players,
 *  and the conservation audit blessed it because a fee is expected shrinkage. So every figure here is
 *  printed BESIDE the composition of the round that produced it, and a round with no real fighters
 *  says so in words rather than leaving the reader to notice the zero.
 *
 *  NO CUMULATIVE TOTAL IS PUBLISHED ANYWHERE, and that is a refusal rather than an omission. Telling
 *  real revenue from circular revenue needs the fee attributed PER WALLET, and chain state cannot do
 *  it: `Round` stores each fighter's stake NET and the fee only in aggregate, so the gross a
 *  particular wallet paid is recoverable only from the `Entered` event, which nothing here reads. The
 *  arithmetic inverse (`gross = net / (1 - bps/10000)`) is not exact against the program's own
 *  flooring. A total that mixed the two would be a confident wrong number about money, which is worse
 *  than no number — so the status file gets none, and this log line carries the split instead. */
function reportSweptTake(ctx: KeeperContext, round: RawRoundAccount): void {
  const split = ctx.bank.classify(round);
  const fees = bnOr0(round.feesCollected);
  const penalties = bnOr0(round.penaltiesCollected);
  ok(`swept round #${round.roundNo}: ${fees} fee + ${penalties} penalty units onto the arena's treasury`);
  plain(split.realCount === 0
    ? `  ${c.y}all of it is the house paying itself${c.x} ${c.d}(${split.houseCount} house fighters, no real players — not revenue; see DEVLOG.md Bug #20)${c.x}`
    : `  ${c.d}from ${split.realCount} real and ${split.houseCount} house fighter(s) — the house's own share of this is a wash, and per-wallet attribution is only in the Entered event (see DEVLOG.md Bug #20)${c.x}`);
}

async function driveAbandoned(
  ctx: KeeperContext,
  state: KeeperChainState,
  round: RawRoundAccount,
  roundPda: PublicKey,
): Promise<void> {
  // Latched for the same reason as the settled hold — see `driveSettled`.
  if (ctx.timeline.abandonedObservedAtSec === null) ctx.timeline.abandonedObservedAtSec = state.nowSec;
  // AN ABANDONED ROUND CAN STILL OWE THE HOUSE SOMETHING. It holds fewer than two fighters, but one
  // of them may have entered and paid a fee — and `sweep_house_take` accepts `Abandoned` for exactly
  // that reason. Skipping it here would forfeit that fee permanently and put `Treasury.rounds_swept`
  // permanently out of step with the arena's `round_counter`, which is the one cross-check the
  // program offers on whether the books are complete.
  await sweepHouseTake(ctx, state, round, roundPda);
  // Much shorter than the settled hold, and for a different reason: there is no result to show, so
  // this is room for the commit_and_undelegate rather than a display pause. Same retention rule as
  // `driveSettled` — the abandoned round stays published alongside the countdown.
  const opensAt = ctx.timeline.abandonedObservedAtSec + ABANDON_HOLD_SECONDS;
  ctx.publisher.setNextLobbyOpensAt(opensAt);
  if (state.nowSec < opensAt) return;
  return openNextRound(ctx, state.roundCounter + 1n);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Reclaiming rent — the backlog, one round per pass
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * CLOSE ONE FINISHED ROUND ACCOUNT PER PASS, OLDEST FIRST, AND HAND ITS RENT BACK.
 *
 * A `Round` is 3,248 bytes holding 0.023497 SOL of rent-exempt deposit, measured against v8 at
 * `MAX_FIGHTERS = 48` (COST-MODEL §1; `Round::SIZE` in lib.rs carries the byte arithmetic, and the
 * same figure was 0.008561 at sixteen fighters). Beside the ~0.00007 SOL of fees a round actually
 * spends, that deposit is very nearly the whole of what an unreclaimed round costs, and before v7
 * nothing ever reclaimed a lamport of it. This is the instruction that does — the difference between
 * ~0.030 SOL/day and ~9.96 SOL/day at 424 rounds/day, a factor of 330, which is why the burn brake
 * and `/reclamation.json` exist at all (COST-MODEL §0, §4).
 *
 * EVERY CONDITION IS ENFORCED ON CHAIN, by `check_close_permitted`: terminal phase, `house_swept`,
 * `round_no + MIN_RETAINED_ROUNDS <= round_counter`, and `has_one = authority`. The checks below are
 * NOT a second implementation of that rule — they are how the keeper avoids sending a transaction it
 * knows will be refused, which costs a signature and a log line each time. If the two ever disagree
 * the chain wins, and the keeper's failure mode is a wasted signature rather than a wrong outcome.
 * That asymmetry is the reason it is safe for this policy to default ON.
 *
 * THE CURSOR IS THE ONLY MEMORY, AND IT EXISTS TO BOUND THE WORK. This keeper's rule is that every
 * pass re-derives from the chain, and a literal reading would mean scanning from round #1 every
 * second — unbounded as history grows, on a 1Hz loop. So one number is kept: the oldest round that
 * might still be closeable. It starts at #1 on EVERY BOOT, which is what makes the pre-existing
 * backlog get picked up rather than only rounds this process opened — a keeper starting against an
 * arena with two hundred stranded rounds walks them from the beginning. It only ever moves forward,
 * so it cannot loop, and one round is examined per pass, so the cost is one account read per second
 * regardless of how much history there is.
 *
 * WHEN THE CURSOR ADVANCES, which is the whole of the logic and each case is a different fact:
 *
 *   * the account is GONE — already closed, by this keeper on a previous run or by anything else.
 *     Nothing left to do, and this is the common case while draining a backlog.
 *   * the close SUCCEEDED. Rent recovered.
 *   * the round is NOT TERMINAL. A round stuck in `Drawing` can never reach a closeable state — the
 *     program has no exit for it (see `abandon_round`'s doc comment and this README's "Known holes")
 *     — so waiting for it would hold every older round's rent hostage behind one that is never
 *     coming. It is already recorded in `wedgedRounds`; the cursor steps past it.
 *   * it is still DELEGATED. `Account<Round>` fails the owner check while the Delegation Program owns
 *     it, so no close is possible. For an old round this means an undelegation that never completed,
 *     which the phase machine only repairs for the CURRENT round — so, again, stepping past is the
 *     difference between reclaiming the rest of the backlog and reclaiming none of it.
 *   * it has failed to close `CLOSE_ATTEMPTS_PER_ROUND` times. See that constant: one round the
 *     keeper cannot fix must not be able to block every older one forever.
 *
 * AND WHEN IT DOES NOT: a terminal, undelegated, UNSWEPT round. That one is fixable, and fixing it is
 * strictly better than skipping it — the sweep is the very precondition the chain is refusing on, the
 * keeper already has the code, and the instruction is permissionless. So the sweep is sent and the
 * round is re-examined next pass, at which point it closes normally. This also quietly drains the
 * "gap between `Treasury.rounds_swept` and `round_counter`" that this README lists as a known cost of
 * a round missing its own sweep window.
 */
async function closeOneFinishedRound(ctx: KeeperContext, state: KeeperChainState): Promise<void> {
  if (!ctx.options.closeRounds || !ctx.features.roundAccountClose) return;

  // See `housekeepingIsWelcome` — never against a live fight.
  if (!housekeepingIsWelcome(state.round?.phase ?? null)) return;

  // Throttled after a failure, for the reason `SWEEP_RETRY_SECONDS` exists: the work to do is derived
  // from the chain rather than remembered, so a close that cannot succeed would be re-sent on every
  // pass at 1Hz forever.
  if (state.nowSec < ctx.closeRetryAfterSec) return;

  if (!isPastRetention(ctx.closeCursor, state.roundCounter, ROUND_RETENTION)) return; // caught up

  const roundNo = ctx.closeCursor;
  const roundPda = roundIx.roundPdaForRoundNo(roundNo, ctx.client.arenaPda);

  // Through the router, exactly as `sweepHouseTake` reaches its round: the router routes per account,
  // and an undelegated round routes to the base layer on its own. `fetchRound`'s own doc comment
  // names this caller. `fetchNullable` answers null for an account that no longer exists, which is
  // precisely the "already closed" case.
  const round = await ctx.client.fetchRound(roundNo);
  // The delegation question is only asked when there is something to ask it about, because it is an
  // extra RPC and a missing account has no owner. `decideClose` never reads `delegated` in the
  // already-closed branch, so `false` here is not a claim, it is an unused field.
  const delegated = round === null ? false : await ctx.client.isDelegated(roundPda);
  const decision = decideClose({
    // `roundCloser.ts`'s `houseSwept` is a `boolean` — this is the conversion point from the wire's
    // `u8` (see `houseSwept` in chain/program.ts). `?? 0` is the true value rather than a default: a
    // program with no sweep instruction has swept nothing.
    round: round === null ? null : { phase: round.phase, houseSwept: (round.houseSwept ?? 0) !== 0 },
    delegated,
  });

  if (decision.kind === "advance") {
    // COUNTED, NOT ONLY LOGGED, and the two `advance` reasons are counted SEPARATELY from each other
    // and from the give-up path below. Each is a different kind of loss and `/reclamation.json`
    // reports them apart for the reason `ReclamationReport` argues. `"already-closed"` records
    // nothing, because nothing was lost: that is the common case of a drained backlog.
    if (decision.because === "never-terminal") {
      // PRICED THROUGH `ROUND_RENT_LAMPORTS`, not the 0.0086 this line used to carry: that figure was
      // measured at sixteen fighters and rent moves with the seat cap. This round is now also counted
      // into `/reclamation.json`, which prices it at 0.023497 — two numbers for one loss is how a
      // reader ends up believing the smaller one.
      warn(`round #${roundNo} is ${PHASE_NAME[round!.phase]} and past the retention window — it can never be closed, so its ~${fmtSol(ROUND_RENT_LAMPORTS)} of rent is unrecoverable. Skipping it.`);
      recordCloseLoss(ctx.closeStrandedNeverTerminal, roundNo);
    } else if (decision.because === "still-delegated") {
      warn(`round #${roundNo} is terminal but still DELEGATED past the retention window — close_round_account cannot run while the Delegation Program owns it. Skipping it; its rent stays stranded.`);
      recordCloseLoss(ctx.closeStrandedStillDelegated, roundNo);
    }
    ctx.closeCursor += 1n;
    ctx.closeAttempts = 0;
    return;
  }

  if (decision.kind === "sweep-first") {
    // The cursor deliberately does NOT move: this is the one case the keeper can fix, and it comes
    // back to the same round next pass to finish the job.
    info(`round #${roundNo} is unswept, so it cannot be closed yet — sweeping it first`);
    await sweepHouseTake(ctx, state, round!, roundPda);
    return;
  }

  try {
    const outcome = await ctx.client.send(
      roundIx.closeRoundAccount(ctx.client.program, {
        arena: ctx.client.arenaPda,
        round: roundPda,
        authority: ctx.operator.publicKey,
        roundNo: BigInt(roundNo.toString()),
      }),
      ctx.operator,
      `close_round_account #${roundNo}`,
    );
    if (outcome.sent) {
      ctx.rentReclaimed += 1;
      ok(`round #${roundNo} closed — its rent deposit is back with the payer (${ctx.rentReclaimed} reclaimed this run)`);
    }
    ctx.closeCursor += 1n;
    ctx.closeAttempts = 0;
  } catch (e) {
    // Caught, never thrown. This is housekeeping: a keeper that stopped running rounds because it
    // could not reclaim rent would be trading the product for its own accounting, which is the same
    // judgement `sweepHouseTake` makes one step earlier.
    ctx.closeAttempts += 1;
    ctx.closeRetryAfterSec = state.nowSec + CLOSE_RETRY_SECONDS;
    error(`close_round_account #${roundNo} failed (attempt ${ctx.closeAttempts}/${CLOSE_ATTEMPTS_PER_ROUND}, the rent stays put and the round stays closeable): ${describeError(e)}`);
    if (ctx.closeAttempts >= CLOSE_ATTEMPTS_PER_ROUND) {
      warn(`giving up on round #${roundNo} for this run and moving to the next — one round the keeper cannot close must not hold the rest of the backlog hostage. Close it by hand if its rent matters.`);
      // The most expensive of the three, and the only one that was AVOIDABLE: this round was
      // closeable and the keeper stopped trying. Recorded so the report can put a SOL figure on the
      // deliberate part of the loss.
      recordCloseLoss(ctx.closeSkipped, roundNo);
      ctx.closeCursor += 1n;
      ctx.closeAttempts = 0;
    }
  }
}

/** THE OTHER WITNESS — `Treasury.rounds_swept` against `Arena.round_counter`, which COST-MODEL §4
 *  names in as many words as the thing to watch for the first day of continuous running.
 *
 *  IT IS NOT THE SAME QUESTION THE BRAKE ASKS, which is why both exist. A sweep is a PRECONDITION of a
 *  close, not a close: a keeper that sweeps perfectly and then fails every `close_round_account` has a
 *  sweep gap of zero and is burning 9.96 SOL/day. This one is a direct observation of the chain's own
 *  bookkeeping and is right immediately; the brake is a lagging measurement that cannot say anything
 *  at all for its first forty-five rounds. `reclamation.ts`'s header argues the pairing.
 *
 *  ON ITS OWN INTERVAL, NOT ON THE LOOP'S. The quantity moves at most once per round, so polling it
 *  every pass would be ~200 reads to observe one event, on the endpoint whose rate limit already
 *  shapes this process — see `TREASURY_POLL_SECONDS`. The throttle is stamped BEFORE the read, so a
 *  failing poll backs off with everything else rather than retrying at 1 Hz.
 *
 *  AND IT CAN NEVER TAKE THE KEEPER DOWN. The failure is swallowed and warned: this is telemetry, and
 *  a keeper that stopped running rounds because a report could not be refreshed would be trading the
 *  product for its own instrumentation — the same judgement `sweepHouseTake` and
 *  `closeOneFinishedRound` make either side of it. */
async function pollTreasury(ctx: KeeperContext, state: KeeperChainState): Promise<void> {
  // The CAPABILITY, not the account. An IDL with no `sweep_house_take` has no treasury to read and
  // nothing that would ever write one, so this is a question that cannot have an answer there.
  if (!ctx.features.houseTakeSweep) return;
  if (state.nowSec < ctx.treasuryPolledAtSec + TREASURY_POLL_SECONDS) return;
  ctx.treasuryPolledAtSec = state.nowSec;
  try {
    const treasury = await ctx.client.fetchTreasury();
    ctx.treasury = {
      roundCounter: Number(state.roundCounter),
      // Null rather than 0 for a treasury that does not exist yet — `init_treasury` runs on the first
      // sweep, so an arena can legitimately be several rounds old before there is anything to read,
      // and a zero here would publish a sweep gap equal to the whole of its history.
      roundsSwept: treasury === null ? null : Number(treasury.roundsSwept.toString()),
      polledAtSec: state.nowSec,
    };
  } catch (e) {
    // Throttled by the poll interval itself rather than by a second timer: the line can only be
    // reached once every `TREASURY_POLL_SECONDS`. The last reading stands, and `pollAgeSec` in the
    // report is what tells a reader it has stopped being refreshed.
    warn(`the treasury poll failed — ${RECLAMATION_PATH} keeps its last reading and its pollAge says how old it is: ${describeError(e)}`);
  }
}

/** Everything `reclamation.ts` is allowed to know, gathered from where the keeper already holds it.
 *  Nothing is computed here and nothing is read from the chain: every field is an observation some
 *  other part of this process already made. */
function reclamationStateOf(ctx: KeeperContext, observedAtSec: number): ReclamationState {
  return {
    observedAtSec,
    arena: ctx.treasury,
    closer: {
      cursor: Number(ctx.closeCursor),
      reclaimed: ctx.rentReclaimed,
      skipped: ctx.closeSkipped.sample,
      strandedNeverTerminal: ctx.closeStrandedNeverTerminal.sample,
      strandedStillDelegated: ctx.closeStrandedStillDelegated.sample,
      // THE COUNTS THE REPORT IS PRICED OFF, handed over beside the samples they are the totals of.
      // The samples are capped at `CLOSE_LOSS_SAMPLE` and these are not, which is the whole reason
      // `summariseReclamation` reads these and not the lengths.
      skippedTotal: ctx.closeSkipped.total,
      strandedNeverTerminalTotal: ctx.closeStrandedNeverTerminal.total,
      strandedStillDelegatedTotal: ctx.closeStrandedStillDelegated.total,
    },
    burnSamplesLamports: ctx.burnSamplesLamports,
    operatorLamports: ctx.operatorLamportsObserved,
    // THE LATCH, NOT A RECOMPUTED VERDICT. `summariseReclamation` derives the report's
    // `sweep.tripped` from this, so the endpoint says the keeper is stopped for as long as it is —
    // and not only for as long as the gap that stopped it happens to still be wide. See
    // `KeeperContext.sweepStopSince` for why that distinction has teeth here and not for the brake.
    sweepStoppedSinceSec: ctx.sweepStopSince,
  };
}

/** EVERY CONFIGURED NUMBER THE REPORT AND THE TWO STOPS RUN ON, gathered once so the boot seed and
 *  every later render cannot disagree about them. See `ReclamationThresholds` for why this is a
 *  record and not four positional arguments. */
const RECLAMATION_THRESHOLDS: ReclamationThresholds = {
  burnLamportsPerRound: MAX_BURN_LAMPORTS_PER_ROUND,
  armAfterSamples: BURN_ARM_AFTER_ROUNDS,
  windowSamples: BURN_SAMPLE_ROUNDS,
  stopAtGapRounds: SWEEP_GAP_STOP_ROUNDS,
};

/** The report as the bytes `GET /reclamation.json` serves. One place builds it, so the boot seed and
 *  every later render are the same code — see `StatusServerDeps.reclamation` for why the handler is
 *  handed a string rather than allowed to build one. */
function renderReclamation(state: ReclamationState, roundsPerDay: number): string {
  return serializeReclamationReport(
    summariseReclamation(state, RECLAMATION_THRESHOLDS, roundsPerDay),
  );
}

/** THE FUNDING FLOOR, CHECKED AT THE ONE POINT WHERE REFUSING IS FREE.
 *
 *  Returns true when the keeper may open a round. Publishes the condition either way.
 *
 *  WHY ONLY HERE, AND NOWHERE ELSE IN THE PHASE MACHINE. Every other point in a round is PAST the
 *  expensive commitment: `open_round` has already paid ~0.0235 SOL of rent and `delegate_round` has
 *  handed the account to the ER. A keeper that downed tools mid-round on a low balance would strand
 *  that deposit for nothing and leave a real player's fight unfinished — and stranded is the operative
 *  word: rent on a round that REACHES a terminal phase is float, but a round abandoned mid-flight
 *  reaches none, so it can never be swept and can never be closed. It would convert a funding
 *  problem into a permanent loss and a broken promise, which is strictly worse than spending the last
 *  of the money on finishing what was started. So an in-flight round is always driven to a terminal
 *  state. What the keeper refuses is to START work it may not be able to finish.
 *
 *  THROTTLED, because while it is refusing it is asked on every pass. A blocked keeper reaches this
 *  function at 1Hz for as long as the condition lasts, and each check is an RPC. Re-reading the
 *  balance once every `LOW_BALANCE_RECHECK_SECONDS` bounds that to a request every fifteen seconds
 *  while still noticing a top-up within fifteen seconds of it landing — which is the responsiveness
 *  that matters, since the operator who just sent SOL is watching. The cached verdict is what the
 *  passes in between use.
 *
 *  LOGGED ONCE PER STRETCH, not per check. A keeper that is out of money is going to be out of money
 *  for a while, and a line a second would bury the one line that says what to do about it. */
async function affordsAnotherRound(ctx: KeeperContext, roundNo: bigint): Promise<number | null> {
  const nowSec = ctx.client.nowSec();
  if (ctx.lowBalanceSince !== null && nowSec < ctx.lowBalanceCheckedAtSec + LOW_BALANCE_RECHECK_SECONDS) {
    return null; // inside the throttle window, and the last answer was "no"
  }

  // ALSO THE COST BASELINE, handed back rather than read twice. `open_round` needs the pre-spend
  // balance to report what the round cost, and that is the same number this guard just fetched — two
  // reads would be two RPCs and, worse, two different instants, so the reported cost would silently
  // include anything that moved in between.
  const lamports = await ctx.client.balance(ctx.operator.publicKey);
  ctx.lowBalanceCheckedAtSec = nowSec;
  // THE RECLAMATION REPORT'S BALANCE, TAKEN FROM A READ SOMEBODY ELSE WAS ALREADY PAYING FOR. That
  // report renders once per pass, and a `getBalance` per second on the endpoint whose rate limit
  // already shapes this process would be an RPC bought purely to print a number.
  ctx.operatorLamportsObserved = lamports;

  if (lamports >= MIN_BALANCE_LAMPORTS) {
    if (ctx.lowBalanceSince !== null) {
      ok(`payer is funded again — ${fmtSol(lamports)} is back above the ${fmtSol(MIN_BALANCE_LAMPORTS)} floor; opening rounds again`);
      ctx.lowBalanceSince = null;
      ctx.publisher.setLowBalance(null);
      // STATED HERE RATHER THAN INFERRED FROM `setLowBalance(null)`, and the two calls stay separate on
      // purpose — see `setNotOpeningRounds`. There are two causes now, this call site is the one that
      // knows which of them applies, and a setter that derived one from the other would make
      // `"low-balance"` the published reason for a keeper stopped by the burn brake with a perfectly
      // healthy balance.
      ctx.publisher.setNotOpeningRounds(null);
    }
    return lamports;
  }

  // The countdown goes with it. A settled round's hold has already proposed "next lobby in 0:08", and
  // leaving that standing beside a keeper that is not going to open one is the confidently-wrong
  // number this whole status contract exists to delete. `keeperCountdown` refuses it on the reader's
  // side too — see its comment on why both layers are needed rather than one.
  ctx.publisher.setNextLobbyOpensAt(null);
  ctx.publisher.setLowBalance({
    lamports: BigInt(lamports),
    floorLamports: BigInt(MIN_BALANCE_LAMPORTS),
    nowSec,
  });
  // The AMOUNTS above, and what they MEAN here. Both, from the one call site that knows the cause.
  ctx.publisher.setNotOpeningRounds("low-balance");

  if (ctx.lowBalanceSince === null) {
    ctx.lowBalanceSince = nowSec;
    error(`OUT OF FUNDS — the payer holds ${fmtSol(lamports)}, below the ${fmtSol(MIN_BALANCE_LAMPORTS)} floor.`);
    error(`  Round #${roundNo} was NOT opened. Any round already running is still being driven to a`);
    error(`  terminal state, and the status file now says no next lobby is coming. Send SOL to`);
    error(`  ${ctx.operator.publicKey.toBase58()} and the keeper resumes on its own within ${LOW_BALANCE_RECHECK_SECONDS}s.`);
    error(`  Change the floor with KEEPER_MIN_BALANCE_SOL.`);
  }
  return null;
}

/** THE RENT BRAKE, CHECKED AT THE SAME POINT AND FOR THE SAME REASON AS THE FUNDING FLOOR ABOVE.
 *
 *  Returns true when the keeper may open a round. Publishes the condition either way.
 *
 *  WHAT IT MEASURES lives in `reclamation.ts` and is not re-argued here: `burnBrake` owns why
 *  consecutive open-to-open balance samples are the one measurement that cannot be fooled by a failure
 *  nobody predicted, why the brake must not arm before `BURN_ARM_AFTER_ROUNDS` samples exist, and why
 *  a top-up can only ever fool it into staying OPEN. This function is the wiring: it asks, it
 *  publishes, and it says the one thing out loud that an operator has to act on.
 *
 *  ────────────────────────────────────────────────────────────────────────────────────────────────
 *  THE STOP IS A LATCH WITHIN A PROCESS, AND THAT IS THE DESIGN RATHER THAN A LIMITATION
 *  ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *  A sample is taken at `open_round` and nowhere else. So once this stops opening rounds, no further
 *  sample can arrive, the mean is frozen at the value that tripped it, and it stays stopped for the
 *  life of the process. That is not an oversight to be fixed with a decay or a retry timer: the ONLY
 *  way to gather evidence that the burn has improved is to resume opening rounds at the rate that was
 *  emptying the wallet, which is precisely the thing the brake exists to stop. A brake that reopened
 *  on its own would be a brake that spends 9.96 SOL/day proving to itself that it should not have.
 *
 *  So the way to clear it is a person: read `GET /reclamation.json`, which carries the sweep gap on
 *  one side and the rounds the closer skipped and found stranded on the other, work out which of them
 *  is the cause, fix it, and restart the keeper. Restarting is not a workaround here — it is the
 *  assertion that somebody looked.
 *
 *  LOGGED ONCE PER STRETCH, exactly as the funding floor is, and for its reason: the condition lasts,
 *  and a six-line alarm once a second is how an operator learns to scroll past the loudest line in the
 *  log. */
function rentIsComingBack(ctx: KeeperContext, roundNo: bigint): boolean {
  const verdict = burnBrake(
    ctx.burnSamplesLamports,
    MAX_BURN_LAMPORTS_PER_ROUND,
    BURN_ARM_AFTER_ROUNDS,
    BURN_SAMPLE_ROUNDS,
  );

  if (!verdict.tripped) {
    // GUARDED ON THIS FUNCTION'S OWN LATCH so it can never clear a reason another cause set — the
    // funding floor owns `"low-balance"` and clears it itself. It is unreachable while the stop holds,
    // because a stopped keeper takes no further samples and the mean cannot move; it is written anyway
    // because "the published reason is cleared by whatever set it" has to hold for both causes or it
    // is a rule with an exception that the third cause will be written against.
    if (ctx.burnStopSince !== null) {
      ctx.burnStopSince = null;
      ctx.publisher.setNotOpeningRounds(null);
      ok(`measured burn is back under ${fmtSol(MAX_BURN_LAMPORTS_PER_ROUND)}/round — opening rounds again`);
    }
    return true;
  }

  // The countdown goes with it, for the reason the funding floor gives: a settled round's hold has
  // already proposed "next lobby in 0:08", and leaving that standing beside a keeper that will not
  // open one is the confidently-wrong number the whole status contract exists to delete.
  ctx.publisher.setNextLobbyOpensAt(null);
  ctx.publisher.setNotOpeningRounds("rent-not-reclaimed");

  if (ctx.burnStopSince === null) {
    ctx.burnStopSince = ctx.client.nowSec();
    const mean = verdict.meanLamportsPerRound ?? 0;
    const perDay = measuredRoundsPerDay(ctx, ctx.client.nowSec());
    error(`RENT IS NOT COMING BACK — the keeper has STOPPED opening rounds.`);
    error(`  Measured ${fmtSol(mean)} per round over the last ${verdict.samples} of ${ctx.burnSamplesLamports.length} samples,`);
    error(`  against a ceiling of ${fmtSol(MAX_BURN_LAMPORTS_PER_ROUND)} (KEEPER_MAX_BURN_SOL_PER_ROUND). At the`);
    error(`  ${perDay === null ? "cadence this run has not measured yet that is" : `${perDay.toFixed(0)} rounds/day this run has measured that is`}`);
    error(`  ${perDay === null ? "an unknown daily figure" : `~${(mean * perDay / 1e9).toFixed(2)} SOL/day`} — COST-MODEL §4's failure mode, arriving.`);
    error(`  Round #${roundNo} was NOT opened. Any round already running is still being driven to a`);
    error(`  terminal state, and the status file now says no next lobby is coming.`);
    error(`  THIS STOP DOES NOT CLEAR ITSELF, and that is deliberate: samples are taken at open_round, so`);
    error(`  a stopped keeper gathers no new evidence and the only way to gather some is to resume`);
    error(`  spending at the rate that tripped it. Read ${RECLAMATION_PATH} — it carries the sweep gap,`);
    error(`  the rounds the closer skipped and the ones it found stranded — fix the cause, then restart`);
    error(`  the keeper. To run knowingly at this burn instead, raise KEEPER_MAX_BURN_SOL_PER_ROUND.`);
  }
  return false;
}

/** THE SWEEP-GAP STOP, CHECKED AT THE SAME POINT AND FOR THE SAME REASON AS THE TWO GUARDS ABOVE.
 *
 *  Returns true when the keeper may open a round. Publishes the condition either way.
 *
 *  WHAT IT MEASURES AND WHY 25 both live elsewhere and are not re-argued here: `sweepGapStop` in
 *  `reclamation.ts` owns why a stale or missing poll may not trip it, why the latch is an argument
 *  rather than a flag, and why the comparison is `>=`; `SWEEP_GAP_STOP_ROUNDS` in `config.ts` owns
 *  the derivation from `MIN_RETAINED_ROUNDS` and what the headroom is worth. This function is the
 *  wiring.
 *
 *  WHY IT SITS AFTER THE BURN BRAKE RATHER THAN BEFORE THE FUNDING FLOOR, which is the only real
 *  choice in placing it. Checking it first would be cheaper — it needs no RPC, so a latched stop
 *  could skip the balance read entirely — and that is exactly what makes it wrong. `affordsAnotherRound`
 *  is where `ctx.operatorLamportsObserved` is refreshed, and that number is what `/reclamation.json`
 *  computes `operator.sol` and `runwayDays` from. Short-circuiting ahead of it would freeze the
 *  balance in the report at whatever it read on the last pass before the stop — while closes keep
 *  running and keep pushing it UP — so the operator deciding what to do about a stopped arena would
 *  be reading a stale number on the endpoint they were sent to. One `getBalance` per pass is what the
 *  burn brake already costs in this state, and it buys a report that stays true.
 *
 *  IT ALSO RE-PUBLISHES ITS REASON ON EVERY PASS AND NOT ONLY ON THE FIRST, which matters because of
 *  the ordering above rather than as belt-and-braces. `affordsAnotherRound` clears
 *  `notOpeningRounds` to null when the payer comes back above the floor, and it cannot know that a
 *  later guard is still holding the keeper shut. Re-asserting here, unconditionally, is what makes
 *  "the published reason is cleared by whatever set it" survive a cause that never clears its own —
 *  and the status file is rendered once at the end of the pass, so the intermediate null never
 *  reaches either channel.
 *
 *  LOGGED ONCE PER STRETCH, exactly as the two guards above are, and for their reason. */
function sweepIsKeepingUp(ctx: KeeperContext, roundNo: bigint): boolean {
  const verdict = sweepGapStop(ctx.treasury, SWEEP_GAP_STOP_ROUNDS, ctx.sweepStopSince !== null);

  // NO `else` BRANCH CLEARING ANYTHING, and that is the one place this departs from
  // `rentIsComingBack`'s shape rather than copying it. That function clears its own reason when its
  // verdict comes back untripped, guarded on its own latch so it can never clear a reason the funding
  // floor set. Here the untripped case cannot follow a tripped one at all — `latched` makes the
  // verdict monotonic — so a clearing branch would be unreachable code that reads like a promise the
  // stop does not make. The rule it is written against still holds: this function never touches a
  // reason it did not set, and it sets exactly one.
  if (!verdict.tripped) return true;

  // The countdown goes with it, for the reason both guards above give: a settled round's hold has
  // already proposed "next lobby in 0:08", and leaving that standing beside a keeper that will not
  // open one is the confidently-wrong number the whole status contract exists to delete.
  ctx.publisher.setNextLobbyOpensAt(null);
  ctx.publisher.setNotOpeningRounds("rent-not-swept");

  if (ctx.sweepStopSince === null) {
    ctx.sweepStopSince = ctx.client.nowSec();
    const gap = verdict.gap;
    error(`RENT IS NOT BEING SWEPT — the keeper has STOPPED opening rounds.`);
    error(`  Arena.round_counter is ${gap === null ? "an unknown number of" : gap} round(s) ahead of Treasury.rounds_swept,`);
    error(`  at or past the stop of ${SWEEP_GAP_STOP_ROUNDS} (KEEPER_SWEEP_GAP_STOP_ROUNDS). A round cannot be closed until it`);
    error(`  has been swept — close_round_account answers RoundNotSwept — so every round in that gap is`);
    error(`  past the ${ROUND_RETENTION}-round retention window with its ~${fmtSol(ROUND_RENT_LAMPORTS)} of rent NOT coming back.`);
    error(`  Round #${roundNo} was NOT opened. Any round already running is still being driven to a`);
    error(`  terminal state, and the status file now says no next lobby is coming.`);
    error(`  THIS STOP DOES NOT CLEAR ITSELF. The gap will fall on its own once the arena stops opening`);
    error(`  rounds, which is why it must not be read as the problem being fixed. Read ${RECLAMATION_PATH} —`);
    error(`  closer.stranded.neverTerminal is the count of rounds that can NEVER be swept, and if that is`);
    error(`  what grew, the threshold is what needs raising rather than the sweep that needs fixing.`);
    error(`  Fix the cause, then restart the keeper. To run knowingly at this gap, raise`);
    error(`  KEEPER_SWEEP_GAP_STOP_ROUNDS.`);
  }
  return false;
}

/** THE MEASURED ROUNDS PER DAY, or null while nothing honest can be said about it.
 *
 *  MEASURED, NEVER MODELLED, AND THAT IS THE WHOLE REASON IT IS A FUNCTION RATHER THAN A CONSTANT.
 *  COST-MODEL §2 derives 424 rounds/day from the configured cadence and the program's own fight-length
 *  table — a projection, and a good one, but the fight length moves with the seat cap and the draw and
 *  the hold are wall-clock. §7 of that same document records what happens when a defensible-looking
 *  proxy is measured instead of the thing itself. A modelled rate multiplied by a measured burn is a
 *  number that is half evidence and reads as whole, sitting one field along from the measurement this
 *  entire report exists to make.
 *
 *  NULL UNTIL TWO OPENS AT LEAST `MIN_RATE_WINDOW_SECONDS` APART. One open gives no interval at all,
 *  and an interval of a few seconds extrapolates to thousands of rounds a day — a confidently wrong
 *  number in the first minute of every run, which is exactly the minute somebody is watching.
 *
 *  ITS BIAS IS KNOWN, SMALL, AND DECIDES NOTHING. `n` opens span `n - 1` intervals, so counting `n`
 *  against the elapsed time reads a few percent high; measuring the elapsed time to NOW rather than to
 *  the last open reads a few percent low; at the sample counts this runs at they largely cancel. It
 *  matters because nothing branches on this — the brake compares LAMPORTS PER ROUND, which needs no
 *  rate — so this number's only job is to turn a per-round figure into the per-day one the owner
 *  actually asked about. */
function measuredRoundsPerDay(ctx: KeeperContext, nowSec: number): number | null {
  if (ctx.firstOpenAtSec === null || ctx.opensObserved < 2) return null;
  const elapsed = nowSec - ctx.firstOpenAtSec;
  if (elapsed < MIN_RATE_WINDOW_SECONDS) return null;
  return ctx.opensObserved * 86_400 / elapsed;
}

/** The shortest span the rounds/day rate may be extrapolated from. A minute — long enough that the
 *  first two opens of a run cannot produce a four-figure rate, short enough that the report has a real
 *  number in it within the first couple of rounds. */
const MIN_RATE_WINDOW_SECONDS = 60;

async function openNextRound(ctx: KeeperContext, roundNo: bigint): Promise<void> {
  // A STOP THAT HAS ALREADY LATCHED IS ANSWERED WITHOUT AN RPC, and this line is the difference
  // between a stopped keeper that costs nothing and one that hammers a public endpoint for days.
  //
  // `affordsAnotherRound` only throttles its `getBalance` while the payer is BELOW the floor
  // (`lowBalanceSince !== null`). A keeper stopped by the sweep gap has a perfectly healthy balance,
  // so nothing throttles it: without this line it would issue one `getBalance` per second, for the
  // life of a process whose stop never clears. `LOW_BALANCE_RECHECK_SECONDS` exists because "an RPC
  // per second for as long as the arena is unfunded — which could be days" was already judged
  // unacceptable, and this condition lasts strictly longer than that one. A 429 storm from here
  // throws out of `balance()` into the main loop's catch, and a keeper that is stopped but otherwise
  // fine starts publishing `stalledSince` — a second, wrong, alarm on top of the right one.
  //
  // IT IS ONLY THE ALREADY-LATCHED PASS THAT SHORT-CIRCUITS. The pass on which the stop FIRST fires
  // takes the full path below, so the balance behind `/reclamation.json`'s `operator` and
  // `runwayDays` is refreshed at the moment of the stop — which is the reading an operator wants
  // anyway ("what did it have when it stopped"). It does not go stale afterwards in any way that
  // matters: `config.ts`'s `MIN_BALANCE_SOL` block works through why a stopped keeper has no closes
  // left to run, so there is nothing moving that balance for this to miss.
  //
  // `sweepIsKeepingUp` is still CALLED rather than the reason being assumed, because it is what
  // re-publishes `notOpeningRounds` on every pass — see its own comment on why that has to happen
  // even though nothing has changed.
  if (ctx.sweepStopSince !== null) {
    sweepIsKeepingUp(ctx, roundNo);
    return;
  }

  // Sampled BEFORE anything is spent, so the per-round cost reported at settlement is measured rather
  // than estimated. It includes the round PDA's rent, which is the dominant term. It is the same read
  // the funding guard just did — see `affordsAnotherRound`.
  const lamportsBefore = await affordsAnotherRound(ctx, roundNo);
  if (lamportsBefore === null) return;

  // ONE BURN SAMPLE PER ROUND, TAKEN FROM THE READ THE FUNDING GUARD JUST MADE AND BEFORE ANYTHING IS
  // SPENT. The sample is the NET lamports the PREVIOUS round cost: everything that left the wallet and
  // everything that came back into it between two consecutive opens, `close_round_account` refunds
  // included. See `burnBrake` for why a balance difference subsumes failure modes a counter of known
  // failures cannot.
  //
  // THE RING ITSELF IS `recordBurnSample`'S, not two lines of push-and-shift written out here, and the
  // reason is that those two lines were the only load-bearing arithmetic in this file that no test
  // could reach. `BURN_ARM_AFTER_ROUNDS` is the cap rather than `BURN_SAMPLE_ROUNDS` — see the field's
  // own comment on `KeeperContext` for what confusing them costs, and `reclamation.test.ts` for the
  // sweep that now holds it.
  if (ctx.lastOpenLamports !== null) {
    ctx.burnSamplesLamports = recordBurnSample(
      ctx.burnSamplesLamports,
      ctx.lastOpenLamports - lamportsBefore,
      BURN_ARM_AFTER_ROUNDS,
    );
  }
  // ASKED WITH THE NEWEST SAMPLE ALREADY IN HAND, which is the whole point of the ordering: the round
  // this decides about is the very next one, and evaluating the brake before pushing would always pay
  // for one more round than it had to.
  if (!rentIsComingBack(ctx, roundNo)) return;
  // THE SECOND WITNESS, WIRED TO ITS OWN STOP — and the one that has an opinion during the ~2.6 hours
  // the brake above spends filling its ring after every restart. `reclamation.ts`'s header argues why
  // both exist and why neither subsumes the other; `sweepIsKeepingUp` argues why it is asked here,
  // after the balance read rather than before it.
  if (!sweepIsKeepingUp(ctx, roundNo)) return;

  const roundPda = roundIx.roundPdaForRoundNo(roundNo, ctx.client.arenaPda);
  // THE MODE IS ON THIS LINE SO THERE IS ONE LINE PER ROUND SAYING SO, for as long as it is on. A
  // boot banner scrolls; a keeper that has been running house-only rounds for three days must not
  // require somebody to find its first hundred lines to discover that.
  info(`opening round #${roundNo}${ctx.options.houseOnlyRounds ? ` ${c.y}(house-only)${c.x}` : ""}  pda ${roundPda.toBase58()}`);

  // Vestigial since the seed moved to the VRF oracle — any 32 bytes satisfy the on-chain format, and
  // the operator no longer chooses the seed at all. Kept because `open_round` still takes it.
  const seedCommit = crypto.getRandomValues(new Uint8Array(32));
  // THE LOBBY LENGTH MEANS THREE DIFFERENT THINGS NOW, which is why it is chosen here rather than
  // fixed. Under the hold-open policy the deadline is a BACKSTOP — the keeper closes the lobby itself
  // when a player arrives, so this is only "how long before I give up on this round and pay for
  // another one". Without it the deadline is the SCHEDULE and the keeper has to open a lobby of
  // exactly the length it intends to wait, because nothing else can end one.
  //
  // THE THIRD IS THE TWO POLICIES MEETING, and it is why the second clause is here. Under house-only
  // the backstop BECOMES the schedule: an empty lobby is not being held for anybody, it is going to be
  // drawn at its deadline like every other lobby, so the deadline is the one thing deciding how often
  // a round happens. Production sets `KEEPER_HOLD_OPEN_LOBBY_SECONDS=604800` — seven days, and a
  // perfectly sound number for a backstop nobody expects to reach — which as a schedule is one round
  // per week. `DEFAULT_LOBBY_SECONDS` is the honest length for a lobby that will be drawn on its own
  // merits.
  //
  // THE EARLY-CLOSE HALF OF HOLD-OPEN IS UNTOUCHED and still fires for a real arrival, on the same
  // grace, ahead of the same deadline. `lobbyPolicy.ts`'s header owns that argument and it is not
  // restated here.
  const lobbySeconds = ctx.options.holdOpen && !ctx.options.houseOnlyRounds
    ? HOLD_OPEN_LOBBY_SECONDS : DEFAULT_LOBBY_SECONDS;
  const outcome = await ctx.client.send(
    roundIx.openRound(ctx.client.program, {
      arena: ctx.client.arenaPda,
      round: roundPda,
      authority: ctx.operator.publicKey,
      roundNo,
      seedCommit,
      lobbySeconds,
    }),
    ctx.operator,
    `open_round #${roundNo}`,
  );
  if (!outcome.sent) return;

  // STAMPED ONLY ON AN OPEN THAT LANDED, which is the difference between a sample and a fiction. A
  // failed open spends nothing and moves no round, so treating it as the start of a round would put a
  // phantom entry in the ring — the net change of a wallet across an interval in which nothing was
  // opened — and the brake averages exactly what it is given.
  ctx.lastOpenLamports = lamportsBefore;
  if (ctx.firstOpenAtSec === null) ctx.firstOpenAtSec = ctx.client.nowSec();
  ctx.opensObserved += 1;

  // STAMPED IMMEDIATELY, before anything that can fail. Everything below is best-effort, and the
  // pre-open balance is the one thing here that cannot be recovered later — losing it makes the
  // round's cost unreportable, which is the number this whole measurement exists for.
  ctx.timeline = freshTimeline(roundNo, lamportsBefore);
  ctx.publisher.setNextLobbyOpensAt(null);
  ctx.refreshAfterStep = true;

  // Read the window back off the account rather than echoing what we asked for: the chain clamps the
  // duration into [MIN_LOBBY_SECONDS, MAX_LOBBY_SECONDS] and stamps both ends from its own `Clock`.
  // From the BASE layer, because that is where `open_round` ran and the round is not delegated yet.
  //
  // READ-YOUR-WRITES IS NOT GUARANTEED HERE and this is the hot path of every round: the write was
  // confirmed through the ROUTER and this read goes to a load-balanced public pool, so a slot or two
  // of lag answers "Account does not exist". Retried, and tolerated when it still comes back null —
  // it is a log line, not a precondition for anything below it.
  const opened = await ctx.client.programBase.account.round.fetchNullable(roundPda).catch(() => null);
  if (opened) {
    const closesAt = Number(opened.lobbyClosesAt.toString());
    const window = closesAt - Number(opened.lobbyOpenedAt.toString());
    ok(`round #${roundNo} open — a ${window}s lobby, closing at ${new Date(closesAt * 1000).toLocaleTimeString()}`);
  } else {
    info(`round #${roundNo} open — the base layer has not caught up enough to echo the window back yet`);
  }

  await delegateRound(ctx, roundPda, roundNo);

  // Between rounds is the natural moment to check the house's fuel, and it must not be boot-only:
  // these wallets are funded for thousands of rounds, this process is designed to run for days, and
  // the failure mode when they run dry is silent — see `fundHouseBank`.
  await fundHouseBank(ctx.client, ctx.operator, ctx.bank, ctx.options.dryRun, true);
}

/** The per-round report. Every number is measured or read off the chain; anything this process did not
 *  observe prints as "unknown" rather than as a plausible zero. */
async function summariseRound(ctx: KeeperContext, round: RawRoundAccount, roundPda: PublicKey): Promise<void> {
  const split = ctx.bank.classify(round);
  const { timeline } = ctx;

  const lobbySeconds = Number(round.lobbyClosesAt.toString()) - Number(round.lobbyOpenedAt.toString());
  const drawingSeconds = timeline.drawRequestedAtMs !== null && timeline.fightObservedAtMs !== null
    ? (timeline.fightObservedAtMs - timeline.drawRequestedAtMs) / 1_000
    : null;
  const fightStartedAt = Number(round.fightStartedAt.toString());
  const fightSeconds = timeline.settledObservedAtSec !== null && fightStartedAt > 0
    ? timeline.settledObservedAtSec - fightStartedAt
    : null;

  const lamportsAfter = await ctx.client.balance(ctx.operator.publicKey);
  // The second of the two places a balance is already read for a decision — see
  // `operatorLamportsObserved`. Between them the reclamation report's balance is at worst one round
  // old, for no RPC of its own.
  ctx.operatorLamportsObserved = lamportsAfter;
  const spent = timeline.operatorLamportsAtOpen !== null
    ? timeline.operatorLamportsAtOpen - lamportsAfter
    : null;

  heading(`ROUND #${round.roundNo} COMPLETE`);
  plain(`  pda            ${roundPda.toBase58()}`);
  plain(`  fighters       ${round.fighterCount}  (${split.houseCount} house / ${split.realCount} real)`);
  plain(`  winner         side ${round.winner}`);
  plain(`  pot            ${round.pot.toString()}`);
  plain(`  lobby          ${lobbySeconds}s ${c.d}(the window the chain recorded)${c.x}`);
  plain(`  drawing        ${fmtDuration(drawingSeconds)} ${c.d}(close_lobby_and_draw -> Fight, wall clock)${c.x}`);
  // "-> round observed Settled", not "-> resolve landing": `resolveRound` can grind across several
  // `resolve` calls on a neglected round (see its own comment), so the moment a `resolve` transaction
  // lands is no longer necessarily the moment the round settles. `settledObservedAtSec` is stamped by
  // `driveSettled` on the first pass that reads the phase as `Settled`, which is the honest instant.
  plain(`  fight          ${fmtDuration(fightSeconds)} ${c.d}(fight_started_at -> round observed Settled)${c.x}`);
  plain(`  result hold    ${RESULT_HOLD_SECONDS}s ${c.d}(configured; close_round runs inside it)${c.x}`);
  // "FLOATS", NOT "SPENDS": the delta includes the round PDA's rent, and `close_round_account` hands
  // that back once `ROUND_RETENTION` newer rounds exist. This line used to say "which nothing
  // reclaims" — true before v7, and now the difference between a round that cost ~0.0235 SOL and one
  // that cost ~0.00007 with the rest on loan.
  plain(`  operator spent ${spent === null ? "unknown (this keeper did not open this round)" : `${fmtSol(spent)} ${c.d}(measured balance delta; most of it is the round PDA's rent, returned once ${ROUND_RETENTION} newer rounds exist)${c.x}`}`);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Boot and the loop
// ────────────────────────────────────────────────────────────────────────────────────────────────

function publishRoundSnapshot(ctx: KeeperContext, state: KeeperChainState): void {
  if (!state.round || !state.roundPda) {
    ctx.publisher.setRound(null);
    return;
  }
  // STILL CLASSIFIED, AND THE CLASSIFICATION IS STILL LOAD-BEARING — it just no longer reaches the
  // file. The split used to be published as `houseFighterCount` / `realFighterCount` AND consumed
  // here; only the first of those is gone. `lobbyIsHeldOpen` is a function of `realFighterCount`, so
  // deleting this call to tidy up after the removal would silently make `heldOpen` always-true and put
  // "waiting for players" on screen in front of a full lobby. The keeper's own use of the numbers is
  // untouched everywhere in this file, deliberately: the treasury rule is built on them.
  const split = ctx.bank.classify(state.round);
  // Computed from THIS snapshot, from the same split, through the same predicate the phase machine
  // branches on. That is what makes `heldOpen` incapable of contradicting the `phase` published next
  // to it — and it is the reason `heldOpen` survives a change that deleted every other field derived
  // from who the fighters are. See `roundStatusFrom`.
  const heldOpen = lobbyIsHeldOpen({
    phaseCode: state.round.phase,
    lobbyClosesAt: Number(state.round.lobbyClosesAt.toString()),
    nowSec: state.nowSec,
    realFighterCount: split.realCount,
    holdOpen: ctx.options.holdOpen,
    houseOnly: ctx.options.houseOnlyRounds,
  });
  ctx.publisher.setRound(roundStatusFrom(state.round, state.roundPda, heldOpen));
}

/**
 * Record a failure: the whole of it to the log, and the BARE FACT of it to the published status.
 *
 * IT USED TO PUBLISH THE EXCEPTION TEXT, truncated to four hundred characters, and the truncation was
 * the tell that nobody had asked the right question about it. `describeError` returns whatever the
 * thrower wrote — and the throwers here are libraries, the RPC and the chain, none of which have any
 * idea what this project considers private. An RPC simulation failure names the program, the accounts
 * the failing instruction touched and the transaction logs; a house `enter` that fails is an exception
 * with one of the arena's OWN wallets inside it. A sampled status file had exactly that in it. So the
 * field was publishing forty-eight pubkeys' worth of potential disclosure through a name — `message` —
 * that gave nobody a reason to look, one field along from the `house` block that was removed on
 * purpose.
 *
 * SANITISING IT WAS CONSIDERED AND REJECTED, and the reasoning generalises past this field. A filter
 * over text you did not write has to be right every time, forever, against every future version of
 * every library in the path — and the one time it is wrong, the leak is silent, published, and cached
 * by whoever fetched it. A field with no inputs cannot be got wrong. So the message is gone from the
 * shape (see `KeeperError` in `src/v2/data/keeperStatus.ts`) and what remains is `at` and a `context`
 * chosen from a small fixed vocabulary.
 *
 * THE RULE THAT CAME OUT OF IT, which is the part worth carrying to whoever adds the next field:
 * NOTHING INTERPOLATED FROM AN EXCEPTION, AN ACCOUNT, OR A COUNT MAY EVER ENTER THIS PAYLOAD. Every
 * `setLastError` call site in this file passes a literal `context` and nothing else. A template string
 * in one of them is the regression, and `statusFile.test.ts` asserts over the serialized bytes because
 * that is the only check that catches it arriving through a field nobody thought to look at.
 *
 * WHAT IS LOST AND WHY IT IS AFFORDABLE: an operator can no longer read the cause out of the status
 * file, and has to open the logs. The log line below is untruncated and always emitted, so the
 * information still exists in full — it moved from a public channel to a private one, which for
 * diagnostic text is where it belonged in the first place. What the file still says is the part a
 * BROWSER can act on: that this keeper hit a problem, in which part of itself, and when.
 */
function recordError(ctx: KeeperContext, context: string, e: unknown): void {
  // Untruncated, and this is now the only copy. The four-hundred-character cap existed solely to keep
  // twelve lines of program logs out of a payload a browser fetches; with nothing published there is
  // nothing to cap, and capping the LOG would delete the one place the detail still lives.
  error(`${context}: ${describeError(e)}`);
  ctx.publisher.setLastError({ at: ctx.client.nowSec(), context });
  ctx.publisher.publish();
}

/** One line describing what the chain said, for the dry run's report. A dry run whose pass sent
 *  nothing is the COMMON case — most passes of a lobby or a hold have nothing due — and without this
 *  it is indistinguishable from a pass that failed to understand what it read. */
function describeState(ctx: KeeperContext, state: KeeperChainState | null): string {
  if (!state) return "nothing — the first read failed";
  if (!state.arena) return `no arena at ${ctx.client.arenaPda.toBase58()} yet`;
  if (!state.round) return `arena round_counter ${state.roundCounter}, no round account`;
  const split = ctx.bank.classify(state.round);
  const delegated = state.roundDelegated === null
    ? "delegated (implied by the phase)"
    : state.roundDelegated ? "delegated" : "NOT delegated";
  return `round #${state.round.roundNo} ${PHASE_NAME[state.round.phase]}, ` +
    `${state.round.fighterCount} fighters (${split.houseCount} house / ${split.realCount} real), ${delegated}`;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  // Aborted on the first stop signal. Threaded into every wait so a SIGTERM is answered in about a
  // second rather than after the longest await in flight — which was up to 30s of undelegation
  // polling, comfortably past a `docker stop` grace period and therefore a SIGKILL that skips the
  // deliberate stale-heartbeat exit entirely.
  const stopper = new AbortController();
  const operator = loadOperator();
  const client = await createChainClient({ operator, dryRun: options.dryRun, stopSignal: stopper.signal });

  // `open_round` and `delegate_round` are both `has_one = authority`. Checking it at boot turns a
  // whole class of "why does every round fail" into one line, before a single lamport is spent.
  const arena = await client.programBase.account.arena.fetchNullable(client.arenaPda);
  if (arena && !arena.authority.equals(operator.publicKey)) {
    throw new Error(
      `the arena at ${client.arenaPda.toBase58()} has authority ${arena.authority.toBase58()}, but this ` +
      `keeper signs as ${operator.publicKey.toBase58()}. open_round and delegate_round are has_one = ` +
      `authority, so this keeper cannot open rounds on this arena.`,
    );
  }

  // THE ONE-DIRECTIONAL VETO ON `--hold-open`. `programFeatures` cannot tell us the early close is
  // DEPLOYED — only the operator knows that, which is why the policy is a flag — but it can tell us
  // the instruction cannot even be ENCODED, and that answer is worth refusing to start on. Anchor
  // builds account lists by walking the IDL, so an `authority` the IDL has never heard of is silently
  // dropped: the keeper would hold a lobby open, send what it believed was an early close, and get
  // `LobbyStillOpen` — an error about the clock — once the grace had run and on every pass after it,
  // with a real player standing in the room waiting for a fight that could not start. Better to say so
  // before the first round.
  const features = await readProgramFeatures();
  if (options.holdOpen && !features.authorityEarlyClose) {
    throw new Error(
      "--hold-open needs an authority-signed early close, and the IDL this keeper builds from " +
      "(public/idl/bulls_arena.json) has no `authority` account on close_lobby_and_draw. Anchor would " +
      "drop it silently and every early close would come back as LobbyStillOpen while a real player " +
      "waited. Deploy the program, regenerate the IDL, then re-run with --hold-open.",
    );
  }

  // THE HOUSE BANK IS LOADED, AND THE STATUS SERVER STARTED, BEFORE THE SLOW PART OF BOOT.
  //
  // The ordering is the point. Choosing an ER validator downloads a ~360KB cloned program account per
  // route and write-probes each one with a 5-second ceiling, and funding the house bank can send a
  // confirmed base-layer transaction. Both are network-bound and both can take tens of seconds on an
  // unwell devnet. Starting the server after them meant that during the exact stretch where boot is
  // slow, the health endpoint did not exist — so a platform probe arriving in that window finds a
  // dead port, and on a one-machine app with a bounded grace period that is a machine killed for
  // being slow to start rather than for being broken.
  //
  // `loadOrCreateHouseBank` moves up with it because the ROSTER ENDPOINT needs the bank — it used to
  // be the publisher that needed it, for the disclosure list, and that consumer is gone. The ordering
  // argument is unchanged and the new consumer needs it just as early: a status server that started
  // before the bank existed would answer `/house-wallets.json` with an empty list during exactly the
  // window in which boot is slow, and the identity API would cache that empty list for a minute and
  // serve a face to every house wallet in it. It is purely local anyway — a file read (or an env var)
  // and possibly a keygen — so nothing it does is worth waiting on. `fundHouseBank` stays below: it
  // spends, and nothing should spend before the process has said it is alive.
  const bank = loadOrCreateHouseBank(options.dryRun);

  const publisher = createStatusPublisher({
    programId: PROGRAM_ID.toBase58(),
    arenaPda: client.arenaPda.toBase58(),
    nowSec: client.nowSec,
    houseOnlyRounds: options.houseOnlyRounds,
  });

  // THE SECOND CHANNEL, and in production the only one that reaches a browser — see
  // `statusServer.ts`. The publisher renders a valid payload at construction, so from this line on
  // there is something honest to serve: a status whose `erValidator` is still null and whose
  // heartbeat is the boot instant, which is exactly what is true.
  //
  // A DRY RUN STARTS IT TOO. It is one pass and out, so the server lives for a second or so — but
  // that second is exactly what makes `--dry-run` a rehearsal of the deployment rather than of the
  // laptop: a port that cannot be bound, a `KEEPER_CORS_ORIGIN` that is not an origin, a
  // `KEEPER_HTTP_PORT` that disagrees with `fly.toml` all surface here, before any SOL is spent.
  const originPolicy = resolveAllowedOrigins(process.env.KEEPER_CORS_ORIGIN);
  for (const line of originPolicyWarnings(originPolicy)) warn(line);
  // THE ENV IS READ HERE, ONCE, AND NEVER ON THE REQUEST PATH — see `StatusServerDeps.houseToken`.
  // Same shape as the CORS policy directly above it, and for the same reason: the rules stay pure
  // functions of values, so they can be tested under vitest, which has no `Bun` global at all.
  const houseTokenPolicy = resolveHouseTokenPolicy(process.env[HOUSE_TOKEN_ENV]);
  for (const line of houseTokenPolicy.warnings) warn(line);
  // SEEDED FROM A ZERO STATE BEFORE THE SERVER EXISTS, on `statusFile.ts`'s argument for rendering its
  // own payload at construction: a request arriving during the slow half of boot gets a well-formed
  // body describing exactly what is true — nothing polled, no samples, no losses, and (via a rate of
  // zero) no daily figure claimed — rather than an empty one a reader would need a special case for.
  //
  // It is re-rendered ONCE PER PASS beside `publisher.publish()`, never from a request handler. That
  // is `StatusServerDeps.reclamation`'s rule, not a convention: a route that computes is a route that
  // can throw, can be slow, and can be made to run by anybody on the internet.
  let reclamationBody = renderReclamation({
    observedAtSec: client.nowSec(),
    arena: null,
    closer: {
      cursor: 1, reclaimed: 0,
      skipped: [], strandedNeverTerminal: [], strandedStillDelegated: [],
      skippedTotal: 0, strandedNeverTerminalTotal: 0, strandedStillDelegatedTotal: 0,
    },
    burnSamplesLamports: [],
    operatorLamports: null,
    sweepStoppedSinceSec: null,
  }, 0);
  const statusServer = startStatusServer({
    port: HTTP_PORT,
    policy: originPolicy,
    body: publisher.body,
    heartbeatAgeSeconds: publisher.heartbeatAgeSeconds,
    reclamation: () => reclamationBody,
    houseToken: houseTokenPolicy.token,
    // Read through a closure rather than passed as an array, so the endpoint always answers from the
    // bank this process actually holds. It cannot change today — the bank is loaded once at boot —
    // and that is exactly why the indirection is worth its one line: the day it can, the roster will
    // be right without anybody remembering that it needed to be.
    houseWallets: () => bank.bankPubkeys,
  });

  heading("choosing an ER validator");
  const validator = await selectWritableValidator();
  if (!validator) {
    error(NO_FRESH_VALIDATOR);
    error("  A keeper cannot work around this: every round it opened would be delegated to a route that");
    error("  cannot run the deployed code. Failing loudly beats opening rounds nobody can play.");
    process.exit(1);
  }
  // Filled in after the fact rather than passed at construction, which is the whole reason
  // `setErValidator` is a setter: the status has to exist before the thing it describes is known.
  publisher.setErValidator({ identity: validator.identity.toBase58(), fqdn: validator.fqdn });

  // THE MODE'S OWN REFUSAL, HERE BECAUSE HERE IS WHERE THE THIRD URL FINALLY EXISTS.
  //
  // Two of these three are DEFENCE IN DEPTH and that is deliberate rather than redundant.
  // `endpoints.ts` already runs `assertDevnetUrl` over both RPCs at module load, and `chainClient.ts`
  // repeats it for its own contract's sake — but a mode that retires an on-chain guarantee must not
  // have its refusal depend on another module's import-time side effect continuing to exist, and when
  // it refuses it must name the FEATURE. "base devnet RPC points at MAINNET" tells an operator which
  // URL; "house-only rounds: base RPC" tells them which thing to turn off, which is the sentence they
  // can act on.
  //
  // THE VALIDATOR IS THE ONE THAT IS GENUINELY NEW HERE. It is chosen from the router at runtime and
  // never passes through `endpoints.ts`'s `resolve` at all, so the only assertion it has today lives
  // inside the SELECTION routine that produced it (`pickValidator`, and `acceptsWrites` for a
  // fallback candidate) — a place whose job is choosing a validator rather than guarding a cluster,
  // and which a rewrite of the selection logic could legitimately drop. Asserted on the string
  // `delegate_round` will actually be sent to, not on a reconstruction of it.
  if (options.houseOnlyRounds) {
    assertDevnetUrl(BASE_RPC_ENDPOINT.url, "house-only rounds (KEEPER_HOUSE_ONLY_ROUNDS): base RPC");
    assertDevnetUrl(ROUTER_ENDPOINT.url, "house-only rounds (KEEPER_HOUSE_ONLY_ROUNDS): Magic Router");
    assertDevnetUrl(validator.fqdn, "house-only rounds (KEEPER_HOUSE_ONLY_ROUNDS): ER validator");
  }

  await fundHouseBank(client, operator, bank, options.dryRun);

  // ONE BATCHED READ, NOT ONE PER WALLET — the same defect `fundHouseBank` carried, in a second
  // place, and it took the keeper down to find it. This was a `Promise.all` firing a `getBalance` per
  // house wallet. At a pool of six that is invisible; at forty-eight it earns
  // `429 Connection rate limits exceeded` from api.devnet.solana.com and the process dies with
  // KEEPER FAILED TO START — before the HTTP server binds, so Fly reports it as "instance refused
  // connection" and the actual cause is four lines further up the log.
  //
  // The boot BANNER is what needed these, which is the galling part: the keeper failed to start
  // because it was trying to print a table. Batched through `getMultipleAccountsInfo` (100 keys per
  // call, so any pool inside `HOUSE_WALLET_COUNT_MAX` is one call), with a null entry meaning an
  // account that does not exist yet — zero lamports, which is exactly the state a freshly generated
  // wallet is in on the boot that first funds it.
  const operatorBalance = await client.balance(operator.publicKey);
  const houseInfos = await client.base.getMultipleAccountsInfo(
    bank.active.map((w) => w.keypair.publicKey),
  );
  const houseBalances = houseInfos.map((info) => info?.lamports ?? 0);
  heading(`ROUND KEEPER${options.dryRun ? `  ${c.y}(DRY RUN — no transactions will be sent)${c.x}` : ""}`);
  plain(`  program        ${PROGRAM_ID.toBase58()}`);
  plain(`  arena pda      ${client.arenaPda.toBase58()}${arena ? "" : `  ${c.y}(not initialised — the keeper will init_arena)${c.x}`}`);
  plain(`  operator       ${operator.publicKey.toBase58()}  ${fmtSol(operatorBalance!)}${arena ? "  (arena authority)" : ""}`);
  plain(`  er validator   ${validator.fqdn}  ${c.d}${validator.identity.toBase58()}${c.x}`);
  // WHICH ENDPOINTS, AND WHETHER THEY CAME FROM THE ENVIRONMENT. An operator who set a paid RPC to
  // stop being rate-limited needs one line proving it is the one in use; without it, "I configured
  // it" and "it is configured" are the same sentence. API keys are masked — see `describeEndpoints`.
  for (const { label, text } of describeEndpoints()) plain(`  ${label.padEnd(15)}${text}`);
  plain(`  clock          ${client.clockOffsetSeconds() === 0 ? "in step with the chain" : `${Math.abs(client.clockOffsetSeconds())}s ${client.clockOffsetSeconds() > 0 ? "behind" : "ahead of"} the chain — corrected`}`);
  // "in the bank", not "disclosed". Nothing about these wallets is disclosed any more — the status
  // file no longer names, lists or counts them — and a banner that still said so would be the first
  // thing an operator read and the last place anybody would look for a stale claim.
  plain(`  house wallets  ${bank.active.length} active of ${bank.bankPubkeys.length} in the bank`);
  // THE PUBKEYS AND THEIR BALANCES STAY, AND THAT IS NOT AN OVERSIGHT. This is the process's own
  // stdout — Fly's log stream, reachable only by somebody who can already `fly ssh` into the machine
  // and read the wallet file itself. It is not a published channel, and the distinction this whole
  // change turns on is PUBLISHED versus INTERNAL rather than secret versus not. An operator funding a
  // bank needs to see which wallet is empty, and taking that away would buy no privacy from anyone
  // who did not already have the keys.
  bank.active.forEach((wallet, i) => {
    plain(`    [${wallet.index}] ${wallet.keypair.publicKey.toBase58()}  ${fmtSol(houseBalances[i]!)}`);
  });
  plain(`  status file    ${publisher.path}`);
  // BOTH CHANNELS, named, because "the status is published" is not a fact an operator can act on and
  // "it is at this URL, or it is not being served at all" is. A null server is a bind failure that has
  // already been logged as an error; repeating it here is what stops it scrolling past unread.
  //
  // `RECLAMATION_PATH` JOINS IT FOR THAT SAME ARGUMENT. `startStatusServer` names all three in its own
  // ok() line, and that line is exactly the one that does not print on the boot where the port could
  // not be bound — which is the boot on which an operator most needs to know that the endpoint they
  // were told to watch is not there. This is also the only place the reclamation route is advertised
  // to somebody who reads the banner and nothing else.
  plain(`  status http    ${statusServer === null
    ? `${c.r}NOT SERVING — the port could not be bound (see the error above). A deployed page will read this keeper as down, and ${RECLAMATION_PATH} is not answering either.${c.x}`
    : `http://${BIND_HOSTNAME}:${statusServer.port}${STATUS_PATH}  ${c.d}(health: ${HEALTH_PATH}, reclamation: ${RECLAMATION_PATH})${c.x}`}`);
  // THE ROSTER ENDPOINT, IN THE BANNER AND NOT ONLY IN `startStatusServer`'s OWN LOG LINE. The two
  // are not redundant: a bind failure returns null from that function before it logs anything, so on
  // the one boot where the operator most needs to know the state of every endpoint, its line is the
  // one that did not print. The banner always prints. Same argument as the `status http` line above,
  // which exists for exactly this reason.
  //
  // WHAT THE OFF CASE COSTS IS STATED HERE RATHER THAN LEFT TO BE INFERRED, because it is a total
  // feature outage at a different host: the identity API fails closed, so no token means no avatars
  // for anybody, and nothing on either side renders an error a person would notice.
  plain(`  house roster   ${houseTokenPolicy.enabled
    ? `${HOUSE_PATH} ${c.d}(authenticated; ${HOUSE_TOKEN_ENV} is set)${c.x}`
    : `${c.y}NOT served — no ${HOUSE_TOKEN_ENV}. The identity API fails closed and will show NO avatars at all.${c.x}`}`);
  plain(`  cors           ${originPolicy.configured
    ? originPolicy.origins.join(", ")
    : `${c.y}local development only (${originPolicy.origins.join(", ")}) — set KEEPER_CORS_ORIGIN for a deployment${c.x}`}`);
  // WHICH POLICY IS RUNNING, in the operator's own words, because the two behave so differently that
  // reading the log without knowing which one is in force is guesswork. The hold-open line states the
  // three numbers that decide everything about it; the other states the one that decides its cost.
  //
  // THE FIXED-CADENCE LINE NO LONGER CLAIMS A PERMANENT LOSS, and the change is the point rather than
  // a wording preference. It said each round "permanently locks ~0.0085 SOL" — a figure measured at
  // sixteen fighters, and a claim that stopped being true when `close_round_account` shipped. Rent is
  // FLOAT now: the arena carries `ROUND_RETENTION` rounds' worth and gets each one back. What the
  // cadence actually costs is that float and the risk on it, which is a smaller number honestly
  // stated — and stating the old one would have argued for hold-open on a saving that no longer
  // exists, in front of an operator deciding whether to turn it on.
  //
  // HOUSE-ONLY GETS THE FIRST BRANCH BECAUSE IT OVERRIDES THE OTHER TWO. With both flags set the
  // hold-open line would be wrong twice — the lobby is `DEFAULT_LOBBY_SECONDS` rather than the
  // backstop, and nothing is being held for anybody — and a banner line that is wrong under a
  // combination nobody refuses is worse than no line at all.
  plain(options.houseOnlyRounds
    ? `  lobby policy   ${c.y}HOUSE-ONLY${c.x} — a fresh ${DEFAULT_LOBBY_SECONDS}s lobby every round, drawn at its own deadline with nobody real in it` +
      `${options.holdOpen ? ` ${c.d}(--hold-open is also set: its backstop collapses into this schedule, and its ${REAL_PLAYER_GRACE_SECONDS}s early close still fires for a real arrival)${c.x}` : ""}`
    : options.holdOpen
      ? `  lobby policy   ${c.g}HOLD OPEN${c.x} — one lobby, held for players; ${HOLD_OPEN_LOBBY_SECONDS}s backstop · ${REAL_PLAYER_GRACE_SECONDS}s grace after the first real entry`
      : `  lobby policy   fixed cadence — a fresh ${DEFAULT_LOBBY_SECONDS}s lobby every round ${c.d}(--hold-open is off; each round floats ~${fmtSol(ROUND_RENT_LAMPORTS)} of rent whether or not anyone plays, back after ${ROUND_RETENTION} newer rounds — and gone for good on any round that cannot be closed)${c.x}`);
  // THE HOUSE'S SHAPE AND WHAT IT PUTS AT RISK, on its own line and printed under BOTH policies —
  // because the treasury rule no longer depends on which one is running, and because these five
  // numbers are the ones an operator retunes. Mean stake is the midpoint of the band, so the exposure
  // figure is the honest expected total rather than a worst case: it is what the house has on the
  // board in a round with one real player in it, which is the shape almost every live round has had.
  //
  // AND THE TAIL OF IT IS NOW CONDITIONAL, because "N fighter and no fight when nobody is" is exactly
  // the sentence house-only makes false. What the mode fields instead is NOT the board target: the
  // board is what `houseFighterCount` asks for, and `plannedHouseEntries` then holds `REAL_SEATS_RESERVED`
  // seats back out of the round's own seat count — at the production 48-seat round that reservation is
  // the term that binds, and the arithmetic is `houseBank.ts`'s, beside `houseCeiling`. The seat count
  // is the chain's number and this banner has no round to read it off, so the line states the
  // subtraction rather than a total it would be guessing at.
  const houseOnlyWanted = houseFighterCount({ side0: 0, side1: 0 }, "house-only");
  plain(
    `  house          board of ${HOUSE_BOARD_TARGET} · ${HOUSE_WALLET_COUNT} wallets · ${HOUSE_DISPLACEMENT} seat(s) yielded per real entrant · ` +
    `$${HOUSE_STAKE_MIN_USD}-$${HOUSE_STAKE_MAX_USD} stakes ` +
    `${c.d}(~$${((HOUSE_BOARD_TARGET - 1) * (HOUSE_STAKE_MIN_USD + HOUSE_STAKE_MAX_USD) / 2).toFixed(0)} of house stake on the board against a lone real player; ` +
    `${options.houseOnlyRounds
      ? `min(${houseOnlyWanted}, seats − ${REAL_SEATS_RESERVED}) fighters AND A FIGHT when nobody is`
      : `${HOUSE_MAX_WITHOUT_REAL_PLAYER} fighter and no fight when nobody is`})${c.x}`,
  );
  plain(`  cadence        result hold ${RESULT_HOLD_SECONDS}s · draw timeout ${DRAW_TIMEOUT_SECONDS}s · heartbeat ${HEARTBEAT_INTERVAL_SECONDS}s/stale ${STALE_AFTER_SECONDS}s`);
  plain(`  house sweep    ${features.houseTakeSweep
    ? "on — each finished round's fees and penalties are swept onto the arena's Treasury"
    : `${c.d}unavailable — this IDL has no sweep_house_take; each round's take stays on the round${c.x}`}`);
  // THE MOST CONSEQUENTIAL LINE IN THIS BANNER, in money terms. 95.4% of what a round costs is rent
  // that used to be unrecoverable, so which of these two states the keeper booted in is the
  // difference between ~740 more rounds on the current payer and ~16,200.
  plain(`  rent           ${!options.closeRounds
    ? `${c.y}NOT reclaimed — --no-close-rounds/KEEPER_CLOSE_ROUNDS=0 is set; every round keeps its ~${fmtSol(ROUND_RENT_LAMPORTS)} deposit forever${c.x}`
    : features.roundAccountClose
      ? `${c.g}reclaimed${c.x} — finished rounds are closed once ${ROUND_RETENTION} newer ones exist, returning ~${fmtSol(ROUND_RENT_LAMPORTS)} each`
      : `${c.y}unavailable — this IDL has no close_round_account (or no sweep to precede it); each round keeps its ~${fmtSol(ROUND_RENT_LAMPORTS)} deposit forever${c.x}`}`);
  plain(`  funding floor  ${fmtSol(MIN_BALANCE_LAMPORTS)} — below this the keeper finishes the round in flight and opens no more`);
  // PRINTED ON EVERY BOOT, UNLIKE THE BURN BRAKE'S DESCRIPTION, and that asymmetry is the reason this
  // line exists rather than a paragraph in the house-only block beside it. The brake is explained in
  // the `--house-only-rounds` warning, which production does not print — `fly.toml` deliberately does
  // not set that flag — so a deployed operator has never seen either stop described. This is the one
  // that can fire in the first minute of a run, on chain state, with no samples and no warm-up, so it
  // is the one that must not be a surprise. Its threshold is env-overridable, and this file's standing
  // rule for those is that the honest way to say "I accept this" is a number the boot banner prints.
  plain(`  sweep stop     ${SWEEP_GAP_STOP_ROUNDS} round(s) — if round_counter runs this far ahead of Treasury.rounds_swept the keeper opens no more ${c.d}(past the ${ROUND_RETENTION}-round retention window, where an unswept round's rent has stopped coming back; armed on the first treasury poll, and it LATCHES)${c.x}`);
  plain(`  stop after     ${options.rounds === null ? "never — runs until stopped" : `${options.rounds} completed round(s)`}`);
  plain("");

  // LAST, SO IT CANNOT SCROLL PAST. Everything above is a table an operator skims; this is the block
  // that says a guarantee has been given up, and it is printed immediately before the loop starts so
  // it is the final thing on screen when the rounds begin. It prints ONLY when the mode is on, which
  // is what stops it becoming a banner people learn to skip on every ordinary boot. `warn` rather
  // than `plain` because these lines are coloured and this one has to be the loudest thing here.
  if (options.houseOnlyRounds) {
    heading("HOUSE-ONLY ROUNDS ARE ON");
    warn(`  Turned on by KEEPER_HOUSE_ONLY_ROUNDS=1 (or --house-only-rounds). UNSETTING IT RESTORES`);
    warn(`  TODAY'S BEHAVIOUR EXACTLY — there is no migration, no state to unwind, and no round already`);
    warn(`  opened that behaves differently afterwards. The next boot is simply the old keeper.`);
    warn(``);
    warn(`  WHAT IT RETIRES. A room with nobody real in it normally holds ONE house fighter, which is`);
    warn(`  below the program's enough_to_fight — so no house-versus-house round can be drawn by this`);
    warn(`  keeper OR by a permissionless caller racing it at the deadline, and abandon_round stays`);
    warn(`  legal so the round always reaches a terminal state. BOTH OF THOSE STOP BEING TRUE while`);
    warn(`  this is on. "The house never fights itself" was a property the CHAIN enforced; for as long`);
    warn(`  as this runs it is not enforced by anything.`);
    warn(``);
    warn(`  THE NEW EXPOSURE, WHICH IS THE PART NOBODY GUESSES. A house-only lobby is past`);
    warn(`  enough_to_fight, so abandon_round is refused on it — the only instruction that can end it`);
    warn(`  is close_lobby_and_draw. If that cannot land (a dead ER validator, a VRF queue that`);
    warn(`  refuses, a delegation lost) the round sits in Lobby with nothing left that will succeed on`);
    warn(`  it, and its ~0.0235 SOL is stranded PERMANENTLY: close_round_account needs house_swept and`);
    warn(`  sweeping needs a terminal phase. COST-MODEL §4.2 records 19 rounds already in that state,`);
    warn(`  holding ~0.16 SOL that no instruction will ever return. The keeper retries the draw`);
    warn(`  forever, so this is not a new code path — it is the same path, walked by every round`);
    warn(`  instead of only by the rare one somebody played.`);
    warn(``);
    warn(`  WHAT IT COSTS. ~0.031 SOL/day while close_round_account keeps reclaiming rent, and`);
    warn(`  ~9.96 SOL/day the moment it silently stops — 330x, with no exception, no failed`);
    warn(`  transaction and a keeper that looks perfectly healthy throughout. That mechanism has NEVER`);
    warn(`  RUN at MAX_FIGHTERS = 48, where rent is 2.7x what it was the last time it was observed`);
    warn(`  working. This mode is what makes that gap something the arena runs into rather than`);
    warn(`  something it can reason about.`);
    warn(``);
    warn(`  THE BOARD IT FIELDS IS min(${houseOnlyWanted}, seats − ${REAL_SEATS_RESERVED}) — the seat reservation is not yielded to`);
    warn(`  this mode. At the production 48-seat round that reservation is the term that binds, so a`);
    warn(`  house-only round fields 39 fighters and not 48, and nine seats stand empty for the whole`);
    warn(`  lobby, held for a visitor who is MORE likely to arrive into one of these rounds than into`);
    warn(`  any other — these are the rounds that run all day.`);
    warn(``);
    warn(`  WHERE TO WATCH IT: GET ${RECLAMATION_PATH}. It carries the sweep gap`);
    warn(`  (Arena.round_counter minus Treasury.rounds_swept, polled every ${TREASURY_POLL_SECONDS}s), the rounds the`);
    warn(`  closer skipped and the ones it found stranded, and the measured burn per round.`);
    warn(`  THE BRAKE: the keeper stops opening rounds if the mean net cost of the last`);
    warn(`  ${BURN_SAMPLE_ROUNDS} rounds exceeds ${fmtSol(MAX_BURN_LAMPORTS_PER_ROUND)}/round, and it will not form an opinion`);
    warn(`  before ${BURN_ARM_AFTER_ROUNDS} rounds have been sampled (a young arena legitimately pays full rent for its`);
    warn(`  first ${ROUND_RETENTION}). That stop DOES NOT CLEAR ITSELF — fix the cause and restart the keeper.`);
    warn(`  THE SWEEP-GAP STOP covers the hours the brake cannot: its ${BURN_ARM_AFTER_ROUNDS} samples live in process`);
    warn(`  memory and start empty on EVERY boot, so a restart buys ~${(BURN_ARM_AFTER_ROUNDS * 204 / 3600).toFixed(1)}h with no brake at all. This`);
    warn(`  one is a subtraction over chain state and is armed on the first treasury poll: the keeper`);
    warn(`  stops opening rounds once round_counter is ${SWEEP_GAP_STOP_ROUNDS} or more ahead of rounds_swept (past the`);
    warn(`  ${ROUND_RETENTION}-round retention window, where the rent was due back). It latches for the same reason.`);
    warn(``);
    warn(`  DEVNET ONLY. Every endpoint this mode will touch — base RPC, Magic Router and the ER`);
    warn(`  validator's own fqdn — was re-asserted against the devnet allowlist above, naming this`);
    warn(`  feature, and the process refuses to start anywhere else.`);
    plain("");
  }

  const ctx: KeeperContext = {
    client, publisher, bank, operator, validator, options, features,
    // ONE DERIVATION OF THE POLICY, HERE, at the boundary where the operator's flag becomes the
    // keeper's vocabulary — see `KeeperContext.emptyRoom`.
    emptyRoom: options.houseOnlyRounds ? "house-only" : "unfightable",
    timeline: freshTimeline(null, null),
    roundsCompleted: 0,
    roundsAbandoned: 0,
    stop: false,
    refreshAfterStep: false,
    lastDrawLogSec: 0,
    lastHoldLogSec: 0,
    // #1, on every boot — see the field's comment. This is the line that makes the backlog get
    // drained rather than only the rounds this process happens to open.
    closeCursor: 1n,
    closeAttempts: 0,
    closeRetryAfterSec: 0,
    rentReclaimed: 0,
    closeSkipped: { sample: [], total: 0 },
    closeStrandedNeverTerminal: { sample: [], total: 0 },
    closeStrandedStillDelegated: { sample: [], total: 0 },
    lowBalanceSince: null,
    lowBalanceCheckedAtSec: 0,
    treasury: null,
    treasuryPolledAtSec: 0,
    burnSamplesLamports: [],
    lastOpenLamports: null,
    burnStopSince: null,
    sweepStopSince: null,
    operatorLamportsObserved: operatorBalance,
    firstOpenAtSec: null,
    opensObserved: 0,
  };

  // INSTALLED AFTER BOOT, ON PURPOSE. A failure during boot — an unreadable keypair, an arena whose
  // authority is somebody else, no writable validator — must exit non-zero, because none of those
  // resolve themselves and a keeper that spun on them would look alive while doing nothing. Past this
  // point the opposite is true: everything that decides an action is re-read from the chain every
  // second, so no stray rejection can leave this process in a state its next pass will not repair,
  // and dying from one would end rounds that are otherwise running perfectly.
  process.on("unhandledRejection", (reason) => {
    recordError(ctx, "unhandledRejection", reason);
    warn("keeper is continuing — the next pass re-derives everything from the chain");
  });
  process.on("uncaughtException", (e) => {
    recordError(ctx, "uncaughtException", e);
    warn("keeper is continuing — the next pass re-derives everything from the chain");
  });

  let stopSignalled = false;
  const onSignal = (signal: string) => {
    if (stopSignalled) {
      error(`second ${signal} — exiting immediately`);
      process.exit(130);
    }
    stopSignalled = true;
    stopper.abort();
    warn(`${signal} received — finishing the current step, then stopping`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  // SIGHUP too: a keeper started from a terminal that is then closed would otherwise die without
  // running the exit path that stops the heartbeat, leaving a file that claims a live process.
  process.on("SIGHUP", () => onSignal("SIGHUP"));

  publisher.startHeartbeat();
  publisher.publish();

  let consecutiveErrors = 0;
  let lastState: KeeperChainState | null = null;
  while (!ctx.stop && !stopSignalled) {
    try {
      const state = await client.readChainState();
      lastState = state;
      setLogRound(state.roundCounter > 0n ? state.roundCounter : null);
      if (state.roundCounter > 0n && ctx.timeline.roundNo !== state.roundCounter) {
        ctx.timeline = freshTimeline(state.roundCounter, null);
      }
      publishRoundSnapshot(ctx, state);
      await driveOneStep(ctx, state);

      // A step that moved the round's phase leaves the snapshot taken above describing the previous
      // instant, while whatever the step published describes this one. Re-reading costs one RPC on
      // the few passes that change anything, and it is what keeps the file's two halves from
      // contradicting each other — a sample once caught `nextLobbyOpensAt` set beside a round still
      // reading `Fight`, which the contract says never happens.
      if (ctx.refreshAfterStep) {
        ctx.refreshAfterStep = false;
        publishRoundSnapshot(ctx, await client.readChainState());
      } else {
        // HOUSEKEEPING ONLY ON A PASS THAT DID NOTHING ELSE. `refreshAfterStep` is set by every step
        // that moved the round on, so its absence is the loop's own signal that this pass was idle —
        // which is exactly the pass that can afford one account read and possibly one small
        // transaction. Reclaiming rent must never be the reason a fight ticks late.
        //
        // It is also why this sits outside `driveOneStep`: that function is the PHASE machine, and
        // closing an ancient round is not a phase of the current one. Putting it there would have
        // meant a branch in every case, or a case that is not a phase.
        await closeOneFinishedRound(ctx, state);
        // The second witness, on the same idle passes and for the same reason: it is one account read
        // on its own slow interval, and it must never be what makes a fight tick late. See
        // `pollTreasury`.
        await pollTreasury(ctx, state);
      }
      // ONE RENDER PER PASS, BESIDE THE PUBLISH IT MIRRORS. Both channels are refreshed at the one
      // point in the loop where the pass's work is finished and its observations are complete, so a
      // reader of either one is reading the same instant. The rate is passed as the MEASURED
      // rounds/day, or 0 to say it has not been measured — which `summariseReclamation` renders as
      // null rather than as a daily burn of zero.
      reclamationBody = renderReclamation(
        reclamationStateOf(ctx, state.nowSec),
        measuredRoundsPerDay(ctx, state.nowSec) ?? 0,
      );
      publisher.publish();

      consecutiveErrors = 0;
      // A clean pass clears both. `lastError` otherwise persists for the life of the process, so a
      // single blip at minute two is still on screen at hour six, indistinguishable from a keeper
      // that is failing right now.
      publisher.setLastError(null);
      publisher.setStalledSince(null);
    } catch (e) {
      consecutiveErrors += 1;
      recordError(ctx, "main-loop", e);
      if (consecutiveErrors === STALL_AFTER_CONSECUTIVE_FAILURES) {
        // ONCE, at the threshold, not on every failing pass. From here the heartbeat keeps saying the
        // process is alive — which it is — so the status file has to say the other thing too, or the
        // page keeps promising a round that nothing is going to run. See
        // `STALL_AFTER_CONSECUTIVE_FAILURES`.
        publisher.setStalledSince(ctx.client.nowSec());
        error(`STALLED — ${consecutiveErrors} consecutive failed passes. The keeper is alive and is`);
        error(`  retrying, but nothing is progressing, and the status file now says so: any countdown`);
        error(`  the page was drawing stops. It clears itself on the first clean pass.`);
      }
      publisher.publish();
      const backoff = Math.min(ERROR_BACKOFF_BASE_SECONDS * 2 ** (consecutiveErrors - 1), ERROR_BACKOFF_MAX_SECONDS);
      warn(`backing off ${backoff}s (${consecutiveErrors} consecutive failure${consecutiveErrors === 1 ? "" : "s"})`);
      await sleep(backoff * 1_000, stopper.signal);
      continue;
    }

    if (options.dryRun) {
      // ONE PASS AND OUT. A dry run that looped would re-log the same "would send" line forever,
      // because nothing it does can change the state it is reading. One full pass proves what a dry
      // run is for: the keypairs load, the validator resolves, the chain reads decode, the phase
      // machine reaches a decision, and the status file is written.
      heading("DRY RUN COMPLETE");
      plain(`  chain read     ${describeState(ctx, lastState)}`);
      plain(`  would send     ${client.dryRunPlan.length === 0
        ? `${c.d}nothing — no transaction was due on this pass${c.x}`
        : client.dryRunPlan.join(", ")}`);
      plain(`  status file    written to ${publisher.path}`);
      plain(`  ${c.d}No transactions were sent. Re-run without --dry-run to actually keep rounds.${c.x}`);
      break;
    }
    await sleep(LOOP_INTERVAL_SECONDS * 1_000, stopper.signal);
  }

  // ONE FINAL STATUS, THEN OUT — with the round exactly as it stands, and WITHOUT bumping the
  // heartbeat. That omission is the point: a keeper that wrote a fresh heartbeat on its way out would
  // leave a file claiming a live process for another `staleAfterSeconds`, and a page would keep
  // drawing a countdown for a round nobody is going to run. Letting the heartbeat go stale is exactly
  // the correct signal, and it arrives on its own within `staleAfterSeconds`.
  publisher.stopHeartbeat();
  publisher.publish();

  // AND THE PROCESS ACTUALLY HAS TO EXIT. `Bun.serve` holds the event loop open exactly as a listening
  // socket should, so without this the keeper would print "KEEPER STOPPED", stop keeping rounds, and
  // then sit there serving a status whose heartbeat is going stale — a process the platform believes
  // is healthy, running nothing. `--rounds N` would never return and a SIGTERM would need a second
  // signal to land.
  //
  // Closing it is also the honest signal. A page polling a keeper that has stopped gets a connection
  // refused, which `useKeeperStatus` reads exactly as it reads a 404 and a stale heartbeat: there is
  // no keeper status. Serving one last frozen payload on the way out would say less, later.
  statusServer?.stop();

  heading("KEEPER STOPPED");
  plain(`  rounds completed  ${ctx.roundsCompleted}`);
  plain(`  rounds abandoned  ${ctx.roundsAbandoned}`);
  // Stated as a measured total rather than left to be inferred from the balance, because the balance
  // moved for several reasons during the run and this is the only one that moved it UP.
  //
  // PRICED THROUGH `ROUND_RENT_LAMPORTS` RATHER THAN THE 0.008561 THIS LINE USED TO CARRY. That figure
  // was measured at sixteen fighters; rent moves with the seat cap and is 0.023497 at forty-eight
  // (COST-MODEL §1). Leaving it would have put a stale price on the rent that came BACK directly above
  // a current price on the rent that did not, in the same block, differing by 2.7x.
  plain(`  rent reclaimed    ${ctx.rentReclaimed} round account(s)${ctx.rentReclaimed > 0 ? `  ~${fmtSol(ctx.rentReclaimed * ROUND_RENT_LAMPORTS)} returned` : ""}`);
  // WHAT DID NOT COME BACK, IN THE UNIT THAT MAKES IT ACTIONABLE. "2 rounds skipped" and "0.047 SOL
  // you are never getting back" are the same fact and only one of them makes anybody do something.
  // These are the TOTALS, not the bounded samples that go with them — see `CLOSE_LOSS_SAMPLE`.
  const skipped = ctx.closeSkipped.total;
  const neverTerminal = ctx.closeStrandedNeverTerminal.total;
  const stillDelegated = ctx.closeStrandedStillDelegated.total;
  const stranded = neverTerminal + stillDelegated;
  plain(`  rounds skipped    ${skipped}${skipped > 0 ? `  ~${fmtSol(skipped * ROUND_RENT_LAMPORTS)} given up on after ${CLOSE_ATTEMPTS_PER_ROUND} failed closes each` : ""}`);
  plain(`  rounds stranded   ${stranded}${stranded > 0 ? `  ~${fmtSol(stranded * ROUND_RENT_LAMPORTS)} ${c.d}(${neverTerminal} never terminal / ${stillDelegated} still delegated — no instruction can close either)${c.x}` : ""}`);
  // MEASURED OR "UNKNOWN", NEVER A PLAUSIBLE ZERO — this block's standing rule, and these two are
  // exactly the fields it was written for. A sweep gap of 0 from a treasury nobody read and a burn of
  // 0.000000 SOL from a run with one sample are both numbers that would be believed.
  const treasury = ctx.treasury;
  plain(`  sweep gap         ${treasury === null
    ? "unknown — the treasury was never polled"
    : treasury.roundsSwept === null
      ? "unknown — this program has no Treasury account"
      : `${treasury.roundCounter - treasury.roundsSwept} round(s) ${c.d}(round_counter minus rounds_swept, as of ${ctx.client.nowSec() - treasury.polledAtSec}s ago; ` +
        `the stop ${ctx.sweepStopSince === null ? `is at ${SWEEP_GAP_STOP_ROUNDS} and did not fire` : "FIRED"})${c.x}`}`);
  const finalBurn = burnBrake(
    ctx.burnSamplesLamports, MAX_BURN_LAMPORTS_PER_ROUND, BURN_ARM_AFTER_ROUNDS, BURN_SAMPLE_ROUNDS,
  );
  plain(`  burn per round    ${finalBurn.meanLamportsPerRound === null
    ? "unknown — no round was opened twice, so nothing was sampled"
    : `${fmtSol(finalBurn.meanLamportsPerRound)} ${c.d}(mean of ${finalBurn.samples} sample(s) of ${ctx.burnSamplesLamports.length}; the brake ${finalBurn.armed ? (finalBurn.tripped ? "TRIPPED" : "was armed and did not trip") : `needs ${BURN_ARM_AFTER_ROUNDS} to have an opinion`})${c.x}`}`);
  // CAUGHT, because this is the last line of a SUCCESSFUL run. `balance` goes through `withReadRetry`
  // and throws after four attempts, and a rejection here escapes into `main().catch()` — which prints
  // `KEEPER FAILED TO START` and exits 1, for a keeper that ran for six hours and stopped exactly as
  // asked. The operator would get a torn banner followed by a startup-failure message describing
  // nothing that happened. A balance nobody could read is worth "unknown", not an inverted exit code;
  // `fmtDuration` already takes the same position on an unobserved measurement.
  const finalBalance = await client.balance(operator.publicKey).catch(() => null);
  plain(`  operator balance  ${finalBalance === null ? "unknown — the final read failed" : fmtSol(finalBalance)}`);
  plain(`  ${c.d}the status file is left in place; its heartbeat goes stale within ${STALE_AFTER_SECONDS}s, which is how the UI learns the keeper is down${c.x}`);
}

// Boot failures exit non-zero and say why. `parseCliOptions`' own errors already carry the usage
// text, so nothing is appended here — printing it twice for one mistake reads as a second problem.
main().catch((e) => {
  error(`KEEPER FAILED TO START: ${describeError(e)}`);
  process.exit(1);
});
