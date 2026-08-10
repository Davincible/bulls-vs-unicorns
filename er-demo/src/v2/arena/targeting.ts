// Who is each fighter currently moving toward? Decided entirely by where the playhead sits in the
// ordered event array, so it can be reasoned about — and tested — without a canvas, a body, or a
// clock: `assign` takes numbers, the event array and a liveness predicate, and returns ids.
//
// The whole idea, restated because it is the non-obvious part of this design: the on-chain fight has
// no positions and no collisions — `hash(seed, step) % n` picks the pair. So the motion cannot
// decide the hits; it has to ANTICIPATE them. Reading a few seconds ahead of the playhead and
// steering the named pair together means that when the hit finally lands, it lands on two circles
// that are already touching, and the whole thing reads as cause and effect instead of as two
// unrelated systems running side by side.
//
// THAT IS THE INTENTION. IT WAS NOT WHAT THE FIELD ACTUALLY DID, and the gap between the two is what
// this file's current shape exists to close. `field.ts`'s `RECOIL_REACH` note records the symptom
// from the other end — a hit's throw could only fire on 6-12% of blows because the pair was
// typically 169 units (n=9) / 203 units (n=16) apart at the instant it landed, against a parking
// distance of 22 — and hands the diagnosis here. Measured on the same rig (fixture lineup, real
// seeded `runFullFight` stream, the real field, 60fps for a whole fight), the cause was NOT the one
// that had been assumed:
//
//   THE CHURN HYPOTHESIS IS FALSE. The worry was that a fighter is named in an event roughly twice a
//   second, so a tracker that re-picks whenever the stream names it could never finish a crossing.
//   The old `DWELL_MS` was doing its job precisely: on the fixture's own seed, 0.33 re-picks per
//   fighter per second and a median commitment of 1.93 seconds — i.e. every commitment ran to its
//   full dwell. Commitments were long. They were pointed at the wrong shape.
//
//   THE REAL CAUSE IS THAT THE COMMITMENTS WERE NOT MUTUAL. The old `computeTargets` swept the
//   window back to front writing BOTH sides of every event, so a later write — an event nearer the
//   cursor — silently overwrote one half of an earlier pairing. Given `A↔B` at +900ms and `A↔C` at
//   +400ms it produced `A→C, B→A, C→A`: B is chasing A, and A is running away to C. The result is a
//   FUNCTION on the fighters, not a matching, and reciprocity in it is an accident. Measured over
//   eight seeds, only 39% (n=9) / 31% (n=16) of steering links were reciprocated, and the gap at the
//   moment of the blow splits cleanly along exactly that line:
//
//   ```text
//   link at the instant the hit lands       median edge-to-edge gap, in units
//   mutual — both steering at each other     107 (n=9)   159 (n=16)
//   one-sided — a chase                      191 (n=9)   223 (n=16)
//   over ALL hits, whatever the link         189 (n=9)   229 (n=16)
//   ```
//
//   A one-sided link is not an approach. It is a pursuit of a fighter who is himself accelerating
//   toward somebody else, so the closing speed is a difference of two velocities rather than a sum.
//   The third row is what convicts it: a one-sided chase lands its blow at the distance two fighters
//   picked at random would have been at anyway — `field.ts` holds non-duelling bodies at
//   `0.85·sqrt(area/n)`, which on a desktop panel at nine fighters is 212 units. For most of the
//   field the steering was doing nothing at all.
//
//   AND THE STAGGER MADE IT WORSE. The old renewal fired at `DWELL_MS + (id·137 % 500)`, deliberately
//   out of step across the table so that sixteen fighters would not re-target in unison. But A and B
//   therefore latched their proposals at different instants, against different windows — so even the
//   reciprocity `computeTargets` did produce was routinely torn in half a beat later.
//
// SO THE MODEL CHANGED FROM A DWELL TO AN APPOINTMENT BOOK. A fighter is not "committed to somebody
// for 1.6 seconds"; it is BOOKED for a specific upcoming blow, together with the fighter on the other
// end of it, from far enough out that it can actually be there. See `CROSSING_MS`.
//
// WHAT THAT MEASURES AS, driven end to end on the same rig — eight seeded fights per cell, the whole
// fight at 60fps, the real field and the real replay, `recoil` counted by whether it actually applied
// an impulse. "gap" is edge-to-edge between the pair at the instant their blow lands, in `unit`s,
// against a parking distance (`STANDOFF_GAP`) of 22:
//
// ```text
// lineup / panel        committed-pair gap        hits landing      steering links     centroid sd /
//                        median      p90       in contact  <=44u    reciprocated      frames >15% off
//  9 @ 1390x781        164 -> 100  421 -> 361  10.6->14.2% 13.4->17.7%  39% -> 71%   8.7->7.6% / 8.6->6.0%
// 16 @ 1390x781        213 -> 114  478 -> 384   6.2->10.6%  8.1->13.0%  31% -> 81%   5.3->4.2% / 0.8->0.4%
// 16 @  360x270        162 ->  87  356 -> 285   7.8->12.8% 10.6->15.6%  31% -> 81%   6.6->5.5% / 1.9->1.2%
//  2 @ 1390x781         64 ->  60  188 -> 199  28.8->33.3% 37.8->42.5% 100% ->100%  19.3->19.5% / 51->54%
// ```
//
// AND ONE MORE COLUMN, because `leadMs` is half of what this module hands downstream and none of the
// above would have caught it being wrong: the share of LUNGE frames — `field.ts` inside `LUNGE_MS` of
// a blow — in which the pair is still more than two standoffs apart. It runs 84.9% -> 74.0% (n=9),
// 90.7% -> 76.9% (n=16), 88.3% -> 73.2% (phone). Read it as a BOUND on wasted anticipation rather
// than a count of visible failures: a pair closing at twice cruising speed covers about 50 units
// inside a lunge, so some of what it counts does arrive in time. It is the before/after ratio that is
// the finding, and it is the one number the `leadMs` fix moves on its own.
//
// A DUEL IS ALMOST UNTOUCHED, and the part that moved is worth reading. `held` is identical on every
// frame of every duel — structurally, not luckily: at two fighters there is exactly one pair the hash
// can draw. What changed is `leadMs`, and it changed for the better (contact 28.8% -> 33.3%): the
// duel is the case where the old lead was most often the refused blow, because the pair is together
// from the first frame and therefore always has a blow nearer than the one it was booked for. Two
// fighters is also the one lineup where the composition reads poorly — the crowd's centroid IS the
// duelling pair, so `field.ts`'s `recentre` is measuring the thing it is trying to move — and that is
// a two-body artifact of the statistic, documented at `FERVOUR_GAIN`, not something decided here.
//
// No run at any size produced a NaN or a body outside the walls.
//
// AND THE HONEST CEILING, because the next person to look at this should know where the floor is
// before spending a week on it. The fight's own cadence bounds how much of this is choreographable at
// all: solve, per fighter, for the largest subset of its own blows it could attend given a travel time
// of 0.6s — a longest-chain DP over the real stream, and an UPPER bound because it lets each fighter
// choose independently of the fighter on the other end — and the answer is 61% (n=9) / 56% (n=16).
// Mutual agreement costs most of the rest. What is NOT reachable from this file is the gap on the
// blows nobody can attend: `field.ts` holds non-duelling bodies at `0.85·sqrt(area/n)`, which IS the
// ~200-unit figure those blows land at, so the median over ALL hits is set by the crowd's spacing and
// not by anything decided here. Raising the contact rate further means either a tighter crowd or a
// faster crossing, and both of those live in `field.ts`.
//
// NOTHING HERE CAN CHANGE A NUMBER ON THE PAGE. This module reads the ORDER of the event array and
// where the playhead sits in it, and returns ids. It never touches `amount`, never reorders, never
// applies — `replay.ts` owns the playhead and `advanceReplay` owns application, and both are upstream
// of this call. `run_fight()` picked every attacker, defender and roll by `hash(seed, step)` before
// the canvas drew its first frame; all that is chosen here is who walks toward whom in the meantime.

import { stepsPerSecond } from "../contract.ts";
import type { HitEvent } from "../../sim/hitEvents.ts";

/** How far ahead to look, in EVENTS — scaled to the table, because the fight's pace is scaled to the
 *  table. The chain advances `stepsPerSecond(n) = n * 2` steps a second and roughly half of those
 *  produce a real exchange (`tick()` skips same-side, self and dead pairs), so `2 * n` events is
 *  between two and three seconds of lead at any lineup size — measured on the fixture at 2.0s (n=2),
 *  2.5s (n=9) and 2.9s (n=16).
 *
 *  `render/arena/retarget.ts`'s flat 4 was tuned against a two-fighter duel; at a full table it is a
 *  quarter-second window that most fighters don't appear in at all, so most of the field would idle
 *  through a brawl.
 *
 *  UNCHANGED THROUGH THE REWRITE, AND CHECKED RATHER THAN ASSUMED. The window's job is now to hold
 *  enough appointments that the sweep below can find each fighter one it can keep, so "is it long
 *  enough" is a question with an answer: at `3 * n` the committed-pair gap improves by a further 10
 *  units at nine fighters and 13 at sixteen, and wall contact rises from 0.66% of live-body-frames to
 *  0.77%. That is a fifth of a unit of gap per basis point of a fighter sliding along an edge, which
 *  is not a trade worth making, and a longer window is also a longer bet on a stream that an
 *  `extract()` may recompute. Left where it was. */
export function lookaheadFor(count: number): number {
  return Math.max(8, count * 2);
}

/** HOW LONG BEFORE A BLOW LANDS ITS PAIR MUST BE BOOKED — the one number this file turns on, and the
 *  rule it enforces is that A FIGHTER IS ONLY EVER SENT TO AN APPOINTMENT IT CAN KEEP.
 *
 *  The old tracker picked the NEAREST upcoming event naming a fighter, whenever its dwell happened to
 *  run out. Both halves of that are wrong for the same reason. A blow 80ms away cannot be arrived at
 *  from anywhere — the field's whole width is about a second of travel — so committing to it buys
 *  nothing, and it costs the one thing that is scarce: the fighter is now pointed at somebody it will
 *  be finished with before it has moved, instead of at the blow after that, which it could have made.
 *  Skipping the unreachable appointment is free. It was going to land at range whatever the steering
 *  did; the next one need not.
 *
 *  WHAT THE NUMBER IS. It is the time a mutually-committed pair takes to close the distance between
 *  two fighters who are not already duelling, which `field.ts` holds at `SPACING_SHARE · sqrt(area/n)`.
 *  The crossing is ACCELERATION-limited rather than speed-limited — `MAX_SPEED / SEEK_ACCEL` is
 *  0.70s, longer than the crossing itself — so with both parties closing at `SEEK_ACCEL · unit · ramp`
 *  the distance covered is `a·t²` and the time is `sqrt(d/a)`:
 *
 *  ```text
 *  lineup / panel     separation   accel at the bell   crossing: bell -> last round
 *   9 @ 1390x781         295px         418 px/s²          0.84s  ->  0.52s
 *  16 @ 1390x781         221px         418 px/s²          0.73s  ->  0.45s
 *  16 @  360x270          66px         165 px/s²          0.63s  ->  0.39s
 *  ```
 *
 *  (The late column is the same figure divided by `sqrt(1 + FERVOUR_GAIN)`; every acceleration in the
 *  field ramps with the round — see `field.ts`'s `FERVOUR_GAIN` — so a crossing gets faster as the
 *  fight goes on, by the square root of the ramp rather than by the ramp.) 600ms is a little under
 *  the middle of that spread, which is where a constant belongs: too long is a fighter booked further
 *  out than it needed to be, too short is a booking it cannot keep.
 *
 *  AND IT IS A PLATEAU, NOT A PEAK, which is the only honest way to hold a tuned constant. Over eight
 *  seeds at nine and sixteen fighters, the committed pair's median gap runs 97-119 units anywhere
 *  between 400ms and 850ms and only degrades outside it (103/128 at 300ms). Nothing here is balanced
 *  on the third digit.
 *
 *  NOT SCALED BY THE FERVOUR RAMP, and that was measured rather than reasoned. The table above says
 *  the crossing gets 1.6x faster across a round, so dividing this by `1 + FERVOUR_GAIN · fervour`
 *  looks obviously right — the playhead and the last event's step are both in scope here, so the
 *  ramp is computable without a new argument. It buys nothing: at every equivalent opening value the
 *  scaled form lands inside the noise of the flat one (committed gap 96/118 against 102/109), because
 *  the floor is already sitting on a plateau twice as wide as the effect. A constant that measures
 *  the same as a derived one, and does not have to be kept in step with another file's ramp, is the
 *  better of the two.
 *
 *  IT IS ALSO WHAT KEEPS THE ANTICIPATION HONEST — BUT ONLY BECAUSE `leadMs` IS READ OFF THE BOOKING.
 *  `field.ts` starts a windup at `WINDUP_MS` (300ms) before the blow and a lunge at `LUNGE_MS`
 *  (120ms). A booking is always made at least this far out and 600 > 300, so the run-in cannot begin
 *  before the pair was told to set off.
 *
 *  THAT DID NOT HOLD WHEN THIS FLOOR FIRST LANDED, and the hole is worth recording because the
 *  constant was right and the number handed downstream was not. `leadMs` was recomputed after the
 *  sweep as the nearest window blow naming the held pair, with no reference to which blow had
 *  actually been booked — so a pair booked for their SECOND blow was reported against their first,
 *  i.e. against the very blow this floor had just refused as unreachable. The two-fighter duel shows
 *  it at its purest, on frame zero: the step-1 blow is 250ms out, the floor refuses it, the pair is
 *  booked for the step-3 blow at 750ms — and the field was then handed 250ms and made them rear back
 *  and lunge at the refused one, arriving for the real blow with the anticipation already spent. It
 *  is the failure `WINDUP_MS`'s own note describes, inverted: a strike reading as an arrival rather
 *  than a decision.
 *
 *  So the lead now comes from `bookedAt` and from nothing else. This constant is only a guarantee
 *  about the anticipation if the two are the same blow.
 *
 *  WHAT THAT ONE CHANGE IS WORTH, isolated — the same book, the same holds, only the lead's source
 *  swapped, eight seeds a cell:
 *
 *  ```text
 *  lineup / panel     hits in contact   run-ins fired   of which the pair is >2 standoffs apart
 *   2 @ 1390x781      28.8% -> 33.3%    57.1 -> 56.2         66.7% -> 64.4%
 *   9 @ 1390x781      14.3% -> 14.2%    10.4 ->  8.8         76.7% -> 74.0%
 *  16 @ 1390x781      10.3% -> 10.6%    10.0 ->  9.1         79.3% -> 76.9%
 *  16 @  360x270      13.5% -> 12.8%    10.0 ->  9.1         74.0% -> 73.2%
 *  ```
 *
 *  The duel is where it pays, and for the reason the trace above shows: a pair together from the
 *  first frame ALWAYS has a blow nearer than the one it was booked for, so it was the lineup getting
 *  the wrong number most often. A full table is a wash on contact and fires a seventh fewer run-ins,
 *  each better aimed — which is the trade, since the run-ins removed are the ones aimed at a blow
 *  this module had already refused. THE PHONE PAYS 0.7 OF A POINT and it is not noise: on a 360x270
 *  panel the crowd's spacing is 66px and a lunge covers about 50 units, so aiming at whatever blow
 *  was nearest was frequently a lunge the pair could complete anyway — wrong in meaning, right by
 *  accident, on the one panel where everything is within reach. Taken, because a number that means
 *  one thing at every size is worth more than a point of contact on the smallest one.
 *
 *  EXPORTED for that guarantee and not for its value. The invariant that matters is the CROSS-FILE
 *  one — `CROSSING_MS > WINDUP_MS` — and until this was exported neither file could state it: a test
 *  wanting to check it had to binary-search several hundred `assign` calls for a number this module
 *  already knew. Nothing outside is expected to depend on it being 600. */
export const CROSSING_MS = 600;

export interface TargetTracker {
  /** The committed assignment for each id this frame. `isDead` breaks a booking early — an extracted
   *  fighter must stop being chased the instant the chain says it left, which is the case
   *  `render/arena/retarget.ts` documents.
   *
   *  The returned array is the tracker's own and is rewritten in place on every call; the loop reads
   *  it and hands it straight to `stepField` within the same frame, and nothing else may hold it. */
  assign(
    count: number,
    events: HitEvent[],
    cursor: number,
    /** The replay's float step position — see `leadMs`. */
    playhead: number,
    nowMs: number,
    isDead: (id: number) => boolean,
  ): (number | null)[];
  /** HOW LONG UNTIL THE BLOW THIS FIGHTER WAS SENT TO MAKE, in ms — the lead of its BOOKING, and
   *  `Infinity` when it has no booking.
   *
   *  This is what buys the field anticipation — see field.ts's WINDUP_MS. The whole premise of this
   *  module is already that the fight's future is KNOWN (`run_fight()` decided every pair before the
   *  first frame), and the steering has always used that to have the right two circles in the right
   *  place; this is the same knowledge spent on having them arrive at the right MOMENT.
   *
   *  IT IS THE BOOKED BLOW AND NOT THE NEAREST ONE, which is a distinction with a measured cost — see
   *  `CROSSING_MS`. Reporting the nearest blow between the held pair sounds like the same thing and
   *  is not: a pair whose soonest blow was refused as unreachable is travelling toward a LATER one,
   *  and handing the field the refused blow's lead makes them rear back at a fighter they are still
   *  half a field from.
   *
   *  `Infinity` therefore covers three cases, and all three are a fighter that should not be rearing
   *  back at anybody: it has no partner; it has a partner but no booking, because the sweep found it
   *  nothing keepable; or its booked blow has landed and it is standing in the follow-through. A
   *  fighter that winds up and lunges at somebody it is not about to trade with is a fighter
   *  attacking a bystander, which is worse than no anticipation at all.
   *
   *  Both ends of a booked pair carry the same number by construction, so a duel's windup and lunge
   *  begin on the same frame at both ends. Valid for the frame it was computed on, same as `assign`. */
  readonly leadMs: number[];
}

/** THE TRACKER'S STATE IS THREE FLAT ARRAYS AND NOTHING ELSE, which is what makes the three ways this
 *  page can be interrupted safe by construction rather than by a guard each:
 *
 *    A BACKGROUNDED TAB. rAF stops while the playhead runs on wall clock, so the first frame back
 *      arrives with `nowMs` jumped by however long the tab was hidden. Every `bookedAt` is therefore
 *      in the past, every fighter is free, and the whole field re-books in one sweep against the
 *      cursor the replay has caught up to. That is exactly the wanted behaviour, and it is the
 *      behaviour of the ordinary path — there is no catch-up branch here to get wrong.
 *      (`replay.ts`'s `MAX_ANNOUNCED` handles the other half of a stall, which is FX, not steering.)
 *    A REPLACED STREAM. An `extract()` makes the data layer recompute `hitEvents` from the extraction
 *      point on. Nothing here stores an event INDEX or an object identity — a booking is a partner id
 *      and a wall-clock instant — so a swapped array cannot leave a dangling reference. The worst a
 *      swap can do is leave a pair booked for a blow that no longer exists, and that booking simply
 *      comes due and is replaced.
 *    THE END OF THE FIGHT. Past the last event the window is empty, nobody is booked, and every pair
 *      goes on holding the partner it last had. That is the right picture — the fight stopped, the
 *      fighters are still facing each other — and `motionModeFor("Settled")` brings the field to a
 *      standstill around it regardless.
 *
 *  A NEW ROUND WITH THE SAME NUMBER OF FIGHTERS IS THE ONE CASE THAT LOOKS UNGUARDED AND IS NOT, and
 *  it is written down because a reader will notice that the only reset here is keyed on the lineup
 *  SIZE. `arenaLoop` builds one tracker for the life of the page, so a round following a round of the
 *  same size inherits the previous round's holds. Three things make that correct rather than lucky,
 *  and a change to any of them is a change to this:
 *
 *    - `bookedAt` is an instant on a MONOTONIC clock (`rafMs`), so every inherited appointment is
 *      already in the past. Nobody is busy, and the first sweep of the new round re-books the whole
 *      field against the new stream.
 *    - an inherited hold therefore carries no appointment, so `leadMs` is `Infinity` for it. Nothing
 *      rears back at a partner left over from a fight that is finished.
 *    - the ids are positions in the lineup array and `arenaLoop` rebuilds the field whenever a wallet
 *      or a stake changes, so an inherited id is always a real fighter in the new table — the same
 *      count is the same seats, even when it is not the same people.
 *
 *  What survives is a fighter walking toward last round's partner for the frame or two before the
 *  sweep books it, in a phase (`Lobby`/`Drawing`) where `motionModeFor` returns `calm` and `stepField`
 *  ignores targets outright. Clearing the book on a cursor that has moved BACKWARDS would close even
 *  that, and was left out on purpose: it is a variable and a branch whose entire job would be to
 *  shorten this paragraph.
 *
 *  And it allocates nothing per frame. This runs sixty times a second for the life of the page; the
 *  arrays are at most sixteen slots wide and are rebuilt only when the lineup size changes. */
export function createTargetTracker(): TargetTracker {
  /** Who each fighter is steering at. Outlives the booking that created it — see the sweep. */
  let held: (number | null)[] = [];
  /** WHEN THE BLOW THIS FIGHTER IS TRAVELLING TOWARD LANDS, on the loop's rAF clock. Until that
   *  moment the fighter is BUSY and no nearer event may book it away; after it, the fighter is free
   *  again but goes on steering at the same partner until something better is booked, which is the
   *  follow-through — a pair that has just traded stays together for the beat it takes the recoil to
   *  bleed off, instead of turning on its heel inside the same frame the number appears.
   *
   *  `bookedAt[id] > nowMs` IS THE WHOLE PREDICATE — "booked, and on its way". Anything else is a
   *  fighter with no appointment, whether because it never had one, because the fallback merely aimed
   *  it, or because its blow has already landed. Two readers depend on exactly that one test: the
   *  busy check in the sweep, and `leadMs`. A past instant and a never-set `0` are deliberately the
   *  same state, so there is no third value for a reader to get wrong. */
  let bookedAt: number[] = [];
  let leadMs: number[] = [];

  return {
    get leadMs() {
      return leadMs;
    },

    assign(count, events, cursor, playhead, nowMs, isDead) {
      if (held.length !== count) {
        held = new Array<number | null>(count).fill(null);
        bookedAt = new Array<number>(count).fill(0);
        leadMs = new Array<number>(count).fill(Infinity);
      }

      // BREAK WHAT CAN NO LONGER STAND, and free the booking with it: a fighter still marked busy for
      // a blow that will never be struck could not be re-booked until its old appointment came due.
      for (let id = 0; id < count; id++) {
        const partner = held[id];
        if (partner === null) continue;
        if (partner >= count || partner < 0 || isDead(id) || isDead(partner)) {
          held[id] = null;
          bookedAt[id] = 0;
        }
      }

      const msPerStep = 1000 / stepsPerSecond(count);
      const end = Math.min(events.length, cursor + lookaheadFor(count));

      // THE BOOK, NEAREST APPOINTMENT FIRST. One sweep of the window; the soonest blow whose two
      // fighters are both free claims them both, and they are then busy until it lands. Sweeping
      // forwards rather than backwards is what makes this a matching instead of the old overwrite:
      // an event can only take a fighter nobody nearer has already taken, so both halves of every
      // pairing survive to the end of the sweep.
      for (let i = cursor; i < end; i++) {
        const event = events[i];
        const a = event.attackerId;
        const d = event.defenderId;
        if (a < 0 || a >= count || d < 0 || d >= count || a === d) continue;
        if (isDead(a) || isDead(d)) continue;
        if (nowMs < bookedAt[a] || nowMs < bookedAt[d]) continue;
        const lead = Math.max(0, (Number(event.step) - playhead) * msPerStep);
        // THE FLOOR IS WAIVED FOR A PAIR ALREADY STANDING TOGETHER, and it is not a special case —
        // it is the same rule. `CROSSING_MS` is a TRAVEL budget, and a pair that is already at its
        // standoff has no travel left to pay for. Hash-picked pairs recur, so this is what lets two
        // fighters who keep drawing each other trade three or four blows in a row where they stand
        // rather than being separated by the floor and sent back across the field between them.
        if (lead < CROSSING_MS && !(held[a] === d && held[d] === a)) continue;
        held[a] = d;
        held[d] = a;
        bookedAt[a] = nowMs + lead;
        bookedAt[d] = nowMs + lead;
      }

      // ...AND WHOEVER IS LEFT WITH NOBODY AT ALL. The opening frames, and a fighter whose partner
      // has just gone out. Nearest event wins, one-sided, exactly as this file's first draft assigned
      // everyone: it is the weaker reading, but a fighter drifting on `WANDER_SPEED` in the middle of
      // a brawl is a worse one, and a fighter with no booking has nothing else to be doing.
      //
      // Note what this deliberately does NOT do: it leaves a STALE one-sided link alone. When a
      // nearer blow books A away from B, B goes on steering at A rather than being re-aimed. Tried
      // both ways — re-aiming every lapsed unreciprocated link at its own current nearest event costs
      // 28 units of committed-pair gap at nine fighters and 55 at sixteen, and takes the centroid
      // from 5.2% to 11.3% of the fight spent more than 15% off centre. Chasing the fighter you were
      // last told to fight is coherent; being spun round every time somebody else's appointment
      // changes is the churn this whole file is written against.
      //
      // AND IT AIMS BUT IT DOES NOT BOOK, which is the whole difference between the two sweeps. A
      // booking is a claim that this fighter has been SENT somewhere and can get there; the floor
      // above is what makes the claim true, and this sweep has no floor. So it leaves `bookedAt`
      // alone, which buys both of the things that follow from a fighter having no appointment:
      // `leadMs` stays `Infinity`, so nothing rears back at a blow it cannot reach; and the fighter
      // stays FREE, so the book may take it the moment a keepable one appears rather than being
      // locked out until whatever the fallback happened to point at has landed.
      for (let i = cursor; i < end; i++) {
        const event = events[i];
        const a = event.attackerId;
        const d = event.defenderId;
        if (a < 0 || a >= count || d < 0 || d >= count || a === d) continue;
        if (isDead(a) || isDead(d)) continue;
        if (held[a] === null) held[a] = d;
        if (held[d] === null) held[d] = a;
      }

      // ...and then the lead times, off THE BOOK and not off the window — see `leadMs` and
      // `CROSSING_MS`. `bookedAt` is the instant the booked blow lands, so the remaining lead is a
      // subtraction: it needs no second scan, it cannot drift onto a different blow, and it holds no
      // event index for a recomputed stream to invalidate.
      //
      // It counts down truthfully because `nowMs` and `playhead` are driven by the same rAF timestamp
      // at the same rate (see arenaLoop), so a booking made at `nowMs + lead` is still exactly `lead`
      // ahead of the playhead a hundred frames later. Verified frame by frame against the window
      // scan it replaced: both fall at 16.7ms per frame, they simply count down to different blows.
      //
      // `<` and not `<=`: at the instant the booked blow lands the fighter has nothing ahead of it
      // and should not be lunging. That also makes a zero-lead booking harmless rather than a lunge
      // on the frame it is made.
      for (let id = 0; id < count; id++) {
        leadMs[id] = nowMs < bookedAt[id] ? bookedAt[id] - nowMs : Infinity;
      }
      return held;
    },
  };
}
