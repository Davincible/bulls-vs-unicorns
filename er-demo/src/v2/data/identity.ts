// WHO IS PLAYING, and what they can sign with — the one object the two chain providers differ by.
//
// `ArenaProvider` used to call `useSigner()` and thread a raw `Keypair` into three hooks. That works
// for exactly one kind of player: a burner key this browser minted for itself. A stranger arriving
// on a public URL has a Phantom wallet, which is a `publicKey` plus an async `signTransaction` and
// no secret key at all — so the thing the provider passes around cannot be a `Keypair` any more. It
// is this: an identity, with whatever signing capability that identity happens to have.
//
// Both providers build one of these and hand it to the same `ChainArena`, which is what keeps the
// wiring — the round poll, the history, the session manager, the ticker, the actions — in one place
// instead of forked in two.
//
// ================================================================================================
// TWO LANDMINES, WRITTEN OUT IN FULL BECAUSE BOTH LOOK LIKE TIDINESS TO REMOVE.
//
// 1. `tickerKeypair` IN WALLET MODE IS A PLACEHOLDER THAT MUST NEVER SIGN.
//
//    `chain/useFightTicker.ts` takes a REQUIRED `keypair: Keypair` and signs with it on the branch
//    where no session is active. That file is `src/chain/**` and this workstream may not edit it, so
//    the parameter cannot be made optional and cannot be widened to `TxSigner`.
//
//    In wallet mode there is no keypair in existence to pass. So we generate one — in memory, never
//    persisted, never funded, holding nothing — and rely on `shouldDriveFight` refusing to enable
//    the ticker in wallet mode unless a session key is active. When a session IS active, the ticker
//    takes the session branch and this key is not read. The branch that would use it is therefore
//    unreachable, and `fightPace.test.ts`'s "PROOF" case is the assertion that keeps it that way.
//
//    DO NOT "simplify" this by reusing the burner. `loadOrCreateBurnerKeypair()` writes a secret key
//    into localStorage — for a stranger who never asked for one, on a page whose entire point is
//    that they bring their own wallet. That is the exact behaviour this workstream exists to delete,
//    and it would come back disguised as removing a duplicate.
//
// 2. `disconnectedWallet()` REJECTS RATHER THAN SIGNING SOMETHING USELESS.
//
//    `createProgram` and `useAppSessionManager` both want a wallet object at all times, including
//    before anyone has connected — they are constructed on the first render and a conditional hook
//    is not an option. The tempting fill-in is a throwaway keypair, which would "work": it can sign.
//    It would also produce a transaction that fails on chain for a reason ("Attempt to debit an
//    account but found no record of a prior credit") that names nothing a reader could act on.
//    A wallet that throws "connect a wallet first" the instant anything asks it to sign turns a
//    silent, expensive, remote failure into an immediate local answer.
// ================================================================================================

import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import type { Wallet } from "@coral-xyz/anchor";
import type { TxSigner } from "../../chain/sendTx.ts";
import type { SignerMode } from "./flags.ts";
import type { WalletFault } from "./walletFault.ts";
import type { WalletStatus } from "./walletConnection.ts";

export interface ChainIdentity {
  mode: SignerMode;
  /** THE FIGHTER IDENTITY the chain credits — the `player` account on `enter`/`extract`, regardless
   *  of which key signs. `null` means nobody is playing yet, which is a real and common state in
   *  wallet mode and never happens in burner mode. */
  player: PublicKey | null;
  /** For `createProgram` (an `AnchorProvider` needs one to exist) and for the session manager, which
   *  is typed against `AnchorWallet`. Never null — see landmine 2. */
  anchorWallet: Wallet;
  /** Signs `enter`/`extract` when no session key is active: the raw `Keypair` in burner mode, the
   *  wallet's own async `signTransaction` in wallet mode (`sendTx` accepts either — see its
   *  `TxSigner` union). `null` when nobody is connected, which is what makes an accidental press
   *  produce a sentence instead of a stack trace. */
  txSigner: TxSigner | null;
  /** SIGNS A SENTENCE, NOT A TRANSACTION — one prompt, no fee, nothing on chain, no funds moved.
   *
   *  The X link ceremony is the only caller (`TWITTER-CONNECT.md` §4.1 step 5): the server hands the
   *  browser a canonical message naming this wallet and one X account, the wallet signs it, and the
   *  server verifies the signature against the wallet's public key. That signature is the entire
   *  proof that the person who just finished an OAuth flow also controls this key — so it is the
   *  thing that makes the link unforgeable, and it is why this member exists at all.
   *
   *  `null` when nobody is connected, mirroring `txSigner` exactly and for the same reason: it is
   *  what makes an accidental press produce a sentence instead of a stack trace. Bytes in, raw
   *  64-byte detached signature out — see `SigningWallet.signMessage` for what is NOT done to them. */
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
  /** See landmine 1. In burner mode this is the burner itself and is used exactly as before. */
  tickerKeypair: Keypair;
  status: WalletStatus;
  fault: WalletFault | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/** The message every unsignable path answers with. One string so the three places that can produce
 *  it cannot drift into three different accounts of the same situation. */
export const NO_WALLET_MESSAGE =
  "Connect a wallet first — this page has nothing to sign with until you do.";

/**
 * EVERYTHING THIS APP EVER ASKS A WALLET TO DO. The first three are the members `AnchorProvider`
 * consumes; the fourth it has never heard of.
 *
 * `signMessage` sits on the same interface rather than on a second one because it is the same
 * object — one wallet, one place to look for what it can do. Anchor never sees the extra member
 * (`asAnchorWallet` casts to a type that does not declare it, and structural excess is not an
 * error), so widening this costs the anchor path nothing.
 */
export interface SigningWallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
  /**
   * Sign a plain message — one prompt, no transaction, no funds moved.
   *
   * RETURNS THE RAW 64-BYTE DETACHED ED25519 SIGNATURE, and each of those words is load-bearing.
   * Not a wrapper object: Phantom's injected provider resolves `{ signature, publicKey }` and the
   * adapter already unwraps it, so a second wrapper here would be a shape every caller has to learn.
   * Not base64, not hex: how a signature is encoded for a wire is the business of whoever is
   * transporting it, and a wallet layer that picks one has decided a question it was not asked.
   *
   * AND NOTHING IS DONE TO THE MESSAGE. No prefix, no hash, no re-encoding, no normalisation — the
   * bytes handed in are the bytes signed, so a verifier that reconstructs them from the same string
   * gets `true` and one that does not gets `false`. That is the only property the link ceremony
   * needs, and the only one that survives a message containing characters outside ASCII.
   */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * THE ONE CAST IN THIS FILE, and it is a `.d.ts` problem rather than a soundness one.
 *
 * `@coral-xyz/anchor` exports `Wallet` as `class Wallet extends NodeWallet` — a CLASS whose
 * `readonly payer: Keypair` is REQUIRED. The structural interface `AnchorProvider` is written
 * against (`publicKey` plus the two sign methods, `payer?` optional) lives in the package's internal
 * `provider.d.ts` and is not re-exported, so the only `Wallet` a caller can name is the Node one.
 *
 * A browser wallet has no secret key by definition, so it cannot produce a `payer` and cannot
 * satisfy that type honestly. The alternatives are worse: inventing a throwaway `Keypair` to fill
 * the field would put a real, signature-capable key on the object, and the one code path that reads
 * `payer` — `NodeWallet.signTransaction`, `tx.partialSign(this.payer)` — would then sign with a key
 * holding nothing instead of failing loudly.
 *
 * NOTHING ON THIS APP'S PATHS READS `payer`. `AnchorProvider` stores the wallet and calls
 * `signTransaction`; `chain/sendTx.ts` bypasses `AnchorProvider`'s send path entirely (its "SDK
 * SURPRISE #1"); `toAnchorWallet` narrows to wallet-adapter's `AnchorWallet`, which does not have
 * the field at all. Same contained-bridge-cast pattern, and same reasoning, as `chain/program.ts`.
 */
export function asAnchorWallet(w: SigningWallet): Wallet {
  return w as unknown as Wallet;
}

/**
 * An anchor `Wallet` for the window before anybody has connected.
 *
 * `PublicKey.default` is the all-zero key (the System Program's address), which is the closest thing
 * Solana has to a written "nobody": it is a real, valid `PublicKey` so `AnchorProvider` is satisfied,
 * and no fighter in any round can ever equal it. Every sign method rejects — see landmine 2.
 */
const refuseToSign = async (): Promise<never> => {
  throw new Error(NO_WALLET_MESSAGE);
};

/**
 * ONE INSTANCE, AND ITS IDENTITY IS LOAD-BEARING — this was a factory, and the cost was measured in
 * RPC calls rather than allocations.
 *
 * `walletIdentity` puts this object on `anchorWallet`, and `useChain`'s `createProgram` effect used
 * to key on it. A factory therefore produced a fresh `Program` at every step of a normal wallet-mode
 * load (`unsupported` → `disconnected` → `connected`), and `program` identity feeds `useHistory`,
 * which sweeps up to 250 round accounts eight at a time. Three sweeps per load instead of one,
 * against the public devnet RPC whose 429s this repo already documents as its first failure mode —
 * and another full sweep every time a cancelled connect changed `fault`.
 *
 * It is safe to share because it is stateless: every method only throws, and `PublicKey` is
 * immutable. Frozen so nothing can quietly give it the ability to sign later.
 *
 * TYPED AS `SigningWallet`, NOT `Wallet`, AND THE CAST MOVED TO THE CALLER — the one change this
 * object needed when it gained `signMessage`. Anchor's `Wallet` does not declare that member, so
 * storing the instance pre-cast would have hidden it from every reader and from the compiler,
 * leaving the file's most important refusal reachable only through a second cast. `asAnchorWallet`
 * is a no-op at runtime, so `walletIdentity` casting at the point where anchor's type is genuinely
 * required hands `createProgram` this exact object, with this exact identity, as it always did.
 */
const DISCONNECTED_WALLET: SigningWallet = Object.freeze({
  publicKey: PublicKey.default,
  signTransaction: <T extends Transaction | VersionedTransaction>(_tx: T): Promise<T> => refuseToSign(),
  signAllTransactions: <T extends Transaction | VersionedTransaction>(_txs: T[]): Promise<T[]> => refuseToSign(),
  signMessage: (_message: Uint8Array): Promise<Uint8Array> => refuseToSign(),
});

export function disconnectedWallet(): SigningWallet {
  return DISCONNECTED_WALLET;
}

/**
 * The identity for a connected wallet, or the disconnected stand-in — built from what `usePhantom`
 * reports. Pure, so `identity.test.ts` can check the two shapes without a browser.
 *
 * `wallet` and `player` move together by construction: a wallet object exists exactly when there is
 * a public key to sign with, so there is no state in which the page believes it can sign for someone
 * it cannot name.
 *
 * IT TAKES THE `SigningWallet`, NOT THE ANCHOR `Wallet`, and that is deliberate rather than
 * incidental. Anchor's exported type declares three members and knows nothing about `signMessage`,
 * so accepting it here would mean reaching the message signature through a cast on every call — a
 * cast that asserts a member the type system had already been told did not exist. Taking the honest
 * type instead means the ONE place that needs anchor's shape (`anchorWallet`) is the one place that
 * casts, `asAnchorWallet` keeps its single documented justification, and `usePhantom` — which builds
 * this object and knows exactly what it can do — no longer has to cast at all.
 */
export function walletIdentity(input: {
  wallet: SigningWallet | null;
  status: WalletStatus;
  fault: WalletFault | null;
  tickerKeypair: Keypair;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}): ChainIdentity {
  const { wallet, status, fault, tickerKeypair, connect, disconnect } = input;
  return {
    mode: "wallet",
    player: wallet?.publicKey ?? null,
    anchorWallet: asAnchorWallet(wallet ?? disconnectedWallet()),
    // `SigningWallet` is structurally a superset of `sendTx`'s `WalletLikeSigner` — the same
    // `publicKey` and the same `signTransaction<T extends Transaction>` — so the wallet IS the
    // signer, with no adapter object in between to get out of step with it.
    txSigner: wallet === null ? null : { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction },
    // WRAPPED, WHERE `txSigner` ABOVE PASSES THE METHOD ITSELF — and the asymmetry is the point.
    // `txSigner` hands `sendTx` an object with the method ON it, so `this` survives the journey.
    // This member is a bare function, and a bare `wallet.signMessage` is an UNBOUND method: any
    // implementation that reads `this` (a class-based adapter is the obvious one) would throw at the
    // call site, which is a stranger halfway through linking their X account. The closure costs one
    // allocation per `useMemo` recompute — the same cost `txSigner`'s object literal already pays —
    // and removes the hazard entirely.
    signMessage: wallet === null ? null : (message: Uint8Array) => wallet.signMessage(message),
    tickerKeypair,
    status,
    fault,
    connect,
    disconnect,
  };
}

/**
 * THE BURNER SIGNING A MESSAGE — the only identity on this page that can do it without a dialog, and
 * the reason the X link ceremony is testable at all.
 *
 * Wallet mode's `signMessage` can only be exercised by a human clicking Approve in an extension.
 * Burner mode's cannot fail that way, so `?signer=burner` is what lets the fixture, the scripts and
 * every headless test drive the whole ceremony — build the canonical message, sign it, verify it —
 * with no browser in the room. That is worth more than the twelve lines it costs.
 *
 * `Keypair.secretKey` IS 64 BYTES: the 32-byte seed followed by the 32-byte public key. That is what
 * NaCl calls a secret key and it is NOT what `@noble/curves` means by one — noble wants the seed
 * alone. Handing it all 64 raises a length error if you are lucky and, in libraries that are lenient
 * about it, silently signs under a key nobody can verify against. The check below derives the public
 * half from the seed we are about to sign with and compares it to the keypair's own: one scalar
 * multiplication, on a path that runs once per link, in exchange for turning that whole class of
 * mistake from a signature a server rejects with no explanation into a local error naming the cause.
 *
 * `@noble/curves` rather than `tweetnacl` because noble is a direct dependency of this package and
 * tweetnacl is only a transitive one — signing under a library nothing declares is a dependency that
 * disappears the day an unrelated package drops it.
 */
function signWithKeypair(keypair: Keypair, message: Uint8Array): Uint8Array {
  const seed = keypair.secretKey.slice(0, 32);
  const derived = ed25519.getPublicKey(seed);
  const expected = keypair.publicKey.toBytes();
  if (derived.length !== expected.length || derived.some((byte, i) => byte !== expected[i])) {
    throw new Error(
      "This keypair's secret key does not derive its own public key, so any signature it produced " +
        "would be unverifiable. The 64-byte secret key's first 32 bytes are the ed25519 seed.",
    );
  }
  return ed25519.sign(message, seed);
}

/**
 * The identity for the burner path — `?signer=burner`, the fixture, and every script and test that
 * predates wallets on this page.
 *
 * It is `"connected"` by construction and can never fault: the key exists the moment the page loads,
 * so none of the wallet states are reachable here. That is why `playBlock` only ever returns
 * `no-program`/`no-sol` in burner mode.
 */
export function burnerIdentity(keypair: Keypair, wallet: Wallet): ChainIdentity {
  return {
    mode: "burner",
    player: keypair.publicKey,
    anchorWallet: wallet,
    // The raw `Keypair`, exactly as before: `sendTx` signs synchronously with it and never opens a
    // dialog. Behaviour on this path is unchanged by this workstream.
    txSigner: keypair,
    // Never null on this path, and never a popup: the key is in memory. `async` only because the
    // contract is shared with a wallet that has to cross an extension boundary to answer.
    signMessage: async (message: Uint8Array) => signWithKeypair(keypair, message),
    tickerKeypair: keypair,
    status: "connected",
    fault: null,
    connect: async () => {},
    disconnect: async () => {},
  };
}

/** One per page, in wallet mode. Exported so the provider's `useMemo` has something to name, and so
 *  the reason it exists is a link away rather than a comment nobody reads twice. */
export function newTickerPlaceholder(): Keypair {
  return Keypair.generate();
}
