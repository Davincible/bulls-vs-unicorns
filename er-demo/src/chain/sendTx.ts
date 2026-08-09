// The router-bypass send path — ported from engine/scripts/er-client-canary.mjs's sendTx() /
// blockhashForAccounts() (its lines ~106-181 at the time of this port). This is the single most
// load-bearing file in chain/: both gotchas below were fought for on real devnet this session and
// silently break if "simplified" back to the obvious-looking `AnchorProvider.rpc()` call.
//
// SDK SURPRISE #1, FOUND BY RUNNING THIS AGAINST REAL DEVNET (not guessed from the .d.ts).
//
// `AnchorProvider.sendAndConfirm` — what `.rpc()` uses under the hood — fetches its blockhash via
// `this.connection.getLatestBlockhash(...)` and sends via a standalone `sendAndConfirmRawTransaction`
// helper. Neither of those goes through `ConnectionMagicRouter`'s OVERRIDDEN `sendTransaction` /
// `sendAndConfirmTransaction`, which are the methods that call `getLatestBlockhashForTransaction` —
// the router's account-aware blockhash lookup that decides whether a transaction is base-layer or
// belongs to a specific ER validator. `.rpc()` against the router therefore fetches a blockhash from
// whatever the router's plain `getLatestBlockhash` defaults to, which does not necessarily match
// where the transaction is about to be routed, and devnet answered every attempt with "Blockhash not
// found". `program.methods.x(...).transaction()` still builds the instruction correctly (all account
// resolution happens there); it is only the SEND path that has to bypass AnchorProvider.
//
// SDK SURPRISE #2. Fixing #1 still wasn't enough for ONE instruction: `close_lobby_and_draw`'s
// writable accounts are `payer`, `round`, AND `oracle_queue` (the ephemeral VRF queue,
// `5hBR571…FRK5Tc`). The generic router refused the transaction outright — not just the blockhash
// lookup, the actual `sendTransaction` too — with "transaction contains accounts that were delegated
// to different ER nodes". Traced (by querying `getDelegationStatus` on each account directly) to the
// queue account's own delegation record naming its authority as the SYSTEM PROGRAM
// (`11111111…1111`), which the multi-validator router cannot map to any ER node's fqdn and refuses to
// reconcile against `round`'s real delegation. The queue is a protocol-level singleton the router
// doesn't know how to place, not evidence that the transaction itself is actually misrouted — querying
// the round's OWN validator directly (`getDelegationStatus(round).fqdn`, same identity
// `getIdentity`/"closest validator" already returned) resolves both `round` and `oracle_queue` fine,
// because that validator hosts the ER `round` is actually delegated to and evidently already knows
// about the well-known VRF queue singleton. Fix: instructions that touch the queue go straight to that
// validator's own RPC, bypassing the generic router for this one call.
//
// ONE DELIBERATE STRUCTURAL CHANGE FROM THE CANARY, LOGIC OTHERWISE UNCHANGED: the canary closed
// over a script-local `let router` set once at the top of an IIFE — fine for a single linear script,
// wrong for a module imported by a React app, a presenter's admin script, AND a verification script,
// each of which construct their own `ConnectionMagicRouter`. `router` is an explicit parameter here
// instead of a shared mutable module global. The blockhash-selection logic, the direct-endpoint
// bypass, the sign/send/confirm sequence — all identical to the original.

import {
  Connection, type Keypair, type PublicKey, type Transaction,
} from "@solana/web3.js";
import type { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";

/** The minimal shape every `program.methods.x(...).accounts({...})` builder has — deliberately not
 *  Anchor's full `MethodsBuilder<Idl, Ix>` generic, which would drag this module's types into every
 *  instruction's specific shape for no benefit; `sendTx` only ever calls `.transaction()`. */
export interface TransactionBuilder {
  transaction(): Promise<Transaction>;
}

/** Anything capable of producing a signature for a `Transaction` that isn't a raw `Keypair` — the
 *  session wallet's shape (chain/session/useSessionKeyManager.ts's `ActiveSession.signTransaction`,
 *  itself gum-react-sdk's `SessionWalletInterface.signTransaction`) once Session Keys (Phase 6) is
 *  active. `sendTx` accepts either this or a `Keypair` (see `TxSigner` below) so the ONE proven
 *  send path — the account-aware blockhash fetch this module exists for — is shared by both the
 *  burner-keypair default and the session-key path, rather than the session path reimplementing
 *  its own send logic elsewhere.
 *
 *  Load-bearing ordering note: `sendTx` sets `tx.feePayer`/`tx.recentBlockhash` BEFORE calling
 *  `signTransaction`. gum-react-sdk's own implementation (decompiled and read directly — it ships
 *  no source, see MAGICBLOCK_FEEDBACK.md) only fills in either field `transaction.recentBlockhash ||
 *  (await connection.getLatestBlockhash(...))` — i.e. only when still unset. Because this module
 *  always sets both first, that fallback path never runs, so the session wallet's own,
 *  UNROUTED `getLatestBlockhash()` call (which would reproduce SDK SURPRISE #1 below) never fires;
 *  the only blockhash ever used is this module's own account-aware one. */
export interface WalletLikeSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction>(tx: T): Promise<T>;
}

export type TxSigner = Keypair | WalletLikeSigner;

function isKeypairSigner(signer: TxSigner): signer is Keypair {
  return "secretKey" in signer;
}

export interface BlockhashResult {
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Same JSON-RPC call `ConnectionMagicRouter.getLatestBlockhashForTransaction` makes internally, but
 *  against an account list WE choose rather than one derived from the transaction's writable keys —
 *  see SDK SURPRISE #2 above for why that derivation isn't safe for every instruction. */
export async function blockhashForAccounts(
  routerUrl: string,
  accounts: PublicKey[],
): Promise<BlockhashResult> {
  const res = await fetch(routerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts",
      params: [accounts.map((a) => a.toBase58())],
    }),
  });
  const body = await res.json();
  if (body.error) {
    throw new Error(
      `getBlockhashForAccounts(${accounts.map((a) => a.toBase58()).join(",")}): ${body.error.message}`,
    );
  }
  return body.result as BlockhashResult;
}

export interface SendRouting {
  /** Override the writable-account set used to pick a blockhash through the generic router
   *  (default: derived from the transaction, matching the router SDK's own logic). */
  blockhashAccounts?: PublicKey[];
  /** Send DIRECTLY to this RPC endpoint (an ER validator's own fqdn) instead of through the generic
   *  router — see SDK SURPRISE #2. */
  endpoint?: string;
}

export interface SendResult {
  signature: string;
  elapsedMs: number;
}

export async function sendTx(
  router: ConnectionMagicRouter,
  methodsBuilder: TransactionBuilder,
  signer: TxSigner,
  label: string,
  routing: SendRouting = {},
): Promise<SendResult> {
  const { blockhashAccounts, endpoint } = routing;
  const tx = await methodsBuilder.transaction();
  tx.feePayer = signer.publicKey;
  const t0 = Date.now();
  const conn = endpoint ? new Connection(endpoint, "confirmed") : router;
  let blockhash: string;
  let lastValidBlockHeight: number;
  if (endpoint) {
    ({ blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed"));
  } else {
    const accountsForBlockhash = blockhashAccounts ?? [tx.feePayer, ...new Set(
      tx.instructions.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey)),
    )];
    ({ blockhash, lastValidBlockHeight } = await blockhashForAccounts(router.rpcEndpoint, accountsForBlockhash));
  }
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  // See `WalletLikeSigner`'s own doc comment above: feePayer/recentBlockhash are already set by the
  // time either branch runs, which is what keeps the session-wallet path on this module's
  // account-aware blockhash instead of fetching its own.
  let signedTx: Transaction;
  if (isKeypairSigner(signer)) {
    tx.sign(signer);
    signedTx = tx;
  } else {
    signedTx = await signer.signTransaction(tx);
  }
  const signature = await conn.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  const elapsedMs = Date.now() - t0;
  console.log(`[sendTx] ${label}  ${elapsedMs}ms  ${signature}`);
  return { signature, elapsedMs };
}
