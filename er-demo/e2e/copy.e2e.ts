// DEFECTS #2, #3 AND #4 — three ways a page can state more than its data supports.
//
//   #2  FOUR SCREENS SAID "ALL TIME" over a windowed log. `history.rounds` is the newest N round
//       accounts and short a round wherever a read failed; every aggregate on 01, 02, 04 and the
//       rail is computed over that window, and all four captioned it "all-time". `LogCoverage` and
//       `views/coverage.ts` are the fix.
//
//   #3  THE INTRO OVERLAY SAID 0.20% WHILE THE CHAIN CHARGED 1.00%. The rate was a build-time
//       constant; devnet's `set_fee_bps` moved it mid-session and the first thing a new player read
//       was a fifth of what they were about to be charged. `views/feeCopy.ts` is the fix, and six
//       surfaces render it.
//
//   #4  "1 FIGHTERS" REACHED PRODUCTION — a count stapled to a hard-coded plural. `counted()` in
//       `contract.ts` is the fix.
//
// WHAT A UNIT TEST ALREADY DOES, AND WHERE IT STOPS. `coverage.test.ts`, `feeCopy.test.ts` and
// `contract.test.ts` hold all three functions and hold them well — including the branches this file
// cannot reach. What they cannot hold is whether a SURFACE calls them. Every one of these three
// defects was a surface printing its own string beside a module that already knew better, and that
// is the only thing checked here.
//
// ── WHAT THIS FILE HONESTLY DOES NOT COVER, stated because a green suite that proves less than it
//    looks like is the failure mode this repo cares most about avoiding ───────────────────────────
//
//   * THE WINDOWED COVERAGE BRANCH. The fixture's log is `MOCK_HISTORY` held against
//     `BigInt(MOCK_HISTORY.length)` (`useFixtureArena.ts`), so `logCoverage.complete` is TRUE and the
//     fixture is the one page on which "all time" is a claim that can be backed. There is no flag
//     that makes it incomplete, and the chain path is out of scope. So what is checked below is that
//     the wording is DERIVED — every caption states the log's actual size and that size matches the
//     log — not that the incomplete branch words itself correctly. `coverage.test.ts` owns that.
//
//   * A COUNT OF ONE, WHICH MEANS THIS FILE WOULD NOT HAVE CAUGHT "1 FIGHTERS" ITSELF. `?fighters=`
//     is clamped to the program's own 2..16 (`fixtureLineup.ts`), and every other `counted()` call
//     site was driven and read: across all fifteen lineups the app accepts, the smallest count any
//     of them renders is 2 (04-1's "your rounds" bottoms out at 2, at `?fighters=13`). So the
//     singular branch is unreachable from a browser and `contract.test.ts` is the only thing that
//     can hold it. What this file does instead is prove the count is DERIVED from the lineup rather
//     than stapled to it, and hold a standing agreement net over every `N <noun>` pair the page does
//     render — which is what found the leaderboard's "1 of 2 FIGHTER is ours" (`LeaderboardView.tsx`),
//     a live instance of the same class of defect, at `?fighters=2`.

import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import {
  VIEWS,
  assertNoPageErrors,
  goToView,
  keeperStates,
  open,
  screenText,
  useBrowser,
  until,
} from "./harness.ts";

/** The fixture's arena charges 20bps. The build's PRE-READ FALLBACK (`contract.ts#FEE_BPS`) is 100 —
 *  a different number, deliberately used here: any surface that reverted to quoting the constant, or
 *  to a literal, would render `1%` where the supplied rate is `0.2%`, and the two are distinguishable
 *  by inspection. That divergence is the whole reason this test can tell a wired surface from a
 *  hard-coded one. */
const FIXTURE_FEE = "0.2%";
const BUILD_FALLBACK_FEE = "1%";

/** The fixture's invented log: sixteen rounds, and every round this invented arena ever ran. */
const LOG_ROUNDS = 16;

describe("what the page claims", () => {
  const browser = useBrowser();

  // ── #3 — the entry rate ──────────────────────────────────────────────────────────────────────

  it("quotes the supplied entry rate on every surface that states one, and never the build constant", async () => {
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby(), dismissIntro: false });
    try {
      const found: Record<string, string> = {};

      // 1. THE TAKEOVER — the surface the incident happened on, and the first thing a player reads.
      const intro = await s.page.locator(".overlay-body").innerText();
      found["takeover"] = extractRate(intro, /the arena deducts\s+([\d.]+%)/i, "takeover");
      await s.page.getByRole("button", { name: /let.?s go/i }).click();

      // 2. 00-3's lede, on the deploy control itself.
      await goToView(s.page, "arena");
      const arena = await screenText(s.page);
      found["deploy lede"] = extractRate(arena, /The arena deducts\s+([\d.]+%)\s+on entry/i, "00-3");

      // 3. The dock's price line, beside the button that incurs it.
      const dockFee = await s.page.locator(".dock-fee").first().innerText();
      found["dock"] = extractRate(dockFee, /·\s*([\d.]+%)\s*fee/i, "the dock");

      // 4. The dashboard's standalone figure.
      await goToView(s.page, "dashboard");
      found["dashboard tile"] = await figureBesideLabel(s.page, "Fee at the door");

      // 5 and 6. The referrals screen states it as a figure and inside two sentences.
      await goToView(s.page, "referrals");
      found["referrals tile"] = await figureBesideLabel(s.page, "House fee · per deploy");
      const referrals = await screenText(s.page);
      found["referrals terms"] = extractRate(
        referrals,
        /The house takes\s+([\d.]+%)\s+of every deploy/i,
        "03-3.1",
      );

      // ALL SIX AGREE, AND ALL SIX AGREE WITH THE SUPPLIED RATE. Six independently-written hedges is
      // exactly how one of them ended up stating the fallback flat.
      expect(found).toEqual({
        takeover: FIXTURE_FEE,
        "deploy lede": FIXTURE_FEE,
        dock: FIXTURE_FEE,
        "dashboard tile": FIXTURE_FEE,
        "referrals tile": FIXTURE_FEE,
        "referrals terms": FIXTURE_FEE,
      });
      expect(Object.values(found)).not.toContain(BUILD_FALLBACK_FEE);

      assertNoPageErrors(s, "the fee surfaces");
    } finally {
      await s.close();
    }
  });

  it("prices the referral example from the rate rather than restating it", async () => {
    // ITS PREDECESSOR WAS TWO MODULE CONSTANTS folded against `FEE_BPS` at build time, under a
    // comment that spelled the answer out in prose — already wrong by the time anyone read it. The
    // arithmetic is 10% of 0.2% of a $100 deploy = $0.02, and it is checked here rather than
    // asserted as a string so that a rate change would have to move the figure with it.
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      await goToView(s.page, "referrals");
      const text = await screenText(s.page);
      const m = text.match(
        /(\d+)% of a ([\d.]+)% fee is \$([\d.]+) on a \$([\d,]+) deploy/i,
      );
      expect(m, `the referrals worked example did not render:\n${text.slice(0, 600)}`).not.toBeNull();
      const [, sharePct, feePct, shareUsd, deployUsd] = m as RegExpMatchArray;
      const expected = (Number(deployUsd.replace(/,/g, "")) * (Number(feePct) / 100)) * (Number(sharePct) / 100);
      expect(Number(shareUsd)).toBeCloseTo(expected, 2);
      expect(`${feePct}%`).toBe(FIXTURE_FEE);
      assertNoPageErrors(s, "the referral example");
    } finally {
      await s.close();
    }
  });

  // ── #2 — what the aggregates cover ───────────────────────────────────────────────────────────

  it("captions every aggregate with the log's actual size, on all four screens that carry one", async () => {
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      // THE DENOMINATOR, ESTABLISHED FROM THE PAGE'S OWN TABLE FIRST — not from a constant in this
      // file. 04-2 lists one row per logged round; that count is what every caption has to agree
      // with, and holding the captions against it is what makes this a check rather than a restating.
      await goToView(s.page, "history");
      const history = await screenText(s.page);
      const rowsInLog = [...history.matchAll(/\b\d+ PLAYED\b/gi)].length;
      expect(rowsInLog, "04-2 listed no rounds at all").toBe(LOG_ROUNDS);

      // Every screen that states the figure states the same one.
      const figures: Record<string, string> = {
        history: await figureBesideLabel(s.page, "Rounds logged"),
      };
      await goToView(s.page, "leaderboard");
      figures["leaderboard"] = await figureBesideLabel(s.page, "Rounds logged");
      await goToView(s.page, "dashboard");
      figures["dashboard"] = await figureBesideLabel(s.page, "Rounds logged");
      expect(figures).toEqual({
        history: String(rowsInLog),
        leaderboard: String(rowsInLog),
        dashboard: String(rowsInLog),
      });

      // AND EVERY CAPTION NAMES IT. This is the assertion that would have caught the incident: the
      // four screens that said "all time" said it as a bare phrase with NO NUMBER IN IT, because
      // there was no number to say — a constant string cannot state the size of a window. Both
      // wordings `coveragePhrase` can produce are accepted ("across all N rounds…" when the log is
      // complete, "across the newest N of M rounds…" when it is not); what is not accepted is a
      // caption with no count in it at all.
      const COVERAGE = /ACROSS (?:ALL )?(?:THE NEWEST )?([\d,]+)[^.\n]*?ROUNDS?/gi;
      const captions: string[] = [];

      /** Scan whatever is on screen, require at least one caption, and hold each against the log. */
      const scan = async (where: string, text: string, atLeast = 1) => {
        const found = [...text.matchAll(COVERAGE)];
        expect(
          found.length,
          `${where} carries no coverage caption — this is where "all-time" used to be`,
        ).toBeGreaterThanOrEqual(atLeast);
        for (const c of found) {
          expect(Number(c[1].replace(/,/g, "")), `${where}: "${c[0]}"`).toBe(rowsInLog);
          captions.push(`${where}: ${c[0]}`);
        }
      };

      // 01 — BEHIND ITS TABS. The two boards computed off the log carry the caption; "This round" is
      // read off the round account and correctly carries none, which is why each tab is asked
      // separately rather than the screen being scanned once with the default tab showing.
      await goToView(s.page, "leaderboard");
      for (const tab of ["Standings", "Hall of fame"]) {
        await s.page.getByRole("tab", { name: tab }).click();
        await scan(`leaderboard/${tab}`, await screenText(s.page));
      }

      // 02 — the dashboard captions several figures with it; the module's own note says eight.
      await goToView(s.page, "dashboard");
      await scan("dashboard", await screenText(s.page), 4);

      // 04 — the history screen states the same fact in its own words (`counted(logged, "round")`),
      // not through `coveragePhrase`, so it gets its own pattern rather than being excused.
      await goToView(s.page, "history");
      const historyClaim = (await screenText(s.page)).match(/([\d,]+) ROUNDS? IN ALL/i);
      expect(historyClaim, "04's lede does not say how many rounds are in the log").not.toBeNull();
      expect(Number((historyClaim as RegExpMatchArray)[1].replace(/,/g, ""))).toBe(rowsInLog);
      captions.push(`history: ${(historyClaim as RegExpMatchArray)[0]}`);

      // THE FOURTH SURFACE, and the last one to still be claiming "all time" over a window: the
      // fighter rail's "Your record" block, which is where a player reads their OWN numbers.
      await goToView(s.page, "arena");
      await s.page.locator(".row.roster[role='button']").first().click();
      await until(
        async () => (await s.page.locator('aside.rail[aria-label="Fighter profile"]').count()) === 1,
        "the fighter rail to open",
      );
      await scan("fighter rail", await s.page.locator("aside.rail").innerText());

      // Non-vacuity: this test is a scan, and a scan that matched nothing would pass silently.
      expect(captions.length, `only found: ${captions.join(" | ")}`).toBeGreaterThanOrEqual(8);

      assertNoPageErrors(s, "the coverage captions");
    } finally {
      await s.close();
    }
  });

  // ── #4 — counts and their nouns ──────────────────────────────────────────────────────────────

  it("derives the fighter count from the lineup rather than stapling it, and pluralises with it", async () => {
    for (const lineup of [2, 16]) {
      const s = await open(browser(), {
        query: `fixture=1&fighters=${lineup}`,
        keeper: keeperStates.heldOpenLobby(),
      });
      try {
        await goToView(s.page, "arena");
        const arena = await screenText(s.page);
        // 00-1's hero — the line `counted()` was introduced for.
        const hero = arena.match(/POT ON THE TABLE · (\d+) (FIGHTERS?)/i);
        expect(hero, `00-1's hero line did not render:\n${arena.slice(0, 400)}`).not.toBeNull();
        const [, heroCount, heroNoun] = hero as RegExpMatchArray;
        expect(Number(heroCount), "the hero ignored ?fighters=").toBe(lineup);
        expect(heroNoun.toLowerCase()).toBe(lineup === 1 ? "fighter" : "fighters");

        // 02-1 says the same thing from its own aggregate — two surfaces, one fact.
        await goToView(s.page, "dashboard");
        const dash = await screenText(s.page);
        const across = dash.match(/ACROSS (\d+) (FIGHTERS?)/i);
        expect(across, "02-1's caption did not render").not.toBeNull();
        expect(Number((across as RegExpMatchArray)[1])).toBe(lineup);
        expect((across as RegExpMatchArray)[2].toLowerCase()).toBe("fighters");

        assertNoPageErrors(s, `${lineup} fighters`);
      } finally {
        await s.close();
      }
    }
  });

  it("agrees between every count and its noun, everywhere on the page, at every lineup", async () => {
    // THE STANDING NET, and it is not a reproduction of "1 FIGHTERS" — see this file's header for
    // why that exact instance is unreachable from the fixture. It is the RULE that instance broke,
    // applied to every `N <noun>` pair the five screens render.
    //
    // RUN AT EVERY LINEUP, WHICH IS THE HALF THAT EARNS IT. At the fixture's default 9 there is
    // nothing to find; at `?fighters=2` the leaderboard's house sentence rendered "1 of 2 FIGHTER
    // is ours", because the noun and the verb were both keyed to the numerator when only the verb
    // belongs to it. That is a live defect this net caught the first time it was pointed at the
    // right state, and it is why the loop below walks the bounds rather than the default.
    const nouns = new Set([
      "fighter", "fighters", "round", "rounds", "player", "players",
      "step", "steps", "exchange", "exchanges", "win", "wins",
    ]);
    const checked: string[] = [];
    const wrong: string[] = [];

    for (const lineup of [null, 2, 3, 16]) {
      const s = await open(browser(), {
        query: lineup === null ? "fixture=1" : `fixture=1&fighters=${lineup}`,
        keeper: keeperStates.heldOpenLobby(),
      });
      try {
        const at = lineup === null ? "default" : `${lineup} fighters`;
        for (const view of VIEWS) {
          await goToView(s.page, view);
          const text = await screenText(s.page);
          // `(?<![$\d])` keeps `$100 deploy`-shaped prices out, and requiring the number to START
          // with a digit stops a bare separator matching — `,` used to match `hash(seed, step)`.
          for (const m of text.matchAll(/(?<![$\d])\b(\d[\d,]*)[^\S\n]+([A-Za-z]+)\b/g)) {
            const noun = m[2].toLowerCase();
            // THE NOUNS THIS PAGE COUNTS THINGS IN. A closed list rather than "any word after a
            // number": `$100 deploy` and `18 steps/sec` are adjectival, not counts, and a net that
            // flagged them would be switched off within a week.
            if (!nouns.has(noun)) continue;
            const n = Number(m[1].replace(/,/g, ""));
            const singular = !noun.endsWith("s");
            checked.push(`${at}/${view}: ${m[0]}`);
            if ((n === 1) !== singular) wrong.push(`${at}/${view}: "${m[0]}"`);
          }
        }
        assertNoPageErrors(s, `the plural scan at ${at}`);
      } finally {
        await s.close();
      }
    }

    expect(wrong, "a count disagreed with its noun").toEqual([]);
    // NON-VACUITY. A scan is only worth the pairs it actually saw, and a refactor that emptied these
    // screens would otherwise turn this green by finding nothing to disagree with. ~68 pairs are
    // matched across the four lineups today; the floor is set well under that so ordinary copy edits
    // do not trip it, and well over zero so an empty scan cannot pass.
    //
    // WHICH DIRECTION IS EXERCISED, PLAINLY: every pair reached here has n > 1, so what is proven is
    // that a plural count keeps a plural noun — which is the half that caught the leaderboard's
    // "1 of 2 FIGHTER". The n === 1 half is checked on every pair too and has nothing to check,
    // because no surface on the fixture page renders a count of one: measured by driving every
    // lineup the app accepts (`?fighters=2` … `16`) and reading every screen, the smallest count any
    // `counted()` call site produces is 2. `contract.test.ts` owns `counted(1, …)`.
    expect(checked.length, "the plural scan matched nothing at all").toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------------------------

function extractRate(text: string, pattern: RegExp, where: string): string {
  const m = text.match(pattern);
  if (m === null) {
    throw new Error(`e2e: no fee rate found on ${where}. Text was:\n${text.slice(0, 800)}`);
  }
  return m[1];
}

/**
 * The figure rendered against a label, in whichever of the page's THREE label/value shapes carries
 * it. Written against the real markup rather than as one fuzzy text walk, because a fuzzy walk that
 * silently matches the wrong element is how a copy test starts asserting about a different number.
 *
 *   `.kv`     — `primitives.tsx`. Value FIRST, label second (`.kv-v` / `.kv-n`).
 *   `.sc-fx`  — `DashboardView.tsx`. Label first, value second, an optional note third.
 *   `.u`      — an inline `Label · <span class="u--ink">figure</span>` metadata line.
 *
 * Throws with the labels it did find, so a renamed label fails as a rename rather than as a null.
 */
async function figureBesideLabel(page: Page, label: string): Promise<string> {
  const found = await page.evaluate((wanted: string) => {
    const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const want = norm(wanted);
    const labels: string[] = [];

    const pairs: [string, string, string][] = [
      [".kv", ".kv-n", ".kv-v"],
      [".sc-fx", ".sc-fx-n", ".sc-fx-v"],
    ];
    for (const [container, nameSel, valueSel] of pairs) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(container))) {
        const name = norm(el.querySelector<HTMLElement>(nameSel)?.textContent);
        if (name === "") continue;
        labels.push(name);
        if (name === want) return { value: norm(el.querySelector<HTMLElement>(valueSel)?.textContent) };
      }
    }

    // The inline metadata line: the label is loose text and the figure is the `.u--ink` child.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("span.u"))) {
      const ink = el.querySelector<HTMLElement>(".u--ink");
      if (ink === null) continue;
      const whole = norm(el.textContent);
      const value = norm(ink.textContent);
      const name = whole.slice(0, whole.length - value.length).replace(/[·:\s]+$/, "");
      labels.push(name);
      if (name === want) return { value };
    }

    return { labels };
  }, label);

  if (found.value === undefined) {
    throw new Error(
      `e2e: no figure found beside the label "${label}". Labels on screen: ${(found.labels ?? []).join(", ")}`,
    );
  }
  return found.value;
}
