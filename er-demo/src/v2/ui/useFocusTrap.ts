// FOCUS CONTAINMENT — the half of "modal" that ARIA does not do for you.
//
// `aria-modal="true"` is a statement to the ACCESSIBILITY TREE: a screen reader's virtual cursor
// treats everything outside the dialogue as though it were not there. It is not a statement to the
// BROWSER, and the browser owns the tab order. So a takeover carrying `role="dialog"` and
// `aria-modal="true"` and nothing else is, to a keyboard, a sheet of paper laid over a page whose
// every control is still reachable and still pressable — which is exactly what was measured on this
// page before this file existed: one Tab moved focus out of the intro's button, and the next three
// landed on page controls behind a takeover whose entire purpose is to be read first.
//
// The two mechanisms are complementary and neither substitutes for the other. The attribute fixes
// the READING order; this hook fixes the TAB order. Both are needed to make one claim true.
//
// IT IS ALSO THE PAGE'S ONLY COPY OF THIS LOGIC, deliberately. Two panels want it — the first-visit
// takeover and, at the width where it covers the whole screen, the right-hand rail — and a focus
// trap that exists twice is a focus trap that behaves two ways. The differences between the two call
// sites are expressed as options, not as a second implementation.
//
// WHAT IT DOES NOT DO:
//
//   * It does not touch Escape. Escape is already owned by `useKeyboardNav` (and by the two panels'
//     own listeners), where its precedence is decided once — takeover before rail — so that one
//     press does exactly one thing. A trap that also closed on Escape would be a third opinion.
//   * It does not re-trap on `focusin`. Pulling focus back whenever it lands outside sounds
//     stricter, but it fights every legitimate way focus leaves a document — the address bar, a
//     browser find bar, a screen reader's own cursor — and a loop between two elements that each
//     move focus is a hang with no console error. Containing Tab contains the keyboard; that is the
//     hole that was actually open.
//   * It does not make the page behind `inert`. `inert` would be the tidier primitive, but it would
//     mean this hook reaching outside the container it was handed and mutating elements owned by
//     other components — and with Tab contained and `aria-modal` set, there is nothing left for it
//     to fix that is worth that reach.

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/** Everything the browser will consider making a tab stop of. `:not(:disabled)` is in the selector
 *  rather than in the filter below because a disabled control is not a candidate at all — the
 *  filter's job is the things a selector cannot see (visibility, an aria-hidden ancestor, an
 *  explicit negative tabindex). */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "summary",
  "iframe",
  "audio[controls]",
  "video[controls]",
  '[contenteditable]:not([contenteditable="false"])',
  "[tabindex]",
].join(",");

/** Visible in the sense that matters for focus: the browser will refuse to focus a `display: none`
 *  element, and WILL happily focus a `visibility: hidden` one — which is precisely how the rail
 *  parks itself between opens (`shell.css`), so both have to be asked about.
 *
 *  `getClientRects()` is empty for `display: none` and for a detached node but NOT for
 *  `visibility: hidden`, which still generates boxes; the computed style answers that half.
 *  `visibility` inherits, so reading it off the element itself also answers for every ancestor and
 *  saves walking the tree. */
function isVisible(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false;
  return getComputedStyle(el).visibility === "visible";
}

/** A real tab stop, right now. `tabIndex >= 0` throws out `[tabindex="-1"]`, which matches the
 *  selector but is programmatic-focus-only; the `aria-hidden` ancestor test keeps focus out of a
 *  subtree that has told screen readers it does not exist — the closing rail is exactly that for the
 *  120ms of its slide-out. */
function isFocusable(el: HTMLElement): boolean {
  if (!el.isConnected || el.tabIndex < 0) return false;
  if (!el.matches(FOCUSABLE_SELECTOR)) return false;
  if (el.closest('[aria-hidden="true"]') !== null) return false;
  return isVisible(el);
}

/** The container's tab stops, in tab order — recomputed on every keypress rather than captured once.
 *  The rail's contents change while it is open (it has two tenants, a cashier whose buttons enable
 *  and disable with the balance, and an error line that comes and goes), so a list taken at mount is
 *  a list that is wrong by the time anyone presses Tab.
 *
 *  DOM order, not `tabindex` order: nothing inside either panel sets a positive tabindex, and
 *  honouring one properly would mean implementing the browser's whole two-pass ordering. If a
 *  positive tabindex is ever added inside a trapped panel, that is the thing to fix — not this. */
function tabStopsWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable);
}

/** Put focus back where it came from when the panel closes — and if that is no longer possible, put
 *  it somewhere a keyboard can carry on from.
 *
 *  The element that opened a panel is routinely gone by the time the panel closes: the rail is
 *  opened from fighter rows that re-sort mid-fight, and the takeover is opened by nobody at all (on
 *  first paint `document.activeElement` is `<body>`, which is not focusable and is not a place to
 *  leave anyone). "Fall back to the top of the document" is the honest answer for both — the first
 *  tab stop on the page is a chrome control, so the user resumes from the start of the page instead
 *  of from a `<body>` that announces nothing. */
function restoreFocus(previous: HTMLElement | null): void {
  if (previous !== null && isFocusable(previous)) {
    previous.focus();
    return;
  }
  // `.at(0)`, not `[0]`: an empty document is a real (if brief) state, and this should type as the
  // "maybe nothing" it is rather than lie and be guarded anyway.
  tabStopsWithin(document.body).at(0)?.focus();
}

export interface FocusTrapOptions {
  /** Whether the panel is open. False means no listeners, no focus stealing, no restore — a closed
   *  panel must be able to sit mounted (the rail does, so it can slide) without touching focus. */
  active: boolean;
  /** What to focus when the trap activates. The takeover wants its acknowledge button, the rail
   *  wants its close control. Omitted, the first tab stop in the container gets it. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** A value that, while the trap stays active, re-runs the initial focus whenever it changes.
   *
   *  The takeover has nothing to pass: it activates once and its contents never change under the
   *  reader. The rail is one panel with two tenants and swaps its entire contents in place — opening
   *  a second fighter while it is already open replaces everything in it — and a reader left standing
   *  on the row they pressed gets no signal at all that the panel beside them now describes somebody
   *  else. Moving focus back to the panel head is that signal, and it is what the rail did before
   *  this hook existed. */
  refocusKey?: unknown;
  /** Whether Tab is CONTAINED, as opposed to merely managed.
   *
   *  Separate from `active` because the rail needs one without the other: it always wants its focus
   *  remembered and restored, and it only wants Tab contained at the width where it covers the whole
   *  screen (see SideRail.tsx). A complementary landmark that a reader can see past is not a
   *  dialogue, and trapping the keyboard in one would be a lie in the other direction. */
  trapTab?: boolean;
}

export function useFocusTrap(
  container: RefObject<HTMLElement | null>,
  { active, initialFocus, refocusKey, trapTab = true }: FocusTrapOptions,
): void {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // PASSIVE EFFECTS, NOT LAYOUT ONES — and this is the opposite of what focus management usually
  // wants, so it is worth saying why. React runs a focus service of its own around every commit:
  // `prepareForCommit` records `document.activeElement` before it touches the DOM, and
  // `resetAfterCommit` → `restoreSelection` puts focus BACK on that element afterwards, unless it has
  // left the document. It exists so that re-parenting a subtree does not lose focus, and it does not
  // care why focus moved in between.
  //
  // The rail stays MOUNTED while closed (it has to, or it cannot slide out), so its close button is
  // still in the document at the moment the panel closes — and a restore performed inside the commit
  // is therefore reverted by React a moment later. Measured on the running page, with
  // `HTMLElement.prototype.focus` instrumented: focus moved to the opener row (this hook, from a
  // layout effect), then straight back to the rail's ✕ (`restoreSelection`), then to `<body>` 120ms
  // later when the CSS transition took the panel to `visibility: hidden`. Which is precisely the
  // reported bug, reproduced with the fix in place.
  //
  // Passive effects run after the commit, so they are the last word. Both panels are opened and
  // closed by a discrete event — a click or a keypress — and React flushes passive effects for those
  // in the same task, so focus leaves the closing panel before the browser paints it as closed and
  // before anything can observe the `aria-hidden="true"` subtree holding it.
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement;
    previouslyFocused.current = opener instanceof HTMLElement ? opener : null;
    return () => {
      restoreFocus(previouslyFocused.current);
      previouslyFocused.current = null;
    };
  }, [active]);

  // Declared AFTER the capture above so it runs after it: React fires effects in declaration order,
  // and reversing these two would have the trap remember the element it had just focused itself.
  useEffect(() => {
    if (!active) return;
    const root = container.current;
    if (!root) return;
    (initialFocus?.current ?? tabStopsWithin(root).at(0))?.focus();
  }, [active, container, initialFocus, refocusKey]);

  useEffect(() => {
    if (!active || !trapTab) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const root = container.current;
      if (!root) return;

      const stops = tabStopsWithin(root);
      // A panel with nothing to focus still must not leak: holding focus where it is says "this is
      // modal and there is nothing in it to operate", which is true, and is recoverable with Escape.
      if (stops.length === 0) {
        e.preventDefault();
        return;
      }

      const first = stops[0];
      const last = stops[stops.length - 1];
      const current = document.activeElement;

      // Focus outside the container at all — it started on `<body>`, or something moved it. Pull it
      // to the edge the keypress was heading for rather than letting the browser continue from
      // wherever it was.
      if (!(current instanceof HTMLElement) || !root.contains(current)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }

      if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
      // Anywhere in the middle: the browser's own Tab is correct, and intercepting it would only
      // reimplement it worse.
    };

    // Capture, so the trap sees Tab before any handler on the way up can stop its propagation. It
    // still yields to `defaultPrevented`, which is a component saying it has already dealt with the
    // keypress itself.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active, trapTab, container]);
}

// The viewport question this file's one conditional caller asks — "is the rail covering the whole
// screen, and therefore a dialogue rather than a landmark?" — is answered by `useMediaQuery.ts`,
// which owns both the hook and the name of the page's single layout break. It briefly lived here as
// a second copy, written while `StakeDock.tsx`'s identical `useMatches` was mid-rewrite; both have
// been folded into that module, so there is one implementation and one breakpoint constant.
