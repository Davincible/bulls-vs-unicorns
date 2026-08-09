// THE HIT LOG — the same stream as the voice, as a SURFACE rather than as an interruption.
//
// You could watch your number fall and had no way to find out who took it. The canvas draws the
// exchange for a few frames and the toasts are gone in five seconds; neither is somewhere a reader
// can go back and LOOK. This is that place: every exchange the playhead has crossed, in order, with
// the two fighters named and the amount stated.
//
// TWO CALL SITES, ONE COMPONENT. 00-4.1 renders the whole round; the rail's fighter inspector
// renders it filtered to one wallet, directly under that fighter's stake/hp/banked figures — which
// is where "who took my money" is actually asked. Filtering rather than a second component because
// the two differ in exactly one predicate and nothing else.
//
// LIVE ROUND ONLY, AND A WINDOW OF IT. `useArena().combat` is the last N hits at or before the
// replay cursor — not the whole fight, and not a settled round's — so this says how much it is
// showing rather than letting a truncated table read as the complete record. A settled round's
// exchanges would have to be replayed from its own account, which is a separate job (GAPS.md item 7)
// and is said in words rather than rendered as an empty table that looks like a fight nobody fought.

import { SIDE_TOKEN, usdCompact, type CombatEvent } from "../contract.ts";
import { useArena } from "../data/useArena.ts";
import { Empty, Mark } from "./primitives.tsx";
import "./CombatLog.css";

/** A name as this reader should see it. `YOU` rather than the pseudonym, exactly as the rosters and
 *  the standings already do — a player scanning for their own row should find the same word in every
 *  table on the page. */
function who(f: CombatEvent["attacker"]): string {
  return f.isYou ? "YOU" : f.name;
}

export function CombatLog({
  /** Show only exchanges this wallet was a party to. Omitted, the whole round. */
  wallet,
  /** Rows drawn. The window on the context is larger; this is what fits here. */
  limit,
}: {
  wallet?: string;
  limit: number;
}) {
  const { live, combat } = useArena();

  const phase = live?.phase ?? null;
  // `combat.recent` is ascending by step, which is the order the fight happened in. The filter is
  // this surface's own because the context publishes exactly two cuts — everything, and mine — and
  // "everything involving THIS fighter" is a question only the inspector asks.
  const all = wallet === undefined
    ? combat.recent
    : combat.recent.filter((e) => e.attacker.wallet === wallet || e.defender.wallet === wallet);

  // Newest first: the question this table answers is "what just happened", and the answer is at the
  // top of it. `slice(-limit)` before the reverse so the copy is bounded by what is drawn rather
  // than by the whole window.
  const rows = all.slice(-limit).reverse();

  if (rows.length === 0) {
    return (
      <Empty>
        {phase === "Fight"
          ? wallet === undefined
            ? "The fight has started — the first exchanges appear here within a second."
            : "No exchanges for this fighter yet."
          : phase === "Settled"
            ? "This round is over. Its exchanges are replayed live and are not kept afterwards — 00-7 recomputes the whole round from the revealed seed."
            : "Nothing yet. Exchanges appear here the moment the fight starts."}
      </Empty>
    );
  }

  // What is NOT on screen, said rather than implied.
  const hiddenHere = all.length - rows.length;

  return (
    // Capped rather than full-bleed — see `.hitlog` in CombatLog.css. A raider and the fighter it
    // raided only mean anything as a pair, and at full section width they were 900px apart.
    <div className="hitlog">
      <div className="row row--head hitrow">
        <span>Step</span>
        <span>Raider</span>
        <span>Off</span>
        <span className="r">Took</span>
      </div>

      {rows.map((e) => (
        <div
          key={e.step}
          className={`row hitrow${e.mine ? " row--you" : ""}`}
          // The exact figure, and the pair, on the row — `usdCompact` rounds and a late-fight
          // exchange is often under a cent, so the cell alone cannot always be checked against
          // anything. Same discipline as every other compacted figure on this page.
          title={`Step ${e.step.toLocaleString("en-US")} — ${who(e.attacker)} (${SIDE_TOKEN[e.attacker.side].name}) took ${usdCompact(e.amount)} off ${who(e.defender)} (${SIDE_TOKEN[e.defender.side].name})`}
        >
          <span className="idx">{e.step.toLocaleString("en-US")}</span>
          <span className="line" style={{ gap: 7, minWidth: 0 }}>
            <Mark side={e.attacker.side} label={SIDE_TOKEN[e.attacker.side].name} />
            <span className="trunc">{who(e.attacker)}</span>
          </span>
          <span className="line" style={{ gap: 7, minWidth: 0 }}>
            <Mark side={e.defender.side} label={SIDE_TOKEN[e.defender.side].name} />
            <span className="trunc">{who(e.defender)}</span>
          </span>
          <span className="num r">{usdCompact(e.amount)}</span>
        </div>
      ))}

      {/* THE COVERAGE, ALWAYS. A truncated table that does not say it is truncated is the same class
          of claim as an unbacked figure: it reads as the complete record of the round. Two
          truncations are in play and a reader is owed both — the rows this surface draws, and the
          window the page holds at all, which is the recent past of the LIVE round and nothing more. */}
      <p className="u" style={{ marginTop: 10, lineHeight: 1.6 }}>
        {hiddenHere > 0 ? `${hiddenHere.toLocaleString("en-US")} more held · ` : ""}
        The recent past of the live round, up to step{" "}
        {Math.floor(combat.at).toLocaleString("en-US")} — earlier exchanges are not kept.
      </p>
    </div>
  );
}
