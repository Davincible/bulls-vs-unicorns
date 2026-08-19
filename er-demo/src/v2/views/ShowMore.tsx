// THE CONTROL UNDER A CAPPED TABLE — one button, eight tables, and nothing else.
//
// IT LIVES HERE, BESIDE `ScrollBox.tsx`, for that file's own stated reason: used by more than one
// screen, not generic enough for `ui/primitives.tsx`. `.showmore` means nothing outside a table on 00,
// 01 or 04, and the vocabulary file says anything specific to these screens stays with them. The two
// modules are also complementary rather than alternative — `ScrollBox` caps a table's HEIGHT so the
// page below it stays reachable, this caps its ROW COUNT so the table is a glance in the first place.
// A long table wants both, and the boards on 01 have both.
//
// A REAL `<button>`, NOT A `<details>`, and that is the one place this deliberately parts from
// `ui/Disclosure.tsx`, which a parallel workstream built for exactly this shape of problem. A native
// disclosure is the right answer for PROSE and the wrong one here: `<details>` inserts a `<summary>`
// and a content wrapper into the DOM, and these tables are `role="table"` grids whose children must
// be rows. Wrapping rows in a disclosure breaks the grid semantics the tables carry, and moving the
// disclosure OUTSIDE the table would put the toggle outside the thing it toggles. So the state is a
// `useState` at the call site, the ARIA is written out below, and the visual idiom — the page's
// bracket vocabulary, `[+]` closed and `[-]` open, the same as `[00]` / `[?]` / `[$]` — is matched
// exactly. A reader who has learned that brackets are handles is not taught a second idiom.
//
// THE BRACKET IS A REAL SPAN AND NOT A `::before`, WHICH IS THE OTHER DIVERGENCE. `Disclosure.css`
// draws its bracket with generated content, which is right for a `<summary>` whose label is a
// sentence. Here the label is short and the accessible name matters more: generated content IS
// folded into the accessible name by the accname algorithm, so a `::before` would name this button
// "left bracket plus right bracket, Show the rest, 19 fighters" in the readers that do it. The state
// is already carried to a screen reader by `aria-expanded`, so the glyph is decoration for the eye
// and is marked as such. Same picture, one attribute cheaper to listen to.
//
// AND IT NEVER UNMOUNTS WHEN IT IS PRESSED. `rowCap.ts`'s `hidden` is a property of the CAP rather
// than of the current state, so the same element with the same position takes the press and comes
// back with a new label — `ui/ConnectPanel.tsx` records what happens when it does not (focus drops to
// the top of the document, and a keyboard reader is thrown back to the start of the page for the
// crime of expanding a table). Same element, same position, new label.

import "./ShowMore.css";
import { rowCapLabel } from "./rowCap.ts";

export function ShowMore({
  hidden,
  expanded,
  noun,
  controls,
  onToggle,
}: {
  /** `Capped.hidden` — how many rows the cap holds back, in either state. */
  hidden: number;
  expanded: boolean;
  /** Singular; `rowCapLabel` makes the plural through `contract.ts#counted`. */
  noun: string;
  /** The DOM id of the container holding the rows this reveals — `useId()` at the call site, the
   *  way `LeaderboardView` already scopes its tab/panel pairs. */
  controls: string;
  onToggle(): void;
}) {
  // NOTHING AT ALL FOR A TABLE THAT FITS. A dead "show 0 more" under every short table is worse than
  // no control: it is a permanent affordance that does nothing, on a page whose entire deliverable
  // here is LESS on screen. This is also what keeps an `Empty` table empty — a board with no rows
  // hides nothing, so it grows no control.
  if (hidden === 0) return null;

  return (
    // `.btn--ghost .btn--sm` rather than a new box: the quiet bordered button is already this page's
    // word for a secondary control beside a table (00-6's "All rounds" is literally these three
    // classes), and inheriting it means inheriting base.css's target-size policy too — 24px tall on a
    // desktop, and the phone breakpoint repads every `.btn--sm` to 44px without this file saying
    // anything. A bespoke box here would have been a fourth button idiom AND its own target
    // arithmetic to keep right. `:focus-visible` likewise: base.css draws a 2px `--ink` ring on every
    // focusable thing, which is 15.9:1 against paper and 5.4:1 against the wash a hovered row sits on.
    <button
      type="button"
      className="btn btn--sm btn--ghost showmore"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      <span className="showmore-k" aria-hidden="true">
        {expanded ? "[-]" : "[+]"}
      </span>
      {rowCapLabel(hidden, expanded, noun)}
    </button>
  );
}
