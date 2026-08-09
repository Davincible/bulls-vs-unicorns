// Burner-keypair signer — Phase 1's default, per snug-floating-mitten.md assumption #1: a hackathon
// judge shouldn't need Phantom pre-configured to devnet to try this. Generated client-side, persisted
// to localStorage so it survives a page reload (losing the keypair on every refresh would mean losing
// every entered fighter's identity, mid-demo). Session Keys (Phase 6) layers on top of this later —
// this file only produces a plain `Wallet`-shaped signer, exactly what `AnchorProvider` expects.

import { Keypair, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import type { Wallet } from "@coral-xyz/anchor";
import { useMemo } from "react";

const STORAGE_KEY = "er-demo:burner-secret-key";

/** JSON array of the 64-byte secret key — same on-disk shape as `.devnet/fork-payer.json`, chosen
 *  for consistency with the rest of this project's keypair files rather than base64 (both are
 *  equally compact for a 64-byte key; JSON array needs no encode/decode step and is trivial to
 *  eyeball in devtools if something looks wrong). */
function readStoredKeypair(): Keypair | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const secretKey = Uint8Array.from(JSON.parse(raw));
    return Keypair.fromSecretKey(secretKey);
  } catch (e) {
    // A corrupted or foreign value under this key must not crash the app — fall through and mint a
    // fresh burner instead, same as if nothing had been stored.
    console.warn(`[useSigner] stored burner key at ${STORAGE_KEY} was unreadable, minting a new one`, e);
    return null;
  }
}

function persistKeypair(keypair: Keypair): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(keypair.secretKey)));
}

/** Pure, no side effects beyond localStorage read/write — reused by the Phase 1 verification script
 *  (outside React) to exercise the same signer-construction logic the app itself will run. Falls
 *  back to a fresh, unpersisted keypair when there's no localStorage at all (a plain Node/Bun
 *  process), rather than throwing — a burner signer with no browser to persist it in is still a
 *  valid burner signer for the duration of that process. */
export function loadOrCreateBurnerKeypair(): Keypair {
  const existing = readStoredKeypair();
  if (existing) return existing;
  const fresh = Keypair.generate();
  persistKeypair(fresh);
  return fresh;
}

export function clearStoredBurnerKeypair(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}

/** Wraps a raw `Keypair` in the `Wallet` shape `AnchorProvider` requires. A burner keypair signs
 *  fully client-side (no hardware wallet round-trip), so both methods resolve synchronously. */
export function createBurnerWallet(keypair: Keypair): Wallet {
  return {
    publicKey: keypair.publicKey,
    payer: keypair,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if ("version" in tx) {
        tx.sign([keypair]);
      } else {
        tx.partialSign(keypair);
      }
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      for (const tx of txs) {
        if ("version" in tx) {
          tx.sign([keypair]);
        } else {
          tx.partialSign(keypair);
        }
      }
      return txs;
    },
  };
}

export interface SignerHandle {
  keypair: Keypair;
  wallet: Wallet;
}

/** React hook: the burner keypair for this browser, loaded/created once per mount and stable across
 *  re-renders. `chain/sendTx.ts` signs raw with the `Keypair` directly (see its own module comment
 *  on why `AnchorProvider`'s send path can't be used against the router) — `wallet` exists for
 *  constructing `AnchorProvider`/`Program` and for future Session-Key/wallet-adapter parity, where
 *  only the `Wallet` shape is available, not a raw `Keypair`. */
export function useSigner(): SignerHandle {
  return useMemo<SignerHandle>(() => {
    const keypair = loadOrCreateBurnerKeypair();
    return { keypair, wallet: createBurnerWallet(keypair) };
  }, []);
}
