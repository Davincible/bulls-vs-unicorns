// Phase 6, snug-floating-mitten.md. The ONLY file in this app that imports
// `@magicblock-labs/gum-react-sdk` — enforcing the anchor-0.30-vs-0.32 boundary by IMPORT LOCATION,
// not just convention (per the plan's own project-structure section). gum-react-sdk bundles its own
// `@coral-xyz/anchor@0.30.1` to talk to the `gpl_session` program; every bulls-arena instruction in
// this app (chain/program.ts, chain/round.ts) is built against our own `@coral-xyz/anchor@0.32.1`.
// The two never call into each other — this file is the seam, and everything it exports is plain
// `PublicKey`s and functions, nothing from either Anchor copy's own types.
//
// Proven combination: Session Keys DOES work against an Ephemeral-Rollup-delegated account (Phase 0
// spike, programs/bulls-arena-session-spike, commit e3fb149) — this hook is the real app's use of
// that same, now-real (`programs/bulls-arena`), on-chain shape.

import { useCallback, useMemo } from "react";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import type { Cluster, Connection, Transaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { useSessionKeyManager as useGumSessionKeyManager } from "@magicblock-labs/gum-react-sdk";

/** Everything chain/round.ts and the UI need to build a session-signed `enter()`/`extract()` call.
 *  Deliberately holds no gum-react-sdk types — see this file's header comment. */
export interface ActiveSession {
  /** The session key's own pubkey — goes in the on-chain `signer` account, the one that actually
   *  signs the transaction. */
  signerPubkey: PublicKey;
  /** The real wallet's pubkey — goes in the on-chain `player` account, the fighter identity that
   *  gets credited regardless of which key signed. */
  playerPubkey: PublicKey;
  /** The on-chain `SessionToken` PDA — goes in the `session_token` account.
   *
   *  Read directly off gum-react-sdk's own resolved `sessionToken` string rather than re-derived by
   *  hand here: `createSession` already computed this exact address via its own instruction
   *  builder's `pubkeys()` call and persisted it (see the hook's compiled source — it ships no
   *  source tree, MAGICBLOCK_FEEDBACK.md has the full note on that — under
   *  `node_modules/@magicblock-labs/gum-react-sdk/lib/index.js`). Re-deriving the same PDA a second
   *  time here would just be a second place to get the seed order
   *  (`[b"session_token", target_program, session_signer, authority]`, confirmed against that same
   *  source and against `bulls-arena-session-spike`'s Phase 0 script) wrong for zero benefit. */
  sessionTokenPda: PublicKey;
  /** Signs with the session keypair — gum-react-sdk's own `signTransaction`. Safe to hand a
   *  transaction that already has `feePayer`/`recentBlockhash` set: gum's implementation only fills
   *  either in when absent, so chain/sendTx.ts's account-aware blockhash fetch (its own "SDK
   *  SURPRISE #1") is never shadowed by this function fetching its own, unrouted one. */
  signTransaction: <T extends Transaction>(tx: T) => Promise<T>;
}

export interface SessionManager {
  isLoading: boolean;
  error: string | null;
  /** Non-null only once a session exists and is actually usable (a real keypair loaded, a real
   *  token PDA resolved). Null means "no session" — every call site falls back to direct wallet
   *  signing in that case, matching the on-chain `Option<Account<SessionToken>>` default
   *  (`session_token: null`, `signer == player`) — see chain/round.ts's `enter`/`extract`. */
  active: ActiveSession | null;
  /** One signature from the real wallet, authorizing a fresh session key scoped to `targetProgram`
   *  (bound in by `useAppSessionManager`'s own caller, not passed per-call — this app only ever
   *  needs a session for one program). */
  createSession: () => Promise<void>;
  revokeSession: () => Promise<void>;
}

// gum-react-sdk's own `.d.ts` names this parameter `validUntil` and types it as though it were an
// absolute timestamp — it is not. Read directly from the compiled hook (see this file's header
// comment on why source isn't shipped): `expiryTimestamp = Math.ceil((Date.now() + expiryInMinutes *
// 60 * 1000) / 1000)`, i.e. the third argument is MINUTES FROM NOW, capped at `24 * 60` (the hook
// throws "Expiry cannot be more than 24 hours" above that) — a real `.d.ts`/behaviour mismatch, not
// a guess; worth a MAGICBLOCK_FEEDBACK.md entry alongside the others found this session.
const SESSION_VALID_MINUTES = 60;
// Funds the session key's OWN account so IT can pay enter()/extract()'s tx fees without ever
// touching the player's wallet again after this one signature — same amount and reasoning as Phase
// 0's spike script (0.01 SOL there; doubled here since a real session now spans both enter AND
// extract, not enter alone, so it should comfortably outlast more fee-paying transactions).
const SESSION_TOP_UP_LAMPORTS = 0.02 * 1_000_000_000;

/** Wraps gum-react-sdk's `useSessionKeyManager` in the narrower shape this app actually needs —
 *  see `ActiveSession`/`SessionManager`'s own doc comments. `wallet` should be the burner wallet
 *  adapted to `AnchorWallet` (chain/useSigner.ts's `toAnchorWallet`); `connection` should be a
 *  BASE-layer connection, not the router — `create_session`/`revoke_session` call the `gpl_session`
 *  program directly, which is never delegated to an Ephemeral Rollup, exactly like Phase 0's spike
 *  script used `base`, not `router`, for the same calls. */
export function useAppSessionManager(
  wallet: AnchorWallet,
  connection: Connection,
  cluster: Cluster | "localnet",
  targetProgram: PublicKey,
): SessionManager {
  const gum = useGumSessionKeyManager(wallet, connection, cluster);

  const active = useMemo<ActiveSession | null>(() => {
    if (!gum.sessionToken || !gum.publicKey || !gum.signTransaction) return null;
    return {
      signerPubkey: gum.publicKey,
      playerPubkey: wallet.publicKey,
      sessionTokenPda: new PublicKey(gum.sessionToken),
      signTransaction: gum.signTransaction,
    };
  }, [gum.sessionToken, gum.publicKey, gum.signTransaction, wallet.publicKey]);

  const createSession = useCallback(async () => {
    await gum.createSession(targetProgram, SESSION_TOP_UP_LAMPORTS, SESSION_VALID_MINUTES);
  }, [gum, targetProgram]);

  const revokeSession = useCallback(async () => {
    await gum.revokeSession();
  }, [gum]);

  return { isLoading: gum.isLoading, error: gum.error, active, createSession, revokeSession };
}
