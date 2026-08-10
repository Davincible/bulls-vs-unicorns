// HOW MANY FIGHTERS THE FIXTURE FIELDS, and who they are — pure, seeded, and testable.
//
// WHY THIS IS A SEPARATE MODULE FROM `mockData.ts`. The lineup size arrives from the URL
// (`?fighters=48`), so `mockData.ts` can only ever build ONE lineup per page load — its exports are
// module constants and everything downstream (`useFixtureRound`'s `RATE`, `LAST_EVENT_STEP`,
// `FIGHT_SECONDS`) is derived from them at module scope. That is the right shape for the app and the
// wrong shape for a test, which needs to build 2, 9 and 48 in the same process and compare them.
// So the *builder* lives here, takes the count as an argument, touches no globals, and imports
// nothing from React or the DOM; `mockData.ts` calls it exactly once with whatever the URL said.
//
// WHY THE FIXTURE IS SIZEABLE AT ALL. `programs/bulls-arena/src/lib.rs` caps a round at
// `MAX_FIGHTERS` and requires at least 2 for a fight (`run_fight`'s own
// `(fighters as usize).clamp(2, MAX_FIGHTERS)`). The fixture shipped 9 — comfortably inside the
// range and therefore no evidence at all about either end of it. The page had never been run at the
// program's own ceiling, so "does the product work at its documented maximum" was an open question
// with a plausible-sounding assumed answer, which is the kind of question that gets answered by a
// demo audience instead.
//
// THAT CEILING HAS SINCE TRIPLED, 16 -> 48, which is the reason this file changed. Everything above
// still holds and now matters more: the gap between the 9 the fixture defaults to and the 48 the
// program permits is where the untested rendering lives.
//
// DETERMINISM IS A HARD REQUIREMENT, not a nicety. Screenshots of this fixture are the artifact
// design review works from, so the same `?fighters=n` must produce the same wallets, the same
// stakes, the same sides and therefore the same fight on every reload — otherwise two screenshots
// differ for reasons nobody can attribute. Hence the seeded LCG rather than `Math.random()`, and
// hence the fixed stake table rather than a drawn one.
//
// AND THE DEFAULT DOES NOT MOVE. `buildLineup(9)` emits byte-for-byte what the hand-written
// nine-fighter fixture emitted before it was generalised: same LCG seed, same draw order, same first
// nine stakes. `fixtureLineup.test.ts` pins that as an explicit regression, because the whole point
// of an opt-in flag is that nobody who did not opt in notices it exists.

import { usdToUnits, type Side } from "../contract.ts";

/** The program's own minimum for a fight — `run_fight` clamps to it, and a one-sided "fight" is not
 *  a state the round machine can reach. */
export const MIN_LINEUP = 2;

/** `MAX_FIGHTERS` in `programs/bulls-arena/src/lib.rs`. The round is one account so it can be one
 *  atomic commit; 48 is the largest lineup that still reaches a conclusion before the bell as often
 *  as the deployed sixteen-fighter round did. It used to be 16, and the binding constraint used to be
 *  that the account had to deserialise inside the ER's 4 KB stack — `zero_copy` removed that, and
 *  what replaced it is a property of the GAME rather than of the runtime. */
export const MAX_LINEUP = 48;

/** What the fixture fields when nobody asks for anything else. Unchanged from the original
 *  hand-written fixture, deliberately — see this file's header. */
export const DEFAULT_LINEUP = 9;

/** The LCG seed the original fixture used. Frozen: changing it recasts every fighter. */
const WALLET_SEED = 20260809;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Deterministic 32-bit LCG — the fixture must look the same on every reload, so a reviewer
 *  comparing two screenshots is comparing the design and not the dice.
 *
 *  Numerical Recipes' constants, same as the fixture has always used. Exported because `mockData.ts`
 *  draws its past rounds from a second, independently seeded stream and two copies of a generator is
 *  two chances for one of them to be "improved". */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** A 44-character base58 string. Not a real key and not checked as one — nothing in fixture mode
 *  ever hands it to `PublicKey`. */
export function fakeWallet(rnd: () => number): string {
  let out = "";
  for (let i = 0; i < 44; i++) out += B58[Math.floor(rnd() * B58.length)];
  return out;
}

/** The first sixteen stakes, in whole dollars — hand-picked, and FROZEN.
 *
 *  The first NINE are the original fixture's literal table and may not be reordered — that is what
 *  keeps `?fighters=9` (and therefore the default) pixel-identical to what it was. Entries 10..16
 *  were added when the fixture was first made sizeable, against the then-ceiling of 16, and are
 *  frozen for the same reason one step down: every screenshot review taken at those sizes is an
 *  artifact somebody may still be comparing against. */
const STAKE_USD_HEAD: readonly number[] = [
  25, 60, 12, 100, 40, 8, 75, 33, 55,   // the original nine — frozen
  18, 90, 45, 6, 68, 28, 82,            // 10..16 — the sixteen-seat extension, also frozen
];

/** The band the hand-picked head spans, and therefore the band its generated tail draws from. */
const MIN_STAKE_USD = 6;
const MAX_STAKE_USD = 100;

/** Frozen, like `WALLET_SEED`: changing it re-prices every fighter from index 16 up. Its own stream
 *  rather than the wallet one, so that adding a stake never shifts a wallet. */
const STAKE_SEED = 20260810;

/** Stakes, in whole dollars, assigned by lineup index — a frozen head and a generated tail.
 *
 *  WHY STAKE SPREAD IS THE POINT. Stake is what `field.ts`'s `radiusFor` sizes a disc from, so a flat
 *  table would field forty-eight identical circles and quietly retire the label-overlap case the
 *  large lineup sizes exist to stress. The head was hand-picked to scatter across the band; the tail
 *  is DEALT from the same band without replacement, which scatters it for the same reason without
 *  asking anyone to invent thirty-two more numbers by eye.
 *
 *  DEALT, NOT DRAWN, AND THAT IS THE WHOLE DESIGN. Sampling with replacement would repeat values —
 *  measured, a uniform draw over this band gave 25 distinct out of 32 — and two fighters holding the
 *  same stake are two discs of exactly the same radius, i.e. the flat table this file exists to
 *  avoid, arrived at by accident instead of by choice. Dealing from a shuffled pool of the values the
 *  head did not already take makes "every fighter has a distinct stake" true BY CONSTRUCTION at every
 *  lineup size, rather than a property to hope for and assert afterwards. There is room: the band
 *  holds 95 whole-dollar values and the full lineup needs 48.
 *
 *  WHY THE TAIL IS GENERATED RATHER THAN WRITTEN OUT, now that the ceiling is 48 rather than 16. A
 *  literal table of forty-eight entries is thirty-two more places to make a typo that nobody will
 *  ever catch by reading, and — the stronger argument — the length invariant stops being something to
 *  ASSERT and becomes something that cannot be false. The previous revision carried a module-load
 *  `throw` here, because indexing `STAKE_USD[i]` unguarded was safe only while a hand-written table
 *  happened to be as long as `MAX_LINEUP`, and raising the ceiling without extending the table would
 *  have produced `usdToUnits(undefined)` at module load: a blank page whose stack trace points at
 *  currency formatting. Filling to `MAX_LINEUP` by construction deletes that failure mode instead of
 *  reporting it, which is why the `throw` is gone rather than merely re-tuned.
 *
 *  BOTH HALVES ARE STILL FIXED PER INDEX, which is the property `buildLineup` depends on: this table
 *  is built once, at module scope, from a frozen seed, so the stake attached to fighter `i` does not
 *  depend on how many fighters came after it. At any count, index 3 is the $100 whale. Drawing inside
 *  `buildLineup` instead — from the wallet stream, as the obvious shortcut — would have made every
 *  stake a function of the lineup size, and two screenshots at different sizes would then differ in
 *  ways nobody could attribute. */
const STAKE_USD: readonly number[] = (() => {
  const rnd = lcg(STAKE_SEED);
  const taken = new Set(STAKE_USD_HEAD);
  const pool: number[] = [];
  for (let usd = MIN_STAKE_USD; usd <= MAX_STAKE_USD; usd++) if (!taken.has(usd)) pool.push(usd);

  // Fisher-Yates, so the deal is a permutation rather than a biased shuffle — the tail's spread is
  // the only reason it exists, and a shuffle that clustered would give back what dealing bought.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return [...STAKE_USD_HEAD, ...pool.slice(0, MAX_LINEUP - STAKE_USD_HEAD.length)];
})();

/** Any URL-shaped input to a lineup size the program would actually accept.
 *
 *  TOTAL, on purpose: this reads a query string, so it will be handed `"abc"`, `""`, `"1e3"`, `"-4"`
 *  and `"48.9"` by anyone who edits the address bar, and every one of those has to land on a number
 *  the fight engine can run rather than on a `NaN` that becomes an empty arena three modules later.
 *  Out-of-range CLAMPS rather than falling back to the default: someone typing `?fighters=99` is
 *  asking for "as many as possible", and `MAX_LINEUP` is that answer. Unparseable falls back to the
 *  default, because that is a typo, not a request. */
export function clampLineup(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_LINEUP;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LINEUP;
  return Math.min(Math.max(Math.trunc(n), MIN_LINEUP), MAX_LINEUP);
}

/** One fixture entry, in the shape `sim/hitEvents.ts`'s `runFullFight` consumes. Declared
 *  structurally rather than imported as `HitEventEntry` so this module's only import is `contract.ts`
 *  — it is assignable to it, and `mockData.ts` proves that at the call site. */
export interface LineupEntry {
  wallet: string;
  side: Side;
  stake: bigint;
}

export interface FixtureLineup {
  /** The local player. Always index 0, always side 0 — "you" must be visible in the roster the
   *  reviewer looks at first, at every lineup size. */
  you: string;
  wallets: string[];
  entries: LineupEntry[];
}

/** Builds the fixture's lineup at `count` fighters.
 *
 *  Sides alternate by index, so every size splits as evenly as it can (48 → 24/24, 9 → 5/4) and both
 *  rosters are populated at the minimum of 2. */
export function buildLineup(count: number): FixtureLineup {
  const n = clampLineup(count);
  const rnd = lcg(WALLET_SEED);

  // Drawn one at a time off a single stream, in index order — the original's
  // `[you, ...Array.from({ length: 8 }, ...)]` consumed the generator in exactly this order, which
  // is why the first nine wallets are unchanged.
  const wallets: string[] = [];
  for (let i = 0; i < n; i++) wallets.push(fakeWallet(rnd));

  const entries: LineupEntry[] = wallets.map((wallet, i) => ({
    wallet,
    side: (i % 2) as Side,
    stake: usdToUnits(STAKE_USD[i]),
  }));

  return { you: wallets[0], wallets, entries };
}
