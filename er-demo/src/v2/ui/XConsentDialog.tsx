// THE TWO SENTENCES A PLAYER MUST READ BEFORE THEY CHANGE ANYTHING, and the screen that makes them
// unavoidable.
//
// ================================================================================================
// WHY THIS IS A TAKEOVER AND NOT A LINE UNDER THE BUTTON.
//
// `TWITTER-CONNECT.md` §6.1 is unusually direct about the consent copy: it must be said "in one plain
// sentence, before the OAuth redirect", it must not be softened, and — the part that decides this
// component's shape — "this will reduce the link rate. THAT IS THE CORRECT OUTCOME."
//
// A paragraph beside a button is read by nobody. That is not cynicism, it is the measured behaviour of
// every consent notice ever shipped, and the fact being consented to here is not a cookie preference:
// linking permanently deanonymises a WALLET. Every token it has held, every transfer it has made, past
// and future, becomes public under a real name, on a ledger that does not forget — and deleting our row
// afterwards changes nothing about what a scraper already saw.
//
// So it takes the screen, it traps focus, and the affirmative control is not the default-focused one.
// The dock panel is described in its own file as "the smallest surface on the page"; this does not
// belong there.
//
// IT WRITES NO COPY. Every sentence comes from `data/xConsent.ts`, where the claims sit next to the
// code that makes them true — `REVOCATION_COPY`'s numbers are derived from the poll interval and the
// avatar cache header for exactly that reason. If a sentence reads badly, it is fixed there.
// ================================================================================================

import { useEffect, useRef } from "react";
import { CONSENT_COPY, REVOCATION_COPY } from "../data/xConsent.ts";
import { useFocusTrap } from "./useFocusTrap.ts";

interface XDialogProps {
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

interface DialogCopy {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly confirm: string;
  readonly cancel: string;
  readonly testId: string;
  readonly index: string;
}

/**
 * The shell both dialogs share.
 *
 * FOCUS STARTS ON `Cancel`, DELIBERATELY, and it is the one place this component overrides the
 * pattern `IntroOverlay` set. That takeover focuses its dismiss button because dismissing is the only
 * thing it asks for. This one asks for a decision with an irreversible half, and a reader who presses
 * Enter out of habit — the habit every other dialog on the internet has taught them — must not thereby
 * publish their wallet under their own name. The safe control is the reachable one.
 */
function XDialog({ copy, onConfirm, onCancel }: XDialogProps & { copy: DialogCopy }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // `aria-modal` is the claim; the trap is what makes it true for a keyboard. See `IntroOverlay` for
  // the measurement that produced this pairing (one Tab out, three more onto live controls).
  useFocusTrap(overlayRef, { active: true, initialFocus: cancelRef });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ESCAPE IS ALWAYS THE SAFE DIRECTION. It cancels; it never confirms. That holds for the unlink
      // dialog too, where the "safe" answer is to keep the link — undoing an unlink costs a whole
      // ceremony, and a face removed by an accidental keypress is a surprise this page does not do.
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${copy.testId}-h`}
      ref={overlayRef}
      data-testid={copy.testId}
    >
      <div className="overlay-body">
        <div className="ovl-idx">
          <span className="idx">{copy.index}</span>
          <span className="u u--ink">Read this before you decide</span>
        </div>

        <h1 className="display" id={`${copy.testId}-h`} style={{ margin: "22px 0 16px" }}>
          {copy.heading}
        </h1>

        {/* The FIRST paragraph is the one §6.1 supplies almost verbatim, and it is rendered at `lede`
            weight rather than as body text. Ordering is the whole argument: the consequence comes
            before the mechanics, because a reader who stops after one paragraph must have read the
            one that matters. */}
        {copy.paragraphs.map((text, i) => (
          <p key={text} className={i === 0 ? "lede" : "u"} style={{ marginBottom: i === 0 ? 22 : 14 }}>
            {text}
          </p>
        ))}

        <div className="line" style={{ marginTop: 26, gap: 12 }}>
          {/* Cancel FIRST in the DOM, so it is first in the tab order as well as focused. */}
          <button type="button" className="btn btn--ghost" ref={cancelRef} onClick={onCancel}>
            {copy.cancel}
          </button>
          <button type="button" className="btn" onClick={onConfirm} data-testid={`${copy.testId}-confirm`}>
            {copy.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Before the redirect. §6.1's sentence, then the honest limit of what a delete can do, then what is
 *  about to happen — so the two wallet prompts are not a surprise. */
export function XConsentDialog(props: XDialogProps) {
  return (
    <XDialog
      {...props}
      copy={{
        heading: CONSENT_COPY.heading,
        paragraphs: [CONSENT_COPY.deanonymisation, CONSENT_COPY.irreversible, CONSENT_COPY.whatHappens],
        confirm: CONSENT_COPY.proceed,
        cancel: CONSENT_COPY.cancel,
        testId: "x-consent",
        index: "[X1]",
      }}
    />
  );
}

/**
 * Before an unlink. It states the two real numbers — how long until the board stops showing you, and
 * how long a cached picture can survive — rather than claiming "immediate", which is not achievable
 * from a browser and which `REVOCATION_COPY` deliberately does not claim.
 */
export function XRevokeDialog(props: XDialogProps) {
  return (
    <XDialog
      {...props}
      copy={{
        heading: REVOCATION_COPY.heading,
        paragraphs: [REVOCATION_COPY.effect, REVOCATION_COPY.irreversible],
        confirm: REVOCATION_COPY.confirm,
        cancel: REVOCATION_COPY.cancel,
        testId: "x-revoke",
        index: "[X2]",
      }}
    />
  );
}
