// THE PHANTOM CONNECTION — one adapter, four states, and no library between us and it.
//
// WHY THE ADAPTER CLASS DIRECTLY, AND NOT `WalletProvider`/`useWallet()` FROM
// `@solana/wallet-adapter-react`. Both are installed; using the React layer would be the reflex, and
// it would cost two things this page cannot spend:
//
//   (a) IT IS BUILT FOR A WALLET PICKER. `WalletProvider` exists to hold a LIST of adapters, remember
//       which one was chosen by name, and drive a selection modal. This page supports exactly one
//       wallet, deliberately. All of that machinery would buy nothing and would put a second state
//       machine between the extension's events and the four states this app actually renders — the
//       four whose copy is the product here.
//
//   (b) IT WANTS A `ConnectionProvider`, i.e. A SECOND `Connection` BUILT FROM AN ENDPOINT STRING.
//       Every endpoint in this repo is asserted devnet-only at import (`devnet-guard.ts`,
//       `chain/constants.ts`), and the whole point of the guard is that there is a small, countable
//       set of places a URL can enter. Adding a wallet-owned connection would widen that set for no
//       gain: we never need it. This app calls `signTransaction` and submits the signed bytes itself
//       over the router (`chain/sendTx.ts`), so the wallet never needs an RPC at all. See
//       `devnetOnly.ts` for what that forecloses.
//
// WHAT WE USE THE ADAPTER FOR IS TWO METHODS — `signTransaction` and `signMessage`. Never
// `sendTransaction`, which is the only method that would hand a wallet an endpoint and let IT decide
// where a transaction goes. That is what makes a visitor whose Phantom is set to Mainnet still able
// to play: the signature is cluster-agnostic, and this page is the one doing the submitting.
//
// `signMessage` IS THE ADAPTER'S TOO, not the injected provider's, and that is not a preference.
// `PhantomWalletAdapter` implements `MessageSignerWalletAdapter` from `@solana/wallet-adapter-base`,
// so the method is right there with the same connection state, the same error classes and the same
// `error` event as everything else here. The injected provider in `walletConnection.ts` exists for
// exactly one thing the adapter cannot express — the trusted-only `connect({onlyIfTrusted:true})`
// probe below — and widening it into a second signing path would give this file two objects that
// disagree about whether a wallet is connected. One adapter, one path.
//
// THIN BY DESIGN. There is no jsdom in this project and no React Testing Library, so anything with
// a decision in it lives in `walletConnection.ts` / `walletFault.ts` / `playGate.ts` and is tested
// there. What is left here is subscription and bookkeeping.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import type { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { SigningWallet } from "./identity.ts";
import { classifyWalletError, connectFailedFault, type WalletFault } from "./walletFault.ts";
import {
  hasInjectedPhantom,
  injectedPhantom,
  statusForReadyState,
  type WalletStatus,
} from "./walletConnection.ts";

export interface PhantomHandle {
  status: WalletStatus;
  publicKey: PublicKey | null;
  /** The last thing the wallet said no with. Cleared on a successful connect and on a disconnect the
   *  PLAYER asked for — a fault is a thing that happened TO them, not a record of every click. */
  fault: WalletFault | null;
  /** True when a Phantom-shaped provider is in the page, whatever the adapter's readiness says.
   *  Feeds `playGate`'s split between "install Phantom" and "Phantom is here but silent". */
  providerPresent: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** ONE PROMPT, NO TRANSACTION — the raw 64-byte detached signature over exactly these bytes.
   *
   *  Throws the adapter's own error rather than a classified one, and latches NO `fault`. Both
   *  choices are argued at the implementation; the short version is that the outcome of a message
   *  signature belongs to whoever asked for it, and `fault` is this page's account of the CONNECTION.
   *
   *  Rejects with `WalletNotConnectedError` when nothing is connected. Callers holding a
   *  `ChainIdentity` never see that — its `signMessage` is `null` in that state. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Everything this app can ask the wallet to do, non-null only while connected. Deliberately NOT
   *  pre-cast to anchor's `Wallet`: that type does not declare `signMessage`, and `identity.ts`
   *  casts once, where anchor's shape is genuinely required. */
  wallet: SigningWallet | null;
}

/**
 * ONE ADAPTER PER TAB, held at module scope rather than in a `useMemo`, and the difference is not
 * academic.
 *
 * `PhantomWalletAdapter`'s constructor installs `scopePollingDetectionStrategy` — a 1s `setInterval`
 * with NO external teardown; it clears itself only once it finds Phantom, and never at all when
 * there is no extension. `useMemo` double-invokes its factory under StrictMode in development, so a
 * `useMemo` here builds two adapters and leaves the discarded one polling for the lifetime of the
 * tab. The comment that used to sit here claimed the opposite ("building a second would double that
 * polling for no benefit") while doing exactly that in dev.
 *
 * Lazy, not eager: constructing at import time would start the poll in every Node test that so much
 * as imports this module transitively.
 */
let sharedAdapter: PhantomWalletAdapter | null = null;
function phantomAdapter(): PhantomWalletAdapter {
  sharedAdapter ??= new PhantomWalletAdapter();
  return sharedAdapter;
}

/** How long to keep watching for a late-injecting extension. Phantom injects at `document_start`, so
 *  anything that has not appeared within a few seconds is not going to; an unbounded poll would run
 *  for the tab's life on every visit that genuinely has no wallet — which is the common case. */
const PROVIDER_POLL_MS = 400;
const PROVIDER_POLL_LIMIT_MS = 8_000;

/**
 * `providerPresent`, as a proper external store.
 *
 * It used to be read straight off `window` during render, which is a React purity violation and —
 * worse in practice — could never trigger the re-render that would surface a change. The state it
 * feeds (`wallet-unannounced`) is precisely the one where the round may not be polling, so there was
 * no incidental re-render to hide behind either.
 *
 * The subscription is a bounded poll because there is no injection event to listen for. It stops the
 * moment the answer becomes true: an extension cannot un-inject itself, so `true` is terminal.
 */
function subscribeToProvider(onChange: () => void): () => void {
  if (typeof window === "undefined" || hasInjectedPhantom(window)) return () => {};
  let waited = 0;
  const id = window.setInterval(() => {
    waited += PROVIDER_POLL_MS;
    if (hasInjectedPhantom(window)) {
      onChange();
      window.clearInterval(id);
    } else if (waited >= PROVIDER_POLL_LIMIT_MS) {
      window.clearInterval(id);
    }
  }, PROVIDER_POLL_MS);
  return () => window.clearInterval(id);
}

function readProviderPresent(): boolean {
  return typeof window === "undefined" ? false : hasInjectedPhantom(window);
}

/** Server/prerender snapshot. There is no `window`, so there is no provider — and this must be a
 *  separate function from `readProviderPresent` for `useSyncExternalStore`'s hydration check. */
function noProviderOnServer(): boolean {
  return false;
}

export function usePhantom(): PhantomHandle {
  const adapter = useMemo(() => phantomAdapter(), []);

  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [readyState, setReadyState] = useState<WalletReadyState>(() => adapter.readyState);
  const [fault, setFault] = useState<WalletFault | null>(null);
  // Set while OUR OWN `disconnect()` is in flight. Phantom emits `disconnect` in both directions and
  // only attaches an error to the one it initiates (it detaches its listeners before a disconnect we
  // asked for) — but the error and the event race, so this is belt to that braces: a disconnect the
  // player asked for must never leave a fault on screen saying the wallet walked away.
  const selfDisconnecting = useRef(false);
  // How many message-signature prompts are open. Non-zero suppresses the adapter's `error` event —
  // see `signMessage` below for the whole argument, which is the same shape as `selfDisconnecting`'s
  // and reaches the same conclusion for a different action.
  //
  // A COUNTER, WHERE `selfDisconnecting` IS A BOOLEAN, because this is the one of the two a UI can
  // have several of in flight: a double-pressed Link button opens two prompts, and a boolean cleared
  // by whichever resolved first would let the other's error through as a fault.
  const signingMessages = useRef(0);

  useEffect(() => {
    const onConnect = (pk: PublicKey) => {
      setPublicKey(pk);
      setConnecting(false);
      // A successful connect retires whatever went wrong last time. Leaving a stale "you cancelled"
      // beside a live account is the kind of contradiction that makes a working page look broken.
      setFault(null);
    };
    const onDisconnect = () => {
      setPublicKey(null);
      setConnecting(false);
    };
    const onError = (e: unknown) => {
      setConnecting(false);
      // A disconnect we asked for is not a failure and must not be reported as one.
      if (selfDisconnecting.current) return;
      // Neither is a message signature, whose caller is holding the same error already.
      if (signingMessages.current > 0) return;
      setFault(classifyWalletError(e));
    };
    const onReadyStateChange = (rs: WalletReadyState) => setReadyState(rs);

    adapter.on("connect", onConnect);
    adapter.on("disconnect", onDisconnect);
    adapter.on("error", onError);
    adapter.on("readyStateChange", onReadyStateChange);
    // The adapter's polling detection can flip readiness between construction and this effect.
    setReadyState(adapter.readyState);
    if (adapter.publicKey !== null) setPublicKey(adapter.publicKey);

    return () => {
      adapter.off("connect", onConnect);
      adapter.off("disconnect", onDisconnect);
      adapter.off("error", onError);
      adapter.off("readyStateChange", onReadyStateChange);
    };
  }, [adapter]);

  // THE SILENT RETURNING-VISITOR PATH — and the reason it does NOT use `adapter.autoConnect()`.
  //
  // THE BUG THIS FIXES WAS CAUGHT BY RUNNING IT, not by reading the types. `autoConnect()` sounds
  // like the trusted-only reconnect every wallet has; it is not. Its whole body is
  // `if (readyState === Installed) await this.connect()`, and `connect()` calls the provider's
  // `wallet.connect()` with NO ARGUMENTS. Phantom only stays silent for `connect({onlyIfTrusted:
  // true})` — bare `connect()` OPENS THE APPROVAL POPUP. So calling `autoConnect()` on mount threw an
  // unsolicited Phantom dialog at every first-time visitor, on page load, before they had read a word
  // of the page or pressed anything. `scripts/verify-wallet-states.ts` found it as a wrong state
  // (`not-connected` rendering as `no-sol`, because the mock connected when nobody had asked it to).
  //
  // So we ask the injected provider the trusted-only question ourselves — the one thing the adapter
  // gives us no way to express — and only bring the adapter into line once the answer is yes. By then
  // the provider is already connected, so the adapter's own `connect()` skips its `wallet.connect()`
  // branch entirely (`if (!wallet.isConnected)`) and just reads the public key across. No second
  // prompt, and every subsequent interaction is the adapter's, not ours.
  //
  // A rejection here is the ORDINARY FIRST VISIT — not trusted yet — so it is swallowed and leaves no
  // fault. Surfacing it would put "the wallet did not finish connecting" in front of exactly the
  // people who have done nothing wrong.
  const autoConnected = useRef(false);
  /**
   * ONE HANDSHAKE AT A TIME, shared by the eager path and the Connect button.
   *
   * `PhantomWalletAdapter.connect()` silently early-returns when it is already connecting
   * (`if (this.connected || this.connecting) return`). Without this ref, a click landing while the
   * eager reconnect was in flight would resolve instantly, find `adapter.publicKey` still null, and
   * report "the wallet did not finish connecting" — a flashed failure on a connect that was about to
   * succeed, shown to a returning visitor who did nothing wrong. The ref is what makes the two paths
   * mutually exclusive rather than merely unlikely to overlap.
   */
  const inFlight = useRef(false);

  const runConnect = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setConnecting(true);
    try {
      await adapter.connect();
      // Resolving without a public key is a real state (a locked wallet, or one with no accounts).
      // The `error` event does not fire for it, so nothing else would report it.
      //
      // EXCEPT UNDER `Loadable`, where it is not a failure at all: the adapter's `connect()` sets
      // `window.location.href` to Phantom's universal link and returns, so a null key there means
      // "we are navigating away", and calling it a failure would put an error on screen during the
      // redirect it asked for.
      if (adapter.publicKey === null && adapter.readyState !== WalletReadyState.Loadable) {
        setFault(connectFailedFault());
      }
    } catch (e) {
      setFault(classifyWalletError(e));
    } finally {
      inFlight.current = false;
      setConnecting(false);
    }
  }, [adapter]);

  useEffect(() => {
    if (autoConnected.current) return;
    if (readyState !== WalletReadyState.Installed) return;
    if (adapter.connected || inFlight.current) return;
    const provider = typeof window === "undefined" ? null : injectedPhantom(window);
    if (provider === null) return;
    autoConnected.current = true;
    void (async () => {
      try {
        // SILENT, AND NOT YET "CONNECTING". For an untrusted origin this rejects without showing
        // anything, so flipping the status here would render "waiting for you to approve…" over a
        // popup that does not exist. The status starts once trust is established and a real
        // handshake is genuinely running.
        await provider.connect({ onlyIfTrusted: true });
      } catch {
        return; // Not trusted yet. No popup was shown, and the Connect button is the path.
      }
      // Trusted a moment ago and failing now is worth reporting: it means the handshake broke after
      // Phantom had already said yes, which is not a state the player can guess at.
      await runConnect();
    })();
  }, [adapter, readyState, runConnect]);

  const connect = useCallback(async () => {
    setFault(null);
    await runConnect();
  }, [runConnect]);

  /**
   * SIGN A SENTENCE. One prompt, no transaction, no fee, no funds moved — the X link ceremony's
   * step 5 (`TWITTER-CONNECT.md` §4.1) and, at present, its only caller.
   *
   * ------------------------------------------------------------------------------------------
   * IT LATCHES NO `fault`, AND THAT IS THE WHOLE REASON THIS FUNCTION IS MORE THAN ONE LINE.
   *
   * `PhantomWalletAdapter.signMessage` does not merely throw: it `emit`s `error` first and then
   * rethrows. So without the guard, pressing Cancel on a link prompt would run through `onError`
   * above and set `fault` — and `fault` means exactly one thing in this app. `playGate` reads it in
   * a single branch, `walletStatus === "disconnected"`, to explain why a CONNECTION has not
   * happened. Nothing renders it while connected, which is the state a link prompt is opened in.
   *
   * So the fault would not appear at the time; it would sit there and appear LATER, attached to the
   * wrong action. Cancel the X-link prompt now, disconnect an hour afterwards, and the page invites
   * you to connect under the words "you cancelled the request in your wallet". `PhantomHandle.fault`
   * says it: a fault is a thing that happened TO the player, not a record of every click.
   *
   * A CANCELLED CONNECT IS LATCHED FOR THE SAME RULE, NOT AN OPPOSITE ONE. `runConnect` sets a fault
   * because a refused connect leaves the page in a state — disconnected, nothing to sign with, a
   * Connect button and nothing to say — that `fault` is the only copy for. A refused signature
   * leaves no state at all: the wallet is still connected, the round still plays, and the only
   * surface that owes anybody a sentence is the one that asked.
   *
   * WHICH IS WHY THE ORIGINAL ERROR IS RETHROWN UNTOUCHED, rather than flattened here. It reaches
   * the same `classifyWalletError` every other failure does — at the call site, where the copy is
   * rendered, exactly as `sendTx`'s throws are classified where they are shown. Classifying early
   * would hand the caller a string it would have to re-classify to learn whether "rejected" or
   * something real had happened, throwing away a `WalletFaultCode` we were already holding.
   *
   * The guard's cost is one narrow window: a wallet that hangs up on us WHILE a prompt is open
   * emits its `WalletDisconnectedError` into the suppressed path. The `disconnect` event still
   * fires, `publicKey` still goes null, and the gate still says "no wallet is connected" — the same
   * trade `selfDisconnecting` already makes, for the same reason.
   * ------------------------------------------------------------------------------------------
   *
   * Deliberately NOT serialised behind an `inFlight` ref the way `connect` is. That ref works there
   * because a duplicate connect can early-return having done nothing; a duplicate signature has to
   * return bytes, and the second call's message is not the first call's message. Two prompts is the
   * honest outcome of two presses, and the button that made them is the thing that should be
   * disabled.
   */
  const signMessage = useCallback(
    async (message: Uint8Array): Promise<Uint8Array> => {
      signingMessages.current += 1;
      try {
        return await adapter.signMessage(message);
      } finally {
        signingMessages.current -= 1;
      }
    },
    [adapter],
  );

  const disconnect = useCallback(async () => {
    selfDisconnecting.current = true;
    try {
      await adapter.disconnect();
      setFault(null);
    } catch (e) {
      setFault(classifyWalletError(e));
    } finally {
      selfDisconnecting.current = false;
    }
  }, [adapter]);

  // `connecting` alone — never `adapter.connecting` beside it. That was a second, non-reactive read
  // of a mutable external object during render: nothing re-renders when it changes, so it could only
  // ever be right by accident, and `runConnect` now owns the same fact reactively.
  const status = statusForReadyState(readyState, connecting, publicKey !== null);

  const providerPresent = useSyncExternalStore(
    subscribeToProvider,
    readProviderPresent,
    noProviderOnServer,
  );

  const wallet = useMemo<SigningWallet | null>(() => {
    if (publicKey === null) return null;
    // BOUND — these are class methods reading `this._wallet`, and an unbound reference throws the
    // moment anything calls it, with the call site being `sendTx`, mid-fight.
    //
    // AND NO CAST ANY MORE. This used to go out through `asAnchorWallet`, because `walletIdentity`
    // took anchor's `Wallet`; it now takes the honest `SigningWallet` and casts once, itself, at the
    // single member that needs anchor's shape. The wallet that can do four things is described here
    // as a wallet that can do four things.
    return {
      publicKey,
      signTransaction: <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> =>
        adapter.signTransaction(tx),
      signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> =>
        adapter.signAllTransactions(txs),
      // Already a stable, adapter-bound callback — see above for why it is not a bare method.
      signMessage,
    };
  }, [adapter, publicKey, signMessage]);

  return {
    status,
    publicKey,
    fault,
    providerPresent,
    connect,
    disconnect,
    signMessage,
    wallet,
  };
}
