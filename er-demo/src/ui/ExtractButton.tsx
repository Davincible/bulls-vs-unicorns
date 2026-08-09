// The hackathon's core story beat, per snug-floating-mitten.md: mid-fight, prominent, and the reason
// this whole demo needs an Ephemeral Rollup rather than a plain devnet program — without real-time
// player input, the outcome would be a pure function of (seed, entries) computable the instant the
// lobby closes, and nothing would need 10ms blocks. `extract()` (sim/erSim.ts's own header comment
// makes the same point) is what makes WHEN a human presses a button part of the outcome.
//
// Self-contained by design: takes exactly what it needs to build and send one `extract()` transaction
// and to know whether doing so is currently legal, no store, no App.tsx coupling. Local
// loading/error/success state only, per the plan's 80/20 cut — no global toast system here.

import { useState } from "react";
import type { Keypair, PublicKey } from "@solana/web3.js";
import type { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";
import { extract } from "../chain/round.ts";
import { sendTx } from "../chain/sendTx.ts";
import type { BullsArenaProgram } from "../chain/program.ts";
import type { RoundState } from "../chain/useRound.ts";

export interface ExtractButtonProps {
  /** Built once IDL has loaded — null while the caller is still awaiting `createProgram()`. */
  program: BullsArenaProgram | null;
  router: ConnectionMagicRouter;
  keypair: Keypair;
  round: RoundState | null;
  roundPda: PublicKey | null;
  /** Fires after a confirmed extract signature — an integration layer can hang a toast, a store
   *  refresh, or nothing at all off this without this component knowing any of those exist. */
  onExtracted?: (result: { signature: string; elapsedMs: number }) => void;
}

interface Eligibility {
  eligible: boolean;
  /** Shown next to the button whenever it's NOT clickable, so a judge watching a live demo can read
   *  why at a glance instead of wondering whether the button is just broken. */
  reason: string | null;
  fighterHp: bigint | null;
}

function evaluateEligibility(
  program: BullsArenaProgram | null,
  roundPda: PublicKey | null,
  round: RoundState | null,
  playerPubkey: PublicKey,
): Eligibility {
  if (!program) return { eligible: false, reason: "loading program...", fighterHp: null };
  if (!roundPda) return { eligible: false, reason: "no round selected", fighterHp: null };
  if (!round) return { eligible: false, reason: "loading round...", fighterHp: null };
  if (round.phaseName !== "Fight") {
    return {
      eligible: false,
      reason: `extract is only available during Fight (round is currently ${round.phaseName})`,
      fighterHp: null,
    };
  }
  const fighter = round.fighters.find((f) => f.wallet.equals(playerPubkey));
  if (!fighter) return { eligible: false, reason: "you have no fighter in this round", fighterHp: null };
  if (fighter.dead || fighter.hp <= 0n) {
    return { eligible: false, reason: "your fighter is already out", fighterHp: fighter.hp };
  }
  return { eligible: true, reason: null, fighterHp: fighter.hp };
}

type ExtractStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; signature: string }
  | { kind: "error"; message: string };

export function ExtractButton({ program, router, keypair, round, roundPda, onExtracted }: ExtractButtonProps) {
  const [status, setStatus] = useState<ExtractStatus>({ kind: "idle" });

  const { eligible, reason, fighterHp } = evaluateEligibility(program, roundPda, round, keypair.publicKey);
  const canClick = eligible && status.kind !== "pending" && program !== null && roundPda !== null;

  const handleClick = async () => {
    if (!program || !roundPda) return;
    setStatus({ kind: "pending" });
    try {
      const builder = extract(program, { round: roundPda, player: keypair.publicKey });
      const { signature, elapsedMs } = await sendTx(router, builder, keypair, "extract");
      setStatus({ kind: "success", signature });
      onExtracted?.({ signature, elapsedMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message });
    }
  };

  return (
    <section aria-label="extract">
      <h2>Extract</h2>
      <p>
        Pull your fighter out mid-fight: your current hp is locked in as banked winnings and you stop
        taking (or dealing) any more damage. This is the one decision only YOU can make in real time —
        it is why this fight runs on an Ephemeral Rollup instead of settling instantly.
      </p>
      {fighterHp !== null && eligible && (
        <p>
          extracting now banks <strong>{fighterHp.toString()}</strong> hp and takes you out of the
          fight.
        </p>
      )}
      <button type="button" disabled={!canClick} onClick={() => void handleClick()}>
        {status.kind === "pending" ? "extracting..." : "Extract"}
      </button>
      {!eligible && reason && <p className="extract-reason">{reason}</p>}
      {status.kind === "success" && (
        <p className="extract-success" role="status">
          extracted — <code title={status.signature}>{status.signature}</code>
        </p>
      )}
      {status.kind === "error" && (
        <p className="extract-error" role="alert">
          extract failed: {status.message}
        </p>
      )}
    </section>
  );
}
