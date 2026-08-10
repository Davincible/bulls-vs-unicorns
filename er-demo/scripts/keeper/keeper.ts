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
// deadline. Every round permanently locks ~0.0085 SOL of rent that nothing reclaims, whether or not
// anybody played — ~0.32 SOL/hour to cycle an arena with nobody in it, and every one of those fights
// is the house against itself.
//
// HOLD OPEN (`--hold-open`): ONE lobby with a long backstop, one house fighter in it so the room is
// not empty, held at zero marginal cost until a real player arrives — then a short grace window and
// an authority-signed early close, so the fight starts because a person showed up. One rent payment
// instead of one per cycle.
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
import * as roundIx from "../../src/chain/round.ts";

import {
  ABANDON_HOLD_SECONDS, ARENA_FEE_BPS, CLOCK_SKEW_MARGIN_SECONDS, DEFAULT_LOBBY_SECONDS,
  DELEGATION_WAIT_SECONDS, DRAW_TIMEOUT_SECONDS, ERROR_BACKOFF_BASE_SECONDS, ERROR_BACKOFF_MAX_SECONDS,
  HEARTBEAT_INTERVAL_SECONDS, HOLD_OPEN_LOBBY_SECONDS, HOUSE_BOARD_TARGET, HOUSE_DISPLACEMENT,
  HOUSE_ENTRY_RETRY_SECONDS, HOUSE_STAKE_MAX_USD, HOUSE_STAKE_MIN_USD, HOUSE_WALLET_COUNT,
  LOOP_INTERVAL_SECONDS, REAL_PLAYER_GRACE_SECONDS, RESOLVE_RETRY_ATTEMPTS,
  RESOLVE_RETRY_WAIT_SECONDS, RESULT_HOLD_SECONDS, STALE_AFTER_SECONDS,
  STALL_AFTER_CONSECUTIVE_FAILURES, SWEEP_RETRY_SECONDS, UNDELEGATE_WAIT_SECONDS,
  CLOSE_ATTEMPTS_PER_ROUND, CLOSE_RETRY_SECONDS, HTTP_PORT, LOW_BALANCE_RECHECK_SECONDS,
  MIN_BALANCE_LAMPORTS, ROUND_RETENTION, parseCliOptions, type KeeperCliOptions,
} from "./config.ts";
import { describeEndpoints } from "./endpoints.ts";
import { asSecretKeyBytes, parseSecretJson, readSecretText } from "./secrets.ts";
import {
  BIND_HOSTNAME, HEALTH_PATH, STATUS_PATH, originPolicyWarnings, resolveAllowedOrigins,
  startStatusServer,
} from "./statusServer.ts";
import { HOUSE_MAX_WITHOUT_REAL_PLAYER } from "./houseSizing.ts";
import { lobbyIsHeldOpen, planLobby, type LobbyPlan } from "./lobbyPolicy.ts";
import { decideClose, housekeepingIsWelcome, isPastRetention } from "./roundCloser.ts";
import { readProgramFeatures, type ProgramFeatures } from "./programFeatures.ts";
import {
  NO_FRESH_VALIDATOR, createChainClient, selectWritableValidator,
  type ChainClient, type ErValidator, type KeeperChainState,
} from "./chainClient.ts";
import {
  HOUSE_DISCLOSURE, enterHouseFighters, fundHouseBank, loadOrCreateHouseBank, plannedHouseEntries,
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
   *  on the least reliable thing in the system to answer a question worth twenty seconds.
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

  // ---- running out of money ----------------------------------------------------------------------

  /** Chain second at which the payer FIRST fell below the floor in the current stretch, or null while
   *  it is funded. Drives the log-once behaviour; the published latch lives in `statusFile.ts`. */
  lowBalanceSince: number | null;
  /** When the balance was last actually read for the funding guard, so a blocked keeper re-checks on
   *  an interval rather than once a second. */
  lowBalanceCheckedAtSec: number;
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
  });
  ctx.publisher.setEntriesCloseAt(plan.entriesCloseAt);

  switch (plan.step.kind) {
    case "abandon":
      return abandonRound(ctx, state, round, roundPda);
    case "close":
      // The permissionless close — the deadline has passed (or the lobby filled), and the program's
      // own rule is what permits it. `authority: null` says so in the transaction itself.
      return drawSeed(ctx, round, roundPda, null);
    case "closeEarly":
      // THE OPERATOR CHOSE THIS MOMENT, and the transaction is self-describing about it: an
      // `authority` account present means a person turned up and the keeper started their fight; the
      // same instruction with it absent means a clock ran out.
      return drawSeed(ctx, round, roundPda, ctx.operator.publicKey);
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

  const { entries, split } = plannedHouseEntries(
    ctx.bank, round, state.roundCounter, state.nowSec, { drawAt: plan.drawAt },
  );
  if (entries.length === 0) return;

  info(
    `fielding ${entries.length} house fighter(s) with ${plan.drawAt - state.nowSec}s until the lobby is drawn ` +
    `(currently ${split.realCount} real, ${split.houseCount} house)`,
  );
  // ONE STEP, not one per pass. Bringing the house up to target is a single logical action, and
  // splitting it across passes would stretch the fill stage past the deadline it exists to sit
  // inside. Each entry is individually fault-tolerant — see `enterHouseFighters`.
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
    // Surfaced to the status file, not just the log. A house wallet that has run dry fails every entry
    // of every round without throwing, so `lastError` would otherwise stay null while the arena
    // quietly emptied and every lobby died under-subscribed — the exact 3am failure this file's
    // design is meant to make impossible to have silently.
    const how = result.dropped === 0 ? "failed"
      : result.failed === 0 ? "ran out of lobby time"
      : `failed (${result.failed}) or ran out of lobby time (${result.dropped})`;
    ctx.publisher.setLastError({
      at: state.nowSec,
      context: "house-enter",
      message: `${short} of ${entries.length} house entries ${how} on round #${round.roundNo}`,
    });
  }
}

/** Close the lobby and ask the oracle for the seed.
 *
 *  `authority` is the ENTIRE difference between the two ways a lobby ends, and it is passed rather
 *  than inferred so the call site has to say which one this is:
 *
 *    * `null` — the permissionless close. The deadline has passed (or the lobby is full) and the
 *      program's own rule permits anyone to send this. Byte-for-byte the call this has always been.
 *    * the operator's key — the AUTHORITY EARLY CLOSE. A real player turned up, the grace window has
 *      run, and the arena's authority is choosing this moment. It bypasses the deadline; it cannot
 *      touch the outcome, because the seed is requested BY this instruction and delivered afterwards
 *      by `callback_seed`, so at the instant of choosing, the seed does not exist for anyone.
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
  authority: PublicKey | null,
): Promise<void> {
  // DIRECT TO THIS ROUND'S OWN ER VALIDATOR, never through the generic router. The transaction's
  // writable set includes the ephemeral VRF queue, whose delegation record names the SYSTEM PROGRAM
  // as its authority — the multi-validator router cannot place that and refuses the whole
  // transaction with "accounts delegated to different ER nodes". Full account in
  // src/chain/sendTx.ts's "SDK SURPRISE #2".
  const fqdn = await ctx.client.roundValidatorFqdn(roundPda);
  info(authority
    ? `closing the lobby early with ${round.fighterCount} fighters — a real player is in — drawing the seed via ${fqdn}`
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
 *  (`close_round`, `abandon_round`) are unreachable from `Drawing`. Its rent — ~0.0085 SOL, the
 *  dominant per-round cost — is never reclaimed, exactly as for every other round, but this one also
 *  never comes home. And if the callback arrives LATE it will move this round to `Fight`, where
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

async function resolveRound(
  ctx: KeeperContext,
  round: RawRoundAccount,
  roundPda: PublicKey,
  byTimeout: boolean,
): Promise<void> {
  info(byTimeout
    ? `the bell has rung (${FIGHT_TIMEOUT_SECONDS}s) — settling round #${round.roundNo}`
    : `one side has nobody standing — settling round #${round.roundNo}`);

  for (let attempt = 1; attempt <= RESOLVE_RETRY_ATTEMPTS; attempt++) {
    try {
      const outcome = await ctx.client.send(
        roundIx.resolve(ctx.client.program, { payer: ctx.operator.publicKey, round: roundPda }),
        ctx.operator,
        `resolve #${round.roundNo}`,
      );
      if (outcome.sent) {
        // THE RESULT HOLD STARTS HERE — derived from when `resolve` actually landed, not assumed from
        // when the fight might have ended. Latched: `driveSettled` will not re-stamp it while this
        // round stands, which is what makes the published countdown count DOWN.
        ctx.timeline.settledObservedAtSec = ctx.client.nowSec();
        ctx.refreshAfterStep = true;
      }
      return;
    } catch (e) {
      // Matched from the LOGS, never via `instanceof anchor.AnchorError` — `sendTx` sends raw, so
      // Anchor's `translateError` never runs and this is always a `SendTransactionError`. See
      // `logsOf` in log.ts, and verify-session-real.mjs step 12 where the `instanceof` form silently
      // reduced this same retry to a single attempt.
      if (!failedWith(e, "FightNotOverYet")) throw e;
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
  // LATCHED, NOT RE-STAMPED. A keeper that booted into an already-settled round did not see `resolve`
  // land, so it stamps the first moment IT saw the result — honest, and it only ever extends the hold.
  // What it must never do is stamp again on a later pass of the same round: that moves the published
  // countdown backwards, which is the one thing the result hold exists not to do.
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
  // `?? false` is the true value, not a default: a program with no sweep instruction has swept
  // nothing. See `houseSwept` in chain/program.ts.
  if (round.houseSwept ?? false) return;
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
    ctx.publisher.setLastError({
      at: state.nowSec,
      context: "house-sweep",
      message: `sweep_house_take #${round.roundNo}: ${describeError(e)}`,
    });
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
 * A `Round` is 1,102 bytes holding 0.008561 SOL of rent-exempt deposit — 95.4% of the 0.008971 a
 * whole round costs — and before v7 nothing ever reclaimed a lamport of it. This is the instruction
 * that does, and running it takes the marginal cost of a round to ~0.00041.
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
    // `?? false` is the true value rather than a default — see `houseSwept` in chain/program.ts: a
    // program with no sweep instruction has swept nothing.
    round: round === null ? null : { phase: round.phase, houseSwept: round.houseSwept ?? false },
    delegated,
  });

  if (decision.kind === "advance") {
    if (decision.because === "never-terminal") {
      warn(`round #${roundNo} is ${PHASE_NAME[round!.phase]} and past the retention window — it can never be closed, so its ~0.0086 SOL of rent is unrecoverable. Skipping it.`);
    } else if (decision.because === "still-delegated") {
      warn(`round #${roundNo} is terminal but still DELEGATED past the retention window — close_round_account cannot run while the Delegation Program owns it. Skipping it; its rent stays stranded.`);
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
      ctx.closeCursor += 1n;
      ctx.closeAttempts = 0;
    }
  }
}

/** THE FUNDING FLOOR, CHECKED AT THE ONE POINT WHERE REFUSING IS FREE.
 *
 *  Returns true when the keeper may open a round. Publishes the condition either way.
 *
 *  WHY ONLY HERE, AND NOWHERE ELSE IN THE PHASE MACHINE. Every other point in a round is PAST the
 *  expensive commitment: `open_round` has already paid ~0.0086 SOL of rent and `delegate_round` has
 *  handed the account to the ER. A keeper that downed tools mid-round on a low balance would strand
 *  that deposit for nothing and leave a real player's fight unfinished — it would convert a funding
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

  if (lamports >= MIN_BALANCE_LAMPORTS) {
    if (ctx.lowBalanceSince !== null) {
      ok(`payer is funded again — ${fmtSol(lamports)} is back above the ${fmtSol(MIN_BALANCE_LAMPORTS)} floor; opening rounds again`);
      ctx.lowBalanceSince = null;
      ctx.publisher.setLowBalance(null);
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

async function openNextRound(ctx: KeeperContext, roundNo: bigint): Promise<void> {
  // Sampled BEFORE anything is spent, so the per-round cost reported at settlement is measured rather
  // than estimated. It includes the round PDA's rent, which is the dominant term. It is the same read
  // the funding guard just did — see `affordsAnotherRound`.
  const lamportsBefore = await affordsAnotherRound(ctx, roundNo);
  if (lamportsBefore === null) return;
  const roundPda = roundIx.roundPdaForRoundNo(roundNo, ctx.client.arenaPda);
  info(`opening round #${roundNo}  pda ${roundPda.toBase58()}`);

  // Vestigial since the seed moved to the VRF oracle — any 32 bytes satisfy the on-chain format, and
  // the operator no longer chooses the seed at all. Kept because `open_round` still takes it.
  const seedCommit = crypto.getRandomValues(new Uint8Array(32));
  // THE LOBBY LENGTH MEANS TWO DIFFERENT THINGS UNDER THE TWO POLICIES, which is why it is chosen
  // here rather than fixed. Under the hold-open policy the deadline is a BACKSTOP — the keeper closes
  // the lobby itself when a player arrives, so this is only "how long before I give up on this round
  // and pay for another one". Without it the deadline is the SCHEDULE and the keeper has to open a
  // lobby of exactly the length it intends to wait, because nothing else can end one.
  const lobbySeconds = ctx.options.holdOpen ? HOLD_OPEN_LOBBY_SECONDS : DEFAULT_LOBBY_SECONDS;
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
  plain(`  fight          ${fmtDuration(fightSeconds)} ${c.d}(fight_started_at -> resolve landing)${c.x}`);
  plain(`  result hold    ${RESULT_HOLD_SECONDS}s ${c.d}(configured; close_round runs inside it)${c.x}`);
  plain(`  operator spent ${spent === null ? "unknown (this keeper did not open this round)" : `${fmtSol(spent)} ${c.d}(measured balance delta; includes the round PDA's rent, which nothing reclaims)${c.x}`}`);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Boot and the loop
// ────────────────────────────────────────────────────────────────────────────────────────────────

function publishRoundSnapshot(ctx: KeeperContext, state: KeeperChainState): void {
  if (!state.round || !state.roundPda) {
    ctx.publisher.setRound(null);
    return;
  }
  const split = ctx.bank.classify(state.round);
  // Computed from THIS snapshot, beside the counts it is consistent with, through the same predicate
  // the phase machine branches on. That is what makes `heldOpen` incapable of contradicting the
  // `phase` and `realFighterCount` published next to it.
  const heldOpen = lobbyIsHeldOpen({
    phaseCode: state.round.phase,
    lobbyClosesAt: Number(state.round.lobbyClosesAt.toString()),
    nowSec: state.nowSec,
    realFighterCount: split.realCount,
    holdOpen: ctx.options.holdOpen,
  });
  ctx.publisher.setRound(
    roundStatusFrom(state.round, state.roundPda, split.houseCount, split.realCount, heldOpen),
  );
}

/** The status file is fetched by a browser, so a failure message carrying twelve lines of program logs
 *  would be a payload rather than a signal. The full text always reaches the log; this is the summary. */
const STATUS_ERROR_MAX_CHARS = 400;

function recordError(ctx: KeeperContext, context: string, e: unknown): void {
  const full = describeError(e);
  error(`${context}: ${full}`);
  ctx.publisher.setLastError({
    at: ctx.client.nowSec(),
    context,
    message: full.length > STATUS_ERROR_MAX_CHARS ? `${full.slice(0, STATUS_ERROR_MAX_CHARS)}…` : full,
  });
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
  // `LobbyStillOpen` — an error about the clock — every twenty seconds, with a real player standing
  // in the room waiting for a fight that could not start. Better to say so before the first round.
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
  // `loadOrCreateHouseBank` moves up with it because the publisher needs the disclosure list, and it
  // is purely local — a file read (or an env var) and possibly a keygen. Nothing it does is worth
  // waiting on. `fundHouseBank` stays below: it spends, and nothing should spend before the process
  // has said it is alive.
  const bank = loadOrCreateHouseBank(options.dryRun);

  const publisher = createStatusPublisher({
    programId: PROGRAM_ID.toBase58(),
    arenaPda: client.arenaPda.toBase58(),
    houseWallets: bank.disclosedPubkeys,
    disclosure: HOUSE_DISCLOSURE,
    nowSec: client.nowSec,
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
  const statusServer = startStatusServer({
    port: HTTP_PORT,
    policy: originPolicy,
    body: publisher.body,
    heartbeatAgeSeconds: publisher.heartbeatAgeSeconds,
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

  await fundHouseBank(client, operator, bank, options.dryRun);

  const [operatorBalance, ...houseBalances] = await Promise.all([
    client.balance(operator.publicKey),
    ...bank.active.map((w) => client.balance(w.keypair.publicKey)),
  ]);
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
  plain(`  house wallets  ${bank.active.length} active of ${bank.disclosedPubkeys.length} disclosed`);
  bank.active.forEach((wallet, i) => {
    plain(`    [${wallet.index}] ${wallet.keypair.publicKey.toBase58()}  ${fmtSol(houseBalances[i]!)}`);
  });
  plain(`  status file    ${publisher.path}`);
  // BOTH CHANNELS, named, because "the status is published" is not a fact an operator can act on and
  // "it is at this URL, or it is not being served at all" is. A null server is a bind failure that has
  // already been logged as an error; repeating it here is what stops it scrolling past unread.
  plain(`  status http    ${statusServer === null
    ? `${c.r}NOT SERVING — the port could not be bound (see the error above). A deployed page will read this keeper as down.${c.x}`
    : `http://${BIND_HOSTNAME}:${statusServer.port}${STATUS_PATH}  ${c.d}(health: ${HEALTH_PATH})${c.x}`}`);
  plain(`  cors           ${originPolicy.configured
    ? originPolicy.origins.join(", ")
    : `${c.y}local development only (${originPolicy.origins.join(", ")}) — set KEEPER_CORS_ORIGIN for a deployment${c.x}`}`);
  // WHICH POLICY IS RUNNING, in the operator's own words, because the two behave so differently that
  // reading the log without knowing which one is in force is guesswork. The hold-open line states the
  // three numbers that decide everything about it; the other states the one that always did.
  plain(options.holdOpen
    ? `  lobby policy   ${c.g}HOLD OPEN${c.x} — one lobby, held for players; ${HOLD_OPEN_LOBBY_SECONDS}s backstop · ${REAL_PLAYER_GRACE_SECONDS}s grace after the first real entry`
    : `  lobby policy   fixed cadence — a fresh ${DEFAULT_LOBBY_SECONDS}s lobby every round ${c.d}(--hold-open is off; each round permanently locks ~0.0085 SOL of rent whether or not anyone plays)${c.x}`);
  // THE HOUSE'S SHAPE AND WHAT IT PUTS AT RISK, on its own line and printed under BOTH policies —
  // because the treasury rule no longer depends on which one is running, and because these five
  // numbers are the ones an operator retunes. Mean stake is the midpoint of the band, so the exposure
  // figure is the honest expected total rather than a worst case: it is what the house has on the
  // board in a round with one real player in it, which is the shape almost every live round has had.
  plain(
    `  house          board of ${HOUSE_BOARD_TARGET} · ${HOUSE_WALLET_COUNT} wallets · ${HOUSE_DISPLACEMENT} seat(s) yielded per real entrant · ` +
    `$${HOUSE_STAKE_MIN_USD}-$${HOUSE_STAKE_MAX_USD} stakes ` +
    `${c.d}(~$${((HOUSE_BOARD_TARGET - 1) * (HOUSE_STAKE_MIN_USD + HOUSE_STAKE_MAX_USD) / 2).toFixed(0)} of house stake on the board against a lone real player; ` +
    `${HOUSE_MAX_WITHOUT_REAL_PLAYER} fighter and no fight when nobody is)${c.x}`,
  );
  plain(`  cadence        result hold ${RESULT_HOLD_SECONDS}s · draw timeout ${DRAW_TIMEOUT_SECONDS}s · heartbeat ${HEARTBEAT_INTERVAL_SECONDS}s/stale ${STALE_AFTER_SECONDS}s`);
  plain(`  house sweep    ${features.houseTakeSweep
    ? "on — each finished round's fees and penalties are swept onto the arena's Treasury"
    : `${c.d}unavailable — this IDL has no sweep_house_take; each round's take stays on the round${c.x}`}`);
  // THE MOST CONSEQUENTIAL LINE IN THIS BANNER, in money terms. 95.4% of what a round costs is rent
  // that used to be unrecoverable, so which of these two states the keeper booted in is the
  // difference between ~740 more rounds on the current payer and ~16,200.
  plain(`  rent           ${!options.closeRounds
    ? `${c.y}NOT reclaimed — --no-close-rounds/KEEPER_CLOSE_ROUNDS=0 is set; every round keeps its ~0.0086 SOL deposit forever${c.x}`
    : features.roundAccountClose
      ? `${c.g}reclaimed${c.x} — finished rounds are closed once ${ROUND_RETENTION} newer ones exist, returning ~0.0086 SOL each`
      : `${c.y}unavailable — this IDL has no close_round_account (or no sweep to precede it); each round keeps its ~0.0086 SOL deposit forever${c.x}`}`);
  plain(`  funding floor  ${fmtSol(MIN_BALANCE_LAMPORTS)} — below this the keeper finishes the round in flight and opens no more`);
  plain(`  stop after     ${options.rounds === null ? "never — runs until stopped" : `${options.rounds} completed round(s)`}`);
  plain("");

  const ctx: KeeperContext = {
    client, publisher, bank, operator, validator, options, features,
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
    lowBalanceSince: null,
    lowBalanceCheckedAtSec: 0,
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
      }
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
  plain(`  rent reclaimed    ${ctx.rentReclaimed} round account(s)${ctx.rentReclaimed > 0 ? `  ~${(ctx.rentReclaimed * 0.008561).toFixed(4)} SOL returned` : ""}`);
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
