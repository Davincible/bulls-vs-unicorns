// The shared vocabulary of the v2 page, in React form. Written alongside `styles/base.css` (whose
// header comment is the design law) so that every screen composes the SAME handful of pieces —
// a section is always a rule + an index + a heading, a side marker is always a 7px square, money is
// always formatted by `contract.ts`. Anything that appears on two screens belongs here; anything
// specific to one screen stays with that screen.

import type { ReactNode } from "react";
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

/** The smallest possible carrier of a side colour. */
export function Mark({ side, dead }: { side: Side; dead?: boolean }) {
  return <span className={`mk ${dead ? "mk--dead" : side === 0 ? "mk--a" : "mk--b"}`} aria-hidden="true" />;
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

// `NoInfer` on `items` so `T` is fixed by `value` — the caller's own union — instead of being
// widened to `string` by an inline array literal. Without it, `<Tabs items={[{id:"all",…}]}
// value={tab} onChange={setTab}/>` fails to typecheck against a `useState<TabId>` setter, which is
// the single most common way these get used.
export function Tabs<T extends string>({
  items,
  value,
  onChange,
}: {
  items: { id: NoInfer<T>; label: string }[];
  value: T;
  onChange(id: NoInfer<T>): void;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          aria-selected={value === it.id}
          className={value === it.id ? "on" : undefined}
          onClick={() => onChange(it.id)}
        >
          {it.label}
        </button>
      ))}
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
