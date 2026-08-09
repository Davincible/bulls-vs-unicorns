// Composition root — wires burner signer -> program -> polled round state -> both the plain-text
// RoundPanel (Phase 3) and the Pixi arena/Extract/Verify screens (Phases 4/5, integrated here).
// Phases 3/4/5 were built concurrently this session as self-contained, props-driven pieces with an
// explicit file-ownership split precisely so they wouldn't collide; this file is where they actually
// get wired together into one running app.

import { useEffect, useMemo, useState } from "react";
import { Connection } from "@solana/web3.js";
import { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BASE_RPC, PROGRAM_ID, ROUTER_URL } from "./chain/constants.ts";
import { createProgram, type BullsArenaProgram } from "./chain/program.ts";
import { useRound } from "./chain/useRound.ts";
import { toAnchorWallet, useSigner } from "./chain/useSigner.ts";
import { useAppSessionManager } from "./chain/session/useSessionKeyManager.ts";
import { arenaPda, roundPdaForRoundNo } from "./chain/round.ts";
import { useDemoStore } from "./state/store.ts";
import { ConnectWallet } from "./ui/ConnectWallet.tsx";
import { DevnetBadge } from "./ui/DevnetBadge.tsx";
import { Toasts } from "./ui/Toasts.tsx";
import { RoundPanel } from "./ui/RoundPanel.tsx";
import { SessionButton } from "./ui/SessionButton.tsx";
import { EnterForm } from "./ui/EnterForm.tsx";
import { ExtractButton } from "./ui/ExtractButton.tsx";
import { VerifyPanel } from "./ui/VerifyPanel.tsx";
import { PixiCanvas } from "./render/PixiCanvas.tsx";
import { fromFighterStates } from "./render/adapt.ts";
import { MAX_STEPS } from "./render/gameLoop.ts";
import { runFullFight, type HitEvent, type HitEventEntry } from "./sim/hitEvents.ts";
import "./App.css";

// The round `scripts/admin-open-round.mjs` most recently opened and delegated on devnet (checked
// against the live `arena.roundCounter` during this integration pass — round #9 is PERMANENTLY STUCK
// (Phase 5's own finding: it sat in Fight past the intended window and its resolve() now blows the CU
// ceiling every time), so round #10 is the current default. A judge/tester overrides this per-session
// with `?round=<n>` rather than needing to rebuild; the presenter's admin script is the source of
// truth for what's currently open (assumption #2 in snug-floating-mitten.md — round lifecycle stays
// out of player-facing UI).
const DEFAULT_ROUND_NO = 10n;

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

  // Session Keys (Phase 6). `create_session`/`revoke_session` call the `gpl_session` program
  // directly, which is never delegated to an Ephemeral Rollup — `baseConnection`, not `router`, per
  // chain/session/useSessionKeyManager.ts's own comment (matches Phase 0's spike script). `session
  // .active` is null until "start session" is clicked; every consumer below already treats null as
  // "fall back to direct wallet signing" (EnterForm.tsx/ExtractButton.tsx).
  const anchorWallet = useMemo(() => toAnchorWallet(wallet), [wallet]);
  const session = useAppSessionManager(anchorWallet, baseConnection, "devnet", PROGRAM_ID);

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

  // The store mirror — the ONLY coupling point between chain/ and anything that isn't already holding
  // a `useRound()` result of its own, per snug-floating-mitten.md. In practice, by the time Phases 4/5
  // were wired in here, none of their components ended up needing it: `PixiCanvas` was deliberately
  // built prop-driven (see its own header comment — "no dependency on zustand/a store"), and
  // `ExtractButton`/`VerifyPanel` are equally self-contained, taking `round`/`roundPda` straight from
  // this component's own `useRound()` call. The mirror still earns its keep for `EnterForm`'s toasts
  // (`pushToast`) and stays wired for any future consumer that isn't already polling — but the render
  // layer's own data (fighters, hitEvents, below) is passed as plain props, not routed through here,
  // because nothing else needs to read it and `PixiCanvas`'s contract was written for props.
  useEffect(() => { useDemoStore.getState().setSigner(keypair.publicKey); }, [keypair]);
  useEffect(() => { useDemoStore.getState().setRound(round); }, [round]);

  const pushToast = useDemoStore((s) => s.pushToast);

  // Primitive keys derived from `round`, NOT `round` itself, are what `hitEvents` memoizes on below.
  // `useRound()` (chain/useRound.ts) hands back a brand-new `RoundState` object on every ~1.5s poll
  // even when nothing relevant changed, so memoizing on `round` directly would re-run the full
  // MAX_STEPS-step fight simulation every poll tick — exactly what this task calls out as the thing
  // NOT to do. `seedHex`/`entriesKey` only change when the seed actually reveals (Drawing -> Fight) or
  // when the entry list itself changes shape (never, in practice, once the lobby has closed) — never
  // when only the live per-tick fields (hp/banked/dead) update underneath them.
  const seedHex = round && round.seed.some((b) => b !== 0) ? Buffer.from(round.seed).toString("hex") : null;
  const entriesKey = round ? round.fighters.map((f) => `${f.wallet.toBase58()}:${f.side}:${f.stake}`).join(",") : "";

  // The full precomputed hit sequence for the current fight — a pure function of (seed, entries,
  // steps), per hitEvents.ts's own contract. Runs to MAX_STEPS unconditionally rather than to
  // `round.tickCount` (which is only meaningful once Settled, well after the canvas already needs to
  // start animating): MAX_STEPS is `resolve()`'s own on-chain ceiling (lib.rs), and gameLoop.ts's
  // playhead independently caps at the same constant, so precomputing exactly that far means the
  // event stream never runs out from under a live-playing fight.
  const hitEvents = useMemo<HitEvent[]>(() => {
    if (!seedHex || !round) return [];
    const entries: HitEventEntry[] = round.fighters.map((f) => ({
      wallet: f.wallet.toBase58(),
      side: f.side as 0 | 1,
      stake: f.stake,
    }));
    return runFullFight(Buffer.from(round.seed), entries, MAX_STEPS).events;
    // `round` is deliberately omitted: `seedHex`/`entriesKey` already fully determine everything this
    // closure reads off of it (the seed bytes and each fighter's wallet/side/stake) — see the comment
    // above. Whenever those primitives are unchanged, `round`'s live fields may still have moved, but
    // this computation doesn't depend on them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedHex, entriesKey]);

  // `RenderFighter[]` — cheap to rebuild every render (a plain array map), unlike `hitEvents`. Its one
  // live field, `dead`, MUST track the current poll (see adapt.ts/types.ts): that's what lets
  // `retarget()` stop steering an extracted fighter at the next animation frame without needing a
  // fresh `hitEvents` recompute.
  const renderFighters = useMemo(
    () => (round ? fromFighterStates(round.fighters) : []),
    [round],
  );

  const fightStartedAtMs = round && round.fightStartedAt > 0n ? Number(round.fightStartedAt) * 1000 : null;
  const showArena = round !== null && round.phaseName !== "Lobby";

  return (
    <>
      <DevnetBadge />

      <main className="app">
        <header className="app-header">
          <h1>bulls-arena</h1>
          <p className="app-tagline">
            One real Solana round, played on a MagicBlock Ephemeral Rollup. Enter a side, watch the
            fight play back from the chain's own revealed seed, pull out mid-fight — then re-derive
            the whole result yourself, in this tab, and check it against what the chain settled to.
          </p>
        </header>

        <ConnectWallet keypair={keypair} connection={baseConnection} />

        {/* Fatal for everything downstream — no program means no round, no enter, no extract — so
            this is a persistent banner rather than a dismissible toast. The raw message is included
            verbatim: per the plan's 80/20 cuts there is no per-error-type recovery flow, and a real
            error string a presenter can read out is worth more than a friendly paraphrase of it. */}
        {programError && (
          <p className="app-banner app-banner--error" role="alert">
            <strong>could not load the program IDL</strong> — nothing on this page can talk to the
            chain until this succeeds. {programError.message}
          </p>
        )}

        <div className="app-layout">
          <div className="app-arena">
            {showArena ? (
              <PixiCanvas
                fighters={renderFighters}
                hitEvents={hitEvents}
                fightStartedAtMs={fightStartedAtMs}
                phase={round.phaseName}
              />
            ) : (
              <div className="app-arena-placeholder" aria-label="arena-placeholder">
                the arena appears once the lobby closes and fighters are locked in
              </div>
            )}
            {/* The canvas is the thing everyone in the room is looking at, so the one sentence that
                explains what they're looking at belongs under it, not in a sidebar panel they'd
                have to go find. */}
            <p className="app-arena-caption">
              <span>
                Every impact is a real on-chain exchange, replayed from this round's revealed seed —
                the drifting and bouncing is cosmetic, the hits are not.
              </span>
              <span className="app-arena-phase">{round ? round.phaseName : "no round"}</span>
            </p>
          </div>

          <aside className="app-sidebar">
            <RoundPanel round={round} loading={roundLoading} error={roundError} />

            <SessionButton session={session} />

            <EnterForm
              program={program}
              router={router}
              keypair={keypair}
              arena={arena}
              roundPda={roundPda}
              session={session.active}
            />

            <ExtractButton
              program={program}
              router={router}
              keypair={keypair}
              round={round}
              roundPda={roundPda}
              session={session.active}
              onExtracted={({ signature }) => pushToast(`extracted — ${signature}`, "info")}
            />
          </aside>
        </div>

        {/* Full page width, below the layout, rather than as a sixth sidebar panel. Its comparison
            table is 9 columns of on-chain-vs-replay numbers — in the 480px sidebar the last three
            were permanently scrolled out of sight, on the one screen snug-floating-mitten.md calls
            "THE highest-value screen in the app for a judge." It only renders once a round is
            Settled, which is also exactly the moment there's nothing left to watch on the canvas. */}
        {round?.phaseName === "Settled" && <VerifyPanel round={round} />}
      </main>

      {/* Last in the tree, fixed to the corner (App.css) — a confirmation or a failure has to stay
          readable while the reader is scrolled down watching the canvas, which is where they'll be
          standing the moment either one fires. */}
      <Toasts />
    </>
  );
}

export default App;
