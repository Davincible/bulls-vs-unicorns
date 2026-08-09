// The two identities, and the properties that stop each of them lying about what it can do.
//
// The most important test in this file is the last one: that a disconnected wallet REFUSES to sign
// rather than producing a signature nobody can use. Everything else here is shape-checking.

import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, Transaction, type VersionedTransaction } from "@solana/web3.js";
import { createBurnerWallet } from "../../chain/useSigner.ts";
import {
  NO_WALLET_MESSAGE,
  asAnchorWallet,
  burnerIdentity,
  disconnectedWallet,
  newTickerPlaceholder,
  walletIdentity,
} from "./identity.ts";
import { classifyWalletError } from "./walletFault.ts";

/** Stands in for Phantom: a public key and an async signer, and NO SECRET KEY ANYWHERE — which is
 *  the property that matters, and the reason `asAnchorWallet` has to exist (anchor's exported
 *  `Wallet` type demands a `payer: Keypair` this object cannot have). */
function fakeWalletFor(kp: Keypair) {
  return asAnchorWallet({
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => tx,
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => txs,
  });
}

const NOOP = async () => {};

describe("burnerIdentity", () => {
  it("is connected by construction and can never fault", () => {
    // None of the wallet states are reachable on this path — the key exists the moment the page
    // loads. This is what lets `playBlock` skip every connection branch in burner mode.
    const kp = Keypair.generate();
    const id = burnerIdentity(kp, createBurnerWallet(kp));
    expect(id).toMatchObject({ mode: "burner", status: "connected", fault: null });
  });

  it("signs with the raw keypair, exactly as this page did before wallets existed", () => {
    const kp = Keypair.generate();
    const id = burnerIdentity(kp, createBurnerWallet(kp));
    // `sendTx` branches on `"secretKey" in signer` to sign synchronously. Handing it anything else
    // here would silently change the burner path's behaviour, which this workstream must not do.
    expect(id.txSigner).toBe(kp);
    expect(id.tickerKeypair).toBe(kp);
    expect(id.player?.equals(kp.publicKey)).toBe(true);
  });
});

describe("walletIdentity", () => {
  const tickerKeypair = newTickerPlaceholder();

  it("names the player and the signer together, or names neither", () => {
    // The invariant that matters: there is no state in which the page believes it can sign for
    // someone it cannot name, or names someone it cannot sign for.
    const kp = Keypair.generate();
    const connected = walletIdentity({
      wallet: fakeWalletFor(kp),
      status: "connected",
      fault: null,
      tickerKeypair,
      connect: NOOP,
      disconnect: NOOP,
    });
    expect(connected.player?.equals(kp.publicKey)).toBe(true);
    expect(connected.txSigner?.publicKey.equals(kp.publicKey)).toBe(true);

    const disconnected = walletIdentity({
      wallet: null,
      status: "disconnected",
      fault: null,
      tickerKeypair,
      connect: NOOP,
      disconnect: NOOP,
    });
    expect(disconnected.player).toBeNull();
    expect(disconnected.txSigner).toBeNull();
  });

  it("hands sendTx the wallet itself rather than a copy that could drift", () => {
    const kp = Keypair.generate();
    const wallet = fakeWalletFor(kp);
    const id = walletIdentity({
      wallet,
      status: "connected",
      fault: null,
      tickerKeypair,
      connect: NOOP,
      disconnect: NOOP,
    });
    // `Wallet` is structurally a superset of `sendTx`'s `WalletLikeSigner`, so the signer is the
    // wallet's own method — not a wrapper that could be built from a stale reference.
    expect(id.txSigner).not.toBeNull();
    // `sendTx` branches on `"secretKey" in signer` to decide between synchronous keypair signing and
    // an async wallet round-trip. A browser wallet must take the second branch.
    expect(id.txSigner).not.toHaveProperty("secretKey");
    const signer = id.txSigner as { signTransaction: unknown };
    expect(signer.signTransaction).toBe(wallet.signTransaction);
  });

  it("carries a placeholder ticker key that holds nothing", () => {
    // See landmine 1 in identity.ts. It exists only to satisfy `useFightTicker`'s required parameter;
    // `shouldDriveFight` is what makes it unreachable, and `fightPace.test.ts` proves that.
    const id = walletIdentity({
      wallet: null,
      status: "disconnected",
      fault: null,
      tickerKeypair,
      connect: NOOP,
      disconnect: NOOP,
    });
    expect(id.tickerKeypair).toBe(tickerKeypair);
    // Freshly generated per page and never persisted: it must not be the burner, whose secret key
    // lives in localStorage under a well-known name.
    expect(newTickerPlaceholder().publicKey.equals(tickerKeypair.publicKey)).toBe(false);
  });
});

describe("disconnectedWallet", () => {
  it("is a real, valid PublicKey so AnchorProvider can be constructed at all", () => {
    const w = disconnectedWallet();
    expect(w.publicKey.equals(PublicKey.default)).toBe(true);
    // The all-zero key. No fighter in any round can equal it, so it can never be mistaken for a
    // player — which is the whole reason it is the right stand-in.
    expect(w.publicKey.toBase58()).toBe("11111111111111111111111111111111");
  });

  it("REFUSES to sign, rather than producing a signature nobody can use", async () => {
    // The landmine. A throwaway keypair here would "work" — and then fail on chain with "Attempt to
    // debit an account but found no record of a prior credit", which names nothing a reader can act
    // on. An immediate local error is worth more than a remote one.
    const w = disconnectedWallet();
    await expect(w.signTransaction(new Transaction())).rejects.toThrow(NO_WALLET_MESSAGE);
    await expect(w.signAllTransactions([new Transaction()])).rejects.toThrow(NO_WALLET_MESSAGE);
  });

  it("refuses with a sentence, not a symptom", async () => {
    const w = disconnectedWallet();
    const err = await w.signTransaction(new Transaction()).catch((e: unknown) => e);
    // And it must survive the classifier without being mangled into a network story or an install
    // prompt — it is already the answer.
    const fault = classifyWalletError(err);
    expect(fault.detail).toContain("Connect a wallet first");
  });
});
