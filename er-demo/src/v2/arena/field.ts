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

// Motion, all in px/s (or px/s²) per `unit`.
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
const WALL_RESTITUTION = 0.9;
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
  };
  // Deterministic spawn means deterministic overlaps. Settle them before the first paint so a lobby
  // never opens with two fighters fused together — 16 passes of the same solver the loop uses.
  for (let i = 0; i < 16; i++) separate(field);
  clampToWalls(field);
  return field;
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
 *  `createField` put them. */
export function stepField(
  field: ArenaField,
  targets: (number | null)[],
  leadMs: number[],
  mode: MotionMode,
  dtMs: number,
  nowMs: number,
): void {
  // Clamped rather than raw: a backgrounded tab hands back one enormous delta, and integrating it
  // would teleport every fighter through a wall. The physics decides nothing, so losing a little
  // wall-clock accuracy after a stall costs nothing at all.
  const dt = clamp(dtMs / 1000, 0, MAX_DT);
  if (dt <= 0) return;
  const u = field.unit;
  const t = nowMs / 1000;

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
      const dx = target.x + Math.cos(angle) * standoff - b.x;
      const dy = target.y + Math.sin(angle) * standoff - b.y;
      const dist = Math.hypot(dx, dy) || 1;
      b.vx += (dx / dist) * SEEK_ACCEL * u * dt;
      b.vy += (dy / dist) * SEEK_ACCEL * u * dt;

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
        const accel = (lunging ? LUNGE_ACCEL : -WINDUP_ACCEL) * u * dt;
        b.vx += (tx / td) * accel;
        b.vy += (ty / td) * accel;
      }

      // Ease off as they close, so the pair meets and stays together across the moment the hit lands
      // rather than sailing past each other at full tilt. The lunge is exempt: it is the one moment
      // the fighter is supposed to sail.
      const cap = (lunging ? LUNGE_SPEED : dist < APPROACH_RADIUS * u ? APPROACH_SPEED : MAX_SPEED) * u;
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
  const accel = SPREAD_ACCEL * field.unit * dt;
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

  const cap = RECENTRE_MAX_ACCEL * field.unit;
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
  if (dist <= 0 || dist > a.r + d.r + 6 * field.unit) return;

  const ma = massOf(a);
  const md = massOf(d);
  const total = ma + md;
  if (total <= 0) return;
  const scale = RECOIL_FORCE[0] + (RECOIL_FORCE[1] - RECOIL_FORCE[0]) * force;
  // Per unit of distance, so the two components below need no second normalisation.
  const j = (HIT_RECOIL * field.unit * scale) / dist;
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
  const knock = CONTACT_KNOCK * field.unit;
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

function clampToWalls(field: ArenaField): void {
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
