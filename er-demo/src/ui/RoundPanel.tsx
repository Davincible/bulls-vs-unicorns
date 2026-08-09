// The chain's own view of this round, rendered as an instrument panel rather than as a debug dump.
//
// Its job is unchanged and permanent: prove, in plain text, that what the app believes matches what
// the chain says. What changed in the redesign is only how that proof is presented. Every figure it
// used to show is still here — phase, phase index, pot, tick, fighter count, winner, and per-fighter
// wallet/side/stake/hp/banked/dead — because in this codebase numbers are evidence and hiding one to
// tidy the layout would be the wrong trade. They are simply no longer a `|`-separated run-on
// sentence with a hairline box drawn around every cell.

import type { ReactNode } from "react";
import type { RoundState } from "../chain/useRound.ts";

function truncate(base58: string): string {
  return `${base58.slice(0, 4)}...${base58.slice(-4)}`;
}

/** Phase drives the panel's one coloured signal. Lobby is inert, Drawing and Fight are live (gold,
 *  the app's "happening right now" colour), Settled is done (green). The phase NAME is always
 *  printed alongside — the colour is a second channel, never the only one.
 *
 *  Abandoned is done but NOT green: a lobby that expired holding fewer than two fighters ended
 *  without a fight, and colouring it like a completed round would say something untrue at a glance. */
const PHASE_CHIP: Record<RoundState["phaseName"], string> = {
  Lobby: "chip chip--muted",
  Drawing: "chip chip--warn chip--live",
  Fight: "chip chip--warn chip--live",
  Settled: "chip chip--ok",
  Abandoned: "chip chip--muted",
};

/** Every branch of this panel renders the same labelled landmark, so the accessible name and the
 *  panel surface are declared once rather than repeated across four early returns. */
function Shell({ children }: { children: ReactNode }) {
  return <section aria-label="round">{children}</section>;
}

export interface RoundPanelProps {
  round: RoundState | null;
  loading: boolean;
  error: Error | null;
}

export function RoundPanel({ round, loading, error }: RoundPanelProps) {
  if (error) {
    return (
      <Shell>
        <h2>Round</h2>
        {/* `role="alert"` and not a toast on purpose: `useRound()` re-polls every 1.5s, so a
            persistent failure (RPC down, wrong round number) would push a new toast every tick and
            bury everything else. In place, with the raw message, is the right surface for a
            condition that repeats. */}
        <p className="status-error note" role="alert">
          error polling round: {error.message}
        </p>
      </Shell>
    );
  }

  if (!round) {
    return (
      <Shell>
        <h2>Round</h2>
        <p className="note">{loading ? "loading round…" : "no round loaded"}</p>
      </Shell>
    );
  }

  const sideA = round.fighters.filter((f) => f.side === 0).length;
  const sideB = round.fighters.filter((f) => f.side === 1).length;
  const settled = round.phaseName === "Settled";
  const hasWinner = settled || round.winner !== 0;

  // Common scale for every fighter's value bar, so the rows are comparable to EACH OTHER rather
  // than each being drawn against its own max (which would make every fighter look identical).
  // Taken over both current value and entry stake so neither can overflow the track.
  let scaleMax = 1n;
  for (const f of round.fighters) {
    const total = f.hp + f.banked;
    if (total > scaleMax) scaleMax = total;
    if (f.stake > scaleMax) scaleMax = f.stake;
  }
  const pct = (v: bigint) => Number((v * 10_000n) / scaleMax) / 100;

  return (
    <Shell>
      <div className="round-head">
        <span className="round-head__no">Round #{round.roundNo.toString()}</span>
        <span className={PHASE_CHIP[round.phaseName]}>
          <span className="chip__dot" />
          {/* The raw phase index is kept beside the name: it's the actual on-chain discriminant and
              this panel's whole purpose is that the chain's state is legible, not paraphrased. */}
          {round.phaseName} · {round.phase}
        </span>
      </div>

      <div className="stats stats--3">
        <div className="stat stat--wide">
          <div className="stat__label">pot</div>
          <div className="stat__value stat__value--gold">{round.pot.toString()}</div>
          <div className="stat__sub">
            sum of {round.fighterCount} {round.fighterCount === 1 ? "stake" : "stakes"}, net of the
            entry fee
          </div>
        </div>

        <div className="stat">
          <div className="stat__label">fighters</div>
          <div className="stat__value">{round.fighterCount}</div>
          <div className="stat__sub">
            {sideA} on side 0 · {sideB} on side 1
          </div>
        </div>

        <div className="stat">
          <div className="stat__label">tick</div>
          <div className="stat__value">{round.tickCount.toString()}</div>
          <div className="stat__sub">fight steps resolved on-chain</div>
        </div>

        <div className="stat">
          <div className="stat__label">winner</div>
          {/* UI-REDESIGN-BRIEF.md Part 2: "a figure with no backing shows —, never 0. Zero is a
              claim." Before a round settles there is no winner, and `winner: side 0` — which is what
              the raw field reads as — would assert one. */}
          {hasWinner ? (
            <div className={`stat__value ${round.winner === 1 ? "stat__value--b" : "stat__value--a"}`}>
              side {round.winner}
            </div>
          ) : (
            <div className="stat__value stat__value--none">—</div>
          )}
          <div className="stat__sub">{hasWinner ? "settled on-chain" : "decided when the round settles"}</div>
        </div>
      </div>

      <div className="round-fighters">
        <div className="round-fighters__title">fighters</div>
        {round.fighters.length === 0 ? (
          <p className="round-empty">no fighters yet — the lobby is open</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>wallet</th>
                  <th>side</th>
                  <th>value</th>
                  <th className="num">stake</th>
                  <th className="num">hp</th>
                  <th className="num">banked</th>
                  <th className="num">dead</th>
                </tr>
              </thead>
              <tbody>
                {round.fighters.map((f) => (
                  <tr key={f.wallet.toBase58()}>
                    <td className="ident" title={f.wallet.toBase58()}>
                      {truncate(f.wallet.toBase58())}
                    </td>
                    <td>
                      <span className={`side-tag side-tag--${f.side === 1 ? "b" : "a"}`}>{f.side}</span>
                    </td>
                    <td className="hpbar-cell">
                      {/* Purely a second reading of the three numbers in the cells to its right, so
                          it is hidden from assistive tech rather than repeated aloud. `hp` starts
                          equal to `stake` (see the CSS note on .hpbar), which is what makes the
                          entry notch a meaningful reference point rather than decoration. */}
                      <div
                        className={`hpbar ${f.side === 1 ? "hpbar--b" : ""}`}
                        aria-hidden="true"
                        title={`hp ${f.hp} + banked ${f.banked} of ${f.stake} staked`}
                      >
                        <span className="hpbar__hp" style={{ width: `${pct(f.hp)}%` }} />
                        <span className="hpbar__banked" style={{ width: `${pct(f.banked)}%` }} />
                        <span className="hpbar__mark" style={{ left: `${pct(f.stake)}%` }} />
                      </div>
                    </td>
                    <td className="num num--faint">{f.stake.toString()}</td>
                    <td className="num">{f.hp.toString()}</td>
                    <td className="num">{f.banked.toString()}</td>
                    <td className={`num ${f.dead ? "status-error" : "num--faint"}`}>
                      {f.dead ? "yes" : "no"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* A bar without a key is a decoration. This says what the two fills and the notch are
                and, critically, that the scale is shared across rows rather than per-row. */}
            <p className="bar-legend" aria-hidden="true">
              <span className="bar-legend__k bar-legend__k--hp" /> hp in the ring
              <span className="bar-legend__k bar-legend__k--banked" /> banked
              <span className="bar-legend__k bar-legend__k--mark" /> entry stake
              <span className="bar-legend__note">· all rows share one scale</span>
            </p>
          </>
        )}
      </div>
    </Shell>
  );
}
