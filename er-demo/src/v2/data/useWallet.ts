// THE PLAYER'S SOL — the one balance on this page that is real, on-chain, and NOT simulated.
// It is also the one that decides whether anything else works: a transaction that cannot pay its fee
// does not land, so a zero balance is the first wall a new visitor hits and the last thing they'd
// guess at. `playGate.ts` turns this number into the sentence that unblocks them.
//
// BASE LAYER, not the router: a SOL balance is a base-layer fact whether or not the round this
// wallet is about to play is ER-delegated (same precedent as `src/ui/ConnectWallet.tsx`).
//
// IT READS A `PublicKey | null`, NOT A `Keypair`, and that is the whole shape change this file
// needed. In wallet mode there is no secret key in the page at all, and before anyone connects there
// is no key of any kind — `null` is a state this hook is genuinely in, on every first paint of a
// public URL, and it must produce "no balance known" rather than a crash on `.publicKey`.
//
// AIRDROP. It stays, and it stays honest. `ConnectWallet.tsx` deliberately offers none — it prints
// `bun scripts/fund-wallet.mjs <pubkey>` instead, because the only funding source that path has is a
// keypair that must never enter a browser bundle. `requestAirdrop` needs no secret at all and is
// what devnet's faucet is for, so the BURNER path offers it: a developer on a fresh IP may well get
// it. The WALLET path does not offer it in the UI (Phase 2), because devnet's public faucet
// rate-limits it to uselessness — five consecutive 429s, measured 2026-08-09 — and a button that
// reliably fails is worse than no button. `playGate` sends a real visitor to faucet.solana.com,
// which works.

import { useCallback, useEffect, useState } from "react";
import { LAMPORTS_PER_SOL, type Connection } from "@solana/web3.js";
import { shortKey } from "../contract.ts";
import { assertDevnetConnection } from "./devnetOnly.ts";
import type { ChainIdentity } from "./identity.ts";
import type { ArenaContextValue, ToastKind } from "./types.ts";

/** Slow on purpose. The balance only moves when the wallet signs something or is funded, and both of
 *  those already trigger their own refresh — this interval only exists so a wallet funded from a
 *  terminal or a faucet shows up without a reload. Quoted in `playGate`'s copy as "about fifteen
 *  seconds", so the two must not drift apart. */
const BALANCE_POLL_MS = 15_000;

/** One SOL. Devnet's faucet caps a single request well below what it once did; asking for more is
 *  the most common reason a request is refused outright rather than rate-limited. */
const AIRDROP_LAMPORTS = LAMPORTS_PER_SOL;

/** Takes the whole `ChainIdentity` rather than a bag of fields: who is connected, which mode, and
 *  the connect/disconnect controls all travel together and all belong on the context's `wallet`, so
 *  passing them individually would just be an opportunity for one of them to be forgotten. */
export function useWallet(
  identity: ChainIdentity,
  connection: Connection,
  push: (text: string, kind?: ToastKind) => void,
): ArenaContextValue["wallet"] {
  // Cheap, and it runs before the first read rather than after a mistake. See `devnetOnly.ts` for
  // what a user-controlled wallet does and does not change about this app's endpoint surface.
  assertDevnetConnection(connection, "wallet balance connection");

  const { player: pubkey, mode } = identity;
  const address = pubkey?.toBase58() ?? "";
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [airdropping, setAirdropping] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    // NOT MERELY "SKIP THE POLL". The balance has to be cleared: a wallet that disconnects mid-round
    // must not leave the previous account's SOL on screen beside a Connect button, which would read
    // as the page still believing it can spend it.
    if (pubkey === null) {
      setSolBalance(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const lamports = await connection.getBalance(pubkey, "confirmed");
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
    // `address` rather than `pubkey`: `PublicKey` instances are rebuilt on every adapter event, so
    // depending on the object identity would restart this interval several times a second.
  }, [connection, pubkey, address, nonce]);

  const airdrop = useCallback(async () => {
    if (pubkey === null) {
      // Reachable only if a UI offers this while disconnected. An answer beats a TypeError.
      push("Connect a wallet first — there is no address to airdrop to.", "error");
      return;
    }
    setAirdropping(true);
    try {
      const signature = await connection.requestAirdrop(pubkey, AIRDROP_LAMPORTS);
      const latest = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction({ signature, ...latest }, "confirmed");
      push(`airdropped ${AIRDROP_LAMPORTS / LAMPORTS_PER_SOL} SOL — ${signature}`, "info");
      refresh();
    } catch (e) {
      // The faucet's own message ("airdrop request failed... 429 Too Many Requests") is the useful
      // half; the second sentence is the part that actually unblocks someone — and it differs by
      // path, because a developer has a script that always works and a visitor does not.
      const message = e instanceof Error ? e.message : String(e);
      const route =
        mode === "burner"
          ? `bun scripts/fund-wallet.mjs ${address} always works`
          : "devnet SOL is free at faucet.solana.com, which is not rate-limited the same way";
      push(`airdrop failed: ${message} — devnet's faucet rate-limits hard; ${route}`, "error");
    } finally {
      setAirdropping(false);
    }
  }, [connection, pubkey, address, push, refresh, mode]);

  return {
    pubkey: address,
    // An em dash rather than an empty string: this is rendered in the top chrome, where a blank
    // reads as a figure that failed to load rather than as an absence of one.
    short: pubkey === null ? "—" : shortKey(address),
    solBalance,
    airdrop,
    airdropping,
    refresh,
    // Straight through from the identity: this hook knows about money, the identity knows about
    // who and how, and neither restates the other.
    mode,
    status: identity.status,
    fault: identity.fault,
    connect: identity.connect,
    disconnect: identity.disconnect,
  };
}
