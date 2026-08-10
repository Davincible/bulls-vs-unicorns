#!/usr/bin/env bun
// THE ROUND CLOCK, PHOTOGRAPHED IN EVERY PHASE, AT THE LINEUP THAT ACTUALLY BINDS.
//
//   cd er-demo && npx vite build && bun scripts/shoot-clock.ts
//
// WHY THIS EXISTS. The clock is the largest figure on the page and most of it is PAINTED — the
// watermark row in `arena/scoreboard.ts` has no DOM, no accessible name and nothing a suite can
// query, so `e2e/clock.e2e.ts` can only assert against the `.sr` text alternative beside the canvas.
// Everything the assertions cannot reach — whether a 20px countdown survives 44 fighters standing on
// it, whether a tracked `ENDING` reads as a word rather than as a smear, whether the caption under
// the hero clock fits the column it was given — is a LOOKING question, and the only honest way to
// answer it is to look.
//
// WHY 44 FIGHTERS. `CLOCK_RANGE`'s 20px floor binds on a phone, and the alpha this row is drawn at
// was tuned against exactly that frame (see `CLOCK_ALPHA`): 390x844 with the field full. 44 is also
// what the production round runs at, and it is where `finalCursor(n) = 360n` produces the 15,840 that
// started this change.
//
// WHAT THESE IMAGES ARE. The FIXTURE (`?fixture=1`), not a live round — deterministic money,
// deterministic lineup, a faked wall clock so the phases can be reached in order and photographed at
// a chosen second. Nothing here is a devnet capture and none of it should be shown as one.

import { mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
// THE SUITE'S OWN KEEPER FIXTURES, NOT A SECOND COPY OF THEM. `keeper-status.json` is a four-field
// schema with a heartbeat, a chain block and a round block, and a hand-written approximation of it
// would fall to `no-keeper` on the first field it got wrong — which is a DIFFERENT cadence, with a
// different clock, quietly photographed under the right filename. Importing means a screenshot of the
// held-open lobby is a screenshot of the state `e2e/clock.e2e.ts` asserts on.
import { T0, keeperStates } from "../e2e/harness.ts";

const BASE = process.env.SHOOT_BASE_URL ?? "http://localhost:5299";
const OUT = process.env.SHOOT_OUT ?? "design/clock";

/** The fixture's own timeline (`data/useFixtureRound.ts`): Lobby 0-8s, Drawing 8-10s, Fight from 10s.
 *  Mirrored rather than imported for the same reason `e2e/harness.ts` mirrors it — a script that
 *  imported the app's clock would be asserting against itself. */
const LOBBY_ENDS = 8;
const DRAWING_ENDS = 10;

// `T0` — the frozen start — comes from the harness too, and it is not a stylistic import. Two of the
// keeper fixtures publish ABSOLUTE instants (`entriesCloseAt = T0_SEC + n`), so a script that faked
// its own epoch would hand the page a deadline decades out and photograph a six-digit countdown under
// a filename claiming it was a lobby closing in forty seconds. Measured, when this file did exactly
// that: `545760:37`.

interface Shot {
  /** File stem — `{name}-{device}.png`. */
  name: string;
  /** Seconds to fast-forward past load before the shutter. */
  at: number;
  /** What this frame is supposed to show, printed beside the reading it produced. */
  expect: string;
  /** The keeper's published status, or null for "no keeper is running" (404). */
  keeper?: unknown;
}

const SHOTS: Shot[] = [
  {
    name: "1-lobby-held-open",
    at: 2,
    expect: "OPEN, never 0:00",
    keeper: keeperStates.heldOpenLobby(),
  },
  {
    name: "2-lobby-closing",
    at: 2,
    expect: "a real deadline, counting down",
    keeper: keeperStates.closingLobby(40),
  },
  { name: "3-drawing", at: LOBBY_ENDS + 1, expect: "no clock at all" },
  { name: "4-fight-early", at: DRAWING_ENDS + 4, expect: "the bell, counting down from ~2:56" },
  { name: "5-fight-late", at: DRAWING_ENDS + 70, expect: "the bell, well down" },
  // THE TAIL, SAMPLED RATHER THAN AIMED AT. `ENDING` needs a round that is settleable and not yet
  // settled, and the fixture goes Settled on its own last hit event — so whether that window is
  // reachable at all is a property of the replay and not something a script can arrange. These four
  // walk the last twenty seconds looking for it; if none of them lands on it, the state is held by
  // `roundPhaseCopy.test.ts` and photographed nowhere, which is worth knowing either way.
  { name: "6-fight-tail-160", at: DRAWING_ENDS + 160, expect: "0:20, or ENDING if wiped out" },
  { name: "7-fight-tail-172", at: DRAWING_ENDS + 172, expect: "0:08, or ENDING if wiped out" },
  { name: "8-fight-tail-179", at: DRAWING_ENDS + 179, expect: "0:01, or ENDING — never 0:00" },
  { name: "9-settled", at: DRAWING_ENDS + 200, expect: "the length the fight ran, static" },
];

const DEVICES = [
  { device: "desktop", viewport: { width: 1440, height: 950 } },
  // THE WIDTH WHERE THE HERO IS TIGHTEST, and it is neither of the other two. `.hero` is
  // `grid-template-columns: 1fr auto`, so the clock's column is sized to its widest row — which is now
  // the caption, not the phase word — and the pot takes what is left. A desktop has slack and a phone
  // has stacked the two, so a tablet is the only width at which the caption and a five-figure pot are
  // actually competing for the same line.
  { device: "tablet", viewport: { width: 768, height: 1024 } },
  { device: "phone", viewport: { width: 390, height: 844 } },
];

/** Every clock slot on the page, as text — the same query `e2e/clock.e2e.ts` runs, so a reading
 *  printed here and an assertion over there cannot be about different elements. */
async function slots(page: Page): Promise<string[]> {
  return await page.locator('[data-testid="round-clock"]').allInnerTexts();
}

async function shoot(browser: Browser, shot: Shot, device: (typeof DEVICES)[number]): Promise<void> {
  const context = await browser.newContext({ viewport: device.viewport });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  // WHICH resource, not just that one failed. A bare "Failed to load resource: 404" is unactionable
  // and is exactly what this script printed on its first run; the URL turns it into either a defect
  // or a known absence in one reading.
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });

  // Before `goto`: the keeper is polled from an effect on the first commit, and `data/flags.ts` reads
  // the query string at module load.
  await page.route("**/keeper-status.json", (route) =>
    shot.keeper === undefined
      ? route.fulfill({ status: 404, contentType: "text/plain", body: "no keeper here" })
      : route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(shot.keeper),
        }),
  );
  await page.clock.install({ time: new Date(T0) });
  await page.goto(`${BASE}/?fixture=1&fighters=44`, { waitUntil: "load", timeout: 30_000 });
  await page.waitForSelector(".chrome--top", { timeout: 30_000 });

  const dialog = page.locator('[role="dialog"]');
  if ((await dialog.count()) > 0) await page.getByRole("button", { name: /let.?s go/i }).click();

  // THE LAST SECOND IS RUN, NOT JUMPED, AND THE JUMP IS SHORT BY THAT SECOND. `fastForward` moves the
  // clock without firing the intervals it skipped, so the canvas loop and `useSecondTick` need real
  // ticks to repaint against the new time — but a `runFor` ON TOP of the full jump lands one second
  // PAST the mark, which is how this script's first run photographed a FIGHT under the filename
  // `drawing` (9s intended, 10s taken, and Drawing ends at 10).
  await page.clock.fastForward(Math.max(0, shot.at - 1) * 1000);
  await page.clock.runFor(1000);
  await page.waitForTimeout(600);

  const file = `${OUT}/${shot.name}-${device.device}.png`;
  await page.screenshot({ path: file, fullPage: false });
  // AND THE FIELD ON ITS OWN, because on a phone the frame is below the fold and the watermark clock
  // is the whole reason this script exists. A viewport shot of a 390px page shows the hero and stops;
  // the row that had to be re-tuned for 44 fighters at a 20px floor would never appear in it.
  const frame = page.locator(".frame").first();
  if ((await frame.count()) > 0) {
    await frame.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await frame.screenshot({ path: `${OUT}/${shot.name}-${device.device}-field.png` });
  }
  const reading = (await slots(page)).join(" / ");
  const phase = await page.locator(".hero-phase").first().innerText();
  console.log(
    `${file.padEnd(46)} ${phase.padEnd(9)} slots [${reading}]  — expected ${shot.expect}` +
      (errors.length > 0 ? `\n    PAGE ERRORS: ${errors.join(" | ")}` : ""),
  );
  await context.close();
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
mkdirSync(OUT, { recursive: true });
for (const device of DEVICES) {
  for (const shot of SHOTS) await shoot(browser, shot, device);
}
await browser.close();
