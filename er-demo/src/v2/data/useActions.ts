// The two write paths: `enter()` and `extract()`. Built exactly as `src/ui/EnterForm.tsx` and
// `src/ui/ExtractButton.tsx` build them — `chain/round.ts`'s instruction builders into
// `chain/sendTx.ts`'s proven, account-aware send path, never `AnchorProvider.rpc()` (see sendTx.ts's
// "SDK SURPRISE #1" for what that costs).
//
// THE PLAYER/SIGNER SPLIT, once, for both. `player` is always the burner wallet's own pubkey — the
// fighter identity the chain credits, session or not. `signer` is whoever actually signs: the session
// key when a session is live, the burner keypair when it isn't. `sessionToken` must be an EXPLICIT
// `null` in the second case, not an omitted key (chain/program.ts's `MethodsBuilder` doc comment
// explains why Anchor's resolver needs it that way).
//
// Both reject with a real `Error` rather than swallowing — the provider turns that into a toast, and
// a caller that wants to know can await. The message is the chain's own, verbatim: a presenter can
// read "custom program error: NothingToExtract" aloud, and no paraphrase of it is more useful.

import { useCallback, useMemo, useState } from "react";
import type { Keypair, PublicKey } from "@solana/web3.js";
import type { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";
import { enter as buildEnter, extract as buildExtract } from "../../chain/round.ts";
import { sendTx, type TxSigner } from "../../chain/sendTx.ts";
import type { BullsArenaProgram } from "../../chain/program.ts";
import type { ActiveSession } from "../../chain/session/useSessionKeyManager.ts";
import type { LiveRound, Side } from "../contract.ts";
import { extractEligibility } from "./extractTerms.ts";
import type { ArenaContextValue } from "./types.ts";

export interface ActionsParams {
  program: BullsArenaProgram | null;
  router: ConnectionMagicRouter;
  keypair: Keypair;
  arena: PublicKey;
  roundPda: PublicKey | null;
  /** The round AS DISPLAYED, not the raw account — eligibility now has to quote a price as well as a
   *  verdict, and the price is a function of the CANONICAL cursor (`LiveRound.stepsNow`), which is
   *  derived here in `data/` and does not exist on `RoundState`. See `extractTerms.ts`. */
  live: LiveRound | null;
  session: ActiveSession | null;
  /** Fires only after a CONFIRMED enter. The simulated ledger books the deploy and the house fee off
   *  this — never off the attempt, so a failed transaction can't debit play money for a fighter that
   *  never entered. */
  onEntered(side: Side, stakeUnits: bigint): void;
}

export function useActions(params: ActionsParams): ArenaContextValue["actions"] {
  const { program, router, keypair, arena, roundPda, live, session, onEntered } = params;
  const [entering, setEntering] = useState(false);
  const [extracting, setExtracting] = useState(false);

  /** The one place the session/burner choice is made, shared by both instructions. */
  const signerFor = useCallback(
    (): TxSigner =>
      session ? { publicKey: session.signerPubkey, signTransaction: session.signTransaction } : keypair,
    [session, keypair],
  );

  const enter = useCallback(
    async (side: Side, stakeUnits: bigint): Promise<string> => {
      if (!program) throw new Error("the program is not loaded yet — nothing can be sent to the chain");
      if (!roundPda) throw new Error("there is no open round to deploy into");
      if (stakeUnits <= 0n) throw new Error("stake must be greater than zero");
      setEntering(true);
      try {
        const signer = signerFor();
        const builder = buildEnter(program, {
          arena,
          round: roundPda,
          player: keypair.publicKey,
          signer: signer.publicKey,
          sessionToken: session?.sessionTokenPda ?? null,
          side,
          stake: stakeUnits,
        });
        const { signature } = await sendTx(router, builder, signer, `enter side ${side}`);
        onEntered(side, stakeUnits);
        return signature;
      } finally {
        setEntering(false);
      }
    },
    [program, roundPda, arena, keypair, router, session, signerFor, onEntered],
  );

  const extract = useCallback(async (): Promise<string> => {
    if (!program) throw new Error("the program is not loaded yet — nothing can be sent to the chain");
    if (!roundPda) throw new Error("there is no open round to extract from");
    setExtracting(true);
    try {
      const signer = signerFor();
      const builder = buildExtract(program, {
        round: roundPda,
        player: keypair.publicKey,
        signer: signer.publicKey,
        sessionToken: session?.sessionTokenPda ?? null,
      });
      const { signature } = await sendTx(router, builder, signer, "extract");
      return signature;
    } finally {
      setExtracting(false);
    }
  }, [program, roundPda, keypair, router, session, signerFor]);

  // Recomputed on every `live` identity change, which during Fight is the 250ms clock in
  // `useLiveRound` — deliberately, because the penalty this quotes decays with the cursor. A price
  // that only moved when the chain poll landed would be stale by up to a poll interval, in the
  // direction that overstates what the house takes.
  const extractEligible = useMemo(
    () =>
      extractEligibility(
        live,
        !program ? "loading program…" : !roundPda ? "no round selected" : null,
      ),
    [program, roundPda, live],
  );

  return { enter, extract, entering, extracting, extractEligible };
}
