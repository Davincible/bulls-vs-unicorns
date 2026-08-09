// THE ONE PLACE A `PlayBlock` BECOMES UI — the funnel, rendered.
//
// `data/playGate.ts` already answered the only question that matters ("why can't I press this, and
// what would make it pressable"), and it answered it ONCE so that six surfaces cannot answer it six
// ways. This file is the other half of that bargain: it renders that answer, and it does not write
// copy of its own. If a state reads badly on screen, the fix belongs in `playGate.ts` or
// `walletFault.ts`, never here — the moment this component starts composing its own sentences there
// are two sources of truth again and one of them is going stale.
//
// TWO DENSITIES, ONE COMPONENT, for the same reason `RoundPhaseNote` has two: the rail has a column
// to explain things in and the dock has a corner. Both must say the same thing, so they render the
// same object rather than two texts that happen to agree today.
//
// THE CTA IS A REAL CONTROL, not a sentence telling someone to go and find one. A block that says
// "connect your wallet" while the connect button lives on another surface is the disabled-control
// bug wearing a different hat — `playGate` guarantees every block carries a route out, and this
// renders that route as the thing you press.

import { DEVNET_ONLY_NOTE, type PlayBlock } from "../data/playGate.ts";
import { useArena } from "../data/useArena.ts";
import { asSentence } from "./roundPhaseCopy.ts";
import "./ConnectPanel.css";

/** The waiting states worth telling a screen reader about, and the resting ones that are not.
 *
 *  `connect-failed` is the only ALERT: something the reader did has just failed and the page is
 *  asking them to do it again, which is the one case that earns an interruption.
 *
 *  `connecting` and `no-program` are POLITE: both are transient, both end on their own, and both
 *  answer "is this thing working?" — the question a reader who cannot see a spinner is actually
 *  asking.
 *
 *  Everything else gets NO live region at all, and that is a deliberate reading of the brief rather
 *  than an omission. `not-connected` is this page's resting state for every visitor who has not
 *  connected yet: it is present from the first paint, it never changes, and it is inserted into the
 *  accessibility tree again every single time the rail is opened. A polite region there does not
 *  interrupt, but it does queue the same paragraph on every open, which is noise standing in front
 *  of the thing the reader just asked to see. The panel is still read normally, in reading order,
 *  where they went looking for it. */
function liveRole(code: PlayBlock["code"]): "alert" | "status" | undefined {
  if (code === "connect-failed") return "alert";
  if (code === "connecting" || code === "no-program") return "status";
  return undefined;
}

export interface ConnectPanelProps {
  block: PlayBlock;
  /** `"full"` is the rail's column; `"compact"` is the dock's corner. Same words, tighter setting. */
  density: "full" | "compact";
}

export function ConnectPanel({ block, density }: ConnectPanelProps) {
  const { wallet } = useArena();
  const { cta } = block;
  const connecting = wallet.status === "connecting";

  // ONE COPY OF THE NETWORK STATEMENT PER PANEL, decided by looking rather than by remembering.
  //
  // `playGate.ts` embeds `DEVNET_ONLY_NOTE` in the two blocks where it is part of the pitch (the
  // first thing a visitor reads on `not-installed` and `not-connected`). Every other block does not
  // carry it, and it is the one statement about this page that is correct 100% of the time — with no
  // way to read a wallet's cluster, saying which network we are on unconditionally is the whole
  // mitigation. So it is appended here when it is missing.
  //
  // The check reads the rendered string instead of listing the two codes that embed it today. A list
  // would be a second place that has to agree with `playGate.ts`, and it would agree right up until
  // someone added the note to a third block and shipped it twice.
  const noteAlreadySaid = block.detail.includes(DEVNET_ONLY_NOTE);

  return (
    <div
      className={`cx cx--${density}`}
      data-testid="connect-panel"
      data-block={block.code}
      role={liveRole(block.code)}
    >
      <p className="cx-now">{asSentence(block.short)}</p>
      <p className="lede cx-detail">{block.detail}</p>

      {cta === null ? null : cta.kind === "connect" ? (
        <button
          type="button"
          className="btn btn--fill btn--wide cx-cta"
          data-testid="connect-cta"
          disabled={connecting}
          onClick={() => void wallet.connect()}
        >
          {/* The disabled state says what it is waiting for. A greyed button labelled "Connect
              Phantom" is indistinguishable from a broken one. */}
          {connecting ? "Waiting for Phantom…" : cta.label}
        </button>
      ) : cta.kind === "retry" ? (
        <button
          type="button"
          className="btn btn--fill btn--wide cx-cta"
          data-testid="connect-cta"
          onClick={() => window.location.reload()}
        >
          {cta.label}
        </button>
      ) : (
        // `install` and `faucet` — the two that leave the page. `.btn` is worn by an `<a>` elsewhere
        // on this page already (ReferralsView), so this is the established shape rather than a new
        // one. The accessible name CONTAINS the visible label (WCAG 2.5.3, Label in Name) and adds
        // the one fact the visible label cannot carry: that this opens somewhere else.
        <a
          className="btn btn--fill btn--wide cx-cta"
          data-testid="connect-cta"
          href={cta.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${cta.label} — opens in a new tab`}
        >
          {cta.label}
        </a>
      )}

      {/* THE ASIDE IS THE RAIL'S ALONE, and dropping it in the dock is safe BY CONTRACT: `playGate`
          guarantees everything a player must DO lives in `detail`, so an `aside` can never be the
          missing instruction (`playGate.test.ts` asserts it). The dock is a 320px corner over a live
          round — it gets the claim, the remedy and the button. The rail has the column to explain
          the thing a subset of readers are confused by, and it is set below the control because it
          is context for a decision already made, not part of making it. */}
      {density === "full" && block.aside !== undefined ? (
        <p className="lede cx-aside">{block.aside}</p>
      ) : null}

      {noteAlreadySaid ? null : <p className="u cx-net">{DEVNET_ONLY_NOTE}</p>}
    </div>
  );
}
