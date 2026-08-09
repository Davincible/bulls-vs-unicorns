// TEMPORARY FIXTURE — the shape of a busy arena, with no network involved.
//
// It exists so the view and canvas layers could be built and design-reviewed before (and
// independently of) a live devnet round: a round only exists while an operator has one open, and
// "the page is unstyleable unless someone is running the admin script" is not a workable way to
// build a front end. The real provider replaces every value here with chain data; nothing in
// `views/` or `arena/` may import this module directly — it reaches them only through
// `ArenaProvider`.
//
// The fight itself is NOT faked: it runs the same `sim/hitEvents.ts` replay the real page does, off
// a fixed seed, so the event stream driving the canvas here is byte-for-byte the kind of stream the
// chain produces.

import { runFullFight, type HitEvent, type HitEventEntry } from "../../sim/hitEvents.ts";
import {
  MAX_STEPS,
  nameFor,
  shortKey,
  usdToUnits,
  type FighterView,
  type RoundPlayer,
  type RoundSummary,
  type Side,
} from "../contract.ts";
import { buildLineup, lcg, fakeWallet } from "./fixtureLineup.ts";
import { FIXTURE_LINEUP } from "./flags.ts";

/** The lineup, sized by `?fighters=<n>` and defaulting to nine — the size this fixture has always
 *  been. Built ONCE, at module load, because everything downstream of it is a module constant too
 *  (`MOCK_HIT_EVENTS` is a whole fight; `useFixtureRound`'s `RATE` and `FIGHT_SECONDS` are read off
 *  it), and a lineup that could change mid-session would mean a fight that changes under a canvas
 *  mid-frame. Like the other flags, it is a deep-link: changing it is a reload. */
const LINEUP = buildLineup(FIXTURE_LINEUP);

/** The local player's wallet in fixture mode. */
export const MOCK_YOU = LINEUP.you;

const MOCK_WALLETS: string[] = LINEUP.wallets;

/** The round's entries — stakes spread across the original's $5–$100 band, sides alternating so both
 *  rosters are populated at every lineup size. Assignable to `HitEventEntry` by construction; the
 *  annotation is what proves it, since `fixtureLineup.ts` declares the shape structurally rather than
 *  importing the sim's type. */
const ENTRIES: HitEventEntry[] = LINEUP.entries;

export const MOCK_SEED = Buffer.from(
  Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff),
);

const FULL = runFullFight(MOCK_SEED, ENTRIES, MAX_STEPS);

/** The whole fight, precomputed — exactly what the real provider hands the canvas. */
export const MOCK_HIT_EVENTS: HitEvent[] = FULL.events;

export const MOCK_FIGHTER_SEEDS = ENTRIES.map((e, id) => ({
  id,
  wallet: e.wallet,
  short: shortKey(e.wallet),
  name: nameFor(e.wallet),
  side: e.side,
  stake: e.stake,
  isYou: e.wallet === MOCK_YOU,
}));

/** Replays the event stream up to `step` and returns the rosters as they stand at that moment —
 *  which is how the fixture's fighter tables and health bars move while a reviewer watches. */
export function mockFightersAt(step: number): FighterView[] {
  const state = MOCK_FIGHTER_SEEDS.map((f) => ({ hp: f.stake, banked: 0n, dead: false }));
  for (const ev of MOCK_HIT_EVENTS) {
    if (Number(ev.step) > step) break;
    const a = state[ev.attackerId];
    const d = state[ev.defenderId];
    if (!a || !d) continue;
    d.hp -= ev.amount;
    a.banked += ev.amount;
    if (d.hp <= 0n) {
      d.hp = 0n;
      d.dead = true;
    }
  }
  return MOCK_FIGHTER_SEEDS.map((f, i) => ({
    ...f,
    hp: state[i].hp,
    banked: state[i].banked,
    dead: state[i].dead,
  }));
}

// ---------------------------------------------------------------------------------------------
// Past rounds
// ---------------------------------------------------------------------------------------------

/** How big a PAST round was. It has to scale with `?fighters=<n>` too, and this is not cosmetic:
 *  History's expanded round detail, the round standings, `deriveStandings`/`deriveHall` and the
 *  Dashboard's fighter facts all read `MOCK_HISTORY`, not the live round. Leaving this pinned at
 *  4..9 meant `?fighters=16` stressed the arena and the live roster and NOTHING else — every table
 *  that renders a past lineup would still have been quietly testing nine, which is exactly the false
 *  negative this whole exercise exists to avoid.
 *
 *  The floor is 4, or the whole lineup when the lineup is smaller than that — at `?fighters=2` every
 *  past round is a duel, which is the truth about a two-fighter arena. Note that the shape at the
 *  default is unchanged: `LINEUP = 9` gives `4 + floor(r() * 6)`, the original expression exactly,
 *  drawing exactly one number off the stream as before. */
const PAST_ROUND_FLOOR = Math.min(4, LINEUP.entries.length);
const PAST_ROUND_SPREAD = LINEUP.entries.length - PAST_ROUND_FLOOR + 1;

function mockRound(roundNo: number, r: () => number): RoundSummary {
  const n = PAST_ROUND_FLOOR + Math.floor(r() * PAST_ROUND_SPREAD);
  const players: RoundPlayer[] = [];
  // ONE ENTRY PER WALLET PER SIDE, keyed exactly as `enter` keys it — see the merge below.
  const bySeat = new Map<string, RoundPlayer>();
  let pot = 0n;
  for (let i = 0; i < n; i++) {
    // Two thirds of the field are recurring faces, so the all-time table has real repeat players in
    // it rather than a fresh cast every round.
    const wallet = r() < 0.66 ? MOCK_WALLETS[Math.floor(r() * MOCK_WALLETS.length)] : fakeWallet(r);
    const side = (i % 2) as Side;
    const stake = usdToUnits(Math.round(5 + r() * 95));
    const mult = r() < 0.18 ? 0 : 0.35 + r() * 1.9;   // ~18% of entries wipe out entirely
    const final = BigInt(Math.round(Number(stake) * mult));

    // A REPEAT TOPS UP; IT DOES NOT SPAWN A SECOND FIGHTER — `lib.rs`'s `enter`:
    //
    //     .find(|f| f.wallet == who && f.side == side)   // then f.stake += net; f.hp += net
    //
    // The draw above picks recurring wallets WITH REPLACEMENT, so it was producing rounds in which
    // the same wallet held two separate seats on one side. The chain cannot represent that — a
    // second `enter` from a wallet already on that side merges into the row it already has — so the
    // fixture was rendering a round shape the program forbids, and `deriveStandings`/`deriveHall`
    // were counting one wallet twice in a single round while computing its record.
    //
    // Note the key includes SIDE, because the program's does. One wallet on BOTH sides is legal on
    // chain (two `Fighter` entries, different `side`) and stays legal here — hedging both camps is a
    // real thing a player can do, and flattening it would be a different lie.
    //
    // The generator is untouched: the same numbers are drawn in the same order and the pot is
    // unchanged. Only the ASSEMBLY differs, so rounds without a collision are byte-identical to what
    // this function produced before.
    const seat = `${wallet}/${side}`;
    const held = bySeat.get(seat);
    if (held) {
      held.stake += stake;
      held.final += final;
      held.pnl = held.final - held.stake;
      held.dead = held.final === 0n;
    } else {
      const player: RoundPlayer = {
        wallet,
        short: shortKey(wallet),
        name: nameFor(wallet),
        side,
        stake,
        final,
        pnl: final - stake,
        dead: final === 0n,
        isYou: wallet === MOCK_YOU,
      };
      bySeat.set(seat, player);
      players.push(player);
    }
    pot += stake;
  }
  let a = 0n;
  let b = 0n;
  for (const p of players) {
    if (p.side === 0) a += p.final;
    else b += p.final;
  }
  return {
    roundNo: BigInt(roundNo),
    phase: "Settled",
    winner: a >= b ? 0 : 1,
    pot,
    fighterCount: players.length,
    tickCount: BigInt(1200 + Math.floor(r() * 2800)),
    // Zero because nobody extracted: these rounds are drawn from a distribution of outcomes, not
    // replayed from a seed, so there is no extraction in them for the house to have taken a cut of.
    // A non-zero figure here would be a fabricated house take sitting in a column a reader is meant
    // to be able to check against a round account.
    penaltiesCollected: 0n,
    // Zero for a sharper reason than the penalty's: `pot` above is accumulated from the stakes this
    // generator hands out directly, with no `enter()` anywhere to have charged anything. So these
    // stakes ARE the gross, and a fee here would not be an unverifiable figure — it would be a false
    // one, claiming money that no player in this fixture was ever charged.
    feesCollected: 0n,
    players,
  };
}

const histRnd = lcg(4242);
export const MOCK_HISTORY: RoundSummary[] = Array.from({ length: 16 }, (_, i) =>
  mockRound(16 - i, histRnd),
);

// `deriveStandings`/`deriveBigWins`/`deriveHall` used to live here. They now live in `roundLog.ts`
// and are shared: the fixture's rounds and devnet's rounds are the same `RoundSummary[]` shape, so
// aggregating them twice was two chances to disagree about what a standing means. Nothing about the
// fixture's data changed — only where the arithmetic over it lives.
