// The two write paths: `enter()` and `extract()`. Built exactly as `src/ui/EnterForm.tsx` and
// `src/ui/ExtractButton.tsx` build them — `chain/round.ts`'s instruction builders into
// `chain/sendTx.ts`'s proven, account-aware send path, never `AnchorProvider.rpc()` (see sendTx.ts's
// "SDK SURPRISE #1" for what that costs).
//
// THE PLAYER/SIGNER SPLIT, once, for both. `player` is the fighter identity the chain credits —
// the burner's pubkey, or the connected wallet's — session or not. `signer` is whoever actually
// signs: the session key when a session is live, otherwise the identity's own signer (a raw
// `Keypair` in burner mode, the wallet's async `signTransaction` in wallet mode; `sendTx` accepts
// either). `sessionToken` must be an EXPLICIT `null` in the second case, not an omitted key
// (chain/program.ts's `MethodsBuilder` doc comment explains why Anchor's resolver needs it that way).
//
// THE SESSION IS RESOLVED PER PRESS, NOT PER RENDER, and that is what makes it the DEFAULT path
// rather than an opt-in one. `autoSession.ts`'s `runSigned` decides — open one first, use the live
// one, renew a lapsed one, or sign directly — and hands the answer to the builders below. Reading it
// out of the render closure instead would be subtly, expensively wrong: gum's `createSession`
// resolves `void` and the new session only reaches this component on a LATER render, so the very
// first deploy after opening a session would still be built with `sessionToken: null` and would open
// a second Phantom popup — the exact defect this path exists to remove.
//
// NOBODY MAY BE PLAYING AT ALL, and that is the state this file gained when the page stopped minting
// a burner for every visitor. `player`/`fallbackSigner` are null until a wallet connects, and every
// path out of that is a REFUSAL WITH A SENTENCE rather than a crash: `blocked` carries the same copy
// the disabled controls are already showing, so a press that slips past a disabled button (a stale
// render, a keyboard shortcut, the repeat rule firing) answers the player instead of throwing a
// TypeError into a toast.
//
// ERRORS COME BACK AS THE CHAIN'S OWN WORDS, WITH THREE EXCEPTIONS. A presenter can read "custom
// program error: NothingToExtract" aloud and no paraphrase is more useful, so `unknown` failures are
// re-thrown verbatim. The three that are re-written are the ones whose real message names a symptom
// and hides the cause — a cancelled popup, an expired blockhash, a lapsed session key. See
// `walletFault.ts`.

import { useCallback, useMemo, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";
import { enter as buildEnter, extract as buildExtract } from "../../chain/round.ts";
import { sendTx, type TxSigner } from "../../chain/sendTx.ts";
import type { BullsArenaProgram } from "../../chain/program.ts";
import type { ActiveSession } from "../../chain/session/useSessionKeyManager.ts";
import type { LiveRound, Side } from "../contract.ts";
import { runSigned, type SessionSigning, type SigningPlan } from "./autoSession.ts";
import { extractEligibility } from "./extractTerms.ts";
import { NO_WALLET_MESSAGE } from "./identity.ts";
import type { PlayBlock } from "./playGate.ts";
import type { ArenaContextValue } from "./types.ts";
import { classifyWalletError } from "./walletFault.ts";

/** The three whose original text is NOT the answer — everything else is re-thrown verbatim. */
const REWRITTEN = new Set(["rejected", "wrong-network", "session-expired"]);

export interface ActionsParams {
  program: BullsArenaProgram | null;
  router: ConnectionMagicRouter;
  /** The fighter identity the chain credits. `null` when nobody has connected. */
  player: PublicKey | null;
  /** Signs when no session is live. `null` when nobody has connected. */
  fallbackSigner: TxSigner | null;
  arena: PublicKey;
  roundPda: PublicKey | null;
  /** The round AS DISPLAYED, not the raw account — eligibility now has to quote a price as well as a
   *  verdict, and the price is a function of the CANONICAL cursor (`LiveRound.stepsNow`), which is
   *  derived here in `data/` and does not exist on `RoundState`. See `extractTerms.ts`. */
  live: LiveRound | null;
  /** HOW THE NEXT MOVE GETS SIGNED — see `autoSession.ts`. Decided in the provider from the wallet,
   *  the gate, the balance and whether the player has pressed Stop; acted on here. */
  plan: SigningPlan;
  /** Opening, renewing and classifying, injected so this file holds no session machinery of its own
   *  and `autoSession.test.ts` can drive the same orchestration with fakes. */
  signing: SessionSigning<ActiveSession>;
  /** Why the player cannot act, or null. The single verdict every disabled control renders — see
   *  `playGate.ts`. It is checked here too, so the button and the transaction cannot disagree. */
  blocked: PlayBlock | null;
  /** Fires only after a CONFIRMED enter. The simulated ledger books the deploy and the house fee off
   *  this — never off the attempt, so a failed transaction can't debit play money for a fighter that
   *  never entered. */
  onEntered(side: Side, stakeUnits: bigint): void;
}

export function useActions(params: ActionsParams): ArenaContextValue["actions"] {
  const { program, router, player, fallbackSigner, arena, roundPda, live, plan, signing, blocked, onEntered } =
    params;
  const [entering, setEntering] = useState(false);
  const [extracting, setExtracting] = useState(false);

  /** The one place a resolved session becomes a signer, shared by both instructions. `null` is the
   *  direct path — the identity's own signer, and an explicit `sessionToken: null` on the builder. */
  const signerFor = useCallback(
    (session: ActiveSession | null): TxSigner | null =>
      session ? { publicKey: session.signerPubkey, signTransaction: session.signTransaction } : fallbackSigner,
    [fallbackSigner],
  );

  /** Everything both instructions need to be true BEFORE either opens a session or builds a
   *  transaction, returned narrowed so neither call site needs a non-null assertion. Throws the copy
   *  the page is already showing, so there is exactly one account of why an action is unavailable.
   *
   *  It runs first, and that ordering is load-bearing now that a press can spend money on a session:
   *  a refusal must cost nothing, and every reason to refuse is known here. */
  const requireReady = useCallback((): {
    program: BullsArenaProgram;
    player: PublicKey;
  } => {
    if (!program) throw new Error("the program is not loaded yet — nothing can be sent to the chain");
    // The gate outranks the local null checks: it has the sentence that says what to DO, where
    // "player is null" only says what is missing.
    if (blocked) throw new Error(blocked.detail);
    // `fallbackSigner` is checked even on the session path: no wallet means nothing can AUTHORIZE a
    // session either, so this is the honest refusal rather than a failed `createSession`.
    if (player === null || fallbackSigner === null) throw new Error(NO_WALLET_MESSAGE);
    return { program, player };
  }, [program, blocked, player, fallbackSigner]);

  /**
   * Re-throw with the useful message. See this file's header on which three are rewritten.
   *
   * THE VERBATIM RULE INVERTS WHEN THERE ARE NO WORDS, which is not a hypothetical: every
   * `WalletError` subclass in `@solana/wallet-adapter-base` is `constructor() { super(...arguments) }`
   * and the adapter throws them with no arguments, so `.message` is `""`. Re-throwing one of those
   * "verbatim" hands the toast an empty string — a blank red box, which is worse than any paraphrase
   * and was exactly what a mid-round disconnect produced. `classifyWalletError` always yields a real
   * sentence (see its `BARE_WALLET_ERROR` branch), so an empty message defers to it. Errors that
   * genuinely carry text — every program error, which is the case the rule was written for — are
   * still passed through untouched.
   */
  const rethrow = useCallback((e: unknown): never => {
    const fault = classifyWalletError(e);
    if (REWRITTEN.has(fault.code)) throw new Error(fault.detail);
    if (e instanceof Error && e.message.trim() !== "") throw e;
    throw new Error(fault.detail);
  }, []);

  const enter = useCallback(
    async (side: Side, stakeUnits: bigint): Promise<string> => {
      const { program: p, player: from } = requireReady();
      if (!roundPda) throw new Error("there is no open round to deploy into");
      if (stakeUnits <= 0n) throw new Error("stake must be greater than zero");
      // Set BEFORE the session is opened, not after: the press now spans a Phantom dialog, and the
      // buttons have to be shut for the whole of it or a second press lands mid-approval and opens
      // a second one. `pendingNote(session.work)` is what the dock says during that window.
      setEntering(true);
      try {
        const signature = await runSigned(plan, signing, async (session) => {
          const signer = signerFor(session);
          if (signer === null) throw new Error(NO_WALLET_MESSAGE);
          const builder = buildEnter(p, {
            arena,
            round: roundPda,
            player: from,
            signer: signer.publicKey,
            sessionToken: session?.sessionTokenPda ?? null,
            side,
            stake: stakeUnits,
          });
          return (await sendTx(router, builder, signer, `enter side ${side}`)).signature;
        });
        // AFTER `runSigned`, deliberately: it can send twice (a lapsed session is renewed and the
        // move re-sent), and the simulated ledger must book one confirmed deploy, not two.
        onEntered(side, stakeUnits);
        return signature;
      } catch (e) {
        return rethrow(e);
      } finally {
        setEntering(false);
      }
    },
    [roundPda, arena, router, plan, signing, signerFor, requireReady, onEntered, rethrow],
  );

  const extract = useCallback(async (): Promise<string> => {
    const { program: p, player: from } = requireReady();
    if (!roundPda) throw new Error("there is no open round to extract from");
    setExtracting(true);
    try {
      return await runSigned(plan, signing, async (session) => {
        const signer = signerFor(session);
        if (signer === null) throw new Error(NO_WALLET_MESSAGE);
        const builder = buildExtract(p, {
          round: roundPda,
          player: from,
          signer: signer.publicKey,
          sessionToken: session?.sessionTokenPda ?? null,
        });
        return (await sendTx(router, builder, signer, "extract")).signature;
      });
    } catch (e) {
      return rethrow(e);
    } finally {
      setExtracting(false);
    }
  }, [roundPda, router, plan, signing, signerFor, requireReady, rethrow]);

  // Recomputed on every `live` identity change, which during Fight is the 250ms clock in
  // `useLiveRound` — deliberately, because the penalty this quotes decays with the cursor. A price
  // that only moved when the chain poll landed would be stale by up to a poll interval, in the
  // direction that overstates what the house takes.
  //
  // THE GATE IS THE FIRST REASON OFFERED. "connect a wallet" outranks "you have no fighter in this
  // round", which is technically also true of someone who has not connected and is useless to them.
  const extractEligible = useMemo(
    () =>
      extractEligibility(
        live,
        blocked?.short ?? (!program ? "loading program…" : !roundPda ? "no round selected" : null),
      ),
    [program, roundPda, live, blocked],
  );

  return { enter, extract, entering, extracting, extractEligible };
}
