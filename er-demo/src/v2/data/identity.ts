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

/** The three members `AnchorProvider` actually consumes. */
export interface SigningWallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
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
 * and no fighter in any round can ever equal it. Both sign methods reject — see landmine 2.
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
 * It is safe to share because it is stateless: both methods only throw, and `PublicKey` is
 * immutable. Frozen so nothing can quietly give it the ability to sign later.
 */
const DISCONNECTED_WALLET: Wallet = Object.freeze(
  asAnchorWallet({
    publicKey: PublicKey.default,
    signTransaction: <T extends Transaction | VersionedTransaction>(_tx: T): Promise<T> => refuseToSign(),
    signAllTransactions: <T extends Transaction | VersionedTransaction>(_txs: T[]): Promise<T[]> => refuseToSign(),
  }),
);

export function disconnectedWallet(): Wallet {
  return DISCONNECTED_WALLET;
}

/**
 * The identity for a connected wallet, or the disconnected stand-in — built from what `usePhantom`
 * reports. Pure, so `identity.test.ts` can check the two shapes without a browser.
 *
 * `wallet` and `player` move together by construction: a wallet object exists exactly when there is
 * a public key to sign with, so there is no state in which the page believes it can sign for someone
 * it cannot name.
 */
export function walletIdentity(input: {
  wallet: Wallet | null;
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
    anchorWallet: wallet ?? disconnectedWallet(),
    // `Wallet` is structurally a superset of `sendTx`'s `WalletLikeSigner` — the same `publicKey`
    // and the same `signTransaction<T extends Transaction>` — so the wallet IS the signer, with no
    // adapter object in between to get out of step with it.
    txSigner: wallet === null ? null : { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction },
    tickerKeypair,
    status,
    fault,
    connect,
    disconnect,
  };
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
