// DEFECT #6 — KEYBOARD NAVIGATION, AND THE TWO WAYS IT GOES WRONG.
//
// THE BINDING IS THE PRINTED INDEX, NOT THE ORDINAL. The bottom nav labels its five screens
// `[00] ARENA` … `[04] HISTORY`, and the same numbering runs through every section heading on the
// page. So `1` goes to the screen labelled `[01]`. Binding by position instead would make `1` mean
// "the screen labelled 00" — the sort of small permanent papercut that makes a shortcut feel
// unreliable and stop being used. `useKeyboardNav.ts` says so; nothing checked it end to end, and
// the label and the handler are written in two different files (`Chrome.tsx` and
// `useKeyboardNav.ts`) which is exactly where an off-by-one lives.
//
// AND IT MUST BE INERT WHILE SOMEONE IS TYPING. The deploy panel contains a number field and a
// range slider. `5` there means five dollars, not "go to History" — a shortcut that eats your input
// is worse than no shortcut. Same for the first-visit takeover, which owns the keyboard while it is
// up: navigating behind a modal leaves the reader on a screen they never asked for.
//
// THE PRINTED LABEL AND THE HANDLER ARE HELD AGAINST EACH OTHER HERE. `goToView` in the harness
// selects by `aria-keyshortcuts`, and this file reads the label's own `[nn]` text — so a nav whose
// printed index and whose advertised shortcut disagreed could not pass both halves.

import { describe, expect, it } from "vitest";
import {
  VIEWS,
  assertNoPageErrors,
  currentView,
  goToView,
  keeperStates,
  open,
  useBrowser,
  until,
} from "./harness.ts";

/** What each nav button prints and what it advertises, straight off the DOM. */
async function navButtons(page: import("playwright-core").Page) {
  return await page.evaluate(() =>
    // `.nav button`, not every button in the bar: the bottom chrome also carries "How this works"
    // and the wallet control, which are not screens and carry no index.
    Array.from(
      document.querySelectorAll<HTMLElement>('nav[aria-label="Screens"] .nav button'),
    ).map((b) => ({
      printed: b.querySelector(".nav-i")?.textContent?.trim() ?? "",
      shortcut: b.getAttribute("aria-keyshortcuts") ?? "",
      label: b.textContent?.replace(/^\[\d+\]/, "").trim() ?? "",
    })),
  );
}

describe("keyboard navigation", () => {
  const browser = useBrowser();

  it("binds each digit to the index the nav prints beside it", async () => {
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      const buttons = await navButtons(s.page);
      expect(buttons.length, "the screens nav did not render").toBe(VIEWS.length);

      for (const [i, button] of buttons.entries()) {
        // The label says `[01]`; the shortcut attribute says `1`; they must be the same digit.
        expect(button.printed, `nav button ${i} prints "${button.printed}"`).toMatch(/^\[\d\d\]$/);
        const printedDigit = Number(button.printed.slice(1, -1));
        expect(printedDigit, `"${button.printed}" advertises key ${button.shortcut}`).toBe(
          Number(button.shortcut),
        );

        // And pressing that digit actually lands there.
        await s.page.keyboard.press(String(printedDigit));
        await until(
          async () => (await currentView(s.page)) === VIEWS[printedDigit],
          `key ${printedDigit} to select ${VIEWS[printedDigit]} (${button.label})`,
        );
      }

      assertNoPageErrors(s, "digit navigation");
    } finally {
      await s.close();
    }
  });

  it("leaves 5 through 9 alone rather than swallowing them", async () => {
    // `useKeyboardNav` returns without `preventDefault` for a digit with no screen behind it,
    // deliberately: swallowing them would be a lie about what exists.
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      await goToView(s.page, "dashboard");
      for (const key of ["5", "6", "7", "8", "9"]) {
        await s.page.keyboard.press(key);
        expect(await currentView(s.page), `key ${key} moved the page`).toBe("dashboard");
      }
      assertNoPageErrors(s, "unbound digits");
    } finally {
      await s.close();
    }
  });

  it("stays out of the way while a digit is being typed into the stake field", async () => {
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      await goToView(s.page, "arena");
      const amount = s.page.locator("#stake-amt");
      await amount.click();
      // `ControlOrMeta+a` — see `stake.e2e.ts`'s `clearField` for why `Control+a` is wrong on macOS.
      await amount.press("ControlOrMeta+a");
      await amount.pressSequentially("53");

      expect(await currentView(s.page), "typing 5 navigated away from the arena").toBe("arena");
      expect(await amount.inputValue()).toBe("53");

      // The slider is the other control `useKeyboardNav` has to keep its hands off.
      const slider = s.page.locator('input[type="range"][aria-label="Stake amount"]');
      await slider.focus();
      await s.page.keyboard.press("4");
      expect(await currentView(s.page), "a digit on the slider navigated away").toBe("arena");

      assertNoPageErrors(s, "typing");
    } finally {
      await s.close();
    }
  });

  it("stays out of the way while the first-visit takeover is up", async () => {
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby(), dismissIntro: false });
    try {
      expect(await s.page.locator('[role="dialog"]').count()).toBe(1);
      await s.page.keyboard.press("3");
      expect(await currentView(s.page), "a digit navigated behind the takeover").toBe("arena");
      expect(await s.page.locator('[role="dialog"]').count(), "the digit closed the takeover").toBe(1);

      // Escape is the one key that still works while blocked — it is how the takeover is dismissed.
      await s.page.keyboard.press("Escape");
      await until(
        async () => (await s.page.locator('[role="dialog"]').count()) === 0,
        "Escape to dismiss the takeover",
      );
      // And now the digits are live again.
      await s.page.keyboard.press("3");
      await until(async () => (await currentView(s.page)) === "referrals", "key 3 to select referrals");

      assertNoPageErrors(s, "the blocked takeover");
    } finally {
      await s.close();
    }
  });

  it("gives one Escape exactly one job", async () => {
    // The rail and the takeover both answer to Escape, and `App.tsx` orders them — takeover first,
    // because it sits above the rail. With no takeover up, Escape belongs to the rail.
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      await goToView(s.page, "dashboard");
      await s.page.locator('[data-testid="chrome-wallet-btn"]').click();
      await until(
        async () => (await s.page.locator("aside.rail.rail--open").count()) === 1,
        "the rail to open",
      );

      await s.page.keyboard.press("Escape");
      await until(
        async () => (await s.page.locator("aside.rail.rail--open").count()) === 0,
        "Escape to close the rail",
      );
      // And it did not also change screen on the way past.
      expect(await currentView(s.page)).toBe("dashboard");

      assertNoPageErrors(s, "Escape");
    } finally {
      await s.close();
    }
  });
});
