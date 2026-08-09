// The burner wallet's SOL — the one balance on this page that is real, on-chain, and NOT simulated.
// It is also the one that decides whether anything else works: a fresh burner starts at 0 SOL and
// cannot pay for its own transactions, so an unfunded wallet is the first thing a first-time visitor
// hits and the last thing they'd guess at.
//
// BASE LAYER, not the router: a SOL balance is a base-layer fact whether or not the round this wallet
// is about to play is ER-delegated (same precedent as `src/ui/ConnectWallet.tsx`).
//
// AIRDROP. `ConnectWallet.tsx` deliberately does NOT offer one — it prints
// `bun scripts/fund-wallet.mjs <pubkey>` instead, because the only funding source that project has is
// a keypair that must never enter a browser bundle. That reasoning is about the FORK PAYER, not about
// airdrops; `requestAirdrop` needs no secret at all and is exactly what devnet's faucet is for. So v2
// offers it, in-page, and is honest when it fails: the public faucet rate-limits hard, and the
// terminal command remains the reliable path (the failure toast says so).

import { useCallback, useEffect, useState } from "react";
import { LAMPORTS_PER_SOL, type Connection, type Keypair } from "@solana/web3.js";
import { shortKey } from "../contract.ts";
import type { ArenaContextValue, ToastKind } from "./types.ts";

/** Slow on purpose. The balance only moves when the wallet signs something or is funded, and both of
 *  those already trigger their own refresh — this interval only exists so a wallet funded from a
 *  terminal shows up without a reload. */
const BALANCE_POLL_MS = 15_000;

/** One SOL. Devnet's faucet caps a single request well below what it once did; asking for more is
 *  the most common reason a request is refused outright rather than rate-limited. */
const AIRDROP_LAMPORTS = LAMPORTS_PER_SOL;

export function useWallet(
  keypair: Keypair,
  connection: Connection,
  push: (text: string, kind?: ToastKind) => void,
): ArenaContextValue["wallet"] {
  const pubkey = keypair.publicKey.toBase58();
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [airdropping, setAirdropping] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const lamports = await connection.getBalance(keypair.publicKey, "confirmed");
        if (!cancelled) setSolBalance(lamports / LAMPORTS_PER_SOL);
      } catch {
        // Deliberately quiet: this retries every BALANCE_POLL_MS, and a toast per failed poll would
        // bury the page in noise the moment devnet hiccups. The balance simply stops updating, which
        // is what `null`/a stale figure already communicates.
      }
    };
    void poll();
    const id = setInterval(() => void poll(), BALANCE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [connection, keypair, nonce]);

  const airdrop = useCallback(async () => {
    setAirdropping(true);
    try {
      const signature = await connection.requestAirdrop(keypair.publicKey, AIRDROP_LAMPORTS);
      const latest = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction({ signature, ...latest }, "confirmed");
      push(`airdropped ${AIRDROP_LAMPORTS / LAMPORTS_PER_SOL} SOL — ${signature}`, "info");
      refresh();
    } catch (e) {
      // The faucet's own message ("airdrop request failed... 429 Too Many Requests") is the useful
      // half; the second sentence is the part that actually unblocks someone.
      const message = e instanceof Error ? e.message : String(e);
      push(
        `airdrop failed: ${message} — devnet's faucet rate-limits hard; ` +
        `bun scripts/fund-wallet.mjs ${pubkey} always works`,
        "error",
      );
    } finally {
      setAirdropping(false);
    }
  }, [connection, keypair, push, refresh, pubkey]);

  return { pubkey, short: shortKey(pubkey), solBalance, airdrop, airdropping, refresh };
}
