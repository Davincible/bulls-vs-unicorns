// "Connecting," for this phase, means having a funded burner keypair — see chain/useSigner.ts and
// snug-floating-mitten.md assumption #1 for why a burner is the default signer rather than Phantom.
// A fresh burner starts at 0 SOL and can't pay for its own fee-paying transactions, so the one real
// job of this component is making that unfunded state legible and actionable: show the pubkey
// clearly, let it be copied without a typo, and hand over the exact command that funds it.
//
// Deliberately NOT a "Fund" button that sends SOL from inside the browser: the only funding source
// today is `.devnet/fork-payer.json`, and that keypair must never enter a browser bundle (a bundle
// is public by construction — see scripts/fund-wallet.mjs's own comment on this). The terminal
// command is the real, secure funding path, not a shortcut standing in for a nicer one.

import { useEffect, useState } from "react";
import type { Connection, Keypair } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

const BALANCE_POLL_MS = 4000;

function truncate(base58: string): string {
  return `${base58.slice(0, 4)}...${base58.slice(-4)}`;
}

export interface ConnectWalletProps {
  keypair: Keypair;
  /** A base-layer connection — SOL balance is a base-layer fact regardless of whether the round
   *  this wallet is about to play is ER-delegated (matches scripts/verify-lifecycle.ts's own
   *  precedent of reading balances from `base`, not the router). */
  connection: Connection;
}

export function ConnectWallet({ keypair, connection }: ConnectWalletProps) {
  const pubkey = keypair.publicKey.toBase58();
  const [balanceLamports, setBalanceLamports] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const lamports = await connection.getBalance(keypair.publicKey, "confirmed");
        if (!cancelled) {
          setBalanceLamports(lamports);
          setBalanceError(null);
        }
      } catch (e) {
        if (!cancelled) setBalanceError(e instanceof Error ? e.message : String(e));
      }
    };
    void poll();
    const id = setInterval(() => void poll(), BALANCE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection, keypair]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(pubkey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isUnfunded = balanceLamports === 0;

  return (
    // `wallet-strip` (App.css) lays this out as one instrument row rather than a stack of
    // paragraphs: it's the full width of the page above the arena, and three stacked lines of
    // secondary information there pushed the canvas — the thing the demo is about — below the fold.
    // Each fact is a labelled cell (micro-label over value), the same shape every other figure in
    // the app is rendered with, so the row reads as a status bar instead of a sentence.
    <section aria-label="wallet" className="wallet-strip">
      <h2>Wallet</h2>

      <div className="wallet-cell">
        <span className="wallet-cell__label">burner</span>
        <span className="wallet-cell__value">
          <code title={pubkey}>{truncate(pubkey)}</code>
          <button
            type="button"
            className="btn--tiny"
            /* The visible label alone ("copy") doesn't say WHAT gets copied once it's sitting in a
               row beside a balance and a fund command. The accessible name does. */
            aria-label="copy burner address to clipboard"
            onClick={() => void handleCopy()}
          >
            {copied ? "copied" : "copy"}
          </button>
        </span>
      </div>

      <div className="wallet-cell">
        <span className="wallet-cell__label">balance</span>
        <span className="wallet-cell__value">
          {balanceError !== null ? (
            // Same reasoning as RoundPanel's poll error: this retries every BALANCE_POLL_MS, so it
            // belongs in place rather than as a toast per attempt. Marked up as an error rather than
            // reading as a plain balance value, which is what "error: ..." as bare text looked like.
            <span className="status-error" role="alert">
              error: {balanceError}
            </span>
          ) : balanceLamports === null ? (
            <span className="status-muted">loading…</span>
          ) : (
            // The unit is never dropped — UI-REDESIGN-BRIEF.md Part 2: "every figure names its
            // unit", written after this codebase shipped two separate unit bugs.
            <>
              {(balanceLamports / LAMPORTS_PER_SOL).toFixed(4)} <span className="status-muted">SOL</span>
            </>
          )}
        </span>
      </div>

      {isUnfunded && (
        <div className="wallet-strip__warn" role="status">
          <span>this wallet has no SOL and can&apos;t sign fee-paying transactions yet — fund it from a terminal:</span>
          <code>bun scripts/fund-wallet.mjs {pubkey}</code>
        </div>
      )}
    </section>
  );
}
