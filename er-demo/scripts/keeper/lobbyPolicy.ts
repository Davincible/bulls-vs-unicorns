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
// forever, at nobody. When this file was written that cost 0.00981 SOL of permanently-locked rent per
// cycle (see `HOLD_OPEN_LOBBY_SECONDS`), which was ~0.32 SOL/hour to run an arena with no players in
// it, and every one of those fights was the house against itself.
//
// BOTH HALVES OF THAT ARGUMENT HAVE SINCE GONE AWAY, and writing that down is worth more than
// restating a number: a policy still defended on two claims that stopped being true is a policy
// nobody can re-examine.
//
// THE MONEY WENT FIRST. `close_round_account` shipped in v7, so a round's deposit is FLOAT — parked
// for `ROUND_RETENTION` rounds and handed back — and at `MAX_FIGHTERS = 48` it is 0.023497 SOL parked
// against ~0.00007 SOL of fees actually spent. Whatever the cadence, the spend is fees; the ~0.32
// SOL/hour of permanent loss this file was written against is three orders of magnitude away and is
// not coming back (COST-MODEL §0, §1).
//
// THE HOUSE FIGHTING ITSELF WENT SECOND, AND THIS PARAGRAPH CLAIMED OTHERWISE FOR A WHILE.
// `HOUSE_MAX_WITHOUT_REAL_PLAYER` — the rule this file spends its next two hundred lines on — now
// governs EVERY empty room rather than only a held-open one. So a fixed-cadence lobby that nobody
// joins holds ONE fighter, which is below `enough_to_fight`, and at its deadline it is ABANDONED
// rather than drawn. There are no house-versus-house rounds in any default configuration under
// EITHER policy. That is exactly what `--house-only-rounds` exists to give up, and claiming the
// cadence had already given it up would have argued for hold-open on a cost the cadence does not
// have.
//
// WHAT ACTUALLY SURVIVES IS TWO THINGS, AND NEITHER OF THEM IS SOL/HOUR.
//
//   EXPOSURE. Every round opened is one more deposit riding on a close landing, and COST-MODEL §4 is
//   about nothing but the ways that close fails: a skipped round, a round wedged before a terminal
//   phase, a round left delegated. An IDLE fixed cadence accumulates that faster than the headline
//   suggests, because §2's 204-second cycle is mostly a 124-second fight and an idle round has no
//   fight in it — fewer signatures each, many more rounds a day. Hold-open's answer is one deposit
//   instead of a day's worth.
//
//   THE ROOM, WHICH IS THE PRODUCT ARGUMENT AND OUTLASTS BOTH OF THE OTHERS. Under fixed cadence a
//   visitor arrives at an arbitrary point in somebody else's cycle: a lobby with four seconds left on
//   it, a fight already running, a result hold. Under hold-open the lobby is open whenever they get
//   there, the house fills in AROUND them, and the fight starts because they showed up. That was
//   always the best reason to want this policy; it is now the main one.
//
// The arithmetic below is unchanged by any of it.
//
// Now:
//
//     open ONE round, with a long backstop deadline
//     ONE house fighter goes in, so the room is not empty (see `HOUSE_MAX_WITHOUT_REAL_PLAYER`, which
//         is what that rule is called now that it governs every empty room rather than a held-open one)
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
// HOUSE-ONLY ROUNDS DO NOT DISABLE HOLD-OPEN. THEY COLLAPSE THE BACKSTOP INTO A SCHEDULE.
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// `KEEPER_HOUSE_ONLY_ROUNDS` (config.ts) asks for an arena that keeps running with nobody real in it.
// The obvious reading is that it makes hold-open meaningless and the two should be mutually exclusive.
// That reading is wrong, and getting it right is the difference between a page that draws an honest
// countdown and one that says `waiting-for-players` in front of a lobby that is going to fight in
// forty seconds.
//
// HOLD-OPEN IS TWO HALVES, AND THEY HAVE DIFFERENT FATES HERE.
//
//   HALF ONE — "an empty lobby waits indefinitely for a person." This is the half that goes. It was
//   bought at a specific price and the price has changed: holding was free while CYCLING permanently
//   locked ~0.0098 SOL of rent per round, which is the arithmetic in `HOLD_OPEN_LOBBY_SECONDS`.
//   `close_round_account` has since converted that rent from a cost into FLOAT — COST-MODEL §5 puts
//   the present figure at 250x cheaper than the fixed cadence it replaced — so the justification for
//   the indefinite half is largely spent even before this mode. And in this mode there is nothing left
//   of it at all: an empty lobby is not waiting for anybody, it is going to be drawn at its deadline
//   like every other lobby. `lobbyIsHeldOpen` is therefore FALSE, which is what turns the deadline back
//   into a countdown a page can draw.
//
//   HALF TWO — the authority-signed early close. A real player arrives, the grace window runs, the
//   keeper starts their fight. This half is FULLY RETAINED, and the mechanism is worth naming because
//   it is not obvious from the code: `entriesCloseAt` is gated on `view.holdOpen` and the first real
//   entry, NOT on `heldOpen`. So making `heldOpen` false costs a real arrival nothing — they still get
//   an early close, still after the same grace, still ahead of the deadline.
//
// WHAT AN OPERATOR ACTUALLY GETS FROM `--hold-open --house-only-rounds` TOGETHER, which is worth
// stating plainly because it is the DEPLOYED configuration and not a corner (`fly.toml` sets
// `KEEPER_HOLD_OPEN=1`): continuous rounds, each drawn on its own deadline at the ordinary lobby
// length, and a real arrival still getting an early close after the same grace. Half one gone, half
// two intact — the two flags compose, and nothing here has to refuse anything.
//
// THE PIECE THAT MAKES THAT TRUE IS NOT IN THIS FILE, and it is the direct consequence of half one
// going. Once nothing is being held for anybody, the deadline stops being a backstop and becomes the
// SCHEDULE — and a backstop is sized to be unreachable, which is the opposite of what a schedule
// needs. So the length has to come down with it, and `keeper.ts`'s `openNextRound` is where it does:
// house-only stamps `DEFAULT_LOBBY_SECONDS` rather than `HOLD_OPEN_LOBBY_SECONDS`. What that line is
// worth is a number, so it lives beside the constants — see `HOUSE_ONLY_ROUNDS_ENABLED` in config.ts
// for what the deployed backstop would have turned this mode into without it.
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE ROUND THAT WAS ALREADY STANDING WHEN THE MODE WAS SWITCHED ON
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// Everything above is about the rounds this keeper OPENS under the mode. It says nothing about the one
// that was already open when the flag was set, and that silence stopped a live arena for a week. The
// state it was found in, recorded rather than paraphrased, because a paragraph here is cheaper than a
// second occurrence:
//
//     round #4   phase Lobby   lobbyOpenedAt 1786716371   lobbyClosesAt 1787321171
//     heldOpen false   drawAt null   2 fighters, none of them real   KEEPER_HOUSE_ONLY_ROUNDS=1
//
// 604,800 seconds between those two stamps. That is `KEEPER_HOLD_OPEN_LOBBY_SECONDS` exactly as
// `fly.toml` sets it, written by `open_round` under the policy in force when round #4 opened — and
// `lobby_closes_at` is written ONCE. No instruction in the program moves it afterwards. So switching
// the mode on changed everything about what the keeper INTENDS and nothing whatsoever about the
// deadline it now intends against, and `openNextRound`'s `DEFAULT_LOBBY_SECONDS` line — the piece the
// section above calls the one that makes the two flags compose — only ever applies to the NEXT round.
// There was no next round. That is the whole bug: the mode has a steady state and had no way in.
//
// IT FAILS TWICE OVER, AND THE SECOND FAILURE GETS REPORTED AS A DIFFERENT BUG ENTIRELY.
//
//   THE LOBBY IS NO LONGER HELD, AND IS NOT GOING TO BE DRAWN EITHER. `lobbyIsHeldOpen` answers false
//   under this mode by the argument in the section above — the deadline is a schedule and not a
//   backstop, so there is nobody it is being held for — and the deadline it is calling a schedule is
//   seven days out. Nothing is waiting for a player and nothing is going to draw the round, which is
//   the one state this file was extracted to make impossible to reach quietly.
//
//   AND THE ROOM STOPS FILLING AT TWO. This is the half that gets reported as "one house wallet
//   entered and then nothing", and the arithmetic is worth doing rather than calling it a trickle,
//   because it is not a trickle — it is a freeze. `plannedHouseEntries` is handed `drawAt`, which with
//   nobody real in the room is the deadline itself. `arrivalFraction` clamps to ZERO everywhere before
//   `drawAt - REAL_PLAYER_GRACE_SECONDS` — 604,755 of the 604,800 seconds — `arrivalsDueBy` at fraction
//   zero is exactly one by construction (`a_1 = 0`), and `target = max(fightability, min(board, due))`
//   then floors that at `HOUSE_FLOOR = 2` because nobody real is in. So the board holds at TWO for a
//   week and would jump to thirty-nine (the deployed board of 48 less `REAL_SEATS_RESERVED`) in the
//   last forty-five seconds. The wallet that "entered at boot" is the fightability floor's second
//   fighter joining the treasury rule's first, and there was never going to be a third.
//
// THE FIX IS THE AUTHORITY EARLY CLOSE, WHICH IS ALREADY BUILT AND WHICH THIS KEEPER ALREADY SIGNS FOR
// A REAL ARRIVAL. `close_lobby_and_draw` with the `authority` account bypasses the deadline; the
// deadline is the only thing wrong with this round; the keeper is the arena's authority. So under
// house-only ONLY, a lobby whose deadline is further out than the mode itself would ever have stamped
// is drawn now instead of next week — `deadlineIsOffSchedule` owns the comparison and `closeToSchedule`
// is the step it produces.
//
// WHAT IT IS NOT, AND THE DISTINCTION IS THE GATE: a general repair for a long deadline. With the mode
// OFF, a seven-day backstop over an empty lobby is not a fault at all — it is `--hold-open` doing
// exactly what it was configured to do, and drawing it early would be the keeper overruling the
// operator on the one policy the operator sets by hand. With the mode off, not one byte of this file's
// behaviour moves.
//
// AND IT IS ONE ROUND'S WORTH OF WORK, WHICH IS WHY IT IS A TRANSITION AND NOT A POLICY. Once this
// round is drawn the ordinary machine has it — Drawing, Fight, Settled, then `driveSettled`'s
// `openNextRound`, which stamps `DEFAULT_LOBBY_SECONDS` under this mode. Round two of the mode's life
// is already on schedule and so is every round after it, so this branch fires once per switch-on and
// then cannot fire again for as long as the flag stays set.
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO THINGS THIS FUNCTION IS TOLD RATHER THAN SHOWN
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// `firstRealEntryObservedAtSec`. The program stamps no per-fighter entry time — a `Fighter` row is a
// wallet, a side, a stake and some hp — so "when did the first real player arrive" is not derivable
// from the round account at all, at any cost. It is latched by the caller, per round, exactly the way
// `settledObservedAtSec` is, and for the same reason. See `RoundTimeline` in keeper.ts for what a
// restart does to it (it re-stamps to now, which only ever EXTENDS the window: the safe direction).
//
// `scheduleCloseRetryAfterSec`, which arrived with the transition above and is the reason this heading
// says two. It is the keeper's own backoff after sending an off-schedule close, and it is HERE rather
// than read at the top of the sending function the way `houseRetryAfterSec` and `sweepRetryAfterSec`
// are. Those two guard work this plan has no step for — fielding the house, sweeping a take — so the
// IO layer is the only place they could live. This one guards a STEP, and a plan that says "close it
// now" once a second while the keeper means "not for another thirty" is a plan that does not describe
// what the keeper is doing. Keeping it here also keeps the once-per-round property TESTABLE, which for
// a decision this file exists to hold is the difference between a claim and a check.
//
// Everything else here is read off the account this second.

import { Phase, lobbyIsOpen } from "../../src/chain/constants.ts";
import {
  CLOCK_SKEW_MARGIN_SECONDS, DEFAULT_LOBBY_SECONDS, MIN_FIGHTERS_TO_FIGHT, REAL_PLAYER_GRACE_SECONDS,
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
  /** UNDER HOUSE-ONLY ONLY: this lobby's deadline was stamped under a policy that is no longer in
   *  force, so sign the same authority early close to bring the round onto the mode's schedule. See
   *  this file's header for the arena this exists because of, and `deadlineIsOffSchedule` for the
   *  comparison.
   *
   *  A SEPARATE STEP RATHER THAN A WIDENED `closeEarly`, and the two reasons are both about not
   *  weakening the one that already works. The transaction is byte-identical — `close_lobby_and_draw`
   *  with the operator as `authority` — but `closeEarly`'s log line says "a real player is in", which
   *  here would be a lie about the only fact that matters; and the keeper THROTTLES this one and
   *  deliberately does not throttle that one, because a real arrival's close is bounded by their
   *  deadline and this one's condition persists for as long as the stale deadline does. Folding them
   *  together would have meant either lying in the log or putting a backoff in front of a fight
   *  somebody is standing in the room waiting for. */
  | { kind: "closeToSchedule" }
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
  /** Is the keeper running rounds with nobody real in them? `--house-only-rounds` /
   *  `KEEPER_HOUSE_ONLY_ROUNDS`, default OFF — see `HOUSE_ONLY_ROUNDS_ENABLED`.
   *
   *  IT ANSWERS `heldOpen`, AND IT GATES EXACTLY ONE STEP: `closeToSchedule`. It appears in neither
   *  `entriesCloseAt` nor `drawAt`, and in no OTHER step branch — an empty house-only lobby runs to its
   *  deadline and is closed by the same permissionless branch that has always closed a lobby at its
   *  deadline, and a real player who arrives into one gets the identical early close. See this file's
   *  header for why "hold-open collapses into a schedule" is the accurate description and "house-only
   *  turns hold-open off" is not.
   *
   *  THIS COMMENT USED TO SAY "ONLY TO ANSWER `heldOpen`, AND THAT IS THE WHOLE OF ITS EFFECT", which
   *  was true and was also the shape of the bug: collapsing the backstop into a schedule is a claim
   *  about a deadline, and the flag had no way to reach a deadline that was already stamped. The one
   *  step is what closes that. */
  houseOnly: boolean;
  /** Chain second before which the keeper will not re-send an off-schedule close, latched by the caller
   *  when it sends one — the second of the two things this function is told rather than shown, and the
   *  header argues why it is told rather than kept in the sending function.
   *
   *  Zero means "no close has been sent for this round", which is what `freshTimeline` gives every new
   *  round and what a restart gives the round it boots into. Both resolve the same way: the close is
   *  attempted immediately. That is the safe direction — a restart can only make the repair happen
   *  SOONER, never later, and the transaction it might duplicate is one the program answers with a
   *  phase error rather than a second draw. */
  scheduleCloseRetryAfterSec: number;
}

export interface LobbyPlan {
  step: LobbyStep;
  /** Published as `round.heldOpen`. See `keeperStatus.ts` for why a UI needs it. */
  heldOpen: boolean;
  /** Published as `entriesCloseAt` — the instant the keeper INTENDS to stop taking entries, or null
   *  when it has no such intention (nobody has arrived, or there is no early close to make). */
  entriesCloseAt: number | null;
  /** THE INSTANT THIS LOBBY WILL ACTUALLY BE DRAWN, which is what the house has to size itself
   *  against AND what its arrival schedule is anchored to. It used to be the chain's deadline because
   *  the deadline was the only way a lobby ever ended; now it is the keeper's own close whenever the
   *  keeper has committed to one. Feeding `plannedHouseEntries` the deadline instead would put the
   *  whole arrival window an hour after the fight had already started — i.e. never — and the house
   *  would field its fightability floor and nothing else, silently retiring the board policy on every
   *  round a real player actually played. */
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
 *  the absence of anybody real to close it for.
 *
 *  `houseOnly` IS THE THIRD THING THAT DECIDES IT, and it reads as the negation it is: under that mode
 *  the keeper IS going to close this lobby at its deadline, so the deadline is a schedule and not a
 *  backstop, and there is nobody it is being held for. Reporting `heldOpen` there would put
 *  `waiting-for-players` on a page in front of a lobby that fights in forty seconds — a confidently
 *  drawn wrong answer, which is the class of bug this predicate was extracted to prevent. */
export function lobbyIsHeldOpen(view: {
  phaseCode: number;
  lobbyClosesAt: number;
  nowSec: number;
  realFighterCount: number;
  holdOpen: boolean;
  houseOnly: boolean;
}): boolean {
  return view.holdOpen
    && !view.houseOnly
    && view.phaseCode === Phase.Lobby
    && view.realFighterCount === 0
    && lobbyIsOpen(view.lobbyClosesAt, view.nowSec);
}

/** IS THIS LOBBY'S DEADLINE FURTHER OUT THAN THE MODE NOW RUNNING WOULD EVER HAVE STAMPED?
 *
 *  The question the transition in this file's header turns on, and it is asked of the deadline alone —
 *  whether anything should be DONE about the answer is `scheduleCloseIsDue`'s job.
 *
 *  MEASURED AS TIME REMAINING, NOT AS `lobbyClosesAt - lobbyOpenedAt`. That second arithmetic is the
 *  one `lobbyIsHeldOpen` rejects two doc comments above, for a reason that applies here word for word:
 *  the stored WINDOW is a claim about the setting a round was opened under, and comparing it against
 *  the setting configured today misclassifies every round opened under a third one. Remaining time is
 *  also the quantity the outage was actually measured in — how much longer the arena stands still —
 *  and it is the only one of the two this view carries, because `lobbyOpenedAt` was deliberately never
 *  put on it.
 *
 *  THE SKEW MARGIN IS LOAD-BEARING AND IS NOT THE PROGRAM'S MARGIN. Everywhere else in this file
 *  `CLOCK_SKEW_MARGIN_SECONDS` is about the ER refusing a transaction whose deadline it disagrees with;
 *  here it is about not misreading OUR OWN lobby. `nowSec` is the ER's clock and `lobby_closes_at` was
 *  stamped by `open_round` from the base layer's, so a lobby this keeper opened a second ago reads as
 *  `DEFAULT_LOBBY_SECONDS` remaining plus whatever those two clocks disagree by. Without the margin,
 *  two seconds of skew would make every freshly opened house-only lobby answer TRUE and be drawn on its
 *  first pass — a fight every couple of seconds, each parking a round's rent — which is a far more
 *  expensive failure than the week-long stall being fixed. With it, the round the mode opens is
 *  structurally outside this predicate rather than probably outside it.
 *
 *  `holdOpen` IS IN THE CONDITION AND IT IS NOT DECORATION. It is this keeper's only assertion that an
 *  authority-signed close can actually land: `HOLD_OPEN_ENABLED_DEFAULT` explains why that is an
 *  operator switch rather than a probe, keeper.ts refuses to BOOT with `--hold-open` against an IDL
 *  whose `close_lobby_and_draw` has no `authority` account, and `entriesCloseAt` — the early close that
 *  already works — is gated on the same flag. Without it this would be the first path in this file able
 *  to ask for an authority close that boot never vetted, and Anchor drops an account the IDL has never
 *  heard of SILENTLY: the keeper would send what it believed was an early close and be answered with
 *  `LobbyStillOpen`, an error about the clock, once every backoff for a week. The deployment this was
 *  written for sets both flags (`fly.toml`), so the pairing costs the repair nothing. */
function deadlineIsOffSchedule(view: LobbyView): boolean {
  return view.holdOpen
    && view.houseOnly
    && view.lobbyClosesAt - view.nowSec > DEFAULT_LOBBY_SECONDS + CLOCK_SKEW_MARGIN_SECONDS;
}

/** SHOULD THE KEEPER SEND THE OFF-SCHEDULE CLOSE ON THIS PASS? The deadline question above, plus the
 *  two things that decide whether acting on it is possible and whether it is due.
 *
 *  `enough_to_fight` IS THE CHAIN'S RULE AND IT BINDS ON THE AUTHORITY PATH EXACTLY AS IT DOES ON THE
 *  PERMISSIONLESS ONE — the same fact `waitForFighters` exists for. Below two fighters this close is a
 *  transaction that can only be rejected, so it is not attempted.
 *
 *  WHAT THAT MEANS FOR A STUCK LOBBY HOLDING FEWER THAN TWO, SAID OUT LOUD BECAUSE THE ANSWER IS "IT
 *  STAYS STUCK" AND THAT DESERVES TO BE A DECISION RATHER THAN AN OMISSION. Such a round has no early
 *  exit at all: `abandon_round` requires `lobby_is_dead`, which requires being PAST the deadline, and
 *  the deadline is the thing that is a week away. There is no instruction any signer can send that ends
 *  it sooner — so refusing here costs nothing that was available. What the keeper does instead is the
 *  `wait` branch it already had: keep fielding the house. Under this mode `plannedHouseEntries` floors
 *  its target at `HOUSE_FLOOR = 2` from the first pass whatever the arrival ramp says (that is the
 *  `fightability` term), so the room is being topped up to exactly the count this close needs, on
 *  `HOUSE_ENTRY_RETRY_SECONDS`, for as long as it takes. The realistic reason to be at one fighter is a
 *  drained house wallet, which already raises `lastError` from `fieldHouseFighters`; refill it and the
 *  second fighter lands and this becomes due on the next pass. And if nothing ever refills it, the
 *  round still terminates: at the deadline `lobby_is_dead` is true and `abandon_round` ends it, exactly
 *  as it does today. The floor is a delay, never a wedge.
 *
 *  THE BACKOFF IS THE THIRD CLAUSE AND IT IS WHY THIS FIRES ONCE PER ROUND RATHER THAN ONCE PER PASS.
 *  The keeper loops at 1Hz and every decision here is re-derived from the chain rather than remembered,
 *  so the condition above survives its own failed transaction — with no throttle, a close that cannot
 *  land would be re-sent 604,800 times. See `SCHEDULE_CLOSE_RETRY_SECONDS` for the interval and for why
 *  there is no attempt CAP to go with it. */
function scheduleCloseIsDue(view: LobbyView): boolean {
  return deadlineIsOffSchedule(view)
    && view.fighterCount >= MIN_FIGHTERS_TO_FIGHT
    && view.nowSec >= view.scheduleCloseRetryAfterSec;
}

/**
 * THE SINGLE NEXT THING TO DO WITH A LOBBY, from chain state plus two latched observations.
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
 *   an empty page, and the chain itself refuses to draw a one-fighter round. Under `houseOnly` this
 *   row still says "wait" — but it is the ordinary wait of a lobby counting down to its deadline
 *   rather than an indefinite hold, and `heldOpen` says so. The ONE exception is a deadline that
 *   predates the mode: `scheduleCloseIsDue` sends the authority close rather than waiting out a
 *   backstop nothing is going to be held for. It cannot fire on a lobby this mode opened.
 *
 * WHAT IS DELIBERATELY THE SAME ON THAT NEW ROW: `heldOpen`, `entriesCloseAt` and `drawAt`, all
 * untouched. A synthesised `entriesCloseAt` of "now" would read as the honest answer and is a trap in
 * two directions. It would put the round on the REAL-ARRIVAL ladder from the very next pass, because
 * `entriesCloseAt !== null` is exactly what that ladder is keyed on — so the second pass would answer
 * `closeEarly`, lose the backoff, and log a player who is not there. And it would drag `drawAt` onto
 * `nowSec`, where `plannedHouseEntries` refuses every entry within `CLOCK_SKEW_MARGIN_SECONDS` of the
 * draw and counts them `dropped`: a short-board warning and a published `lastError`, on a round the
 * keeper is deliberately closing.
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

  // NOBODY REAL IS IN. That used to be the end of the answer, and it still is unless this lobby's
  // deadline came from a policy that is no longer running — see this file's header for the arena that
  // spent a week in the `wait` this branch used to return unconditionally.
  if (entriesCloseAt === null) {
    return plan(scheduleCloseIsDue(view) ? { kind: "closeToSchedule" } : { kind: "wait" });
  }
  if (view.nowSec < entriesCloseAt) return plan({ kind: "wait" });
  if (view.fighterCount < MIN_FIGHTERS_TO_FIGHT) return plan({ kind: "waitForFighters" });
  return plan({ kind: "closeEarly" });
}
