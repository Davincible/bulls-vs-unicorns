// KEEPER POLICY: WHAT TO DO WITH A LOBBY, RIGHT NOW.
//
// One pure function over one snapshot of the round. No chain, no I/O, no wall clock of its own — the
// same shape as `houseSizing.ts` and for the same reason: a judgement call you cannot run on its own
// is one nobody will ever argue with, and this one decides when a fight starts.
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE CHANGE THIS FILE EXISTS FOR
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// The keeper used to open a lobby, wait out its deadline, fight whoever was in it, and open another —
// forever, at nobody. That costs 0.00981 SOL of permanently-locked rent per cycle (see
// `HOLD_OPEN_LOBBY_SECONDS`), which is ~0.32 SOL/hour to run an arena with no players in it, and
// every one of those fights was the house against itself.
//
// Now:
//
//     open ONE round, with a long backstop deadline
//     ONE house fighter goes in, so the room is not empty (see `HOLD_OPEN_HOUSE_FIGHTERS`)
//     hold ───────────────────────────────  at ZERO marginal cost; nothing is spent while holding
//     first REAL player enters  ->  house fills in around them  ->  grace  ->  early close  ->  fight
//
// One rent payment instead of one per cycle, and the fight starts because a person showed up.
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// WHY EXACTLY ONE HOUSE FIGHTER WHILE HOLDING, AND WHY THAT IS THE LOAD-BEARING PART
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// The obvious version of this policy seeds the usual four house fighters into the held-open lobby and
// then simply declines to draw it. That version does not work, and it fails in both directions at
// once — which is worth writing down, because it is the design a reader will propose:
//
//   * AT THE BACKSTOP IT DEFEATS ITSELF. A lobby holding four fighters satisfies `enough_to_fight`,
//     so `close_lobby_and_draw` is legal for ANYONE the moment the deadline passes. The keeper
//     declining to call it is not a guarantee; a permissionless caller racing us at the deadline
//     would run exactly the house-versus-house fight this whole change exists to stop.
//   * AND IT CANNOT BE UNDONE. `abandon_round` requires `lobby_is_dead`, which requires FEWER THAN
//     TWO fighters. So a four-fighter held-open lobby that nobody joins cannot be abandoned either:
//     at its deadline the only outcomes are the house-only fight above, or the round sitting in
//     `Lobby` forever with its rent stranded — the permanently-stuck state this repo has already paid
//     for twice and treats "a round can always reach a terminal state" as a promise against.
//
// ONE fighter resolves both, and it resolves them structurally rather than by policy:
//
//   * `fighter_count == 1` is BELOW `enough_to_fight`, so the round cannot be drawn by us, by a
//     racing caller, or by anyone. "No house-only fights" stops being a rule the keeper enforces and
//     becomes a property the CHAIN enforces, which is a much stronger thing to be able to say.
//   * `lobby_is_dead` is therefore TRUE at the backstop, so `abandon_round` works and the ordinary
//     abandon-and-reopen path is reachable. The round always terminates.
//   * The room is still not empty. There is a fighter and a live pot, which is what an arriving
//     player needs to see. The house then fills in AROUND them the moment they enter — which reads
//     better than a static crowd that was already there.
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// REAL VERSUS HOUSE IS A PRIVATE LIST, AND THAT IS OPERATOR POLICY RATHER THAN AN OVERSIGHT
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// `realFighterCount` comes from `houseBank.ts`'s classifier, which is the keeper's own set of house
// pubkeys: anyone not in it is real. There is NO on-chain registry and no flag on the `Round`, and
// the UI does not mark house fighters as house at the fighter level. That is a decision the operator
// has taken, not a gap left to be tidied up later — so if you are here to "fix" it by registering the
// house wallets on the Arena account, that is a product change to raise with them first, not a
// refactor. (`keeperStatus.ts`'s `isHouseWallet` publishes the LIST, which is a different and much
// weaker claim; see its doc comment.)
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE THING THIS FUNCTION IS TOLD RATHER THAN SHOWN
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// `firstRealEntryObservedAtSec`. The program stamps no per-fighter entry time — a `Fighter` row is a
// wallet, a side, a stake and some hp — so "when did the first real player arrive" is not derivable
// from the round account at all, at any cost. It is latched by the caller, per round, exactly the way
// `settledObservedAtSec` is, and for the same reason. See `RoundTimeline` in keeper.ts for what a
// restart does to it (it re-stamps to now, which only ever EXTENDS the window: the safe direction).
//
// Everything else here is read off the account this second.

import { Phase, lobbyIsOpen } from "../../src/chain/constants.ts";
import {
  CLOCK_SKEW_MARGIN_SECONDS, MIN_FIGHTERS_TO_FIGHT, REAL_PLAYER_GRACE_SECONDS,
} from "./config.ts";

/** The single next thing to do with a lobby. Every one of these is an action the keeper can take from
 *  chain state alone; none of them is a mode it has to remember it is in. */
export type LobbyStep =
  /** Do nothing but keep the house at its target. The steady state, and the cheap one: a held-open
   *  lobby spends this way for as long as it takes, at no marginal cost. Also the answer inside the
   *  clock-skew margin after the deadline, where `plannedHouseEntries` refuses to plan anything
   *  anyway, so "field the house" is a no-op there rather than a mistake. */
  | { kind: "wait" }
  /** A real player is in and the grace window has run out: sign the early close. */
  | { kind: "closeEarly" }
  /** The permissionless close — the deadline has passed (or the lobby is full) with enough fighters
   *  to hold a fight. Unchanged from before any of this. */
  | { kind: "close" }
  /** Past the deadline holding fewer than two fighters: `abandon_round` is the only instruction left
   *  that will succeed on it. Unchanged. */
  | { kind: "abandon" }
  /** A real player is in, the grace has expired, and the lobby STILL cannot hold a fight —
   *  `enough_to_fight` binds on the authority path exactly as it does on the permissionless one, so
   *  closing now would be a transaction that can only fail. In practice this means every house entry
   *  failed (a drained wallet is the realistic cause, and it already raises `lastError`). Keep
   *  fielding the house; the close becomes due the moment the second fighter lands. */
  | { kind: "waitForFighters" };

export interface LobbyView {
  /** The CHAIN's clock, in unix seconds. */
  nowSec: number;
  lobbyClosesAt: number;
  fighterCount: number;
  realFighterCount: number;
  /** Latched by the caller, per round — see this file's header. Null until this process has seen a
   *  real fighter standing in this round. */
  firstRealEntryObservedAtSec: number | null;
  /** Is the hold-open policy switched on? `--hold-open` / `KEEPER_HOLD_OPEN`, default OFF — see
   *  `HOLD_OPEN_ENABLED_DEFAULT` for why this is the operator's assertion and not something the
   *  keeper works out for itself.
   *
   *  IT GATES THE WHOLE POLICY, not just the closing transaction. Without the authority early close
   *  actually deployed, a lobby can only be ended by its deadline — so holding one open would mean a
   *  keeper watching a real player stand in a room for an hour with no way to start their fight. When
   *  this is false every branch below collapses to exactly the behaviour that shipped before any of
   *  this existed, and the keeper opens `DEFAULT_LOBBY_SECONDS` lobbies to match. */
  holdOpen: boolean;
}

export interface LobbyPlan {
  step: LobbyStep;
  /** Published as `round.heldOpen`. See `keeperStatus.ts` for why a UI needs it. */
  heldOpen: boolean;
  /** Published as `entriesCloseAt` — the instant the keeper INTENDS to stop taking entries, or null
   *  when it has no such intention (nobody has arrived, or there is no early close to make). */
  entriesCloseAt: number | null;
  /** THE INSTANT THIS LOBBY WILL ACTUALLY BE DRAWN, which is what the house has to size itself
   *  against. It used to be the chain's deadline because the deadline was the only way a lobby ever
   *  ended; now it is the keeper's own close whenever the keeper has committed to one. Feeding
   *  `plannedHouseEntries` the deadline instead would put the fill stage an hour after the fight had
   *  already started — i.e. never — and the house would field its seed and nothing else, silently
   *  retiring the displacement policy on every round a real player actually played. */
  drawAt: number;
}

/** IS THIS LOBBY'S DEADLINE A BACKSTOP RATHER THAN A SCHEDULE?
 *
 *  Exported because the status publisher asks it of a round in any phase, while `planLobby` only ever
 *  asks it of one in `Lobby` — one implementation, so the flag in the status file and the branch in
 *  the keeper cannot drift apart.
 *
 *  It is NOT derived from the length of the stored window, which was the first thing tried. Comparing
 *  `lobbyClosesAt - lobbyOpenedAt` against `HOLD_OPEN_LOBBY_SECONDS` misclassifies every round opened
 *  under a different setting than the one currently configured — and gets it wrong in the dangerous
 *  direction (a 30-minute round read by a keeper configured for an hour would be treated as an
 *  ordinary lobby and waited out in full). What actually decides whether a deadline is a backstop is
 *  whether this keeper is going to close the lobby before reaching it, which is the policy switch and
 *  the absence of anybody real to close it for. */
export function lobbyIsHeldOpen(view: {
  phaseCode: number;
  lobbyClosesAt: number;
  nowSec: number;
  realFighterCount: number;
  holdOpen: boolean;
}): boolean {
  return view.holdOpen
    && view.phaseCode === Phase.Lobby
    && view.realFighterCount === 0
    && lobbyIsOpen(view.lobbyClosesAt, view.nowSec);
}

/**
 * THE SINGLE NEXT THING TO DO WITH A LOBBY, from chain state plus one latched observation.
 *
 * Read as a ladder, deadline first:
 *
 *   PAST THE DEADLINE — unchanged from before any of this, because past the deadline the program's
 *   own rules are the only ones left. Inside the skew margin, wait (the ER's clock and ours are not
 *   the same clock, and both `close_lobby_and_draw` and `abandon_round` refuse if the ER disagrees).
 *   Then abandon if it cannot fight, or close it the permissionless way if it can.
 *
 *   STILL OPEN, NOBODY REAL IN IT — hold. This is the cheap steady state and it can last the whole
 *   backstop. Nothing is sent and nothing is spent; one house fighter sits in the room so it is not
 *   an empty page, and the chain itself refuses to draw a one-fighter round.
 *
 *   STILL OPEN, A REAL PLAYER IS IN — the fight is now on a schedule the keeper owns:
 *   `firstRealEntryObservedAt + REAL_PLAYER_GRACE_SECONDS`, capped at the chain's deadline because
 *   the chain stops accepting entries there regardless of what the keeper intended. Wait it out, then
 *   close early — unless the lobby somehow still cannot hold a fight, in which case sending anything
 *   would be sending a transaction that can only fail.
 *
 * WHAT IS DELIBERATELY NOT HERE: any notion of "am I in hold-open mode". There is no mode. Every
 * branch is a function of this snapshot, so a keeper that boots into the middle of a held lobby makes
 * the same decision as the one that opened it, which is the property the whole process is built on.
 */
export function planLobby(view: LobbyView): LobbyPlan {
  const heldOpen = lobbyIsHeldOpen({ ...view, phaseCode: Phase.Lobby });

  // Non-null only once somebody real is in and there is an early close to make. Capped at the
  // deadline: past it `enter` refuses, so entries genuinely close there whatever the grace said.
  const entriesCloseAt = view.holdOpen && view.firstRealEntryObservedAtSec !== null
    ? Math.min(view.firstRealEntryObservedAtSec + REAL_PLAYER_GRACE_SECONDS, view.lobbyClosesAt)
    : null;
  const drawAt = entriesCloseAt ?? view.lobbyClosesAt;
  const plan = (step: LobbyStep): LobbyPlan => ({ step, heldOpen, entriesCloseAt, drawAt });

  if (!lobbyIsOpen(view.lobbyClosesAt, view.nowSec)) {
    if (view.nowSec < view.lobbyClosesAt + CLOCK_SKEW_MARGIN_SECONDS) return plan({ kind: "wait" });
    // The chain's own predicate, in the same two pieces the program uses: `lobby_is_dead` is exactly
    // "past the deadline and not `enough_to_fight`", so these two branches are exhaustive rather than
    // merely adjacent.
    return plan(view.fighterCount < MIN_FIGHTERS_TO_FIGHT ? { kind: "abandon" } : { kind: "close" });
  }

  if (entriesCloseAt === null) return plan({ kind: "wait" });
  if (view.nowSec < entriesCloseAt) return plan({ kind: "wait" });
  if (view.fighterCount < MIN_FIGHTERS_TO_FIGHT) return plan({ kind: "waitForFighters" });
  return plan({ kind: "closeEarly" });
}
