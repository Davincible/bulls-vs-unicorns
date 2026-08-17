// THE CEREMONY AS A COMPONENT SEES IT: press, wait, be told what happened.
//
// `xLinkCeremony.ts` is the ceremony; this is the two pieces of state a button needs around it and the
// three decisions that are about a person rather than a protocol.
//
// ================================================================================================
// WHY THE BROKER IS BEHIND A DYNAMIC `import()`.
//
// The identity feature is off by default — `?links=` is unset for everybody who has not asked for it
// (`linkSource.ts`), and `XLinkPanel` renders nothing at all in that state. An identity provider's SDK
// is a large dependency, and a large dependency in the main chunk is paid for by every player on every
// visit, including the great majority who will never link anything (`TWITTER-CONNECT.md` §8: "the
// unlinked path is the main path").
//
// So `./xProof.ts` is reached with `await import()`, INSIDE the press handler. Vite splits it into its
// own chunk; the network fetches it the first time somebody actually presses `Connect X`, which is
// after they have read the consent screen and decided. Nobody else ever downloads it.
//
// The unlink path does not import it at all. That is not an optimisation — it is the same rule the
// server enforces: revocation must not depend on the identity provider a player is walking away from,
// and here that means the code to talk to it is not even fetched.
// ================================================================================================

import { useCallback, useRef, useState } from "react";
import { runLink, runUnlink, type CeremonyFailure } from "./xLinkCeremony.ts";
import { FAILURE_COPY } from "./xConsent.ts";

export interface CeremonyState {
  /** True while a ceremony is in flight. Disables the control that started it, and NOTHING ELSE — no
   *  overlay, no spinner over the page, no blocked navigation. A wallet prompt is already modal. */
  readonly busy: boolean;
  /** The sentence to show, or null. Already resolved from `FAILURE_COPY`, because a component that
   *  received a reason code would be a component with a `switch` in it, and that switch is how a new
   *  reason ends up rendering nothing. */
  readonly failure: string | null;
}

export interface CeremonyControls extends CeremonyState {
  link: () => void;
  unlink: () => void;
  /** Clears the failure without starting anything — for the moment a player closes the consent screen
   *  or presses the control again. */
  reset: () => void;
}

/** How a reason becomes a sentence. `tooMany` is the only one that carries a number, and it is the
 *  server's own `Retry-After` rather than one we invented. */
function sentenceFor(reason: CeremonyFailure, retryAfterSec: number | undefined): string {
  if (reason === "tooMany" && retryAfterSec !== undefined && retryAfterSec > 60) {
    const minutes = Math.ceil(retryAfterSec / 60);
    return `${FAILURE_COPY.tooMany} (about ${minutes} minute${minutes === 1 ? "" : "s"}.)`;
  }
  return FAILURE_COPY[reason];
}

export interface CeremonyDepsForHook {
  /** The wallet connected RIGHT NOW, or null. Read at the moment of the press — never remembered. */
  readonly wallet: string | null;
  /** `ChainIdentity.signMessage`, or null when nothing is connected. */
  readonly signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
  /** Called after a ceremony that changed something, so the panel shows the truth rather than the
   *  outcome it assumed. Both directions: a link that succeeded and an unlink that succeeded. */
  readonly onChanged: () => void;
}

export function useXCeremony(deps: CeremonyDepsForHook): CeremonyControls {
  // Destructured so the callbacks below depend on the three VALUES rather than on the object literal a
  // caller rebuilds every render — otherwise `link` and `unlink` get a new identity on every frame and
  // every consumer's dependency list churns with them.
  const { wallet, signMessage, onChanged } = deps;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // GUARDS AGAINST A SECOND PRESS, and it is a ref rather than the `busy` state because state is one
  // render behind: two clicks inside the same frame both see `busy === false` and both start a
  // ceremony, which means two wallet prompts and two challenges for one intention.
  const running = useRef(false);

  const run = useCallback(
    async (what: "link" | "unlink"): Promise<void> => {
      if (running.current) return;
      if (wallet === null || signMessage === null) {
        // Nothing is connected. The panel does not render in this state, so this is a guard against a
        // race — a disconnect between the render and the press — rather than a screen anybody sees.
        setFailure(FAILURE_COPY.unavailable);
        return;
      }

      running.current = true;
      setBusy(true);
      setFailure(null);
      try {
        const result =
          what === "unlink"
            ? await runUnlink({ fetch: globalThis.fetch, wallet, signMessage })
            : await runLink({
                fetch: globalThis.fetch,
                wallet,
                signMessage,
                // See this file's header: the broker's SDK is fetched here and nowhere else, so it
                // stays out of the bundle for everybody who never presses this.
                getProof: async () => (await import("./xProof.ts")).identityProof(),
              });

        if (result.kind === "ok") {
          // The identity on screen comes from re-reading `/api/links` and verifying its signature —
          // never from the write path's response, which carries nothing renderable on purpose.
          onChanged();
          setFailure(null);
        } else {
          setFailure(sentenceFor(result.reason, result.retryAfterSec));
        }
      } catch (e) {
        // The ceremony is written not to throw, so this is the module loader failing — an offline
        // reload, a chunk that 404s after a redeploy. One sentence, and it is the generic one.
        console.warn("[xlink] ceremony could not run:", e);
        setFailure(FAILURE_COPY.unavailable);
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [wallet, signMessage, onChanged],
  );

  return {
    busy,
    failure,
    link: useCallback(() => void run("link"), [run]),
    unlink: useCallback(() => void run("unlink"), [run]),
    reset: useCallback(() => setFailure(null), []),
  };
}
