// The shared vocabulary of the v2 page, in React form. Written alongside `styles/base.css` (whose
// header comment is the design law) so that every screen composes the SAME handful of pieces —
// a section is always a rule + an index + a heading, a side marker is always a 7px square, money is
// always formatted by `contract.ts`. Anything that appears on two screens belongs here; anything
// specific to one screen stays with that screen.

import type { KeyboardEvent, ReactNode } from "react";
import { usd, usdCompact, usdCompactSigned, usdSigned, type Side } from "../contract.ts";

/** A section: hairline rule, index number, heading, optional tools on the right. No box, no fill —
 *  that is the whole point of the design. */
export function Section({
  index,
  title,
  tools,
  lede,
  children,
}: {
  /** "00-1.2" — the survey-marker numbering the page is built on. */
  index: string;
  title: string;
  tools?: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="sec">
      <div className="sec-head">
        <span className="idx">{index}</span>
        <h2 className="h">{title}</h2>
        {tools ? <div className="sec-tools">{tools}</div> : null}
      </div>
      {lede ? <p className="lede" style={{ marginBottom: 14 }}>{lede}</p> : null}
      {children}
    </section>
  );
}

/** The smallest possible carrier of a side colour — and THE DESIGN'S MOST EXPOSED POINT. The whole
 *  page is black on white except for two colours, and those two colours carry a real fact: which side
 *  a fighter is on. A 7px square is that fact and nothing else — no shape difference, no letter — so
 *  wherever the square is alone, the fact is conveyed by colour alone and a reader who cannot
 *  distinguish the two, or who is not looking at the page at all, is told nothing.
 *
 *  MOSTLY THAT IS FINE, AND THE DEFAULT SAYS SO. In History, Leaderboard, Dashboard and the previous-
 *  rounds table the square sits immediately beside the side's printed name, so it is decoration on
 *  top of text — `aria-hidden`, because announcing "Ansem Ansem" on every row of a forty-row table is
 *  its own defect. `label` is for the two places where the square is the ONLY carrier (00-5 standings
 *  and 00-7's verify table, both in ArenaView): there it takes visually hidden text instead.
 *
 *  The text goes INSIDE the square rather than beside it. Every caller that needs a label puts the
 *  mark in a fixed grid track — `.standing`'s second column is literally `7px` — and a sibling span
 *  would be a second grid child that shunts every column after it one place along. `.sr` is
 *  out-of-flow and clipped, so nested it costs no layout at all. */
export function Mark({ side, dead, label }: { side: Side; dead?: boolean; label?: string }) {
  const cls = `mk ${dead ? "mk--dead" : side === 0 ? "mk--a" : "mk--b"}`;
  if (label === undefined) return <span className={cls} aria-hidden="true" />;
  return (
    <span className={cls}>
      <span className="sr">{label}</span>
    </span>
  );
}

/** A health/share bar. `value`/`max` are bigint so it can take chain units directly. */
export function Bar({
  value,
  max,
  side,
  large,
}: {
  value: bigint;
  max: bigint;
  side?: Side;
  large?: boolean;
}) {
  const pct = max > 0n ? Math.max(0, Math.min(100, (Number(value) / Number(max)) * 100)) : 0;
  const tone = side === undefined ? "" : side === 0 ? " bar--a" : " bar--b";
  return (
    <div className={`bar${tone}${large ? " bar--lg" : ""}`}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Value over label. The page's basic unit of fact. */
export function KV({ value, label, title }: { value: ReactNode; label: string; title?: string }) {
  return (
    <div className="kv" title={title}>
      <span className="kv-v">{value}</span>
      <span className="kv-n">{label}</span>
    </div>
  );
}

/** A row of `KV`s, separated by hairlines rather than boxed into tiles. */
export function KVs({ children }: { children: ReactNode }) {
  return <div className="kvs">{children}</div>;
}

/* ---------------------------------------------------------------------------------------------
   TABS — the real pattern, because the roles were already making the promise.
   ---------------------------------------------------------------------------------------------
   `role="tablist"` and `role="tab"` were here from the start; `role="tabpanel"`, `aria-controls`,
   roving tabindex and arrow keys were not. That combination is the worst of both worlds: a screen
   reader announces "tab, 1 of 3" — which tells the reader to press Right — and Right did nothing,
   every tab was its own tab stop, and nothing said what any of them controlled.
   Two ways out. Drop the roles to plain buttons, or finish the widget. Finishing it is right here:
   the one call site (LeaderboardView) puts these in a Section's `tools` slot and the Section's
   children ARE the three panels, which is a tab/tabpanel relationship in fact and not just in
   markup. So: arrow keys move and select, Home/End jump to the ends, only the selected tab is a tab
   stop, and Tab from the tablist lands in the panel it selected.

   AUTOMATIC ACTIVATION (moving selects, rather than requiring Enter) is the APG's guidance for
   panels that are cheap to render, and these are: three sorted arrays over data already in memory.
   Manual activation exists for panels that fetch.

   IDS ARE NAMESPACED BY THE CALLER, and the namespace is required rather than defaulted. Two tab
   sets on one page with the same generated suffix would cross-wire their `aria-controls` silently —
   nothing would look wrong and a screen reader would follow the wrong link. `useId()` at the call
   site is the right namespace: React guarantees it per instance. */

function tabDomId(ns: string, id: string): string {
  return `${ns}-tab-${id}`;
}

function panelDomId(ns: string, id: string): string {
  return `${ns}-panel-${id}`;
}

// `NoInfer` on `items` so `T` is fixed by `value` — the caller's own union — instead of being
// widened to `string` by an inline array literal. Without it, `<Tabs items={[{id:"all",…}]}
// value={tab} onChange={setTab}/>` fails to typecheck against a `useState<TabId>` setter, which is
// the single most common way these get used.
export function Tabs<T extends string>({
  ns,
  items,
  value,
  onChange,
  ariaLabel,
}: {
  /** Id namespace shared with this tablist's `TabPanel`s — `useId()` at the call site. */
  ns: string;
  items: { id: NoInfer<T>; label: string }[];
  value: T;
  onChange(id: NoInfer<T>): void;
  ariaLabel: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = items.findIndex((it) => it.id === value);
    if (from < 0) return;

    let to: number;
    switch (e.key) {
      case "ArrowRight":
        to = (from + 1) % items.length;
        break;
      case "ArrowLeft":
        to = (from - 1 + items.length) % items.length;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = items.length - 1;
        break;
      default:
        return;
    }

    const target = items[to];
    if (!target) return;
    e.preventDefault();
    onChange(target.id);
    // Focus moves WITH selection, and it is read off the DOM at keypress time rather than from a
    // list of refs: the tablist is the event's own `currentTarget`, so there is nothing to keep in
    // sync and nothing to go stale if the items change.
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[to]?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {items.map((it) => {
        const selected = value === it.id;
        return (
          <button
            key={it.id}
            type="button"
            id={tabDomId(ns, it.id)}
            role="tab"
            aria-selected={selected}
            // ONLY THE SELECTED TAB POINTS AT A PANEL, because only its panel is in the document —
            // this page renders one board at a time rather than mounting three and hiding two. An
            // `aria-controls` naming an id that does not exist is worse than none: it is a promise
            // the reader's "go to controlled element" command cannot keep.
            aria-controls={selected ? panelDomId(ns, it.id) : undefined}
            // Roving tabindex: the tablist is ONE tab stop, and the arrow keys move within it. Three
            // separate stops is what made this widget's roles a lie.
            tabIndex={selected ? 0 : -1}
            className={selected ? "on" : undefined}
            onClick={() => onChange(it.id)}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/** The other half of `Tabs`: the panel a tab controls, named by that tab.
 *
 *  NO STYLING, AND THAT IS DELIBERATE — a bare wrapper with no padding, border or background, so the
 *  panel is exactly the box its contents already were. The design law forbids cards, and a tabpanel
 *  that drew one would be an accessibility fix leaving a visual scar.
 *
 *  `tabIndex={0}` makes the panel itself reachable: a panel whose content is a table of text has no
 *  focusable descendant at all, and without it a keyboard user tabs straight from the tablist past
 *  the thing they just selected.
 *
 *  IT IS SOMETIMES A DUPLICATE STOP, AND IT STAYS ANYWAY. ARIA's own authoring practice is to give a
 *  tabpanel `tabindex="0"` only when it holds nothing focusable, and since `views/ScrollBox.tsx`
 *  started contributing a stop for boards that overflow, two of the three leaderboard panels hold
 *  something: tabbing the all-time board now lands on the panel and then immediately on the scroll
 *  region inside it. Counted across the six states that actually ship (three boards x {1440px, 390px},
 *  at 8 and 16 fighters):
 *
 *      this round   0 focusable descendants, at every width and every roster size
 *      hall of fame 0 at 390px, 1 at 1440px (the ScrollBox, once the board is long enough to scroll)
 *      all-time     2 at 390px, 6 at 1440px (five sort headers, plus the ScrollBox)
 *
 *  So the blanket attribute is REQUIRED in two of those six and redundant in four. The two are not
 *  edge cases — "this round" is the board this screen opens on. Removing the attribute to satisfy the
 *  pattern would trade one surplus keystroke on the busy boards for a panel a keyboard cannot enter
 *  at all on the default one, which is the wrong direction to err in. Making it conditional would
 *  mean a primitive asking at runtime whether its own children are focusable — a MutationObserver, re-
 *  run on every sort and every resize — to save that keystroke.
 *
 *  If a future panel makes the duplication genuinely costly, the fix is a `focusable` prop decided by
 *  the call site, which knows what it is rendering. It is not a `querySelectorAll` in here. */
export function TabPanel({ ns, id, children }: { ns: string; id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={panelDomId(ns, id)} aria-labelledby={tabDomId(ns, id)} tabIndex={0}>
      {children}
    </div>
  );
}

export function Seg<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { id: NoInfer<T>; label: string; disabled?: boolean; title?: string }[];
  value: T;
  onChange(id: NoInfer<T>): void;
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.id)}
          type="button"
          title={o.title}
          disabled={o.disabled}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** THIS FIGHTER IS OURS. The keeper seats house wallets so a lobby is never empty, and an undisclosed
 *  one in a list of players is — in `data/keeperStatus.ts`'s own words — "a misrepresentation of who
 *  is in the round". `README.md`'s go-live list still has bot disclosure open; this is the mark that
 *  closes it, and it belongs on EVERY surface that names a fighter.
 *
 *  IT IS A WORD, NOT A BADGE. `.sim` and `.live` are filled chips because they mark a FIGURE, where a
 *  word beside a number reads as part of the number; this marks a NAME, and a tracked grey `.u`
 *  beside a name is the page's existing way of saying something quiet about it (`· you`, `OUT`). It
 *  also costs no new colour, no new fill and no new rule, which is the design law's whole position.
 *
 *  The title carries the disclosure itself rather than only the label, because a reader who has to
 *  ask what "HOUSE" means is exactly the reader the disclosure exists for. */
export function HouseTag() {
  return (
    <span className="u" title="Seated by the keeper so the lobby is never empty. It stakes real value and can win or lose like any other fighter — it is simply not another player.">
      House
    </span>
  );
}

/** Provenance markers. Every money figure on the page carries one — the page shows chain truth, a
 *  simulated ledger, AND (when devnet has no round open) a replayed fixture, and which is which must
 *  never be a guess. `fixture` wears the same grey as `sim` on purpose: both mean "not the chain",
 *  and that is the distinction a reader has to make in a glance. */
export function Tag({ kind }: { kind: "sim" | "live" | "fixture" }) {
  if (kind === "live") return <span className="live">chain</span>;
  return <span className="sim">{kind}</span>;
}

/** Money, formatted one way, everywhere.
 *
 *  `compact` is what every fixed-width money column on this page should be passing: `$13.2k` instead
 *  of `$13,487,910,540,099`, per `contract.ts`'s `usdCompact` — a chain figure printed in full is
 *  twenty characters against a 70px grid track, and a right-aligned overflow spills leftward over
 *  the column beside it. It ignores `dp`, which is a full-precision knob and has no meaning once the
 *  figure has been scaled.
 *
 *  THE EXACT FIGURE IS ALWAYS STILL REACHABLE. Compacting loses money on purpose, so the full
 *  two-decimal string goes on the cell's `title` — but only when it actually differs from what was
 *  rendered, because below $1,000 `usdCompact` IS the full string and a tooltip repeating the text
 *  under the cursor is noise on every row of the table. */
export function Money({
  units,
  signed,
  dp,
  compact,
  className,
}: {
  units: bigint;
  signed?: boolean;
  dp?: number;
  compact?: boolean;
  className?: string;
}) {
  const tone = signed ? (units > 0n ? " pos" : units < 0n ? " neg" : "") : "";
  const text = compact
    ? signed
      ? usdCompactSigned(units)
      : usdCompact(units)
    : signed
      ? usdSigned(units, dp)
      : usd(units, dp);
  const exact = signed ? usdSigned(units, 2) : usd(units, 2);
  return (
    <span
      className={`num${tone}${className ? ` ${className}` : ""}`}
      title={compact && text !== exact ? exact : undefined}
    >
      {text}
    </span>
  );
}

/** A figure with no backing data reads "—", never "0" (UI-SPEC.md's rule). */
export function Dash() {
  return <span className="none">—</span>;
}

/** An empty table/list state. One quiet line, no illustration, no card. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="u" style={{ padding: "18px 4px" }}>
      {children}
    </div>
  );
}
