// KEEPER POLICY: how many house fighters to field, WHEN each of them arrives, which sides they take,
// and what they stake.
//
// PURE FUNCTIONS ONLY — no chain, no I/O, no `Math.random()`, and no clock READ anywhere in the file.
// Instants arrive as arguments the same way `roundNo` does, so "what does the house look like eleven
// seconds into the window" is a question that can be asked in a test rather than waited for.
// Everything in this file is a judgement call about what the arena looks like to somebody reading it,
// and a judgement call you cannot run on its own is one nobody will ever argue with.
// `houseSizing.test.ts` walks the entire policy in milliseconds, which leaves the keeper itself with
// nothing to decide: it asks these functions and sends the transactions they describe.
//
// THE FACT THAT REFRAMES THE WHOLE PROBLEM: `enter` RECORDS A STAKE. IT NEVER MOVES LAMPORTS.
//
// This program custodies nothing at all — see the file header of `programs/bulls-arena/src/lib.rs`
// ("It does NOT move balances or custody"), and `abandon_round`'s "NOTHING IS REFUNDED, BECAUSE
// NOTHING WAS TAKEN". A stake is a number written into a `Fighter` row. So the SIZE of a house stake
// costs the treasury exactly nothing, and cannot: the only real spend is transaction fees and account
// rent, and both are per FIGHTER, not per dollar.
//
// So the shape of the market on screen is what these numbers optimise. How many fighters make a lobby
// look like an arena rather than a duel. Whether both sides are covered so there is a fight at all.
// Whether the stakes on the roster read like players or like N copies of one bot.
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// AND THE ONE PLACE THAT ARGUMENT STOPS WORKING, WHICH IS WHY THE COUNT AND THE STAKE ARE NOW
// SEPARATE KNOBS
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// The version of this file that shipped first drew the obvious conclusion from the paragraph above —
// "there is no bankroll to risk, no exposure to hedge" — and then flagged its own expiry: "the day
// balances move on-chain, every rule under it needs re-arguing from the top." This is that re-arguing,
// taken EARLY rather than on the day, because the change that arrived first was a demand to triple the
// board, and tripling the board is precisely the change that decides what custody will cost.
//
// The numbers are already real in one direction. `Treasury.fees_accrued` is, in `sweep_house_take`'s
// own words, "a ledger the off-chain treasury is paid against", and §4.2 moves `enter` to the base
// layer with an actual transfer. The fight is a zero-sum exchange over the recorded stakes, so
// conservation gives two bounds that hold whether or not lamports have started moving:
//
//     house profit on a round  <=  total REAL stake in it
//     house LOSS   on a round  <=  total HOUSE stake in it
//
// and the house's expected revenue is `fee_bps` on REAL entries only — the fee its own wallets pay is
// charged by the house to the house, which is circular and nets to nothing.
//
// That splits this file's job cleanly in two, and the split is the thing to hold on to:
//
//     SEAT COUNT  is what makes the arena look alive. It costs one signature per fighter, and since
//                 `advance_fight` began reading `min(ring_a, ring_d)` it buys no edge for anyone —
//                 return is size- and seat-neutral to within noise (HOUSE-EDGE-STUDY.md §0).
//     STAKE SIZE  is the entire downside tail, and it buys nothing the seat did not already buy.
//
// So the board is filled with SEATS and the band those seats stake from is held low, rather than the
// board being filled at the old stakes and the exposure tripling silently along with it. Both are
// `KEEPER_HOUSE_*` env knobs in `config.ts`, which is where every number below now comes from and
// where each one is argued in the operator's terms.

import { usdToUnits } from "../../src/v2/contract.ts";
import {
  HOUSE_ARRIVAL_TAIL_SECONDS, HOUSE_BOARD_TARGET, HOUSE_DISPLACEMENT, HOUSE_STAKE_MAX_USD,
  HOUSE_STAKE_MIN_USD, HOUSE_WALLET_COUNT, REAL_PLAYER_GRACE_SECONDS,
} from "./config.ts";

export interface SideCounts {
  side0: number;
  side1: number;
}

/** THE MINIMUM THAT MAKES A FIGHT POSSIBLE AT ALL, and the one part of this policy that is not
 *  throttleable. `close_lobby_and_draw` refuses a lobby holding fewer than two fighters
 *  (`enough_to_fight`), and a lobby that reaches its deadline under-subscribed has exactly one
 *  instruction left that will succeed on it: `abandon_round`. So this is not a comfort figure — it
 *  is the difference between a round and no round, and everything else here may be tuned to zero
 *  while this may not. */
export const HOUSE_FLOOR = 2;

/** THE TREASURY RULE, AS A NUMBER: the most house fighters that may ever stand in a room holding no
 *  real player. One, and the value is chosen for what it makes IMPOSSIBLE rather than for how it
 *  looks.
 *
 *  NOT CONFIGURABLE, ALONE AMONG EVERYTHING IN THIS FILE, and that asymmetry is the point. Every
 *  other number here is a judgement about how the arena should read, and the operator should be able
 *  to move it from a shell. This one encodes their standing instruction — "we don't do runs on only
 *  house players, to protect the treasury" — and a knob whose only safe value is 1 is not a knob, it
 *  is a way to lose the guarantee by typo.
 *
 *  THE MIRROR IMAGE OF `HOUSE_FLOOR`, ARGUED FROM THE SAME CHAIN RULE. Two is the count at which a
 *  round becomes capable of fighting (`enough_to_fight`). One is therefore the largest count at which
 *  it is INCAPABLE of it — and in a room with nobody real in it, being incapable of fighting is
 *  precisely the property wanted:
 *
 *    * `close_lobby_and_draw` is refused, for everyone. Not "the keeper declines to call it" — the
 *      program rejects it, so a permissionless caller racing the deadline cannot run a
 *      house-versus-house round either. The operator's requirement stops being a policy and becomes
 *      an invariant, which is a much stronger thing to be able to promise.
 *    * `abandon_round` is AVAILABLE at the deadline, because `lobby_is_dead` is exactly "past the
 *      deadline and not `enough_to_fight`". A lobby that nobody joined therefore ends cleanly and the
 *      keeper opens another — which is what rounds #24, #25 and #26 did. At any higher count it could
 *      not be abandoned at all, and the round would either fight itself or sit in `Lobby` forever with
 *      its rent stranded.
 *
 *  IT NOW GOVERNS EVERY EMPTY ROOM, NOT ONLY A HELD-OPEN ONE, and that is a real behaviour change
 *  rather than a rename. It used to be `HOLD_OPEN_HOUSE_FIGHTERS`, consulted only while
 *  `KEEPER_HOLD_OPEN` was on; with hold-open off the seed stage put `HOUSE_FLOOR` = 2 into an empty
 *  lobby and the round fought itself at the deadline. That hole was survivable at a board of four.
 *  At a board of ten it would be two and a half times the size, which is exactly the "more house
 *  fighters must not weaken the guarantee" trap. Now the guarantee is a property of the sizing
 *  function and holds under every configuration: a lobby with zero real fighters in it gets one house
 *  fighter and can only ever be abandoned.
 *
 *  AND THE ROOM IS STILL NOT EMPTY, which is the requirement pulling the other way. There is a
 *  fighter and a live pot on screen. The rest of the house arrives the moment a real player enters —
 *  the room populates AROUND them, which reads better than a static crowd that was already there.
 *
 *  Zero would satisfy the chain rules just as well and is rejected on the product: an empty room is
 *  the thing the house exists to prevent, and a visitor who arrives to nothing does not wait to find
 *  out that the arena is alive.
 *
 *  ────────────────────────────────────────────────────────────────────────────────────────────────
 *  AND IT IS STILL NOT A KNOB, NOW THAT THERE IS A MODE THAT DOES NOT WANT IT
 *  ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *  `KEEPER_HOUSE_ONLY_ROUNDS` asks for an arena that keeps running with nobody real in it, which is
 *  precisely this rule being asked to stand aside. The obvious implementation is to make this number
 *  configurable and set it to the board target. That is rejected, and the distinction is the whole
 *  design rather than a stylistic preference:
 *
 *    * A CONFIGURABLE NUMBER means the guarantee has a dial on it. Every value between 2 and the board
 *      is silently house-versus-house, so the safe setting becomes one point in a range an operator can
 *      typo their way off, and every reader downstream has to look up what it is set to before they can
 *      say what the arena does.
 *    * A SECOND NAMED POLICY (`EmptyRoomPolicy`, below) means there is nothing to typo. There are two
 *      whole policies, each named for the property it guarantees; the safe one is the default argument;
 *      and an operator who wants the other has to ask for it by name, once, at the boundary. The number
 *      here never moves, and "1" keeps meaning exactly what this comment says it means.
 *
 *  So this constant is unchanged, in force under `"unfightable"`, and simply not consulted under
 *  `"house-only"` — which is a much easier thing to prove than a clamp that happens to be set to 1. */
export const HOUSE_MAX_WITHOUT_REAL_PLAYER = 1;

/** WHAT A ROOM WITH NOBODY REAL IN IT IS ALLOWED TO HOLD. Two whole policies, NAMED FOR THE PROPERTY
 *  EACH ONE GUARANTEES rather than for the count each one produces — because the count is a
 *  consequence and the property is the decision.
 *
 *    "unfightable"  the standing treasury rule. `HOUSE_MAX_WITHOUT_REAL_PLAYER` fighters, which is
 *                   below `enough_to_fight`, so the CHAIN refuses to draw the round for anybody and
 *                   `abandon_round` stays legal at the deadline. This is the default in every sense
 *                   that matters: the default argument below, the default of the env flag, and the
 *                   behaviour of every call site that has not heard of the other one.
 *    "house-only"   the empty room is an ordinary room. It is filled, drawn, and fought by house
 *                   wallets. `KEEPER_HOUSE_ONLY_ROUNDS` is the operator asking for this by name, and
 *                   `HOUSE_ONLY_ROUNDS_ENABLED` in `config.ts` prices what it gives up — including the
 *                   part nobody guesses, which is that an empty round can no longer be abandoned.
 *
 *  THE POLICY IS A PARAMETER, NOT AN ENV READ IN THIS FILE, and that is deliberate. Everything here is
 *  pure — no chain, no clock, no `process.env` — which is what lets `houseInvariants.test.ts` sweep
 *  86,580 lobby shapes and what lets BOTH policies be proven in one process, in one run, with no module
 *  reset and no environment mutation. A module-level `if (HOUSE_ONLY_ROUNDS_ENABLED)` would make the
 *  guarantee provable only in a process that had been started the right way, which is the same as not
 *  provable. */
export type EmptyRoomPolicy = "unfightable" | "house-only";

/** THE SIZE THE HOUSE HOLDS THE BOARD AT, counting real players, and the ceiling on its own roster.
 *
 *  Both are `config.ts` knobs and both are argued there, in the operator's terms — this file re-exports
 *  nothing and restates nothing, so there is one place to look for "what is the board set to". Read
 *  `HOUSE_BOARD_TARGET` with `HOUSE_DISPLACEMENT` = 1: the house fields the difference between the
 *  target and the crowd, so the board holds its size and its composition turns human as people arrive.
 *
 *  `HOUSE_WALLET_COUNT` is both the ceiling and the number of wallets the keeper banks — the same
 *  number on purpose, since a policy that asked for an eleventh fighter would be asking for a wallet
 *  that does not exist. */

/**
 * HOW MANY HOUSE FIGHTERS THIS LOBBY GETS.
 *
 *     nobody real, policy "unfightable"  ->  HOUSE_MAX_WITHOUT_REAL_PLAYER, and nothing below is
 *                                            consulted
 *
 *     throttled = max(HOUSE_FLOOR - realTotal, HOUSE_BOARD_TARGET - HOUSE_DISPLACEMENT * realTotal)
 *     cover     = how many sides are currently empty (0, 1 or 2)
 *     count     = clamp(max(throttled, cover), 0, HOUSE_WALLET_COUNT)
 *
 * Read it as four promises, in order of how much they matter:
 *
 *   1. THE HOUSE NEVER FIGHTS ITSELF, under the `"unfightable"` policy. The early return is the
 *      treasury rule, and it is first because it overrides every other consideration in this file
 *      including the ones about how the room looks. One fighter is below `enough_to_fight`, so the
 *      CHAIN refuses to draw the round — see `HOUSE_MAX_WITHOUT_REAL_PLAYER` for why that is worth
 *      more than a keeper that declines to. `"house-only"` is the operator asking for this promise to
 *      be given up, by name; the block at the foot of this comment is what they get instead.
 *   2. a fight can happen — `HOUSE_FLOOR` never lets a lobby holding real players fall under
 *      `enough_to_fight`;
 *   3. the board stays the size it is meant to be — `HOUSE_BOARD_TARGET` less the crowd already in it;
 *   4. the house's share of that board falls as the crowd arrives, by `HOUSE_DISPLACEMENT` per
 *      entrant.
 *
 * The ladder that falls out of it at the defaults — target 10, displacement 1 — which is the thing to
 * check when arguing with any of them:
 *
 *     0 real -> 1 house  (TOTAL 1, and unfightable by construction)
 *     1 real -> 9 house  (TOTAL 10)      5 real -> 5 house  (TOTAL 10)
 *     2 real -> 8 house  (TOTAL 10)     10 real -> 0 house  (TOTAL 10)
 *
 * The jump from 1 to 9 between the first two rows is the whole design. It is not a discontinuity in
 * the policy — it is the treasury rule ending and the board rule starting, at the exact moment a real
 * player makes a fight legitimate. Nine bots appearing around somebody who just walked in is also, as
 * it happens, the thing that reads best: the room fills up because THEY arrived.
 *
 * `COVER` IS THE GENUINE MARKET-MAKER FUNCTION, and it is why the ladder above carries a caveat. A
 * lobby where every fighter picked the same side is not a fight — it is a queue — and no amount of
 * real entrants fixes that by itself, because they are free to all pick Bulls. So the house always
 * takes an empty side, even when fully throttled out by the count rule: eleven real players stacked
 * on side 0 still get one house fighter, and it stands on side 1. That is the one case where the
 * house adds a fighter to a room that does not need more fighters, and it is the case where the
 * alternative is a round that cannot be drawn.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT `"house-only"` IS, AND WHY IT IS THE ABSENCE OF POLICY RATHER THAN A NEW ONE
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * It deletes the early return and nothing else. What the general arithmetic then produces for an empty
 * room is not a special case that had to be designed — it is the ladder's own first row, computed the
 * way every other row is:
 *
 *     throttled = max(HOUSE_FLOOR - 0, HOUSE_BOARD_TARGET - HOUSE_DISPLACEMENT * 0)
 *               = max(HOUSE_FLOOR, HOUSE_BOARD_TARGET)  =  the board target, at any sane setting
 *     cover     = 2, because both sides are empty and both need somebody on them
 *     count     = max(throttled, cover)  =  the board
 *
 * So the mode is the ABSENCE of the override, not a second policy to keep in step with the first. That
 * is worth more than the two lines it saves: the arrival ramp, the side allocation and the stake band
 * all apply to a house-only round unchanged, because none of them ever knew about the override. A
 * house-only lobby therefore fills the way a lobby with a person in it fills — one fighter at a time,
 * across the window, onto alternating sides, at stakes drawn from the same band — rather than reverting
 * to the single burst that a separately-written empty-room path would have had to re-implement.
 */
export function houseFighterCount(real: SideCounts, policy: EmptyRoomPolicy = "unfightable"): number {
  const realTotal = real.side0 + real.side1;
  // FIRST, AND ABOVE EVERYTHING ELSE HERE. A room with nobody real in it is a room that must not be
  // able to hold a fight, whatever the board policy would otherwise like. Returning early rather than
  // folding this into the `min` below is deliberate: a clamp can be widened by editing a constant, an
  // early return has to be deleted on purpose.
  //
  // THE DEFAULT ARGUMENT IS THE SAFE POLICY, which is the one property of this signature worth
  // defending. A caller that forgets the parameter — a new call site, a test fixture, a refactor that
  // drops an argument — gets today's guarantee rather than a house-versus-house round, so the failure
  // mode of forgetting is "too careful" instead of "silently retired the treasury rule".
  if (realTotal === 0 && policy === "unfightable") return HOUSE_MAX_WITHOUT_REAL_PLAYER;

  const throttled = Math.max(
    HOUSE_FLOOR - realTotal,
    HOUSE_BOARD_TARGET - HOUSE_DISPLACEMENT * realTotal,
  );
  const cover = (real.side0 === 0 ? 1 : 0) + (real.side1 === 0 ? 1 : 0);
  return Math.max(0, Math.min(HOUSE_WALLET_COUNT, Math.max(throttled, cover)));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// WHEN THE HOUSE ARRIVES, WHICH IS A SEPARATE QUESTION FROM HOW MANY OF IT THERE ARE
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// THE COMPLAINT THIS ANSWERS, in one sentence: at the production board of forty-eight, a real player's
// arrival used to be followed about eight seconds later by forty-two house fighters materialising in
// a single frame. Every one of them is a legitimate seat under the policy above. Arriving together is
// what makes them read as a swarm rather than as a room.
//
// THE FIX IS A TIME-VARYING TARGET, NOT A DELAY. Nothing in this keeper sleeps: it re-derives every
// decision from the chain at 1 Hz, and `plannedHouseEntries` is already a pure function of the instant
// it is asked about. So the arrival pattern is expressed as a schedule — each pass plans only the
// fighters whose scheduled instant has already passed, and sends that small batch down exactly the
// same concurrent, fault-tolerant path a whole batch used to take. The trickle is an EMERGENT property
// of asking for less early on, which means it inherits every retry and accounting guarantee that path
// already had, and adds no new failure mode of its own.
//
// WHERE THE TIME COMES FROM, AND WHY THERE IS ONLY ONE PLACE IT COULD. `HOUSE_MAX_WITHOUT_REAL_PLAYER`
// binds whenever the room holds nobody real, so the house CANNOT trickle in ahead of the first real
// player — the room must go from one fighter to N after that moment, and the moment is the start of
// the grace window. `REAL_PLAYER_GRACE_SECONDS` is therefore the entire runway, which is why it is now
// a knob of its own rather than the chain's degenerate-lobby floor borrowed for the purpose.
//
// THE DISTRIBUTION IS UNIFORM ORDER STATISTICS, WHICH IS A POISSON PROCESS CONDITIONED ON ITS COUNT.
// A metronome — one fighter every 0.85 seconds — is not what a room filling up looks like; it is what
// a machine looks like. The canonical model of natural arrivals is a Poisson process, and a Poisson
// process conditioned on having produced N arrivals in a window is EXACTLY N independent uniform
// points on that window, sorted. That identity is the whole design: drawing N uniforms and sorting
// them gives exponential inter-arrival gaps for free — many short ones, the occasional long one —
// which is what clustering means and what a metronome cannot produce at any rate.
//
// ORDER AND STAKE ARE INDEPENDENT, DELIBERATELY. The stake is `houseStake(roundNo, wallet.index)` and
// the arrival slot is keyed on the ORDINAL, so the pairing between them is deterministic but
// unpatterned — which is what a real lobby looks like. The tempting alternative is "whales arrive
// late", and it is a real phenomenon in markets that have price discovery. This lobby has none: return
// is size- and seat-neutral (HOUSE-EDGE-STUDY.md §0), so there is nothing for a late entrant to have
// learned. Simulating a behaviour whose cause does not exist is a fiction that eventually reads as
// fake, and a correlation is a signature — an independent pairing announces nothing.

/** HOW FAR THROUGH THE ARRIVAL WINDOW THIS INSTANT IS, in [0, 1].
 *
 *  The window is `[drawAt - REAL_PLAYER_GRACE_SECONDS, drawAt - HOUSE_ARRIVAL_TAIL_SECONDS]`, and both
 *  ends are measured from `drawAt` rather than from the first real entry. Two reasons, and the second
 *  is the one that matters:
 *
 *    1. `drawAt` is the only instant `plannedHouseEntries` is given. The first real arrival is latched
 *       in the keeper's own timeline, not on the round account — a `Fighter` row carries no entry
 *       time — so anchoring to it would mean threading a second clock through a pure function to
 *       compute a quantity the first one already determines.
 *    2. IT DEGRADES IN THE RIGHT DIRECTION. `drawAt` is the grace window CAPPED at the chain's own
 *       `lobbyClosesAt`, so a player who arrives ten seconds before the deadline gets a `drawAt` ten
 *       seconds out — and the ramp compresses with it automatically, back towards the single burst
 *       this replaced, rather than politely trickling past a bell that has already rung and leaving
 *       the board short.
 *
 *  ON A NON-HELD-OPEN ROUND `drawAt` IS THE DEADLINE, so the ramp runs in the last `grace` seconds of
 *  the lobby and everything before that is flat. That is the old "commit late so displacement is real"
 *  behaviour, preserved on exactly the rounds it was written for.
 *
 *  A non-positive span is a configuration `config.ts` refuses at boot. It returns 1 rather than
 *  throwing anyway, because the honest degradation of "there is no window" is today's behaviour — the
 *  whole board, at once — and not an empty arena. */
export function arrivalFraction(nowSec: number, drawAt: number): number {
  const windowStart = drawAt - REAL_PLAYER_GRACE_SECONDS;
  const windowEnd = drawAt - HOUSE_ARRIVAL_TAIL_SECONDS;
  const span = windowEnd - windowStart;
  if (span <= 0) return 1;
  const fraction = (nowSec - windowStart) / span;
  return fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
}

/**
 * HOW MANY HOUSE FIGHTERS ARE DUE TO HAVE ARRIVED BY THIS POINT IN THE WINDOW.
 *
 * The schedule is `target` uniform draws on [0, 1], sorted, then AFFINELY RESCALED so the first sits
 * exactly at 0 and the last exactly at 1:
 *
 *     a_k = (u_(k) - u_(1)) / (u_(target) - u_(1))
 *
 * THE RESCALE IS THE SAFETY ARGUMENT AND IT IS WHY IT IS NOT JUST THE RAW DRAWS. It turns two
 * properties from probabilistic into STRUCTURAL:
 *
 *   * the room starts filling the instant the player arrives — `a_1 = 0`, always, rather than
 *     "usually within a second or two";
 *   * the schedule provably cannot run past the end of the window — `a_target = 1`, always. There is
 *     no configuration, and no round number, in which a planned entry never becomes due.
 *
 * Raw draws would give both of those with high probability and neither with certainty, and the failure
 * mode of the second one is a board that draws short for a reason no log line would ever explain.
 *
 * DETERMINISTIC, NEVER `Math.random()`, for the same reason `houseStake` is: a round's lineup and the
 * order it walked in has to be re-derivable from the round number alone, months later, after the
 * accounts have been closed. It also has to survive a retry — the keeper holds no memory, so two
 * passes over the same round must agree about who is due.
 *
 * THE LENGTH IS THE CURRENT BOARD TARGET, RECOMPUTED EVERY PASS, not a pool fixed when the window
 * opened. If real players have arrived and displaced house seats, the same number of arrivals spreads
 * across the same window rather than the schedule finishing early and leaving a dead lull before the
 * bell.
 */
export function arrivalsDueBy(roundNo: number, target: number, fraction: number): number {
  const n = Math.floor(target);
  if (n <= 0) return 0;
  // AT THE END OF THE WINDOW, EVERYTHING IS DUE — AS A STATEMENT RATHER THAN AS AN ARITHMETIC RESULT.
  // This is the load-bearing property of the whole ramp: at `fraction >= 1` it is a no-op, the planner
  // asks for the full shortfall in one batch exactly as it did before there was a schedule, and
  // "every planned entry lands or is counted" is preserved by construction. Stated as an early return
  // because `u_(1) + 1 * (u_(target) - u_(1))` is NOT exactly `u_(target)` in binary floating point,
  // and a board that silently draws one fighter short in some rounds and not others is precisely the
  // kind of bug that survives review.
  if (fraction >= 1) return n;
  // One arrival is due at the window's opening by construction (`a_1 = 0`), which also covers the
  // single-fighter schedule without a division.
  if (n === 1) return 1;

  const draws: number[] = [];
  // Keyed on the ORDINAL (1..target), not on a wallet index: the schedule is about the shape of the
  // arrivals, and which wallet takes which slot is decided elsewhere and independently. `2 ** 32` is
  // the width of `mix`'s output, so this is a uniform in [0, 1).
  for (let k = 1; k <= n; k++) draws.push(mix(roundNo, k) / 2 ** 32);
  draws.sort((a, b) => a - b);

  const first = draws[0]!;
  const spread = draws[n - 1]! - first;
  // Every draw collided, which needs the hash to produce one value for `n` distinct inputs. The affine
  // rescale is undefined there and the honest reading is that the whole schedule sits at one instant,
  // so everything is due at once. Degrading to "all of them now" rather than "none of them ever" keeps
  // the guarantee above true even in a case that cannot happen.
  if (spread <= 0) return n;

  // `a_k <= fraction` rearranges to `u_(k) <= first + fraction * spread`, so the count is a scan over
  // an already-sorted array rather than a second array of rescaled instants.
  const threshold = first + fraction * spread;
  let due = 0;
  while (due < n && draws[due]! <= threshold) due++;
  return due;
}

/**
 * WHICH SIDE EACH HOUSE FIGHTER STANDS ON — greedily, onto whichever side is currently smaller,
 * counting the ones this call has already placed.
 *
 * Greedy-onto-the-smaller-side is not a heuristic here, it is the guarantee: because each assignment
 * updates the counts the next one reads, `count >= cover` is sufficient for both sides to end up
 * non-empty. Ties break toward side 0, which only decides which side an even split starts on and
 * matters solely so the allocation is reproducible.
 *
 * It reads the REAL counts, not just the house's own, because the house is balancing the lobby it is
 * joining rather than balancing itself.
 */
export function allocateHouseSides(count: number, real: SideCounts): (0 | 1)[] {
  const filled: [number, number] = [real.side0, real.side1];
  const sides: (0 | 1)[] = [];
  for (let i = 0; i < Math.max(0, Math.floor(count)); i++) {
    const side: 0 | 1 = filled[1] < filled[0] ? 1 : 0;
    filled[side]++;
    sides.push(side);
  }
  return sides;
}

/**
 * WHAT A HOUSE FIGHTER STAKES, in the program's opaque u64 units.
 *
 * THE BAND is `KEEPER_HOUSE_STAKE_MIN_USD` / `_MAX_USD`, defaulting to $5-$20, and it is argued in
 * `config.ts` because it is the one thing in this policy that decides how much the house has at risk.
 * What belongs here is the constraint the band has to satisfy however it is set:
 *
 * Real players are offered `STAKE_PRESETS` — $5, $20, $50, $100 — so house stakes are drawn from
 * inside that same range, and the roster reads as a market rather than as N identical bots sitting at
 * one round number. Both edges are load-bearing: a house fighter below $5 would be dwarfed by every
 * real entrant at the smallest preset available to them, and one at $100 would dwarf that entrant
 * instead. Neither is a good look for a market maker. The default ceiling stops at $20 — the second
 * rung rather than the top — because the house is seeding liquidity, not providing it, and because
 * exposure is `fighters x mean stake` and the fighter count has just gone up by a factor of four and
 * a half. `houseSizing.test.ts` pins the band to the preset ladder so a re-peg of `STAKE_PRESETS`
 * cannot silently strand it.
 *
 * DETERMINISTIC, NOT `Math.random()`. A round's house lineup is reproducible from the round number
 * alone, forever, by anybody with this file. That is what makes an odd-looking round debuggable after
 * the fact: "round 214's bots staked 5/47/12/33" is a claim that can be re-derived and checked
 * months later, against a round whose accounts have long since been closed. With a random source it
 * would be unrecoverable the moment the process exited, and every question about a strange-looking
 * pot would end in a shrug.
 *
 * Whole dollars, so the roster reads cleanly — nobody staking $37.4192 looks like a person.
 */
export function houseStake(roundNo: number, walletIndex: number): bigint {
  // `span` buckets taken modulo a 32-bit hash carries the usual modulo bias; at any band an operator
  // can configure it is well under one part in a million and it decides how often a bot picks $5 over
  // $6. Rejection sampling here would be ceremony.
  const span = HOUSE_STAKE_MAX_USD - HOUSE_STAKE_MIN_USD + 1;
  const usd = HOUSE_STAKE_MIN_USD + (mix(roundNo, walletIndex) % span);
  // The peg (`UNITS_PER_USD`) is not restated here — it lives in `contract.ts` and every path that
  // turns dollars into units goes through this one function, house and player alike.
  return usdToUnits(usd);
}

/** A 32-bit integer hash of the two inputs — the `lowbias32` finalizer applied to each half and
 *  combined with the golden-ratio constant, which is the standard cheap way to keep `(1, 0)` and
 *  `(0, 1)` from colliding and to keep consecutive round numbers from producing consecutive stakes.
 *
 *  It is a hash, not a PRNG: no state, no seeding, no sequence. Cryptographic strength is beside the
 *  point — nothing is being protected here, the outputs are published in the same breath as the
 *  wallets that post them, and the only property required is that the result looks unpatterned to a
 *  reader and is identical on every machine that computes it.
 *
 *  TWO CALLERS, ONE HASH, AND IT STAYS MODULE-PRIVATE. `houseStake` keys it on (round, wallet index)
 *  and `arrivalsDueBy` on (round, arrival ordinal); both live in this file because both are the same
 *  kind of judgement, so nothing outside needs it and a second copy of a hash is the surest way to end
 *  up with two that disagree. The two key spaces being different is also what keeps a wallet's stake
 *  and its place in the queue unrelated — see the arrival block above for why that independence is
 *  deliberate rather than incidental. */
function mix(roundNo: number, walletIndex: number): number {
  const combined = (avalanche(roundNo) ^ (avalanche(walletIndex) + 0x9e3779b9)) >>> 0;
  return avalanche(combined);
}

function avalanche(value: number): number {
  let h = Math.trunc(value) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}
