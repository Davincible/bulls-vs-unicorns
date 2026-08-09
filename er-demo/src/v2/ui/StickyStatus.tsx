// THE SCROLL-REVEALED STATUS STRIP.
//
// The arena page is eight stacked sections tall. 00-1 prints the round's headline facts and 00-2
// draws the fight, and both are gone by the time a player is reading a roster, the standings or the
// provably-fair block — at which point the page stops telling them what is happening to their money.
// This strip is the answer: the round's SCORE (the two sides' totals) and its PROGRESS (phase, the
// fight clock, the step cursor), pinned under the top chrome from the moment the hero leaves.
//
// WHY IT IS NOT ALWAYS ON. At the top of the page the hero and the canvas overlay already carry
// every figure in here, twice over. A bar that duplicated them there would be pure chrome — and,
// being `position: fixed`, it would also cover the first 40px of the section it was duplicating.
//
// WHY IT IS NOT IN THE TOP CHROME. The black bar already carries the phase, the clock and a
// step-budget gauge, and it is 30px tall with a marquee in it — there is no room there for two money
// figures and a split bar, and widening it would push the whole page down for the sake of a readout
// that is only wanted once you have scrolled.
//
// PHASE HONESTY. Outside Fight nothing is ticking, so nothing in here is allowed to imply that it
// is: the clock slot shows what the phase actually has (entries in Lobby, the seed in Drawing, the
// winner and the length the fight ran once Settled) rather than `0:00` next to a live-looking rule.

import { useEffect, useRef, useState } from "react";
import { FIGHT_TIMEOUT_SECONDS, MAX_STEPS, SIDE_TOKEN, clock, sideTotals, usdCompact } from "../contract.ts";
import { useArena } from "../data/useArena.ts";
import { Bar } from "./primitives.tsx";
import { useShell } from "./shell.ts";

/** One label/figure pair in the right-hand group. The label is what keeps the bar honest — a bare
 *  `1:23` beside a clock-shaped `0:37` is two different facts wearing the same clothes. */
function F({ name, value }: { name: string; value: string }) {
  return (
    <span className="sbar-f">
      <span className="u">{name}</span>
      <span className="num">{value}</span>
    </span>
  );
}

export function StickyStatus() {
  const { live, status } = useArena();
  const { view } = useShell();
  const [scrolledPast, setScrolledPast] = useState(false);

  // PINNED OPEN OFF THE ARENA SCREEN (Max's direction: "that bar should always be visible if you are
  // on any other page that is not the main game page, so you can always see what's going on").
  //
  // The scroll trigger exists because on 00 ARENA the strip is a DUPLICATE: the hero figure and the
  // strength bar are right there, and showing both at once is the same fact twice. Nothing on the
  // leaderboard, dashboard, referrals or history screens carries the live score at all — so on those
  // there is nothing to duplicate and no reason to make someone scroll to earn it. A round can settle
  // while you are reading the all-time table, and that is exactly when you want to see it happen.
  // PINNED means shown from the first paint rather than revealed by scrolling — true on every screen
  // that isn't the arena. It decides both what the strip does and what the page reserves for it.
  const pinned = view !== "arena";
  const shown = pinned || scrolledPast;

  // HOW THE REVEAL IS TRIGGERED — by the element this strip DUPLICATES, not by a distance.
  //
  // It used to observe an anchor of its own, a zero-height box extending `--sbar-reveal` down the
  // page, because this file could not edit the arena view. That is a scroll distance pretending to
  // be a relationship: at 78vh the strip arrived long after the strength bar had gone, and at 20vh it
  // arrived while the bar was still on screen, showing the same side totals twice. No constant is
  // right, because the thing it should track is where an element ends, and that moves with the
  // viewport, the board style and the fighter count.
  //
  // So the arena view marks the strength bar `data-sbar-trigger` and this observes it: the strip
  // appears exactly as that bar leaves, and the page never shows both. The attribute is the contract
  // and it is commented at the other end too.
  //
  // NO TRIGGER MEANS SHOW IMMEDIATELY, which is what the other four screens want: none of them
  // carries the live score at all, so there is nothing to duplicate and no reason to make someone
  // scroll to earn it. `view` is in the deps because the trigger appears and disappears with it.
  //
  // An IntersectionObserver rather than a scroll listener: during a fight this page is already
  // re-rendering at the poll rate, and a scroll handler running on every frame of a flick would be
  // competing with the canvas for the main thread to answer one boolean.
  useEffect(() => {
    if (view !== "arena") {
      setScrolledPast(false);   // reset, so returning to the arena starts hidden again
      return;
    }
    const el = document.querySelector("[data-sbar-trigger]");
    // Defensive, not expected: if the arena ever renders without its strength bar, a strip that
    // never appears is a quieter failure than one pinned over the hero.
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setScrolledPast(!last.isIntersecting);
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [view]);

  // PUBLISH THIS BAR'S HEIGHT so anything that has to sit clear of it can. It is `position: fixed`
  // directly under the top chrome, and it is CONTENT-SIZED: ~40px on a wide screen, ~62px on a phone
  // where its three groups wrap. The leaderboard's sticky column header is the thing that collided —
  // it was written as `calc(var(--chrome-h) + var(--sbar-h, 0px))` precisely so this could complete
  // it, rather than that file hard-coding a 62px that is wrong at every other width.
  //
  // Measured, not assumed, and re-measured on resize: the wrap point depends on the content (a
  // six-figure pot is wider than a three-figure one), so no breakpoint could predict it. The fallback
  // in that `calc` means a consumer degrades to "no offset" rather than to a wrong one if this
  // component never mounts.
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const publish = () => {
      // Round up: a fractional px leaves a hairline of table header peeking out from under the bar,
      // which reads as a rendering fault rather than as a 0.4px difference.
      const h = Math.ceil(el.getBoundingClientRect().height);
      const root = document.documentElement;
      root.style.setProperty("--sbar-h", `${h}px`);
      // AND HOW MUCH THE PAGE OWES IT. Two different questions, and conflating them was the bug:
      // `--sbar-h` is "how tall is this strip" and is what a sticky table header offsets against
      // whether or not the strip is currently visible. `--sbar-pad` is "how much room must the page
      // reserve at the top", which is only non-zero when the strip is pinned open from the first
      // paint — the four screens that always show it. On the arena the strip is revealed by
      // scrolling, so by the time it exists the content it would have covered has already moved up,
      // and reserving space there would leave a permanent gap under the chrome instead.
      root.style.setProperty("--sbar-pad", pinned ? `${h}px` : "0px");
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--sbar-h");
      document.documentElement.style.removeProperty("--sbar-pad");
    };
  }, [pinned]);

  const fighters = live?.fighters ?? [];
  const [aTot, bTot] = sideTotals(fighters);
  const total = aTot + bTot;
  const aPct = total > 0n ? (Number(aTot) / Number(total)) * 100 : 50;
  const phase = live?.phase ?? null;
  const steps = live?.stepsNow ?? 0;

  // One word. The strip is 40px tall and has three groups to fit; the sentence version of each phase
  // ("Lobby — deposits open") lives in 00-1 and on the dock, both of which have room for it.
  const phaseWord = phase ?? (status.loading ? "Loading" : "No round");

  return (
    <>
      {/* `role="region"`, NOT `role="status"`. A status role is an implicit polite live region, and
          during a fight every figure in here changes several times a second — a screen reader would
          be read a fresh scoreboard continuously and never finish a sentence. As a labelled region
          it is navigable on demand, which is what a persistent readout should be. Hidden from the
          accessibility tree and the tab order entirely while it is off screen. */}
      <div
        ref={barRef}
        className={`sbar${shown ? " sbar--on" : ""}`}
        role="region"
        aria-label="Round status"
        aria-hidden={!shown}
      >
        <div className="sbar-in">
          <span className="sbar-id">
            <span className="idx">R{status.roundNo === null ? "—" : status.roundNo.toString()}</span>
            <span className="u u--ink nowrap">{phaseWord}</span>
          </span>

          {/* The score, in the vocabulary 00-2 already established: side total, split bar, side
              total. Same element, same colour rules, a third of the height — a second way of drawing
              the same fact would make the two disagree at a glance. */}
          {/* A 40px-tall strip pinned above every other section on the page — the tightest fixed
              track here, so both side totals and the aria-label restating them for a screen reader
              compact together rather than one giving a truncated figure and the other the real one. */}
          <span className="sbar-score">
            <span className="num sbar-a">{live ? usdCompact(aTot) : "—"}</span>
            <span
              className="split sbar-split"
              role="img"
              aria-label={`${SIDE_TOKEN[0].name} holds ${usdCompact(aTot)}, ${SIDE_TOKEN[1].name} holds ${usdCompact(bTot)}`}
            >
              <span className="split-a" style={{ width: `${aPct}%` }} />
              <span className="split-b" style={{ width: `${100 - aPct}%` }} />
            </span>
            <span className="num sbar-b">{live ? usdCompact(bTot) : "—"}</span>
          </span>

          <span className="sbar-prog">
            {phase === "Fight" && live ? (
              <>
                <F name="Clock" value={clock(live.elapsedSec)} />
                <F
                  name="Step"
                  value={`${steps.toLocaleString("en-US")}/${MAX_STEPS.toLocaleString("en-US")}`}
                />
                {/* Not a countdown to the end of the fight — the round can be settled the moment one
                    side has nobody standing. The bell is the outer bound, and `resolvable` is the
                    fact that beats it. */}
                <F
                  name={live.resolvable ? "Settle" : "Bell"}
                  value={
                    live.resolvable
                      ? "ANYONE MAY"
                      : clock(Math.max(0, FIGHT_TIMEOUT_SECONDS - live.elapsedSec))
                  }
                />
              </>
            ) : phase === "Settled" && live ? (
              <>
                <F name="Winner" value={live.winner === null ? "—" : SIDE_TOKEN[live.winner].name} />
                <F name="Ran" value={clock(live.elapsedSec)} />
                <F name="Steps" value={steps.toLocaleString("en-US")} />
              </>
            ) : phase === "Drawing" && live ? (
              <>
                <F name="Entered" value={String(live.fighters.length)} />
                <F name="Pot" value={usdCompact(live.pot)} />
                <F name="Seed" value="DRAWING" />
              </>
            ) : phase === "Lobby" && live ? (
              <>
                <F name="Entered" value={String(live.fighters.length)} />
                <F name="Pot" value={usdCompact(live.pot)} />
                <F name="Fight" value="NOT STARTED" />
              </>
            ) : (
              <F name="Round" value="—" />
            )}
          </span>
        </div>

        {/* The fight's position between the opening bell and the chain's own step ceiling, as the
            same hairline `Bar` the rest of the page measures things with. It sits on the strip's
            bottom edge so the bar itself doubles as the rule that separates the strip from the page.
            In Lobby and Drawing `stepsNow` is 0 and it draws empty, which is the truth. */}
        <Bar value={BigInt(steps)} max={BigInt(MAX_STEPS)} />
      </div>
    </>
  );
}
