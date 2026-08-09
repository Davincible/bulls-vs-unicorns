// HOW MANY FIGHTERS THE FIXTURE FIELDS, and who they are — pure, seeded, and testable.
//
// WHY THIS IS A SEPARATE MODULE FROM `mockData.ts`. The lineup size arrives from the URL
// (`?fighters=16`), so `mockData.ts` can only ever build ONE lineup per page load — its exports are
// module constants and everything downstream (`useFixtureRound`'s `RATE`, `LAST_EVENT_STEP`,
// `FIGHT_SECONDS`) is derived from them at module scope. That is the right shape for the app and the
// wrong shape for a test, which needs to build 2, 9 and 16 in the same process and compare them.
// So the *builder* lives here, takes the count as an argument, touches no globals, and imports
// nothing from React or the DOM; `mockData.ts` calls it exactly once with whatever the URL said.
//
// WHY THE FIXTURE IS SIZEABLE AT ALL. `programs/bulls-arena/src/lib.rs` caps a round at
// `MAX_FIGHTERS = 16` and requires at least 2 for a fight (`run_fight`'s own
// `(fighters as usize).clamp(2, MAX_FIGHTERS)`). The fixture shipped 9 — comfortably inside the
// range and therefore no evidence at all about either end of it. The page had never been run at the
// program's own ceiling, so "does the product work at its documented maximum" was an open question
// with a plausible-sounding assumed answer, which is the kind of question that gets answered by a
// demo audience instead.
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
 *  atomic commit, and 16 is where that account still deserialises inside the ER's 4 KB stack. */
export const MAX_LINEUP = 16;

/** What the fixture fields when nobody asks for anything else. Unchanged from the original
 *  hand-written fixture, deliberately — see this file's header. */
export const DEFAULT_LINEUP = 9;

/** The LCG seed the original fixture used. Frozen: changing it recasts every fighter. */
const WALLET_SEED = 20260809;

/** Stakes, in whole dollars, assigned by lineup index.
 *
 *  The first NINE are the original fixture's literal table and may not be reordered — that is what
 *  keeps `?fighters=9` (and therefore the default) pixel-identical to what it was. The remaining
 *  seven extend the same $5–$100 band with the same intent behind it: a wide spread, because stake
 *  is what `field.ts`'s `radiusFor` sizes a disc from, so a flat table would field sixteen identical
 *  circles and quietly retire the label-overlap case this lineup size exists to stress.
 *
 *  Fixed rather than drawn from the LCG so that the stake attached to fighter `i` does not depend on
 *  how many fighters came after it: at any count, index 3 is the $100 whale. */
const STAKE_USD: readonly number[] = [
  25, 60, 12, 100, 40, 8, 75, 33, 55,   // the original nine — frozen
  18, 90, 45, 6, 68, 28, 82,            // 10..16
];

// The table is indexed unguarded below (`STAKE_USD[i]` for i < n <= MAX_LINEUP), which is safe only
// because `clampLineup` caps at `MAX_LINEUP`. That coupling is invisible from either end, and the
// failure mode if someone raises the ceiling without extending the table is a `RangeError` from
// `usdToUnits(undefined)` at MODULE LOAD — a blank page with a stack trace pointing at currency
// formatting. Asserting it here turns that into the sentence describing what actually happened.
if (STAKE_USD.length !== MAX_LINEUP) {
  throw new Error(
    `fixtureLineup: STAKE_USD has ${STAKE_USD.length} entries but MAX_LINEUP is ${MAX_LINEUP} — ` +
      `every lineup index must have a stake. Extend the table to match.`,
  );
}

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

/** Any URL-shaped input to a lineup size the program would actually accept.
 *
 *  TOTAL, on purpose: this reads a query string, so it will be handed `"abc"`, `""`, `"1e3"`, `"-4"`
 *  and `"16.9"` by anyone who edits the address bar, and every one of those has to land on a number
 *  the fight engine can run rather than on a `NaN` that becomes an empty arena three modules later.
 *  Out-of-range CLAMPS rather than falling back to the default: someone typing `?fighters=40` is
 *  asking for "as many as possible", and 16 is that answer. Unparseable falls back to the default,
 *  because that is a typo, not a request. */
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
 *  Sides alternate by index, so every size splits as evenly as it can (16 → 8/8, 9 → 5/4) and both
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
