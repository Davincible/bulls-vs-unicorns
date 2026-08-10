// THE FIRST-VISIT TAKEOVER — the half of "modal" that ARIA does not do for you.
//
// THE INCIDENT (`ui/useFocusTrap.ts`'s header, measured on the running page): the overlay carried
// `role="dialog"` and `aria-modal="true"` and nothing else. That pair is a statement to the
// ACCESSIBILITY TREE — a screen reader's virtual cursor treats everything outside as absent — and it
// is not a statement to the BROWSER, which owns the tab order. One Tab moved focus out of the
// intro's button and the next three landed on live page controls behind a takeover whose entire
// purpose is to be read first.
//
// THE OTHER HALF IS WHERE FOCUS GOES AFTERWARDS. A dialogue that closes and drops focus on `<body>`
// announces nothing and restarts tabbing from the top of the page. `restoreFocus` returns it to the
// element that opened the panel, and falls back to the document's first tab stop when there is no
// such element — which is the takeover's first-paint case, where `document.activeElement` is `<body>`
// and nobody opened anything.
//
// A UNIT TEST CANNOT HAVE THIS. Tab order is the browser's, `getClientRects()` and
// `getComputedStyle().visibility` are the layout engine's, and the bug was a real Tab moving real
// focus onto a real control. It is a browser test or it is nothing.

import { describe, expect, it } from "vitest";
import { assertNoPageErrors, keeperStates, open, useBrowser, until } from "./harness.ts";

/** Where focus is, described well enough for a failure message to be actionable. */
async function focused(page: import("playwright-core").Page) {
  return await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el === null) return { tag: "(none)", inOverlay: false, testid: null as string | null, text: "" };
    return {
      tag: el.tagName,
      inOverlay: el.closest(".overlay") !== null,
      testid: el.getAttribute("data-testid"),
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
    };
  });
}

describe("the first-visit takeover", () => {
  const browser = useBrowser();

  it("opens as a dialogue with focus already inside it", async () => {
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby(), dismissIntro: false });
    try {
      const dialog = s.page.locator('[role="dialog"]');
      expect(await dialog.count()).toBe(1);
      expect(await dialog.getAttribute("aria-modal")).toBe("true");
      // Labelled by its own heading, so a screen reader announces what it is.
      const labelledBy = await dialog.getAttribute("aria-labelledby");
      expect(labelledBy).not.toBeNull();
      expect(await s.page.locator(`#${labelledBy}`).count()).toBe(1);

      // `initialFocus` is the acknowledge button — the one thing there is to do in here.
      await until(async () => (await focused(s.page)).inOverlay, "focus to enter the takeover");
      const at = await focused(s.page);
      expect(at.tag).toBe("BUTTON");
      expect(at.text.toLowerCase()).toContain("go");

      assertNoPageErrors(s, "the takeover");
    } finally {
      await s.close();
    }
  });

  it("contains Tab, forwards and backwards, rather than leaking onto the page behind", async () => {
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby(), dismissIntro: false });
    try {
      await until(async () => (await focused(s.page)).inOverlay, "focus to enter the takeover");

      // TEN TABS. The measured leak was ONE Tab out and three more onto live controls, so anything
      // past four presses is already past the reported failure; ten is cheap and covers a trap that
      // holds for a lap and then lets go.
      const escaped: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        await s.page.keyboard.press("Tab");
        const at = await focused(s.page);
        if (!at.inOverlay) escaped.push(`Tab ${i + 1} -> ${at.tag} "${at.text}"`);
      }
      for (let i = 0; i < 10; i += 1) {
        await s.page.keyboard.press("Shift+Tab");
        const at = await focused(s.page);
        if (!at.inOverlay) escaped.push(`Shift+Tab ${i + 1} -> ${at.tag} "${at.text}"`);
      }
      expect(escaped, "focus escaped the takeover").toEqual([]);

      assertNoPageErrors(s, "the focus trap");
    } finally {
      await s.close();
    }
  });

  it("hands focus somewhere usable when it is dismissed on first paint", async () => {
    // NOBODY OPENED IT. `document.activeElement` is `<body>` at first paint, which is not focusable
    // and is not a place to leave anyone — so `restoreFocus` falls through to the document's first
    // tab stop. What must never happen is focus landing back on `<body>`, which announces nothing
    // and restarts tabbing from the top.
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby(), dismissIntro: false });
    try {
      await until(async () => (await focused(s.page)).inOverlay, "focus to enter the takeover");
      await s.page.keyboard.press("Escape");
      await until(
        async () => (await s.page.locator('[role="dialog"]').count()) === 0,
        "the takeover to close",
      );

      const at = await focused(s.page);
      expect(at.tag, "focus was dropped on the document body").not.toBe("BODY");
      expect(at.inOverlay).toBe(false);
      // Whatever it is, it is a real tab stop — the page can be operated from here.
      const isTabbable = await s.page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el !== null && el.tabIndex >= 0 && el.getClientRects().length > 0;
      });
      expect(isTabbable, `focus landed on ${at.tag} "${at.text}", which is not a tab stop`).toBe(true);

      assertNoPageErrors(s, "dismissing the takeover");
    } finally {
      await s.close();
    }
  });

  it("returns focus to the control that reopened it", async () => {
    // THE FULL CONTRACT, and the only case where "returns it" can be checked against a specific
    // element: the bottom bar's "How this works" button is a real, focusable opener, so closing must
    // put focus back on it and not merely somewhere plausible.
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      const opener = s.page.locator('[data-testid="chrome-intro-btn"]');
      await opener.click();
      await until(
        async () => (await s.page.locator('[role="dialog"]').count()) === 1,
        "the takeover to reopen",
      );
      await until(async () => (await focused(s.page)).inOverlay, "focus to enter the takeover");

      await s.page.keyboard.press("Escape");
      await until(
        async () => (await s.page.locator('[role="dialog"]').count()) === 0,
        "the takeover to close",
      );
      await until(
        async () => (await focused(s.page)).testid === "chrome-intro-btn",
        "focus to return to the control that opened the takeover",
      );

      assertNoPageErrors(s, "reopening the takeover");
    } finally {
      await s.close();
    }
  });

  it("shows once per browser and stays reachable afterwards", async () => {
    // `INTRO_KEY` records "this browser has been shown the takeover unasked", and reopening it
    // deliberately does NOT re-arm that — so a reload after a dismissal must be quiet, and the bar's
    // button must still be there. Two separate claims, and the second is why the button exists at all.
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby(), dismissIntro: false });
    try {
      expect(await s.page.locator('[role="dialog"]').count()).toBe(1);
      await s.page.getByRole("button", { name: /let.?s go/i }).click();
      await until(
        async () => (await s.page.locator('[role="dialog"]').count()) === 0,
        "the takeover to close",
      );

      await s.page.reload({ waitUntil: "load" });
      await s.page.waitForSelector(".chrome--top");
      expect(await s.page.locator('[role="dialog"]').count(), "the takeover returned on reload").toBe(0);
      expect(await s.page.locator('[data-testid="chrome-intro-btn"]').count()).toBe(1);

      assertNoPageErrors(s, "the second visit");
    } finally {
      await s.close();
    }
  });
});
