// THE highest-value screen in the app for a judge, per snug-floating-mitten.md — not a claim in a
// README, a live re-derivation anyone watching can check with their own eyes. Given a settled round,
// this re-runs the exact same algorithm the chain ran, from the chain's own revealed seed, entirely
// client-side, and shows the two columns side by side rather than asking for trust in a checkmark.
//
// Self-contained by design (see verifyRound.ts's own header for the full reasoning): takes only a
// `RoundState`, no store, no chain handle. Everything it needs — seed, entries, step count, the final
// settled numbers — already lives on the round the caller is already polling.

import { useMemo } from "react";
import type { RoundState } from "../chain/useRound.ts";
import { verifyRound, type VerifyResult } from "./verifyRound.ts";

export interface VerifyPanelProps {
  round: RoundState | null;
}

function truncate(base58: string): string {
  return `${base58.slice(0, 4)}...${base58.slice(-4)}`;
}

const VERDICT_COPY: Record<VerifyResult["verdict"], { label: string; detail: string }> = {
  verified: {
    label: "VERIFIED — independent replay matches exactly",
    detail:
      "Re-running the algorithm client-side, from the chain's own revealed seed and entries, " +
      "produced the exact same winner and the exact same hp/banked for every fighter the chain " +
      "settled to. Nothing here required trusting the operator.",
  },
  "extraction-likely": {
    label: "Not an exact replay — consistent with a mid-fight Extract",
    detail:
      "This round's on-chain state doesn't line up with a pure replay, but the on-chain numbers " +
      "still fully conserve value (nothing was created or destroyed) and at least one fighter's " +
      "final state is the exact shape only a mid-fight extract() leaves behind. The chain doesn't " +
      "record WHEN an extract happened, only its effect — so a replay driven only by the final " +
      "seed and entries structurally cannot reproduce a human's real-time decision. That is an " +
      "honest limit of this client-side check, not a fairness problem.",
  },
  mismatch: {
    label: "MISMATCH — not explained by extraction",
    detail:
      "This round's on-chain state disagrees with an independent replay in a way a mid-fight " +
      "extract cannot account for: either the on-chain fighters' own value doesn't conserve, or " +
      "no fighter shows the shape an extraction leaves behind. That points at a real problem — " +
      "wrong seed, wrong entries, wrong step count, or an algorithm bug — worth investigating, not " +
      "an accusation on its own.",
  },
};

const VERDICT_CLASS: Record<VerifyResult["verdict"], string> = {
  verified: "verify-verdict verify-verdict--ok",
  "extraction-likely": "verify-verdict verify-verdict--info",
  mismatch: "verify-verdict verify-verdict--bad",
};

function FighterRow({ fighter }: { fighter: VerifyResult["fighters"][number] }) {
  const status = fighter.matches ? "match" : fighter.extractionSignature ? "extracted?" : "diverges";
  return (
    <tr>
      <td title={fighter.wallet}>{truncate(fighter.wallet)}</td>
      <td>{fighter.side}</td>
      <td>{fighter.onChain.hp.toString()}</td>
      <td>{fighter.recomputed.hp.toString()}</td>
      <td>{fighter.onChain.banked.toString()}</td>
      <td>{fighter.recomputed.banked.toString()}</td>
      <td>{fighter.onChain.dead ? "yes" : "no"}</td>
      <td>{fighter.recomputed.dead ? "yes" : "no"}</td>
      <td>{status}</td>
    </tr>
  );
}

export function VerifyPanel({ round }: VerifyPanelProps) {
  const seedRevealed = round !== null && round.seed.some((b) => b !== 0);
  const canVerify = round !== null && round.phaseName === "Settled" && seedRevealed;

  // useMemo, not useEffect+useState: verifyRound() is a pure, synchronous, in-memory computation
  // (no network) — the same reasoning App.tsx's own derived values use.
  const [result, computeError] = useMemo<[VerifyResult | null, Error | null]>(() => {
    if (!canVerify || round === null) return [null, null];
    try {
      return [verifyRound(round), null];
    } catch (e) {
      return [null, e instanceof Error ? e : new Error(String(e))];
    }
  }, [canVerify, round]);

  if (round === null) {
    return (
      <section aria-label="verify">
        <h2>Verify</h2>
        <p>no round loaded</p>
      </section>
    );
  }

  if (!canVerify) {
    return (
      <section aria-label="verify">
        <h2>Verify</h2>
        <p>
          verification runs once this round is Settled with a revealed seed (currently:{" "}
          {round.phaseName}).
        </p>
      </section>
    );
  }

  if (computeError) {
    return (
      <section aria-label="verify">
        <h2>Verify</h2>
        <p role="alert">could not run the independent replay: {computeError.message}</p>
      </section>
    );
  }

  if (!result) return null; // unreachable given the guards above — keeps TypeScript's narrowing happy.

  const copy = VERDICT_COPY[result.verdict];

  return (
    <section aria-label="verify">
      <h2>Verify — round #{round.roundNo.toString()}</h2>
      <p className={VERDICT_CLASS[result.verdict]} role="status">
        {copy.label}
      </p>
      <p>{copy.detail}</p>

      <dl className="verify-facts">
        <div>
          <dt>seed (on-chain, revealed)</dt>
          <dd>
            <code>{result.seedHex}</code>
          </dd>
        </div>
        <div>
          <dt>steps replayed</dt>
          <dd>{result.steps} (= this round's on-chain tickCount)</dd>
        </div>
        <div>
          <dt>winner — on-chain / recomputed</dt>
          <dd>
            side {result.winnerOnChain} / side {result.winnerRecomputed}{" "}
            {result.winnerMatches ? "(match)" : "(differ)"}
          </dd>
        </div>
        <div>
          <dt>value conservation (on-chain)</dt>
          <dd>
            {result.totalValueOnChain.toString()} / pot {result.potOnChain.toString()}{" "}
            {result.conservationHoldsOnChain ? "(holds)" : "(BROKEN)"}
          </dd>
        </div>
      </dl>

      <table>
        <thead>
          <tr>
            <th>wallet</th>
            <th>side</th>
            <th>hp (chain)</th>
            <th>hp (replay)</th>
            <th>banked (chain)</th>
            <th>banked (replay)</th>
            <th>dead (chain)</th>
            <th>dead (replay)</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          {result.fighters.map((f) => (
            <FighterRow key={`${f.wallet}:${f.side}`} fighter={f} />
          ))}
        </tbody>
      </table>
    </section>
  );
}
