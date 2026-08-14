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
import { KeeperStatusProvider } from "./ui/KeeperStatusProvider.tsx";
import { SideRail } from "./ui/SideRail.tsx";
import { StakeDock } from "./ui/StakeDock.tsx";
import { StickyStatus } from "./ui/StickyStatus.tsx";
import { ToastRail } from "./ui/ToastRail.tsx";
import { useSharedKeeperStatus } from "./ui/keeperCadence.ts";
import { ShellContext, type Rail, type ShellApi } from "./ui/shell.ts";
import { useKeyboardNav } from "./ui/useKeyboardNav.ts";
import { REDUCED_MOTION, useMediaQuery } from "./ui/useMediaQuery.ts";
import "./ui/shell.css";

import { ArenaView } from "./views/ArenaView.tsx";
import { DashboardView } from "./views/DashboardView.tsx";
import { HistoryView } from "./views/HistoryView.tsx";
import { LeaderboardView } from "./views/LeaderboardView.tsx";
import { ReferralsView } from "./views/ReferralsView.tsx";

const INTRO_KEY = "v2_intro_seen";

/**
 * THE OPERATOR IS PLAYING ITSELF, AND THE PAGE SAYS SO.
 *
 * The keeper has an opt-in mode in which it runs rounds continuously with nothing but its own wallets
 * in them (`KeeperStatus.keeper.houseOnlyRounds`). This page is public and reachable, so an arena that
 * is busy every minute of the day is a claim being made to whoever opens it — and without this line
 * the claim would be one nobody ever decided to make. It is the same failure the keeper status file
 * exists for, one layer out: not a wrong number, a wrong impression, drawn confidently.
 *
 * THE COPY IS MODE-SHAPED AND NEVER ROUND-SHAPED, which is the whole difficulty of this notice. A real
 * player can enter in this mode at any moment, and from that instant the round on screen holds a real
 * fighter and a real pot. "The fighters below are bots" would therefore be false on exactly the rounds
 * that matter most, and false in the direction that tells a player their own entry did not count. So
 * what is stated is what the OPERATOR is doing and what a visitor may not infer from a full lobby —
 * both of which are true whoever is standing in it. See `houseOnlyRounds`, where the same rule is
 * written down on the field itself.
 *
 * IT IS SILENT WHEN THE KEEPER IS DOWN OR ABSENT, and that is not the usual "no data, no banner"
 * reflex. A stale file is a claim about a process that has since stopped saying anything: nothing is
 * running rounds at all in that state, house or otherwise, so the sentence has no subject. Silence is
 * the direction this whole mechanism chooses whenever it cannot back what it would say.
 *
 * ITS OWN COMPONENT, NOT FOUR LINES INSIDE `Notices`, for the reason `KeeperStatusProvider.tsx` was
 * split out: a component that reads this context re-renders on every poll, twice a second, forever.
 * `Notices` is inside the provider's subtree — it renders under `<Shell />`, which is the provider's
 * child — so the alternative was never a second subscriber to the feed, it was waking the fixture line
 * and both error banners on a heartbeat that says nothing about any of them. This way the subscription
 * is scoped to the one element whose visibility actually depends on it.
 */
function HouseRoundsNotice() {
  const { status, stale } = useSharedKeeperStatus();
  if (status === null || stale || !status.keeper.houseOnlyRounds) return null;

  return (
    // `data-testid` for the same reason `RoundClockSlot` carries one: there is no structural selector
    // that finds this banner and nothing else — it is one of four `.banner--quiet` blocks this
    // component can render, distinguished from the other three only by the words in it. Selecting on
    // those words
    // would make an e2e test about WHETHER THE DISCLOSURE APPEARS fail the moment somebody improves
    // the sentence, which teaches the next person that the test is noise. The handle is stable; the
    // copy is free to move.
    <div className="banner banner--quiet" role="status" data-testid="house-rounds-notice">
      <span className="u nowrap">House rounds</span>
      <span className="banner-t">
        The operator is filling rounds with its own wallets so the arena keeps running between real
        players. A busy lobby here is not a crowd. It is not a claim about any particular round
        either — a real player can enter at any moment, and nothing in this notice says whether one
        has.
      </span>
    </div>
  );
}

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

      {/* Beside the fixture line rather than after the two error banners: both are DISCLOSURES about
          what the page is showing and where it came from, and they belong together and above the
          transient reports of something having gone wrong. */}
      <HouseRoundsNotice />

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

  // REOPENING IS NOT THE INVERSE OF DISMISSING, and that is why this does not touch `INTRO_KEY`.
  // The flag records "this browser has been shown the takeover unasked", which stays true forever
  // once it happens; asking to re-read the rules is a different act and must not re-arm the
  // first-visit behaviour. `BottomChrome` is the only caller — see the note there on why the route
  // back belongs in the bar that is on every screen and never scrolls away.
  const openIntro = useCallback(() => setIntro(true), []);

  /** WHETHER THE PAGE NARRATES THE FIGHT — see `ShellApi.commentary`.
   *
   *  DEFAULTED FROM `prefers-reduced-motion`, NOT GATED BY IT. `base.css` already kills every
   *  transition and animation under that preference, which covers everything that moves; a stack of
   *  commentary lines appearing and disappearing every few seconds is content that CHANGES ON ITS
   *  OWN, which no stylesheet rule can turn off and which is the same thing the preference is asking
   *  about. So the honest default there is off. It stays a control rather than a lock because the
   *  preference is about motion and not about interest: a reader who wants the fight narrated can
   *  still have it, and a reader who does not can switch it off whatever their system says.
   *
   *  `null` means nobody has touched the control, so the preference is followed LIVE — turning
   *  reduce-motion on in system settings mid-session silences the page on the next frame rather than
   *  on the next reload. Once the reader has pressed the toggle their answer is the answer, in both
   *  directions; a preference that kept overruling an explicit choice would be a control that does
   *  not work. */
  const reducedMotion = useMediaQuery(REDUCED_MOTION);
  const [commentaryChoice, setCommentary] = useState<boolean | null>(null);
  const commentary = commentaryChoice ?? !reducedMotion;

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
      openIntro,
      commentary,
      setCommentary,
    }),
    [view, rail, openIntro, commentary],
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
      {/* The keeper's status file, polled ONCE for the whole page — `ui/keeperCadence.ts` explains
          why it cannot be polled per phase-note, and `KeeperStatusProvider.tsx` why the `<Shell />`
          element is passed as a child rather than the hook being called inside it. Outside the
          shell's own state so a poll landing re-renders only the surfaces that show a countdown. */}
      <KeeperStatusProvider>
        <Shell />
      </KeeperStatusProvider>
    </ArenaProvider>
  );
}
