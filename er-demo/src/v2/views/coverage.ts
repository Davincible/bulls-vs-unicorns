// HOW A SCREEN SAYS WHAT A FIGURE COVERS — one sentence, built once.
//
// `standings`, `hall`, `bigWins`, `sideRecord` and every aggregate the three data screens compute
// themselves come off `history.rounds`, which is the NEWEST N round accounts and short a round
// wherever a read failed. All three screens said "all-time" over that window; `LogCoverage` is the
// fact that makes the claim checkable, and this is the wording of it.
//
// IT LIVES IN ONE MODULE BECAUSE IT IS ONE CLAIM. 01, 02 and 04 each caption several figures with it
// — the dashboard alone does so eight times — and three hand-written variants of "across N logged
// rounds" is exactly how one screen ends up saying "all-time" a release after the others stopped.
// The phrase is data-dependent in a way a constant string cannot be: when the log genuinely holds
// every round the arena ever opened, "all time" is TRUE and refusing to say so is its own small
// dishonesty, so `complete` is allowed to license the words the rest of the time it forbids.

import type { LogCoverage } from "../contract.ts";

function rounds(n: number): string {
  return `${n} ${n === 1 ? "round" : "rounds"}`;
}

/** The caption a figure carries: `across all 12 rounds this arena has run`, `across the newest 250
 *  of 613 rounds`, or `across 12 logged rounds` when the denominator is unknown.
 *
 *  Reads as a phrase, not a sentence — every call site is appending it to something ("Where the money
 *  went, …"), so it starts lowercase and carries no full stop. */
export function coveragePhrase(c: LogCoverage): string {
  if (c.complete) return `across all ${rounds(c.rounds)} this arena has run`;
  if (c.roundsEverOpened !== null) {
    return `across the newest ${c.rounds} of ${c.roundsEverOpened} rounds this arena has run`;
  }
  // No denominator: the page has not read the arena account, or is on the fixture's invented log.
  // State what was counted and claim nothing about what it is a fraction of.
  return `across ${rounds(c.rounds)} in the log`;
}

/** The same fact as a figure for a metadata line: `12 of 613`, or `12` when nothing can be compared
 *  against. Never `12 of 12` when the log is complete — that reads as a coincidence rather than as
 *  the whole history, and `coverageNote` is what explains which one it is. */
export function coverageFigure(c: LogCoverage): string {
  if (c.complete || c.roundsEverOpened === null) return `${c.rounds}`;
  return `${c.rounds} of ${c.roundsEverOpened}`;
}

/** The tooltip behind `coverageFigure` — the one place the window is explained rather than merely
 *  stated, so the figure beside it can stay a figure. */
export function coverageNote(c: LogCoverage): string {
  if (c.complete) {
    return `Every round this arena has opened is in the log, so the aggregates on this screen genuinely are all-time.`;
  }
  if (c.roundsEverOpened !== null) {
    return `The page reads back the newest round accounts only. ${c.roundsEverOpened - BigInt(c.rounds)} older ${c.roundsEverOpened - BigInt(c.rounds) === 1n ? "round is" : "rounds are"} still on chain and are not counted in anything on this screen.`;
  }
  return `How many rounds this arena has opened is not known here, so the aggregates on this screen cannot be called all-time — they are counted over the ${rounds(c.rounds)} in the log and no more.`;
}
