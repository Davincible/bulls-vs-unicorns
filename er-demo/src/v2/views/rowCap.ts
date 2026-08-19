// HOW MANY ROWS A TABLE SHOWS BEFORE IT IS ASKED FOR MORE — the numbers, the arithmetic, and the
// sentence the control prints. One module, because there are eight capped tables across three
// screens and the alternative is eight opinions about all three.
//
// THE COMPLAINT, verbatim: "We have multiple tables on the home page, previous rounds, standings etc,
// should all be collapsed by default, as in only show a max number by default". Every table named is
// variable-length and several are unbounded — 00-5 renders up to 48 fighters, 04-1 up to 250 of your
// rounds, the standings board every wallet in the log — so the arena screen grew a tail proportional
// to how popular the arena got. The fix is a cap plus a way past it, not a smaller table.
//
// THE CAP IS A PLAIN TOP-N OF THE SORT THE TABLE ALREADY APPLIED, AND THAT IS A HARD RULE. Every
// call site sorts first and caps second, so the rows that survive are decided by RANK and by nothing
// else. `scripts/keeper/statusFile.ts` states the standing rule this serves: the arena fields its own
// wallets, and nothing in the UI may make that visible or inferable — "no label, no marker, no
// ORDERING". Capping is an ordering decision by construction, which is exactly why it is a `slice(0,
// n)` of an already-ordered list here and never a partition, a reserved slot, or a filter. If a
// future caller wants "always keep your own row visible", that is a bias on which rows survive the
// cut and it does not belong in this file.
//
// THE NUMBERS ARE NAMED BY THEIR ARGUMENT, NOT BY THEIR TABLE. A constant called `ROSTER_CAP` is a
// magic number with a longer name; a constant called `ROW_CAP_BOARD` carries the reason it is 10 and
// therefore tells the next caller which one to reach for. Five constants for eight tables is the
// point — two tables sharing a number share it because they share a reason.

import { counted } from "../contract.ts";

/** THE DEFAULT, and what most tables get: the arena screen's own tables (00-4's two rosters, 00-5's
 *  standings). Five rows is a glance rather than a list — enough to see the shape of the field and
 *  who is at the top of it, short enough that four tables stacked down 00 read as four facts instead
 *  of as a page you scroll past. The full version of both is one click away on 01. */
export const ROW_CAP = 5;

/** A BOARD ON A SCREEN SOMEBODY NAVIGATED TO ON PURPOSE — 01's three tabs, 04's two lists. Twice the
 *  default, because the reader's intent is different: they did not land here, they asked for the
 *  table. Ten is still a screenful rather than a scroll, and on 01 it sits inside a `ScrollBox` whose
 *  height cap is complementary to this one — the box stops a long table from pushing the page down,
 *  the cap stops it from being long in the first place. */
export const ROW_CAP_BOARD = 10;

/** A TABLE INSIDE AN OPENED ROW — 04-2's per-round field. It is already two levels down and the row
 *  above it was a deliberate press, so it can afford more than the default; but 04-2 opens its first
 *  round automatically, which means this table's rows are on screen at load without anyone asking for
 *  them. Eight is the compromise those two facts land on. */
export const ROW_CAP_NESTED = 8;

/** 00-6 PREVIOUS ROUNDS, and the tightest cap on the page — it is the only table here with a whole
 *  SCREEN one click away, advertised in its own header ("All rounds" → 04). Three rows answer the
 *  question the section is actually asked on 00 ("what happened just before this?") and hand
 *  everything else to the screen built for it.
 *
 *  Note what this cap is a cap ON: the section already showed the newest 8 of a log up to 250 deep,
 *  and expanding restores that 8 rather than the whole log. The section's own ceiling is unchanged —
 *  putting 250 rounds on the arena screen is the complaint, not the fix for it. */
export const ROW_CAP_RECENT = 3;

/** 00-7's VERIFY TABLE. Up to 48 rows of full-precision figures, and it renders only after a
 *  deliberate press of "Verify this round" — so the reader who is looking at it asked for it, which
 *  argues up from the default. What stops it going higher is that a divergent row can sit below the
 *  cut: `verify.result.fighters` is in entry order, not sorted by whether it agrees, and this file
 *  may not re-sort it (see the ordering rule above). That is survivable only because the verdict and
 *  the `Winner agrees` / `Value conserved` figures ABOVE the table already state the round's answer
 *  in full — the table is the workings, not the finding. Eight rows show the shape of the workings;
 *  a reader checking a specific fighter expands. */
export const ROW_CAP_PROOF = 8;

/** What a capped table renders, and what it is holding back. */
export interface Capped<T> {
  /** The rows to render right now — `rows.slice(0, cap)` while collapsed, the whole list once
   *  expanded. The SAME ARRAY REFERENCE as the input whenever nothing was dropped; see `capRows`. */
  rows: readonly T[];
  /** How many rows the cap holds back. This is the figure the control prints, and it does NOT change
   *  when the table expands — it is a property of the cap, not of the current state.
   *
   *  THAT IS THE ONLY SELF-CONSISTENT READING, and it is worth saying why, because "how many are
   *  hidden right now" is the obvious one and it is wrong. The control must (a) render nothing when
   *  `hidden === 0` and (b) not unmount when pressed, or focus drops to the top of the document —
   *  `ui/ConnectPanel.tsx` records that exact defect. A `hidden` that went to zero on expand would
   *  make those two rules contradict each other. This one satisfies both with a single test. */
  hidden: number;
}

/** The top `cap` rows, or all of them once `expanded`.
 *
 *  IDENTITY IS PRESERVED WHENEVER NOTHING IS DROPPED, and that is load-bearing rather than tidy.
 *  `live.fighters` is rebuilt four times a second (see `data/linkFighters.ts` for why the identity of
 *  that array is watched at all), and several of these tables feed `useMemo`s keyed on the array they
 *  are given. A fresh array per render from a table that is not capping anything would invalidate
 *  those memos for nothing — a `slice` that copies 5 of 5 rows is pure cost. So both non-capping
 *  branches return the input untouched. */
export function capRows<T>(rows: readonly T[], cap: number, expanded: boolean): Capped<T> {
  // `Math.max` and not a bare subtraction: a caller passing a cap larger than the list must produce
  // 0, never a negative "hidden" that would print as "SHOW THE REST — −3 FIGHTERS".
  const hidden = Math.max(0, rows.length - cap);
  if (expanded || hidden === 0) return { rows, hidden };
  return { rows: rows.slice(0, cap), hidden };
}

/** The control's label, in both of its states.
 *
 *  THE COUNT IS THE WHOLE POINT and it goes at the END. "Show more" alone tells a reader nothing
 *  about whether pressing it costs them two rows or two hundred, and the count is what makes the cap
 *  honest rather than a quiet truncation. Ending on `counted()` is the same move `HistoryView`'s lede
 *  makes and for the same reason — the agreement problem is sidestepped entirely, and the pair reads
 *  identically at 1 as at 40.
 *
 *  `counted` DOES THE NOUN, and this file writes no second pluraliser (`contract.ts` says why it owns
 *  the rule). Every noun passed in today is regular — fighter, round, player, wallet, performance —
 *  so the default plural is correct; the day one is not, `counted`'s third argument is where it goes
 *  and this signature grows to pass it through.
 *
 *  THE VERB IS THE ONLY WORD THAT MOVES. "Show the rest" and "Hide the rest" over the same count read
 *  as one control in two states rather than as two controls, which is exactly what they are — the
 *  button is not replaced when it is pressed. State is carried by that verb, by the bracket glyph
 *  beside it and by `aria-expanded`; never by colour. */
export function rowCapLabel(hidden: number, expanded: boolean, noun: string): string {
  return `${expanded ? "Hide" : "Show"} the rest — ${counted(hidden, noun)}`;
}
