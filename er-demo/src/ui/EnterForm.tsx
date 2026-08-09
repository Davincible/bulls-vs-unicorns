// The one write path this phase needs: side + stake -> `enter()` -> a real devnet signature. On
// success this does NOT touch the store or manually refetch the round — `useRound()`'s own poll
// (chain/useRound.ts, 1.5s interval) is what's supposed to pick up the new fighter, and proving that
// actually happens (rather than wiring a manual refresh as a crutch) is part of what this phase is
// meant to verify about the polling design.

import { useState, type FormEvent } from "react";
import type { Keypair, PublicKey } from "@solana/web3.js";
import type { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";
import { enter } from "../chain/round.ts";
import { sendTx, type TxSigner } from "../chain/sendTx.ts";
import type { BullsArenaProgram } from "../chain/program.ts";
import type { ActiveSession } from "../chain/session/useSessionKeyManager.ts";
import { useDemoStore } from "../state/store.ts";

export interface EnterFormProps {
  /** Built once IDL has loaded — null while `App.tsx` is still awaiting `createProgram()`. */
  program: BullsArenaProgram | null;
  router: ConnectionMagicRouter;
  keypair: Keypair;
  arena: PublicKey;
  roundPda: PublicKey;
  /** Non-null once a session is active (chain/session/useSessionKeyManager.ts) — `enter` is then
   *  signed by the session key instead of the burner keypair directly, with no fresh signature
   *  prompt. Null (no active session) is the pre-Phase-6 path, byte-for-byte: the burner keypair
   *  signs directly, `player` and `signer` are the same pubkey, `session_token` is omitted. */
  session: ActiveSession | null;
}

/** Parses the stake field as a positive integer. Returns null for anything that isn't one (empty,
 *  negative, fractional, non-numeric) — used both to validate on submit and to disable the button
 *  before a doomed transaction is even attempted. */
function parseStake(raw: string): bigint | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = BigInt(raw.trim());
  return n > 0n ? n : null;
}

export function EnterForm({ program, router, keypair, arena, roundPda, session }: EnterFormProps) {
  const [side, setSide] = useState<0 | 1>(0);
  const [stakeInput, setStakeInput] = useState("1000000");
  const [pending, setPending] = useState(false);
  const pushToast = useDemoStore((s) => s.pushToast);

  const stake = parseStake(stakeInput);
  const canSubmit = program !== null && stake !== null && !pending;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!program || stake === null) return;
    setPending(true);
    try {
      // Same shape either way: `player` is always the real fighter identity (the burner wallet's
      // own pubkey, session or not — see chain/round.ts's `enter` doc comment). What changes is WHO
      // signs: the session key (no popup, no burner-keypair involvement at all) when a session is
      // active, or the burner keypair directly when it isn't — the exact, unmodified pre-Phase-6
      // path.
      const signer: TxSigner = session ? { publicKey: session.signerPubkey, signTransaction: session.signTransaction } : keypair;
      const builder = enter(program, {
        arena,
        round: roundPda,
        player: keypair.publicKey,
        signer: signer.publicKey,
        sessionToken: session?.sessionTokenPda ?? null,
        side,
        stake,
      });
      const { signature } = await sendTx(router, builder, signer, `enter side ${side}`);
      pushToast(`entered side ${side}, stake ${stake} — ${signature}`, "info");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setPending(false);
    }
  };

  return (
    <form aria-label="enter" onSubmit={(e) => void handleSubmit(e)}>
      <h2>Enter</h2>
      <label>
        side{" "}
        <select value={side} onChange={(e) => setSide(Number(e.target.value) === 1 ? 1 : 0)}>
          <option value={0}>0</option>
          <option value={1}>1</option>
        </select>
      </label>{" "}
      <label>
        stake{" "}
        <input
          value={stakeInput}
          onChange={(e) => setStakeInput(e.target.value)}
          inputMode="numeric"
          aria-invalid={stake === null}
        />
      </label>{" "}
      <button type="submit" disabled={!canSubmit}>
        {pending ? "sending..." : "Enter"}
      </button>
    </form>
  );
}
