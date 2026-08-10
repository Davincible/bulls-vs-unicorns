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

import { useState } from "react";
import { DEVNET_ONLY_NOTE, type PlayBlock } from "../data/playGate.ts";
import { useArena } from "../data/useArena.ts";
import { useLinks } from "../data/useLinks.ts";
import { FAILURE_COPY, LINKED_COPY, UNLINKED_COPY } from "../data/xConsent.ts";
import { asSentence } from "./roundPhaseCopy.ts";
import { linkedDateText } from "./linkedDate.ts";
import { XIdentity } from "./XIdentity.tsx";
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

// =================================================================================================
// THE X IDENTITY BLOCK — the second tenant of this file, and the same bargain as the first.
// =================================================================================================
//
// IT LIVES DIRECTLY UNDER THE WALLET ADDRESS because the link is ABOUT the wallet (`SOCIAL.md`
// §4.0). A player asking "what does this site know about me" is looking at their key; the answer
// belongs in the same breath, not four blocks down under a heading they have to go and find.
//
// IT WRITES NO COPY, exactly as `ConnectPanel` above it writes none. Every sentence comes from
// `data/xConsent.ts`, where the claims can be reviewed next to the code that makes them true —
// `REVOCATION_COPY`'s numbers are derived from `useLinks.ts#REFRESH_MS` and the avatar cache header
// for precisely that reason. If a state reads badly, the fix is in that file.
//
// THERE ARE THREE STATES AND THE THIRD ONE IS NOT AN ERROR SCREEN.
//
//   off      — `?links=` is unset, which is the default and the shipping configuration. NOTHING is
//              rendered. Stage 3 does not exist, and a `Connect X` button that cannot connect is
//              worse than no button: this page's own account of the in-page airdrop makes the same
//              argument, and it is right.
//   unlinked — the control and the invitation. Once, here, and nowhere else on the page: there is no
//              per-row nag on the leaderboard and there never may be (`TWITTER-CONNECT.md` §8).
//   linked   — the face at 24px, the `@handle`, when it was linked, `Unlink`, and the sentence that
//              disconnecting a wallet is NOT unlinking. That last one is not a nicety. It is the
//              natural wrong assumption, and its consequence — your face keeps appearing on a board
//              you think you have left — is exactly the class of surprise this page refuses.
//   failed   — the reason and `Try again`. THERE IS NO HANDLE-ENTRY FALLBACK and there is nowhere to
//              put one: `LinkRequest` has no `handle` field. The old build answered every OAuth
//              failure with `prompt("Your X handle")` and wrote the answer through the same message
//              as a proven one, which is the defect this entire feature exists to delete.
//
// NOTHING HERE IS GATED ON `loading`, except the one thing it exists for. `useLinks`' own contract:
// it must never gate anything, and it is there so this panel does not flash "not connected" at
// somebody who is. So the FIRST fetch renders nothing at all rather than a `Connect X` button that
// is about to be replaced by a face. Every other surface renders straight through it.

// WHAT BOTH CONTROLS DO TODAY, and it is the same thing: say so. Stage 3 — the OAuth start,
// callback, challenge and link endpoints — does not exist, so neither `Connect X` nor `Unlink` can
// run a ceremony, and this panel does not invent one, does not fake a request it never sent, and
// does not report a failure that did not happen. `FAILURE_COPY.notBuilt` is that sentence, and it
// lives in `xConsent.ts` with the rest of the copy, flagged there as provisional. When the ceremony
// lands, these two `onClick`s are where it goes and the rest of this component is unchanged.

export function XLinkPanel() {
  const { source, you, loading } = useLinks();
  /** What the last press produced, or null for "nothing has been pressed". A STRING rather than a
   *  boolean so that when the ceremony arrives this is already the shape it needs — one reason out
   *  of `FAILURE_COPY`, rendered — instead of a flag somebody has to widen. */
  const [failure, setFailure] = useState<string | null>(null);

  // The feature is off, which is the default and the deployed state. Not "disabled", not "coming
  // soon" — absent. See this block's header.
  if (source === "off") return null;
  // The only thing `loading` is allowed to do anywhere in this program.
  if (loading && you === null) return null;

  if (you !== null) {
    const linkedOn = linkedDateText(you.linkedAt, Date.now());
    return (
      <div className="xl" data-testid="x-link-panel" data-state={failure === null ? "linked" : "failed"}>
        {/* 24px, which is the largest an avatar may be on the DOM outside the fighter inspector.
            `SOCIAL.md` §4.6: size is the discipline that keeps a colour photograph honest on a page
            whose only other colour is the two sides. */}
        <XIdentity link={you} size={24} />
        <div className="line xl-line">
          {/* Withheld rather than faked when the timestamp is unusable — `linkedDateText` returns
              null and this prints nothing, instead of asserting "linked 1 Jan 1970" as a fact. */}
          {linkedOn === null ? null : (
            <span className="u">
              Linked · <span className="u--ink">{linkedOn}</span>
            </span>
          )}
          <button type="button" className="btn btn--sm btn--ghost push" onClick={() => setFailure(FAILURE_COPY.notBuilt)}>
            {failure === null ? LINKED_COPY.unlink : FAILURE_COPY.retry}
          </button>
        </div>
        {/* THE IDENTITY STAYS ON SCREEN THROUGH THE FAILURE, and that is correctness rather than
            layout: the unlink did not happen, so a panel that removed the face would be showing the
            outcome of the thing that just failed. */}
        {failure === null ? (
          <p className="lede xl-note">{LINKED_COPY.disconnectIsNotUnlink}</p>
        ) : (
          <p className="lede xl-note" role="alert">
            {failure}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="xl" data-testid="x-link-panel" data-state={failure === null ? "unlinked" : "failed"}>
      {/* ONE BUTTON ACROSS BOTH STATES, in the same slot, and that is a focus decision rather than a
          tidy one. Rendering a separate `Try again` control would unmount the button the reader just
          pressed and drop focus to the top of the document — the exact defect `useFocusTrap.ts` was
          written against. Same element, same position, new label. */}
      <button type="button" className="btn btn--sm btn--wide" onClick={() => setFailure(FAILURE_COPY.notBuilt)}>
        {failure === null ? UNLINKED_COPY.action : FAILURE_COPY.retry}
      </button>
      {failure === null ? (
        <>
          <p className="lede xl-note">{UNLINKED_COPY.invitation}</p>
          {/* Said quietly and always. It is what makes not linking a CHOICE rather than a gap, and
              it is the reason there is no nudge, no modal and no disabled control anywhere else:
              play is never gated on this. */}
          <p className="lede xl-note">{UNLINKED_COPY.optional}</p>
        </>
      ) : (
        <p className="lede xl-note" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
