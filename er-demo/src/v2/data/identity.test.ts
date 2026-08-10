// The two identities, and the properties that stop each of them lying about what it can do.
//
// Two tests here are load-bearing rather than shape-checking, and they are the ones to preserve if
// this file is ever pruned: that a disconnected wallet REFUSES to sign rather than producing a
// signature nobody can use, and that the burner's message signature actually VERIFIES. The second is
// the difference between a `signMessage` that is correctly shaped and one that is real — a wrong
// seed slice, a mangled encoding or a swapped argument order all typecheck perfectly and all produce
// 64 bytes no server will accept.

import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, PublicKey, Transaction, type VersionedTransaction } from "@solana/web3.js";
import { createBurnerWallet } from "../../chain/useSigner.ts";
import {
  NO_WALLET_MESSAGE,
  burnerIdentity,
  disconnectedWallet,
  newTickerPlaceholder,
  walletIdentity,
  type ChainIdentity,
  type SigningWallet,
} from "./identity.ts";
import { classifyWalletError } from "./walletFault.ts";

/** A signature the fake wallet could not possibly have computed. It has to be recognisable rather
 *  than valid: a fake that signed honestly would let a `walletIdentity` that had quietly started
 *  signing for itself pass, and handing the WALLET'S bytes back untouched is the only thing
 *  `walletIdentity` is supposed to do on that path. */
const WALLET_SIGNATURE = Uint8Array.from({ length: 64 }, (_, i) => i);

/** Stands in for Phantom: a public key and three async signers, and NO SECRET KEY ANYWHERE — which
 *  is the property that matters. A plain `SigningWallet`, with no `asAnchorWallet` around it: that
 *  cast belongs to `walletIdentity` now, and a test that pre-applied it would be exercising a shape
 *  the provider never passes.
 *
 *  `seen` collects the messages the wallet was asked to sign, for the tests that care what crossed
 *  the boundary rather than what came back. */
function fakeWalletFor(kp: Keypair, seen: Uint8Array[] = []): SigningWallet {
  return {
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => tx,
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => txs,
    signMessage: async (message: Uint8Array): Promise<Uint8Array> => {
      seen.push(message);
      return WALLET_SIGNATURE;
    },
  };
}

const NOOP = async () => {};

/** `ChainIdentity.signMessage` is nullable by design — `null` is how a disconnected page says it
 *  cannot sign. These tests are about the identities that CAN, so this narrows in one place and
 *  fails with a sentence instead of scattering casts through the assertions. */
async function signWith(id: ChainIdentity, message: Uint8Array): Promise<Uint8Array> {
  const sign = id.signMessage;
  if (sign === null) throw new Error("this identity was expected to be able to sign a message");
  return sign(message);
}

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

  it("produces a message signature that actually verifies against the burner's public key", async () => {
    // THE TEST THAT PROVES THE THING IS REAL. Every plausible mistake in `signWithKeypair` —
    // passing all 64 secret bytes instead of the 32-byte seed, signing the public key, swapping
    // noble's (message, key) argument order — still returns 64 bytes and still typechecks. Only a
    // verification distinguishes them, and the party doing the verifying in production is a server
    // that will simply refuse the link with no way for anyone to see why.
    const kp = Keypair.generate();
    const id = burnerIdentity(kp, createBurnerWallet(kp));
    const message = new TextEncoder().encode("bullsvsunicorns.fun wants to link your X account.");

    const signature = await signWith(id, message);
    // RAW BYTES, NOT A WRAPPER AND NOT BASE64 — the two things the interface promises it is not. A
    // 64-character base64 string would satisfy `toHaveLength` alone, which is why both are here.
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature).toHaveLength(64);
    expect(ed25519.verify(signature, message, kp.publicKey.toBytes())).toBe(true);
  });

  it("survives a message whose bytes are not its characters, verified from the server's position", async () => {
    // THE BYTE PATH, END TO END, FROM WHERE `/api/x/link` STANDS. That endpoint holds two strings —
    // the canonical message it composed, and the wallet in base58 — and reconstructs the bytes and
    // the key from them before verifying. Nothing it has ever touched the signer's own arrays.
    //
    // The message is deliberately full of characters outside ASCII: the canonical text is written in
    // this project's register (em dashes, arrows) and it quotes an X display name, which is
    // arbitrary user-chosen unicode. Any step that went through a latin-1 conversion, a UTF-16
    // length, or a "safe" re-encoding would leave a signature over different bytes than the
    // verifier reconstructs — and would pass every test above.
    const kp = Keypair.generate();
    const id = burnerIdentity(kp, createBurnerWallet(kp));
    const canonical =
      "bullsvsunicorns.fun — link your X account\n" +
      `Wallet:  ${kp.publicKey.toBase58()}\n` +
      "X:       @ünicørn🦄 (龍) → id 1234567890\n" +
      "Signing this proves you control this wallet. It moves no funds.";

    const signature = await signWith(id, new TextEncoder().encode(canonical));

    const rebuiltMessage = new TextEncoder().encode(canonical);
    const rebuiltKey = new PublicKey(kp.publicKey.toBase58()).toBytes();
    expect(ed25519.verify(signature, rebuiltMessage, rebuiltKey)).toBe(true);
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
    // `signMessage` is bound by the same invariant and must move with the other two: an identity
    // that could sign a link message for a player it cannot name would be exactly the state this
    // whole shape exists to make unrepresentable.
    expect(connected.signMessage).not.toBeNull();

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
    expect(disconnected.signMessage).toBeNull();
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

  it("hands the wallet's own message signature back untouched, in both directions", async () => {
    // THE ONLY JOB ON THIS PATH IS NOT GETTING IN THE WAY. Wallet mode cannot sign anything itself —
    // the bytes go out to an extension and a signature comes back — so the failure to guard against
    // is a well-meant transformation in between: a copy, a re-encode, a "helpful" base64.
    const kp = Keypair.generate();
    const seen: Uint8Array[] = [];
    const id = walletIdentity({
      wallet: fakeWalletFor(kp, seen),
      status: "connected",
      fault: null,
      tickerKeypair,
      connect: NOOP,
      disconnect: NOOP,
    });

    // Multi-byte on purpose: the canonical message quotes an X display name, which is arbitrary
    // unicode, and this is the layer where a stray `String`/`Buffer` round-trip would corrupt it.
    const message = new TextEncoder().encode("link @ünicørn🦄 — nonce 0f3a");
    const signature = await signWith(id, message);

    expect(seen).toEqual([message]);
    expect(signature).toBe(WALLET_SIGNATURE);
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
    // The same answer for a plain message, and it must be the same STRING: a link ceremony that
    // reached this object has hit the identical situation as one that reached the other two, and
    // two accounts of one situation is how copy drifts apart.
    await expect(w.signMessage(new TextEncoder().encode("link"))).rejects.toThrow(NO_WALLET_MESSAGE);
  });

  it("is ONE frozen instance, because its object identity is measured in RPC calls", () => {
    // Not a tidiness assertion. `walletIdentity` puts this on `anchorWallet`, `useChain`'s
    // `createProgram` effect keys on it, and `program` identity feeds `useHistory`, which sweeps up
    // to 250 round accounts. A factory here bought three full sweeps per wallet-mode load against
    // the public devnet RPC instead of one — see the comment above `DISCONNECTED_WALLET`. Nothing
    // about that regression is visible locally, which is exactly why it needs a test.
    expect(disconnectedWallet()).toBe(disconnectedWallet());
    // And frozen, so nothing can quietly give it the ability to sign later — including the
    // `signMessage` this workstream just added to it.
    expect(Object.isFrozen(disconnectedWallet())).toBe(true);
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
