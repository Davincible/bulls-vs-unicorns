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

/** Byte array -> lowercase hex. Local rather than `Buffer.from(...).toString("hex")` so this
 *  component keeps needing nothing but its own props — the same self-containment its header comment
 *  claims, which a node-polyfill import would quietly break. */
function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The one-word conclusion, shown as a mark beside the sentence. It exists so the verdict survives
 *  being read at a glance from across a room — and so the verdict is never carried by hue alone,
 *  which is the accessibility failure a green/amber/red banner walks straight into. */
const VERDICT_MARK: Record<VerifyResult["verdict"], string> = {
  verified: "MATCH",
  "extraction-likely": "PARTIAL",
  mismatch: "MISMATCH",
};

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
      "This round's on-chain state doesn't line up with a pure replay, but the on-chain numbers are " +
      "internally consistent — value still fully conserves (nothing was created or destroyed) and " +
      "the round's own recorded pot still matches the stakes that make it up — and at least one " +
      "fighter's final state is the exact shape only a mid-fight extract() leaves behind. The chain doesn't " +
      "record WHEN an extract happened, only its effect — so a replay driven only by the final " +
      "seed and entries structurally cannot reproduce a human's real-time decision. That is an " +
      "honest limit of this client-side check, not a fairness problem.",
  },
  mismatch: {
    label: "MISMATCH — not explained by extraction",
    detail:
      "This round's on-chain state disagrees with an independent replay in a way a mid-fight " +
      "extract cannot account for: the on-chain fighters' own value doesn't conserve, or the " +
      "round's recorded pot disagrees with the stakes it should be the sum of, or no fighter shows " +
      "the shape an extraction leaves behind. That points at a real problem — wrong seed, wrong " +
      "entries, wrong step count, or an algorithm bug — worth investigating, not an accusation on " +
      "its own.",
  },
};

const VERDICT_CLASS: Record<VerifyResult["verdict"], string> = {
  verified: "verify-verdict verify-verdict--ok",
  "extraction-likely": "verify-verdict verify-verdict--info",
  mismatch: "verify-verdict verify-verdict--bad",
};

/** One measured quantity, twice: what the chain settled to and what the in-tab replay produced.
 *  A pair that disagrees is tinted on BOTH cells — the single thing in this app that must never be
 *  scanned past — and a pair that agrees is left plain, so "no red anywhere" is the whole reading. */
function Pair({ chain, replay, seam }: { chain: string; replay: string; seam?: boolean }) {
  const differs = chain !== replay;
  return (
    <>
      <td className={`num ${seam ? "seam" : ""} ${differs ? "differs" : ""}`}>{chain}</td>
      <td className={`num ${differs ? "differs" : ""}`}>{replay}</td>
    </>
  );
}

const ROW_CLASS: Record<string, string> = {
  match: "row--match",
  "extracted?": "row--extracted",
  diverges: "row--diverges",
};

function FighterRow({ fighter }: { fighter: VerifyResult["fighters"][number] }) {
  const status = fighter.matches ? "match" : fighter.extractionSignature ? "extracted?" : "diverges";
  const chip =
    status === "match" ? "chip chip--ok" : status === "extracted?" ? "chip chip--warn" : "chip chip--bad";
  return (
    <tr className={ROW_CLASS[status]}>
      <td className="ident" title={fighter.wallet}>
        {truncate(fighter.wallet)}
      </td>
      <td>
        <span className={`side-tag side-tag--${fighter.side === 1 ? "b" : "a"}`}>{fighter.side}</span>
      </td>
      <Pair chain={fighter.onChain.hp.toString()} replay={fighter.recomputed.hp.toString()} seam />
      <Pair chain={fighter.onChain.banked.toString()} replay={fighter.recomputed.banked.toString()} seam />
      <Pair
        chain={fighter.onChain.dead ? "yes" : "no"}
        replay={fighter.recomputed.dead ? "yes" : "no"}
        seam
      />
      <td className="seam">
        <span className={chip}>{status}</span>
      </td>
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

  // The three not-yet states share the panel's own accent frame rather than degrading to bare text.
  // This surface is the demo's headline claim, and a judge who scrolls past it mid-round should see
  // a panel that is waiting, not one that looks broken or unfinished.
  if (round === null) {
    return (
      <section aria-label="verify" className="verify">
        <div className="verify__head">
          <h2>Verify</h2>
          <span className="chip chip--muted">idle</span>
        </div>
        <p className="note">no round loaded</p>
      </section>
    );
  }

  if (!canVerify) {
    const commitHex = toHex(round.seedCommit);
    const committed = round.seedCommit.some((b) => b !== 0);
    return (
      <section aria-label="verify" className="verify">
        <div className="verify__head">
          <h2>Verify</h2>
          <span className="chip chip--muted">{round.phaseName}</span>
        </div>
        <p className="prose">
          The independent replay runs the moment this round settles and its seed is revealed. Until
          then there is nothing to check against — the result does not exist yet, on-chain or here.
        </p>

        {/* The half of the fairness story that IS already available. `seedCommit` is sha256 of the
            VRF output (programs/bulls-arena/src/lib.rs — `hashv(&[randomness])`), published before
            the seed itself, and the seed revealed later has to hash to it. Showing it now is what
            makes the later reveal checkable instead of something taken on trust, and it is real
            on-chain data this panel was already being handed and had simply never displayed.
            UI-REDESIGN-BRIEF.md Part 5 asks for exactly this.

            No claim is made here about WHEN it was posted relative to entries opening: the program
            writes it on two different paths (`open_round`'s argument, and the VRF callback), so
            "before deploys opened" is not a property this component can prove from the account it
            holds. It says what it can back and stops there. */}
        {committed && (
          <div className="verify-facts">
            <div className="stat stat--wide">
              <div className="stat__label">seed commit — sha256, already on-chain</div>
              <div className="stat__value">{commitHex}</div>
              <div className="stat__sub">
                the seed revealed at fight start must hash to this value, so it cannot be swapped for
                a more convenient one afterwards — that check is what the panel above runs once this
                round settles
              </div>
            </div>
          </div>
        )}
      </section>
    );
  }

  if (computeError) {
    return (
      <section aria-label="verify" className="verify">
        <div className="verify__head">
          <h2>Verify</h2>
          <span className="chip chip--bad">error</span>
        </div>
        <p className="status-error note" role="alert">
          could not run the independent replay: {computeError.message}
        </p>
      </section>
    );
  }

  if (!result) return null; // unreachable given the guards above — keeps TypeScript's narrowing happy.

  const copy = VERDICT_COPY[result.verdict];

  return (
    // Read top to bottom as an argument: the conclusion, then why, then the inputs it was computed
    // from, then every number that went into it. `.verify` is the only accent-bordered surface in
    // the app — the "one hero of the heroes" move from SATRUSH-DASHBOARD-PROMPT.md, spent on the one
    // screen whose entire job is to be believed.
    <section aria-label="verify" className="verify">
      <div className="verify__head">
        <h2>Verify</h2>
        <span className="chip">round #{round.roundNo.toString()}</span>
      </div>

      <p className={VERDICT_CLASS[result.verdict]} role="status">
        <span className="verify-verdict__mark">{VERDICT_MARK[result.verdict]}</span>
        <span>{copy.label}</span>
      </p>
      <p className="prose verify__detail">{copy.detail}</p>

      {/* The inputs the verdict was derived from. Rendered as stat cells like every other figure in
          the app rather than as a description list: the old `dl` sized a shared grid column to a
          64-character hex, which pushed two of these four facts clean off the panel — on the screen
          the plan calls the highest-value one in the app. The seed now takes a full row of its own,
          so no other fact has to share a column with it. */}
      <div className="verify-facts">
        <div className="stat stat--wide">
          <div className="stat__label">seed — on-chain, revealed</div>
          <div className="stat__value">{result.seedHex}</div>
          <div className="stat__sub">
            the chain's own randomness, published at fight start — and the only input the replay
            below is driven by
          </div>
        </div>

        <div className="stat">
          <div className="stat__label">steps replayed</div>
          <div className="stat__value">{result.steps}</div>
          <div className="stat__sub">= this round's on-chain tickCount</div>
        </div>

        <div className="stat">
          <div className="stat__label">winner — chain / replay</div>
          {/* "1 / 1" alone reads as a fraction, which is the wrong mental model for two independent
              readings of the same fact. The unit is named on both, per the brief's no-bare-numbers
              rule, and each side keeps its own colour key. */}
          <div className="stat__value">
            <span className={`side-tag side-tag--${result.winnerOnChain === 1 ? "b" : "a"}`}>
              side {result.winnerOnChain}
            </span>
            <span className="stat__sep">/</span>
            <span className={`side-tag side-tag--${result.winnerRecomputed === 1 ? "b" : "a"}`}>
              side {result.winnerRecomputed}
            </span>
          </div>
          <div className="stat__sub">
            {result.winnerMatches
              ? "on-chain and recomputed agree"
              : "on-chain and recomputed DIFFER"}
          </div>
        </div>

        <div className="stat">
          <div className="stat__label">value conservation</div>
          <div className={`stat__value ${result.conservationHoldsOnChain ? "" : "stat__value--none"}`}>
            {result.conservationHoldsOnChain ? "holds" : "BROKEN"}
          </div>
          {/* The penalty term is shown even when it's zero. "held vs pot" alone stopped adding up
              the moment extract() started paying a penalty to the treasury — value legitimately
              leaves the round now — and two numbers that differ with no third to explain them read
              as a discrepancy on the one screen whose entire job is looking trustworthy. Spelling
              out held + penalties = pot shows the identity actually being checked. */}
          <div className="stat__sub">
            {result.totalValueOnChain.toString()} held + {result.penaltiesCollectedOnChain.toString()}{" "}
            penalties = pot {result.potOnChain.toString()}
          </div>
          {/* The pot in the line above is SUMMED from the fighters' stakes. The round account also
              keeps its own running `pot`, and comparing the two is the one check on this panel whose
              both sides are on-chain facts about the same quantity — so it is the one that can be
              false without anybody having replayed anything. Shown on every round, passing or
              failing, for the same reason the penalty term is shown when it is zero: a check nobody
              can see is indistinguishable from a check nobody ran.

              It is shown here rather than in a cell of its own because it is a statement ABOUT the
              number the line above ends on. It is deliberately NOT folded into the "holds"/"BROKEN"
              word: that word is the conservation identity's verdict, and these are two independent
              checks that can fail independently. Tinted red when it fails, which is this panel's
              established language for the thing that must not be scanned past. */}
          <div className={`stat__sub ${result.potMatchesStakesOnChain ? "" : "stat__sub--differs"}`}>
            {result.potMatchesStakesOnChain
              ? `cross-checked: the round's own pot field records ${result.potRecordedOnChain.toString()}, the same total — the two are written together on every entry`
              : `CROSS-CHECK FAILED: the round's own pot field records ${result.potRecordedOnChain.toString()}, but the stakes sum to ${result.potOnChain.toString()} — the two are written together on every entry, so no player action explains this`}
          </div>
          {/* The fee, on its own line and only when there is one.
              NOT folded into the line above, deliberately. That line is the identity being CHECKED,
              and the fee is not part of it — it never entered the ring, so it cancels (see
              verifyRound.ts's header). Adding it there would put an unchecked number inside a
              sentence a viewer reads as verified, which is the one thing this panel must not do.
              It is worth its own line because `pot` is the sum of NET stakes: without it, the number
              labelled "pot" is quietly less than what players were charged, and the house's take
              looks like the penalty alone when the penalty is only half of it. */}
          {result.feesCollectedOnChain > 0n ? (
            <div className="stat__sub">
              + {result.feesCollectedOnChain.toString()} entry fee (not in the pot) = gross{" "}
              {result.grossDepositsOnChain.toString()}, house took {result.houseTookOnChain.toString()}
            </div>
          ) : null}
        </div>
      </div>

      <div className="verify-table">
        <table>
          <caption className="visually-hidden">
            Every fighter's final state as settled on-chain, beside the same figure recomputed
            independently in this browser tab.
          </caption>
          <thead>
            {/* Two-level header. These nine columns are really "identity, then three quantities
                measured twice, then a verdict" — spanning the pairs makes that structure visible, so
                a reader sees they are looking at the same numbers twice instead of decoding nine
                similar-looking labels. */}
            <tr>
              <th aria-hidden="true" />
              <th aria-hidden="true" />
              <th className="grp grp--chain seam" colSpan={2} scope="colgroup">
                hp
              </th>
              <th className="grp grp--chain seam" colSpan={2} scope="colgroup">
                banked
              </th>
              <th className="grp grp--chain seam" colSpan={2} scope="colgroup">
                dead
              </th>
              <th aria-hidden="true" />
            </tr>
            <tr className="sub">
              <th scope="col">wallet</th>
              <th scope="col">side</th>
              <th className="num seam" scope="col">chain</th>
              <th className="num" scope="col">replay</th>
              <th className="num seam" scope="col">chain</th>
              <th className="num" scope="col">replay</th>
              <th className="num seam" scope="col">chain</th>
              <th className="num" scope="col">replay</th>
              <th className="seam" scope="col">status</th>
            </tr>
          </thead>
          <tbody>
            {result.fighters.map((f) => (
              <FighterRow key={`${f.wallet}:${f.side}`} fighter={f} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="note verify-note">
        Nothing above was fetched from a server. The replay column is computed in this tab, by this
        page, from the seed and entries the chain itself published. Any pair that disagrees is tinted
        red: on a clean round there are none, and on a round where someone pulled out mid-fight the
        tinted cells are exactly where that decision changed the outcome — which is the one thing a
        replay driven only by the final seed structurally cannot reproduce.
      </p>
    </section>
  );
}
