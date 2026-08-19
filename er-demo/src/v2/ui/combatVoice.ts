// THE FIGHT, IN WORDS. Pure functions only — no React, no context, no clock — so the hard part
// (what a burst of exchanges should SAY) is testable without a browser.
//
// IT DERIVES NOTHING. `data/combatFeed.ts` cuts the window and resolves each `HitEvent` into a
// `CombatEvent` once, centrally, and publishes it as `useArena().combat`; this file only turns those
// into sentences. That division is the point — an earlier draft of this module carried its own
// `resolveCombat`, which meant every consumer walking the same stream with its own cursor four times
// a second, each free to get "which of these have I already seen" subtly differently.
//
//   · `CombatLog.tsx`  a surface. Everything, on the page, read at the reader's own pace.
//   · `useCombatVoice` an interruption. Only what involves you, and only at a rate a person can
//                      follow — see `COALESCE_MS` for the arithmetic behind the number.
//
// WHY A THROTTLE EXISTS AT ALL. The original game (web/index.html) narrated the fight continuously
// and carried its own flood defence — a nine-deep ring buffer, of which it drew five. That was a
// 50ms tick with one hit per tick; this program runs `stepsPerSecond(n) = n * 2`, so a full
// sixteen-fighter lobby produces ~32 exchanges a second and a ring buffer is nowhere near enough.
// Nothing below narrates an exchange it has not first decided is worth a person's attention.

import { ONE_CENT_UNITS, SIDE_TOKEN, usdCompact, type CombatEvent, type FighterView } from "../contract.ts";
import { namePlate, plateText } from "../data/namePlate.ts";
import type { LinkMap } from "../data/xLink.ts";
import type { ToastKind } from "../data/types.ts";

/** One thing the page says out loud, in the toast rail's own vocabulary. `kind` is `useToasts.ts`'s
 *  existing `ToastKind` and nothing else — the fight does not get a private set of colours. */
export interface VoiceLine {
  text: string;
  kind: ToastKind;
}

/** HOW LONG A BURST IS ALLOWED TO ACCUMULATE BEFORE IT IS SAID, in ms. This is the throttle, and the
 *  number is arithmetic rather than taste:
 *
 *    · A toast lives 6,000ms (`useToasts.ts`'s `DISMISS_MS`) and the stack holds 5 (`MAX_VISIBLE`).
 *    · This module emits AT MOST ONE LINE PER DIRECTION per window — one for what you took off
 *      somebody, one for what somebody took off you — so a window costs at most 2 lines.
 *    · 6,000 / 3,000 = 2 windows alive at once, so at most 4 commentary lines are on screen, and the
 *      fifth slot is always free for the thing that actually matters: a deploy, an extract, or an
 *      error. THE FIGHT MUST NEVER PUSH A TRANSACTION OFF THE SCREEN. (`ToastRail.tsx` hardens the
 *      same guarantee structurally, by keeping the two lists apart; this is what makes the visual
 *      density defensible even so.)
 *
 *  WHAT IT IS PROTECTING AGAINST, measured against the program rather than guessed: a sixteen-fighter
 *  lobby runs at `stepsPerSecond(16) = 32` exchanges a second, of which you are a party to roughly
 *  `2/n` — about four a second. Four a second against a six-second toast is twenty-four lines
 *  competing for five slots, i.e. a stack that turns over completely three times before a reader has
 *  finished the first line. A two-fighter duel is the same problem from the other end: 4 steps/sec
 *  and every one of them is yours.
 *
 *  Three seconds is also the shortest window in which the SUM is more informative than the parts. A
 *  single late-fight raid is dust; three seconds of them is a number a player can act on. */
export const COALESCE_MS = 3_000;

/** BELOW THIS, A WINDOW IS NOT WORTH INTERRUPTING ANYBODY FOR. The damage roll is a percentage of
 *  remaining hp, so a fight's closing stretch is thousands of sub-cent exchanges — narrating them
 *  would spend the whole throttle budget on `<$0.01` and drown the moments that matter. It is the
 *  page's own cent floor (`contract.ts`'s `ONE_CENT_UNITS`), not a new threshold: anything this page
 *  would print as a bound rather than a figure is not news. The exchanges are still all in the log. */
const VOICE_FLOOR_UNITS = ONE_CENT_UNITS;

function sideKind(side: 0 | 1): ToastKind {
  return side === 0 ? "a" : "b";
}

/** WHAT A WINDOW OF YOUR OWN EXCHANGES SAYS — at most one line per direction, never more.
 *
 *  `events` is everything that crossed the playhead in the last `COALESCE_MS` in which you were a
 *  party. Everything that is not yours has already been filtered out by the caller: `CombatEvent.mine`
 *  is documented as "what a toast filter keys on", and this is that filter's other half.
 *
 *  THE COPY IS THE ORIGINAL'S, IN THIS PAGE'S REGISTER. web/index.html said "You raided $4.10 from
 *  turboTina!" and "gigaGwei hit you for $2.80!"; the exclamation marks and the emoji belong to that
 *  product's voice and not to this one, but the grammar — you as the subject when you are winning,
 *  the opponent as the subject when you are not — is what made it feel like the fight was happening
 *  to somebody, and that survives verbatim. Figures are `usdCompact`: a toast is a 520px box, and
 *  the exact number is in the log two sections up. */
export function commentary(events: CombatEvent[], links: LinkMap): VoiceLine[] {
  const out: VoiceLine[] = [];
  for (const dir of ["out", "in"] as const) {
    const slice = events.filter((e) => (dir === "out" ? e.attacker.isYou : e.defender.isYou));
    if (slice.length === 0) continue;

    let total = 0n;
    const others = new Set<string>();
    let biggest: CombatEvent | null = null;
    for (const e of slice) {
      total += e.amount;
      others.add(dir === "out" ? e.defender.wallet : e.attacker.wallet);
      if (biggest === null || e.amount > biggest.amount) biggest = e;
    }
    if (total < VOICE_FLOOR_UNITS || biggest === null) continue;

    // The name to print when there is one. With several opponents the count carries more than any
    // one name would, so the line reports the spread instead of picking a favourite.
    const alone = others.size === 1;
    const other = dir === "out" ? biggest.defender : biggest.attacker;
    const money = usdCompact(total);
    // THE SAME NAME SLOT AS EVERY OTHER SURFACE, resolved through the one module that decides it —
    // `@handle` where the opponent proved one, their truncated address where they did not. It used
    // to be `nameFor()`'s pseudonym, and a toast is the surface where an invented name is least
    // checkable: it is gone in five seconds and there is no key beside it to check it against.
    //
    // `"unmarked"`, ALWAYS: this line's grammar already puts the reader in it as "you", so the
    // opponent is never the reader and there is no orientation for the slot to do. Passing a `you`
    // cue here would put `YOU` on both sides of a sentence about two fighters.
    const otherName = plateText(namePlate(links, other.wallet, "unmarked"), other.short);

    if (dir === "out") {
      out.push({
        kind: sideKind(biggest.attacker.side),
        text: alone
          ? slice.length === 1
            ? `You raided ${money} off ${otherName}`
            : `You raided ${money} off ${otherName} · ${slice.length} raids`
          : `You raided ${money} · ${slice.length} raids on ${others.size} fighters`,
      });
    } else {
      out.push({
        kind: sideKind(biggest.attacker.side),
        text: alone
          ? slice.length === 1
            ? `${otherName} hit you for ${money}`
            : `${otherName} hit you for ${money} · ${slice.length} hits`
          : `You took ${money} · ${slice.length} hits from ${others.size} fighters`,
      });
    }
  }
  return out;
}

/** YOUR FIGHTER IS OUT — the one mid-fight event that is a moment rather than a rate, so it never
 *  waits for a window and never coalesces with anything.
 *
 *  It says what survived, because that is the whole difference between the two intents the page
 *  offers: banked value is out of the ring and cannot be taken, ring value cannot be recovered. A
 *  player who has been extracting deserves to be told the extraction worked at the exact moment the
 *  fighter dies, and a player who has not deserves to be told plainly what Mayhem just cost. */
export function deathLine(you: FighterView): VoiceLine {
  return {
    kind: "error",
    text:
      you.banked > 0n
        ? `Your fighter is out — ${usdCompact(you.banked)} banked stays yours, the ring is gone`
        : "Your fighter is out — nothing was banked, and the ring is gone",
  };
}

/** THE ROUND'S ANSWER, once. Not a duplicate of the settled plate on the field: the plate is a
 *  description that sits there, this is the notification that the thing a player was waiting for has
 *  happened, which may well be while they are scrolled into a table two screens down. */
export function resultLine(winner: 0 | 1, you: FighterView | null, pnl: bigint | null): VoiceLine {
  const head = `${SIDE_TOKEN[winner].name} takes the round`;
  if (you === null || pnl === null) return { kind: sideKind(winner), text: head };
  const sign = pnl < 0n ? "−" : "+";
  const magnitude = usdCompact(pnl < 0n ? -pnl : pnl);
  return {
    kind: sideKind(winner),
    text: `${head} — you finished ${pnl === 0n ? "level" : `${sign}${magnitude}`}`,
  };
}
