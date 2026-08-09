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
    <section aria-label="wallet">
      <h2>Wallet</h2>
      <p>
        burner: <code title={pubkey}>{truncate(pubkey)}</code>{" "}
        <button type="button" onClick={() => void handleCopy()}>
          {copied ? "copied" : "copy"}
        </button>
      </p>
      <p>
        balance:{" "}
        {balanceError !== null
          ? `error: ${balanceError}`
          : balanceLamports === null
            ? "loading..."
            : `${(balanceLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`}
      </p>
      {isUnfunded && (
        <p>
          this wallet has no SOL and can't sign fee-paying transactions yet. Fund it from a terminal:
          <br />
          <code>bun scripts/fund-wallet.mjs {pubkey}</code>
        </p>
      )}
    </section>
  );
}
