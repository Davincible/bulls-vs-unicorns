// Renders whatever `useRound()` currently has — no Pixi, no styling investment, per
// snug-floating-mitten.md's Phase 3 "done" criteria ("render the raw state as a plain table/list").
// Phase 4 replaces the visual side of this with PixiCanvas.tsx; this component's job is narrower and
// permanent regardless: prove, in plain text, that the store's state matches the chain.

import type { RoundState } from "../chain/useRound.ts";

function truncate(base58: string): string {
  return `${base58.slice(0, 4)}...${base58.slice(-4)}`;
}

export interface RoundPanelProps {
  round: RoundState | null;
  loading: boolean;
  error: Error | null;
}

export function RoundPanel({ round, loading, error }: RoundPanelProps) {
  if (error) {
    return (
      <section aria-label="round">
        <h2>Round</h2>
        <p>error polling round: {error.message}</p>
      </section>
    );
  }

  if (!round) {
    return (
      <section aria-label="round">
        <h2>Round</h2>
        <p>{loading ? "loading round..." : "no round loaded"}</p>
      </section>
    );
  }

  return (
    <section aria-label="round">
      <h2>Round #{round.roundNo.toString()}</h2>
      <p>
        phase: {round.phaseName} ({round.phase}) &nbsp;|&nbsp; pot: {round.pot.toString()} &nbsp;|&nbsp;
        tick: {round.tickCount.toString()} &nbsp;|&nbsp; fighters: {round.fighterCount}
        {round.winner !== 0 || round.phaseName === "Settled" ? <> &nbsp;|&nbsp; winner: side {round.winner}</> : null}
      </p>
      <table>
        <thead>
          <tr>
            <th>wallet</th>
            <th>side</th>
            <th>stake</th>
            <th>hp</th>
            <th>banked</th>
            <th>dead</th>
          </tr>
        </thead>
        <tbody>
          {round.fighters.map((f) => (
            <tr key={f.wallet.toBase58()}>
              <td title={f.wallet.toBase58()}>{truncate(f.wallet.toBase58())}</td>
              <td>{f.side}</td>
              <td>{f.stake.toString()}</td>
              <td>{f.hp.toString()}</td>
              <td>{f.banked.toString()}</td>
              <td>{f.dead ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {round.fighters.length === 0 && <p>no fighters yet</p>}
    </section>
  );
}
