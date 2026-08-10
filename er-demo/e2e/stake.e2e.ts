// THE STAKE FIELD — the control that once made every sub-$1 amount untypable.
//
// THE INCIDENT. 00-3's amount box was bound straight to `stake` and clamped on EVERY KEYSTROKE.
// `Number("0") || 0.01` takes the fallback, because 0 is falsy — so typing `0.5` snapped to `0.01`
// at the first character and there was no way to reach it left to right. Clearing the box snapped it
// to a cent too, which quietly rewrote a $50 deploy into a one-cent one on a tab-out. The fix
// (`ArenaView.tsx`'s `stakeText` / `editingAmount`) holds half-typed text AS TEXT while the field has
// focus and reconciles it to a number exactly once, on blur.
//
// WHY IT IS HERE AND NOT IN A UNIT TEST. There is no React testing library in this repo, and even
// with one the defect is a keystroke-by-keystroke interaction between a controlled input's `value`
// and the state behind it. Typing `0`, then `.`, then `5` into a real `<input type="number">` in a
// real browser is the only way to observe it — `fill()` would set the value in one shot and sail
// straight past the bug.
//
// THE FIELD ONLY EXISTS WHILE ENTRIES ARE OPEN (`entriesOpen()`, not `phase === "Lobby"`), so every
// test here runs against a held-open lobby.

import { describe, expect, it } from "vitest";
import {
  assertNoPageErrors,
  goToView,
  keeperStates,
  open,
  screenText,
  useBrowser,
  until,
} from "./harness.ts";

/** Empty the field the way a person does, leaving it focused and mid-edit.
 *
 *  `ControlOrMeta+a`, NOT `Control+a`. On macOS Chrome, Ctrl+A in a text field is the Emacs binding
 *  — move to start of line — so `Control+a` followed by Delete forward-deletes ONE character and
 *  leaves the rest of the value behind. That is not a clear, and a helper that half-works turns
 *  every assertion built on it into a coincidence: it was measured doing exactly that here, and the
 *  cap test passed anyway because clamping happened to reach the same answer from `25000`.
 *  The emptiness is asserted rather than assumed for the same reason. */
async function clearField(amount: import("playwright-core").Locator): Promise<void> {
  await amount.click();
  await amount.press("ControlOrMeta+a");
  await amount.press("Delete");
  const left = await amount.inputValue();
  if (left !== "") throw new Error(`e2e: the stake field did not clear — "${left}" is still in it`);
}

describe("the stake amount field", () => {
  const browser = useBrowser();

  it("accepts 0.5 typed one character at a time", async () => {
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      await goToView(s.page, "arena");
      const amount = s.page.locator("#stake-amt");
      await clearField(amount);

      // ONE CHARACTER AT A TIME, AND CHECKED AFTER EACH. The old code failed at the FIRST character:
      // `0` clamped to `0.01` and there was nowhere to go from there. Asserting only the end state
      // would let a future regression that snapped on `0` and recovered on `5` slip through.
      await amount.press("0");
      expect(await amount.inputValue(), "typing 0 snapped the field").toBe("0");
      await amount.press(".");
      await amount.press("5");
      expect(await amount.inputValue(), "0.5 was rewritten while being typed").toBe("0.5");

      // AND THE STAKE BEHIND IT FOLLOWED. The lede prices the amount that would actually be sent, so
      // it is the evidence that `0.5` is the stake and not just what is in the box.
      await until(
        async () => /so \$0\.50 puts/i.test(await screenText(s.page)),
        "the deploy lede to price a $0.50 stake",
      );

      // Blur reconciles once and must not move it.
      await amount.blur();
      expect(await amount.inputValue(), "blur rewrote 0.5").toBe("0.5");
      expect(await screenText(s.page)).toMatch(/so \$0\.50 puts/i);

      assertNoPageErrors(s, "typing 0.5");
    } finally {
      await s.close();
    }
  });

  it("keeps the last good stake when the box is emptied and left", async () => {
    // Tabbing out of a cleared box used to silently rewrite the deploy to the floor. The reconcile
    // falls back to the last good stake instead — which for a fresh panel is its $5 default.
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      await goToView(s.page, "arena");
      const amount = s.page.locator("#stake-amt");
      const before = await amount.inputValue();
      expect(Number(before)).toBeGreaterThan(0);

      await clearField(amount);
      await amount.blur();
      expect(await amount.inputValue(), "an emptied box fell to the floor instead of the last stake").toBe(
        before,
      );

      assertNoPageErrors(s, "emptying the stake field");
    } finally {
      await s.close();
    }
  });

  it("holds the cap the arena enforces", async () => {
    // `STAKE_CAP_USD` is $100 a side and `clampStake` is what keeps the panel from offering more than
    // the program will take. Checked at the boundary and one above it.
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      await goToView(s.page, "arena");
      const amount = s.page.locator("#stake-amt");

      await clearField(amount);
      await amount.pressSequentially("100");
      await amount.blur();
      expect(await amount.inputValue()).toBe("100");

      await clearField(amount);
      await amount.pressSequentially("250");
      await amount.blur();
      expect(await amount.inputValue(), "the field offered more than the per-side cap").toBe("100");

      assertNoPageErrors(s, "the stake cap");
    } finally {
      await s.close();
    }
  });

  it("follows the presets and the Max button", async () => {
    // The presets, the slider and Max all move the canonical stake; the box follows unless it is
    // being edited. That "unless" is the half of the fix that makes the field usable, and it is worth
    // proving the other half still works.
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      await goToView(s.page, "arena");
      const amount = s.page.locator("#stake-amt");

      await s.page.getByRole("button", { name: "$50", exact: true }).first().click();
      await until(async () => (await amount.inputValue()) === "50", "the box to follow the $50 preset");

      await s.page.getByRole("button", { name: "Max", exact: true }).click();
      await until(async () => (await amount.inputValue()) === "100", "the box to follow Max");

      assertNoPageErrors(s, "the presets");
    } finally {
      await s.close();
    }
  });
});
