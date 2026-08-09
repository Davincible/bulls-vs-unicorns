// 01 — LEADERBOARD. Three boards, one line per row, no boxes.
//
//   01-1 THIS ROUND   — live, off the round account: who is still standing and what they are worth.
//   01-2 ALL-TIME     — every wallet's record, aggregated from the ROUND LOG and nothing else.
//   01-3 HALL OF FAME — the best single rounds anyone has ever had.
//
// WHY ALL-TIME COMES FROM THE ROUND LOG. This was bug #1 in UI-SPEC.md: the old profile card
// computed a wallet's ROI from its live balances while the board computed it from the log, so one
// wallet legitimately showed two different ROIs and neither was wrong. A balance board is also a
// survey of SURVIVORS — a player who won and walked away vanishes with their profit, and anyone
// mid-round reads ~0 because their stake has left their balance and is sitting in the ring. Both
// figures here come from `standings`, which the data layer derives from settled rounds only, so the
// leaderboard and the dashboard's "your position" band are physically incapable of disagreeing.

import { useMemo, useState } from "react";
import { useArena } from "../data/useArena.ts";
import { Bar, Empty, Mark, Money, Section, Tabs, Tag } from "../ui/primitives.tsx";
import {
  SIDE_TOKEN,
  usd,
  usdCompact,
  worth,
  type FighterView,
  type RoundPlayer,
  type StandingsRow,
} from "../contract.ts";
import "./screens.css";

type TabId = "round" | "alltime" | "hall";

const TABS: { id: TabId; label: string }[] = [
  { id: "round", label: "This round" },
  { id: "alltime", label: "All-time" },
  { id: "hall", label: "Hall of fame" },
];

const HEAD: Record<TabId, { index: string; title: string; lede: string; source: string }> = {
  round: {
    index: "01-1",
    title: "This round",
    lede: "Everyone in the ring right now, ranked by what they are worth — value still fighting plus value already raided. It moves while you watch it.",
    source: "round account",
  },
  alltime: {
    index: "01-2",
    title: "All-time",
    lede: "Every wallet that has ever deployed, aggregated across every settled round. Read from the permanent round log, never from live balances — a balance board only ever surveys the survivors.",
    source: "round log",
  },
  hall: {
    index: "01-3",
    title: "Hall of fame",
    lede: "The best single rounds anyone has had here: what they put in, what they walked out with, and the multiple that separates the two.",
    source: "round log",
  },
};

/** Sortable columns on the all-time board. */
type SortKey = "pnl" | "roi" | "staked" | "returned" | "rounds";

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/** The largest magnitude on a board, which is what every rail on it is drawn against. Taken over
 *  ABSOLUTE values so one −$130 wipeout and one +$103 win share a scale and can be compared by
 *  length — a rail normalised per-sign would draw them the same and be lying about both. */
function peak(values: bigint[]): bigint {
  let m = 0n;
  for (const v of values) {
    const a = abs(v);
    if (a > m) m = a;
  }
  return m;
}

export function LeaderboardView() {
  const { live, standings, hall, history, you, source } = useArena();
  const [tab, setTab] = useState<TabId>("round");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "pnl", desc: true });

  // `hall` is a flat list of RoundPlayer, and RoundPlayer does not carry its round number — so the
  // round each performance happened in is recovered from the log the list was flattened out of.
  // Object identity first (the derivation doesn't copy), then a value key as the fallback, so a
  // provider that clones its rows degrades to a correct number rather than to a wrong one.
  const roundOf = useMemo(() => {
    const byRef = new Map<RoundPlayer, bigint>();
    const byValue = new Map<string, bigint>();
    for (const r of history.rounds) {
      for (const p of r.players) {
        byRef.set(p, r.roundNo);
        byValue.set(`${p.wallet}|${p.stake}|${p.final}`, r.roundNo);
      }
    }
    return (p: RoundPlayer): bigint | null =>
      byRef.get(p) ?? byValue.get(`${p.wallet}|${p.stake}|${p.final}`) ?? null;
  }, [history.rounds]);

  // Ranked by total worth (hp + banked), which is the figure the round is actually decided on —
  // a fighter sitting on a big bank with no health left is still winning.
  const ranked = useMemo(() => {
    const fs = live ? [...live.fighters] : [];
    fs.sort((a, b) => {
      const d = worth(b) - worth(a);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });
    return fs;
  }, [live]);

  const sorted = useMemo(() => {
    const rows = [...standings];
    const dir = sort.desc ? 1 : -1;
    rows.sort((a, b) => {
      switch (sort.key) {
        case "rounds":
          return (b.rounds - a.rounds) * dir;
        case "roi":
          // A wallet with no stake has no ROI at all; it sorts last in both directions rather than
          // pretending to be a 0% return.
          return ((b.roi ?? -Infinity) - (a.roi ?? -Infinity)) * dir;
        default: {
          const d = b[sort.key] - a[sort.key];
          return (d > 0n ? 1 : d < 0n ? -1 : 0) * dir;
        }
      }
    });
    return rows;
  }, [standings, sort]);

  const head = HEAD[tab];
  const count =
    tab === "round" ? ranked.length : tab === "alltime" ? standings.length : hall.length;

  // WHAT THE BOARD IS READ FROM has to survive the fallback. `head.source` names the account these
  // rows came out of — but in fixture mode that account is `mockData.ts`, and "READ FROM · ROUND LOG"
  // beside a grey marker was still a chain claim in the only place a reader looks for one. Say
  // "fixture round log" and let the marker agree with it.
  const fixture = source === "fixture";

  return (
    <div className="scr">
      <header className="scr-head">
        <span className="idx">01</span>
        <div className="scr-head-main">
          <h1 className="display">Leaderboard</h1>
          <p className="lede">
            Who is winning right now, who has won the most ever, and the single best rounds this
            arena has produced.
          </p>
        </div>
        <div className="scr-head-meta">
          <span className="u">
            Read from · <span className="u--ink">{fixture ? `fixture ${head.source}` : head.source}</span>
          </span>
          {/* Which round log: a real one on devnet, or the fixture the page falls back to when
              there is nothing to read. Never let a reader mistake one for the other. `fixture`, not
              `sim` — these rows are a replay of real round accounting, not a made-up ledger, and the
              `Tag` has a word for exactly that distinction. */}
          <span className="u">
            Provenance · <Tag kind={fixture ? "fixture" : "live"} />
          </span>
          <span className="u">
            Rounds logged · <span className="u--ink">{history.rounds.length}</span>
          </span>
          <span className="u">
            Rows · <span className="u--ink">{count}</span>
          </span>
        </div>
      </header>

      <Section
        index={head.index}
        title={head.title}
        lede={head.lede}
        tools={<Tabs items={TABS} value={tab} onChange={(id) => setTab(id)} />}
      >
        {tab === "round" ? <RoundBoard fighters={ranked} /> : null}
        {tab === "alltime" ? (
          <AllTime rows={sorted} sort={sort} setSort={setSort} youKey={you.pubkey} loading={history.loading} />
        ) : null}
        {tab === "hall" ? (
          <Hall rows={hall} youKey={you.pubkey} loading={history.loading} roundOf={roundOf} />
        ) : null}
      </Section>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   01-1 · THIS ROUND
   --------------------------------------------------------------------------------------------- */

/** Three states, and they are genuinely different: DEAD lost everything to raids, OUT pulled its
 *  ring value into the bank with `extract()` and is no longer a target, ALIVE is still being shot
 *  at. Colour alone never says which — the word does. */
function statusOf(f: FighterView): { label: string; dim: boolean } {
  if (f.dead) return { label: "dead", dim: true };
  if (f.hp === 0n) return { label: "out", dim: true };
  return { label: "alive", dim: false };
}

function RoundBoard({ fighters }: { fighters: FighterView[] }) {
  if (!fighters.length) {
    return <Empty>No fighters in the ring — the board fills the moment someone deploys.</Empty>;
  }
  return (
    <div className="sc-wrap">
      <div className="rows sc-tbl sc-tbl--lbr" role="table" aria-label="This round">
        <div className="row row--head" role="row">
          <div role="columnheader">#</div>
          <div role="columnheader">Side</div>
          <div role="columnheader">Fighter</div>
          {/* `sc-hp`, not `sc-s`: health is this board's rail — the equivalent of 01-2's P/L scale —
              and it is the one column that MOVES during a fight. It outlives the workings columns
              beside it and is dropped only on a phone. */}
          <div role="columnheader" className="sc-hp">
            Health
          </div>
          <div role="columnheader" className="r sc-s">
            In the ring
          </div>
          <div role="columnheader" className="r sc-s">
            Banked
          </div>
          <div role="columnheader" className="r">
            Worth
          </div>
          <div role="columnheader" className="sc-st">
            Status
          </div>
        </div>
        {fighters.map((f, i) => {
          const st = statusOf(f);
          return (
            <div
              key={f.id}
              role="row"
              className={`row${f.isYou ? " row--you" : ""}${st.dim ? " row--dead" : ""}`}
            >
              <div role="cell" className="num dim">
                {i + 1}
              </div>
              <div role="cell" className="sc-side">
                <Mark side={f.side} dead={f.dead} />
                <span className="u">{SIDE_TOKEN[f.side].name}</span>
              </div>
              <div role="cell" className="sc-who" title={f.wallet}>
                <span className="sc-who-n">{f.name}</span>
                {f.isYou ? <span className="u u--ink">you</span> : null}
                <span className="sc-who-k">{f.short}</span>
              </div>
              <div role="cell" className="sc-hp">
                <Bar value={f.hp} max={f.stake} side={f.side} />
              </div>
              {/* This board is the widest live table on the page (three money columns plus a health
                  bar) against fixed 70-88px tracks — on the chain path a live fighter's ring/bank/
                  worth are all up to twenty characters and right-aligned, so a full `usd()` here
                  spills leftward into the column beside it. Compact. */}
              <div role="cell" className="num r sc-s">
                {usdCompact(f.hp)}
              </div>
              <div role="cell" className="num r sc-s">
                {f.banked > 0n ? usdCompact(f.banked) : <span className="none">—</span>}
              </div>
              <div role="cell" className="num r">
                {usdCompact(worth(f))}
              </div>
              <div role="cell" className="u sc-st">
                {st.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   01-2 · ALL-TIME
   --------------------------------------------------------------------------------------------- */

function SortHead({
  label,
  col,
  sort,
  setSort,
  right,
  title,
  className,
}: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; desc: boolean };
  setSort(s: { key: SortKey; desc: boolean }): void;
  right?: boolean;
  title?: string;
  className?: string;
}) {
  const on = sort.key === col;
  return (
    <div
      role="columnheader"
      aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}
      className={`${right ? "r " : ""}${className ?? ""}`}
    >
      <button
        type="button"
        title={title ?? `Sort by ${label.toLowerCase()}`}
        onClick={() => setSort({ key: col, desc: on ? !sort.desc : true })}
      >
        {label}
        {on ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </div>
  );
}

function AllTime({
  rows,
  sort,
  setSort,
  youKey,
  loading,
}: {
  rows: StandingsRow[];
  sort: { key: SortKey; desc: boolean };
  setSort(s: { key: SortKey; desc: boolean }): void;
  youKey: string;
  loading: boolean;
}) {
  if (!rows.length) {
    return (
      <Empty>
        {loading
          ? "Reading the round log…"
          : "Standings build from settled rounds — the first appear once a round resolves."}
      </Empty>
    );
  }
  // Fixed across the whole board, not per-page: a rail whose scale changed as you sorted would make
  // two sorts of the same table disagree about how big the same wallet's P/L is.
  const top = peak(rows.map((r) => r.pnl));
  return (
    <div className="sc-wrap">
      <div className="rows sc-tbl sc-tbl--lba" role="table" aria-label="All-time standings">
        <div className="row row--head" role="row">
          <div role="columnheader">#</div>
          <div role="columnheader">Wallet</div>
          {/* `usd(top)` here stays full precision on purpose: this string lives only inside a
              `title=` tooltip, prose a reader opens deliberately to check the board's scale against
              an exact figure — not a grid cell that has to fit a fixed track. */}
          <div
            role="columnheader"
            className="sc-w"
            title={`Each wallet's P/L drawn against the largest on this board, ${usd(top)}`}
          >
            P/L scale
          </div>
          <SortHead label="Rounds" col="rounds" sort={sort} setSort={setSort} right className="r sc-s" />
          <div role="columnheader" className="r">
            W / L
          </div>
          <SortHead label="Staked" col="staked" sort={sort} setSort={setSort} right className="r sc-s" />
          <SortHead label="Returned" col="returned" sort={sort} setSort={setSort} right className="r sc-s" />
          <SortHead label="P/L" col="pnl" sort={sort} setSort={setSort} right className="r" />
          <SortHead
            label="ROI"
            col="roi"
            sort={sort}
            setSort={setSort}
            right
            className="r"
            title="Returned ÷ staked, over every round this wallet has ever played"
          />
        </div>
        {rows.map((r, i) => (
          <div key={r.wallet} role="row" className={`row${r.wallet === youKey ? " row--you" : ""}`}>
            <div role="cell" className="num dim">
              {i + 1}
            </div>
            <div role="cell" className="sc-who" title={r.wallet}>
              <span className="sc-who-n">{r.name}</span>
              {r.wallet === youKey ? <span className="u u--ink">you</span> : null}
              <span className="sc-who-k">{r.short}</span>
            </div>
            {/* The cell is deliberately empty to a screen reader: the bar is a redrawing of the P/L
                three columns along, and announcing it again as "graphic" on all 52 rows would cost a
                non-sighted reader time to be told nothing new. */}
            <div role="cell" className="sc-w">
              <span className={`sc-scale${r.pnl < 0n ? " sc-scale--neg" : ""}`}>
                <Bar value={abs(r.pnl)} max={top} />
              </span>
            </div>
            <div role="cell" className="num r sc-s">
              {r.rounds}
            </div>
            <div role="cell" className="num r">
              {r.wins} / {r.rounds - r.wins}
            </div>
            {/* Staked is the DENOMINATOR of the ROI two cells along, so a zero there is not a wallet
                that risked nothing — it is a wallet whose return has no basis, and it dashes for the
                same reason `roi` does. `returned` never dashes: nothing coming back is a real, and
                very common, outcome. */}
            <div role="cell" className="num r sc-s">
              {r.staked > 0n ? usdCompact(r.staked) : <span className="none">—</span>}
            </div>
            <div role="cell" className="num r sc-s">
              {usdCompact(r.returned)}
            </div>
            <div role="cell" className="r">
              <Money units={r.pnl} signed compact />
            </div>
            <div role="cell" className="num r" title={r.roi === null ? undefined : `${r.roi.toFixed(2)}× returned`}>
              {/* ROI is `returned ÷ staked`; shown as the gain on that, so it reads with the same
                  sign as the P/L column beside it instead of contradicting it at 0.98×. */}
              {r.roi === null ? (
                <span className="none">—</span>
              ) : (
                <span className={r.roi >= 1 ? "pos" : "neg"}>
                  {r.roi >= 1 ? "+" : "−"}
                  {Math.abs((r.roi - 1) * 100).toFixed(0)}%
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   01-3 · HALL OF FAME
   --------------------------------------------------------------------------------------------- */

function Hall({
  rows,
  youKey,
  loading,
  roundOf,
}: {
  rows: RoundPlayer[];
  youKey: string;
  loading: boolean;
  roundOf(p: RoundPlayer): bigint | null;
}) {
  if (!rows.length) {
    return (
      <Empty>
        {loading ? "Reading the round log…" : "Best single-round returns appear here once rounds settle."}
      </Empty>
    );
  }
  // `deriveHall` keeps profitable rounds only, so this peak is a plain maximum — but it is still
  // taken over the rows rather than read off `rows[0]`, because that would make the rail depend on
  // the list staying sorted by the same figure it is drawn from.
  const top = peak(rows.map((p) => p.pnl));
  return (
    <div className="sc-wrap">
      <div className="rows sc-tbl sc-tbl--lbh" role="table" aria-label="Hall of fame">
        <div className="row row--head" role="row">
          <div role="columnheader">#</div>
          <div role="columnheader">Side</div>
          <div role="columnheader">Fighter</div>
          {/* Same rule as 01-2's scale header: `usd(top)` is tooltip prose, not a grid cell, so it
              keeps the exact figure. */}
          <div
            role="columnheader"
            className="sc-w"
            title={`Each round's profit drawn against the best on this board, ${usd(top)}`}
          >
            Profit scale
          </div>
          <div role="columnheader" className="sc-s">
            Round
          </div>
          <div role="columnheader" className="r sc-s">
            Deposit → final
          </div>
          <div role="columnheader" className="r">
            Return
          </div>
          <div role="columnheader" className="r">
            Profit
          </div>
        </div>
        {rows.map((p, i) => {
          const mult = p.stake > 0n ? Number(p.final) / Number(p.stake) : null;
          const rno = roundOf(p);
          return (
            <div
              key={`${p.wallet}-${i}`}
              role="row"
              className={`row${p.wallet === youKey ? " row--you" : ""}`}
            >
              <div role="cell" className="num dim">
                {i + 1}
              </div>
              <div role="cell" className="sc-side">
                <Mark side={p.side} />
                <span className="u">{SIDE_TOKEN[p.side].name}</span>
              </div>
              <div role="cell" className="sc-who" title={p.wallet}>
                <span className="sc-who-n">{p.name}</span>
                {p.wallet === youKey ? <span className="u u--ink">you</span> : null}
                <span className="sc-who-k">{p.short}</span>
              </div>
              {/* Empty to a screen reader, for the same reason as the all-time rail: it redraws the
                  profit figure at the end of its own row. */}
              <div role="cell" className="sc-w">
                <span className="sc-scale">
                  <Bar value={p.pnl} max={top} />
                </span>
              </div>
              <div role="cell" className="num dim sc-s">
                {rno === null ? <span className="none">—</span> : `R${rno.toString()}`}
              </div>
              {/* A zero deposit has no `→` to describe — it is the same missing basis that dashes the
                  return multiple in the next cell but one. */}
              <div role="cell" className="num r sc-s">
                {p.stake > 0n ? usdCompact(p.stake) : <span className="none">—</span>}{" "}
                <span className="dim">→</span> {usdCompact(p.final)}
              </div>
              <div role="cell" className="num r">
                {mult === null ? <span className="none">—</span> : `${mult.toFixed(2)}×`}
              </div>
              <div role="cell" className="r">
                <Money units={p.pnl} signed compact />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
