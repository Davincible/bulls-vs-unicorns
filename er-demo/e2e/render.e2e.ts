// DEFECT #5 — THE PAGE MUST NOT WHITE-SCREEN. Plus the plain fact that all five screens render.
//
// THE INCIDENT, TWICE. A wallet error object reached JSX as a React child and took the whole
// document with it — React unmounts the tree on an uncaught render error, so what a player got was
// not a broken panel but a blank page (`ArenaProvider.tsx` normalises errors to strings at the
// context boundary because of it; `useSessionKeyManager.ts`'s `normalizeGumError` is the other half).
// Nothing in the unit suite can see this: every module involved returns exactly what its test says
// it returns. It is a property of the assembled tree, at runtime, in a browser.
//
// SO THE CHECK IS TWO CLAIMS, NOT ONE, and both are necessary:
//
//   * NO ERRORS — every `console.error` and every uncaught exception is collected and must be empty.
//   * STILL A PAGE — `#v2-root` has children and `main.page` holds real text. An error-free blank
//     page is still a blank page, and a suite that only watched the console would call it green.
//
// EXERCISED ACROSS the five screens, the four phases the fixture reaches, both lineup extremes, a
// phone viewport, the two side-rail tenants, and the takeover opening and closing — because the
// original failure was in a panel, not on a screen, and a screen-only walk would have missed it.

import { describe, expect, it } from "vitest";
import {
  DRAWING_ENDS_SEC,
  FIGHT_ENDS_SEC,
  LOBBY_ENDS_SEC,
  VIEWS,
  assertHermetic,
  assertNoPageErrors,
  assertRendered,
  currentView,
  dismissTakeover,
  goToView,
  keeperStates,
  open,
  useBrowser,
  until,
} from "./harness.ts";

describe("the assembled page", () => {
  const browser = useBrowser();

  it("renders all five screens, in every phase the fixture reaches, with no errors", async () => {
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      const stops: [string, number][] = [
        ["lobby", 0],
        ["drawing", LOBBY_ENDS_SEC + 1],
        ["fight", DRAWING_ENDS_SEC + 5],
        ["settled", FIGHT_ENDS_SEC + 6],
      ];
      let at = 0;
      for (const [phase, second] of stops) {
        if (second > at) {
          await s.jump(second - at);
          at = second;
        }
        for (const view of VIEWS) {
          await goToView(s.page, view);
          expect(await currentView(s.page)).toBe(view);
          await assertRendered(s.page, `${view} in ${phase}`);
          assertNoPageErrors(s, `${view} in ${phase}`);
        }
      }
      assertHermetic(s);
    } finally {
      await s.close();
    }
  });

  it("opens both side-rail tenants without losing the page", async () => {
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      // THE WALLET RAIL IS WHERE THE WHITE-SCREEN CAME FROM. It is the panel that renders whatever
      // the wallet and the session layer are currently saying, which is the one place on this page
      // where an arbitrary error object has ever reached a React child.
      await s.page.locator('[data-testid="chrome-wallet-btn"]').click();
      await until(
        async () => (await s.page.locator('aside.rail[aria-label="Wallet and session"]').count()) === 1,
        "the wallet rail to open",
      );
      await assertRendered(s.page, "with the wallet rail open");
      assertNoPageErrors(s, "the wallet rail");

      // Escape closes it — `useKeyboardNav`'s job, and the rail's own contract.
      await s.page.keyboard.press("Escape");
      await until(
        async () =>
          (await s.page.locator("aside.rail.rail--open").count()) === 0,
        "the wallet rail to close on Escape",
      );

      // The fighter tenant: a roster row on 00-6 swaps the panel's whole contents in place.
      const row = s.page.locator(".row.roster[role='button']").first();
      await row.click();
      await until(
        async () => (await s.page.locator('aside.rail[aria-label="Fighter profile"]').count()) === 1,
        "the fighter rail to open",
      );
      await assertRendered(s.page, "with the fighter rail open");
      assertNoPageErrors(s, "the fighter rail");
      assertHermetic(s);
    } finally {
      await s.close();
    }
  });

  it("survives the takeover being dismissed and reopened", async () => {
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby(), dismissIntro: false });
    try {
      expect(await s.page.locator('[role="dialog"]').count()).toBe(1);
      await assertRendered(s.page, "behind the takeover");
      await dismissTakeover(s.page);
      await assertRendered(s.page, "after dismissing the takeover");

      await s.page.locator('[data-testid="chrome-intro-btn"]').click();
      await until(
        async () => (await s.page.locator('[role="dialog"]').count()) === 1,
        "the takeover to reopen",
      );
      await assertRendered(s.page, "with the takeover reopened");
      assertNoPageErrors(s, "the takeover");
    } finally {
      await s.close();
    }
  });

  it("renders at both ends of the lineup the program allows", async () => {
    // 2 and 48 are `MAX_FIGHTERS`' own bounds (`data/fixtureLineup.ts`). The page had only ever been
    // run at the fixture's hand-written 9; the rosters, the standings and the canvas at the ceiling
    // are what `?fighters=` exists to make reviewable, and nothing was watching them.
    //
    // THE UPPER BOUND MOVED 16 -> 48 AND THIS SWEEP HAD TO MOVE WITH IT, or the test would have gone
    // on rendering a third of the board and calling it "both ends". 16 is kept as the middle point:
    // it is the lineup every deployed round has been fielding, so a regression there is a regression
    // in what is actually live, and it is the only one of the three with existing screenshots.
    for (const lineup of [2, 16, 48]) {
      const s = await open(browser(), {
        query: `fixture=1&fighters=${lineup}`,
        keeper: keeperStates.heldOpenLobby(),
      });
      try {
        for (const view of VIEWS) {
          await goToView(s.page, view);
          await assertRendered(s.page, `${view} at ${lineup} fighters`);
        }
        // Through a fight as well: the canvas lays out and the rosters re-sort at both extremes.
        await s.jump(DRAWING_ENDS_SEC + 5);
        await goToView(s.page, "arena");
        await assertRendered(s.page, `the fight at ${lineup} fighters`);
        assertNoPageErrors(s, `${lineup} fighters`);
        assertHermetic(s);
      } finally {
        await s.close();
      }
    }
  });

  it("renders on a phone-sized viewport", async () => {
    // 390x844 is the width the dock audit was run at — the one where a 320px floating panel stopped
    // being a corner and became a blindfold. What is checked here is only that the page survives it;
    // what the dock COVERS at that width is a layout judgement no assertion can make honestly.
    const s = await open(browser(), {
      keeper: keeperStates.heldOpenLobby(),
      viewport: { width: 390, height: 844 },
    });
    try {
      for (const view of VIEWS) {
        await goToView(s.page, view);
        await assertRendered(s.page, `${view} at 390px`);
      }
      assertNoPageErrors(s, "the phone viewport");
      assertHermetic(s);
    } finally {
      await s.close();
    }
  });

  it("touches nothing but its own origin", async () => {
    // `?fixture=1` says it serves the fixture "and touches the network for nothing at all". The only
    // request that leaves the bundle is the keeper's status file, which is same-origin by default
    // (`KEEPER_STATUS_URL`). This is that claim, checked rather than assumed — and it is what stops
    // this suite quietly acquiring a devnet dependency.
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      await s.jump(FIGHT_ENDS_SEC + 6);
      for (const view of VIEWS) await goToView(s.page, view);
      assertHermetic(s);
      expect(s.requests.length, "the page requested nothing at all").toBeGreaterThan(0);
      assertNoPageErrors(s, "the hermetic walk");
    } finally {
      await s.close();
    }
  });
});
