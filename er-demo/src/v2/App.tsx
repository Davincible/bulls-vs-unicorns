// The v2 shell: two fixed black bars, one scrolling white page between them, one right-hand rail,
// one first-visit takeover. No router — five screens and a `useState` is the honest amount of
// machinery for that, and a router would put a dependency and a URL contract between this page and
// the old app it deliberately shares nothing mutable with.
//
// Everything below `<ArenaProvider>` reads `useArena()` for itself (SPEC.md: views take no props),
// so this file owns exactly two pieces of state — which screen, and what the rail is showing — and
// hands them down through `ShellContext` rather than props.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ViewId } from "./contract.ts";
import { ArenaProvider } from "./data/ArenaProvider.tsx";
import { useArena } from "./data/useArena.ts";
import { BottomChrome, TopChrome } from "./ui/Chrome.tsx";
import { IntroOverlay } from "./ui/IntroOverlay.tsx";
import { SideRail } from "./ui/SideRail.tsx";
import { StakeDock } from "./ui/StakeDock.tsx";
import { StickyStatus } from "./ui/StickyStatus.tsx";
import { ToastRail } from "./ui/ToastRail.tsx";
import { ShellContext, type Rail, type ShellApi } from "./ui/shell.ts";
import { useKeyboardNav } from "./ui/useKeyboardNav.ts";
import "./ui/shell.css";

import { ArenaView } from "./views/ArenaView.tsx";
import { DashboardView } from "./views/DashboardView.tsx";
import { HistoryView } from "./views/HistoryView.tsx";
import { LeaderboardView } from "./views/LeaderboardView.tsx";
import { ReferralsView } from "./views/ReferralsView.tsx";

const INTRO_KEY = "v2_intro_seen";

/** Persistent notices. The program error is fatal — with no program there is no round, no deploy
 *  and no extract, so it stays on screen rather than passing through as a toast. */
function Notices() {
  const { status, history, source } = useArena();

  return (
    <>
      {status.programError ? (
        <div className="banner banner--fatal" role="alert">
          <span className="u u--ink nowrap">No program</span>
          <span className="banner-t">
            {status.programError} — nothing on this page can reach the chain. Every figure below is
            the last thing that was read, or nothing at all.
          </span>
        </div>
      ) : null}

      {/* Said quietly, once, at the top: a page that shows plausible money without saying where it
          came from is the one failure mode this build treats as unshippable. */}
      {source === "fixture" ? (
        <div className="banner banner--quiet">
          <span className="u nowrap">Fixture</span>
          <span className="banner-t">
            No live round is being read. The round, the fight and the rosters below are a fixture
            replayed from a fixed seed — the same replay the chain runs, on invented entries — so the
            page stays reviewable between rounds. Nothing here is anyone&apos;s money.
          </span>
        </div>
      ) : null}

      {status.roundError ? (
        <div className="banner banner--quiet" role="status">
          <span className="u nowrap">Round</span>
          <span className="banner-t">{status.roundError}</span>
        </div>
      ) : null}

      {history.error ? (
        <div className="banner banner--quiet" role="status">
          <span className="u nowrap">History</span>
          <span className="banner-t">{history.error}</span>
        </div>
      ) : null}
    </>
  );
}

function Screen({ view }: { view: ViewId }) {
  switch (view) {
    case "leaderboard":
      return <LeaderboardView />;
    case "dashboard":
      return <DashboardView />;
    case "referrals":
      return <ReferralsView />;
    case "history":
      return <HistoryView />;
    case "arena":
    default:
      return <ArenaView />;
  }
}

function Shell() {
  const [view, setView] = useState<ViewId>("arena");
  const [rail, setRail] = useState<Rail>(null);
  const [intro, setIntro] = useState(() => {
    try {
      return localStorage.getItem(INTRO_KEY) !== "1";
    } catch {
      return true; // Storage blocked (private mode, embedded frame) — show it rather than swallow it.
    }
  });

  const closeIntro = useCallback(() => {
    setIntro(false);
    try {
      localStorage.setItem(INTRO_KEY, "1");
    } catch {
      /* Nothing to do: the takeover just returns next visit. */
    }
  }, []);

  // Changing screens with a fighter open would leave the rail describing something the new screen
  // isn't showing.
  useEffect(() => {
    setRail((r) => (r?.kind === "fighter" ? null : r));
  }, [view]);

  // One Escape does one thing, innermost first: the takeover sits above the rail, so it goes first.
  const handleEscape = useCallback(() => {
    if (intro) {
      closeIntro();
      return true;
    }
    let had = false;
    setRail((r) => {
      had = r !== null;
      return null;
    });
    return had;
  }, [intro, closeIntro]);

  useKeyboardNav({ setView, onEscape: handleEscape, blocked: intro });

  const shell = useMemo<ShellApi>(
    () => ({
      view,
      setView,
      rail,
      setRail,
      inspectedWallet: rail?.kind === "fighter" ? rail.wallet : null,
    }),
    [view, rail],
  );

  return (
    <ShellContext.Provider value={shell}>
      <TopChrome />

      {/* BEFORE `main`, AND THAT IS THE WHOLE REASON IT IS HERE. This bar carries `<nav aria-label=
          "Screens">` — the only way to move between the five screens without knowing the digit
          shortcuts — and it used to be rendered after the page, which put it LAST in the tab order:
          on Arena a keyboard user passed 56 controls before reaching the screen navigation, and the
          shortcuts that mitigate that are printed as `[00]` in the nav they cannot reach yet.
          Both bars are `position: fixed` with the same `z-index: 80` and they do not overlap (one is
          `top: 0`, the other `bottom: 0`, see base.css), so DOM order buys layout nothing and costs
          paint nothing — it buys the conventional order: chrome, navigation, content. */}
      <BottomChrome />

      {/* Inside `main`, and first: the strip itself is `position: fixed` so its place in the DOM is
          immaterial, but the anchor it reveals itself from is a flow element that has to start at the
          top of the page's content to measure a scroll depth from it. Keeping the two together means
          the reveal rule lives entirely in one file instead of being half a component and half a
          sentinel someone else remembers to render. */}
      <main className="page">
        <StickyStatus />
        <Notices />
        <Screen view={view} />
      </main>

      <SideRail />
      <ToastRail />
      {/* After the toast rail: the dock measures that column to stay clear of it on narrow screens,
          so the element has to exist by the time the dock's effects run. */}
      <StakeDock />
      {intro ? <IntroOverlay onClose={closeIntro} /> : null}
    </ShellContext.Provider>
  );
}

export function App() {
  return (
    <ArenaProvider>
      <Shell />
    </ArenaProvider>
  );
}
