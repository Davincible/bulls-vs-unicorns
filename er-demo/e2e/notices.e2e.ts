// THE HOUSE-ROUNDS DISCLOSURE — the one notice on this page that is a statement about the OPERATOR
// rather than about the data, and the only thing in this suite that asserts on a banner at all.
//
// WHY IT NEEDS AN E2E AND NOT ONLY A UNIT TEST, which is the standing question for anything added
// here. `keeperStatus.test.ts` holds the field: it parses, it round-trips, it rejects a v5 file, and
// it cannot be got from a fighter count. None of that says the SENTENCE REACHES A VISITOR. The
// disclosure only does its job if it is on the page a stranger opens, and every part of that journey
// — the keeper feed polling, the context provider, a component that renders `null` for three
// different reasons — lives outside the module that decides the fact. That gap is precisely the one
// this suite exists for: a decision that was already right in a module and absent on the assembled
// page.
//
// AND THE FAILURE IS SILENT IN THE DIRECTION THAT MATTERS. A disclosure that stops rendering does not
// throw, does not fail to build and does not change a number; the page simply goes quiet about
// something it is supposed to say, and looks perfectly healthy doing it. Nothing but an assertion
// that the words are on screen catches that.

import { describe, expect, it } from "vitest";
import {
  VIEWS,
  assertHermetic,
  assertNoPageErrors,
  clockSlots,
  goToView,
  keeperStates,
  open,
  useBrowser,
  until,
} from "./harness.ts";

const NOTICE = '[data-testid="house-rounds-notice"]';

describe("the house-rounds disclosure", () => {
  const browser = useBrowser();

  it("is on screen whenever the keeper says it is running rounds against itself", async () => {
    const s = await open(browser(), { keeper: keeperStates.houseOnlyRounds() });
    try {
      const banner = s.page.locator(NOTICE);
      // `until` from Node, never `waitForSelector`: every timer inside the page is faked, including
      // the `requestAnimationFrame` Playwright's own selector poller runs on, and the status arrives
      // from a fetch on the first commit so the banner is one render behind the shell. See the
      // harness header — waiting in this suite is always a Node-side poll on an observable condition.
      await until(async () => (await banner.count()) === 1, "the house-rounds banner to appear");

      const text = (await banner.innerText()).replace(/\s+/g, " ");
      // THE TWO CLAIMS THE COPY EXISTS TO MAKE, checked by their load-bearing phrases rather than by
      // pinning the paragraph: that the operator is filling rounds with its own wallets, and that a
      // full lobby is therefore not evidence of anything. A test that matched the whole sentence
      // would fail on every improvement to it and teach the next person that it is noise.
      expect(text).toMatch(/its own wallets/i);
      expect(text).toMatch(/not a crowd/i);

      // AND THE CLAIM IT MUST NOT MAKE. The flag is a fact about the keeper's MODE and never about
      // the round on screen — a real player can enter at any moment — so any wording that calls the
      // fighters below bots would be false on exactly the rounds that matter most. Asserted as an
      // absence because that is the regression a well-meaning edit would introduce.
      expect(text).not.toMatch(/\bbots?\b/i);
      expect(text).not.toMatch(/these fighters/i);
    } finally {
      assertNoPageErrors(s, "the house-rounds banner");
      assertHermetic(s);
      await s.close();
    }
  });

  it("stays on every screen, because the mode does not change when the reader navigates", async () => {
    // The notice is rendered by the shell rather than by a view, which is what makes this true — and
    // is also exactly the sort of thing a later refactor moves into `ArenaView` without noticing that
    // four screens then stop disclosing anything.
    const s = await open(browser(), { keeper: keeperStates.houseOnlyRounds() });
    try {
      await until(
        async () => (await s.page.locator(NOTICE).count()) === 1,
        "the house-rounds banner to appear",
      );
      for (const view of VIEWS) {
        await goToView(s.page, view);
        expect(await s.page.locator(NOTICE).count(), view).toBe(1);
      }
    } finally {
      assertNoPageErrors(s, "the house-rounds banner across screens");
      await s.close();
    }
  });

  it("says nothing when the keeper is running ordinary rounds, or is not there at all", async () => {
    // THE HALF THAT KEEPS THE TEST ABOVE HONEST. A banner rendered unconditionally would pass every
    // assertion in this file and disclose nothing — it would be a permanent line of prose that is
    // false most of the time, which is worse than saying nothing. Both off states are checked: a
    // keeper publishing `houseOnlyRounds: false`, and no keeper publishing at all (a 404, which is
    // the normal response where none has ever run).
    for (const keeper of [keeperStates.heldOpenLobby(), null]) {
      const s = await open(browser(), { keeper });
      try {
        // WAITED FOR THE STATUS TO HAVE LANDED, not merely for the page to exist, because an absence
        // asserted one render too early is an absence that would hold whatever the file said. A
        // held-open lobby drives every clock slot to the word OPEN (`clock.e2e.ts` owns that rule),
        // and that word can only come from a status this page has fetched and parsed — so it is proof
        // the feed arrived and the banner is missing on purpose.
        //
        // The 404 case has no such signal by construction: nothing publishes, so nothing changes on
        // screen, and what is checked there is the weaker claim that a page with no keeper never grows
        // this banner. The `.banner--quiet` wait is what makes it non-vacuous — the fixture notice
        // comes out of the same `Notices` block, so the block has rendered.
        if (keeper === null) {
          await until(
            async () => (await s.page.locator(".banner--quiet").count()) >= 1,
            "the fixture banner, which proves the notices block has rendered",
          );
        } else {
          await until(
            async () => {
              // `length > 0` as well as `every`, because `every` over an empty list is true and the
              // list is empty for exactly as long as the page has not rendered its clocks — which
              // would make this wait return before the thing it is waiting for.
              const slots = await clockSlots(s.page);
              return slots.length > 0 && slots.every((slot) => slot === "OPEN");
            },
            "the held-open keeper's status to reach the page",
          );
        }
        expect(await s.page.locator(NOTICE).count(), String(keeper === null)).toBe(0);
      } finally {
        // NOT ASKED OF THE 404 CASE, and that is the harness's own rule rather than a concession.
        // "No keeper has ever run here" is served as a 404, which Chrome reports as a failed resource
        // load on the console — so the collector holds one error for a page behaving exactly as
        // designed. Asserting it away here would mean asserting that the normal state is an error;
        // the publishing case still gets the full check, which is where a genuine render fault would
        // show up.
        if (keeper !== null) assertNoPageErrors(s, "the page without a house-rounds banner");
        await s.close();
      }
    }
  });
});
