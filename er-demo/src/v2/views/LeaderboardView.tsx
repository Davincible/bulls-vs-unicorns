// 01 — LEADERBOARD. Three boards, one line per row, no boxes.
//
//   01-1 THIS ROUND   — live, off the round account: who is still standing and what they are worth.
//   01-2 STANDINGS    — every wallet's record, aggregated from the ROUND LOG and nothing else.
//   01-3 HALL OF FAME — the best single rounds in that same log.
//
// WHY THE STANDINGS COME FROM THE ROUND LOG. This was bug #1 in UI-SPEC.md: the old profile card
// computed a wallet's ROI from its live balances while the board computed it from the log, so one
// wallet legitimately showed two different ROIs and neither was wrong. A balance board is also a
// survey of SURVIVORS — a player who won and walked away vanishes with their profit, and anyone
// mid-round reads ~0 because their stake has left their balance and is sitting in the ring. Both
// figures here come from `standings`, which the data layer derives from settled rounds only, so the
// leaderboard and the dashboard's "your position" band are physically incapable of disagreeing.
//
// THE BOARD USED TO BE CALLED "ALL-TIME" AND IS NOT. `useHistory` fetches the newest rounds that
// still exist — it stops once it has walked into a run of accounts whose rent the arena has already
// reclaimed, and is capped at `MAX_ROUNDS` besides — and tolerates a read that fails, so `standings`
// (derived from exactly that log) covers a WINDOW. `SideRecord` was built refusing the phrase for
// this reason and carrying its own coverage instead; the board did not, and said "aggregated across
// every settled round" over the same data. That window was 250 rounds wide when this was written and
// is now usually about `MIN_RETAINED_ROUNDS`, so it is no longer a bug waiting for the arena to get
// popular. Every board here states the coverage it was counted over.
//
// AND WHO IS BEHIND A ROW — NOTHING HERE ANSWERS THAT, ON PURPOSE. 01-1 used to mark the fighters
// the keeper had seated for the arena, off a per-fighter flag stamped from a wallet list the keeper
// published. `KEEPER_STATUS_SCHEMA` 5 took that list away along with the prose beside it and the
// round's own counts, and it REJECTS an older status file outright rather than ignoring the extra
// fields — so there is nothing a browser can read that backs a claim about whether a row is a
// person, and no version of this page that can quietly start reading one again. Every column below
// is a copy of the round account: a wallet, a side, its money, its status. Who is holding it is not
// among the facts this screen has.
//
// IF THAT MARK EVER RETURNS IT MAY NOT RETURN AS A BOOLEAN. The flag this board read defaulted to
// `false` whenever nothing was disclosing, and `false` renders identically to "checked, and this one
// is a person" — a confident claim about the single thing nobody had checked, which is a worse
// untruth than the silence that replaced it. Whatever restores the mark has to be able to say "not
// known" as a third answer, and the boards here have to render that third answer as `—`.

import { useId, useMemo, useState } from "react";
import { useArena } from "../data/useArena.ts";
import { useLinks } from "../data/useLinks.ts";
import { namePlate } from "../data/namePlate.ts";
import { Bar, Empty, Mark, Money, Section, TabPanel, Tabs, Tag } from "../ui/primitives.tsx";
import { NameCell } from "./NameCell.tsx";
import { ScrollBox } from "./ScrollBox.tsx";
import { ShowMore } from "./ShowMore.tsx";
import { capRows, ROW_CAP_BOARD } from "./rowCap.ts";
import { coverageFigure, coverageNote, coveragePhrase } from "./coverage.ts";
import {
  SIDE_TOKEN,
  usd,
  usdCompact,
  worth,
  type FighterView,
  type LogCoverage,
  type RoundPlayer,
  type StandingsRow,
} from "../contract.ts";
import "./screens.css";

type TabId = "round" | "alltime" | "hall";

const TABS: { id: TabId; label: string }[] = [
  { id: "round", label: "This round" },
  // "Standings", not "All-time" — see the note at the top of this file. The id stays `alltime` on
  // purpose: it is a DOM/aria namespace (`useId`-scoped tab and panel ids), renaming it would change
  // nothing a reader sees and would be a rename for its own sake.
  { id: "alltime", label: "Standings" },
  { id: "hall", label: "Hall of fame" },
];

/** Each board's heading, and its lede — a FUNCTION of the coverage, because two of the three make a
 *  claim about how much history they cover and neither may make it in the abstract. What goes in is
 *  `LogCoverage`, which knows both what was fetched and what the arena has actually run, so the word
 *  "all-time" appears exactly where it is true and nowhere else. See `views/coverage.ts`. */
const HEAD: Record<
  TabId,
  { index: string; title: string; lede: (c: LogCoverage) => string; source: string }
> = {
  round: {
    index: "01-1",
    title: "This round",
    lede: () =>
      "Everyone in the ring right now, ranked by what they are worth — value still fighting plus value already raided. It moves while you watch it.",
    source: "round account",
  },
  alltime: {
    index: "01-2",
    title: "Standings",
    lede: (c) =>
      `Every wallet that appears in the round log, aggregated ${coveragePhrase(c)}. Read from the log itself, never from live balances: a balance board only ever surveys the survivors.`,
    source: "round log",
  },
  hall: {
    index: "01-3",
    title: "Hall of fame",
    // "Performances", not "rounds" — the phrase this is appended to counts rounds, and "the best
    // single rounds across all 16 rounds" reads as a stutter rather than as two different facts.
    lede: (c) =>
      `The best single performances ${coveragePhrase(c)}: what reached the ring, what they walked out with, and the multiple that separates the two.`,
    source: "round log",
  },
};

/** Sortable columns on the standings board. */
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
  const { live, standings, hall, history, logCoverage, you, source } = useArena();
  const [tab, setTab] = useState<TabId>("round");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "pnl", desc: true });

  // The id namespace tying each tab to the panel it controls. `useId` rather than a literal so the
  // pairing survives this screen ever being rendered twice (two boards side by side, a preview) —
  // duplicate ids would cross-wire the two silently, and nothing on screen would look wrong.
  const tabsNs = useId();

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
            Who is winning right now, who has won the most across the rounds this page has read
            back, and the single best of them.
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
          {/* THE COVERAGE, IN THE PLACE A READER LOOKS FOR PROVENANCE. `N of M` is the whole point:
              the boards below are counted over N, the arena has run M, and until those differ nobody
              can see that the first number is a window at all. */}
          <span className="u" title={coverageNote(logCoverage)}>
            Rounds logged · <span className="u--ink">{coverageFigure(logCoverage)}</span>
          </span>
          {/* HOW MANY ROWS THE BOARD ON SCREEN IS SHOWING — on all three tabs, and `count` already
              tracks which one is mounted. This slot was a per-tab split until 01-1 got its own
              figure here; it is one fact again.

              IT IS THE WHOLE BOARD AND IT STAYS THE WHOLE BOARD, now that each board renders at most
              `ROW_CAP_BOARD` rows until it is asked for more. Making this the VISIBLE count is the
              obvious next edit and it is the wrong one: it would print "Rows · 10" over a 52-wallet
              standings board and delete the only figure on the page that says how much board there
              is. How many the cap holds back is the control's job, under the table, and it says so
              in the same breath as offering them. */}
          <span className="u">
            Rows · <span className="u--ink">{count}</span>
          </span>
        </div>
      </header>

      <Section
        index={head.index}
        title={head.title}
        lede={head.lede(logCoverage)}
        tools={
          <Tabs
            ns={tabsNs}
            ariaLabel="Leaderboard board"
            items={TABS}
            value={tab}
            onChange={(id) => setTab(id)}
          />
        }
      >
        {/* THE SECTION'S CHILDREN ARE THE PANELS, which is why the tabs sit in its `tools` slot: the
            heading, the lede and the board under it all change together when a tab changes, and the
            three boards are three renderings of the same section rather than three sections. Each is
            wrapped in the `TabPanel` its tab names, so a reader can move from the tab to the board it
            just selected instead of guessing what changed. One at a time — mounting all three and
            hiding two would sort and render two boards nobody asked for.

            `label` IS `head.title` — the heading printed at the top of this very section. It ends up
            naming the scrolling box each board sits in (see `ScrollBox`), and passing the heading's
            own string down is what stops the name a screen reader hears from drifting from the words
            a sighted reader sees. `head` is `HEAD[tab]` and only this tab's panel is mounted, so it
            is always this board's heading.

            ONE THING FOR `ui/primitives.tsx` TO RETIRE, NOT FOR THIS FILE: `TabPanel` carries its own
            `tabIndex={0}`, justified in its comment by "a panel whose content is a table of text has
            no focusable descendant at all". As of `ScrollBox` that is no longer true here whenever a
            board is long enough to scroll, and the panel's stop becomes a second consecutive stop on
            the same box. Harmless, but it is one line to drop once that module is free. */}
        {tab === "round" ? (
          <TabPanel ns={tabsNs} id="round">
            <RoundBoard fighters={ranked} label={head.title} />
          </TabPanel>
        ) : null}
        {tab === "alltime" ? (
          <TabPanel ns={tabsNs} id="alltime">
            <AllTime
              rows={sorted}
              sort={sort}
              setSort={setSort}
              youKey={you.pubkey}
              loading={history.loading}
              label={head.title}
            />
          </TabPanel>
        ) : null}
        {tab === "hall" ? (
          <TabPanel ns={tabsNs} id="hall">
            <Hall
              rows={hall}
              youKey={you.pubkey}
              loading={history.loading}
              roundOf={roundOf}
              label={head.title}
            />
          </TabPanel>
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

function RoundBoard({ fighters, label }: { fighters: FighterView[]; label: string }) {
  // THE IDENTITY MAP, READ HERE RATHER THAN THREADED THROUGH. It is a context value, so this costs
  // one lookup and keeps the three boards' prop lists as they were. `loading` is deliberately not
  // consulted: nothing on this board may wait on the identity feed (`useLinks.ts`), and a round
  // renders completely and correctly while it is still outstanding.
  const { map } = useLinks();
  // ABOVE THE EMPTY BRANCH, because hooks are unconditional — a board that goes from rows to none
  // and back must not change how many of these run. `useId` scopes the control's `aria-controls` to
  // the table it opens, the same way this screen already scopes its tab/panel pairs.
  const [expanded, setExpanded] = useState(false);
  const rowsId = useId();
  // An empty board never renders a `ScrollBox` at all — there is no box, so there is no stop to
  // decide about. The same is true of the two boards below: the empty state is structurally
  // excluded rather than measured away. It grows no control either: `capRows` of an empty list
  // hides nothing and `ShowMore` renders nothing for a table that fits, so "no fighters in the ring"
  // can never become "show 0 more".
  if (!fighters.length) {
    return <Empty>No fighters in the ring — the board fills the moment someone deploys.</Empty>;
  }
  // SORTED IN `LeaderboardView`, CAPPED HERE, in that order and never the other one. `fighters` is
  // `ranked` — already in worth order — and this is a plain top-N of it, so the rows that survive
  // are decided by RANK and by nothing else. `rowCap.ts` carries the argument and the rule it
  // serves; the `#` column keeps reading 1…n because a top-N of an ordered list is its own prefix.
  const shown = capRows(fighters, ROW_CAP_BOARD, expanded);
  return (
    // THE CONTROL SITS OUTSIDE THE BOX, and both reasons point the same way.
    //
    // `ScrollBox`'s header states the contract this keeps: a box holds ONE table for its lifetime,
    // because `useCanScroll` observes `el.children` once when the element arrives and React never
    // swaps that child out underneath it. A button in there would be a second observed element and a
    // contract broken for a control that does not need to be inside anything.
    //
    // And a way past a cap that you must scroll the capped box to REACH is not a way past it. The
    // box exists so a long table stops pushing the page down; putting the button at the bottom of it
    // hands the reader back the scroll the box just saved them.
    //
    // Expanding still re-answers the box's own question with nothing said here: the table grows, the
    // table is a child the observer is already watching, so the tab stop appears or disappears on
    // its own.
    <>
      <ScrollBox label={label}>
        <div id={rowsId} className="rows sc-tbl sc-tbl--lbr" role="table" aria-label="This round">
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
          {shown.rows.map((f, i) => {
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
                  {/* `namePlate`, NEVER `map.get`, on all three boards — and `namePlate` goes through
                      `linkFor`, which is the one lookup that asks the runtime mint register. A
                      `LinkRecord`'s compile-time brand does not survive a spread, so the map alone
                      cannot answer whether the record in it is one the client actually verified; an
                      unverified copy renders as unlinked. Holding that behind one function is what
                      makes it a guard rather than a habit; `linkFighters.ts`'s header is the argument.

                      `"beside"` because this row prints its own `you` marker on the next line, so the
                      name slot is free to carry a linked reader's own handle rather than spending
                      itself repeating what the marker just said. See `namePlate.ts`'s `YouCue`. */}
                  <NameCell plate={namePlate(map, f.wallet, f.isYou ? "beside" : "unmarked")} />
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
      </ScrollBox>
      <ShowMore
        hidden={shown.hidden}
        expanded={expanded}
        noun="fighter"
        controls={rowsId}
        onToggle={() => setExpanded((v) => !v)}
      />
    </>
  );
}

/* ---------------------------------------------------------------------------------------------
   01-2 · STANDINGS
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
  label,
}: {
  rows: StandingsRow[];
  sort: { key: SortKey; desc: boolean };
  setSort(s: { key: SortKey; desc: boolean }): void;
  youKey: string;
  loading: boolean;
  label: string;
}) {
  // See `RoundBoard` — read from context here rather than threaded down, and never waited on.
  const { map } = useLinks();
  // ABOVE THE EMPTY BRANCH, for the reason `RoundBoard` gives: hooks are unconditional.
  //
  // `expanded` SURVIVES A RE-SORT, and that is structural rather than lucky. `sort` lives up in
  // `LeaderboardView` and is passed down, so pressing a column header re-renders this component in
  // place — same element, same position, state intact — and a reader who expanded a 52-wallet board
  // and then sorted it by ROI keeps all 52. Only the order under them changes, which is what they
  // asked for.
  //
  // SWITCHING TABS DOES RESET IT, and that is accepted. Only the selected panel is mounted (see the
  // three ternaries in `LeaderboardView`), so leaving and returning unmounts this and its state with
  // it. A tab is a request for a different board; arriving at it collapsed is the same state every
  // other arrival at it gives, and the alternative is a `Record<TabId, boolean>` in the parent
  // remembering how three tables were left, for a preference a single press restores.
  const [expanded, setExpanded] = useState(false);
  const rowsId = useId();
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
  //
  // WHICH IS WHY IT IS `rows` AND NOT `shown.rows` BELOW. The cap is a second route to exactly the
  // per-page scale this paragraph rejects: drawn against the visible ten, every rail would change
  // length the moment the board expanded, and the top wallet would be full-width in both states
  // while meaning two different figures. The header's tooltip prints `usd(top)` as the board's
  // scale, and it has to stay true of the board rather than of the page of it you are on.
  const top = peak(rows.map((r) => r.pnl));
  // SORTED IN `LeaderboardView`, CAPPED HERE. `rows` is `sorted`; this is a plain top-N of it and
  // never a partition, so which wallets survive the cut is decided by the sort the reader chose.
  // `rowCap.ts` states the rule and why it is not negotiable.
  const shown = capRows(rows, ROW_CAP_BOARD, expanded);
  return (
    // Outside the box, for the two reasons `RoundBoard` sets out above.
    <>
      <ScrollBox label={label}>
        <div
          id={rowsId}
          className="rows sc-tbl sc-tbl--lba"
          role="table"
          aria-label="Standings over the round log"
        >
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
            {/* "NET STAKE", NOT "STAKED". `StandingsRow.staked` sums the chain's per-fighter `stake`,
                which is recorded AFTER the arena's entry fee is taken at the door — so a column headed
                "Staked" was reporting less than these wallets were charged. `grossDeposits()` is the
                honest figure for that claim and it is not available per wallet: `fees_collected` is
                written on the ROUND, not on the fighter, and splitting it by hand would be a number
                this page invented. So the header carries the qualification instead. The ROI beside it
                is unaffected — both sides of it are net, so it stays like-for-like. */}
            <SortHead
              label="Net stake"
              col="staked"
              sort={sort}
              setSort={setSort}
              right
              className="r sc-s"
              title="What reached the ring, net of the arena's entry fee — the fee is charged at the door and never enters the pot. Sort by it."
            />
            <SortHead label="Returned" col="returned" sort={sort} setSort={setSort} right className="r sc-s" />
            <SortHead label="P/L" col="pnl" sort={sort} setSort={setSort} right className="r" />
            <SortHead
              label="ROI"
              col="roi"
              sort={sort}
              setSort={setSort}
              right
              className="r"
              title="Returned ÷ net stake, over the rounds in the log — not over this wallet's whole life, which the log is only a window on"
            />
          </div>
          {shown.rows.map((r, i) => (
            <div key={r.wallet} role="row" className={`row${r.wallet === youKey ? " row--you" : ""}`}>
              <div role="cell" className="num dim">
                {i + 1}
              </div>
              <div role="cell" className="sc-who" title={r.wallet}>
                <NameCell plate={namePlate(map, r.wallet, r.wallet === youKey ? "beside" : "unmarked")} />
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
      </ScrollBox>
      <ShowMore
        hidden={shown.hidden}
        expanded={expanded}
        noun="wallet"
        controls={rowsId}
        onToggle={() => setExpanded((v) => !v)}
      />
    </>
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
  label,
}: {
  rows: RoundPlayer[];
  youKey: string;
  loading: boolean;
  roundOf(p: RoundPlayer): bigint | null;
  label: string;
}) {
  // See `RoundBoard` — read from context here rather than threaded down, and never waited on.
  const { map } = useLinks();
  // Above the empty branch, same rule as the two boards above. This panel is unmounted when the tab
  // changes, so `expanded` resets on the way back — see `AllTime` for why that is accepted.
  const [expanded, setExpanded] = useState(false);
  const rowsId = useId();
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
  //
  // `rows`, NOT `shown.rows`, for `AllTime`'s reason: a scale taken over the visible ten is a
  // per-page scale, and the rails would redraw themselves the moment the board was expanded.
  const top = peak(rows.map((p) => p.pnl));
  // Sorted by `deriveHall`, capped here — a plain top-N of the order it already applied, never a
  // reordering of it. `rowCap.ts` carries the rule.
  const shown = capRows(rows, ROW_CAP_BOARD, expanded);
  return (
    // Outside the box, for the two reasons `RoundBoard` sets out.
    <>
      <ScrollBox label={label}>
        <div id={rowsId} className="rows sc-tbl sc-tbl--lbh" role="table" aria-label="Hall of fame">
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
            {/* Same qualification as the standings' net-stake column, and for the same reason:
                `RoundPlayer.stake` is what the chain stored after the entry fee. */}
            <div
              role="columnheader"
              className="r sc-s"
              title="What reached the ring — the deposit net of the arena's entry fee — and what it finished as"
            >
              Net deposit → final
            </div>
            <div role="columnheader" className="r">
              Return
            </div>
            <div role="columnheader" className="r">
              Profit
            </div>
          </div>
          {shown.rows.map((p, i) => {
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
                  <NameCell plate={namePlate(map, p.wallet, p.wallet === youKey ? "beside" : "unmarked")} />
                  {p.wallet === youKey ? <span className="u u--ink">you</span> : null}
                  <span className="sc-who-k">{p.short}</span>
                </div>
                {/* Empty to a screen reader, for the same reason as the standings rail: it redraws the
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
      </ScrollBox>
      <ShowMore
        hidden={shown.hidden}
        expanded={expanded}
        noun="performance"
        controls={rowsId}
        onToggle={() => setExpanded((v) => !v)}
      />
    </>
  );
}
