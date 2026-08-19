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
import { DEVNET_ONLY_NOTE, type PlayBlock, type PlayBlockCta } from "../data/playGate.ts";
import { useArena } from "../data/useArena.ts";
import { useLinks } from "../data/useLinks.ts";
import { useXCeremony } from "../data/useXCeremony.ts";
import { FAILURE_COPY, LINKED_COPY, UNLINKED_COPY } from "../data/xConsent.ts";
import { XConsentDialog, XRevokeDialog } from "./XConsentDialog.tsx";
import { Disclosure } from "./Disclosure.tsx";
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

/**
 * THE WORD FOR "THE WALLET HAS BEEN ASKED AND HAS NOT ANSWERED", AND THE ONLY ONE.
 *
 * Exported because a second surface now says it: the header's wallet cell (`Chrome.tsx`), which is
 * pressable and must not read as dead while a connect is in flight. Two surfaces describing one
 * state in two vocabularies is the defect `playGate.ts` exists to prevent, applied one layer down —
 * so the string is shared rather than retyped, and the ellipsis, the tense and the wallet's name all
 * move together or not at all.
 */
export const CONNECTING_LABEL = "Waiting for Phantom…";

/**
 * A `PlayBlockCta`, AS THE THING YOU PRESS — the one place on this page that knows how.
 *
 * IT WAS INLINE IN `ConnectPanel` AND IS NOW ITS OWN COMPONENT, because a second surface needed the
 * same knowledge and the alternative was a second copy of this ternary. `install` and `faucet` are
 * anchors, `retry` reloads, `connect` calls the adapter and shuts while it waits; get any one of
 * those wrong in a copy and the divergence is silent, because both copies keep rendering a button.
 *
 * IT TAKES `cta` AND NOTHING ELSE. The wallet comes from the arena context, exactly as every other
 * consumer on this page reads it — `useWallet` is the factory the provider calls once, not a hook a
 * component may call for itself, and calling it here would build a second wallet with its own
 * balance polling.
 */
export function ConnectCta({ cta }: { cta: PlayBlockCta }) {
  const { wallet } = useArena();
  const connecting = wallet.status === "connecting";

  if (cta.kind === "connect") {
    return (
      <button
        type="button"
        className="btn btn--fill btn--wide cx-cta"
        data-testid="connect-cta"
        disabled={connecting}
        onClick={() => void wallet.connect()}
      >
        {/* The disabled state says what it is waiting for. A greyed button labelled "Connect
            Phantom" is indistinguishable from a broken one. */}
        {connecting ? CONNECTING_LABEL : cta.label}
      </button>
    );
  }

  if (cta.kind === "retry") {
    return (
      <button
        type="button"
        className="btn btn--fill btn--wide cx-cta"
        data-testid="connect-cta"
        onClick={() => window.location.reload()}
      >
        {cta.label}
      </button>
    );
  }

  // `install` and `faucet` — the two that leave the page. `.btn` is worn by an `<a>` elsewhere
  // on this page already (ReferralsView), so this is the established shape rather than a new
  // one. The accessible name CONTAINS the visible label (WCAG 2.5.3, Label in Name) and adds
  // the one fact the visible label cannot carry: that this opens somewhere else.
  return (
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
  );
}

export interface ConnectPanelProps {
  block: PlayBlock;
  /** `"full"` is the rail's column; `"compact"` is the dock's corner. Same words, tighter setting. */
  density: "full" | "compact";
}

export function ConnectPanel({ block, density }: ConnectPanelProps) {
  const { cta } = block;

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

      {cta === null ? null : <ConnectCta cta={cta} />}

      {/* THE ASIDE IS THE RAIL'S ALONE, and dropping it in the dock is safe BY CONTRACT: `playGate`
          guarantees everything a player must DO lives in `detail`, so an `aside` can never be the
          missing instruction (`playGate.test.ts` asserts it). The dock is a 320px corner over a live
          round — it gets the claim, the remedy and the button. The rail has the column to explain
          the thing a subset of readers are confused by, and it is set below the control because it
          is context for a decision already made, not part of making it.

          AND IN THE RAIL IT IS NOW CLOSED. Same contract, read one step further: a paragraph that is
          safe to DROP entirely is, by construction, safe to put behind a click. Today there is
          exactly one — `no-sol`'s explanation of why Phantom shows a healthy balance while this page
          says zero — which is a question a subset of readers arrive holding and the rest never think
          to ask. The summary lets that subset find it in a glance without the rest paying a
          paragraph for it.

          THE SUMMARY IS THE ASIDE'S OWN OPENING QUESTION, WORD FOR WORD, and that is the only reason
          this component is allowed to have one at all — see this file's header: it writes no copy,
          and a summary invented here would be copy. `playGate.ts` opens that aside "Seeing a balance
          in Phantom? That is your Mainnet balance…" and `playGate.test.ts` asserts exactly those
          words, so this label cannot drift away from the paragraph it opens without a red test.
          IF A SECOND BLOCK EVER GROWS AN ASIDE about something else, this stops being true and the
          summary has to move into `playGate.ts` beside the sentence it names. It is a one-line label
          today because there is one aside today. */}
      {density === "full" && block.aside !== undefined ? (
        <Disclosure summary="Seeing a balance in Phantom?">
          <p className="lede">{block.aside}</p>
        </Disclosure>
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
//   unlinked — one labelled status row: `X · NOT LINKED`, and the control. Once, here, and nowhere
//              else on the page: there is no per-row nag on the leaderboard and there never may be
//              (`TWITTER-CONNECT.md` §8).
//   linked   — THE SAME ROW, in its other state: the face at 24px, the `@handle`, when it was
//              linked, and `Unlink`.
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
//
// =================================================================================================
// ONE ROW, TWO STATES — the answer to the third operator fault, verbatim: "I don't know if twitter is
// connected or not, I don't see the connect option in the wallet side panel now, but also don't see
// anything to suggest its connected."
//
// THEY WERE TWO DIFFERENT WIDGETS AND THAT WAS THE WHOLE BUG. Unlinked rendered a wide button with
// two paragraphs stacked under it; linked rendered an avatar, then a separate line holding a date and
// a small ghost button, then another paragraph. Nothing shared a shape, so there was no ROW to read
// the state off — a reader had to infer it from which widget happened to be on screen, and inferring
// "not linked" from the absence of a face is exactly the reading that fails.
//
// Now both states are one `.xl-row`: an identity slot, a muted fact beside it, and the control that
// changes it, pushed right. Unlinked the identity slot says `X · NOT LINKED` in words; linked it is
// the face, the `@handle` and the X mark. THE STATE IS NEVER CARRIED BY THE PRESENCE OR ABSENCE OF
// SOMETHING — it is written out in one case and shown as an identity in the other, and the control
// beside it names the direction of travel (`Connect X` / `Unlink`) either way.
//
// AND THE PROSE UNDER IT IS GONE. `UNLINKED_COPY.invitation` is deleted outright (see `xConsent.ts` —
// it made a claim about pseudonyms that is about to stop being true), `UNLINKED_COPY.optional` with
// it, and `LINKED_COPY.disconnectIsNotUnlink` is behind a disclosure that names it. The unlinked
// state now renders no prose at all; the linked state renders one closed line.
// =================================================================================================

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
        <div className="line xl-row">
          {/* 24px, which is the largest an avatar may be on the DOM outside the fighter inspector.
              `SOCIAL.md` §4.6: size is the discipline that keeps a colour photograph honest on a page
              whose only other colour is the two sides.
              It is the ROW'S IDENTITY SLOT, holding what `X · NOT LINKED` holds in the other state —
              and it is the slot that gives way when the column is narrow, because `XIdentity`
              ellipsises the handle and keeps the face and the mark whole. */}
          <XIdentity link={you} size={24} />
          {/* Withheld rather than faked when the timestamp is unusable — `linkedDateText` returns
              null and this prints nothing, instead of asserting "linked 1 Jan 1970" as a fact. */}
          {linkedOn === null ? null : (
            <span className="u xl-when">
              Linked · <span className="u--ink">{linkedOn}</span>
            </span>
          )}
          <button
            type="button"
            className="btn btn--sm btn--ghost push xl-act"
            disabled={ceremony.busy}
            aria-busy={ceremony.busy}
            // "Unlink" alone is a verb with no object in a rail that also holds Disconnect, Stop,
            // Revoke and Pause. The accessible name CONTAINS the visible label (WCAG 2.5.3) and adds
            // what it acts on; `Try again` is left as it is, because the alert beside it is the
            // object and repeating it here would announce the failure twice.
            aria-label={failure === null ? "Unlink your X account" : undefined}
            onClick={() => setDialog("revoke")}
          >
            {failure === null ? LINKED_COPY.unlink : FAILURE_COPY.retry}
          </button>
        </div>
        {/* THE IDENTITY STAYS ON SCREEN THROUGH THE FAILURE, and that is correctness rather than
            layout: the unlink did not happen, so a panel that removed the face would be showing the
            outcome of the thing that just failed.

            THE FAILURE IS THE ONE PARAGRAPH THAT STAYS OPEN. It is the definition of actionable —
            something the reader just did has not happened, and the control beside it now says
            `Try again`. Everything else in this block is behind the disclosure below. */}
        {failure === null ? (
          // `disconnectIsNotUnlink` CORRECTS A WRONG ASSUMPTION AND IS NOW BEHIND A CLICK, which is
          // the one decision in this block worth defending. It has to stay reachable — a player who
          // thinks disconnecting their wallet removed their face is heading for exactly the surprise
          // this page refuses — but it is not actionable: it is true whether or not it is read, and
          // it describes a button (`Disconnect`, in the block above) that this reader has not
          // pressed. As a permanent paragraph under the row it was one of the ten this rail was
          // cited for; as a named summary it is one line, and the name is the correction itself.
          //
          // NOT MOVED INTO THE REVOKE DIALOG, which was the other candidate. That dialog opens after
          // someone has decided to unlink, and this sentence is for the player who is about to
          // decide they DON'T have to — telling them there that disconnecting would not have worked
          // is telling them about a road they are no longer on. It belongs beside the linked row,
          // one press from the Disconnect button it is about.
          <Disclosure summary="What disconnecting your wallet does not do">
            <p className="lede">{LINKED_COPY.disconnectIsNotUnlink}</p>
          </Disclosure>
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
      <div className="line xl-row">
        {/* THE STATE, IN WORDS, IN THE SLOT THE FACE OCCUPIES WHEN THERE IS ONE. This is the whole
            fix for "I don't see anything to suggest its connected": the unlinked state is now
            ASSERTED rather than inferred from an absence. `.u--ink` because it is the row's subject
            and not its metadata — the same weight the `@handle` carries in the other state. */}
        <span className="u u--ink xl-status">X · Not linked</span>
        {/* ONE BUTTON ACROSS BOTH STATES, in the same slot, and that is a focus decision rather than a
            tidy one. Rendering a separate `Try again` control would unmount the button the reader just
            pressed and drop focus to the top of the document — the exact defect `useFocusTrap.ts` was
            written against. Same element, same position, new label.
            `btn--sm` and pushed right, not `btn--wide`: it is now one control on a status row rather
            than a call to action with a column to itself, which is what linking is — optional, and
            never nagged for (`TWITTER-CONNECT.md` §8). */}
        <button
          type="button"
          className="btn btn--sm push xl-act"
          disabled={ceremony.busy}
          aria-busy={ceremony.busy}
          onClick={() => {
            warmIdentityChunk();
            setDialog("consent");
          }}
        >
          {failure === null ? UNLINKED_COPY.action : FAILURE_COPY.retry}
        </button>
      </div>
      {/* NO PROSE AT ALL WHEN NOTHING HAS GONE WRONG, and both sentences that used to be here are
          gone from `xConsent.ts` rather than hidden — see that file for the argument. What replaced
          them is the row above: a status that says which state this is, and a control that says
          which way it moves. */}
      {failure === null ? null : (
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
