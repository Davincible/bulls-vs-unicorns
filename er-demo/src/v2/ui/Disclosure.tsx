// A CLOSED-BY-DEFAULT DISCLOSURE — the answer to ten paragraphs in one 420px column.
//
// THE COMPLAINT THIS EXISTS FOR, verbatim: "the wallet side panel is a fucking mess. Wayyyy too much
// text. Very unnecessary. No one is going to read that." Every paragraph it names is one this repo
// argues for at length somewhere — the pause-versus-revoke distinction is required honestly by
// `SOCIAL.md` §5.4, the custody claims are the whole reason the `sim` marker exists — so the fix
// could not be deletion. It had to be a place to PUT them where a reader who wants them can open
// them and a reader who does not never sees them.
//
// NATIVE `<details>`/`<summary>`, AND THAT IS THE WHOLE IMPLEMENTATION. Three reasons, in order of
// how much they cost to give up:
//
//   * THE PRODUCTION CSP IS ENFORCED AND FORBIDS INLINE SCRIPT (`default-src 'self'`). A hand-rolled
//     disclosure is a `useState`, an `aria-expanded`, an `aria-controls` and a keydown handler — all
//     of which ship fine, but every one of them is a chance to get the ARIA wrong for a widget the
//     platform already implements correctly. Nothing here needs a byte of new script.
//   * KEYBOARD AND SCREEN-READER SUPPORT ARRIVE FOR FREE and are the browser's problem to keep
//     right: `<summary>` is focusable, Enter and Space toggle it, and the expanded/collapsed state is
//     exposed without an attribute this file has to remember to update.
//   * IT SURVIVES CSS FAILING. If this stylesheet never loads, a `<details>` is still a working
//     disclosure with a working triangle. A div pretending to be one is a paragraph that vanished.
//
// THE MARKER IS REPLACED, NEVER REMOVED. The default triangle is dropped and the page's own bracket
// form takes its place — `[+]` closed, `[-]` open, the same vocabulary as `[00]`, `[?]`, `[$]`, `[F]`
// and `[W]` elsewhere on this page. That keeps two rules at once: the open/closed state is carried by
// a GLYPH rather than by colour (nothing on this page may say anything in colour alone), and a
// reader who has learned that brackets mean "a handle for something" is not taught a second idiom.
// `:focus-visible` is deliberately untouched — base.css's ring applies to a `<summary>` already.
//
// THE SUMMARY NAMES WHAT IS INSIDE IT. Not "Learn more", not "Details", not "▸". A closed disclosure
// is a promise about its contents, and a reader deciding whether to spend a click on it can only
// make that decision from the label. "What Pause and Revoke actually do" is a summary; "More info"
// is a shrug. This is a rule for every caller, not a suggestion — see the call sites in
// `SideRail.tsx`, every one of which names its own contents.

import type { ReactNode } from "react";
import "./Disclosure.css";

export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    // NO `open` PROP, AND THERE IS NOT GOING TO BE ONE. A disclosure this page opens for you is a
    // paragraph again, and the reason a caller would want it — "but MY paragraph is important" — is
    // true of every paragraph that got collapsed here.
    <details className="disc">
      <summary className="u disc-s">{summary}</summary>
      <div className="disc-b">{children}</div>
    </details>
  );
}
