// THE E2E HARNESS — one production build, one static server, one real Chrome, and a clock the test
// owns rather than waits on.
//
// WHAT THIS SUITE IS FOR, AND WHY IT IS NOT MORE UNIT TESTS. There are 1431 of those and they cover
// the decisions: `roundPhaseCopy.ts` decides what a clock slot holds, `coverage.ts` decides how a
// window is worded, `feeCopy.ts` decides how a rate is stated, `contract.ts#counted` decides a
// plural. Every one of the defects this suite is written against was a decision that was ALREADY
// RIGHT in a module and WRONG on the assembled page — a surface that never called the module, or
// called it and printed something else beside it. That gap is invisible to a unit test by
// construction, and it is the only thing in here.
//
// ── THE THREE RULES THIS FILE EXISTS TO ENFORCE ───────────────────────────────────────────────
//
// 1. NO WALL CLOCK. The fixture round is a real state machine on a real timer: Lobby for 8s,
//    Drawing for 2s, then a ~94s fight (`useFixtureRound.ts`). Sleeping through that would be two
//    minutes per phase-walk and would still be a race. `page.clock` (Playwright's fake timers)
//    replaces `Date`, `setTimeout`, `setInterval` and `requestAnimationFrame` inside the page, so a
//    test STEPS the round from Lobby to Settled in milliseconds and knows exactly where it is. The
//    page's own second-tick, the fixture's 250ms clock and the keeper poll are all driven by it.
//
//    Consequence, and it is the reason `waitForTimeout` appears nowhere in this suite: every timer
//    inside the page is frozen, so a sleep would advance nothing and `page.waitForFunction`'s
//    polling — which is itself a page timer — would never fire. Waiting is done by `until()` below,
//    from Node, on an OBSERVABLE CONDITION. There is no "sleep and hope" anywhere in here.
//
// 2. NO NETWORK. `?fixture=1` constructs no program, no wallet and no RPC (`ArenaProvider.tsx`), so
//    the only request the page makes off its own bundle is the keeper's status file. That one is
//    always intercepted — never left to `public/keeper-status.json`, which is a checked-in artifact
//    that can go stale, and never to the deployed keeper. `assertHermetic` then proves the claim
//    rather than assuming it: any request that leaves the origin fails the test.
//
// 3. NO SHARED STATE. One browser context per page, so `localStorage` (`v2_intro_seen`,
//    the sim ledger) starts empty every time. The first-visit takeover is a first-visit takeover.
//
// ── WHAT IS DELIBERATELY NOT COVERED ──────────────────────────────────────────────────────────
//
// The chain path. Nothing in here connects a wallet, signs anything, or reads devnet — a suite that
// needs devnet is a suite nobody runs, and `scripts/prod-smoke.mjs` is the thing that drives the
// real write path against production. What this suite covers is everything that is true of the page
// regardless of who is signing, which is where all six of the shipped defects lived.

import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import { afterAll, beforeAll } from "vitest";

/** Fixed rather than ephemeral, and `strictPort` in the global setup, so a stray server on this port
 *  fails loudly at startup instead of a suite silently testing somebody else's build. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 5199);
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;

/** The instant every test starts from. Fixed and in the past-tense-of-nothing: no test may depend on
 *  the time of day it runs at, and a fixed epoch makes every countdown in the suite reproducible. */
export const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const T0_SEC = Math.floor(T0 / 1000);

// ── The fixture round's own timeline, mirrored from `data/useFixtureRound.ts` ──────────────────
//
// Mirrored rather than imported because these tests drive the page from OUTSIDE: importing the
// module's constants would make the test agree with the implementation by construction, which is
// exactly the kind of agreement that proves nothing. The numbers below are what the page was
// OBSERVED to do (see `phaseAt`); `clock.e2e.ts` asserts the observed phase at each of them, so a
// change to the fixture's pacing fails here rather than silently skewing every other test.
export const LOBBY_ENDS_SEC = 8;
export const DRAWING_ENDS_SEC = 10;
/** The last exchange in `MOCK_HIT_EVENTS` lands at ~94s of fight; the round settles there. */
export const FIGHT_ENDS_SEC = 104;

// ---------------------------------------------------------------------------------------------
// The keeper's status file
// ---------------------------------------------------------------------------------------------

/** A schema-5 status file (`data/keeperStatus.ts`), built at `T0` so the heartbeat is fresh.
 *
 *  `staleAfterSeconds` is deliberately enormous. A test that fast-forwards two minutes of page time
 *  would otherwise age the heartbeat past a realistic 15s threshold mid-test and flip the cadence
 *  underneath the assertion — a keeper going stale mid-fast-forward is a state a test must ASK for
 *  by publishing an old heartbeat, never one it drifts into halfway through an assertion. */
function baseStatus() {
  return {
    schema: 5,
    keeper: {
      startedAt: T0_SEC - 600,
      heartbeatAt: T0_SEC,
      heartbeatIntervalSeconds: 2,
      staleAfterSeconds: 86_400,
      stalledSince: null,
      roundsCompleted: 16,
      lastError: null,
      lowBalance: null,
      wedgedRounds: [] as number[],
    },
    chain: {
      cluster: "devnet",
      programId: "ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe",
      arenaPda: "B982CKufw8M86duY7t7R7FVQ4uSTLXBmMWQmJUvHpaXk",
      erValidator: null,
    },
    round: {
      no: 17,
      pda: "RoundPda11111111111111111111111111111111111",
      phase: "Lobby",
      phaseCode: 0,
      lobbyOpenedAt: T0_SEC - 10,
      lobbyClosesAt: T0_SEC + 3540,
      fightStartedAt: 0,
      fighterCount: 9,
      heldOpen: true,
      winner: 0,
      pot: "408000000",
    },
    entriesCloseAt: null as number | null,
    nextLobbyOpensAt: null as number | null,
  };
}

/** THE THREE KEEPER STATES THE PAGE'S CLOCK RULES BRANCH ON — named, so a test says which one it is
 *  testing instead of hand-assembling JSON.
 *
 *  `roundCadence`/`keeperCountdown` turn each of these into a different `Cadence`, and each `Cadence`
 *  puts something different in a clock slot. They are the input side of defect #1. */
export const keeperStates = {
  /** The lobby the keeper is holding open at no cost until somebody arrives. `heldOpen` ⇒
   *  `waiting-for-players` ⇒ the slot must say OPEN and must NOT count. */
  heldOpenLobby() {
    return baseStatus();
  },
  /** Somebody arrived, so the keeper has committed to a time and publishes it. ⇒ `entries-close` ⇒
   *  a real, running countdown.
   *
   *  `heldOpen` going false IS the whole difference now. It used to be set alongside a
   *  `realFighterCount` of 1, which the status file stopped carrying at schema 5 — and the pair was
   *  always one fact written twice, so nothing about what this state MEANS has changed. */
  closingLobby(secondsFromT0: number) {
    const s = baseStatus();
    s.round.heldOpen = false;
    s.entriesCloseAt = T0_SEC + secondsFromT0;
    return s;
  },
  /** Up, publishing, and with nothing honest to say about time. */
  silent() {
    const s = baseStatus();
    s.round.heldOpen = false;
    return s;
  },
} as const;

export type KeeperState = ReturnType<(typeof keeperStates)[keyof typeof keeperStates]>;

// ---------------------------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------------------------

/** SYSTEM CHROME, NOT A DOWNLOADED BUILD. `playwright` (the package that ships browsers) is
 *  deliberately not a dependency of this repo; `playwright-core` drives a browser that is already on
 *  the machine, and `channel: "chrome"` is the one that is. */
export async function launch(): Promise<Browser> {
  return await chromium.launch({ channel: "chrome", headless: true });
}

/** One browser per test file, torn down with it. Call at the top of a `describe`. */
export function useBrowser(): () => Browser {
  let browser: Browser | null = null;
  beforeAll(async () => {
    browser = await launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    browser = null;
  });
  return () => {
    if (browser === null) throw new Error("e2e: browser requested outside a test lifecycle");
    return browser;
  };
}

export interface OpenOptions {
  /** Query string appended to `/`, without the leading `?`. Always includes `fixture=1` unless the
   *  caller replaces it outright. */
  query?: string;
  /** Which keeper the page reads. `null` serves a 404 — "no keeper has ever run here", which is the
   *  page's `no-keeper` cadence and the state the chain's own `lobby_closes_at` may be counted in. */
  keeper?: KeeperState | null;
  viewport?: { width: number; height: number };
  /** Dismiss the first-visit takeover before handing the page back. Every test that is not ABOUT the
   *  takeover wants this — it covers the page and traps the keyboard. */
  dismissIntro?: boolean;
  /** EXTRA ROUTES, INSTALLED BEFORE `goto` — which is the only moment at which a response the page
   *  fetches on mount can be delayed, rewritten or failed. `page.route` called after navigation is
   *  too late for every one of them.
   *
   *  It exists because ORDERING IS SOMETIMES THE THING UNDER TEST. `links.e2e.ts` has to prove the
   *  canvas picks up an identity that arrives AFTER the field was built, and the only way to know
   *  the field was built first is to hold the identity response until the test has seen it happen.
   *  Waiting and hoping would have been a test that passes whichever order the machine happened to
   *  produce — which is precisely the false green this suite exists not to produce. */
  routes?(page: Page): Promise<void>;
}

export interface Session {
  page: Page;
  context: BrowserContext;
  /** Every `console.error` and every uncaught exception, in order. Defect #5's evidence. */
  errors: string[];
  /** Every URL the page asked for. Defect: a "no network" fixture that talks to the network. */
  requests: string[];
  /** Advance the page's clock by `seconds` — firing each pending timer at most once per jump, which
   *  is what makes a 94-second fight cost a millisecond. Use `tick` when intermediate ticks matter. */
  jump(seconds: number): Promise<void>;
  /** Advance the page's clock by `seconds`, running every timer callback that falls inside it. */
  tick(seconds: number): Promise<void>;
  close(): Promise<void>;
}

/** Open the assembled page in a fresh, isolated context with a fake clock and a known keeper. */
export async function open(browser: Browser, options: OpenOptions = {}): Promise<Session> {
  const { query = "fixture=1", keeper = null, dismissIntro = true } = options;
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 1000 },
  });
  const page = await context.newPage();

  const errors: string[] = [];
  const requests: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // EVERY request, whether it succeeded or not — `assertHermetic` is asking where the page tried to
  // go, and a blocked cross-origin call is exactly as much of a defect as a successful one.
  page.on("request", (r) => requests.push(r.url()));

  // BEFORE `goto`, always: the keeper is polled from an effect that runs on the first commit.
  await page.route("**/keeper-status.json", (route: Route) =>
    keeper === null
      ? route.fulfill({ status: 404, contentType: "text/plain", body: "no keeper here" })
      : route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(keeper),
        }),
  );

  // After the keeper's, so a caller can override it, and still before `goto` — see `OpenOptions`.
  if (options.routes) await options.routes(page);

  // BEFORE `goto` as well, and this one is load-bearing: `data/flags.ts` reads the query string at
  // MODULE LOAD, and `useFixtureRound` seeds its start time from `Date.now()` on first render.
  await page.clock.install({ time: new Date(T0) });

  await page.goto(`${BASE_URL}/?${query}`, { waitUntil: "load", timeout: 30_000 });
  await page.waitForSelector(".chrome--top", { timeout: 30_000 });

  const session: Session = {
    page,
    context,
    errors,
    requests,
    jump: async (seconds) => {
      await page.clock.fastForward(seconds * 1000);
    },
    tick: async (seconds) => {
      await page.clock.runFor(seconds * 1000);
    },
    close: async () => {
      await context.close();
    },
  };

  if (dismissIntro) await dismissTakeover(page);
  return session;
}

/** The first-visit takeover, gone. Idempotent — a page that has already seen it has no dialogue. */
export async function dismissTakeover(page: Page): Promise<void> {
  const dialog = page.locator('[role="dialog"]');
  if ((await dialog.count()) === 0) return;
  await page.getByRole("button", { name: /let.?s go/i }).click();
  await until(async () => (await dialog.count()) === 0, "the takeover to close");
}

// ---------------------------------------------------------------------------------------------
// Waiting, from Node, on conditions
// ---------------------------------------------------------------------------------------------

/**
 * Poll a condition until it holds. THE ONLY WAIT IN THIS SUITE.
 *
 * It exists because the page's own timers are faked (see this file's header), which rules out
 * `page.waitForFunction` — its polling is a page timer and would never fire — and because a fixed
 * sleep is not synchronisation, it is a bet. Everything here waits on something OBSERVABLE: a piece
 * of text, an element count, a focused element. If the condition never holds the failure names what
 * it was waiting for rather than timing out anonymously.
 *
 * The delay between polls is a Node timer against real time and is not synchronisation either — it
 * is how often the question gets asked. Nothing passes because of it.
 */
export async function until(
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      if (await condition()) return;
      last = null;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `e2e: timed out after ${timeoutMs}ms waiting for ${what}` +
          (last === null ? "" : ` (last error: ${String(last)})`),
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------------------------

export const VIEWS = ["arena", "leaderboard", "dashboard", "referrals", "history"] as const;
export type ViewName = (typeof VIEWS)[number];

/** Move to a screen through the bottom nav, and wait for it to be the CURRENT one.
 *
 *  `aria-keyshortcuts` is the selector rather than the label because it is the same attribute the
 *  keyboard test asserts against — one fact, one handle, so a nav whose printed index and whose
 *  shortcut disagreed could not pass both. */
export async function goToView(page: Page, view: ViewName): Promise<void> {
  const index = VIEWS.indexOf(view);
  const button = page.locator(`nav[aria-label="Screens"] button[aria-keyshortcuts="${index}"]`);
  await button.click();
  await until(
    async () => (await button.getAttribute("aria-current")) === "page",
    `the ${view} screen to become current`,
  );
}

/** Which screen the nav says is current — read from the nav's own `aria-current`, which is the same
 *  fact a screen reader is given. */
export async function currentView(page: Page): Promise<ViewName | null> {
  const index = await page.evaluate(() => {
    const on = document.querySelector('nav[aria-label="Screens"] button[aria-current="page"]');
    return on?.getAttribute("aria-keyshortcuts") ?? null;
  });
  if (index === null) return null;
  return VIEWS[Number(index)] ?? null;
}

/** Everything in every round-clock slot on screen, in DOM order. Three of them on Arena (the top
 *  bar, 00-1's hero, the strip on the field); one everywhere else. */
export async function clockSlots(page: Page): Promise<string[]> {
  const raw = await page.locator('[data-testid="round-clock"]').allInnerTexts();
  return raw.map((t) => t.trim());
}

/** The page's own words, as a reader sees them — `innerText`, so `text-transform: uppercase` is
 *  applied exactly as it is on screen. "1 FIGHTERS" shipped in capitals; this is how it is caught. */
export async function screenText(page: Page): Promise<string> {
  return await page.locator("main.page").innerText();
}

/** The round's phase, off the top bar — the one surface present on all five screens. */
export async function phaseWord(page: Page): Promise<string> {
  const tele = (await page.locator(".tele").innerText()).replace(/\s*\n\s*/g, " ");
  return tele.split(" / ")[1] ?? "";
}

/** Wait until the top bar reports `phase`. Used after every clock jump, so no assertion runs against
 *  a render that has not happened yet. */
export async function waitForPhase(page: Page, phase: string): Promise<void> {
  await until(async () => (await phaseWord(page)) === phase, `the round to reach ${phase}`);
}

// ---------------------------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------------------------

/** DEFECT #5, EVERYWHERE. Every test calls this before it closes; a page that white-screened from a
 *  wallet error rendered as a React child fails here rather than in whichever assertion happened to
 *  read an empty string first. */
export function assertNoPageErrors(session: Session, where: string): void {
  if (session.errors.length > 0) {
    throw new Error(`e2e: ${where} produced ${session.errors.length} page error(s):\n  ${session.errors.join("\n  ")}`);
  }
}

/** The page is a page: React committed, the shell is there, and the screen has content in it. An
 *  error-free white screen is still a white screen. */
export async function assertRendered(page: Page, where: string): Promise<void> {
  const state = await page.evaluate(() => {
    const root = document.getElementById("v2-root");
    const main = document.querySelector("main.page");
    return {
      rootChildren: root?.childElementCount ?? -1,
      mainText: (main as HTMLElement | null)?.innerText.trim().length ?? -1,
    };
  });
  if (state.rootChildren <= 0) throw new Error(`e2e: ${where} — #v2-root has no children (white screen)`);
  if (state.mainText < 200) {
    throw new Error(`e2e: ${where} — main.page holds only ${state.mainText} characters of text`);
  }
}

/** `?fixture=1` claims to "touch the network for nothing at all". This is that claim, checked. */
export function assertHermetic(session: Session): void {
  const foreign = [...new Set(session.requests)].filter((u) => !u.startsWith(BASE_URL));
  if (foreign.length > 0) {
    throw new Error(`e2e: the fixture page left its own origin:\n  ${foreign.join("\n  ")}`);
  }
}
