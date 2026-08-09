// HOW A SURFACE STATES THE ENTRY FEE — and what it says in the window where nothing has told it the
// rate yet.
//
// `fee_bps` is read off the Arena account (`data/useChain.ts`) on the poll that was already running,
// so the rate on screen follows `set_fee_bps` within seconds and without a build. Before that first
// read lands — and after one that failed — there is no chain value, and `FeeRate.known` is false.
// This module is the difference between the two, in words.
//
// IT IS ONE MODULE BECAUSE IT IS ONE CLAIM, exactly as `coverage.ts` is for `LogCoverage`. Six
// surfaces render this rate: the intro overlay, the dock's price line, 00-3's lede, the dashboard
// tile, and two figures on the referrals screen. Six hand-written hedges is how one of them ends up
// stating the fallback flat — which is the defect this whole path exists to close, and it has already
// happened once at production scale (see `FEE_BPS`).
//
// THE RULE IS NOT THE SAME ON EVERY SURFACE, deliberately:
//
//   · A STANDALONE FIGURE — the dashboard's "Fee at the door", the referrals KV — renders `—` when
//     the rate is unread. That is UI-SPEC's rule for an unbacked figure, and it is precisely what
//     "Rounds opened" does two tiles from the fee tile, off the same unread account.
//   · PROSE THAT HAS TO SAY SOMETHING — the takeover a first-time player reads before anything else,
//     the deploy lede, the dock's fee line — keeps the figure and marks it. "The arena deducts —% on
//     entry" teaches a newcomer nothing; "the arena deducts 1%" before reading the account is the
//     original defect in a smaller font. `feePhrase` is the third answer: the number, and the fact
//     that nobody has confirmed it.
//
// Every call site pairs its figure with `feeNote` as a `title`, so the short marker never has to
// carry the explanation on its own.

import { REFERRAL_SHARE_PCT, bpsPct, type FeeRate } from "../contract.ts";

/** The rate as a standalone figure, or `null` when nothing has stated it — callers render `<Dash/>`,
 *  never a number. */
export function feeFigure(fee: FeeRate): string | null {
  return fee.known ? bpsPct(fee.bps) : null;
}

/** The rate inside a sentence: `1%`, or `1% (not yet read)` before the arena account has answered.
 *
 *  The marker is four plain words rather than a symbol or a piece of jargon because the surface most
 *  likely to render it is the one a first-time player reads first, and "not yet read" is a state a
 *  reader can act on (wait a second) without knowing what an account is. It is terminal in the
 *  parenthesis so it drops into any slot a bare figure fits. */
export function feePhrase(fee: FeeRate): string {
  return fee.known ? bpsPct(fee.bps) : `${bpsPct(fee.bps)} (not yet read)`;
}

/** The tooltip behind either of the above — the one place the mechanism is explained, so the figure
 *  beside it can stay a figure. */
export function feeNote(fee: FeeRate): string {
  if (fee.known) {
    return `The arena's own fee_bps, read off the account and re-read every few seconds. The authority can move it with set_fee_bps at any time and this figure follows within seconds, with no redeploy — so it is what the chain is charging now, not what this build was written against.`;
  }
  return `The arena account has not been read yet, so the live rate is not known here. ${bpsPct(fee.bps)} is the figure this build ships with as its pre-read default — what the arena carried when the build was cut, not a reading of what it is charging now.`;
}

/** WHAT "10% OF THE HOUSE FEE" IS ACTUALLY WORTH, on a deploy a player can hold in their head.
 *
 *  The referrals screen quotes the two rates as percentages of each other, and two percentages
 *  multiplied is the one arithmetic no reader does in their head correctly. Priced instead — and
 *  priced FROM THE LIVE RATE, so the worked example moves when the door does. Its predecessor was a
 *  pair of module constants folded against `FEE_BPS` at build time, under a comment that spelled the
 *  answer out in prose ("10% of 0.20% is two hundredths of one percent") — which was already wrong
 *  by the time it was read, in the same way and for the same reason as everything else on this path.
 *
 *  Dollars, matching the ledger this screen reports; the view prices them through `usd()` like every
 *  other figure. A zero rate gives two honest zeros and nothing divides by anything. */
export function referralExample(fee: FeeRate, deployUsd: number): {
  houseFeeUsd: number;
  shareUsd: number;
} {
  const houseFeeUsd = (deployUsd * fee.bps) / 10_000;
  return { houseFeeUsd, shareUsd: (houseFeeUsd * REFERRAL_SHARE_PCT) / 100 };
}
