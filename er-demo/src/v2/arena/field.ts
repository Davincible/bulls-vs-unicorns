// The field: one circle per fighter, its radius a pure function of the value still in its ring, and
// a few hundred flops per frame of drift / seek / bounce to move them around.
//
// WHY NOT matter-js (it is already a dependency, and render/arena/ArenaScene.ts uses it):
//
//   1. A Matter body's collider radius is fixed at construction. Ours is not — it tracks hp, which
//      changes on every hit, which is the entire point of the visual (`Matter.Body.scale` exists,
//      but then "how big is this fighter" lives in two places that have to be kept in agreement
//      every frame, and the drawn circle and the thing that collides can drift apart. In a design
//      whose one job is to make relative wealth readable at a glance, that is not a detail.)
//   2. Matter buys rigid-body dynamics — rotation, restitution, compound shapes, constraints, a
//      broadphase built for hundreds of bodies. At the program's cap of 16 circles the broadphase
//      is 120 pair checks, and the other features are all things this design actively does not want.
//   3. The gameplay feel being preserved is `web/index.html`'s, and that is positional separation
//      plus an impulse exchange along the contact normal — thirty lines, reproduced below. Running
//      it through a physics engine would be a re-implementation of the reference, not a use of it.
//
// The physics is COSMETIC and always was: `run_fight()` picks its pairs by hash, so nothing here
// decides anything. It exists to make the hit stream legible.

import type { Side, FighterView } from "../contract.ts";

export interface ArenaBody {
  readonly id: number;
  /** Identity across a rebuild — `id` is a position in the on-chain array, the wallet is the player. */
  readonly wallet: string;
  readonly side: Side;
  readonly name: string;
  readonly isYou: boolean;
  /** `FighterView.avatarSrc` — a same-origin path, or null for the (majority) unlinked fighter.
   *
   *  Carried onto the body so `faces.ts` can resolve a face without the canvas ever touching data,
   *  which is the boundary `SOCIAL.md` §6.3 exists to hold.
   *
   *  THE ONE MUTABLE FIELD IN THIS BLOCK, and the exception is the point rather than an oversight.
   *  Everything above it is immutable identity: a wallet, a side, a pseudonym and a stake are all
   *  decided before the body exists and cannot change while it does. An avatar is not identity in
   *  that sense — it is a LATE-ARRIVING NETWORK RESOURCE about an identity, and the link feed
   *  resolves its fetch after the round is already on screen essentially every time. So this field
   *  belongs with `hp`/`banked`/`dead` below, which are likewise mirrored in from outside on the
   *  frames they move, and it is written by `syncAvatars` for exactly their reason: the alternative
   *  is rebuilding the field to deliver one string, which throws away live physics state.
   *
   *  It is declared HERE rather than beside them because a reader asking "what is this fighter"
   *  should find it with the wallet and the name. Grouping is for the reader; `readonly` is for the
   *  compiler; they disagree in this one case and this comment is the reconciliation. */
  avatarSrc: string | null;
  /** Starting hp, i.e. net-of-fee stake — fixed for the life of the round. */
  readonly stake: bigint;

  x: number;
  y: number;
  vx: number;
  vy: number;
  /** The drawn radius AND the collider. One number, so they cannot disagree.
   *
   *  It CHASES `rTarget` through a spring rather than tracking it exactly — see RADIUS_STIFFNESS. A
   *  hit therefore makes the disc visibly recoil and settle, and because the recoil is applied to
   *  this number and not to a separate "visual scale", the invariant above survives intact: the
   *  circle you see is still the circle that collides and the circle you can click. */
  r: number;
  /** What `worth` says this fighter should be, right now. `r` converges on it. */
  rTarget: number;
  /** Rate of change of `r`, px/s — the spring's state, and where a hit's flinch is injected. */
  rVel: number;
  /** The radius this fighter entered at. Drawn as a hairline ghost ring, so a mauled fighter reads
   *  as diminished — a small disc inside the outline of the size it used to be — rather than just
   *  as a small disc. */
  r0: number;

  /** Radius of the AT-RISK portion (`hp`) inside the disc, or 0 when it wouldn't read. Everything
   *  outside it is banked and safe — the tension `extract()` exists to resolve, drawn. */
  rRisk: number;
  /** `rRisk / r`, held separately so the at-risk boundary follows the disc through every frame of a
   *  flinch instead of being recomputed only when the fight state moves. Zero when the boundary
   *  would say nothing — see RISK_BAND. */
  riskShare: number;

  // Mirrored from the replay's shadow state each frame; the painter reads them from here so it
  // never needs to know that a shadow-fight exists.
  hp: bigint;
  banked: bigint;
  /** `hp + banked` — what the fighter is worth, and what its size means. */
  worth: bigint;
  dead: boolean;
  /** When this fighter left the field, on the loop's rAF clock — `NOT_DEAD` while it is still in, and
   *  `-Infinity` for one that was ALREADY out when the canvas first saw it (a mount into a fight in
   *  progress, or a stream recomputed around an extraction).
   *
   *  Two consumers, and the distinction between "just died" and "was already dead" is load-bearing
   *  for both: `arenaLoop` fires the death mark on the frame this is stamped, and `draw.ts` holds the
   *  corpse's outline at full ink for a moment afterwards. Without the sentinel, a page opened
   *  halfway through a round would detonate every corpse on the field in its first frame. */
  deadAtMs: number;
}

export interface ArenaField {
  w: number;
  h: number;
  /** Everything sized in px scales by this, so the field looks the same shape at any parent size
   *  instead of turning into a sparse scatter of dots on a large screen. */
  unit: number;
  /** The stake a `baseRadius` circle represents — see `computeRefStake`. */
  refStake: bigint;
  bodies: ArenaBody[];
  /** How far apart fighters try to stay, in px — see `computeSpacing`. */
  spacing: number;
  /** Radius of a fighter holding exactly `refStake` — see `BASE_RADIUS_SHARE`. */
  baseRadius: number;
  /** `bodies` indexed by `FighterView.id`. Steering resolves a target id every frame for every
   *  fighter; a linear scan would make that O(n²) for no reason, and the ids are dense array
   *  indices by contract anyway. Sparse only if a caller ever violates that contract. */
  byId: (ArenaBody | undefined)[];
  /** THE FERVOUR RAMP — `k = 1 + FERVOUR_GAIN · fervour`, the multiplier the fight's own progress puts
   *  on every acceleration and every speed cap in the steering. `FERVOUR_GAIN` carries the argument
   *  for what it scales and, far more importantly, for what it must not.
   *
   *  ITS NEUTRAL VALUE IS 1, NOT 0. A zero here multiplies every acceleration in the file by nothing
   *  and the field stands still, so every path that produces an `ArenaField` has to leave a usable
   *  number in it. `createField` is the only such path — `resizeField` mutates an existing field in
   *  place and cannot invalidate this — and it sets 1, which is also the right value for the settling
   *  passes it runs before it returns: laying out spawn overlaps is not a moment in a fight.
   *
   *  WHY IT IS STATE ON THE STRUCT RATHER THAN AN ARGUMENT. `stepField` receives `fervour` and could
   *  hand the ramp down, but three of the four things that need it are not on that call path.
   *  `spread()` and `recentre()` are module functions taking `(field, …)`, and `recoil()` is called
   *  from `arenaLoop` off the EVENT STREAM — its subject is a hit that just landed, not the passage
   *  of time, and it has no step in scope to have been given anything by. Threading a parameter
   *  through four signatures to carry one number that is constant for the whole frame buys nothing
   *  over the mechanism the field already uses for exactly this: `unit`, `spacing` and `baseRadius`
   *  are all once-per-frame derived scalars read straight off the struct, and this is one more.
   *
   *  `recoil()` therefore reads the value the PREVIOUS frame's `stepField` stored, because arenaLoop
   *  crosses its events before it steps. The ramp moves by `FERVOUR_GAIN · (frame / fight length)`,
   *  which is a quarter of one percent per frame even over a ten-second duel, so a blow is scaled by
   *  a temperature one frame stale. That is well inside the noise and not worth a second assignment
   *  to keep in step. */
  fervourRamp: number;
}

/** Radius of a fighter holding exactly `refStake`, as a share of `sqrt(area / fighters)` — the side
 *  of the square each fighter would get if the field were divided evenly between them.
 *
 *  A FIXED base radius was the first attempt and it does not survive contact with the real range of
 *  inputs: the program's cap is sixteen fighters and its floor is two, so a constant size means
 *  sixteen circles cover eight times the ink two do. Screenshotted at both ends — a full table in a
 *  narrow panel was a solid mass of overlapping discs and unreadable stacked labels, while a duel in
 *  a wide one was two dots adrift in white. Tying it to the room each fighter actually has makes a
 *  duel large and a brawl compact, at every panel size, with no special cases.
 *
 *  LOWERED FROM 0.115, and it is not a taste change — it is the exact compensation for the steeper
 *  `RADIUS_EXPONENT` below. Total disc ink on the field is `Σ (worth/ref)^(2p)`; raising `p` from 0.5
 *  to 0.72 raises that by a measured 19% at nine fighters and 15% at sixteen (`sandbox` run over the
 *  fixture at both sizes), and 0.105 / 0.115 = 0.913 ≈ 1/√1.19 hands it straight back. The field is
 *  therefore no more crowded than it was; only the SPREAD between fighters has widened, which is the
 *  whole point of the change. */
const BASE_RADIUS_SHARE = 0.105;
/** …and the FLOOR must not be reachable by any geometry the shell can actually produce, or it
 *  quietly repeals the rule above.
 *
 *  It was 11, and 11 binds in exactly one case: a phone. A 360x270 field carrying the program's
 *  sixteen gives `roomPerFighter` ≈ 78px, so the share wants 9.0 and the clamp hands back 11 — 22%
 *  more radius, 49% more area, on the one frame with the least paper to spare. A load test measured
 *  the consequence from the other end: at sixteen on a phone the fighters' labels came to 2.5x the
 *  total area of the discs they annotate. That number is not itself the fault (labels are fixed-size
 *  by design — see draw.ts's LABEL_H), but a floor inflating disc ink by half on the frame where the
 *  labels have nowhere to go is the field taking room from the labels and giving it to nothing.
 *
 *  So the floor gives, not the invariant. The invariant is load-bearing — it is what makes a duel
 *  large and a brawl compact at every panel size WITH NO SPECIAL CASES, and a clamp that fires on
 *  one real device is a special case wearing a constant's clothes.
 *
 *  8 rather than 0 because a floor is still wanted for degenerate geometry, and 8 is a number with a
 *  reason: `draw.ts`'s FACE_MIN_RADIUS is 6.5, so at 8 a fighter of MEDIAN worth still carries its
 *  coin's artwork at every size the shell can render. Below that the median fighter would fall back
 *  to a flat disc and the field would lose the "a fighter is its coin" reading wholesale, which is a
 *  far worse trade than a crowded phone. It binds only under ~350x260 at sixteen — narrower than any
 *  phone this page targets. */
const BASE_RADIUS_RANGE = [8, 48] as const;

/** HOW STEEPLY SIZE ANSWERS TO WORTH — `radius ∝ (worth / refStake) ^ p`. The single most consequential
 *  number in this directory, and it was 0.5.
 *
 *  WHY 0.5 WAS DEFENSIBLE AND IS STILL WRONG HERE. `p = 0.5` makes AREA exactly proportional to value,
 *  which is the textbook encoding and the one the previous note here argued for. Two things undo it.
 *
 *    1. THE EYE DOES NOT READ AREA LINEARLY. Flannery measured perceived magnitude of a circle at
 *       about `area^0.87`, so a disc drawn with area exactly proportional to value is systematically
 *       UNDER-read. The cartographic compensation for that is `p = 0.5 / 0.87 ≈ 0.575`, and it is the
 *       floor of what is defensible here rather than the target.
 *    2. THIS IS A CHANGE DISPLAY, NOT A PROPORTIONAL-SYMBOL MAP. Nobody estimates dollars off these
 *       circles — the label under the disc, the hover readout, the roster below the frame and the
 *       ghost ring all carry the figure exactly. What the disc is for is RANK and MOMENTUM: bigger or
 *       smaller than a moment ago, bigger or smaller than the fighter next to it. The sensitivity of
 *       that reading is `d(radius) / d(log worth) = p·r`, so `p` IS the dial, and 0.5 sets it to
 *       about the least sensitive value any monotone power law can reasonably use.
 *
 *  AND THE FIGHT NEEDS THE SENSITIVITY, measured rather than asserted. Damage is
 *  `min(ring_a, ring_d) * roll / 100`, which is deliberately size-neutral and low-churn, and it shows:
 *  over the nine-fighter fixture the median hit moves a defender's radius by 0.03% and the 90th
 *  percentile by 1.9%. Worse, it is all front-loaded — 50% of ALL the size movement in a 94-second
 *  fight is done by t=3s and 90% of it by t=19s. At `p = 0.5` the fight's biggest winner ends 31%
 *  larger than it entered and its biggest loser 30% smaller, and the field is then frozen to two
 *  decimal places for the last seventy seconds. At 0.72 the same fight, the same numbers, the same
 *  seed reads +48% / −40%: the difference between "that fighter got smaller" and "that fighter got
 *  taken apart".
 *
 *  WHY NOT FURTHER. Past ~0.8 the fixture's own range punches through MAX_SCALE at nine fighters, so
 *  the whale clamps and the honesty is repealed at exactly the end where the drama is. 0.72 keeps the
 *  whole of the fixture's range inside the band at 9 and at 16.
 *
 *  WHAT IT COSTS, also measured: total disc ink at entry rises 19% (n=9) / 15% (n=16), which
 *  BASE_RADIUS_SHARE gives back above; and ink GROWTH across the fight — the field getting heavier as
 *  wealth concentrates — is 7% / 4%, so a late field is no more crowded than an early one.
 *
 *  Strictly monotonic in `worth`, which is the one property that must not be traded for any of this:
 *  a bigger disc always means more money, at every point of the range and at both clamps. */
const RADIUS_EXPONENT = 0.72;
/** The ceiling on that scale. Raised from 2.1 alongside the exponent so the same real spread that fit
 *  before still fits: `2.4 * 0.105` is `2.1 * 0.115` to within a percent, so the LARGEST disc this
 *  field can draw is the same size it always was, and no existing geometry that was tuned against it
 *  (scoreboard.ts's SHARE_SEPARATOR, which is sized to survive being stood on by the widest possible
 *  fighter) moves underneath it. */
const MAX_SCALE = 2.4;
/** …and the floor is now in PIXELS rather than in scale, which is both more honest and more brutal.
 *
 *  A scale floor was the wrong shape for the job it was doing. Its stated purpose was that "a nearly
 *  dead fighter becomes a subpixel dot with a label floating over nothing" — a claim about PIXELS —
 *  but 0.32 of a base radius is a different number of pixels on every panel, and it bound where it
 *  had no business binding: at sixteen fighters the fixture's smallest fighter is already under it at
 *  the old exponent, so the field's most beaten-up players stopped shrinking and the routs the game
 *  produces were being drawn as stalemates.
 *
 *  4px is what the smallest disc actually has to be. `bodyAt` allows 4px of slop, so a 4px fighter is
 *  still comfortably clickable; `draw.ts`'s FACE_MIN_RADIUS already drops the artwork below 6.5 and
 *  falls back to a flat disc in the side colour, which is legible at 4; and a name over a 4px dot is
 *  unambiguous because nothing else is near it. Below the median it now simply keeps shrinking, all
 *  the way down, which is what a fighter being emptied out looks like. */
const MIN_RADIUS = 4;

/** How many relaxation passes `buildField` runs before the first paint, to settle the overlaps a
 *  deterministic spawn deterministically produces.
 *
 *  A RENDERING BUDGET, NOT A COUNT OF FIGHTERS, and it is named here because it used to be a bare
 *  `16` inline — the same number `MAX_FIGHTERS` happened to be at the time, which made it read like a
 *  per-fighter pass and it never was. It is one-shot and off the frame path (`separate` is O(n²), so
 *  even a full board is ~37k pair checks once, at spawn), so its cost is not what bounds it.
 *
 *  IT IS UNVALIDATED ABOVE SIXTEEN BODIES. The value was chosen when that was the whole board; a
 *  fuller field starts with more overlaps and may want more passes to clear them. Left alone on
 *  purpose — whether a 48-disc spawn actually settles is something you can only answer by looking at
 *  it, and sizing the canvas for 48 is a separate piece of work. This comment is here so that work
 *  finds the knob instead of rediscovering the literal. */
const SPAWN_SETTLE_PASSES = 16;

// Motion, all in px/s (or px/s²) per `unit`.

/** THE ROUND HAS TO BUILD, and this is the one thing `web/index.html` had that this field did not.
 *
 *  The reference's physics step (line 947) opens with
 *
 *  ```js
 *  const ramp = 1 + 1.6 * (w.roundT / BATTLE_MS);
 *  ```
 *
 *  and then multiplies BOTH `COMBAT.accel` and the max-speed cap by it, for every fighter, on every
 *  frame — 1.0 at the bell, 2.6 at the end of the round. Everything ELSE that made that field feel
 *  violent, this one already has and has better: active pursuit, mass-weighted elastic collision, a
 *  contact knock, anticipation and lunge, a recoil scaled by the chain's own dice. What it did not
 *  have was a TEMPERATURE THAT CHANGES. It opened at the pace it closed at, and a fight that never
 *  accelerates has no last round.
 *
 *  1.6 is the reference's own figure, kept rather than re-derived, because the quantity it is a gain
 *  on is the same quantity: a share of the round, running 0 to 1. `stepField`'s caller computes that
 *  share as the playhead over the LAST EVENT'S step — the exact analogue of `roundT / BATTLE_MS` on
 *  the axis this canvas actually has, which is the chain's, not a wall clock's. See arenaLoop.
 *
 *  WHAT `k = 1 + FERVOUR_GAIN * fervour` SCALES, and the split IS the design:
 *
 *    SCALED — every ACCELERATION and every SPEED CAP in the steering. `SEEK_ACCEL`, `MAX_SPEED`,
 *      `APPROACH_SPEED`, `WINDUP_ACCEL`, `LUNGE_ACCEL`, `LUNGE_SPEED`, `CONTACT_KNOCK`,
 *      `SPREAD_ACCEL`, `RECENTRE_MAX_ACCEL`, and `HIT_RECOIL` in `recoil()`.
 *    NOT SCALED — every RATE or FREQUENCY: `SPEED_BLEED`, `WANDER_LERP`, `REST_DECAY`,
 *      `RECENTRE_GAIN`, `RECENTRE_DAMP`, `RADIUS_STIFFNESS`, `RADIUS_DAMPING`, `FLINCH_SPEED`,
 *      `STANDOFF_DRIFT`. And every GEOMETRIC one: `STANDOFF_GAP`, `APPROACH_RADIUS`,
 *      `PERSONAL_SPACE`, `SPACING_SHARE`, `SPACING_MAX_SHARE`, the radii, the walls, `LABEL_SPACE`.
 *      A ramp on a distance would move the field's furniture as the fight went on; a ramp on a
 *      frequency would change how the field BEHAVES rather than how fast it travels.
 *    LEFT ALONE — `WANDER_SPEED` and `CALM_SPEED`, the idle and lobby drift. Those are not part of a
 *      fight at all, and the lobby is documented above as deliberately almost still.
 *
 *  WHY THAT EXACT SPLIT IS SAFE TO DO TO A COMPOSITION THAT WAS TUNED BY MEASUREMENT. Because this
 *  file's two most carefully argued invariants are RATIOS rather than absolutes, and a common factor
 *  leaves a ratio alone.
 *
 *    - `SPREAD_ACCEL`'s note is that it has to WIN against `SEEK_ACCEL` or the whole table collapses
 *      into one vibrating knot. It says in as many words that it "is a RATIO and not an absolute",
 *      and records being raised 250 → 395 in lockstep when the seek went 190 → 300. Scaling both by
 *      the same `k` holds 395/300 exactly at every value of `fervour` — and the equilibrium spacing,
 *      the separation at which the linear falloff `SPREAD_ACCEL·(range−d)/range` balances
 *      `SEEK_ACCEL`, depends on that ratio and on nothing else. It is therefore unchanged at every
 *      temperature, and the knot provably cannot come back.
 *    - `RECENTRE_*` is a PD controller carrying a measured table (centroid sd 4.3% of the field
 *      width, never once more than 15% off centre) and the standing requirement that "a controller
 *      has to be able to out-run the thing it is correcting". Its GAIN and DAMP are frequency terms —
 *      between them they set the loop's `ωn = √GAIN` and `ζ = DAMP / (2·√GAIN)` — so scaling those
 *      would change the loop's character and retire that table. Its CAP is something else entirely:
 *      an authority limit, against a disturbance whose velocity is now `k` times larger. So the cap,
 *      and only the cap, scales with `k`. ωn and ζ are identical at every fervour, the recovery has
 *      the same shape and the same duration it was measured to have, and it keeps the authority to
 *      apply it to a crowd moving 2.6x faster.
 *    - And the field's AGILITY IN SECONDS does not move either: time to reach a cap is `cap / accel`,
 *      and both ends of that scale by `k`. Nothing takes longer to turn, to close, or to settle.
 *      Everything simply travels faster, which is the only thing being asked for.
 *
 *  WHAT IT ACTUALLY MEASURES AS, driven end to end — the fixture lineup, a real seeded `runFullFight`
 *  stream, the real `createTargetTracker`, a recoil on every crossed event, at 60fps for the whole
 *  fight — because none of the above is worth anything asserted. EIGHT SEEDS PER ROW, averaged; the
 *  first version of this table was one seed and it published a badly wrong figure for two fighters
 *  (see the caveat below), which is a mistake worth leaving the evidence of rather than quietly
 *  correcting. Left column is HEAD, right is this file, so it carries `RECOIL_REACH` and the confined
 *  aim point as well — neither of which moves the speed column by a measurable amount:
 *
 *  ```text
 *  lineup / panel     mean speed px/s   centroid sd (% of width)   frames >15% off centre
 *   9 @ 1390x781        210 →  358          3.7% → 4.4%                  3% →  5%
 *  16 @ 1390x781        217 →  358          2.1% → 3.5%                  0% →  3%
 *   2 @ 1390x781        216 →  425          9.4% → 9.9%                 66% → 58%
 *  16 @  360x270         81 →  135          3.1% → 3.7%                  1% →  3%
 *  ```
 *
 *  The mean of `k` across a fight is 1.8, and the measured speed ratios are 1.70 / 1.65 / 1.97 / 1.67
 *  — the ramp is doing precisely and only what it says on the tin. No run at any size produced a NaN,
 *  a body outside the walls, or a body pinned to a wall with its velocity still pointing into it.
 *
 *  TWO FIGHTERS IS A DIFFERENT MEASUREMENT AND THE COLUMN SHOULD NOT BE READ ACROSS THAT ROW. At a
 *  full table the centroid is an average over nine or sixteen bodies and the individual duels cancel;
 *  at two, THE CENTROID IS THE DUELLING PAIR, so `recentre` is measuring the very thing it is trying
 *  to move and has no crowd to average against. The pair therefore fights wherever it happens to
 *  meet — two thirds of the fight more than 15% off centre, at HEAD and here alike — and the seed
 *  decides which. That is not a controller failure and must not be retuned as one: at nine and
 *  sixteen the same controller holds 4.4% and 3.5%, and the n=2 figure actually IMPROVES here
 *  (66% → 58%). It is a two-body system being reported with a statistic built for a crowd.
 *
 *  AND THE HONEST COST, since the centroid column is not free: the crowd runs LOOSER at temperature.
 *  Mean separation between non-duelling pairs goes from 1.34 to 1.74 spacings between fervour 0 and 1,
 *  and the PD controller spends slightly more of the fight recovering. That is the safe direction of
 *  error — the failure this file has actually been burned by is the knot, the crowd collapsing into
 *  one vibrating mass, and more energy at a fixed spread/seek ratio can only push away from it. The
 *  cause is that the approach brake's authority is a RATE (`SPEED_BLEED`) while the distance overshot
 *  before it takes hold is a speed over that rate: the brake holds its 150ms and the overshoot grows
 *  with `k`. That is the correct trade — scaling the bleed would repeal the recoil's follow-through,
 *  which is the one thing this whole change exists to put on screen. */
const FERVOUR_GAIN = 1.6;

/** RAISED FROM 190 / 135. The old pair produced a field of circles CONVERGING — a smooth glide toward
 *  a standoff point, at a speed that never changed. Nothing about it read as two fighters closing on
 *  each other, because closing is an acceleration and this was a drift. The reference this design is
 *  preserving (`web/index.html`) is much more violent than that, and the whole of the motion here is
 *  cosmetic — `run_fight()` picked every pair by hash before the first frame — so there is no
 *  correctness left to spend and it should all go on the charge. */
const SEEK_ACCEL = 300;
const MAX_SPEED = 210;
/** Inside this radius of the standoff point, cap the speed hard: the pair should visibly MEET and
 *  linger around the moment their event fires, not overshoot and orbit.
 *
 *  TIGHTENED FROM 110/42. That radius was over half the standoff distance on a desktop panel, so a
 *  fighter spent most of its approach already inside the brake and the "charge" was a crawl with a
 *  faster first second. The brake still exists and still does its job — a pair that sails through
 *  each other is two circles that never met — but it now applies only in the last stride, and the
 *  lunge below is explicitly exempt from it. */
const APPROACH_RADIUS = 60;
const APPROACH_SPEED = 66;
/** How fast speed ABOVE the cap bleeds away, as a fraction per second — see the soft cap in
 *  `stepField`. 6/s leaves a recoil visible for about 150ms, which is roughly nine frames and about
 *  as long as a thrown fighter should still be visibly travelling before the seek takes over again. */
const SPEED_BLEED = 6;
/** A fighter steers to a point BESIDE its target, not to its centre.
 *
 *  Steering at the centre makes every fighter try to occupy the same coordinate as its opponent, and
 *  with a dozen of them and hash-picked pairs the whole table collapses into one vibrating knot in
 *  the middle of the field — verified in a browser, and the reason two thirds of the arena was empty
 *  while every label overlapped. Aiming just outside contact instead lets pairs actually pair off:
 *  they close, sit alongside each other for the duration of the duel, and the field stays spread.
 *  The angle drifts slowly and is offset per id by the golden angle, so a duel rotates rather than
 *  freezing into a diagram, and two attackers on the same defender approach from different sides. */
const STANDOFF_GAP = 22;
const STANDOFF_DRIFT = 0.35;
/** Idle drift while a fighter has no event in the lookahead window. */
const WANDER_SPEED = 30;
/** Lobby/Drawing. Deliberately almost still: an empty pre-fight arena should read as composed and
 *  waiting, not as a screensaver. */
const CALM_SPEED = 8;
/** How fast velocity converges on the idle target. A fighter leaving combat eases out of it. */
const WANDER_LERP = 2.6;
/** Settled, and dead bodies at any time: exponential decay to a standstill. */
const REST_DECAY = 3.2;
/** THE WALL IS NOT A BRAKE. It was 0.9, and 0.9 was a second, undocumented governor sitting in the
 *  same path as the documented one.
 *
 *  Speed in this field is decided deliberately and in exactly one place: the soft cap in `stepField`,
 *  which BLEEDS excess velocity off at `SPEED_BLEED` rather than clipping it, precisely so that a
 *  `recoil()` above cruising speed plays out over ~150ms instead of being deleted on the next frame.
 *  A restitution of 0.9 takes a tenth of a fighter's speed at every bounce, and the velocity it takes
 *  it off is exactly the thrown-fighter velocity the soft cap exists to preserve — so a hit that
 *  launched somebody into a wall lost its follow-through at the one moment it was most visible. At 1
 *  the wall reflects and the soft cap alone says how fast anyone is travelling a moment later: one
 *  mechanism instead of two disagreeing about the same number.
 *
 *  It is also what the reference did — `web/index.html` line 954 is `p.vx = Math.abs(p.vx)`,
 *  restitution exactly 1 — and that ricochet is part of why its field never settled.
 *
 *  1 CANNOT TRAP A BODY, and that is a property of `clampToWalls`'s SHAPE rather than of this value:
 *  the position is hard-pinned to the contact point BEFORE the velocity is touched, and the velocity
 *  is then rebuilt as `±Math.abs(...)` — a sign forced to point off the wall. Restitution scales a
 *  magnitude and can never restore a sign, so the next integration can only carry the body inward.
 *  The same holds in the repeat case, a disc whose radius spring GROWS it into a wall it is already
 *  pinned against: the clamp fires again, re-pins, and re-reflects an outward velocity, which at 1 is
 *  a no-op — where at 0.9 it was a fighter being braked once per frame for the crime of getting
 *  richer. */
const WALL_RESTITUTION = 1;
/** Extra push applied along the contact normal when two live circles touch, so a crowd keeps
 *  breathing instead of packing into a solid mass. `web/index.html`'s `COMBAT.knock`, and it has to
 *  be a real fraction of `MAX_SPEED` to do anything against a seek force pulling twelve fighters at
 *  the same point — at a tenth of it the field simply fused into one knot. */
const CONTACT_KNOCK = 105;
/** The kick a LANDED HIT gives the pair, on top of the contact knock. Fired from the event stream,
 *  not from the collision, so a hit visibly throws two fighters apart — the clearest possible
 *  reading of "that just happened", and at the chain's pace of ~n hits a second it lands often
 *  enough to keep a melee from settling into a static huddle. Applied only while the pair is
 *  genuinely touching, so it is a recoil and not a permanent outward wind.
 *
 *  IT IS NOW A TOTAL IMPULSE SPLIT BY MASS rather than a fixed velocity handed to each party, which
 *  is what makes a big fighter hitting a small one THROW it. See `recoil`. The number roughly doubled
 *  because half of it now goes to the attacker's recoil in the equal-mass case, where before the
 *  attacker got an unrelated 0.5x of the defender's kick out of thin air. */
const HIT_RECOIL = 300;
/** …and it is scaled by the blow. `impact.ts`'s `hitForce` recovers the chain's own `roll ∈ [4, 27]`
 *  from the published damage, so a light blow nudges and a heavy one launches — a ~4x spread that
 *  the chain has always published and this canvas has never drawn. Floored well above zero: even the
 *  weakest roll is a fighter being hit and has to move them. */
const RECOIL_FORCE = [0.4, 1.5] as const;
/** HOW FAR APART A PAIR MAY BE, over and above their two radii, AND STILL BE THROWN BY A HIT — and
 *  the fact that it is derived from `STANDOFF_GAP` rather than picked is the entire point of it.
 *
 *  IT WAS A LITERAL `6`, AND THAT LITERAL WAS A BUG that had quietly disabled most of the violence in
 *  this file. `HIT_RECOIL`'s note above claims the kick "lands often enough to keep a melee from
 *  settling into a static huddle", at the chain's pace of ~n hits a second. It did not. Measured over
 *  the fixture's own seeded stream at nine and at sixteen fighters, `recoil` fired on ONE TO TWO PER
 *  CENT of hits — about one throw every fifteen seconds of a hundred-second fight — and the rate was
 *  identical before and after the fervour ramp, so this was never a consequence of the new speeds.
 *
 *  The cause is two constants that have to agree and never did. The steering parks a pair at
 *  `STANDOFF_GAP * unit` edge to edge — that is what `STANDOFF_GAP` IS, the distance a duel is held
 *  at, 22 units — and then the recoil refused to fire beyond 6. A pair sitting exactly where the
 *  steering had put it was three and a half times outside the window that would let a hit move it, so
 *  the throw could only land in the fraction of a second a lunge or a collision had closed the gap.
 *  `flinch()` has no such guard and fires on every hit, which is why the game still read as landing
 *  blows at all: the disc compressed, the ring drew, the figure rose, and the two fighters stood
 *  perfectly still while it happened.
 *
 *  1.5 x `STANDOFF_GAP` admits a pair anywhere up to half again past its parking distance, which
 *  covers both the orbit — `STANDOFF_DRIFT` rotates the aim point, so a fighter circles its station
 *  rather than sitting on it — and the radius spring's overshoot on a fighter that has just been paid.
 *  It cannot start throwing fighters who merely happen to be near each other: `spread()` holds
 *  non-duelling bodies at `SPACING_SHARE * sqrt(area / n)`, which at sixteen fighters on a desktop
 *  panel is 221px against this window's 46px. (Those two have to be compared in the SAME quantity —
 *  `spacing` is already pixels, while this constant is in `unit`s and is multiplied by `field.unit`
 *  at the call site, so the margin is 4.8x rather than the 6.7x that comparing 221 to 33 suggests.
 *  Measured non-duelling separation runs 1.9 to 2.3 spacings, so the margin in practice is about ten
 *  times.) The pairs this reaches are the pairs the steering deliberately brought together, which is
 *  exactly the set `HIT_RECOIL` was written for.
 *
 *  AND NOW THE PART THAT MATTERS, because the bug this fixes was created by a comment asserting a
 *  frequency nobody had measured, and this note is not going to repeat that. What the change bought,
 *  on the same seeded fixture runs, is FOUR TO SIX TIMES THE RATE AND NOT A CURE:
 *
 *  ```text
 *  reach          9 fighters   16 fighters   2 fighters
 *   6 units (was)     1.8%          1.0%         5.9%
 *  33 units (this)    9.8%          5.5%        22.2%
 *  66 units           19.0%        12.6%        48.4%
 *  ```
 *
 *  `RECOIL_REACH` is a SHALLOW LEVER, because the gap was only half the diagnosis: THE PAIR USUALLY
 *  HAS NOT ARRIVED YET. 73% of hits at nine fighters and 61% at sixteen land on a pair the tracker
 *  has genuinely committed to each other — the steering is chasing the right people — but the median
 *  gap between those committed fighters at the instant their blow lands is 169 units at nine and 203
 *  at sixteen, against a parking distance of 22. They are still crossing the field when the chain
 *  resolves them. `DWELL_MS` is 1.6s and a commitment expires and re-picks before the crossing
 *  finishes, so most blows are struck between two fighters who really are nowhere near each other,
 *  and no window short of "always" would catch them: 50% would take ~200 units of reach, which is a
 *  seventh of the arena's width and would repeal this guard's entire purpose — precisely the failure
 *  `recoil()`'s own note warns about, two fighters at opposite ends leaping apart for a reason
 *  nothing on screen explains.
 *
 *  So this is the honest half of the fix. It is worth having and it is safe — across six reach values
 *  at four lineup/panel combinations, no arm produced a NaN, a body outside the walls, or a body held
 *  against one, and speed, centroid and separation are unmoved at 1.5x. The other four fifths are not
 *  in this file: they are `targeting.ts`'s dwell and lookahead, i.e. how long a fighter is given to
 *  arrive. Do not chase it by raising `HIT_RECOIL` instead — that constant was tuned to be visible
 *  when it fires, and it is about to fire five times as often for the first time. */
const RECOIL_REACH = STANDOFF_GAP * 1.5;
/** PERSONAL SPACE. Every fighter is attracted to some other fighter and nothing pushes the field
 *  apart at range, so a table converges on one tight knot in the middle and leaves two thirds of the
 *  arena white — verified in a browser at three different points of a fight before this existed.
 *
 *  A soft outward accel between any two fighters closer than this multiple of their combined radii,
 *  falling off linearly to nothing at the edge of it, spreads duels across the field without ever
 *  preventing one: the pair actually fighting each other is exempt, so they still meet and touch. */
const PERSONAL_SPACE = 2.4;
/** …and it has to be able to WIN against the seek, or the crowd's size is set by the pursuit graph
 *  instead of by the field. It was 150 against a `SEEK_ACCEL` of 190, and EVERY fighter is seeking
 *  somebody: hash-picked pairs put two or three attackers on one defender most of the time, and a
 *  hub like that contracts harder than a linear falloff can hold open. Two late fixture frames, nine
 *  fighters, 1440x950: the entire field of play was a 570x410 knot in one and a 430x555 column in the
 *  other, inside a 1,390x781 canvas — under a fifth of the paper, both outer thirds white, which is
 *  the "bunched into the upper middle" the redesign was called in for.
 *
 *  RAISED FROM 250 IN LOCKSTEP WITH `SEEK_ACCEL`, which went 190 → 300. This constant's whole job is
 *  described above as being able to WIN against the seek, so it is a RATIO and not an absolute: at
 *  250 against a seek of 300 the knot this was written to prevent comes straight back. 395 holds
 *  250/190 exactly. */
const SPREAD_ACCEL = 395;
/** …but a multiple of the RADII alone only spaces fighters relative to each other, which leaves a
 *  dozen well-spaced circles occupying one corner of a wide arena and the other two thirds blank —
 *  the second thing the screenshots showed, after the knot itself.
 *
 *  So personal space is also floored at a share of the ROOM AVAILABLE: `sqrt(area / fighters)` is the
 *  side of the square each fighter would get if the field were divided evenly between them.
 *
 *  RAISED FROM 0.55, which was the arithmetic error underneath the whole complaint. That quantity is
 *  the side of the cell each fighter owns, so centres one WHOLE cell apart is what tiles the field;
 *  0.55 of it aims the crowd at 30% of the area it was given and then the seek eats into even that.
 *  A hexagonal packing at spacing `s` covers `n·s²·√3/2`, so 0.85 targets about 63% of the field —
 *  a crowd that reaches into all four corners while keeping a margin, at 9 fighters and at 16 alike.
 *
 *  CAPPED against the short side, because the share alone diverges as the field empties: two fighters
 *  in a desktop panel work out to 700-odd px of personal space, which is not a duel with room around
 *  it, it is one fighter per wall with the whole arena between them and nothing in it. The cap binds
 *  only below about six fighters, which is exactly the range where "fill the field" stops being the
 *  thing a viewer wants. */
const SPACING_SHARE = 0.85;
const SPACING_MAX_SHARE = 0.42;
/** …and personal space still only says how far apart fighters stand, not WHERE they stand. Because
 *  every fighter is seeking another one, the crowd behaves like a body with its own centre of mass,
 *  and that centre wanders — it drifts into whichever corner the last few duels happened in and
 *  parks there, leaving a third of the arena blank while the fight plays out off to one side.
 *
 *  This nudges the CENTROID toward the middle of the field, applying the identical acceleration to
 *  every fighter. A uniform translation changes nothing about the crowd's internal structure: it
 *  doesn't compress the melee, doesn't override a duel, doesn't make anyone converge — it just keeps
 *  the composition framed. Capped so it is always a drift, never a current.
 *
 *  THE GAIN WENT 0.5 → 2 AND THE CAP 60 → 200, because a controller has to be able to out-run the
 *  thing it is correcting and this one no longer could. Everything about the motion above got faster
 *  — the seek by 1.6x, the recoil by more, and a lunge briefly exceeds all of it — so the crowd can
 *  now put itself a third of the field off centre in a second, and at a gain of 0.5 the correction
 *  took most of ten. Measured over the nine-fighter fixture, in the centroid's distance from the
 *  middle (0% is perfectly framed):
 *
 *  ```text
 *  gain/cap        centroid sd    off centre by >15% of the width
 *  0.5 / 60        15.4%          29% of the fight     <- the new motion, old controller
 *  0.5 / 200       12.0%          24%                  <- authority alone does not fix it
 *  2.0 / 200        4.3%           0%                  <- this, and better than the old field ever was
 *  ```
 *
 *  The old field measured 5.8% / 0% at its much lower energy, so this is not "as good as before" —
 *  the composition is now held tighter than it was AND the fight is twice as violent. */
const RECENTRE_GAIN = 2;
const RECENTRE_MAX_ACCEL = 200;
/** …AND IT HAS TO BE DAMPED, which it was not, and the omission only started to show once the field
 *  got fast.
 *
 *  A gain against a position error and nothing else is a spring with no dashpot: it does not settle
 *  the crowd on the middle, it swings the crowd THROUGH the middle and back. At the old speeds the
 *  swing was small enough to read as drift — measured over the nine-fighter fixture, the centroid's
 *  standard deviation was 5.8% of the field width and it never once sat more than 15% off centre. At
 *  the new ones the same controller put it 15.4% out and off-centre by more than 15% for 29% of the
 *  fight, which is the composition visibly sliding into one half of the arena and back.
 *
 *  So the controller opposes the crowd's MEAN VELOCITY as well as its position — a PD controller
 *  rather than a P one. `2·√GAIN` is critical damping for this loop, which at a gain of 2 is 2.83;
 *  this sits at 0.9 of it, so the recovery is quick rather than sluggish and still does not ring. It
 *  costs one more accumulator in a sum the function was already taking, and like the position term it
 *  is applied identically to every fighter, so it still cannot compress the melee, override a duel or
 *  make anyone converge. */
const RECENTRE_DAMP = 2.55;
const MAX_DT = 1 / 30;

/** ANTICIPATION AND FOLLOW-THROUGH, which is the cheapest drama in animation and the one this field
 *  had none of.
 *
 *  The steering already knows who is about to fight whom — that is the whole premise of targeting.ts,
 *  which reads a couple of seconds ahead of the playhead so that when a hit lands it lands on two
 *  circles that are already touching. What it did NOT know was WHEN, so the approach was a uniform
 *  glide and the hit arrived at an arbitrary point in it. It now gets the lead time as well, and
 *  spends it the way an animator would:
 *
 *    WINDUP  from `WINDUP_MS` out to `LUNGE_MS`, a fighter accelerates AWAY from its target. It
 *            visibly rears back. This is what makes the strike read as a decision rather than as an
 *            arrival.
 *    LUNGE   inside `LUNGE_MS`, a hard acceleration toward it, exempt from the approach brake. The
 *            pair slams together, `separate()` resolves the overlap with an impulse, and `recoil()`
 *            throws them apart on the same frame the number appears.
 *
 *  Both are pure decoration and cannot alter a single figure: `run_fight()` picked every pair and
 *  every roll by `hash(seed, step)` before this canvas drew its first frame. If the lead time is
 *  unknown — no upcoming event names this fighter, or its committed target is not the one it is about
 *  to trade with — neither fires and the motion is exactly the ordinary seek.
 *
 *  120ms of lunge is about seven frames, which is where a strike stops reading as a teleport and
 *  starts reading as a movement; 300ms of windup is long enough to be seen and short enough that a
 *  fighter is never observably retreating from a fight it is winning. */
const WINDUP_MS = 300;
const LUNGE_MS = 120;
const WINDUP_ACCEL = 420;
const LUNGE_ACCEL = 1500;
const LUNGE_SPEED = 460;

/** THE DISC HAS MASS NOW, and the spring is where it lives. `r` chases `rTarget` instead of being
 *  assigned it.
 *
 *  Two things fall out of that, and the second is the reason it exists. The first is that a fighter's
 *  size changes with weight rather than by teleporting between two radii on the frame a poll lands.
 *  The second is that a spring has somewhere to put an IMPULSE — so a hit can make a disc physically
 *  recoil and settle, which is deformation, which is the only channel of violence left once gradients,
 *  glow and colour are all forbidden.
 *
 *  Tuned rather than picked: `ωn = √900 = 30 rad/s` puts the damped period at 250ms and
 *  `ζ = 33 / (2·30) = 0.55` gives a single ~13% overshoot that is gone inside half a second. Slacker
 *  than that and a fighter under fire wobbles like jelly, which is a texture this page cannot have;
 *  tighter and the flinch is not visible at all and the whole mechanism is dead weight.
 *
 *  It applies to `r` itself — the collider and the hit target — rather than to a separate drawn
 *  scale, precisely so field.ts's central invariant survives: one number, so the circle you see, the
 *  circle that collides and the circle you can click cannot disagree. */
const RADIUS_STIFFNESS = 900;
const RADIUS_DAMPING = 33;
/** How hard a hit compresses the disc it lands on, as radii per second at full force. At the spring
 *  above, an impulse of `3.2·r` peaks at about 12% of the radius — a flinch you can see at r=30 and
 *  cannot mistake for the fighter having actually lost that much. The attacker swells by a third as
 *  much, because taking money should read as a gain and not as a matching injury. */
const FLINCH_SPEED = 3.2;
const FLINCH_ATTACKER_SHARE = 0.34;
/** A DEATH IS THE SAME SPRING AT ITS CEILING. A fighter going out convulses once, hard, and the
 *  overshoot on the way back is what sells the ring as having been blown off it. */
const DEATH_FLINCH_SPEED = 6;

/** `deadAtMs` for a fighter still in the ring, and it is NEGATIVE on purpose.
 *
 *  It was `0`, which put the in-play sentinel inside the rAF clock's own domain — so `arenaLoop`'s
 *  `b.deadAtMs === rafMs` test would match every LIVING body on a frame with `rafMs === 0`. Nothing
 *  reaches that today (the only candidate is the first frame, and the first frame always rebuilds the
 *  field and is therefore `fresh`, so the death scan does not run), but that is a coincidence holding
 *  it up rather than a guard. A value the clock cannot produce costs nothing and needs no argument. */
const NOT_DEAD = -1;

export type MotionMode = "calm" | "active" | "rest";

/** What a `phase` means to the field. Settled deliberately brings everything to a halt: the fight is
 *  over, the numbers are final, and a field that keeps milling about says otherwise. */
export function motionModeFor(phase: string, fightStartedAtMs: number | null): MotionMode {
  if (phase === "Settled") return "rest";
  if (fightStartedAtMs === null) return "calm";
  return "active";
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function unitFor(w: number, h: number): number {
  return clamp(Math.min(w, h) / 560, 0.55, 2.4);
}

/** The side of the square each fighter would get if the field were divided evenly between them —
 *  the one quantity both the base radius and the spacing floor are derived from, so "how big" and
 *  "how far apart" can never disagree about how crowded the arena is. */
function roomPerFighter(w: number, h: number, count: number): number {
  return Math.sqrt((w * h) / Math.max(1, count));
}

function computeSpacing(w: number, h: number, count: number): number {
  if (count <= 1) return 0;
  return Math.min(roomPerFighter(w, h, count) * SPACING_SHARE, Math.min(w, h) * SPACING_MAX_SHARE);
}

function computeBaseRadius(w: number, h: number, count: number): number {
  return clamp(roomPerFighter(w, h, count) * BASE_RADIUS_SHARE, BASE_RADIUS_RANGE[0], BASE_RADIUS_RANGE[1]);
}

/** The MEDIAN stake, not the mean and not the max.
 *
 *  This number sets what "normal size" means on the field, so it decides whether the picture is
 *  readable. The max makes every non-whale a dot the moment one player deploys the $100 cap against
 *  a table of $5 entries; the mean is dragged by that same whale most of the way there. The median
 *  is the one that answers "bigger or smaller than the rest of this table?", which is the question
 *  a player is actually asking. */
function computeRefStake(fighters: FighterView[]): bigint {
  if (fighters.length === 0) return 1n;
  const sorted = fighters.map((f) => f.stake).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted[sorted.length >> 1];
  return mid > 0n ? mid : 1n;
}

/** SIZE IS **WORTH** — `hp + banked` — NOT `hp`.
 *
 *  This is the single most important line in the file, and it took a browser to find. In this
 *  program a raid does not compound in the ring the way `web/index.html`'s did: `applyHitEvent`
 *  moves the amount from the defender's `hp` straight into the attacker's `banked`, and nothing ever
 *  puts value back into `hp`. So `hp` is monotonically decreasing FOR EVERYONE, and a canvas that
 *  sizes on it shows a fight in which all sixteen fighters shrink toward nothing and the eventual
 *  winner is the smallest dot on the field. Screenshotted at step 3,572: four survivors holding the
 *  entire pot, drawn as specks inside enormous ghost rings.
 *
 *  `worth()` is what `contract.ts` itself calls "a fighter's total worth right now, which is what
 *  the winner is decided on", and it is the quantity that behaves the way the original game's
 *  circles did: raid the other side and you grow, get raided and you shrink.
 *
 *  The exponent is `RADIUS_EXPONENT` and its derivation is the long note up there — the short version
 *  is that it is between "area proportional to value" and "radius proportional to value", because
 *  what this field is read for is momentum rather than magnitude. */
export function radiusFor(value: bigint, refStake: bigint, baseRadius: number): number {
  if (value <= 0n) return MIN_RADIUS;
  const scale = Math.min(Math.pow(Number(value) / Number(refStake), RADIUS_EXPONENT), MAX_SCALE);
  // `max` and not a clamp: the floor is in pixels and the ceiling is in scale, and they are two
  // different arguments (see MIN_RADIUS / MAX_SCALE). Still strictly monotone in `value` — the max of
  // a monotone function and a constant is monotone.
  return Math.max(baseRadius * scale, MIN_RADIUS);
}

/** A stable pseudo-random in [0,1) from a string. Deterministic on purpose: the spawn layout must
 *  survive React StrictMode's double mount, a remount, and a hot reload without the whole field
 *  visibly reshuffling. Same wallet, same corner of the arena, every time. */
function hash01(text: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Side 0 takes the left third, side 1 the right — so before a single hit lands the two camps are
 *  already legible as camps. Presentation only; the program has no notion of a position. */
function spawn(body: ArenaBody, wallet: string, w: number, h: number): void {
  const rx = hash01(wallet, 0x9e37);
  const ry = hash01(wallet, 0x85eb);
  body.x = body.side === 0 ? w * (0.07 + rx * 0.31) : w * (0.62 + rx * 0.31);
  body.y = h * (0.1 + ry * 0.8);
  body.vx = 0;
  body.vy = 0;
}

/** `prev` carries positions and velocities across a lineup change, matched by wallet.
 *
 *  Without it, every entry that lands during a lobby would rebuild the field and snap every fighter
 *  already on it back to its spawn point — the arena visibly twitching each time somebody else
 *  deploys. `web/index.html` hit the same thing and fixed it the same way ("MERGE by id: keep
 *  existing circles where they drift, no teleporting on every join"). */
export function createField(
  fighters: FighterView[],
  w: number,
  h: number,
  prev?: ArenaField | null,
): ArenaField {
  const unit = unitFor(w, h);
  const baseRadius = computeBaseRadius(w, h, fighters.length);
  const refStake = computeRefStake(fighters);
  const carried = new Map<string, ArenaBody>();
  if (prev) for (const b of prev.bodies) carried.set(b.wallet, b);

  const bodies = fighters.map((f) => {
    const r = radiusFor(f.hp + f.banked, refStake, baseRadius);
    const body: ArenaBody = {
      id: f.id,
      wallet: f.wallet,
      side: f.side,
      name: f.name,
      isYou: f.isYou,
      avatarSrc: f.avatarSrc,
      stake: f.stake,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r,
      rTarget: r,
      rVel: 0,
      r0: radiusFor(f.stake, refStake, baseRadius),
      rRisk: 0,
      riskShare: 0,
      hp: f.hp,
      banked: f.banked,
      worth: f.hp + f.banked,
      dead: f.dead,
      // ALREADY OUT AT CONSTRUCTION IS NOT A DEATH. A field built around a fight in progress must not
      // announce every corpse it inherits — see `deadAtMs`.
      deadAtMs: f.dead ? -Infinity : NOT_DEAD,
    };
    const before = carried.get(f.wallet);
    if (before) {
      body.x = before.x;
      body.y = before.y;
      body.vx = before.vx;
      body.vy = before.vy;
      // Carry the spring too, or every entry landing in a lobby would snap the whole field's radii —
      // the same twitch this merge exists to prevent, one property along.
      body.r = before.dead === f.dead ? before.r : r;
      body.rVel = before.rVel;
      // ONLY WHEN THE CARRIED BODY WAS ALSO OUT. Carrying unconditionally overwrites the sentinel
      // set above with the live body's `NOT_DEAD`, so a fighter constructed as dead would be handed
      // a `deadAtMs` in the rAF clock's own range — and `draw.ts` would run a full death flash for a
      // corpse whose death is inherited history, which is the one thing the sentinel exists to stop.
      if (before.dead && f.dead) body.deadAtMs = before.deadAtMs;
    } else {
      spawn(body, f.wallet, w, h);
    }
    return body;
  });
  const byId: (ArenaBody | undefined)[] = [];
  for (const b of bodies) byId[b.id] = b;

  const field: ArenaField = {
    w,
    h,
    unit,
    refStake,
    spacing: computeSpacing(w, h, bodies.length),
    baseRadius,
    bodies,
    byId,
    // 1 IS THE NEUTRAL, AND IT IS NOT CARRIED FROM `prev`. The first `stepField` of the frame
    // overwrites it with the true ramp before anything in a fight reads it; the only consumer in
    // between is the settle loop below, and settling a spawn layout should run at the opening pace
    // however hot the round it is being rebuilt into happens to be. See `ArenaField.fervourRamp`.
    fervourRamp: 1,
  };
  // Deterministic spawn means deterministic overlaps. Settle them before the first paint so a lobby
  // never opens with two fighters fused together — `SPAWN_SETTLE_PASSES` of the same solver the loop
  // uses.
  for (let i = 0; i < SPAWN_SETTLE_PASSES; i++) separate(field);
  clampToWalls(field);
  return field;
}

/** DELIVER A LATE-ARRIVING AVATAR WITHOUT REBUILDING THE WORLD.
 *
 *  THE DEFECT THIS EXISTS TO FIX, because it is not obvious from either side alone. `createField` is
 *  the only thing that copies `avatarSrc` onto a body, and `arenaLoop`'s `ensureWorld` only calls it
 *  when `lineupChanged` says the CAST changed — same length, same ids, same wallets, same stakes,
 *  same `fightStartedAtMs` means the field stands. An avatar arriving changes none of those. So a
 *  link that resolves after the round is on screen reached the `FighterView`, reached the roster,
 *  reached every DOM surface, and never reached the canvas: the bodies kept the `null` they were
 *  built with and `faceFor` returned the side's coin forever. Both halves were individually correct
 *  and the feature did not work, which is the shape of every defect the e2e suite exists for.
 *
 *  AND IT IS THE NORMAL CASE, not an edge one. `useLinks` fetches, verifies and signs on a promise;
 *  the round is rendering long before that lands. "Link arrives mid-round" is not a scenario a
 *  player has to arrange, it is what happens on every page load.
 *
 *  WHY MUTATION, WHEN THE REST OF THIS FILE'S IDENTITY IS IMMUTABLE. The alternative is to widen
 *  `lineupChanged` so an avatar counts as a new cast, and that is much worse than it looks: the same
 *  branch also rebuilds the replay, resets `streamMark`, clears the impact FX still expanding from
 *  the last blow, and raises `fresh` — which suppresses the frame's death announcements. A fighter
 *  acquiring a face would drop a shockwave and swallow a death. The field itself would survive
 *  (`createField` carries position and the spring forward), but its siblings would not.
 *
 *  FREE ON THE FRAMES WHERE NOTHING CHANGED, which is all but a handful of them in the round's life.
 *  No allocation, no Map, no array: an id lookup and a string compare per fighter, and the compare
 *  is almost always between two references to the same value — `markLinkedFighters` returns its
 *  INPUT array untouched when nothing moved, so the `FighterView`s are the same objects too. The
 *  write only happens on the frame the link actually lands. Same discipline as `houseFighters.ts`
 *  and `linkFighters.ts`: do nothing at all in the common case.
 *
 *  REVOCATION TRAVELS THIS PATH TOO, and needs no branch of its own — an unlinked, suppressed or
 *  deleted account arrives as `avatarSrc: null`, the compare notices, and the fighter is back to its
 *  coin on the next frame. Every rung of `TWITTER-CONNECT.md` §7.3's ladder is one assignment.
 *
 *  BY `byId`, NOT BY POSITION. `ensureWorld` only calls this when `lineupChanged` is false, which
 *  does guarantee the two arrays line up — but leaning on that would make this function silently
 *  wrong if it were ever called anywhere else, and `byId` is the index the whole file already treats
 *  as the canonical id -> body map. A fighter with no body is skipped rather than assumed.
 *
 *  NOT A DUPLICATE OF `syncBodies`, though the names are deliberately siblings. That one pulls FIGHT
 *  STATE off the replay's shadow every frame and re-derives radii from it; this one pulls one
 *  IDENTITY field off the `FighterView`s on the frames where the world was not rebuilt. Different
 *  source, different cadence, different reason to exist — and merging them would put a
 *  `FighterView[]` parameter into the function whose whole doc is "the one place fight state enters
 *  the field". */
export function syncAvatars(field: ArenaField, fighters: readonly FighterView[]): void {
  for (const f of fighters) {
    const b = field.byId[f.id];
    if (b !== undefined && b.avatarSrc !== f.avatarSrc) b.avatarSrc = f.avatarSrc;
  }
}

/** Resize keeps the fight running: positions move proportionally and radii re-derive at the new
 *  scale. Respawning on every ResizeObserver callback would scatter the field every time a sidebar
 *  animated open. */
export function resizeField(field: ArenaField, w: number, h: number): void {
  const sx = field.w > 0 ? w / field.w : 1;
  const sy = field.h > 0 ? h / field.h : 1;
  field.w = w;
  field.h = h;
  field.unit = unitFor(w, h);
  field.spacing = computeSpacing(w, h, field.bodies.length);
  field.baseRadius = computeBaseRadius(w, h, field.bodies.length);
  for (const b of field.bodies) {
    b.x *= sx;
    b.y *= sy;
    // SNAP. A resize is not an event in the fight, and easing every radius across a new base scale
    // would have the whole field breathing every time a sidebar animated open.
    sizeBody(field, b, true);
    b.r0 = radiusFor(b.stake, field.refStake, field.baseRadius);
  }
  clampToWalls(field);
}

/** Fraction of the disc that must be at risk (and not at risk) before the inner boundary is worth
 *  drawing. Outside this band it is either a dot in the middle or a hairline sitting on the edge —
 *  in both cases a mark that says nothing, on a design that has no room for those. */
const RISK_BAND = [0.06, 0.94] as const;

/** `snap` skips the spring and puts the drawn radius on its target immediately. Used wherever the
 *  change is not something that HAPPENED to the fighter — construction, a resize, and every frame
 *  under `prefers-reduced-motion`, where the spring must not run at all. */
function sizeBody(field: ArenaField, b: ArenaBody, snap: boolean): void {
  b.rTarget = radiusFor(b.worth, field.refStake, field.baseRadius);
  const frac = b.worth > 0n ? Number(b.hp) / Number(b.worth) : 0;
  b.riskShare = !b.dead && frac > RISK_BAND[0] && frac < RISK_BAND[1] ? Math.sqrt(frac) : 0;
  if (snap) {
    b.r = b.rTarget;
    b.rVel = 0;
  }
  b.rRisk = b.r * b.riskShare;
}

/** Pulls the replay's current hp/banked/dead onto the bodies and re-derives radii from them. The one
 *  place fight state enters the field — everything downstream (steering, collision, painting) reads
 *  it from the body.
 *
 *  `nowMs` and `announce` exist only for the moment a fighter leaves. `announce` is false when the
 *  transition is not news — a replay re-derived from scratch around an `extract()`, or a first sync
 *  into a fight already in progress — and the corpse is then backdated so nothing downstream
 *  detonates it. See `ArenaBody.deadAtMs`.
 *
 *  Returns whether anybody went out on THIS call and was announced, so the caller can skip a scan of
 *  the whole field on the overwhelming majority of frames where nobody did. */
export function syncBodies(
  field: ArenaField,
  shadow: { hp: bigint; banked: bigint; dead: number }[],
  nowMs: number,
  snap: boolean,
  announce: boolean,
): boolean {
  let died = false;
  for (const b of field.bodies) {
    const s: { hp: bigint; banked: bigint; dead: number } | undefined = shadow[b.id];
    if (!s) continue;
    b.hp = s.hp;
    b.banked = s.banked;
    b.worth = s.hp + s.banked;
    const dead = s.dead === 1;
    if (dead && !b.dead) {
      b.deadAtMs = announce ? nowMs : -Infinity;
      if (announce) {
        died = true;
        // The convulsion. Applied here rather than by the caller so that the one place fight state
        // enters the field is also the one place its consequences leave it.
        b.rVel -= DEATH_FLINCH_SPEED * b.r;
      }
    }
    b.dead = dead;
    // Dead fighters keep sizing on `worth` like everyone else, drawn hollow. A player wiped out to
    // nothing leaves a small empty ring; a player who EXTRACTED a fortune leaves a large one. Both
    // are out of play, and the difference between them is the whole story of the round.
    sizeBody(field, b, snap);
  }
  return died;
}

/** THE FLINCH. A landed hit compresses the defender's disc and swells the attacker's, as an impulse
 *  into the radius spring — see RADIUS_STIFFNESS. `force` is `impact.ts`'s normalised roll, so the
 *  chain's own dice decide how hard the disc buckles.
 *
 *  Called once per crossed `HitEvent`, from the loop, and never under reduced motion. */
export function flinch(field: ArenaField, attackerId: number, defenderId: number, force: number): void {
  const d = field.byId[defenderId];
  if (d && !d.dead) d.rVel -= FLINCH_SPEED * force * d.r;
  const a = field.byId[attackerId];
  if (a && a !== d && !a.dead) a.rVel += FLINCH_SPEED * FLINCH_ATTACKER_SHARE * force * a.r;
}

/** One frame of motion. `targets[id]` is who to steer toward (see targeting.ts); `nowMs` drives the
 *  idle sinusoid. Never called under `prefers-reduced-motion` — positions simply stay where
 *  `createField` put them.
 *
 *  `fervour` is HOW FAR THROUGH THE FIGHT WE ARE, 0 at the bell and 1 at its last event, and the
 *  caller owns that range: it is clamped where it is computed (arenaLoop) and deliberately not
 *  clamped again here, so one place is answerable for it rather than two. Everything it does happens
 *  through `field.fervourRamp` — see `FERVOUR_GAIN`. */
export function stepField(
  field: ArenaField,
  targets: (number | null)[],
  leadMs: number[],
  mode: MotionMode,
  dtMs: number,
  nowMs: number,
  fervour: number,
): void {
  // Clamped rather than raw: a backgrounded tab hands back one enormous delta, and integrating it
  // would teleport every fighter through a wall. The physics decides nothing, so losing a little
  // wall-clock accuracy after a stall costs nothing at all.
  const dt = clamp(dtMs / 1000, 0, MAX_DT);
  if (dt <= 0) return;
  const u = field.unit;
  const t = nowMs / 1000;
  // THE ONE ASSIGNMENT, and it is before every reader: `spread` and `recentre` below, the steering in
  // the body loop, `separate` at the end of the frame, and `recoil` from the loop on the next one.
  // Deliberately after the `dt <= 0` return — a frame that does not step the field should not move
  // the temperature it steps at either.
  const ramp = 1 + FERVOUR_GAIN * fervour;
  field.fervourRamp = ramp;

  stepRadii(field, dt);

  // Not in `rest`: Settled means the field comes to a standstill, and either of these would be a
  // slow permanent creep that the decay never quite wins against.
  if (mode !== "rest") {
    spread(field, targets, dt);
    recentre(field, dt);
  }

  for (const b of field.bodies) {
    if (b.dead || mode === "rest") {
      const decay = Math.exp(-REST_DECAY * dt);
      b.vx *= decay;
      b.vy *= decay;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      continue;
    }

    const targetId = mode === "active" ? (targets[b.id] ?? null) : null;
    const target = targetId !== null ? field.byId[targetId] : undefined;

    if (target && !target.dead) {
      const angle = b.id * 2.399963 + t * STANDOFF_DRIFT;
      const standoff = b.r + target.r + STANDOFF_GAP * u;
      // …AND THE AIM POINT IS CONFINED TO THE PLAYABLE AREA, which it was not, and the omission glued
      // fighters to walls.
      //
      // The standoff point is a target's position plus a rotating offset, and nothing was stopping
      // that sum from landing outside the arena. When it did, the fighter accelerated at a coordinate
      // it could never occupy: `clampToWalls` pinned it to the boundary, the seek pushed it out again
      // on the very next frame, and it sat there pressing outward and sliding along the wall for as
      // long as the angle kept pointing that way. Traced at sixteen fighters — a fighter held against
      // the top wall at 191px/s for 1.4 SECONDS in the middle of a duel, which reads as broken rather
      // than as fast.
      //
      // NOTHING ELSE COULD HAVE RESCUED IT, which is why it had to be fixed at the source. `recentre`
      // applies the IDENTICAL acceleration to every body by construction — that uniformity is the
      // whole argument for why it cannot compress the melee — so it has no per-body authority to peel
      // one fighter off a wall. `spread()` exempts the duelling pair from each other, and the rest of
      // the crowd is pushing that pair further out, not pulling it back. And the wall bounce cannot
      // help either: the velocity into a wall while sliding along it is almost entirely tangential, so
      // reflecting its small normal component just hands the seek something to overcome again.
      //
      // It was rare while mutual pairs were rare. targeting.ts's appointment book made them the norm
      // (reciprocity 31% → 81%), so a latent case became one a viewer would actually see — which is
      // the ordinary way a good change surfaces an old bug rather than causing one.
      //
      // WHAT CONFINING IT IS AND IS NOT WORTH, over eight seeds at each of four configurations,
      // counting EPISODES — consecutive time one live body spends against a wall — because the share
      // of frames in contact is the wrong statistic. Contact went UP across this whole body of work
      // (0.38% → 0.56% of live body-frames at nine fighters) for the simple reason that the field is
      // now 1.7x faster and reaches the walls more often, and a fast bounce off a wall at
      // `WALL_RESTITUTION` 1 is a ricochet, which is wanted. What reads as broken is a body PRESSED
      // there, and that is what episodes measure:
      //
      //   episodes >= 1s, 8 seeds        HEAD    unconfined aim    confined aim
      //     9 @ 1390x781                   1            1                1
      //    16 @ 1390x781                   5            1                0     longest 2.1 -> 0.2s
      //    16 @  360x270                  16            1                2
      //     2 @ 1390x781                   0            0                0
      //
      // So: HEAD's 22 long episodes across the four are down to 3, and most of that was won by the
      // fervour ramp giving a stuck fighter the authority to leave (HEAD's episodes are overwhelmingly
      // ones where the fighter was WINDING UP — 5 of 5 at sixteen, 11 of 16 on the phone — pushing
      // away from its target and into a wall at speeds that took a second to undo). Confining the aim
      // point clears the worst remaining desktop case outright and is a wash on the other three.
      //
      // IT IS STILL RIGHT TO DO INDEPENDENTLY OF THAT LEDGER, which is why it is here despite two of
      // the four rows not moving: steering at a coordinate the body is structurally forbidden from
      // occupying is indefensible on its own terms. The seek was spending force every frame on a
      // request the clamp was always going to refuse, and no amount of downstream correction makes
      // that a sensible thing to ask for. It costs nothing — mean speed 358 either way, centroid and
      // separation unmoved, zero NaN and zero escapes over all 64 runs.
      //
      // AND THE RESIDUAL IS `spread()`, MEASURED, so nobody has to guess next time. Zeroing
      // `SPREAD_ACCEL` on top of this takes the remaining long episodes to 0 at every configuration;
      // zeroing `WINDUP_ACCEL` does much less; and zeroing `CONTACT_KNOCK` makes it far WORSE (the
      // phone goes 2 → 5 episodes and 1.7s → 4.9s), which is the knock doing exactly the job its own
      // note claims — breaking up a pile. Personal space is a pairwise repulsion with no knowledge of
      // walls, and it should not have any: it is equal and opposite by construction, and suppressing
      // one side of a pair at a boundary would inject net momentum into the crowd. When sixteen
      // fighters want two spacings apiece in a 360x240 box that cannot supply it, somebody is against
      // a wall because the field is FULL, and that is a true statement about the fight rather than a
      // defect to be engineered away.
      //
      // THE INSET IS `b.r`, NOT `target.r`: this point is where THIS fighter is asking to put its own
      // centre, and `[b.r, extent - b.r]` is exactly the interval `clampToWalls` will pin that centre
      // to. And the vertical extent is `field.h - LABEL_SPACE`, the same floor the position clamp and
      // `recentre` both use — taking `field.h` here would have fixed three walls out of four and left
      // the one with furniture in front of it.
      const aimX = confineAxis(target.x + Math.cos(angle) * standoff, b.r, field.w);
      const aimY = confineAxis(target.y + Math.sin(angle) * standoff, b.r, field.h - LABEL_SPACE);
      const dx = aimX - b.x;
      const dy = aimY - b.y;
      const dist = Math.hypot(dx, dy) || 1;
      // `STANDOFF_GAP` above is geometry and holds still; the CHARGE at it is what builds. See
      // `FERVOUR_GAIN`.
      b.vx += (dx / dist) * SEEK_ACCEL * u * ramp * dt;
      b.vy += (dy / dist) * SEEK_ACCEL * u * ramp * dt;

      // ANTICIPATION AND FOLLOW-THROUGH — see WINDUP_MS. Steered at the target's CENTRE and not at
      // the standoff point: a lunge is a fighter going for another fighter, and aiming it at the
      // polite spot beside them would be a fighter going for a coordinate.
      const lead = leadMs[b.id] ?? Infinity;
      let lunging = false;
      if (lead <= WINDUP_MS) {
        const tx = target.x - b.x;
        const ty = target.y - b.y;
        const td = Math.hypot(tx, ty) || 1;
        lunging = lead <= LUNGE_MS;
        // Away on the wind-up, at it on the lunge, and the sign is the entire mechanism.
        const accel = (lunging ? LUNGE_ACCEL : -WINDUP_ACCEL) * u * ramp * dt;
        b.vx += (tx / td) * accel;
        b.vy += (ty / td) * accel;
      }

      // Ease off as they close, so the pair meets and stays together across the moment the hit lands
      // rather than sailing past each other at full tilt. The lunge is exempt: it is the one moment
      // the fighter is supposed to sail.
      // All three caps ramp and the RADIUS that chooses between them does not: which brake applies is
      // a question about where the fighter is, and a late round should not move the point at which a
      // charge becomes an arrival. Because the caps ramp with the accelerations that fill them, the
      // time taken to reach any of them is unchanged — see `FERVOUR_GAIN`.
      const cap =
        (lunging ? LUNGE_SPEED : dist < APPROACH_RADIUS * u ? APPROACH_SPEED : MAX_SPEED) * u * ramp;
      const speed = Math.hypot(b.vx, b.vy);
      if (speed > cap) {
        // A SOFT cap, and this is the bug that made the old recoil invisible. `recoil()` hands a
        // fighter a velocity well above cruising speed — that is what being hit means — and a hard
        // clip back to `cap` on the very next frame deleted the whole of it before it had moved
        // anybody a pixel. Bleeding the excess off at a fixed rate instead lets the kick play out
        // over ~150ms and still holds the steady-state speed at exactly `cap`, because the moment the
        // seek is the only thing pushing, `cap / speed` is the binding term again.
        b.vx *= Math.max(cap / speed, 1 - SPEED_BLEED * dt);
        b.vy *= Math.max(cap / speed, 1 - SPEED_BLEED * dt);
      }
    } else {
      // A phase-shifted sinusoid rather than random noise: smooth frame to frame, reproducible, and
      // spread apart by the golden angle so idle fighters don't all drift in lockstep. Lerped into
      // rather than assigned, so leaving combat is a glide, not a snap.
      const speed = (mode === "calm" ? CALM_SPEED : WANDER_SPEED) * u;
      const phase = b.id * 2.399963;
      const wx = Math.cos(t * 0.6 + phase) * speed;
      const wy = Math.sin(t * 0.5 + phase) * speed;
      const k = 1 - Math.exp(-WANDER_LERP * dt);
      b.vx += (wx - b.vx) * k;
      b.vy += (wy - b.vy) * k;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;
  }

  separate(field);
  clampToWalls(field);
}

/** ONE FRAME OF THE RADIUS SPRING, for every body — see RADIUS_STIFFNESS.
 *
 *  Semi-implicit Euler (velocity first, then position) rather than explicit: at a stiffness of 900
 *  and a 33ms frame — which is what MAX_DT allows after a stall — explicit Euler adds energy and the
 *  disc grows instead of settling. Semi-implicit is unconditionally stable at these numbers for one
 *  extra line of nothing.
 *
 *  Floored at 1px. The overshoot on a hard flinch is bounded by the damping, but a hit on a fighter
 *  already at MIN_RADIUS could still take the drawn radius through zero for a frame or two, and a
 *  negative radius is an `arc()` that throws. */
function stepRadii(field: ArenaField, dt: number): void {
  for (const b of field.bodies) {
    b.rVel += (-RADIUS_STIFFNESS * (b.r - b.rTarget) - RADIUS_DAMPING * b.rVel) * dt;
    b.r += b.rVel * dt;
    if (b.r < 1) {
      b.r = 1;
      if (b.rVel < 0) b.rVel = 0;
    }
    b.rRisk = b.r * b.riskShare;
  }
}

/** HOW HEAVY A FIGHTER IS, and it is its AREA — which by `radiusFor` is very nearly what it is worth.
 *
 *  Nothing on the chain has a mass, so this is a free choice and it should be the one that says the
 *  most true thing. Area is it: a whale that has eaten half the table shrugs off a blow from a minnow
 *  and the minnow is thrown across the arena, which is the wealth asymmetry the field's whole visual
 *  argument is about, restated as physics. It costs one multiply — no `sqrt`, no cached field to keep
 *  in step with a radius that moves every frame. */
function massOf(b: ArenaBody): number {
  return b.r * b.r;
}

/** PERSONAL SPACE, applied as an acceleration before integration.
 *
 *  Every fighter is pulled toward some other fighter and, without this, nothing pushes the field
 *  apart at any range — so a table converges on one tight knot in the middle and leaves two thirds of
 *  the arena blank. That is not a hypothetical: it is what three screenshots at three different
 *  points of a fight all showed, with a dozen labels stacked on top of each other in the same 400px.
 *
 *  A soft outward accel between any two LIVE fighters closer than `PERSONAL_SPACE` times their
 *  combined radii, falling off linearly to nothing at the edge of that range. Two exemptions keep it
 *  from fighting the thing it exists to serve:
 *
 *    - the pair currently targeting each other is exempt in BOTH directions, so a duel still closes,
 *      touches, and lands its hit;
 *    - the dead are exempt entirely — they are markers, and a corpse should neither shove nor be
 *      shoved (`separate()` lays them out among themselves and no further).
 *
 *  Linear falloff rather than inverse-square on purpose: an inverse law is unbounded as distance
 *  goes to zero and turns a momentary overlap into a launch. This is a nudge with a hard edge, which
 *  is all a crowd of at most sixteen circles needs. */
function spread(field: ArenaField, targets: (number | null)[], dt: number): void {
  const bodies = field.bodies;
  // RAMPED WITH THE SEEK IT IS HOLDING OFF, which is the point of ramping it at all: this accel's own
  // note is that it is a RATIO against `SEEK_ACCEL`, so a common factor changes nothing about where
  // the two balance and the equilibrium spacing is identical at every fervour. `PERSONAL_SPACE` and
  // `field.spacing` set the range and are geometry — they do not move. See `FERVOUR_GAIN`.
  const accel = SPREAD_ACCEL * field.unit * field.fervourRamp * dt;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (a.dead) continue;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (b.dead) continue;
      if (targets[a.id] === b.id || targets[b.id] === a.id) continue;

      const range = Math.max((a.r + b.r) * PERSONAL_SPACE, field.spacing);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= range || dist <= 0) continue;

      // 1 at contact, 0 at the edge of personal space.
      const push = (accel * (range - dist)) / range;
      const nx = dx / dist;
      const ny = dy / dist;
      a.vx -= nx * push;
      a.vy -= ny * push;
      b.vx += nx * push;
      b.vy += ny * push;
    }
  }
}

/** Keeps the melee framed — see RECENTRE_GAIN. Reads the live fighters' centroid and drifts the
 *  whole crowd toward the middle of the field, using the vertical middle of the PLAYABLE area (the
 *  label strip at the bottom is not part of it, and centring on the raw height would sit the fight
 *  permanently a dozen pixels low). The dead are excluded from both the measurement and the nudge:
 *  they are markers of where something happened, and sliding them around afterwards would quietly
 *  falsify that. */
function recentre(field: ArenaField, dt: number): void {
  let sumX = 0;
  let sumY = 0;
  let sumVx = 0;
  let sumVy = 0;
  let live = 0;
  for (const b of field.bodies) {
    if (b.dead) continue;
    sumX += b.x;
    sumY += b.y;
    sumVx += b.vx;
    sumVy += b.vy;
    live++;
  }
  if (live === 0) return;

  // THE CAP RAMPS AND THE GAINS DO NOT, and the asymmetry is deliberate: the cap is this controller's
  // AUTHORITY, against a crowd that now drifts off centre `fervourRamp` times faster, while GAIN and
  // DAMP are the frequency terms that set its ωn and ζ. Scaling those would retire the measured table
  // over `RECENTRE_GAIN`; scaling only the cap keeps the loop's shape exactly and lets it out-run the
  // faster disturbance, which is the requirement that note states. See `FERVOUR_GAIN`.
  const cap = RECENTRE_MAX_ACCEL * field.unit * field.fervourRamp;
  // Position error, less the crowd's own drift — see RECENTRE_DAMP.
  const ax =
    clamp((field.w / 2 - sumX / live) * RECENTRE_GAIN - (sumVx / live) * RECENTRE_DAMP, -cap, cap) * dt;
  const ay =
    clamp(((field.h - LABEL_SPACE) / 2 - sumY / live) * RECENTRE_GAIN - (sumVy / live) * RECENTRE_DAMP, -cap, cap) *
    dt;
  for (const b of field.bodies) {
    if (b.dead) continue;
    b.vx += ax;
    b.vy += ay;
  }
}

/** The kick a hit gives its pair. A no-op unless they are actually in contact — a raid between two
 *  fighters at opposite ends of the arena (the hash pairs them, not their positions) has no contact
 *  to recoil from, and inventing one would fling fighters around for reasons nothing on screen
 *  explains. Called once per crossed `HitEvent`, from the loop.
 *
 *  IT IS NOW A CONSERVED IMPULSE SPLIT BY MASS. It used to hand the defender a fixed velocity and the
 *  attacker half of it backwards, which is not a collision — it is two independent shoves that happen
 *  to point in opposite directions, and it made a $6 minnow punching a $100 whale look exactly like
 *  the reverse. Splitting one impulse in inverse proportion to mass gives the reading the fight
 *  actually has: the whale barely rocks and the minnow is thrown clear.
 *
 *  `force` is `impact.ts`'s normalised roll, so the size of the impulse is the chain's own dice. */
export function recoil(field: ArenaField, attackerId: number, defenderId: number, force: number): void {
  const a = field.byId[attackerId];
  const d = field.byId[defenderId];
  if (!a || !d || a === d || a.dead || d.dead) return;
  const dx = d.x - a.x;
  const dy = d.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 0 || dist > a.r + d.r + RECOIL_REACH * field.unit) return;

  const ma = massOf(a);
  const md = massOf(d);
  const total = ma + md;
  if (total <= 0) return;
  const scale = RECOIL_FORCE[0] + (RECOIL_FORCE[1] - RECOIL_FORCE[0]) * force;
  // …AND BY THE HOUR OF THE FIGHT. A late blow throws harder than an opening one, which is the ramp's
  // most visible single effect: the impulse is the only place in the file where a fighter's speed is
  // set by an EVENT rather than by steering, and the soft cap now bleeds it back to a cruising speed
  // that is itself `fervourRamp` times higher, so the follow-through survives longer as well as
  // starting faster. Read off the field because this is called from the event stream and not from a
  // step — see `ArenaField.fervourRamp` for why that is a frame stale and why that is fine.
  //
  // Per unit of distance, so the two components below need no second normalisation.
  const j = (HIT_RECOIL * field.unit * scale * field.fervourRamp) / dist;
  // Each party takes the share of the impulse the OTHER party's mass earns it — the standard split,
  // and the reason a heavy attacker throws a light defender rather than both moving equally.
  a.vx -= dx * j * (md / total);
  a.vy -= dy * j * (md / total);
  d.vx += dx * j * (ma / total);
  d.vy += dy * j * (ma / total);
}

/** Positional separation plus an impulse exchange along the contact normal — `web/index.html`'s
 *  collision response, which is the feel being preserved. O(n²) over at most 16 bodies: 120 pair
 *  checks, cheaper than the branch that would avoid them.
 *
 *  A live fighter passes straight THROUGH a dead one: the dead are hollow outlines, out of play, and
 *  shoving the living around from beyond the grave would be a physical claim the game does not make.
 *  Two dead fighters, though, still push each other apart — they die where they were fighting, which
 *  is to say on top of each other, and a pile of concentric grey rings with three greyed labels
 *  stacked underneath is unreadable. Positional only, no impulse: they are markers being laid out,
 *  not bodies colliding.
 *
 *  MASS ENTERS IN BOTH HALVES, and it is what turns a collision into a COLLISION. The reference's
 *  response assumed equal masses — the overlap was split down the middle and the normal velocities
 *  were swapped outright — so a $6 fighter running into a $100 one moved both of them the same
 *  distance, which is the single most obviously wrong thing the old field did. Weighting both the
 *  positional fix and the impulse by `massOf` (area, i.e. very nearly worth) means the small fighter
 *  bounces off the big one, and it degenerates to exactly the old behaviour when they are the same
 *  size, so nothing about the feel this file set out to preserve is lost. */
function separate(field: ArenaField): void {
  const bodies = field.bodies;
  // Ramped: the knock is documented as having to be a real fraction of `MAX_SPEED` to do anything
  // against the seek, and both of those now ramp — so it stays that same fraction all round rather
  // than fading into a field that has got 2.6x faster around it. The positional half of this function
  // is untouched by the ramp, because an overlap is a distance and resolving it is not a force. See
  // `FERVOUR_GAIN`.
  const knock = CONTACT_KNOCK * field.unit * field.fervourRamp;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (a.dead !== b.dead) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const min = a.r + b.r;
      if (dist >= min || dist <= 0) continue;

      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = min - dist;
      const ma = massOf(a);
      const mb = massOf(b);
      const total = ma + mb || 1;
      // The pair still moves `overlap` apart in total; who yields is decided by mass.
      const pushA = overlap * (mb / total);
      const pushB = overlap * (ma / total);
      a.x -= nx * pushA;
      a.y -= ny * pushA;
      b.x += nx * pushB;
      b.y += ny * pushB;
      if (a.dead) continue; // (and therefore b.dead — see the pairing guard above)

      const va = a.vx * nx + a.vy * ny;
      const vb = b.vx * nx + b.vy * ny;
      const diff = vb - va;
      // APPROACHING ONLY. The old form ran the exchange unconditionally, which on a pair that was
      // already separating handed them the closing speed they no longer had and pumped energy into
      // a crowd that then jittered. `diff < 0` is the pair coming together.
      if (diff < 0) {
        // Elastic exchange along the normal, mass-weighted. At `ma == mb` this is `va' = vb`,
        // `vb' = va` — the reference's swap, exactly.
        const ja = 2 * diff * (mb / total);
        const jb = 2 * diff * (ma / total);
        a.vx += nx * ja;
        a.vy += ny * ja;
        b.vx -= nx * jb;
        b.vy -= ny * jb;
      }
      // …and the knock, which is a push and not a bounce, so it applies whichever way they are
      // already going. Split by mass too, or a big fighter would be shoved off its own duel by every
      // small one that brushed it.
      const ka = 2 * knock * (mb / total);
      const kb = 2 * knock * (ma / total);
      a.vx -= nx * ka;
      a.vy -= ny * ka;
      b.vx += nx * kb;
      b.vy += ny * kb;
    }
  }
}

/** THE BOTTOM MARGIN. Nothing the field owns is drawn into it: no disc (see `clampToWalls`), no label
 *  (see draw.ts's `layoutLabels`), no watermark row (see scoreboard.ts's `playable`).
 *
 *  It began as the space kept clear below every fighter for its two label lines — without it the
 *  bottom row printed names and figures straight through the parent's frame, caught in the first
 *  screenshot with the last fighter's ring value simply not there. That reading of it did not survive
 *  the crowd actually reaching the bottom of the arena: at 26 the strip was NARROWER than the label
 *  it was reserved for (draw.ts's LABEL_GAP + LABEL_H is ~36), so a fighter near the floor put its
 *  value line into the last few pixels of the canvas — where the shell's fixed bottom nav is sitting.
 *  Screenshotted on the crowded frame: `INDIGO_82 / $42.7…` with the figure cut in half by the nav's
 *  black bar.
 *
 *  So the strip is now a MARGIN and the label rule is the one that changed: a fighter low enough that
 *  its label will not fit above the margin takes the band over its own head instead, which
 *  `layoutLabels` was already doing for the fighters pinned to the very floor. 30 is the shell chrome's
 *  own height, which is what is actually sitting over the canvas here. */
export const LABEL_SPACE = 30;

/** WHERE A BODY'S CENTRE IS ALLOWED TO BE, on one axis — the interval `[r, extent - r]`, and the
 *  degenerate answer when the body is wider than the axis it is being confined to.
 *
 *  It exists because that interval is now asserted in TWO places and they must not be allowed to
 *  drift apart. `clampToWalls` enforces it on a POSITION after the fact; `stepField` applies it to
 *  the standoff AIM POINT before the fact, so that the steering never asks for a coordinate the
 *  clamp is going to refuse. Two statements of one rectangle that can disagree is the exact shape of
 *  the bug this file has already been bitten by once — `RECOIL_REACH`'s note is the post-mortem — so
 *  the interval gets a name.
 *
 *  `extent / 2` when the body does not fit: the same rule, and the same reasoning, as the "wider than
 *  the field" branch in `clampToWalls`. A `clamp(v, r, extent - r)` with the bounds crossed returns
 *  whichever bound it tests first, which is an arbitrary edge rather than an answer; the middle is at
 *  least the honest one, it matches what the position clamp will do a few lines later, and it cannot
 *  produce a NaN for any finite input. */
function confineAxis(v: number, r: number, extent: number): number {
  return extent <= r * 2 ? extent / 2 : clamp(v, r, extent - r);
}

function clampToWalls(field: ArenaField): void {
  // The same rectangle `confineAxis` describes, enforced on a position rather than on a request, and
  // additionally reflecting the velocity — which is why this is written out rather than delegated.
  const floor = field.h - LABEL_SPACE;
  for (const b of field.bodies) {
    // A fighter wider than the field would oscillate forever between two impossible clamps; pin it
    // to the centre of that axis instead. Only reachable at absurd aspect ratios, but "only
    // reachable" is not "unreachable".
    if (b.r * 2 >= field.w) {
      b.x = field.w / 2;
      b.vx = 0;
    } else if (b.x < b.r) {
      b.x = b.r;
      b.vx = Math.abs(b.vx) * WALL_RESTITUTION;
    } else if (b.x > field.w - b.r) {
      b.x = field.w - b.r;
      b.vx = -Math.abs(b.vx) * WALL_RESTITUTION;
    }

    if (b.r * 2 >= floor) {
      b.y = floor / 2;
      b.vy = 0;
    } else if (b.y < b.r) {
      b.y = b.r;
      b.vy = Math.abs(b.vy) * WALL_RESTITUTION;
    } else if (b.y > floor - b.r) {
      b.y = floor - b.r;
      b.vy = -Math.abs(b.vy) * WALL_RESTITUTION;
    }
  }
}

/** Nearest body whose disc contains the point, with a few px of slop so a small fighter is still
 *  clickable. Dead fighters stay hittable — being able to inspect who went out, and with what, is
 *  the whole reason they remain on the field. */
export function bodyAt(field: ArenaField, x: number, y: number): ArenaBody | null {
  let best: ArenaBody | null = null;
  let bestDist = Infinity;
  for (const b of field.bodies) {
    const d = Math.hypot(b.x - x, b.y - y);
    if (d <= b.r + 4 && d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}
