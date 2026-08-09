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

      {/* A real fieldset/legend around real radios rather than a <select> of "0" and "1".
          Three reasons, in order of weight:
            1. Side is the colour key the whole app is built on — side 0 is green and side 1 is
               purple in the fighter table, the arena and the verify comparison. A dropdown reading
               "0" was the one place that key was invisible, at the exact moment the user commits to
               a side.
            2. Two mutually-exclusive options is what a radio group is FOR; a two-item select hides
               half the choice behind a click.
            3. Grouping, the accessible name, and arrow-key traversal all come from the platform
               here instead of being reimplemented on divs.
          Selection is signalled by border + fill + dot as well as hue, so it never depends on
          colour alone. The submitted values are unchanged: 0 and 1. */}
      <fieldset className="field enter-sides">
        <legend className="field__label">side</legend>
        <div className="seg">
          {([0, 1] as const).map((s) => (
            <label key={s} className={`seg__opt seg__opt--${s === 0 ? "a" : "b"}`}>
              <input
                type="radio"
                name="side"
                value={s}
                checked={side === s}
                onChange={() => setSide(s)}
              />
              <span className="seg__dot" aria-hidden="true" />
              side {s}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="field enter-stake">
        <span className="field__label">stake</span>
        <input
          value={stakeInput}
          onChange={(e) => setStakeInput(e.target.value)}
          inputMode="numeric"
          aria-invalid={stake === null}
          aria-describedby="enter-stake-hint"
        />
        {/* The gross/net distinction is real and was previously invisible: `enter()` takes the GROSS
            amount and stores `stake = net` after deducting the arena fee (programs/bulls-arena/src
            /lib.rs), so the number typed here is NOT the number that shows up in the fighter table.
            This codebase has already shipped two unit bugs; a UI that quietly renders two different
            quantities under one word is how a third one happens. No fee RATE is quoted because this
            component isn't given the Arena account and inventing one would be worse than silence. */}
        <span className="note" id="enter-stake-hint">
          {stake === null
            ? "must be a whole number greater than zero"
            : "gross — the arena fee is deducted on entry, so the fighter table will show slightly less"}
        </span>
      </label>

      <button type="submit" className="btn--primary btn--block" disabled={!canSubmit}>
        {pending ? "sending…" : "Enter the round"}
      </button>
    </form>
  );
}
