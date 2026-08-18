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
import { useXCeremony } from "../data/useXCeremony.ts";
import { FAILURE_COPY, LINKED_COPY, UNLINKED_COPY } from "../data/xConsent.ts";
import { XConsentDialog, XRevokeDialog } from "./XConsentDialog.tsx";
import { asSentence } from "./roundPhaseCopy.ts";
import { linkedDateText } from "./linkedDate.ts";
import { XIdentity } from "./XIdentity.tsx";
import "./ConnectPanel.css";

/** The waiting states worth telling a screen reader about, and the resting ones that are not.
 *
 *  `connect-failed` and `connect-stalled` are the ALERTS. In both, something the reader did has
 *  stopped going anywhere and the page is asking them to act, which is the one case that earns an
 *  interruption. `connect-stalled` earns it for a sharper reason than its neighbour: the reader has
 *  been sitting under a POLITE "waiting for you to approve" for twenty seconds — a sentence that is
 *  read once and then never again — and the thing it told them to wait for is not happening. If the
 *  correction arrived politely too, it would queue behind whatever else the page has said and a
 *  reader with no popup on screen would go on waiting for one.
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
  if (code === "connect-failed" || code === "connect-stalled") return "alert";
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
  // carry it, so an appended copy is how the rail still says it in those states — see the render
  // below for which surfaces get the appended one and why the dock does not.
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

      {/* THE APPENDED NETWORK STATEMENT IS THE RAIL'S, NOT THE DOCK'S — the same rule as the `aside`
          above, applied to the one paragraph that had escaped it.
          THE COMPLAINT THIS ANSWERS: three stacked paragraphs in a 320px corner while a connect was
          in flight — the round's clock, the reader's blocker, and then this. The first two are
          deliberate and argued where they are rendered (`StakeDock`, and `short` then `detail` in
          SPEC's order). The third was neither: it was appended unconditionally, in both densities,
          to every block that did not already embed it, on the argument that it is "correct 100% of
          the time". It is. That is an argument for saying it SOMEWHERE, not for saying it in a
          corner under a transient wait.
          AND `playGate.ts` ALREADY DRAWS THE REAL LINE. It embeds the note in exactly two blocks —
          `not-installed` and `not-connected` — the two a stranger is standing in while deciding
          whether to connect at all, where the network is part of the pitch. Those two carry it in
          BOTH densities, because there it was put in `detail` on purpose: a first-time visitor still
          reads it in the dock. Every state reached AFTER that point is being told a fact it has
          already been told, and repeating it costs a paragraph on the smallest surface on the page.
          So the appended copy goes where there is a column to hold it. That drops the dock's
          connecting panel from three paragraphs to two, and takes nothing away from anyone who has
          not yet been told. */}
      {density === "full" && !noteAlreadySaid ? <p className="u cx-net">{DEVNET_ONLY_NOTE}</p> : null}
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

// WHAT BOTH CONTROLS DO, now that there is a ceremony behind them. This block used to say that Stage 3
// did not exist and that both buttons could only report as much; it does now
// (`data/xLinkCeremony.ts` against `/api/x/challenge` and `/api/x/link`), and the prediction that
// "these two `onClick`s are where it goes and the rest of this component is unchanged" held — the two
// handlers open a dialog, and everything below them renders exactly as it did.
//
// NEITHER CONTROL STARTS A CEREMONY DIRECTLY, AND THAT IS THE ONE ADDITION WORTH ARGUING. Both open a
// takeover first (`XConsentDialog.tsx`):
//
//   Connect X -> the consent screen, because `TWITTER-CONNECT.md` §6.1 requires the deanonymisation
//                sentence to be read BEFORE the redirect, and because that document is explicit that
//                the copy will cost us links and that this is the correct outcome. A line under a
//                button is read by nobody.
//   Unlink    -> the revocation screen, because §6.2's promise is not "immediate" and the two real
//                numbers — about a minute on the board, up to 24 hours for a cached picture — have to
//                be said at the moment they become relevant rather than in a footnote.
//
// EVERY ATTEMPT SEES THE CONSENT SCREEN AGAIN, including `Try again` after a failure. Consent is per
// redirect, not per session: a player who was shown the warning, failed, and came back an hour later
// has not consented to the second attempt because they read something before the first.
//
// THE FAILURE STATE IS UNCHANGED and still comes from `xConsent.ts` — the panel resolves no sentences
// of its own. What changed is that the sentences are now reached by things that actually happened.

/**
 * START FETCHING THE IDENTITY CHUNK WHILE THE PLAYER READS THE CONSENT SCREEN.
 *
 * NOT AN OPTIMISATION — a correctness measure for the popup, and the reasoning is worth having here
 * because the symptom appears three files away. `data/xPrivy.ts` opens the X authorisation window with
 * `window.open`, which browsers allow only while the player's activation from the press is still live.
 * Chrome and Firefox keep it across `await`s for a few seconds; SAFARI TIES IT TO THE GESTURE'S OWN
 * TASK, so a network fetch in between loses it and the window is silently blocked.
 *
 * The fetch in between is `useXCeremony.ts`'s `await import("./xProof.ts")` — cold on the first press,
 * which is precisely the press that needs a window. Warming it here, at the moment the consent dialog
 * opens, means that import resolves in a microtask several seconds later and the activation survives.
 *
 * IT DOES NOT COST THE LAZINESS ANYTHING. This is the same dynamic `import()` the press handler makes,
 * so the chunk stays a chunk and nothing moves into the main bundle; the only change is WHEN it is
 * asked for. It is still asked for by nobody who has not deliberately opened the consent screen —
 * which, per `xConsent.ts`, is a screen designed to be read and refused.
 *
 * FAILING IS FINE AND DELIBERATELY SILENT. If this fetch fails the press will make it again and report
 * the failure properly through the ceremony; a warning here would be a second voice for one event.
 */
function warmIdentityChunk(): void {
  void import("../data/xProof.ts").catch(() => {});
}

export function XLinkPanel() {
  const { source, you, loading, refresh } = useLinks();
  // Through the arena context, like every other consumer on this page. `useWallet` is the FACTORY the
  // provider calls once with an identity and a connection — not a hook a component may call for
  // itself, and calling it here would build a second wallet with its own balance polling.
  const { wallet } = useArena();
  /** Which takeover is open, if any. `none` is not a state anybody sees — it is the absence of one. */
  const [dialog, setDialog] = useState<"none" | "consent" | "revoke">("none");

  const ceremony = useXCeremony({
    // READ AT THE MOMENT OF THE PRESS, never remembered from earlier in the session: §4.2 — "what the
    // user sees is what they sign is what gets linked". `useWallet` gives `""` when nothing is
    // connected, which this normalises to the null the hook refuses on.
    wallet: wallet.pubkey === "" ? null : wallet.pubkey,
    signMessage: wallet.signMessage,
    // A successful ceremony re-reads the feed immediately rather than waiting out the sixty-second
    // poll. A face that takes a minute to appear reads as a link that did not work, and the player
    // presses the button again.
    onChanged: refresh,
  });
  const failure = ceremony.failure;

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
          <button
            type="button"
            className="btn btn--sm btn--ghost push"
            disabled={ceremony.busy}
            aria-busy={ceremony.busy}
            onClick={() => setDialog("revoke")}
          >
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
        {dialog === "revoke" ? (
          <XRevokeDialog
            onCancel={() => setDialog("none")}
            onConfirm={() => {
              // Closed FIRST, so the wallet prompt appears over the page rather than over a takeover
              // the player has already answered.
              setDialog("none");
              ceremony.unlink();
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="xl" data-testid="x-link-panel" data-state={failure === null ? "unlinked" : "failed"}>
      {/* ONE BUTTON ACROSS BOTH STATES, in the same slot, and that is a focus decision rather than a
          tidy one. Rendering a separate `Try again` control would unmount the button the reader just
          pressed and drop focus to the top of the document — the exact defect `useFocusTrap.ts` was
          written against. Same element, same position, new label. */}
      <button
        type="button"
        className="btn btn--sm btn--wide"
        disabled={ceremony.busy}
        aria-busy={ceremony.busy}
        onClick={() => {
          warmIdentityChunk();
          setDialog("consent");
        }}
      >
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
      {dialog === "consent" ? (
        <XConsentDialog
          onCancel={() => setDialog("none")}
          onConfirm={() => {
            setDialog("none");
            ceremony.link();
          }}
        />
      ) : null}
    </div>
  );
}
