// The chain handles every other data hook needs: two connections, the Anchor program, the arena PDA,
// and — the part that is more than plumbing — WHICH ROUND to show.
//
// Ported from `src/App.tsx`'s composition root, which already fought all of this out on real devnet.
// One deliberate difference: App.tsx keeps a hardcoded `DEFAULT_ROUND_NO` as the fallback for when the
// arena account can't be read. v2 doesn't. A stale constant fails as "Account does not exist" on a
// PDA that is perfectly valid and simply empty, which is the single most confusing way this app can
// break; here, an unreadable arena means `roundNo` stays null and the provider falls through to the
// fixture with the real reason attached (`arenaError` / `roundCounter === 0`). The arena is re-read
// every few seconds, so a transient RPC failure heals itself without a reload.

import { useEffect, useMemo, useRef, useState } from "react";
import { Connection, type PublicKey } from "@solana/web3.js";
import { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";
import type { Wallet } from "@coral-xyz/anchor";
import { BASE_RPC, ROUTER_URL } from "../../chain/constants.ts";
import { createProgram, type BullsArenaProgram } from "../../chain/program.ts";
import { arenaPda, roundPdaForRoundNo } from "../../chain/round.ts";

/** How often the arena's `round_counter` is re-read. Not the round poll — this only has to notice
 *  that a NEW round was opened, which happens between demos, not between frames. */
const ARENA_POLL_MS = 5000;

export interface ChainHandles {
  router: ConnectionMagicRouter;
  /** Base layer. SOL balances and `gpl_session` live here; the delegated round does not. */
  baseConnection: Connection;
  program: BullsArenaProgram | null;
  /** Fatal — the IDL never loaded, so nothing on the page can talk to the chain. */
  programError: string | null;
  arena: PublicKey;
  /** The arena's own `round_counter`, null until it has been read once. `0n` means the arena exists
   *  but no round has ever been opened. */
  roundCounter: bigint | null;
  arenaError: string | null;
  /** The round on screen: `?round=<n>` if pinned, otherwise the arena's latest. */
  roundNo: bigint | null;
  roundPda: PublicKey | null;
  /** True when `?round=<n>` pinned it — a deliberate act the auto-discovery must not override. */
  pinned: boolean;
}

/** An explicit `?round=<n>` always wins — pinning a specific round (a settled one to inspect, a stuck
 *  one to look at) is deliberate and must not be second-guessed. Null means "auto-discover". */
export function parseRoundNoFromUrl(search: string): bigint | null {
  const raw = new URLSearchParams(search).get("round");
  if (!raw) return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/** `enabled` is false in forced-fixture mode (`?fixture=1`): the connections are still constructed
 *  (they are stateless wrappers around `fetch`, and constructing them conditionally would mean
 *  conditional hooks) but nothing is ever fetched, so the page runs with no network at all. */
export function useChain(wallet: Wallet, enabled: boolean): ChainHandles {
  // One router and one base connection for the page's lifetime — see App.tsx's own note: they're
  // cheap, but there's no reason to multiply them.
  const router = useMemo(() => new ConnectionMagicRouter(ROUTER_URL, "confirmed"), []);
  const baseConnection = useMemo(() => new Connection(BASE_RPC, "confirmed"), []);
  const arena = useMemo(() => arenaPda(), []);

  const [program, setProgram] = useState<BullsArenaProgram | null>(null);
  const [programError, setProgramError] = useState<string | null>(null);

  // KEYED ON THE ADDRESS, NOT THE OBJECT — and the comment this replaces was true only while the
  // burner was the only signer.
  //
  // It used to read "`wallet` from `useSigner()` is referentially stable across re-renders, so this
  // runs once for the page's whole lifetime". In wallet mode it is not: the identity is rebuilt as
  // the connection advances (`unsupported` → `disconnected` → `connected`) and again whenever a
  // fault changes. Every rebuild produced a new `Program`, and `program` identity is a dependency of
  // the arena poll, `useLiveRound` AND `useHistory` — which sweeps up to `MAX_ROUNDS` accounts in
  // batches of eight. Rebuilding on object identity turned one history sweep per load into three or
  // more, against the public devnet RPC this repo already documents 429s from.
  //
  // Keying on the base58 address collapses that to exactly one rebuild per ACTUAL signer change,
  // which is the only thing the `Program` cares about. It is safe to hold the wallet in a ref
  // because nothing on this app's paths asks `AnchorProvider` to sign: `chain/sendTx.ts` bypasses
  // its send path entirely (that file's "SDK SURPRISE #1") and every instruction builder in
  // `chain/round.ts` passes its accounts explicitly rather than letting Anchor resolve them off the
  // provider. The wallet is here to satisfy the constructor, not to be used by it.
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const walletKey = wallet.publicKey.toBase58();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    createProgram(router, walletRef.current)
      .then((p) => { if (!cancelled) { setProgram(p); setProgramError(null); } })
      .catch((e: unknown) => { if (!cancelled) setProgramError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [router, walletKey, enabled]);

  const pinned = useMemo(() => parseRoundNoFromUrl(window.location.search), []);

  const [roundCounter, setRoundCounter] = useState<bigint | null>(null);
  const [arenaError, setArenaError] = useState<string | null>(null);
  // Guards a slow arena read from an older `program` landing after a newer one started — same pattern
  // as chain/useRound.ts, for the same reason.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!program) return;
    const thisRequestId = ++requestIdRef.current;
    let cancelled = false;
    const stale = () => cancelled || requestIdRef.current !== thisRequestId;

    const read = async () => {
      try {
        const a = await program.account.arena.fetch(arena);
        if (stale()) return;
        setRoundCounter(BigInt(a.roundCounter.toString()));
        setArenaError(null);
      } catch (e) {
        if (stale()) return;
        setArenaError(e instanceof Error ? e.message : String(e));
      }
    };

    void read();
    // Periodic so a presenter opening the next round between demos is picked up without a reload —
    // and so a transient failure doesn't strand the page on the fixture.
    const id = setInterval(() => void read(), ARENA_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [program, arena]);

  const roundNo = pinned ?? (roundCounter !== null && roundCounter > 0n ? roundCounter : null);
  const roundPda = useMemo(
    () => (roundNo === null ? null : roundPdaForRoundNo(roundNo, arena)),
    [roundNo, arena],
  );

  return {
    router,
    baseConnection,
    program,
    programError,
    arena,
    roundCounter,
    arenaError,
    roundNo,
    roundPda,
    pinned: pinned !== null,
  };
}
