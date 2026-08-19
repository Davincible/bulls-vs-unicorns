// WHAT THE HEADER'S WALLET CELL DOES WHEN IT IS PRESSED.
//
// THE FAULT THIS ANSWERS, verbatim from an operator: "Wallet not connected at the top in the header
// should be clickable, it should connect the wallet". It was a `<span>`. The one cell on the page
// that never scrolls away, saying the one thing standing between a visitor and playing, and it did
// nothing at all when pressed.
//
// WHY THIS IS A MODULE AND NOT AN `onClick` WITH A TERNARY IN IT. The rail already renders the real
// answer — `ConnectCta` in `ConnectPanel.tsx` is the single place that knows how a `PlayBlockCta`
// becomes a control, and it renders a wide labelled button, an external link, or a reload. A 30px
// black strip can host none of those: there is room for a status cell and nothing else, and the cell
// must keep saying what it says today ("Wallet NOT CONNECTED") rather than growing a label. So the
// header needs its OWN verdict — a smaller question than `playGate` answers, asked of the same
// object, and answerable without a DOM. That makes it testable, which is the point.
//
// THE RULE, AND THE ONE CASE IT SAYS YES TO. `connect` is the only `PlayBlockCta` kind where a
// single press genuinely finishes the job: `wallet.connect()` opens Phantom and there is nothing
// else the reader needs to have read first. Every other kind needs either a DESTINATION or an
// EXPLANATION that this strip cannot carry:
//
//   install — leaves the page for phantom.app. A press that silently opened a new tab from a status
//             cell would be a popup, not a control; the rail's `ConnectCta` renders it as an
//             `<a>` whose accessible name says it opens elsewhere, which is where it belongs.
//   faucet  — same, for faucet.solana.com, and with a paragraph beside it explaining why a wallet
//             showing a healthy balance can still read as zero here.
//   retry   — reloads the page. Destroying a reader's page from an unlabelled cell in the chrome is
//             the most destructive thing on this list and the one most deserving of the sentence
//             that sits next to it in the rail.
//   null    — there is no route out to offer at all (`connecting`, `no-program`). Both clear on
//             their own, and both have a panel that says so.
//
// So everything that is not `connect` opens the rail, which is one press from every screen and
// already holds the real control. Nothing here duplicates that control; it routes to it.

import type { PlayBlockCta } from "../data/playGate.ts";

/** `connect` starts the connect handshake; `open-rail` shows the panel that holds the real cta. */
export type HeaderWalletAction = "connect" | "open-rail";

/**
 * The verdict for the header's wallet cell, from the gate's own cta.
 *
 * `undefined` is accepted alongside `null` because the caller reaches this through `gate?.cta`, and
 * an optional chain over a null gate yields `undefined` while a gate with no route out yields
 * `null`. They mean the same thing here — no single press finishes the job — and making the caller
 * normalise them would be one more place to get it wrong for no gain.
 */
export function headerWalletAction(cta: PlayBlockCta | null | undefined): HeaderWalletAction {
  return cta?.kind === "connect" ? "connect" : "open-rail";
}
