// Drives the live fight: while a round is in Fight phase, this sends `tick()` transactions into the
// Ephemeral Rollup so the on-chain `hp` genuinely decays instead of sitting at each fighter's full
// entry stake until settlement.
//
// WHY THE BROWSER AND NOT A KEEPER. Both work — `tick` is permissionless and outcome-neutral, so it
// does not matter who calls it (see the instruction's own doc comment in lib.rs). Having the client
// do it is the better showcase AND the better engineering: the tab that is watching the fight is the
// one that wants the fight to be current, nobody has to operate a keeper for the demo to work, and if
// every tab closes the round still settles correctly because `resolve` catches up on its own. This is
// a liveness helper, not a dependency — which is the property that stops it becoming a new way for a
// round to get stuck.
//
// IT SENDS NOTHING IT DOES NOT NEED TO. The on-chain cursor only moves at whole-second boundaries
// (the program derives it from `Clock::unix_timestamp`), so this compares the last-known stored
// cursor against `canonicalCursor()` and stays silent when there is no backlog. Firing transactions
// that knowingly do nothing, to make a demo look busy, is the same dishonesty as an `extract()` that
// always returns 100% — the thing this whole change exists to remove.

import { useEffect, useRef, useState } from "react";
import type { Keypair, PublicKey } from "@solana/web3.js";
import type { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";
import { canonicalCursor, Phase, stepsPerSecond } from "./constants.ts";
import { tick } from "./round.ts";
import { sendTx, type TxSigner } from "./sendTx.ts";
import type { BullsArenaProgram } from "./program.ts";
import type { RoundState } from "./useRound.ts";
import type { ActiveSession } from "./session/useSessionKeyManager.ts";

/** How often to look for a backlog. Faster than the once-a-second the cursor can actually move, so a
 *  tick lands promptly after each second boundary rather than up to a second late — the point of
 *  ticking at all is that a player's `extract()` sees a current ring. */
const POLL_MS = 400;

export interface UseFightTickerResult {
  /** Confirmed ticks this hook has sent for the current round — the ER write count a presenter can
   *  point at, counted rather than claimed. */
  ticksSent: number;
  /** Fight steps those ticks actually executed on-chain. */
  stepsAdvanced: number;
  /** The most recent tick signature, or null before the first one lands. */
  lastSignature: string | null;
  /** Last failure, kept visible rather than swallowed. A tick failing is not fatal — the next one
   *  covers the same backlog, and `resolve` covers everything — but silently retrying forever while
   *  something is genuinely broken is how a demo dies on stage with no explanation. */
  error: Error | null;
}

export interface UseFightTickerOptions {
  program: BullsArenaProgram | null;
  router: ConnectionMagicRouter;
  roundPda: PublicKey | null;
  round: RoundState | null;
  /** Signs and pays for ticks. The session key when one is active — `tick` takes no `player`, so a
   *  session is not required for authorization here, only to avoid spending the burner's own
   *  signature attention; either signer produces exactly the same on-chain effect. */
  keypair: Keypair;
  session: ActiveSession | null;
  /** Off by default in tests/SSR; set true to actually send. */
  enabled?: boolean;
}

export function useFightTicker({
  program, router, roundPda, round, keypair, session, enabled = true,
}: UseFightTickerOptions): UseFightTickerResult {
  const [ticksSent, setTicksSent] = useState(0);
  const [stepsAdvanced, setStepsAdvanced] = useState(0);
  const [lastSignature, setLastSignature] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Everything the interval reads lives in a ref, so a new poll result (a fresh `round` object every
  // ~1.5s) doesn't tear down and rebuild the timer — same reasoning as render/gameLoop.ts's propsRef.
  const latest = useRef({ program, router, roundPda, round, keypair, session, enabled });
  latest.current = { program, router, roundPda, round, keypair, session, enabled };

  // The cursor we believe the chain is at. Seeded from the polled account, then advanced locally by
  // our own confirmed ticks so we don't re-send the same backlog while waiting for the next poll —
  // a duplicate tick is harmless on-chain (it would run zero steps) but it is still a wasted
  // transaction, and the count this hook reports would stop meaning anything.
  const knownCursor = useRef(0);
  const inFlight = useRef(false);

  const roundKey = roundPda?.toBase58() ?? null;
  useEffect(() => {
    knownCursor.current = 0;
    inFlight.current = false;
    setTicksSent(0);
    setStepsAdvanced(0);
    setLastSignature(null);
    setError(null);
  }, [roundKey]);

  useEffect(() => {
    let cancelled = false;

    const pump = async () => {
      const s = latest.current;
      if (!s.enabled || !s.program || !s.roundPda || !s.round) return;
      if (s.round.phase !== Phase.Fight) return;
      if (inFlight.current) return;

      // Trust whichever cursor is further ahead: the polled account (someone else ticked) or our own
      // confirmed sends (we ticked since the last poll).
      const chainCursor = Number(s.round.tickCount);
      if (chainCursor > knownCursor.current) knownCursor.current = chainCursor;

      const target = canonicalCursor(
        Number(s.round.fightStartedAt), s.round.fighterCount, Date.now() / 1000,
      );
      const backlog = target - knownCursor.current;
      if (backlog <= 0) return;

      // Cap a single tick so a long-unattended round is caught up over several cheap transactions
      // rather than one big one — the fight visibly walks forward instead of jumping.
      //
      // The cap is FOUR seconds' worth, not one, and that difference is load-bearing: a round-trip to
      // the ER measured ~850ms, so a ticker that only ever advances one second per call falls further
      // behind on every call and never recovers. Observed for real (the first devnet run of
      // scripts/verify-stepped-fight.ts left the cursor 42 steps behind after five ticks). Headroom to
      // catch up is what makes this converge instead of drift.
      const steps = Math.min(backlog, stepsPerSecond(s.round.fighterCount) * 4);

      inFlight.current = true;
      try {
        const signer: TxSigner = s.session
          ? { publicKey: s.session.signerPubkey, signTransaction: s.session.signTransaction }
          : s.keypair;
        const { signature } = await sendTx(
          s.router, tick(s.program, { round: s.roundPda, steps }), signer, `tick(${steps})`,
        );
        if (cancelled) return;
        knownCursor.current += steps;
        setTicksSent((n) => n + 1);
        setStepsAdvanced((n) => n + steps);
        setLastSignature(signature);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        inFlight.current = false;
      }
    };

    const id = setInterval(() => void pump(), POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return { ticksSent, stepsAdvanced, lastSignature, error };
}
