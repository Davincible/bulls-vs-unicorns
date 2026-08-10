#!/usr/bin/env bun
// WALLET-STATE VERIFICATION — every state a visitor can land in on the way to their first deploy,
// driven headlessly against a MOCKED Phantom provider, asserted, and photographed.
//
//   cd er-demo && bun scripts/verify-wallet-states.ts
//
// WHAT THIS PROVES. That `data/playGate.ts` reaches each of its blocks from the browser conditions
// that are supposed to produce them; that `ui/ConnectPanel.tsx` renders each one with a route out;
// that the top chrome and the bottom chrome follow; that ArenaView's deploy strip is withheld while
// the gate is up and comes back when it drops; and that none of it throws. It also re-runs the two
// paths this workstream promised not to disturb — `?fixture=1` and `?signer=burner`.
//
// WHAT THIS CANNOT PROVE, AND NO SCRIPT IN THIS REPO CAN. Playwright cannot install a browser
// extension, so there is no real Phantom here. Everything downstream of a real approval is out of
// reach: a genuine `connect()` prompt, a genuine signature, `create_session`, a session-signed
// `enter`/`extract`, and anything at all about which network the user's Phantom is set to (no dapp
// can read that — see `walletFault.ts`). A mock that returns what we told it to return is a test of
// OUR state machine, not of Phantom. Read the pass table below as exactly that.
//
// WHY THE PAGE IS HERMETIC, AND WHAT THAT MAKES THE SCREENSHOTS. Two deliberate substitutions:
//
//   1. `getBalance` is FULFILLED BY THIS SCRIPT with whatever the scenario needs. The zero-SOL state
//      is the single most likely thing a stranger hits and it must be reproducible on demand rather
//      than waiting for a wallet to actually be empty.
//   2. Every OTHER devnet/router call is fulfilled with a JSON-RPC ERROR — not aborted. An abort is a
//      network-level failure that shows up as console noise and would drown the very errors this
//      script is watching for; an RPC error is a thing the app already knows how to survive. The
//      arena read fails, so the page lands on its FIXTURE FALLBACK, which is a deterministic backdrop
//      that still carries the real wallet and the real gate (deliberate, see `ArenaProvider.tsx`).
//
// So: the rounds, rosters and money in these screenshots are the FIXTURE, and the SOL figure is a
// number this script made up. Nothing here is a live devnet capture and nothing in it should ever be
// presented as one. The IDL is served from `public/` by Vite, so `programReady` is true within a
// frame and the `no-program` block never masks the wallet states we came to look at.

/** THE `Bun` GLOBAL, DECLARED RATHER THAN INSTALLED — and the reason is that this file was invisible
 *  to the type-checker until now.
 *
 *  `tsconfig.scripts.json` existed but the root solution file never referenced it, so `tsc -b` never
 *  built it and NOTHING under `scripts/` — the whole keeper included — was covered by
 *  `npm run typecheck`. That is the same trap the root `tsconfig.json` header documents at length,
 *  one layer deeper: a gate that passes because it never looked. Adding the reference surfaced
 *  exactly two errors in the entire directory, both of them this global.
 *
 *  Declared locally instead of adding `@types/bun`: a dependency for two call sites is the wrong
 *  trade, and the shape below is only as wide as what this file actually uses. `bun` strips types
 *  without checking them, so this declaration constrains the type-checker and never the runtime. */
declare const Bun: {
  spawn(cmd: string[], opts: { cwd: string; stdout: "pipe"; stderr: "pipe" }): {
    exited: Promise<number>;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    kill(): void;
  };
};

import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// THE BOUND ITSELF, not a number retyped beside it. A harness that waited "about twenty seconds"
// would go on passing the day somebody raised the bound to sixty, having verified nothing.
import { CONNECT_PATIENCE_MS } from "../src/v2/data/connectPatience.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SHOTS = join(ROOT, "design", "wallet-states");

/** Deliberately not Vite's default. Another workstream is live in this repo and may be holding 5173;
 *  colliding with it would fail this run for a reason that has nothing to do with the wallet. */
const PORT = 5199;
const ORIGIN = `http://localhost:${PORT}`;

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const heading = (s: string) => console.log(`\n${c.b}${s}${c.x}`);
const info = (s: string) => console.log(`  ${c.d}${s}${c.x}`);

const LAMPORTS_PER_SOL = 1_000_000_000;

// ---------------------------------------------------------------------------------------------
// The mock provider
// ---------------------------------------------------------------------------------------------

/** How the injected provider should behave. Serialised into the page, so it must stay JSON. */
interface MockSpec {
  /** Set `window.isPhantomInstalled`. WITHOUT IT THE ADAPTER NEVER REACHES `Installed` — its
   *  compiled detection requires BOTH that flag and `…solana.isPhantom`, which is exactly the
   *  real-world hole `wallet-unannounced` exists for. */
  announce: boolean;
  /** THE SITE IS ALREADY TRUSTED, which in Phantom means exactly one thing: `connect({onlyIfTrusted:
   *  true})` resolves instead of rejecting. It does NOT mean `isConnected` starts true — a real
   *  extension starts every page load disconnected and is brought back by that eager call. Modelling
   *  it any other way is what let the unsolicited-popup bug hide. */
  trusted: boolean;
  /** `connect()` rejects with Phantom's own user-rejection shape. */
  reject?: boolean;
  /** The bare `connect()` never settles — a popup sitting open, waiting on a human. The
   *  `onlyIfTrusted` probe still rejects promptly, because that call never shows a popup at all. */
  hang?: boolean;
}

/** Injected before any page script runs. Mirrors the surface `PhantomWalletAdapter` actually
 *  touches, read off its compiled source rather than guessed:
 *  `isPhantom`, `isConnected`, `publicKey.toBytes()`, `connect`, `disconnect`, `on`, `off`,
 *  `signTransaction`, `signAllTransactions`. */
function installMock() {
  return (s: MockSpec) => {
    // A fixed 32-byte key, so the truncated address in the chrome is stable across runs and a
    // screenshot diff means something changed rather than that a key was regenerated.
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 7 + 3) & 0xff;

    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const provider = {
      isPhantom: true,
      // Always false on load, exactly like the real extension. Trust is not a connection.
      isConnected: false,
      publicKey: null as { toBytes: () => Uint8Array } | null,
      connect(options?: { onlyIfTrusted?: boolean }) {
        const reject4001 = () => {
          const e = new Error("User rejected the request.") as Error & { code: number };
          e.code = 4001;
          return Promise.reject(e);
        };
        const accept = () => {
          provider.isConnected = true;
          provider.publicKey = { toBytes: () => bytes };
          return Promise.resolve({ publicKey: provider.publicKey });
        };
        // THE EAGER PROBE. Never shows a popup, so it never hangs and is never "rejected by the
        // user" — it simply answers whether this origin is already trusted.
        if (options?.onlyIfTrusted) return s.trusted ? accept() : reject4001();
        // The interactive call: this is the one that opens a popup, so this is the one that can
        // hang on a human or come back cancelled.
        if (s.hang) return new Promise(() => {});
        if (s.reject) return reject4001();
        return accept();
      },
      disconnect() {
        provider.isConnected = false;
        provider.publicKey = null;
        return Promise.resolve();
      },
      on(event: string, handler: (...a: unknown[]) => void) {
        (listeners[event] ||= []).push(handler);
      },
      off(event: string, handler: (...a: unknown[]) => void) {
        listeners[event] = (listeners[event] || []).filter((h) => h !== handler);
      },
      signTransaction: <T,>(t: T) => Promise.resolve(t),
      signAllTransactions: <T,>(t: T[]) => Promise.resolve(t),
    };

    (window as unknown as Record<string, unknown>).phantom = { solana: provider };
    (window as unknown as Record<string, unknown>).solana = provider;
    if (s.announce) (window as unknown as Record<string, unknown>).isPhantomInstalled = true;

    // The handle the harness reaches for to simulate Phantom dropping the site from ITS side, which
    // is the only way the adapter emits `WalletDisconnectedError` (when WE disconnect it detaches
    // these listeners first, so no error fires — that asymmetry is the whole signal).
    (window as unknown as Record<string, unknown>).__fireDisconnect = () => {
      provider.isConnected = false;
      provider.publicKey = null;
      for (const h of listeners.disconnect || []) h();
    };
  };
}

// ---------------------------------------------------------------------------------------------
// Scenario running
// ---------------------------------------------------------------------------------------------

interface Scenario {
  name: string;
  /** null = inject nothing at all, i.e. a browser with no Phantom. */
  mock: MockSpec | null;
  /** Lamports `getBalance` should report. */
  lamports: number;
  /** Query string appended to `/`. */
  query?: string;
  /** The `data-block` we expect, or null when we expect NO panel at all. */
  expect: string | null;
  /** Extra driving between load and assertion. */
  drive?: (page: Page) => Promise<void>;
  /**
   * HOW LONG TO SIT STILL AFTER `drive`, for a scenario whose assertion is about a bound that only
   * starts running once the page has been driven into the state.
   *
   * It is deliberately NOT a knob on the settle window above, which is what an earlier sketch of this
   * called for. That window is the adapter's detection poll plus the first balance read, and it runs
   * BEFORE `drive` — widening it would make every scenario slower and would still leave the
   * connect-stalled clock un-started at the moment of assertion, because that clock does not begin
   * until the Connect button is pressed. The wait has to come after the press, so it lives here.
   *
   * Zero by default, so every existing scenario is timed exactly as it was.
   */
  dwellMs?: number;
  /** Skip opening the rail — for the fixture/burner regressions where the point is the page. */
  openRail?: boolean;
  /** Whatever else this state is supposed to be true of. Returns the failures it found, so one
   *  scenario reports every problem it has rather than only the first. */
  assert?: (page: Page) => Promise<string[]>;
}

/** THE DEPLOY STRIP — ArenaView renders `<div className="deploy">` only when `open` is true, and
 *  `open` is gated on `gate === null`. So its presence IS the answer to "did the gate actually reach
 *  the controls", which is the half of this that a connect panel on its own cannot prove. */
async function deployStripLive(page: Page): Promise<boolean> {
  return (await page.locator(".deploy").count()) > 0;
}

/** The whole top-right readout, as one string. */
async function chromeRight(page: Page): Promise<string> {
  const el = page.locator(".chrome-right");
  return (await el.count()) === 0 ? "" : (await el.first().innerText()).replace(/\s+/g, " ").trim();
}

interface Result {
  name: string;
  ok: boolean;
  detail: string;
  pageErrors: string[];
  consoleErrors: string[];
  /** What the panel actually said, for the copy review. */
  words: string;
}

async function runScenario(browser: Browser, s: Scenario): Promise<Result> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });

  // The takeover is a first-visit thing and it is not what these shots are about. Dismissed the way
  // the app itself dismisses it, so nothing is stubbed that the app does not already do.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("v2_intro_seen", "1");
    } catch {
      /* storage blocked — the takeover simply shows, which does not invalidate the run */
    }
  });
  if (s.mock) await page.addInitScript(installMock(), s.mock);

  await page.route(/api\.devnet\.solana\.com|devnet-router\.magicblock\.app/, async (route) => {
    let body: unknown;
    try {
      body = route.request().postDataJSON();
    } catch {
      body = null;
    }
    const one = (req: { id?: unknown; method?: string }) =>
      req?.method === "getBalance"
        ? { jsonrpc: "2.0", id: req.id ?? 1, result: { context: { slot: 1 }, value: s.lamports } }
        : {
            jsonrpc: "2.0",
            id: req?.id ?? 1,
            error: { code: -32603, message: "blocked by verify-wallet-states (hermetic run)" },
          };
    const payload = Array.isArray(body) ? body.map(one) : one((body ?? {}) as { id?: unknown; method?: string });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });

  const errors: string[] = [];
  let words = "";
  try {
    await page.goto(`${ORIGIN}/${s.query ?? ""}`, { waitUntil: "domcontentloaded" });
    // The adapter detects Phantom by polling, so the readiness verdict is not available on the first
    // paint. This is the settle window for that poll plus the first balance read.
    await page.waitForTimeout(2500);

    if (s.drive) await s.drive(page);
    if (s.dwellMs) await page.waitForTimeout(s.dwellMs);

    if (s.openRail !== false) {
      const btn = page.locator('[data-testid="chrome-wallet-btn"]');
      if ((await btn.count()) > 0) {
        await btn.first().click();
        await page.waitForTimeout(600);
      }
    }

    const panels = page.locator('[data-testid="connect-panel"]');
    const count = await panels.count();

    if (s.expect === null) {
      if (count !== 0) errors.push(`expected no connect panel, found ${count}`);
    } else if (count === 0) {
      errors.push(`expected data-block="${s.expect}", found no panel at all`);
    } else {
      const blocks = await panels.evaluateAll((els) =>
        els.map((e) => (e as HTMLElement).dataset.block ?? "?"),
      );
      if (!blocks.includes(s.expect)) {
        errors.push(`expected data-block="${s.expect}", found [${blocks.join(", ")}]`);
      }
      words = (await panels.first().innerText()).replace(/\n+/g, " / ");
    }

    if (s.assert) errors.push(...(await s.assert(page)));
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${s.name}.png`) }).catch(() => {});

  if (pageErrors.length > 0) errors.push(`${pageErrors.length} uncaught page error(s)`);

  await ctx.close();
  return {
    name: s.name,
    ok: errors.length === 0,
    detail: errors.join("; ") || "ok",
    pageErrors,
    consoleErrors,
    words,
  };
}

// ---------------------------------------------------------------------------------------------

const FULL: MockSpec = { announce: true, trusted: false };

/** A Phantom that takes the request and never answers — the shape both connect-wait scenarios need,
 *  shared so they cannot drift into testing two different wallets. */
const HANGING: MockSpec = { announce: true, trusted: false, hang: true };

/** Open the rail and press Connect. The two connect-wait scenarios differ ONLY in how long they then
 *  stand still, so the driving is one function: if these diverged, the pair would stop being a
 *  before-and-after of the same handshake. */
async function pressConnect(page: Page): Promise<void> {
  await page.locator('[data-testid="chrome-wallet-btn"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="connect-cta"]').first().click();
  await page.waitForTimeout(600);
}

/** What a particular block says on screen, as one flat string — or null if that block is not up.
 *
 *  IT PICKS THE PANEL BY `data-block` RATHER THAN TAKING THE FIRST. Both the rail and the dock render
 *  a `ConnectPanel`, at different densities and with deliberately different content, so `.first()`
 *  answers a question about DOM order rather than about the state. Reading the compact one — the
 *  dock's, which is the surface the density rule and the placement rule both act on — is the point
 *  of these assertions. */
async function panelText(page: Page, block: string): Promise<string | null> {
  const panel = page.locator(`.cx--compact[data-block="${block}"]`);
  if ((await panel.count()) === 0) return null;
  return (await panel.first().innerText()).replace(/\s+/g, " ").trim();
}

const SCENARIOS: Scenario[] = [
  {
    name: "not-installed",
    mock: null,
    lamports: 0,
    expect: "not-installed",
  },
  {
    name: "wallet-unannounced",
    // The provider is right there in the page; it just never set the flag the adapter waits for.
    mock: { announce: false, trusted: false },
    lamports: 0,
    expect: "wallet-unannounced",
  },
  {
    name: "not-connected",
    mock: FULL,
    lamports: 0,
    expect: "not-connected",
    assert: async (page) => {
      const bad: string[] = [];
      const right = await chromeRight(page);
      if (!/NOT CONNECTED/i.test(right)) bad.push(`top chrome should read NOT CONNECTED, read "${right}"`);
      const label = await page.locator('[data-testid="chrome-wallet-btn"]').first().innerText();
      if (!/connect/i.test(label)) bad.push(`chrome button should invite connecting, read "${label}"`);
      if (await deployStripLive(page)) bad.push("deploy strip is live with no wallet connected");
      return bad;
    },
  },
  {
    name: "connecting",
    mock: HANGING,
    lamports: 0,
    expect: "connecting",
    drive: pressConnect,
    openRail: false,
    // ~1s of driving, comfortably inside the bound, so this is still the ORDINARY wait: a popup is
    // notionally open and the page is entitled to say so.
    assert: async (page) => {
      const bad: string[] = [];
      const panel = await panelText(page, "connecting");
      if (panel === null) return ["no connecting panel to read"];
      if (!/waiting on you/i.test(panel)) {
        bad.push(`the ordinary wait should still say Phantom is waiting on you, read "${panel}"`);
      }
      // THE PLACEMENT RULE, ON THE SURFACE IT WAS WRITTEN FOR. `connecting` carries no cta, so it
      // must SIT BESIDE the dock's deploy controls rather than evict them — see `gatePlacement`.
      // Before this change the panel replaced them outright, and a reader mid-connect lost the stake
      // they had staged and the price it would cost them for as long as the wallet took to answer.
      const sides = await page.locator("#stake-dock .dock-sides button").count();
      if (sides !== 2) bad.push(`expected the dock's two side buttons beside the panel, found ${sides}`);
      const stake = await page.locator('#stake-dock [aria-label="Stake amount"] button').count();
      if (stake === 0) bad.push("the stake segment is gone while the wallet thinks");
      // And the third paragraph is the rail's now, not the dock's — the note is embedded in `detail`
      // for the two states that are still a pitch, and appended nowhere else at this density.
      if (/devnet only/i.test(panel)) {
        bad.push(`the compact panel is still repeating the network note: "${panel}"`);
      }
      return bad;
    },
  },
  {
    name: "connect-stalled",
    // The same hung provider. What is different is only how long we wait for it — which is the whole
    // claim: nothing about the wallet changes at the bound, only what this page is willing to say.
    mock: HANGING,
    lamports: 0,
    expect: "connect-stalled",
    drive: pressConnect,
    // Past the bound, plus a margin. A backgrounded tab throttles timers to roughly one a second, so
    // the transition can land LATE — never early — and a dwell of exactly the bound would be a
    // coin-flip. See `connectPatience.ts`.
    dwellMs: CONNECT_PATIENCE_MS + 4_000,
    openRail: false,
    assert: async (page) => {
      const bad: string[] = [];
      const panel = await panelText(page, "connect-stalled");
      if (panel === null) return ["no connect-stalled panel to read"];
      // THE DEFECT, IN ONE ASSERTION. The page said "waiting for you to approve the connection in
      // Phantom" for the life of the tab, over an extension that was never going to answer. That
      // sentence is a claim about the player, and past the bound this page cannot make it.
      if (/waiting for you|waiting on you/i.test(panel)) {
        bad.push(`still claiming the player is being asked: "${panel}"`);
      }
      // A LIVE ROUTE OUT, which is the other half of it: a wedge with no button is still a wedge.
      const cta = page.locator('[data-testid="connect-cta"]');
      if ((await cta.count()) === 0) {
        bad.push("no cta at all — the stalled state must offer the reload");
      } else if (await cta.first().isDisabled()) {
        bad.push("the reload cta is disabled, which leaves the page with no way out");
      }
      // And it must not have swung to the opposite lie: the promise is still live and a late
      // approval still lands, so the escape says so rather than declaring the request dead.
      if (!/popup is open/i.test(panel)) {
        bad.push(`the escape no longer mentions approving an open popup: "${panel}"`);
      }
      return bad;
    },
  },
  {
    name: "connect-failed",
    mock: { announce: true, trusted: false, reject: true },
    lamports: 0,
    expect: "connect-failed",
    drive: async (page) => {
      await page.locator('[data-testid="chrome-wallet-btn"]').first().click();
      await page.waitForTimeout(400);
      await page.locator('[data-testid="connect-cta"]').first().click();
      await page.waitForTimeout(800);
    },
    openRail: false,
  },
  {
    name: "no-sol",
    mock: { announce: true, trusted: true },
    lamports: 0,
    expect: "no-sol",
    assert: async (page) => {
      const bad: string[] = [];
      const right = await chromeRight(page);
      // Connected, so the chrome must have flipped to the key + SOL readout.
      if (/NOT CONNECTED/i.test(right)) bad.push(`top chrome still reads NOT CONNECTED: "${right}"`);
      if (!/KEY/i.test(right)) bad.push(`top chrome should carry a key readout, read "${right}"`);
      const label = await page.locator('[data-testid="chrome-wallet-btn"]').first().innerText();
      if (!/sol|fund|devnet/i.test(label)) bad.push(`chrome button should point at funding, read "${label}"`);
      if (await deployStripLive(page)) bad.push("deploy strip is live with a zero balance");
      return bad;
    },
  },
  {
    name: "funded",
    mock: { announce: true, trusted: true },
    lamports: 2 * LAMPORTS_PER_SOL,
    expect: null,
    // THE FIXTURE'S LOBBY IS THE FIRST EIGHT SECONDS after mount (`useFixtureRound.ts`), and the
    // deploy strip only exists during it — so this one does not open the rail and does not dawdle.
    openRail: false,
    assert: async (page) => {
      const bad: string[] = [];
      const right = await chromeRight(page);
      if (!/KEY/i.test(right)) bad.push(`top chrome should carry a key readout, read "${right}"`);
      if (!(await deployStripLive(page))) {
        bad.push("deploy strip is absent for a funded, connected wallet");
      } else {
        const buttons = page.locator(".sides button");
        const n = await buttons.count();
        if (n < 2) bad.push(`expected two side buttons, found ${n}`);
        for (let i = 0; i < n; i++) {
          if (await buttons.nth(i).isDisabled()) {
            bad.push(`side button ${i} is disabled for a funded wallet`);
          }
        }
      }
      return bad;
    },
  },
  {
    name: "disconnected-midway",
    mock: { announce: true, trusted: true },
    lamports: 2 * LAMPORTS_PER_SOL,
    expect: "connect-failed",
    drive: async (page) => {
      await page.evaluate(() => (window as unknown as { __fireDisconnect: () => void }).__fireDisconnect());
      await page.waitForTimeout(800);
    },
  },
  // --- the two paths this workstream promised not to disturb ---------------------------------
  {
    name: "fixture",
    mock: null,
    lamports: 0,
    query: "?fixture=1",
    expect: null,
    openRail: false,
  },
  {
    name: "burner",
    mock: null,
    lamports: 2 * LAMPORTS_PER_SOL,
    query: "?signer=burner",
    expect: null,
    openRail: false,
    assert: async (page) => {
      const bad: string[] = [];
      // The burner path is the developer path and it must be untouched: it needs no extension, it
      // still calls itself a burner, and it still offers the airdrop this workstream withheld from
      // wallet mode.
      if (!(await deployStripLive(page))) bad.push("deploy strip is absent on the funded burner path");
      await page.locator('[data-testid="chrome-wallet-btn"]').first().click();
      await page.waitForTimeout(500);
      const rail = await page.locator(".rail").first().innerText();
      if (!/burner/i.test(rail)) bad.push("burner rail no longer calls itself a burner");
      if (!/airdrop/i.test(rail)) bad.push("burner rail lost its airdrop button");
      return bad;
    },
  },
  {
    name: "burner-fixture",
    mock: null,
    lamports: 0,
    query: "?fixture=1&signer=burner",
    expect: null,
    openRail: false,
  },
];

// ---------------------------------------------------------------------------------------------

/**
 * A FROZEN BUILD, NOT THE DEV SERVER — and that is not a preference, it is what makes this script
 * mean anything.
 *
 * Run against `vite dev`, this harness photographs whatever happens to be on disk at the instant each
 * scenario loads. With another workstream saving files continuously, that produced a different
 * failure on every run — `useRef is not defined`, then `house is not defined`, then a timeout, each
 * one an intermediate save in somebody else's file that was gone again by the time it was
 * investigated. A verification script whose result depends on when you ran it verifies nothing.
 *
 * So: build once, serve the built assets, and let every scenario see the same bytes. A failure is
 * then a fact about the code, reproducible from the same commit.
 *
 * `vite build` DIRECTLY rather than `bun run build`, which is `tsc -b && vite build`: the typecheck
 * covers the whole repo including files this workstream does not own, and a red typecheck elsewhere
 * must not be able to stop the wallet states being verified. The typecheck is still run separately —
 * it is just not this script's gate.
 */
async function startVite(): Promise<{ stop: () => void }> {
  info("building (frozen bundle — immune to concurrent edits)…");
  const build = Bun.spawn(["bun", "run", "vite", "build", "--outDir", "dist-verify"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const buildCode = await build.exited;
  if (buildCode !== 0) {
    const err = await new Response(build.stderr).text();
    const out = await new Response(build.stdout).text();
    throw new Error(
      `vite build failed (exit ${buildCode}). If the error names a file outside this workstream, ` +
        `another workstream has the tree red — that is not this script's failure to fix.\n${out}\n${err}`,
    );
  }

  const proc = Bun.spawn(
    ["bun", "run", "vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", "dist-verify"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 30_000;
  let seen = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
    if (seen.includes("Local:")) {
      info(`vite up on ${ORIGIN}`);
      return { stop: () => proc.kill() };
    }
  }
  proc.kill();
  throw new Error(`vite did not become ready in 30s. Output:\n${seen}`);
}

async function main() {
  heading("WALLET STATES — headless, mocked Phantom, hermetic RPC");
  info("The SOL figure is stubbed by this script and the round is the fixture fallback.");
  info("No real Phantom is involved. See this file's header for what that does and does not prove.");

  const vite = await startVite();
  let browser: Browser | null = null;
  const results: Result[] = [];

  try {
    browser = await chromium.launch({ channel: "chrome" });
    for (const s of SCENARIOS) {
      const r = await runScenario(browser, s);
      results.push(r);
      const mark = r.ok ? `${c.g}PASS${c.x}` : `${c.r}FAIL${c.x}`;
      console.log(`  ${mark}  ${s.name.padEnd(20)} ${r.ok ? "" : c.r + r.detail + c.x}`);
    }
  } finally {
    if (browser) await browser.close();
    vite.stop();
  }

  heading("WHAT EACH STATE SAYS ON SCREEN");
  for (const r of results) {
    if (r.words) console.log(`\n${c.b}${r.name}${c.x}\n  ${r.words}`);
  }

  const noisy = results.filter((r) => r.consoleErrors.length > 0);
  if (noisy.length > 0) {
    heading("CONSOLE ERRORS (not failures on their own — the RPC is deliberately stubbed)");
    for (const r of noisy) console.log(`  ${r.name}: ${r.consoleErrors.slice(0, 2).join(" | ")}`);
  }

  const failed = results.filter((r) => !r.ok);
  heading(`${results.length - failed.length}/${results.length} scenarios passed`);
  for (const r of failed) console.log(`  ${c.r}${r.name}${c.x}: ${r.detail}`);
  if (failed.some((r) => r.pageErrors.length > 0)) {
    heading("UNCAUGHT PAGE ERRORS");
    for (const r of failed) for (const e of r.pageErrors.slice(0, 3)) console.log(`  ${r.name}: ${e}`);
  }

  console.log(`\n  screenshots: ${SHOTS}`);
  if (failed.length > 0) process.exit(1);
}

await main();
