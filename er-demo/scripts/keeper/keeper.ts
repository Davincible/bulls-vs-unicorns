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
//   Lobby, expired, >= 2        -> close_lobby_and_draw, DIRECT to this round's own ER validator
//   Lobby, expired, < 2         -> abandon_round, then straight on to the next round
//   Drawing                     -> wait for the VRF callback, bounded; then walk away (see the wedge)
//   Fight                       -> tick once a second; resolve once it is over or the bell has rung
//   Settled, still delegated    -> close_round
//   Settled / Abandoned, home   -> hold until nextLobbyOpensAt, then open_round for counter + 1
//
// Round numbers always come from `arena.round_counter + 1`. Never from memory: `open_round` requires
// `round_no == round_counter + 1` and the counter is the only thing that knows.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, type PublicKey } from "@solana/web3.js";

import {
  FIGHT_TIMEOUT_SECONDS, PHASE_NAME, Phase, PROGRAM_ID,
  canonicalCursor, lobbyIsDead, lobbyIsOpen,
} from "../../src/chain/constants.ts";
import type { RawRoundAccount } from "../../src/chain/program.ts";
import * as roundIx from "../../src/chain/round.ts";

import {
  ABANDON_HOLD_SECONDS, ARENA_FEE_BPS, CLOCK_SKEW_MARGIN_SECONDS, DEFAULT_LOBBY_SECONDS,
  DELEGATION_WAIT_SECONDS, DRAW_TIMEOUT_SECONDS, ERROR_BACKOFF_BASE_SECONDS, ERROR_BACKOFF_MAX_SECONDS,
  HEARTBEAT_INTERVAL_SECONDS, HOLD_OPEN_LOBBY_SECONDS, HOUSE_ENTRY_RETRY_SECONDS,
  LOOP_INTERVAL_SECONDS, REAL_PLAYER_GRACE_SECONDS, RESOLVE_RETRY_ATTEMPTS,
  RESOLVE_RETRY_WAIT_SECONDS, RESULT_HOLD_SECONDS, STALE_AFTER_SECONDS,
  STALL_AFTER_CONSECUTIVE_FAILURES, UNDELEGATE_WAIT_SECONDS,
  parseCliOptions, type KeeperCliOptions,
} from "./config.ts";
import { lobbyIsHeldOpen, planLobby, type LobbyPlan } from "./lobbyPolicy.ts";
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

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
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
    case Phase.Abandoned: return driveAbandoned(ctx, state);
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
    ctx.bank, round, state.roundCounter, state.nowSec, { drawAt: plan.drawAt, heldOpen: plan.heldOpen },
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
  if (result.failed > 0) {
    ctx.timeline.houseRetryAfterSec = state.nowSec + HOUSE_ENTRY_RETRY_SECONDS;
    // Surfaced to the status file, not just the log. A house wallet that has run dry fails every entry
    // of every round without throwing, so `lastError` would otherwise stay null while the arena
    // quietly emptied and every lobby died under-subscribed — the exact 3am failure this file's
    // design is meant to make impossible to have silently.
    ctx.publisher.setLastError({
      at: state.nowSec,
      context: "house-enter",
      message: `${result.failed} of ${entries.length} house entries failed on round #${round.roundNo}`,
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

  if (state.nowSec < opensAt) return; // holding, so the result can be read before the arena moves on
  return openNextRound(ctx, state.roundCounter + 1n);
}

async function driveAbandoned(ctx: KeeperContext, state: KeeperChainState): Promise<void> {
  // Latched for the same reason as the settled hold — see `driveSettled`.
  if (ctx.timeline.abandonedObservedAtSec === null) ctx.timeline.abandonedObservedAtSec = state.nowSec;
  // Much shorter than the settled hold, and for a different reason: there is no result to show, so
  // this is room for the commit_and_undelegate rather than a display pause. Same retention rule as
  // `driveSettled` — the abandoned round stays published alongside the countdown.
  const opensAt = ctx.timeline.abandonedObservedAtSec + ABANDON_HOLD_SECONDS;
  ctx.publisher.setNextLobbyOpensAt(opensAt);
  if (state.nowSec < opensAt) return;
  return openNextRound(ctx, state.roundCounter + 1n);
}

async function openNextRound(ctx: KeeperContext, roundNo: bigint): Promise<void> {
  // Sampled BEFORE anything is spent, so the per-round cost reported at settlement is measured rather
  // than estimated. It includes the round PDA's rent, which is the dominant term.
  const lamportsBefore = await ctx.client.balance(ctx.operator.publicKey);
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
  const operator = loadKeypair(FORK_PAYER_PATH);
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

  heading("choosing an ER validator");
  const validator = await selectWritableValidator();
  if (!validator) {
    error(NO_FRESH_VALIDATOR);
    error("  A keeper cannot work around this: every round it opened would be delegated to a route that");
    error("  cannot run the deployed code. Failing loudly beats opening rounds nobody can play.");
    process.exit(1);
  }

  const bank = loadOrCreateHouseBank(options.dryRun);
  await fundHouseBank(client, operator, bank, options.dryRun);

  const publisher = createStatusPublisher({
    programId: PROGRAM_ID.toBase58(),
    arenaPda: client.arenaPda.toBase58(),
    houseWallets: bank.disclosedPubkeys,
    disclosure: HOUSE_DISCLOSURE,
    nowSec: client.nowSec,
  });
  publisher.setErValidator({ identity: validator.identity.toBase58(), fqdn: validator.fqdn });

  const [operatorBalance, ...houseBalances] = await Promise.all([
    client.balance(operator.publicKey),
    ...bank.active.map((w) => client.balance(w.keypair.publicKey)),
  ]);
  heading(`ROUND KEEPER${options.dryRun ? `  ${c.y}(DRY RUN — no transactions will be sent)${c.x}` : ""}`);
  plain(`  program        ${PROGRAM_ID.toBase58()}`);
  plain(`  arena pda      ${client.arenaPda.toBase58()}${arena ? "" : `  ${c.y}(not initialised — the keeper will init_arena)${c.x}`}`);
  plain(`  operator       ${operator.publicKey.toBase58()}  ${fmtSol(operatorBalance!)}${arena ? "  (arena authority)" : ""}`);
  plain(`  er validator   ${validator.fqdn}  ${c.d}${validator.identity.toBase58()}${c.x}`);
  plain(`  clock          ${client.clockOffsetSeconds() === 0 ? "in step with the chain" : `${Math.abs(client.clockOffsetSeconds())}s ${client.clockOffsetSeconds() > 0 ? "behind" : "ahead of"} the chain — corrected`}`);
  plain(`  house wallets  ${bank.active.length} active of ${bank.disclosedPubkeys.length} disclosed`);
  bank.active.forEach((wallet, i) => {
    plain(`    [${wallet.index}] ${wallet.keypair.publicKey.toBase58()}  ${fmtSol(houseBalances[i]!)}`);
  });
  plain(`  status file    ${publisher.path}`);
  plain(`  cadence        lobby ${DEFAULT_LOBBY_SECONDS}s · result hold ${RESULT_HOLD_SECONDS}s · draw timeout ${DRAW_TIMEOUT_SECONDS}s · heartbeat ${HEARTBEAT_INTERVAL_SECONDS}s/stale ${STALE_AFTER_SECONDS}s`);
  plain(`  stop after     ${options.rounds === null ? "never — runs until stopped" : `${options.rounds} completed round(s)`}`);
  plain("");

  const ctx: KeeperContext = {
    client, publisher, bank, operator, validator, options,
    timeline: freshTimeline(null, null),
    roundsCompleted: 0,
    roundsAbandoned: 0,
    stop: false,
    refreshAfterStep: false,
    lastDrawLogSec: 0,
    lastHoldLogSec: 0,
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

  heading("KEEPER STOPPED");
  plain(`  rounds completed  ${ctx.roundsCompleted}`);
  plain(`  rounds abandoned  ${ctx.roundsAbandoned}`);
  plain(`  operator balance  ${fmtSol(await client.balance(operator.publicKey))}`);
  plain(`  ${c.d}the status file is left in place; its heartbeat goes stale within ${STALE_AFTER_SECONDS}s, which is how the UI learns the keeper is down${c.x}`);
}

// Boot failures exit non-zero and say why. `parseCliOptions`' own errors already carry the usage
// text, so nothing is appended here — printing it twice for one mistake reads as a second problem.
main().catch((e) => {
  error(`KEEPER FAILED TO START: ${describeError(e)}`);
  process.exit(1);
});
