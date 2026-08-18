// THE WALLET'S FOUR STATES, and the one detection question that decides which of them a visitor
// lands in. Pure, React-free and adapter-instance-free, so `walletConnection.test.ts` can run every
// branch in Node — the failure states are the product here, and a state machine nobody can test is
// a state machine nobody can trust.

import { WalletReadyState } from "@solana/wallet-adapter-base";

/**
 * `"unsupported"` — no Phantom the adapter is willing to talk to (see `hasInjectedPhantom` for the
 *                   case where that verdict is wrong and how the page recovers from it).
 * `"disconnected"` — Phantom is there, nobody has connected yet, or the wallet hung up.
 * `"connecting"`  — a handshake this page started has not settled, WHETHER OR NOT A POPUP WAS EVER
 *                   SHOWN. That last clause is the honest version and it used to read "a popup is
 *                   open, or a trusted reconnect is completing" — a claim about the player's screen,
 *                   which this page has no way to verify. `adapter.connect()` has no timeout in it,
 *                   so an extension that never answers leaves a handshake outstanding forever with
 *                   nothing on screen to approve. The status is still the right one there (the
 *                   attempt genuinely is live, and a late approval still lands through it), so it is
 *                   the WORDING that had to give: past `CONNECT_PATIENCE_MS` the page stops claiming
 *                   the player is being asked. See `connectPatience.ts` and `playGate`'s
 *                   `connect-stalled`.
 *                   NOT the silent `onlyIfTrusted` probe that precedes a trusted reconnect — for an
 *                   untrusted origin that rejects without showing anything, and reporting it would
 *                   render "waiting for you to approve…" over a popup nobody can see.
 * `"connected"`   — there is a public key and this page can ask for signatures.
 */
export type WalletStatus = "unsupported" | "disconnected" | "connecting" | "connected";

/**
 * The adapter's readiness, plus the two booleans it exposes, collapsed into our status.
 *
 * `connected` outranks everything, including `connecting`: the adapter briefly reports both while a
 * connection settles, and a UI that showed "connecting…" over a live public key would be inviting a
 * second popup.
 *
 * `Loadable` counts as present. It is meaningless for a browser extension (it describes zero-install
 * runtimes) but it is a positive readiness signal, and treating it as absent would tell a visitor
 * with a working wallet to go install one.
 */
export function statusForReadyState(
  readyState: WalletReadyState,
  connecting: boolean,
  connected: boolean,
): WalletStatus {
  if (connected) return "connected";
  if (connecting) return "connecting";
  if (readyState === WalletReadyState.Installed || readyState === WalletReadyState.Loadable) {
    return "disconnected";
  }
  return "unsupported";
}

/**
 * IS A PHANTOM-SHAPED PROVIDER ACTUALLY IN THIS PAGE? — asked separately from the adapter's own
 * verdict, because the two can disagree and the disagreement is expensive.
 *
 * Read directly from the compiled adapter
 * (`node_modules/@solana/wallet-adapter-phantom/lib/cjs/adapter.js`): it only reaches `Installed`
 * when `window.isPhantomInstalled` is truthy AND a provider object is present. A Phantom build that
 * injects the provider but not that flag leaves `readyState` at `NotDetected` forever — and the page
 * would then tell someone who plainly has Phantom open in front of them to go and install Phantom,
 * which is the worst copy this page could produce.
 *
 * So this probes only the provider half. `usePhantom` combines the two: provider present but adapter
 * never `Installed` is its own state (`wallet-unannounced` in `playGate.ts`), with a reload and the
 * burner deep-link offered instead of an install prompt.
 *
 * Takes the global as a PARAMETER rather than reaching for `window`, so every branch is reachable
 * from a Node test. DEFENSIVE BRANCH, HONESTLY LABELLED: we could not exercise the disagreement
 * against a real old Phantom build — it is written from the adapter's source, not from an observed
 * failure.
 */
export function hasInjectedPhantom(w: unknown): boolean {
  if (w === null || w === undefined || typeof w !== "object") return false;
  const g = w as {
    phantom?: { solana?: { isPhantom?: unknown } };
    solana?: { isPhantom?: unknown };
  };
  // `window.phantom.solana` FIRST, and the order is now load-bearing rather than stylistic — see
  // `phantomFromStandardWallets` below for the observation that forced it.
  return g.phantom?.solana?.isPhantom === true || g.solana?.isPhantom === true;
}

/** THE THIRD PLACE PHANTOM CAN ANNOUNCE ITSELF, and on a multi-wallet browser the only reliable one.
 *
 *  WHY THIS EXISTS — AN OBSERVED FAILURE, not a defensive branch. The operator runs Firefox with both
 *  Phantom AND MetaMask installed, and the live page told them "no Phantom wallet was detected in this
 *  browser… Install Phantom", which is the worst copy this page can produce. Their console showed
 *  MetaMask active on the page (`inpage.js`, `metamask-multichain-provider`), and MetaMask now ships
 *  Solana support and injects `window.solana`.
 *
 *  `window.solana` IS A SINGLE SLOT AND TWO EXTENSIONS WANT IT. Whichever content script runs last
 *  wins it. So `hasInjectedPhantom`'s second clause can be reading MetaMask's provider — where
 *  `isPhantom` is falsy, correctly — and conclude Phantom is absent while Phantom is sitting right
 *  there. The first clause (`window.phantom.solana`) is Phantom's own namespace and should survive,
 *  but "should" is doing a lot of work in a race between two content scripts, and the page has one
 *  observation saying it does not.
 *
 *  THE WALLET STANDARD IS THE ANSWER TO EXACTLY THIS PROBLEM. Wallets register into a shared registry
 *  instead of fighting over one global, so coexistence is the designed case rather than an accident of
 *  script order. `@wallet-standard/app` is already a dependency (via wallet-adapter), so this costs no
 *  new package.
 *
 *  Identified by NAME, deliberately, and this is the part to be uneasy about. The registry entry
 *  carries no `isPhantom`; a wallet's `name` is the only stable identifier it must expose. So a wallet
 *  literally named "Phantom" is what we look for. REJECTED: matching on `chains` containing
 *  `solana:mainnet`, which every Solana wallet satisfies and would make MetaMask read as Phantom —
 *  the exact confusion this function exists to end.
 *
 *  Takes the registry's wallet list as a PARAMETER rather than calling `getWallets()`, so every branch
 *  is reachable from a Node test and this module stays React-free and side-effect-free, per the header.
 */
export function phantomFromStandardWallets(wallets: readonly { name?: unknown }[] | undefined): boolean {
  if (wallets === undefined) return false;
  return wallets.some((wallet) => typeof wallet?.name === "string" && wallet.name.trim() === "Phantom");
}

/** The union: any of the three announcement channels is enough to stop saying "install Phantom".
 *
 *  DELIBERATELY A UNION AND NOT A REPLACEMENT. Older Phantom builds only do the legacy injection and
 *  never register with the standard; newer ones may register before injecting, or inject into a
 *  `window.solana` another extension has taken. Requiring agreement between channels would turn two
 *  partial signals into one stricter false negative — which is the bug being fixed, wearing a hat. */
export function phantomIsPresent(
  w: unknown,
  wallets: readonly { name?: unknown }[] | undefined,
): boolean {
  return hasInjectedPhantom(w) || phantomFromStandardWallets(wallets);
}

/** The eager-connect half of Phantom's provider — the only method we call on it directly.
 *
 *  `onlyIfTrusted` has no equivalent anywhere on the adapter, which is why this exists; see
 *  `usePhantom`'s note on the unsolicited-popup bug it fixes. */
export interface EagerConnectProvider {
  connect(options: { onlyIfTrusted: true }): Promise<unknown>;
}

/**
 * THE INJECTED PROVIDER ITSELF, when there is one — same probe as `hasInjectedPhantom`, handing back
 * the object rather than a verdict.
 *
 * `window.phantom.solana` is preferred over `window.solana` in exactly the order the adapter's own
 * `connect()` prefers them, so we can never end up trusting one object while the adapter connects
 * through the other.
 *
 * The returned type names ONLY `connect`, deliberately. This module is not a second, hand-rolled
 * wallet adapter and must not grow into one: every other interaction goes through
 * `PhantomWalletAdapter`, which is the thing that has been maintained against Phantom's real
 * behaviour. This is the one hole in that abstraction, and naming one method keeps it one hole.
 *
 * STRICTER THAN `hasInjectedPhantom`, AND THE TWO MUST NOT BE FOLDED TOGETHER — they answer different
 * questions. `hasInjectedPhantom` asks "is a Phantom here at all", and its answer decides which COPY a
 * visitor reads (install it, versus it is here but silent); a provider missing a method still means
 * Phantom is installed, and telling that person to install it would be wrong. This one asks "can I
 * make the eager-connect call", which additionally needs the method to exist. Folding them would let
 * a malformed provider silently downgrade the copy to an install prompt.
 */
export function injectedPhantom(w: unknown): EagerConnectProvider | null {
  if (w === null || w === undefined || typeof w !== "object") return null;
  const g = w as {
    phantom?: { solana?: { isPhantom?: unknown; connect?: unknown } };
    solana?: { isPhantom?: unknown; connect?: unknown };
  };
  const candidate = g.phantom?.solana?.isPhantom === true
    ? g.phantom.solana
    : g.solana?.isPhantom === true
      ? g.solana
      : null;
  if (candidate === null || typeof candidate.connect !== "function") return null;
  return candidate as unknown as EagerConnectProvider;
}
