// Digit keys jump between screens.
//
// THE KEY IS THE PRINTED INDEX. The nav already labels every screen `[00] ARENA`, `[01]
// LEADERBOARD`, and so on, and the same numbering runs through every section heading on the page
// (`00-1 THE ROUND`, `01-2 ALL-TIME`). So `1` goes to `[01]`, `2` to `[02]`, and the shortcut needs
// no legend anywhere — the label already says which key it is. Binding 1-5 by ordinal position
// instead would have made `1` mean "the screen labelled 00", which is the sort of small, permanent
// papercut that makes a keyboard shortcut feel unreliable and stop getting used.
//
// NOT WHILE TYPING. The deploy panel contains a number field and a range slider; `5` there means
// five dollars, not "go to History". Any event originating inside a form control, a `contenteditable`
// region, or while a modifier is held is left entirely alone — a shortcut that eats your input is
// worse than no shortcut.

import { useEffect } from "react";
import type { ViewId } from "../contract.ts";

/** Screen order, matching the printed `[nn]` index in the bottom chrome. Index in this array IS the
 *  digit that selects it. */
export const SCREEN_KEYS: ViewId[] = ["arena", "leaderboard", "dashboard", "referrals", "history"];

/** True when the keystroke belongs to whatever the user is typing into, not to the page. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export interface KeyboardNavOptions {
  setView(id: ViewId): void;
  /** Escape's job, in priority order — close the rail if it's open, else close the intro. Returning
   *  true means "handled", so one Escape never does two things at once. */
  onEscape(): boolean;
  /** While the first-visit takeover is up it owns the keyboard: navigating behind a modal leaves the
   *  reader on a screen they didn't ask for once they dismiss it. */
  blocked: boolean;
}

export function useKeyboardNav({ setView, onEscape, blocked }: KeyboardNavOptions): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape works even when blocked — that is how the takeover itself gets dismissed.
      if (e.key === "Escape") {
        if (onEscape()) e.preventDefault();
        return;
      }

      if (blocked) return;
      // Modifier chords belong to the browser and the OS (⌘1 switches browser tabs, and taking that
      // over would be hostile).
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isTypingTarget(e.target)) return;

      // `e.key` rather than `e.code`: this reads the character the layout actually produced, so it
      // still works on AZERTY and on a numeric keypad, where `code` would be `Digit1`/`Numpad1` and
      // a `code`-based binding silently does nothing for half the keyboards in the world.
      if (e.key.length !== 1 || e.key < "0" || e.key > "9") return;
      const target = SCREEN_KEYS[Number(e.key)];
      if (!target) return;   // 5-9: no screen, and swallowing them would be a lie about what exists

      e.preventDefault();
      setView(target);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setView, onEscape, blocked]);
}
