// Phase 3 composition root — wires burner signer -> program -> polled round state -> plain-text
// render, per snug-floating-mitten.md's Phase 3 "done" criteria: connect, enter, see your fighter
// appear, backed by a real transaction. No Pixi, no visual layer — that's Phase 4.

import { useEffect, useMemo, useState } from "react";
import { Connection } from "@solana/web3.js";
import { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BASE_RPC, ROUTER_URL } from "./chain/constants.ts";
import { createProgram, type BullsArenaProgram } from "./chain/program.ts";
import { useRound } from "./chain/useRound.ts";
import { useSigner } from "./chain/useSigner.ts";
import { arenaPda, roundPdaForRoundNo } from "./chain/round.ts";
import { useDemoStore } from "./state/store.ts";
import { ConnectWallet } from "./ui/ConnectWallet.tsx";
import { RoundPanel } from "./ui/RoundPanel.tsx";
import { EnterForm } from "./ui/EnterForm.tsx";
import "./App.css";

// The round `scripts/admin-open-round.mjs` most recently opened and delegated on devnet (checked
// against the live `arena.roundCounter` while building this phase — round #9, delegated, Lobby
// phase, 0 fighters). A judge/tester overrides this per-session with `?round=<n>` rather than
// needing to rebuild; the presenter's admin script is the source of truth for what's currently open
// (assumption #2 in snug-floating-mitten.md — round lifecycle stays out of player-facing UI).
const DEFAULT_ROUND_NO = 9n;

function parseRoundNoFromUrl(): bigint {
  const raw = new URLSearchParams(window.location.search).get("round");
  if (!raw) return DEFAULT_ROUND_NO;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : DEFAULT_ROUND_NO;
  } catch {
    return DEFAULT_ROUND_NO;
  }
}

function App() {
  const { keypair, wallet } = useSigner();

  // One router + one base connection for the whole app's lifetime — passing these down rather than
  // letting each component build its own avoids opening redundant duplicate connections for no
  // benefit (they're stateless wrappers around fetch, but there's still no reason to multiply them).
  const router = useMemo(() => new ConnectionMagicRouter(ROUTER_URL, "confirmed"), []);
  const baseConnection = useMemo(() => new Connection(BASE_RPC, "confirmed"), []);

  const arena = useMemo(() => arenaPda(), []);
  const roundPda = useMemo(() => roundPdaForRoundNo(parseRoundNoFromUrl(), arena), [arena]);

  // `createProgram` is async (it fetches the IDL) and `wallet` from `useSigner()` is referentially
  // stable across re-renders (see useSigner.ts's own `useMemo`), so this effect fires once per
  // `router` identity — i.e. once, for the app's whole lifetime, not once per render.
  const [program, setProgram] = useState<BullsArenaProgram | null>(null);
  const [programError, setProgramError] = useState<Error | null>(null);
  useEffect(() => {
    let cancelled = false;
    createProgram(router, wallet)
      .then((p) => { if (!cancelled) setProgram(p); })
      .catch((e: unknown) => { if (!cancelled) setProgramError(e instanceof Error ? e : new Error(String(e))); });
    return () => { cancelled = true; };
  }, [router, wallet]);

  const { round, error: roundError, loading: roundLoading } = useRound(program, roundPda);

  // The store mirror — chain/ (useRound, useSigner) feeds it, render/ (Phase 4) will read it. Phase
  // 3 has no render/ consumer yet, but wiring the mirror now, alongside the hooks it mirrors, is
  // cheaper and clearer than reconstructing "where does this get written" later.
  useEffect(() => { useDemoStore.getState().setSigner(keypair.publicKey); }, [keypair]);
  useEffect(() => { useDemoStore.getState().setRound(round); }, [round]);

  const toasts = useDemoStore((s) => s.toasts);
  const dismissToast = useDemoStore((s) => s.dismissToast);

  return (
    <main className="app">
      <h1>bulls-arena — devnet demo</h1>

      {toasts.length > 0 && (
        <ul aria-label="toasts">
          {toasts.map((t) => (
            <li key={t.id}>
              [{t.kind}] {t.message}{" "}
              <button type="button" onClick={() => dismissToast(t.id)}>
                dismiss
              </button>
            </li>
          ))}
        </ul>
      )}

      <ConnectWallet keypair={keypair} connection={baseConnection} />

      {programError && <p>failed to load program/IDL: {programError.message}</p>}

      <RoundPanel round={round} loading={roundLoading} error={roundError} />

      <EnterForm program={program} router={router} keypair={keypair} arena={arena} roundPda={roundPda} />
    </main>
  );
}

export default App;
