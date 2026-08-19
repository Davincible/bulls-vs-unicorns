// 00 ARENA — the screen the whole page exists for.
//
// Ordering is by what a player has to know, in the order they have to know it: what is on the table
// (00-1), what is happening to it (00-2), what they can do about it right now (00-3), who is in it
// (00-4), how everyone stands (00-5, 00-6), and why any of it can be believed (00-7). Every figure
// on this screen is either read off the chain or marked; nothing is inferred to fill a gap.
//
// The canvas is a pure white field with black detail (SPEC.md's canvas contract). Its border, its
// strength bar, its phase tag, the your-position HUD and the settled banner all belong to THIS file
// — the canvas draws the fight, this file draws the instrument around it.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ARENAS,
  EXTRACT_PENALTY_START_BPS,
  FIGHT_TIMEOUT_SECONDS,
  MIN_STAKE_USD,
  ONE_CENT_UNITS,
  SIDE_TOKEN,
  STAKE_CAP_USD,
  STAKE_PRESETS,
  UNITS_PER_USD,
  bpsPct,
  clock,
  counted,
  entriesOpen,
  feeOn,
  finalCursor,
  shortKey,
  sideTotals,
  stepsPerSecond,
  usd,
  usdToUnits,
  worth,
  type ArenaMeta,
  type BoardStyle,
  type FighterView,
  type Mode,
  type Side,
} from "../contract.ts";
import { useArena } from "../data/useArena.ts";
import { useLinks } from "../data/useLinks.ts";
import { namePlate, plateText } from "../data/namePlate.ts";
import type { LinkMap } from "../data/xLink.ts";
import { sessionNote } from "../data/autoSession.ts";
import { abandonText, simBankrollUsd, type AmountRule } from "../data/autoDeploy.ts";
import { feePhrase } from "./feeCopy.ts";
import { ShowMore } from "./ShowMore.tsx";
import { capRows, ROW_CAP, ROW_CAP_PROOF, ROW_CAP_RECENT } from "./rowCap.ts";
import { ArenaCanvas } from "../arena/ArenaCanvas.tsx";
import { CombatLog } from "../ui/CombatLog.tsx";
import { Bar, Dash, Empty, KV, KVs, Mark, Money, Section, Seg, Tag } from "../ui/primitives.tsx";
import { RoundClockSlot } from "../ui/RoundClockSlot.tsx";
import { RoundPhaseNote } from "../ui/RoundPhaseNote.tsx";
import { useDrawWatch } from "../ui/useDrawWatch.ts";
import { useFullscreen } from "../ui/useFullscreen.ts";
import { NARROW, useMediaQuery } from "../ui/useMediaQuery.ts";
import { useRoundPhase } from "../ui/useRoundPhase.ts";
import { useSecondTick } from "../ui/useSecondTick.ts";
import { TokenIcon } from "../ui/TokenIcon.tsx";
import { useShell } from "../ui/shell.ts";
import "./ArenaView.css";

/** The extract penalty at the opening bell, as the page says it out loud ("20%"). The rate itself is
 *  never computed here — `data/extractTerms.ts` owns that, against the one correct cursor. */
const START_PENALTY = bpsPct(Number(EXTRACT_PENALTY_START_BPS));

/** WHAT THE HOUSE TAKES, rendered without lying at either end of the range.
 *
 *  `usd()` at two decimal places prints a real sub-cent charge as `$0.00` — "the house takes
 *  nothing" said about a player who is about to be charged something — and the penalty spends the
 *  last stretch of every fight down there, because the rate is decaying toward zero exactly while
 *  the hp it applies to is being whittled down. An EXACTLY zero penalty is a different fact (the
 *  curve arriving at its end, or the program's integer division flooring a small remainder) and is
 *  the one case that must not wear a minus sign.
 *
 *  IT DOES NOT COMPACT, and neither does `keepText`. 00-3.1 is a LEDGER — what leaves your ring,
 *  what you keep, what the house takes — and the three figures are meant to be added up by the
 *  person reading them. `contract.ts`'s `usdCompact` would round `$13,215` to `$13.2k` and leave a
 *  reader checking the split against a $50 hole that is an artefact of the formatter. The sub-cent
 *  BOUND is shared with it (`ONE_CENT_UNITS`); the resolution above a cent is not. */
function penaltyText(units: bigint): string {
  if (units === 0n) return usd(0n, 2);
  return units < ONE_CENT_UNITS ? "−<$0.01" : `−${usd(units, 2)}`;
}

/** WHAT YOU KEEP, with the same floor problem and the same answer.
 *
 *  Caught on a real devnet round, not in review: a fighter whittled down to dust was still alive and
 *  still extractable, and this button read `BANK $0.00` — an offer to bank nothing, made to someone
 *  who genuinely had something. It is the mirror of `penaltyText`'s case and deserves the mirror of
 *  its fix. An exactly-zero keep is a different fact (no fighter, or nothing left) and prints plainly
 *  — the callers that can hit that case render `—` instead anyway. */
function keepText(units: bigint): string {
  if (units === 0n) return usd(0n, 2);
  return units < ONE_CENT_UNITS ? "<$0.01" : usd(units, 2);
}

/** Health as a percentage of what a fighter started with. Display-only; never fed back into a
 *  figure that claims to be chain state. */
function healthPct(f: FighterView): number {
  return f.stake > 0n ? Math.max(0, Math.min(100, (Number(f.hp) / Number(f.stake)) * 100)) : 0;
}

function pnlOf(f: FighterView): bigint {
  return worth(f) - f.stake;
}

/** The pace THIS round runs at. It is per-fighter (`n * 2`), not a constant: a 2-fighter duel and a
 *  16-fighter brawl cannot share one rate, and a caption quoting a fixed number would be describing
 *  a fight the chain is not running. */
function paceLine(fighterCount: number): string {
  const rate = stepsPerSecond(fighterCount);
  return `${rate} steps/sec · 2 per fighter · stops at ${finalCursor(fighterCount).toLocaleString("en-US")}`;
}

/** Provenance for anything derived from the round on screen. It is only `chain` when the provider
 *  actually read a round account — between rounds the same layout is driven by the fixture, and a
 *  section that still claimed "chain" then would be the exact lie this page is built not to tell. */
function RoundTag() {
  const { source } = useArena();
  return <Tag kind={source === "chain" ? "live" : "fixture"} />;
}

/** A P/L figure. Zero is real data — it prints as a plain, unsigned, quiet `$0.00`, because a
 *  column of `+$0.00` before a fight has started reads as nine tiny wins.
 *
 *  COMPACT, because every slot this renders into is a fixed-width one: the standings column, the
 *  previous-rounds column, the position HUD on the canvas and the settled plate. `Money` carries the
 *  exact figure through on a `title` wherever compacting actually changed the string. */
function Pnl({ value }: { value: bigint }) {
  if (value === 0n) return <span className="num dim">{usd(0n)}</span>;
  return <Money units={value} signed compact />;
}

// =============================================================================================
// 00-1 THE ROUND
// =============================================================================================

function TheRound() {
  const { live, status } = useArena();
  // THE SAME DECISION THE CLOCK ITSELF IS RENDERING, one line below — `RoundClockSlot` prints the
  // figure, and this is the two-to-four words that say WHICH figure it is. Both come out of one
  // `useRoundPhase()` object, so the label and the number it labels cannot end up describing
  // different phases of the round. See `ClockSlot#caption`.
  const { clockSlot } = useRoundPhase();
  const fighters = live?.fighters ?? [];
  const [aTot, bTot] = sideTotals(fighters);
  const alive = fighters.filter((f) => !f.dead).length;

  // THE TILE AND THE BIG CLOCK SWAPPED CONTENTS, and this is the other half of that move.
  //
  // The clock above used to count the fight UP and this tile counted the bell DOWN. The clock now
  // counts the bell down (Max: "we need a counter that counts down how much time is still
  // remaining"), which would have put the identical figure on screen twice in one section — so the
  // elapsed time the clock gave up lands here rather than being deleted. It is a real fact and the
  // one the step cursor below is measured against; it is simply not the fact a person reads a clock
  // to get.
  //
  // The two states that outrank a duration keep the cell, exactly as before: a settled round shows
  // who won, and a settleable one shows that the extract race is on. That flag beats any number,
  // because it IS the answer to "how much longer" — there is no longer, it can go at any moment.
  const settleKv =
    live?.phase === "Settled" && live.winner !== null
      ? {
          value: SIDE_TOKEN[live.winner].name,
          label: "Winner",
          title: `${SIDE_TOKEN[live.winner].name} took round ${live.roundNo.toString()}.`,
        }
      : live?.resolvable
        ? {
            value: "ANYONE MAY",
            label: "Settle now",
            title: `A round can be settled by anyone once one side has nobody left standing, or once the ${FIGHT_TIMEOUT_SECONDS}s bell rings. Both are true of this one now — that moment, not a fixed countdown, is the deadline an extract is racing.`,
          }
        : live?.phase === "Fight"
          ? {
              value: clock(live.elapsedSec),
              label: "Fight time",
              title: `How long this fight has been running. The clock above is the other half of it — the most it can still run before the ${FIGHT_TIMEOUT_SECONDS}s bell, which is a ceiling and not a forecast.`,
            }
          : {
              value: <Dash />,
              label: "Fight time",
              title: "No fight has run in this round yet.",
            };

  return (
    <Section
      index="00-1"
      title="The round"
      tools={
        <>
          <RoundTag />
          <span className="u">
            Round {status.roundNo === null ? "—" : status.roundNo.toString()}
          </span>
        </>
      }
    >
      <div className="hero-marks">
        <div className="hero">
          <div>
            {/* THE ONE FIGURE ON THIS SCREEN THAT DOES NOT COMPACT. It is the pot: the whole of what
                is on the table, stated once, at 76px, as the answer to why anyone is here. Every
                other money slot on the page is a cell in a grid competing with four more like it and
                takes `usdCompact`; this one has a `1fr` track to itself and is the number a reader
                is meant to READ rather than scan. `$13.5T` would be a headline that refuses to say
                how much. The cell it sits in is `min-width: 0` so a long pot wraps inside its own
                column instead of pushing the clock beside it off the page — see ArenaView.css.

                A `div`, NOT the `<h3>` it used to be. It is set at 76px because it is the biggest
                fact on the page, and size was mistaken for outline: a dollar amount is a figure, not
                the title of a section, and marking it up as one put "$353.00" into the document's
                heading list between "The round" and "The arena". The section already has its outline
                node — `<h2>The round</h2>`, one line above, from `Section`. `.display` is a class and
                carries its own `margin: 0`, so the box is unchanged. */}
            <div className="display display--mono">{live ? usd(live.pot, 2) : "—"}</div>
            <p className="u" style={{ marginTop: 14 }}>
              Pot on the table · {counted(fighters.length, "fighter")} · {alive} still alive
            </p>
            {/* WHEN IT CHANGES, IN WORDS, AT THE TOP OF THE PAGE — and this is the surface that owed
                it. The hero prints the round's headline facts above the fold, and the only thing it
                had to say about time was a fight clock reading `0:00` through the whole of a lobby.
                The clock slot beside this now says `OPEN` there instead, which is honest but is one
                word; this is the sentence behind that word, and it is the same sentence the dock and
                the plate on the field render, from the same object. `showLabel` is off because
                `.hero-phase` is already the label two lines to the right, and `announce` is off
                because the dock is the one instance that speaks (see RoundPhaseNote). */}
            <div style={{ marginTop: 12 }}>
              <RoundPhaseNote detail="timing" showLabel={false} announce={false} />
            </div>
          </div>
          <div className="hero-r">
            <div className="hero-phase">
              {live ? live.phase : status.loading ? "Loading" : "No round"}
            </div>
            {/* NOT `clock(elapsedSec)` ANY MORE — see `RoundClockSlot`. This was the biggest of the
                three `0:00`s: 19px of stopped clock directly under the word LOBBY, which is the
                reading a visitor forms of the whole arena. During a fight it now counts the bell
                DOWN rather than the fight up; the label under it is not decoration, it is what makes
                a descending figure legible as a ceiling rather than a promise. */}
            <div style={{ marginTop: 8 }}>
              <RoundClockSlot className="num num--lg" />
            </div>
            {/* WHAT USED TO BE HERE, AND WHY IT IS NOT.
                `0 / 15,840 steps`. Max: "we have the number of steps, which is currently 15,000,
                which seems like a lot and very high." Both halves of that ratio are honest and
                neither is legible: the ceiling is `finalCursor(n) = 360n`, so it is a function of how
                many people happen to have joined — 15,840 at 44 fighters, 720 at a duel — and a
                reader has no way to know that the number doubling means the room filled up rather
                than the fight getting longer. It is the chain's own unit and it is the unit the
                replay actually runs on, so it is not deleted: it keeps the field's own metadata
                column (`.ovl--tl`, where it is labelled and has a title explaining the rate) and the
                KV row below states the chain's settled `tick_count` verbatim. What it must not be is
                the caption on the biggest clock on the page.
                WHAT IS HERE INSTEAD is that clock's own label, from the same decision object the
                figure came from. A number that counts down names an instant, and every reading of it
                depends on which instant — so the words travel with the figure rather than being
                written out at each of the surfaces that draw it. */}
            <div className="u" style={{ marginTop: 6 }} title={clockSlot.title}>
              {clockSlot.caption}
            </div>
          </div>
        </div>
      </div>

      <KVs>
        {/* Compact: a `.kv` tile is one column of a five-across grid, and a side total is the LARGEST
            figure on the screen — it is the sum of every fighter on that side. The tile with the
            widest number would otherwise set the width of all five. `Money` puts the exact total on
            the tile's own title; the sentence below it is appended so hovering still explains what
            the figure IS as well as what it is exactly. */}
        <KV
          value={<Money units={aTot} compact />}
          label={`${SIDE_TOKEN[0].name} · side 0`}
          title={`${usd(aTot, 2)} — total value this side is holding right now: hp still in the ring plus anything banked.`}
        />
        <KV
          value={<Money units={bTot} compact />}
          label={`${SIDE_TOKEN[1].name} · side 1`}
          title={`${usd(bTot, 2)} — total value this side is holding right now: hp still in the ring plus anything banked.`}
        />
        <KV
          value={<span className="num">{live ? live.fighters.length : "—"}</span>}
          label="Fighters entered"
        />
        <KV
          value={
            <span className="num">
              {live?.tickCount ? live.tickCount.toString() : <Dash />}
            </span>
          }
          label="On-chain step count"
          title="What the chain itself has written. It stays 0 until a tick or a resolve advances the round on chain — the clock above is this browser's own read of the same fight."
        />
        {/* THE FIGHT'S OWN DURATION, and the two states that outrank it — see `settleKv`. Deliberately
            not a countdown in any of the three: the countdown is the clock in the hero, stated once,
            and a round becomes settleable when one side has nobody left standing OR when the bell
            rings, whichever comes first. A second countdown here would be the same ceiling implying a
            second, different deadline. */}
        <KV
          value={<span className="num">{settleKv.value}</span>}
          label={settleKv.label}
          title={settleKv.title}
        />
      </KVs>
    </Section>
  );
}

// =============================================================================================
// 00-2 THE ARENA
// =============================================================================================

function StrengthBar({ a, b }: { a: bigint; b: bigint }) {
  const total = a + b;
  const aPct = total > 0n ? (Number(a) / Number(total)) * 100 : 50;

  return (
    <>
      {/* THE TRIGGER FOR THE STICKY STRIP. `ui/StickyStatus.tsx` reveals itself when this element
          leaves the top of the viewport, because this is the thing it duplicates: side totals and the
          split bar. Showing both at once is the same fact twice, and revealing after an arbitrary
          scroll distance meant the strip either arrived while this was still on screen or long after
          it had gone. The attribute is the contract between the two files; it is documented at the
          observer's end too. */}
      <div className="str-head" data-sbar-trigger>
        {/* The coin's own artwork stands in for the side marker here: at the head of the strength
            bar there is room for it, and it names the community fighting rather than restating a
            colour key the bar underneath already carries. */}
        <div className="line" style={{ gap: 8 }}>
          <TokenIcon token={SIDE_TOKEN[0]} size="md" />
          <span className="u u--ink">{SIDE_TOKEN[0].name}</span>
          <Money units={a} compact />
        </div>
        <div className="line" style={{ gap: 8, justifyContent: "flex-end" }}>
          <Money units={b} compact />
          <span className="u u--ink">{SIDE_TOKEN[1].name}</span>
          <TokenIcon token={SIDE_TOKEN[1]} size="md" />
        </div>
      </div>
      {/* The ARIA label keeps the full figures. Compacting is a width fix, and a screen reader has no
          width to run out of — reading "thirteen point two k dollars" where the exact number is
          available and free would be the one place this trade buys nothing and costs something. */}
      <div
        className="split"
        role="img"
        aria-label={`${SIDE_TOKEN[0].name} holds ${usd(a, 2)}, ${SIDE_TOKEN[1].name} holds ${usd(b, 2)}`}
      >
        <span className="split-a" style={{ width: `${aPct}%` }}>
          {aPct >= 18 ? `${aPct.toFixed(0)}%` : ""}
        </span>
        <span className="split-b" style={{ width: `${100 - aPct}%` }}>
          {100 - aPct >= 18 ? `${(100 - aPct).toFixed(0)}%` : ""}
        </span>
      </div>
    </>
  );
}

/** The counted version of the claim this whole migration rests on: the fight is stepped, so on-chain
 *  hp only moves when someone sends a permissionless `tick()` — and the tab watching the fight is
 *  what sends them. `undefined` means not applicable (fixture, or nothing driving), which is NOT the
 *  same as zero and must not be rendered as a "0 writes" readout. */
function ErWrites() {
  const { ticker, live } = useArena();
  // Only once there is a fight to advance. In a lobby there is nothing to tick, and a counter
  // reading zero there would look like a failure rather than an accurate nothing.
  if (!ticker || (live?.phase !== "Fight" && live?.phase !== "Settled")) return null;
  if (ticker.error) {
    return (
      <span className="u" style={{ color: "var(--hot)" }} title={ticker.error}>
        ER write failed — {ticker.error}
      </span>
    );
  }
  return (
    <span
      className="u u--ink"
      title={
        ticker.lastSignature
          ? `Last tick signature ${ticker.lastSignature}`
          : "This tab advances the fight on chain with permissionless tick() transactions."
      }
    >
      ER writes <span className="num">{ticker.ticksSent}</span> ·{" "}
      <span className="num">{ticker.stepsAdvanced.toLocaleString("en-US")}</span>{" "}
      {ticker.stepsAdvanced === 1 ? "step" : "steps"} advanced
    </span>
  );
}

/** THE ROUND'S TOP FIVE, ON THE FIELD.
 *
 *  WHY THIS IS NOT A SECOND STANDINGS TABLE. 00-5 already ranks every fighter in the round across
 *  eight columns, and it is good — but it is four sections below the frame, so for the whole of a
 *  fight the reader watching the field cannot see who is winning it. This is the same fact at a
 *  glance, in the corner of the thing it is about, and it deliberately stops at five rows: a sixteen
 *  row list over the field would be a table with a fight behind it.
 *
 *  IT IS PART OF THE TOP-LEFT OVERLAY, NOT THE EMPTY BOTTOM-LEFT ONE, and that is not where it
 *  started. `.ovl--bl` is the slot the design left for it, and the slot is not available: the
 *  shell's toast rail is `position: fixed; left: var(--gut); bottom: calc(var(--chrome-h) + 14px)`
 *  at `z-index: 110` (base.css), which is the same corner of the same screen whenever the field is
 *  the thing being watched, and it outranks any overlay inside the frame. Measured at 1440x1000
 *  mid-fight: the rail occupied x 24-323, y 888-956 against a leaderboard at x 24-269, y 837-970 —
 *  four of the five rows behind "You took $19.92 · 10 hits from 6 fighters". Raising this above the
 *  toasts would be the wrong trade in the other direction: a message telling a player they just lost
 *  money outranks a standings table. So the list moved to the one edge of the field that nothing
 *  else is pinned to, and the left column now answers the three questions in order — which round,
 *  how long is left, who is ahead.
 *
 *  RANKED BY `worth` (hp + banked), WHICH IS NOT WHAT 00-5 SORTS BY, AND THE DISAGREEMENT IS THE
 *  POINT. `worth` is what the discs on the canvas are sized by and what decides the round — so this
 *  list is a reading of the picture beside it, and a row moving up here is a disc that just got
 *  bigger. 00-5 sorts by P/L, which answers a different question (who is UP on what they put in) and
 *  is the right key for a ledger you scroll to on purpose. Two orderings of one set of fighters is
 *  only acceptable while each says which one it is, which is what the caption is for.
 *
 *  ONE SOURCE, SLIGHTLY BEHIND. Every figure here comes off `live.fighters` — the same array the
 *  rosters and 00-5 read — and never off `hitEvents` or the canvas's replay shadow, which run ahead
 *  of the poll by up to a sub-second of interpolation. `arena/replay.ts`'s header names the class of
 *  bug that would be: "two implementations of 'what does one hit do' is how the DUST-floor bug got
 *  in". A leaderboard a quarter-second behind the disc it describes is right; one that computes its
 *  own damage is a second opinion about the same fight, and eventually the two disagree in front of
 *  somebody's money.
 *
 *  DEAD AND EXTRACTED FIGHTERS STAY IN THE LIST. A fighter who extracted early and banked well is
 *  genuinely one of this round's leaders — that is the whole proposition of Extraction mode — and
 *  dropping them would report a leaderboard of "who is still on the field", which is a different
 *  claim under the same heading. They wear `.row--dead`'s quieter ink, the same tone the roster and
 *  00-5 give them, and their square goes neutral through `Mark`'s own `dead` — which is the page's
 *  established vocabulary and costs the side colour on those rows. That cost is real and worth
 *  stating: late in a round most of the top five may be out, and the list can end up with more grey
 *  squares than coloured ones. It is still the right trade, because a green square on a fighter who
 *  is no longer fighting would be the more misleading of the two, and the side survives for a screen
 *  reader in the mark's own label.
 *
 *  NOT INTERACTIVE, AND THAT IS A DECISION RATHER THAN AN OMISSION. Every row in 00-4 and 00-5 is a
 *  `role="button"` tab stop that opens the fighter in the rail, and copying that here would put five
 *  more stops on the path to the Deploy buttons and the Extract control — the two things on this
 *  screen a keyboard reader is most likely to be racing a clock to reach. The fighters in it are
 *  reachable as buttons in three places downstream, and the canvas behind it already opens any
 *  fighter on click. So it is a readout, not a control, and it costs the keyboard nothing.
 *
 *  It stays in the accessibility tree rather than being `aria-hidden` as a duplicate of 00-5: the
 *  caption immediately above it says what it is, and quietly deleting a surface for readers who
 *  cannot see the field is how a screen reader ends up on a different page from everyone else. */
/** THE NAME SLOT ON THIS SCREEN — one definition for the three fighter lists on it.
 *
 *  TEXT ONLY, AND `YOU` IN PLACE OF THE NAME. Every list here is a fixed-track row on or beside the
 *  field with no room for a face and no second cell to hold an orientation marker, so the slot is
 *  the only thing that can say which row is the reader's — which is `namePlate.ts`'s `"name-slot"`
 *  convention, and why a linked reader sees `YOU` here and their own `@handle` on the leaderboard.
 *  Everyone else sees their `@handle` if they have proved one and their address if they have not.
 *
 *  `.trunc` IS NOT DECORATION. A handle is up to sixteen glyphs with the `@`, an address is nine,
 *  and these tracks are fixed — see `ArenaView.css`'s note on `.lead`. The slot ellipsises rather
 *  than widening the row or pushing a money column out of its track. */
function FighterName({ f, links }: { f: FighterView; links: LinkMap }) {
  return (
    <span className="trunc">
      {plateText(namePlate(links, f.wallet, f.isYou ? "name-slot" : "unmarked"), f.short)}
    </span>
  );
}

function FieldLeaders({ fighters }: { fighters: FighterView[] }) {
  // READ, NEVER WAITED ON. `useLinks` is explicit that nothing on the board may gate on the identity
  // feed: this overlay renders completely and correctly while that fetch is outstanding, and every
  // fighter in it is simply unlinked until it lands. See `useLinks.ts`'s header.
  const { map } = useLinks();

  // A LEADERBOARD OF ONE IS NOT A RANKING — it is the only disc on the field, restated. Two is the
  // smallest lineup that expresses an order, and it is also the smallest a fight can have at all
  // (`abandon_round` ends a lobby that reaches its deadline with fewer), so the list appears exactly
  // when there is a contest and never as a caption with nothing under it. Returning `null` rather
  // than an empty list matters now that this block shares the clock's box: an empty one would still
  // print its own heading and still grow the rect `arena/chrome.ts` evicts the fight from.
  // `live === null` arrives here as an empty array from `TheArena` and is caught by the same line.
  if (fighters.length < 2) return null;

  // Stable by construction: `Array.prototype.sort` has been required to be stable since ES2019, so
  // fighters of equal worth — every fighter in a lobby where everyone staked the same, which is the
  // common case — hold their on-chain order rather than shuffling on every poll.
  const top = [...fighters]
    .sort((x, y) => {
      const d = worth(y) - worth(x);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    })
    .slice(0, 5);

  return (
    // NOT AN `.ovl` OF ITS OWN — a block inside the clock's box, separated by whitespace. Two
    // absolutely-positioned overlays cannot be stacked without hardcoding the height of the first,
    // and the first is a `clamp()` that resolves differently at every width; that hardcoded number
    // is precisely `arena/field.ts`'s `LABEL_SPACE` cautionary tale, told again. One box is also one
    // border in `survey`, one rect for `chrome.ts` to claim, and no seam between two claims for a
    // fighter's label to try to thread. The separator is whitespace rather than a hairline for a
    // mechanical reason as well as a stylistic one: a rule that existed in `survey` and not in
    // `blank` would change this box's height with the board style, which would move the ink claim
    // and shift every label on the field on a toggle that is documented to change nothing but the
    // look (see `.frame--blank` in ArenaView.css).
    <div className="ovl-lead">
      {/* AN UNLABELLED LIST OF FIVE NAMES IS A GUESS. The caption names the key in the page's own
          words — `worth` is `hp + banked` everywhere in `contract.ts` — and the title carries the
          part that will not fit: what it ranks, and why it is not the order 00-5 puts the same
          fighters in. */}
      <div
        className="u"
        style={{ marginBottom: 6 }}
        title="The five fighters holding the most value right now — hp still in the ring plus anything banked, which is what the discs on the field are sized by and what decides the round. Extracted and dead fighters keep their place: what they banked is still theirs. The full table in 00-5 ranks the same fighters by profit and loss instead, so the two orders differ on purpose."
      >
        Leaders · hp + banked
      </div>
      {top.map((f, i) => (
        <div key={f.wallet} className={`lead${f.isYou ? " row--you" : ""}${f.dead ? " row--dead" : ""}`}>
          <span className="idx">{(i + 1).toString().padStart(2, "0")}</span>
          {/* LABELLED, exactly as in 00-5 and for the same reason: this list mixes both sides, so
              the 7px square is the only thing on the row saying which one. The dead state is folded
              into the same label rather than given a column of its own — there is no room on the
              field for an `OUT` cell, and base.css's note on `.mk--dead` is explicit that the
              neutral square is only legal while something else still says it in words. Here that
              something is this string and the row's own tone. */}
          <Mark
            side={f.side}
            dead={f.dead}
            label={`${SIDE_TOKEN[f.side].name}${f.dead ? " · out" : ""}`}
          />
          {/* THE NAME GIVES WAY, NOT THE BOX. `.lead`'s name track is a fixed 118px (ArenaView.css
              explains why an overlay cannot afford a `1fr` here), so a name longer than the track
              ellipsises inside it rather than widening the panel mid-round. */}
          <FighterName f={f} links={map} />
          {/* Compact, like every other money figure in a fixed track on this page: 58px does not
              hold a chain figure in full, and `Money` puts the exact one on the cell's title. */}
          <Money units={worth(f)} compact className="r" />
        </div>
      ))}
    </div>
  );
}

function TheArena() {
  const { live, hitEvents, arenaId, setArenaId, board, setBoard, mode, sideRecord, status } = useArena();
  const { setRail, inspectedWallet, commentary, setCommentary } = useShell();
  // The pre-fight plate below says the same thing the dock and 00-3 say, from the same object.
  const phaseCopy = useRoundPhase();

  // THE FRAME IS WHAT GOES FULLSCREEN, not the canvas. The overlays, the phase tag, the position HUD
  // and the result plate are all children of this element and all belong on the field; fullscreening
  // the `<canvas>` alone would take the fight to the whole screen and leave every reading of it
  // behind on a page nobody can see. The canvas follows for free — `ArenaCanvas` sizes itself from a
  // `ResizeObserver` on its parent, so no React state is involved in the resize at all.
  const frameRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(frameRef);

  // How long the draw has been running, measured by this tab. `Phase::Drawing` has no on-chain exit;
  // see `useDrawWatch.ts` for why the measurement is local and what it is allowed to claim.
  const draw = useDrawWatch(live?.phase === "Drawing", live?.roundNo ?? null);

  const fighters = useMemo(() => live?.fighters ?? [], [live]);
  const [aTot, bTot] = sideTotals(fighters);
  const mine = fighters.find((f) => f.isYou) ?? null;
  const selectedId = useMemo(() => {
    if (!inspectedWallet) return null;
    const i = fighters.findIndex((f) => f.wallet === inspectedWallet);
    return i < 0 ? null : i;
  }, [fighters, inspectedWallet]);

  const onSelect = useCallback(
    (id: number) => {
      const f = fighters[id];
      if (f) setRail({ kind: "fighter", wallet: f.wallet });
    },
    [fighters, setRail],
  );

  const phase = live?.phase ?? "Lobby";
  const winner = live?.winner ?? null;

  return (
    <Section
      index="00-2"
      title="The arena"
      tools={
        <>
          <Seg<ArenaMeta["id"]>
            ariaLabel="Arena"
            value={arenaId}
            onChange={setArenaId}
            options={ARENAS.map((a) => ({
              id: a.id,
              label: a.label,
              disabled: !a.live,
              title: a.live ? "Live on devnet" : "Not deployed — this program runs one arena",
            }))}
          />
          {/* The board style. A LOOK, not a setting that changes anything — see `BoardStyle`. It sits
              beside the arena picker because both answer "what am I looking at", and it is a `Seg`
              rather than a checkbox because there are two named states and neither is the absence of
              the other. */}
          <Seg<BoardStyle>
            ariaLabel="Board style"
            value={board}
            onChange={setBoard}
            options={[
              { id: "survey", label: "Survey", title: "The instrument: lattice, registration crosses, frame, boxed overlays" },
              { id: "blank", label: "Blank", title: "Bare paper: no grid, no frame, overlays as plain text" },
            ]}
          />
          {/* THE PAGE'S VOICE, WITH AN OFF SWITCH. The commentary is content that appears and
              disappears on its own every few seconds, which is exactly what WCAG 2.2.2 asks for a
              way to stop — and no stylesheet rule can stop it, because nothing about it is a
              transition. It starts switched off under `prefers-reduced-motion` and follows that
              preference until somebody presses this, after which their answer is the answer (see
              App.tsx). A `Seg` rather than a checkbox for the same reason the board style is one:
              two named states, neither of which is the absence of the other. */}
          <span className="u">Voice</span>
          <Seg<"on" | "off">
            ariaLabel="Fight commentary"
            value={commentary ? "on" : "off"}
            onChange={(v) => setCommentary(v === "on")}
            options={[
              { id: "on", label: "On", title: "Tell me when I raid someone, when someone raids me, and when my fighter is out" },
              { id: "off", label: "Off", title: "Say nothing about the fight — the exchanges are still logged in 00-4.1" },
            ]}
          />
          {/* NOT RENDERED WHERE IT CANNOT WORK. `document.fullscreenEnabled` is false in an iframe
              without `allow="fullscreen"` and on iOS Safari, which has never supported element
              fullscreen — and this page's standing rule is that a button which reliably fails is
              worse than no button (see the in-page airdrop's note in SideRail.tsx). */}
          {fullscreen.supported ? (
            <button
              type="button"
              className="btn btn--sm"
              title="Take the field to the whole screen — Escape brings it back"
              onClick={fullscreen.toggle}
            >
              {fullscreen.active ? "Exit fullscreen" : "Fullscreen"}
            </button>
          ) : null}
          {/* A refusal has to be visible, or the button reads as broken. Kept until the next
              attempt rather than flashed — see `useFullscreen.ts`. */}
          {fullscreen.error !== null ? (
            <span className="u" style={{ color: "var(--hot)" }}>
              Fullscreen refused — {fullscreen.error}
            </span>
          ) : null}
        </>
      }
    >
      <StrengthBar a={aTot} b={bTot} />

      {/* The board style is carried by the FRAME, and the overlays inside it are styled off that one
          class (`.frame--blank .ovl`). Threading a modifier onto each overlay would be three places
          for the two halves of one look to fall out of step. */}
      <div ref={frameRef} className={`frame frame--${board}`}>
        <div className="frame-fill">
          {/* `clockSlot` IS THE FIELD'S CLOCK, NOW THAT THE FIELD DRAWS IT. The canvas sets it as the
              third row of the background scoreboard (`arena/scoreboard.ts`), and it is handed the
              same decision object `RoundClockSlot` renders, off the same `useRoundPhase()` this
              component already calls — so the ink on the field and the word in the accessibility
              tree below it cannot disagree about what the round is doing. */}
          <ArenaCanvas
            fighters={fighters}
            hitEvents={hitEvents}
            fightStartedAtMs={live?.fightStartedAtMs ?? null}
            phase={phase}
            board={board}
            sideRecord={sideRecord}
            clockSlot={phaseCopy.clockSlot}
            onSelect={onSelect}
            selectedId={selectedId}
          />
          {/* WHAT A `role="img"` CANVAS OWES A READER WHO CANNOT SEE IT.
              The clock is painted ink now, and no assistive technology can reach painted ink — the
              canvas is one opaque object with a summary label (see `ArenaCanvas`), and that summary
              is throttled and deliberately about the fight rather than about the round's clock. So
              the field's clock keeps a text alternative, and the alternative is the SAME component
              the other three slots use rather than a second reading of the same facts: one hook, one
              union, one answer, four surfaces.
              IT IS ALSO WHY THIS SCREEN STILL CARRIES THREE SLOTS. `e2e/clock.e2e.ts` asserts that
              every surface showing this figure asked `roundPhaseCopy.ts` for it, and the field is
              still one of those surfaces — it just prints its copy in pixels the DOM cannot be
              queried for. Deleting this node would not remove a clock from the page; it would remove
              the only handle the suite has on the largest one.
              NOT AN `.ovl`, deliberately: `arena/chrome.ts` claims every `.ovl` rect into the ink map
              and evicts the fight from it. `.sr` is a 1px clipped box with no class chrome looks
              for, so it costs the field nothing at any width — including below 560px, where the
              top-left overlay is gone entirely. */}
          <RoundClockSlot className="sr" />
        </div>

        {/* A COLUMN OF METADATA, AND IT NO LONGER HOLDS THE FIGURE IT WAS BUILT AROUND. It began as
            `LOBBY 0:00 0/4,000` on one 12px line, which made the round's clock the same size as the
            label beside it ("very hidden"); it then held an 88px clock as its second row; the clock
            is now background ink on the canvas itself, centred at the top of the field. What is left
            is exactly what this column was always for — what the figure is a clock OF (the phase and
            the round), how far through the fight it is (the step gauge), and who is winning it
            (`.ovl-lead`). It reads top to bottom as one sentence and answers the questions the
            watermark cannot. Below 560px the whole column is gone; see ArenaView.css. */}
        <div className="ovl ovl--tl">
          {/* WHICH ROUND, ON THE FIELD ITSELF. It was in 00-1's section tools and inside the centred
              plate — and the plate is gone the instant the fight starts, which is exactly when
              somebody screenshots the field or joins a stream mid-round and has nothing on it saying
              which round they are looking at. `status.roundNo` rather than `live.roundNo` because
              that is the field the provider publishes for this question: it is the round on screen
              when there is one and the arena's own counter when there is not (ArenaProvider), so it
              never goes blank between rounds. `—` and never `0` — a round number is chain data and
              a missing one is not round zero. */}
          <div className="ovl-line">
            <span className="u u--ink">{phase}</span>
            <span className="u">
              Round {status.roundNo === null ? <Dash /> : status.roundNo.toString()}
            </span>
          </div>
          {/* THE CLOCK IS NOT IN THIS COLUMN ANY MORE. It was here, at `clamp(34px, 8vw, 88px)`, and
              it is now the third row of the canvas's own background scoreboard — centred under
              `ROUNDS WON · N SETTLED`, behind the fighters, in the same ink family as the two side
              totals (`arena/scoreboard.ts`, band 2). Max's direction: "I want it in the background
              not in the foreground... it can be placed below the rounds and the settled number,
              relatively centred at the top."
              IT WAS REMOVED RATHER THAN SHRUNK, and that is the one call worth defending here. A
              small clock in this corner and a large one centred 200px away are two readings of one
              figure inside one frame, and the eye finds the disagreement even when the numbers agree
              — the money watermark has no small twin in an overlay, and neither should this. What is
              left in this column is metadata about the clock rather than a second copy of it: which
              phase, which round, how far through the steps, and who is ahead.
              The remaining slot on this screen is `.sr` beside the canvas — see it for why the count
              `e2e/clock.e2e.ts` asserts is still three. */}
          {/* WHAT THE FIGURE IN THE MIDDLE OF THIS FIELD IS. The watermark clock is the largest mark
              on the screen and it is the only one with no label attached to it — a `2:26` painted
              across the top of a fight is legible as a number and ambiguous as a fact, and now that
              it counts DOWN the ambiguity has a wrong reading available ("the fight ends in 2:26",
              which is true of about a quarter of them). This column is where that label belongs: it
              is already the metadata for the canvas, and `caption` comes off the same `ClockSlot` the
              canvas is handed, so the words and the ink cannot describe different rounds. */}
          <div className="ovl-line">
            <span className="u" title={phaseCopy.clockSlot.title}>
              {phaseCopy.clockSlot.caption}
            </span>
          </div>
          {/* THE STEP CURSOR, WHICH IS STILL WORTH PRINTING AND NO LONGER WORTH A HEADLINE.
              It was also the caption under 00-1's hero clock, where a reader meeting this page for
              the first time got `0 / 15,840 steps` as the second-largest fact about the round — a
              five-digit ratio in a unit nothing had introduced, whose ceiling moves with the size of
              the lobby rather than with anything about the fight. Max: "15,000 seems like a lot and
              very high."
              IT IS NOT DELETED, BECAUSE IT IS THE CHAIN'S OWN UNIT. `stepsNow` is the replay
              playhead, the cursor the extract penalty decays against, and the quantity the settled
              `tick_count` is checkable against — a real, verifiable fact, and the only one on this
              page that is measured in what the program actually counts. So it keeps the field's
              metadata column, where a reader who wants it can find it, with the noun attached and the
              round's own rate on its title (`paceLine`) explaining where a ceiling of 15,840 comes
              from. The ceiling stays per-lineup (`finalCursor(fighterCount)`): with no round in scope
              there is nothing honest to divide by, and printing a ceiling for a lineup of zero would
              claim a fight that isn't there. */}
          <div className="ovl-line">
            <span className="u" title={live ? paceLine(fighters.length) : undefined}>
              {live
                ? `${live.stepsNow.toLocaleString("en-US")}/${finalCursor(fighters.length).toLocaleString("en-US")} steps`
                : <Dash />}
            </span>
          </div>
          {/* WHO IS AHEAD, UNDER HOW LONG IS LEFT. The left edge of the field is one column and it
              reads top to bottom as one sentence: which round this is, how much of it is left, how
              far the fight has run, and who is winning it. It is hidden below 1100px — the centred
              plate reaches this column on a narrow field and the field cannot spare 13% of itself to
              five rows; both measurements are in ArenaView.css, and 00-5 downstairs carries every
              fighter in eight columns. See `FieldLeaders` for why it is not in the bottom-left
              corner the design left empty for it. */}
          <FieldLeaders fighters={fighters} />
        </div>

        <div className="ovl ovl--tr">
          {mine ? (
            <>
              <div className="ovl-line">
                <Mark side={mine.side} dead={mine.dead} />
                <span className="u u--ink">You · {SIDE_TOKEN[mine.side].name}</span>
              </div>
              {/* The position HUD is a hairline box pinned to the frame's own corner, capped at
                  `calc(100% - 24px)`. Three full-precision chain figures on one line would push it
                  across the width of the field it is sitting on top of. */}
              <div className="ovl-line">
                <span className="u">Ring</span>
                <Money units={mine.hp} compact />
                <span className="u">Banked</span>
                {mine.banked > 0n ? <Money units={mine.banked} compact /> : <span className="num">—</span>}
                <Pnl value={pnlOf(mine)} />
              </div>
            </>
          ) : (
            <div className="ovl-line">
              <span className="u">You are not in this round</span>
            </div>
          )}
        </div>

        {/* THIS PLATE IS A LIVE REGION AND THE ONE BELOW IT IS NOT, and the two must not be "made
            consistent" later. A round settling is an EVENT: it happens once, it is the answer to the
            question everyone in the round is holding, and it arrives without anybody doing anything —
            exactly what a polite live region is for. The lobby plate below is DESCRIPTION: the same
            facts as 00-1's hero and the phase note, rewritten every time anyone enters the round. */}
        {phase === "Settled" && winner !== null ? (
          <div className={`result result--${winner === 0 ? "a" : "b"}`} role="status">
            <div className="u" style={{ marginBottom: 8 }}>
              Round {live?.roundNo.toString()} · settled
            </div>
            <div className="h result-h">
              {SIDE_TOKEN[winner].name} takes the round
            </div>
            {/* Compact on the plate, full in 00-1's hero. The plate is a centred box floating over
                the field at `min(360px, 88%)` — and on a phone the frame is 4:3 and the plate is
                capped at `calc(100% - 24px)`, so a twenty-character pot is the difference between a
                result banner and a result banner with the number sticking out of both ends. The
                exact pot is one section up, at 76px, and on this figure's own title. */}
            <div className="line" style={{ justifyContent: "center", marginTop: 12, gap: 18 }}>
              {live ? <Money units={live.pot} compact /> : <span className="num">—</span>}
              <span className="u">pot</span>
              {mine ? (
                <>
                  <Pnl value={pnlOf(mine)} />
                  <span className="u">yours</span>
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Before the fight there is nothing moving on the field, and an empty 16:9 white rectangle
            reads as a broken canvas rather than as a lobby. The same centred plate the result uses
            says what the round is waiting for — with no side colour, because nothing is decided.

            NO `role="status"` HERE, deliberately (it had one). Every entry into the round rewrites
            the count and the pot inside this plate, and a live region re-reads its WHOLE contents on
            any change — so one stranger deploying interrupted the reader with "Round 17, OPEN, 8
            entered, $353.00 on the table, pick a side and deploy", over and over, none of it new and
            none of it about them. The phase change itself is announced once, by the dock's phase note
            (RoundPhaseNote.tsx), which is the sentence that actually changes state. */}
        {phase === "Lobby" || phase === "Drawing" ? (
          <div className="result result--wait">
            <div className="u" style={{ marginBottom: 8 }}>
              Round {live?.roundNo.toString() ?? "—"}
            </div>
            {/* THE SAME WORDS AS THE DOCK, from the same object. This plate used to say "Deposits
                open" for the whole of the Lobby phase, including the window past `lobby_closes_at`
                in which the chain refuses them — so the field could read "deposits open" over a dock
                reading "entries closed". One source, no contradiction. */}
            <div className="h result-h">{phaseCopy.label}</div>
            <div className="line" style={{ justifyContent: "center", marginTop: 12, gap: 18 }}>
              <span className="num">{fighters.length}</span>
              <span className="u">entered</span>
              {live ? <Money units={live.pot} compact /> : <span className="num">—</span>}
              <span className="u">on the table</span>
            </div>
            {/* What to do about it, in the same voice — a plate on an empty field is exactly where a
                player asks "what now?", and "Deploy below" answered only half of it. */}
            <p className="u" style={{ marginTop: 12, lineHeight: 1.6 }}>
              {phaseCopy.action}
            </p>
            {/* A DRAW THAT HAS STOPPED BEING NORMAL. `Phase::Drawing` has no on-chain exit — only the
                VRF callback moves a round out of it, and `abandon_round` accepts `Lobby` and nothing
                else — so a callback that never lands wedges the round permanently while every
                surface keeps saying "usually seconds". Past the threshold this stops saying that and
                says what is actually true, including that the page's own figure is a measure of how
                long IT has been watching (`useDrawWatch.ts`). It is a `role="alert"` because it is
                the one thing on this plate that arrives as news rather than as description. */}
            {draw?.stalled ? (
              <p
                className="u"
                role="alert"
                style={{ marginTop: 12, lineHeight: 1.6, color: "var(--hot)" }}
              >
                The seed has not landed in {clock(draw.watchedSec)} of watching this tab. A draw
                normally takes seconds, and there is no way out of this phase on chain — nothing can
                abandon a round once its lobby has closed. If it stays here, this round is stuck and
                the next one has to be opened by an operator.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* AN ABANDONED ROUND USED TO RENDER AS AN EMPTY WHITE FIELD. It is a real terminal state —
            `abandon_round` ends a lobby that reached its deadline holding fewer than two fighters —
            and it is the only one that produces no fight at all, so the field genuinely has nothing
            on it and a reader has no way to tell that from a canvas that failed.
            NO SIDE COLOUR, because nothing was decided: it takes `result--wait`, the same neutral
            plate the lobby uses, rather than `result--a`/`result--b`. `role="status"` for the same
            reason the settled plate has one and the lobby plate does not — this arrives once, on its
            own, as the answer to what everyone in the round was waiting for, and it does not
            rewrite itself afterwards. */}
        {phase === "Abandoned" ? (
          <div className="result result--wait" role="status">
            <div className="u" style={{ marginBottom: 8 }}>
              Round {live?.roundNo.toString() ?? "—"} · expired
            </div>
            <div className="h result-h">{phaseCopy.label}</div>
            <div className="line" style={{ justifyContent: "center", marginTop: 12, gap: 18 }}>
              <span className="num">{fighters.length}</span>
              <span className="u">{fighters.length === 1 ? "fighter" : "fighters"} entered</span>
              <span className="u">of the 2 a fight needs</span>
            </div>
            <p className="u" style={{ marginTop: 12, lineHeight: 1.6 }}>
              The lobby reached its deadline without enough fighters, so it was ended rather than
              left open. There is no seed, no fight and no winner in this one — nothing here to
              replay or verify. {phaseCopy.action}
            </p>
          </div>
        ) : null}
      </div>

      <div className="helpbar">
        <ErWrites />
        <span className="u u--ink">
          {/* Extraction is not free and the helpbar must not imply it is: the house takes a
              decaying slice of whatever leaves the ring, and this line sits directly under the
              field a player is deciding from. */}
          {mode === "extraction"
            ? `Extraction — bank your raids mid-fight, minus an exit penalty that starts at ${START_PENALTY} and decays to zero`
            : "Mayhem — raids compound in your fighter's ring and stay at risk"}
        </span>
        <span className="u">Click any fighter for its profile</span>
        <span className="u">
          Pairs are picked by hash(seed, step) · {paceLine(fighters.length)}
        </span>
      </div>
    </Section>
  );
}

// =============================================================================================
// 00-3 DEPLOY
// =============================================================================================

/** The repeat rule's sizing options, from the original's deploy panel. `0` is "whatever is in the
 *  amount box"; the percentages are the original's, and are percentages of the SIMULATED bankroll —
 *  see `AmountRule` in `data/autoDeploy.ts` for what that does and does not constrain. */
const PCT_OPTIONS = [
  { id: 0, label: "Fixed $" },
  { id: 5, label: "5% of wallet" },
  { id: 10, label: "10%" },
  { id: 25, label: "25%" },
];

function clampStake(v: number): number {
  return Math.min(STAKE_CAP_USD, Math.max(MIN_STAKE_USD, Math.round(v * 100) / 100));
}

/** THE REPEAT CONTROL — a view of `data/autoDeploy.ts` and nothing more.
 *
 *  Every rule this once contained (when to fire, whether a round had been done, what happens after a
 *  failure, how much) now lives in the data layer, because all of it kept running or kept stopping
 *  depending on which SCREEN was mounted. What is left here is a checkbox, a sizing choice, and — the
 *  part that earns the feature its place — a permanent, plain-English statement of what it is about
 *  to do and what it last did. A control that spends money on its own is only acceptable while it is
 *  answerable, and this is where it answers. */
function Repeat({ stake, pct, setPct }: { stake: number; pct: number; setPct(p: number): void }) {
  const { autoDeploy, sim } = useArena();
  const { armed, side, attempt, setRule } = autoDeploy;

  // The rule as the controls currently describe it. Arming snapshots this; changing either control
  // while armed pushes the new rule down, so what the panel shows is always what would be sent.
  const rule = useMemo<AmountRule>(
    () => (pct > 0 ? { kind: "pct", pct } : { kind: "fixed", usd: stake }),
    [pct, stake],
  );

  // Keep an armed rule in step with the controls. Not a re-arm: the round it starts from is a
  // decision made once, when the box was ticked, and editing the amount must not silently move it.
  // Depends on `setRule` — which is stable — and NOT on the whole `autoDeploy` object, whose identity
  // changes every time this effect succeeds in changing anything.
  useEffect(() => {
    if (armed) setRule(rule);
  }, [armed, rule, setRule]);

  const bankroll = simBankrollUsd(sim.ledger.balances);
  const amount = autoDeploy.nextAmountUsd;
  const sideName = side === null ? null : SIDE_TOKEN[side].name;

  return (
    <>
      <label className="opt" style={{ marginTop: 16 }}>
        <input
          type="checkbox"
          data-testid="repeat-arm"
          checked={armed}
          onChange={(e) => (e.target.checked ? autoDeploy.arm(rule) : autoDeploy.disarm())}
        />
        <span className="opt-t">
          <b>Repeat every round</b>
          <br />
          {/* WHAT IT WILL DO, stated before it does it. The old copy promised "at each new lobby"
              while the code fired the instant the box was ticked, for the round already on screen —
              so the one sentence a player read before handing over their deposits was the one thing
              that was not true. The round it starts from is now named. */}
          <span className="u">
            {!armed ? (
              sideName === null
                ? "Deploys into every new round once you have deployed once — it follows the side you last played"
                : `Would deploy ${amount === null ? "—" : usd(usdToUnits(amount))} to ${sideName}, starting with the round after the one on screen`
            ) : (
              <>
                Armed · {amount === null ? "no deployable amount" : usd(usdToUnits(amount))} to{" "}
                {sideName ?? "the side you play next"}
                {autoDeploy.firesFromRound === null
                  ? ", from the next round to open"
                  : `, from round ${autoDeploy.firesFromRound} on`}
              </>
            )}
          </span>
        </span>
      </label>

      {/* THE STATUS LINE, always present while armed. This is the answer to "is it still working?" —
          a question the previous version could only be answered by watching and hoping. */}
      {armed ? (
        <p className="u" data-testid="repeat-status" style={{ marginTop: 10, lineHeight: 1.6 }}>
          {autoDeploy.status}
        </p>
      ) : null}

      {/* AND WHAT HAPPENED LAST. A missed round is reported here for as long as it is the most recent
          thing that happened, not only as a toast that scrolls away in five seconds — a player who
          steps away and comes back deserves to find out that a round went by without them. */}
      {attempt !== null && attempt.outcome === "abandoned" ? (
        <p className="lede" data-testid="repeat-missed" style={{ marginTop: 8 }}>
          Round {attempt.roundNo.toString()} was not entered —{" "}
          {abandonText(attempt.abandonedBecause ?? "round-moved-on", attempt.error)}.
        </p>
      ) : null}

      <div className="line line--wrap" style={{ marginTop: 14 }}>
        <span className="u">Repeat amount</span>
        <Seg<number> ariaLabel="Repeat amount rule" value={pct} onChange={setPct} options={PCT_OPTIONS} />
        {pct > 0 ? <Tag kind="sim" /> : null}
      </div>
      {pct > 0 ? (
        <p className="u" style={{ marginTop: 8, lineHeight: 1.6 }}>
          {pct}% of the simulated wallet ({usd(usdToUnits(bankroll))}) is{" "}
          {amount === null ? "under the minimum this page will send" : `${usd(usdToUnits(amount))} a round`}.
          The program holds no balance to take a percentage of, so this rule reads the local ledger and
          CONSTRAINS NOTHING — the transaction it sizes is real, and spends real devnet SOL on fees.
          {amount === null ? " Nothing will be deposited until the simulated wallet is topped up." : ""}
        </p>
      ) : null}
    </>
  );
}

/** The panel's default stake, and the fallback whenever no repeat rule is standing. */
const DEFAULT_STAKE_USD = 5;

/** WHAT THE CONTROLS SHOULD READ ON MOUNT.
 *
 *  This panel is unmounted every time someone opens another screen, and the repeat rule is not — so a
 *  panel that always came back at its defaults would push those defaults straight back down through
 *  the sync effect and quietly rewrite a standing $100 instruction to $5. The controls ADOPT the
 *  armed rule instead of overwriting it: whatever is armed is what the panel shows. */
function controlsFor(rule: AmountRule, armed: boolean): { stake: number; pct: number } {
  if (!armed) return { stake: DEFAULT_STAKE_USD, pct: 0 };
  return rule.kind === "pct"
    ? { stake: DEFAULT_STAKE_USD, pct: rule.pct }
    : { stake: rule.usd, pct: 0 };
}

function Deploy() {
  const { live, status, actions, autoDeploy, fee, mode, setMode, session, toasts, gate } = useArena();
  // Read once, at mount, from whatever rule is standing — never on every render, which would make
  // these controls unusable while armed.
  const [initial] = useState(() => controlsFor(autoDeploy.rule, autoDeploy.armed));
  const [stake, setStake] = useState(initial.stake);
  /** WHAT'S IN THE BOX, which is not the same thing as the stake.
   *
   *  The amount field used to be bound straight to `stake` and clamped on every keystroke. That is
   *  unusable for anything but a whole number typed left to right: clearing the box snapped it to
   *  $0.01, and typing "0.5" snapped at the first character, because `Number("0") || 0.01` takes
   *  the fallback — 0 is falsy. Half-typed text is a legitimate transient state, so the text is
   *  held as text while the field has focus and only reconciled to a number on blur. `stake` stays
   *  the single source of truth for what a deploy would actually send. */
  const [stakeText, setStakeText] = useState(String(initial.stake));
  /** Presets, the slider and MAX all move the canonical stake; the box follows unless it's being
   *  edited, in which case it would be rude to rewrite what someone is mid-way through typing. */
  const [editingAmount, setEditingAmount] = useState(false);
  const shownAmount = editingAmount ? stakeText : String(stake);
  const [pct, setPct] = useState(initial.pct);

  const phase = live?.phase ?? null;
  const stakeUnits = usdToUnits(stake);
  const feeUnits = feeOn(stakeUnits, fee);
  const signingNote = sessionNote(session.plan, session.life);

  /** A LIVE CLOCK, because the deposit deadline is a time and not a phase.
   *
   *  `live` only changes when a poll lands or, during Fight, on the 250ms clock — neither of which
   *  runs down the lobby. Without a tick of its own, this panel would keep offering deposits for as
   *  long as the phase said Lobby, which is exactly the window in which the chain refuses them (see
   *  `LiveRound.lobbyClosesAtMs`). One second is the resolution the countdown is read at, and
   *  `useSecondTick` is the same clock the phase note runs on — two intervals at one rate cannot
   *  disagree about which second it is, which a 1s and a 250ms one could. */
  const nowMs = useSecondTick(phase === "Lobby");

  // `gate` (data/playGate.ts) is why THIS reader cannot deploy — no wallet, no devnet SOL — as
  // opposed to why the round cannot be deployed into. Both close these controls, and the `!open`
  // branch's `RoundPhaseNote` already carries the reason for either, because `roundPhaseCopy.ts`
  // reads the same verdict.
  const open = entriesOpen(live, nowMs) && !status.programError && gate === null;

  const deploy = useCallback(
    async (side: Side, amountUsd: number) => {
      try {
        // `actions.enter` fans out to the repeat rule on confirmation (ArenaProvider's `useOnEntered`),
        // which is how "it repeats the side you last played" survives a change of screen — this
        // component no longer remembers anything about it.
        await actions.enter(side, usdToUnits(amountUsd));
        toasts.push(
          `Deployed ${usd(usdToUnits(amountUsd))} to ${SIDE_TOKEN[side].name}`,
          side === 0 ? "a" : "b",
        );
      } catch (e) {
        toasts.push(e instanceof Error ? e.message : "Deploy failed", "error");
      }
    },
    [actions, toasts],
  );

  return (
    <Section
      index="00-3"
      title="Deploy"
      tools={
        <>
          <span className="u">Intent</span>
          <Seg<Mode>
            ariaLabel="Play style"
            value={mode}
            onChange={setMode}
            options={[
              { id: "mayhem", label: "Mayhem", title: "Raids compound in the ring and stay at risk" },
              {
                id: "extraction",
                label: "Extraction",
                title: "Bank raids as you go — on chain both modes are the same program",
              },
            ]}
          />
        </>
      }
      lede={
        open
          ? `Stake is an on-chain u64, shown at ${UNITS_PER_USD.toLocaleString("en-US")} units = $1.00. The arena deducts ${feePhrase(fee)} on entry, so ${usd(stakeUnits)} puts ${usd(stakeUnits - feeUnits)} in the ring. Max ${usd(usdToUnits(STAKE_CAP_USD))} a side.`
          : undefined
      }
    >
      {!open ? (
        // THE FOUR PHASES ARE NOT SPELLED OUT HERE ANY MORE. They were, in a ladder of strings that
        // was a hand-maintained copy of the dock's ladder — and one copy always rots. Both surfaces
        // now render `ui/RoundPhaseNote.tsx`, whose words are a pure function with a test on it.
        <div className="closed" style={{ borderTop: "1px solid var(--rule)", padding: "14px 2px" }}>
          {/* Not the announcer — the dock is (see RoundPhaseNote.tsx). Both are on screen together,
              and two live regions carrying the same word say it twice. */}
          <RoundPhaseNote announce={false} />
        </div>
      ) : (
        <div className="deploy">
          <div>
            {/* The deadline, as a number — same component, same words, as the dock's. A lobby with
                an invisible clock is how a player ends up pressing Deploy two seconds too late and
                being told the round refused them. It renders a sentence rather than nothing when
                the round carries no deadline (`lobbyClosesAtMs === null`), which is a real state on
                a program revision without one and used to print as blank space. */}
            <div data-testid="entry-countdown" style={{ marginBottom: 14 }}>
              <RoundPhaseNote detail="timing" announce={false} />
            </div>
            <div className="line" style={{ marginBottom: 14 }}>
              <span className="u">Stake</span>
              <Seg<number>
                ariaLabel="Stake preset"
                value={STAKE_PRESETS.includes(stake) ? stake : -1}
                onChange={setStake}
                options={STAKE_PRESETS.map((p) => ({ id: p, label: `$${p}` }))}
              />
            </div>

            <div className="amt-row">
              <div>
                <label className="u" htmlFor="stake-amt">
                  Amount USD
                </label>
                <input
                  id="stake-amt"
                  type="number"
                  min={0.01}
                  max={STAKE_CAP_USD}
                  step={0.01}
                  value={shownAmount}
                  onFocus={() => {
                    setStakeText(String(stake));
                    setEditingAmount(true);
                  }}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setStakeText(raw);
                    // Track a valid figure as it's typed so the fee line and the deploy buttons stay
                    // live, but never rewrite the box itself — that's what made it untypable.
                    const n = Number(raw);
                    if (raw.trim() !== "" && Number.isFinite(n) && n > 0) setStake(clampStake(n));
                  }}
                  onBlur={() => {
                    // Reconcile once, here: empty or nonsense falls back to the last good stake
                    // rather than to the floor, so tabbing out of a cleared box doesn't silently
                    // rewrite a $50 deploy into a 1-cent one.
                    const n = Number(stakeText);
                    const next = stakeText.trim() === "" || !Number.isFinite(n) || n <= 0 ? stake : clampStake(n);
                    setStake(next);
                    setStakeText(String(next));
                    setEditingAmount(false);
                  }}
                />
              </div>
              <input
                type="range"
                min={0.01}
                max={STAKE_CAP_USD}
                step={0.01}
                value={stake}
                aria-label="Stake amount"
                onChange={(e) => setStake(clampStake(Number(e.target.value)))}
              />
              <button
                type="button"
                className="btn btn--sm amt-max"
                title={`The arena's per-side cap is $${STAKE_CAP_USD}`}
                onClick={() => setStake(STAKE_CAP_USD)}
              >
                Max
              </button>
            </div>

            <p className="lede" style={{ marginTop: 18 }}>
              Raided value is yours: it moves into your fighter&apos;s ring, and in Extraction you can
              bank it mid-fight — the house takes {START_PENALTY} of whatever you pull out at the
              opening bell, less every step after that, nothing once the fight has run its course
              (00-3.1). Nothing is refunded and nothing is matched: the pot is exactly what everyone
              put in, and the only value that ever leaves it is that penalty.
            </p>
          </div>

          <div>
            <div className="sides">
              <button
                type="button"
                className="btn btn--a btn--wide"
                disabled={actions.entering}
                onClick={() => void deploy(0, stake)}
              >
                <TokenIcon token={SIDE_TOKEN[0]} /> Deploy {SIDE_TOKEN[0].name}
              </button>
              <button
                type="button"
                className="btn btn--b btn--wide"
                disabled={actions.entering}
                onClick={() => void deploy(1, stake)}
              >
                <TokenIcon token={SIDE_TOKEN[1]} /> Deploy {SIDE_TOKEN[1].name}
              </button>
            </div>

            <button
              type="button"
              className="btn btn--ghost btn--wide"
              style={{ marginTop: 12 }}
              disabled={actions.entering}
              onClick={() => {
                void (async () => {
                  await deploy(0, stake);
                  await deploy(1, stake);
                })();
              }}
            >
              Deploy both sides · {usd(stakeUnits * 2n)}
            </button>

            {/* WHAT THE FIRST APPROVAL IS FOR, under the buttons that trigger it — the same sentence
                the dock carries, from the same module, because two hand-written accounts of one
                Phantom dialog is how one of them ends up describing a cost that moved. It is gone
                the moment a session is signing, which is most of the time. */}
            {signingNote !== null ? (
              <p className="lede" style={{ marginTop: 14 }}>
                {signingNote}
              </p>
            ) : null}
          </div>
        </div>
      )}

      {/* ALWAYS ON SCREEN, in every phase — and that is the point, not a layout preference.
          A lobby is a small fraction of a round's life, so a standing instruction to spend money that
          was only visible during a lobby would be unreachable for most of the time it was in force:
          no way to check it, no way to call it off, and — worst of all — its report of a round that
          went by without you would be hidden during exactly the phases in which you would go looking
          for it. It sits below the deploy controls rather than inside them for the same reason. */}
      <div className="repeat" style={{ borderTop: "1px solid var(--rule)", paddingTop: 14, marginTop: 18 }}>
        <Repeat stake={stake} pct={pct} setPct={setPct} />
      </div>
    </Section>
  );
}

// =============================================================================================
// 00-3.1 EXTRACT
// =============================================================================================

function Extract() {
  const { live, actions, session, toasts } = useArena();
  // The bell, from the one place that decides what the bell is doing — see the note on the line that
  // prints it, at the bottom of this panel.
  const { clockSlot } = useRoundPhase();
  const eligible = actions.extractEligible;
  const terms = live?.extractTerms ?? null;
  const fighting = live?.phase === "Fight";
  const signingNote = sessionNote(session.plan, session.life);

  const run = async () => {
    // Read the quote BEFORE awaiting: by the time the transaction lands the cursor has moved and the
    // chain will have charged slightly less. Reporting the pressed-at figures with "~" is the honest
    // version of that — the alternative is a toast quoting a rate nobody was actually charged.
    const quoted =
      eligible.keep !== null && eligible.forfeit !== null && terms
        ? ` — ~${keepText(eligible.keep)} banked, ~${usd(eligible.forfeit, 2)} to the house at the quoted ${bpsPct(terms.penaltyBps)}`
        : "";
    try {
      await actions.extract();
      toasts.push(`Extracted${quoted}`, "info");
    } catch (e) {
      toasts.push(e instanceof Error ? e.message : "Extract failed", "error");
    }
  };

  return (
    <Section
      index="00-3.1"
      title="Extract"
      tools={<RoundTag />}
      lede={`Pull what is still in your fighter's ring out of the fight, mid-round — and pay the house for the privilege. The penalty is ${START_PENALTY} at the opening bell and falls in a straight line to nothing${terms ? ` by step ${terms.freeAtStep.toLocaleString("en-US")}` : ""}: what you give up by leaving is the rest of the fight, which is everything at the start and nothing at the end. So extracting now is expensive and standing there is cheaper — that is the whole decision. This is also the one move a rollup makes possible and a settlement layer does not: it has to land inside a running fight, before anybody settles the round. There is no fixed countdown — anyone may settle the moment one side has nobody left standing, and in any case once the ${FIGHT_TIMEOUT_SECONDS}s bell rings.`}
    >
      <div className="xt">
        <div>
          {/* THE HEADLINE IS WHAT YOU KEEP, not what is in the ring. It used to be `hp`, which was
              the same number until the penalty existed and is now an overstatement of the payout by
              up to a fifth — the single figure a player acts on has to be the one the chain pays. */}
          <div
            className={`display display--mono${eligible.keep === null ? " none" : ""}`}
            style={{ fontSize: "clamp(30px, 4.2vw, 54px)" }}
          >
            {eligible.keep === null ? "—" : keepText(eligible.keep)}
          </div>
          <p className="u" style={{ marginTop: 12 }}>
            What you would bank right now
            {terms && eligible.keep !== null
              ? terms.penaltyBps === 0
                ? " · no penalty left at this point in the fight"
                : ` · ${bpsPct(terms.penaltyBps)} penalty already taken out`
              : ""}
          </p>
          {!eligible.ok && eligible.reason ? (
            <p className="lede" style={{ marginTop: 10 }}>
              Unavailable — {eligible.reason}.
            </p>
          ) : (
            <p className="lede" style={{ marginTop: 10 }}>
              Your fighter leaves the fight immediately and stops being a target. Anything already
              banked stays banked; what is in the ring is split — most of it into your bank, the rest
              out of the round entirely, to the house. Nothing of yours stays on the field.
            </p>
          )}
          {/* THE BELL, ON THE ONE CONTROL THAT IS RACING IT — and it no longer computes its own.
              This line used to call a local `bellLeft(live)`, which was a second subtraction of
              `elapsedSec` from the timeout in a file that already gets the same figure handed to it.
              It now reads the round's own `ClockSlot` for the FIGURE — one bell on the page, quoted
              everywhere, never re-derived.
              BUT THE CLAIM STAYS ON `resolvable`, AND THAT SEPARATION IS THE WHOLE CORRECTNESS OF THIS
              LINE. "Anyone can end this round at any moment" is a statement about the CHAIN, and the
              only fact that supports it is `resolvable`. Deriving it from the slot instead — no
              figure, therefore settleable — reads as equivalent and is not: `clockSlotFor` returns no
              figure whenever the page cannot reach the program at all, short-circuiting before it
              looks at the phase, so a fight on screen during an RPC failure would have printed
              "anyone can end this round at any moment" directly above the Extract button on the
              strength of the page having lost its connection. Three renderings, not two.
              "AT MOST" IS NOT A HEDGE HERE, IT IS THE POINT. This is the surface where misreading the
              bell as a forecast costs actual money: a player who believes they have 2:26 to decide
              may have twenty seconds, because a fight ends the moment one side is wiped out. */}
          {fighting && live ? (
            <p className="u" style={{ marginTop: 12 }}>
              {live.resolvable
                ? "Settleable now — anyone can end this round at any moment"
                : clockSlot.kind === "clock"
                  ? `Bell in ${clock(clockSlot.seconds)} at most · ${stepsPerSecond(live.fighters.length)} steps/sec`
                  : `No bell time we can show · ${stepsPerSecond(live.fighters.length)} steps/sec`}
            </p>
          ) : null}
          {/* IT USED TO READ "A session key would sign this without a wallet prompt (panel, bottom
              right)" — a signpost to a manual step, on the control that is racing a settlement.
              Extract opens its own session now, so what belongs here is a description of what the
              press costs, and nothing at all once a session is signing.

              GATED ON `fighting`, which is what keeps ONE copy of this sentence on the screen. 00-3
              carries the same words inside its own open-lobby branch, and the two phases are
              mutually exclusive — deposits are open in Lobby, extract is live in Fight — so the
              reader gets it beside whichever control they can actually press, and never twice. */}
          {fighting && signingNote !== null ? (
            <p className="lede" style={{ marginTop: 12 }}>
              {signingNote}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="btn btn--fill xt-btn"
          disabled={!eligible.ok || actions.extracting}
          onClick={() => void run()}
        >
          <span>{actions.extracting ? "Extracting…" : "Extract"}</span>
          {/* The trade, on the control that makes it. A button reading only "Extract" beside a
              headline figure lets a player believe the headline is what leaves the ring. */}
          <span className="xt-btn-s">
            {eligible.keep === null || eligible.forfeit === null
              ? "unavailable"
              : `bank ${keepText(eligible.keep)} · ${penaltyText(eligible.forfeit)} to the house`}
          </span>
        </button>
      </div>

      {/* EVERY FIGURE BELOW IS FORWARD-LOOKING — what leaving would cost, and how much cheaper it
          gets — so a settled round must not show them. Its cursor is frozen past the horizon, which
          would render as "free now, 0:00 to go" about a round nobody can extract from at all. What
          the house actually took from a finished round is a matter of record, and 00-7 reports it
          off `Round.penalties_collected`. */}
      {terms && live && live.phase !== "Settled" ? (
        <>
          <KVs>
            <KV
              value={eligible.hp === null ? <Dash /> : <Money units={eligible.hp} dp={2} />}
              label="Out of the ring"
              title="Everything your fighter is still holding in the ring, before the split. `extract()` catches the fight up to this instant first, so this is the hp the chain would be splitting, not the last figure anyone happened to tick."
            />
            <KV
              value={
                eligible.forfeit === null ? (
                  <Dash />
                ) : (
                  <span className={`num${eligible.forfeit > 0n ? " neg" : " dim"}`}>
                    {penaltyText(eligible.forfeit)}
                  </span>
                )
              }
              label="The house takes"
              title="It leaves the round entirely — recorded in Round.penalties_collected, not returned to the pot (which would pay it straight back to the opponents about to raid you) and not burned."
            />
            <KV
              value={<span className="num">{bpsPct(terms.penaltyBps)}</span>}
              label="Penalty rate now"
              title={`${START_PENALTY} at the opening bell, decaying linearly to zero across this lineup's horizon. Charged against the fight's canonical cursor, so it is the same rate anyone can re-derive from the Extracted event.`}
            />
            <KV
              value={<span className="num">{terms.freeAtStep.toLocaleString("en-US")}</span>}
              label="Free from step"
              title={`A fight's length in steps grows with the lineup, so the horizon does too: ${counted(live?.fighters.length ?? 0, "fighter")} here. From this step on, extracting costs nothing.`}
            />
            <KV
              value={
                terms.stepsToFree === 0 ? (
                  <span className="num">FREE NOW</span>
                ) : (
                  <span className="num">{clock(terms.secondsToFree)}</span>
                )
              }
              // Outside Fight the cursor is 0, so this distance is measured from an opening bell
              // that hasn't rung — "free in 0:37" would read as a countdown from now and be wrong
              // by however long the lobby still has to run.
              label={fighting ? "Free in" : "Free after"}
              title={
                fighting
                  ? "At this lineup's pace, how much longer the fight has to run before extracting is free."
                  : "How far INTO the fight the penalty reaches zero, at this lineup's pace. The round isn't running yet, so it is measured from the opening bell, not from now."
              }
            />
          </KVs>

          {/* THE PREMIUM, DECAYING — the mechanic made visible. A rate quoted as one number reads
              like a fee; the bar draining toward a stated end is the same fact stated as the choice
              it actually is. The ladder is rate ONLY, never money: the curve is a pure function of
              the cursor, but the hp it would apply to is not — waiting also means taking hits. */}
          <div className="xt-curve">
            <div className="xt-curve-head">
              <span className="u u--ink">Exit premium</span>
              <span className="u">
                {START_PENALTY} at the opening bell · 0% from step{" "}
                {terms.freeAtStep.toLocaleString("en-US")}
              </span>
            </div>
            <Bar value={BigInt(terms.penaltyBps)} max={EXTRACT_PENALTY_START_BPS} large />
            {/* Once the curve has arrived there is nothing left to wait for, and a ladder of four
                identical FREEs beside a line about the value of patience is noise dressed as
                information. Say the one thing that is true instead. */}
            <div className="xt-ladder">
              {!fighting ? (
                // No cursor is moving, so there is no "in 10 seconds" to quote — only where the
                // curve starts and how much of a fight it takes to run out.
                <span className="u u--ink">
                  At the opening bell <span className="num">{START_PENALTY}</span> — gone{" "}
                  <span className="num">{clock(terms.secondsToFree)}</span> into the fight
                </span>
              ) : terms.penaltyBps === 0 ? (
                <span className="u u--ink">
                  Now <span className="num">FREE</span> — the premium has fully decayed, and
                  everything left in your ring banks untaxed
                </span>
              ) : (
                <>
                  <span className="u u--ink">
                    Now <span className="num">{bpsPct(terms.penaltyBps)}</span>
                  </span>
                  {terms.decay.map((d) => (
                    <span className="u" key={d.inSeconds}>
                      In {d.inSeconds}s{" "}
                      <span className="num">
                        {d.penaltyBps === 0 ? "FREE" : bpsPct(d.penaltyBps)}
                      </span>
                    </span>
                  ))}
                  <span className="u u--faint">
                    Waiting costs you hits and saves you premium — that is the trade
                  </span>
                </>
              )}
            </div>
          </div>
        </>
      ) : null}
    </Section>
  );
}

// =============================================================================================
// 00-4 THE FIELD
// =============================================================================================

function Roster({ side }: { side: Side }) {
  const { live } = useArena();
  const { map } = useLinks();
  const { setRail } = useShell();
  // ONE CAP PER SIDE, AND THE TWO ARE INDEPENDENT. `TheField` renders this component twice, so each
  // side gets its own `expanded` and its own `useId` — which is the honest shape: these are two
  // tables that happen to sit beside each other, not one table split down the middle. A switch
  // shared between them would make a reader who wanted five more fighters on one side take five
  // more on the other, and `aria-controls` would have to name two containers at once.
  const [expanded, setExpanded] = useState(false);
  const rowsId = useId();
  const all = live?.fighters ?? [];
  const rows = all.filter((f) => f.side === side).sort((x, y) => (y.hp > x.hp ? 1 : y.hp < x.hp ? -1 : 0));
  const total = rows.reduce((s, f) => s + worth(f), 0n);
  const alive = rows.filter((f) => !f.dead).length;
  // SORTED ABOVE, CAPPED HERE, in that order — a plain top-N of the health order and never a
  // reshuffle of who survives the cut; `rowCap.ts` carries the rule that keeps it one.
  //
  // The three figures above are derived from `rows` and stay that way: the side's worth and
  // `{alive}/{rows.length} alive` count the WHOLE side in both states. A header that quietly meant
  // "of the five we chose to show you" is the one thing a table with money in it may never print,
  // and it is what the reader checks the cap against.
  const shown = capRows(rows, ROW_CAP, expanded);

  return (
    // THE MARKS IN HERE ARE NOT LABELLED, AND THAT IS CORRECT: this is one side's roster, under that
    // side's own name, so the square is decoration on top of a fact the reader has already been
    // given — unlike 00-5, which mixes both sides into one table.
    //
    // With one qualification, which is what this `role`/`aria-label` pair is for. Every row below is
    // a `role="button"` tab stop, so a keyboard reader arrives INSIDE the roster without passing the
    // heading above it, and a heading nothing points at is a heading nobody hears. Naming the group
    // is what makes the grouping true in the accessibility tree rather than only on screen. No
    // landmark, and no repetition on the rows: one quiet boundary, said once.
    <div role="group" aria-label={`${SIDE_TOKEN[side].name} roster`}>
      <div className="side-head">
        <TokenIcon token={SIDE_TOKEN[side]} size="md" />
        <span className="h h--sm">{SIDE_TOKEN[side].name}</span>
        <Money units={total} compact className="push" />
        <span className="u">
          {alive}/{rows.length} alive
        </span>
      </div>

      <div className="row row--head roster">
        <span>#</span>
        <span />
        <span>Fighter</span>
        <span className="r">Ring</span>
        <span className="r col-opt">Banked</span>
        <span className="col-opt">Health</span>
        <span className="r" />
      </div>

      {rows.length === 0 ? (
        // UNCHANGED, AND IT COMES FIRST FOR A REASON: an empty side is not a capped side. `capRows`
        // of nothing hides nothing and `ShowMore` renders nothing for a table that fits, so even
        // without this branch "no fighters yet" could never become "show 0 more" — but the sentence
        // is the thing a reader on an empty lobby is actually owed, and a cap must not cost it.
        <Empty>No fighters on this side yet</Empty>
      ) : (
        // THE WRAPPER EXISTS TO BE NAMED BY `aria-controls` AND FOR NOTHING ELSE. These rows were
        // loose siblings under the group, and a control claiming to open something has to point at
        // the thing it opens. It takes no class: `.row` is its own grid and the column tracks live
        // on `.roster` (ArenaView.css), so a plain block around them is layout-neutral. The header
        // row stays OUTSIDE it — the header is not one of the rows being revealed, and a reader
        // expanding the table is not being handed a second copy of its column names.
        <>
          <div id={rowsId}>
            {shown.rows.map((f, i) => (
              <div
                key={f.wallet}
                className={`row row--click roster${f.isYou ? " row--you" : ""}${f.dead ? " row--dead" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setRail({ kind: "fighter", wallet: f.wallet })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setRail({ kind: "fighter", wallet: f.wallet });
                  }
                }}
              >
                <span className="idx">{(i + 1).toString().padStart(2, "0")}</span>
                <Mark side={f.side} dead={f.dead} />
                {/* THE NAME IS THE ONE CELL THAT MAY GIVE WAY. `.roster`'s money tracks are fixed and
                    this one is the `minmax(70px, 1fr)` that absorbs whatever is left, so `.trunc` is
                    what keeps a long name inside its column instead of pushing the row's figures out of
                    theirs. Nothing is lost by it: the full name is on the fighter inspector this row
                    opens. */}
                <FighterName f={f} links={map} />
                {/* THE COLUMNS MAX REPORTED. `.roster`'s money tracks are 70px fixed (66px on a phone),
                    and a chain figure printed in full is ~133px of right-aligned text — which does not
                    widen the track, it spills backwards over the name and the column before it. Compact
                    fits the track with room to spare; the exact figure is on each cell's title. */}
                <Money units={f.hp} compact className="r" />
                {f.banked > 0n ? (
                  <Money units={f.banked} compact className="r col-opt" />
                ) : (
                  <span className="num r col-opt">
                    <Dash />
                  </span>
                )}
                <span className="col-opt">
                  <Bar value={f.hp} max={f.stake} side={f.side} />
                </span>
                <span className="u r">{f.dead ? "Out" : `${healthPct(f).toFixed(0)}%`}</span>
              </div>
            ))}
          </div>
          {/* INSIDE THE GROUP, under the rows it opens. The `role="group"` is what makes this side's
              roster a boundary in the accessibility tree at all (see the note at the top of this
              component), so a control that belongs to this roster and not the other one belongs
              inside that boundary. */}
          <ShowMore
            hidden={shown.hidden}
            expanded={expanded}
            noun="fighter"
            controls={rowsId}
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </div>
  );
}

function TheField() {
  const { live } = useArena();
  const fighters = live?.fighters ?? [];

  // THE EMPTY LOBBY IS THE ONLY STATE THIS SECTION OWES A SENTENCE. An empty pair of rosters shows
  // nothing but two headings and two "no fighters yet" cells, and a reader cannot tell from that
  // whether they have arrived too early or the page has failed to load — so the lede answers it.
  // Once anyone has entered, the rosters below ARE the answer: they name every fighter, their side
  // and what each is holding, and a paragraph above them could only restate the count they already
  // carry. `Section` renders no `.lede` paragraph at all for an undefined one, so this leaves the
  // heading sitting directly on the table rather than on an empty line.
  //
  // NOT "until an operator closes it" any more. Nobody closes a lobby on a schedule now: the keeper
  // holds it open until a real player turns up, and only then commits to a time. The sentence says
  // what is true of every way a lobby ends instead of naming one that stopped being the usual one.
  const lede =
    fighters.length === 0
      ? "Nobody has entered yet. The lobby stays open and keeps taking deposits until entries are closed and the seed is drawn."
      : undefined;

  return (
    <Section index="00-4" title="The field" tools={<RoundTag />} lede={lede}>
      <div className="two">
        <Roster side={0} />
        <Roster side={1} />
      </div>
    </Section>
  );
}

// =============================================================================================
// 00-4.1 EXCHANGES
// =============================================================================================

/** THE FIGHT, AS A RECORD RATHER THAN AS A PICTURE.
 *
 *  Everything above this point tells a player WHAT they are worth and nothing tells them WHY: you
 *  watch your number fall on the field and in the standings, and there has been no surface anywhere
 *  that names who took it. The canvas draws each exchange for a few frames and the commentary is
 *  gone in five seconds; neither is somewhere a reader can go and look.
 *
 *  A SECTION OF ITS OWN, numbered under 00-4, because it is about the same thing 00-4 is — who is in
 *  this round — from the other side: 00-4 is the cast, this is what they have been doing to each
 *  other. The same component, filtered to one wallet, is in the fighter inspector, which is where
 *  the question is usually asked. */
function Exchanges() {
  const { live } = useArena();
  const fighting = live?.phase === "Fight";
  // HOW MANY ROWS ARE WORTH THE SCROLL, which is a different answer on a phone. On a wide page this
  // section is one column of a page a reader is scanning and 24 rows is a glance; on a 390px screen
  // the page IS this column, and 24 rows is ~1,500px of table standing between the rosters above and
  // the standings below. Ten is the recent past — the question this surface answers — and the
  // fighter inspector is where a reader goes for more.
  const narrow = useMediaQuery(NARROW);

  return (
    <Section
      index="00-4.1"
      title="Exchanges"
      tools={<RoundTag />}
      lede="Every hit the replay has reached, newest first — who took what off whom, at which step. Pairs are drawn from hash(seed, step), so this is the same sequence anyone can recompute from the revealed seed in 00-7, not a feed this page is inventing alongside the fight."
    >
      <CombatLog limit={narrow ? 10 : fighting ? 24 : 12} />
    </Section>
  );
}

// =============================================================================================
// 00-5 STANDINGS (this round)
// =============================================================================================

function RoundStandings() {
  const { live } = useArena();
  const { map } = useLinks();
  const { setRail } = useShell();
  const [expanded, setExpanded] = useState(false);
  const rowsId = useId();
  const rows = [...(live?.fighters ?? [])].sort((x, y) => {
    const d = pnlOf(y) - pnlOf(x);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });
  const alive = rows.filter((f) => !f.dead).length;
  // THE SORT ABOVE DECIDES WHO SURVIVES THE CUT, AND NOTHING HERE DOES. This is the one table on the
  // page that mixes both sides into one list, which makes it the one where a cap could most easily
  // become a statement about WHICH fighters matter — so it is a bare top-N of the P/L order and
  // never a partition, a quota per side or a reserved row. `rowCap.ts` carries the rule and the
  // standing reason for it; `#` keeps reading 01…n because a prefix of an ordered list is its own.
  //
  // `alive` and `rows.length - alive` in the tools line above count every entry in the round, capped
  // or not — same reason each roster's `{alive}/{rows.length}` does.
  const shown = capRows(rows, ROW_CAP, expanded);
  const caption =
    live?.phase === "Lobby"
      ? "lobby · deposits open"
      : live?.phase === "Settled"
        ? "round over"
        : "live";

  return (
    <Section
      index="00-5"
      title="Standings"
      tools={
        <span className="u">
          {caption} · {alive} alive / {rows.length - alive} out
        </span>
      }
    >
      <div className="row row--head standing">
        <span>#</span>
        {/* The one column on this page whose header cannot be printed: its track is 7px wide, which
            is the mark and nothing else. Hidden text names it rather than leaving an unnamed column
            in a table that has seven named ones.

            THE EMPTY OUTER SPAN IS LOAD-BEARING — it is the grid child, and `.sr` cannot be. `.sr` is
            `position: absolute` (base.css), so an `.sr` span used directly as a grid item takes part
            in no layout at all: the header row was left with seven children against the rows' eight,
            and every label slid one track left. Measured at 1440px, "Deployed" sat over the fighter
            name and "P/L" over Worth — a table of money columns, each one labelled as its neighbour.
            `Mark` avoids the same trap the same way, by nesting the label inside the 7px square. */}
        <span>
          <span className="sr">Side</span>
        </span>
        <span>Fighter</span>
        <span className="r col-opt">Deployed</span>
        <span className="r col-opt">Ring</span>
        <span className="r col-opt">Banked</span>
        <span className="r">Worth</span>
        <span className="r">P/L</span>
      </div>

      {rows.length === 0 ? (
        <Empty>No entries in this round</Empty>
      ) : (
        // Same wrapper as the rosters', for the same one reason: `aria-controls` needs something to
        // name. No class, header row left outside it — see the note in `Roster`.
        <>
          <div id={rowsId}>
            {shown.rows.map((f, i) => (
              <div
                key={f.wallet}
                className={`row row--click standing${f.isYou ? " row--you" : ""}${f.dead ? " row--dead" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setRail({ kind: "fighter", wallet: f.wallet })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setRail({ kind: "fighter", wallet: f.wallet });
                  }
                }}
              >
                <span className="idx">{(i + 1).toString().padStart(2, "0")}</span>
                {/* LABELLED, unlike the rosters two sections up. This is one table with both sides mixed
                    into it, so the 7px square is the ONLY thing saying which side a row is on — side by
                    colour alone, in the one table that sorts the two together. Every row here is also a
                    button, so the reader arrives at it by Tab without passing anything that could have
                    said it for them. */}
                <Mark side={f.side} dead={f.dead} label={SIDE_TOKEN[f.side].name} />
                {/* Same cell as the roster's name, for the same reason — see the note there. */}
                <FighterName f={f} links={map} />
                {/* Five money columns across 76-88px tracks — the worst case on the page, and the other
                    half of Max's report. All five compact; all five carry the exact figure on a title. */}
                <Money units={f.stake} compact className="r col-opt" />
                <Money units={f.hp} compact className="r col-opt" />
                {f.banked > 0n ? (
                  <Money units={f.banked} compact className="r col-opt" />
                ) : (
                  <span className="num r col-opt">
                    <Dash />
                  </span>
                )}
                <Money units={worth(f)} compact className="r" />
                <span className="r">
                  <Pnl value={pnlOf(f)} />
                </span>
              </div>
            ))}
          </div>
          <ShowMore
            hidden={shown.hidden}
            expanded={expanded}
            noun="fighter"
            controls={rowsId}
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </Section>
  );
}

// =============================================================================================
// 00-6 PREVIOUS ROUNDS
// =============================================================================================

function PreviousRounds() {
  const { history } = useArena();
  const { setView } = useShell();
  const [expanded, setExpanded] = useState(false);
  const rowsId = useId();
  // THE 8 IS THIS SECTION'S OWN CEILING AND IT SURVIVES THE CAP UNTOUCHED. What expands below is
  // these eight, not the log behind them — `history.rounds` runs up to 250 deep and pouring that
  // onto the arena screen is the complaint this change answers, not a way out of it. The whole log
  // has a screen of its own and this section already advertises it, in the `All rounds` button in
  // the tools slot above. `rowCap.ts`'s `ROW_CAP_RECENT` argues both halves of that.
  //
  // Newest-first is `history.rounds`' own order — `data/historyScan.ts` walks the log strictly
  // newest→oldest — so both slices are prefixes of it and neither is a judgement about which rounds
  // are worth showing.
  const rows = history.rounds.slice(0, 8);
  const shown = capRows(rows, ROW_CAP_RECENT, expanded);

  return (
    <Section
      index="00-6"
      title="Previous rounds"
      tools={
        <>
          <RoundTag />
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setView("history")}>
            All rounds
          </button>
        </>
      }
    >
      <div className="row row--head pastround">
        <span>Round</span>
        <span>Winner</span>
        <span className="r">Pot</span>
        <span className="r col-opt">Played</span>
        <span className="r col-opt">Steps</span>
        <span className="r">Your P/L</span>
      </div>

      {/* BOTH EMPTY BRANCHES KEY OFF `rows`, THE PRE-CAP LIST, and must keep doing so. `shown.rows`
          is empty in exactly the same cases plus none, but asking the capped list whether the log is
          empty would be asking a display decision to answer a question about the data. */}
      {history.loading && rows.length === 0 ? (
        <Empty>Reading round accounts…</Empty>
      ) : rows.length === 0 ? (
        <Empty>No settled rounds in this arena yet</Empty>
      ) : (
        <>
          <div id={rowsId}>
            {shown.rows.map((r) => {
              const yours = r.players.find((p) => p.isYou) ?? null;
              return (
                <div key={r.roundNo.toString()} className="row pastround">
                  <span className="num">#{r.roundNo.toString()}</span>
                  <span className="line" style={{ gap: 7 }}>
                    {r.winner === null ? (
                      <span className="u">{r.phase}</span>
                    ) : (
                      <>
                        <Mark side={r.winner} />
                        <span className="u u--ink">{SIDE_TOKEN[r.winner].name}</span>
                      </>
                    )}
                  </span>
                  {/* Same 76px track as the standings above it, same reason. */}
                  <Money units={r.pot} compact className="r" />
                  <span className="num r col-opt">{r.fighterCount}</span>
                  <span className="num r col-opt">{r.tickCount.toString()}</span>
                  <span className="r">{yours ? <Pnl value={yours.pnl} /> : <Dash />}</span>
                </div>
              );
            })}
          </div>
          <ShowMore
            hidden={shown.hidden}
            expanded={expanded}
            noun="round"
            controls={rowsId}
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </Section>
  );
}

// =============================================================================================
// 00-7 PROVABLY FAIR
// =============================================================================================

const VERDICT_TEXT: Record<string, string> = {
  verified:
    "Exact replay. Every fighter's settled state was reproduced from the chain's own revealed seed.",
  "extraction-likely":
    "Diverges, and an extraction explains it: value is still fully conserved on chain, and at least one fighter carries the state an extract() leaves behind. A replay knows the seed but not the moment somebody pressed Extract.",
  mismatch:
    "Diverges in a way extraction cannot explain — wrong seed, wrong entries, wrong step count, or a real bug. Do not trust this round's numbers.",
};

function ProvablyFair() {
  const { live, verify } = useArena();
  // ABOVE EVERY BRANCH BELOW, because hooks are unconditional: this section's body swings between an
  // `Empty` and a 48-row table every time a verification is run, and neither state may change how
  // many hooks this component calls.
  const [expanded, setExpanded] = useState(false);
  const rowsId = useId();
  const settled = live?.phase === "Settled";
  const result = verify.result;
  // NOT RE-SORTED, WHICH IS THE WHOLE REASON THE NUMBER IS WHAT IT IS. `result.fighters` is in entry
  // order and stays in it, so a divergent row can sit below the cut — floating the disagreements to
  // the top would be precisely the ordering decision `rowCap.ts` forbids, in the one table on the
  // page whose subject is wallets rather than people. `ROW_CAP_PROOF`'s note argues why eight is
  // survivable anyway: the verdict and the `Winner agrees` / `Value conserved` figures directly
  // above already state the round's answer in full, and this table is the workings behind it.
  //
  // `?? []` is the unverified state only, which renders `Empty` below and grows no control — a cap
  // over nothing hides nothing.
  const shown = capRows(result?.fighters ?? [], ROW_CAP_PROOF, expanded);

  return (
    <Section
      index="00-7"
      title="Provably fair"
      tools={
        <button
          type="button"
          className="btn btn--sm"
          disabled={!settled || verify.running}
          title={settled ? "Recompute this round in your browser" : "Available once the round settles"}
          onClick={verify.run}
        >
          {verify.running ? "Recomputing…" : "Verify this round"}
        </button>
      }
      lede="The seed's sha256 is committed before the lobby closes, so no outcome can be chosen after entries lock. This replays the whole fight from the revealed seed and the entry list and diffs it against what the chain settled to. It cannot reconstruct the moment anyone extracted — the chain records the effect, not the timing — so an honest extraction shows as a divergence too, and is reported separately rather than as a failure."
    >
      <div className="two" style={{ marginBottom: 24 }}>
        <div>
          <div className="u" style={{ marginBottom: 6 }}>
            Seed commit · sha256
          </div>
          <p className="hex">{live?.seedCommitHex ?? "—"}</p>
        </div>
        <div>
          <div className="u" style={{ marginBottom: 6 }}>
            Revealed seed
          </div>
          <p className="hex">
            {live?.seedHex ?? "— revealed by the VRF callback when the fight starts"}
          </p>
        </div>
      </div>

      {!result ? (
        <Empty>
          {settled ? "Not verified yet — run it above" : "Waiting for this round to settle"}
        </Empty>
      ) : (
        <>
          <div className="verdict">
            <span className="idx">Verdict</span>
            <span className="h h--sm nowrap">{result.verdict.replace("-", " ")}</span>
            <span className="lede">{VERDICT_TEXT[result.verdict]}</span>
          </div>

          <KVs>
            <KV
              value={<span className="num">{result.steps.toLocaleString("en-US")}</span>}
              label="Steps replayed"
            />
            <KV
              value={<span className="num">{SIDE_TOKEN[result.winnerOnChain].name}</span>}
              label="Winner on chain"
            />
            <KV
              value={<span className="num">{SIDE_TOKEN[result.winnerRecomputed].name}</span>}
              label="Winner recomputed"
            />
            <KV
              value={<span className="num">{result.winnerMatches ? "MATCH" : "DIFFERS"}</span>}
              label="Winner agrees"
            />
            {/* THE IDENTITY HAS A THIRD TERM NOW. `extract()` sends a decaying slice of what leaves
                the ring to the house, so value genuinely leaves the round and `sum(hp + banked)` is
                strictly LESS than the pot on any round somebody extracted from. The chain records
                exactly what left, in `Round.penalties_collected`, so the check stays exact — and
                the house's take is shown beside it rather than left as an unexplained shortfall
                between two numbers a reader can add up themselves. */}
            <KV
              value={
                <span className={`num${result.conservationHoldsOnChain ? "" : " neg"}`}>
                  {result.conservationHoldsOnChain ? "HOLDS" : "BROKEN"}
                </span>
              }
              label="Value conserved"
              title="hp + banked, summed across every fighter, plus what the house took in extract penalties, must equal the pot. Extraction moves value and prices the move; it never creates any."
            />
            <KV
              value={
                result.penaltiesCollectedOnChain === 0n ? (
                  <Dash />
                ) : (
                  <span className="num neg">{penaltyText(result.penaltiesCollectedOnChain)}</span>
                )
              }
              label="House took · penalties"
              title="Round.penalties_collected, straight off the account: the sum of every extract penalty charged in this round. A dash means nobody extracted, so nothing left the pot."
            />
          </KVs>

          {/* THE COMPARISON TABLE STAYS FULL PRECISION, and its tracks are `1.2fr` rather than fixed
              px precisely so it can. The entire claim of this section is that two independently
              computed numbers are the SAME number; compacting both sides would round a genuine
              one-unit divergence into two identical strings and turn the page's proof into a
              coincidence. Width is the thing that yields here, not the figure. */}
          <div className="row row--head verifyrow" style={{ marginTop: 22 }}>
            <span>Fighter</span>
            <span>Side</span>
            <span>On chain · hp / banked</span>
            <span className="col-opt">Recomputed · hp / banked</span>
            <span className="r">Agrees</span>
          </div>
          {/* The wrapper is `aria-controls`' target and nothing else — the header row above it keeps
              its own `marginTop`, and stays outside because it is not one of the rows being
              revealed. See the note in `Roster`. */}
          <div id={rowsId}>
            {shown.rows.map((f) => (
              <div key={f.wallet} className="row verifyrow">
                {/* THE ADDRESS, AND ONLY THE ADDRESS — the one fighter list on this page that gets no
                    name plate, deliberately. This table's whole claim is that a number the chain
                    settled and a number this browser recomputed are the same number, and its subject
                    is therefore the WALLET the program credited, not the person holding it. A handle
                    here would be an identity standing where a key belongs in a proof, and there is
                    nothing to check it against.

                    This cell used to print `nameFor()`'s pseudonym in front of the key, on the
                    argument that a column of raw base58 proves nothing to a reader who cannot match it
                    to a row. The key is truncated and the full one is on the row's title, so that job
                    was already being done by the thing beside it; what the pseudonym added was a
                    second string that looked like a name and was not one. */}
                <span className="trunc num" title={f.wallet}>
                  {shortKey(f.wallet)}
                </span>
                {/* The whole cell under a "Side" header is the square, so the square has to say it.
                    The verify table is the page's proof, and a proof with a column its reader cannot
                    read is not one. */}
                <span className="line" style={{ gap: 6 }}>
                  <Mark side={f.side} label={SIDE_TOKEN[f.side].name} />
                </span>
                <span className="num">
                  {usd(f.onChain.hp)} / {usd(f.onChain.banked)}
                  {f.onChain.dead ? " · out" : ""}
                </span>
                <span className="num col-opt">
                  {usd(f.recomputed.hp)} / {usd(f.recomputed.banked)}
                  {f.recomputed.dead ? " · out" : ""}
                </span>
                <span className="u r">
                  {f.matches ? "Yes" : f.extractionSignature ? "Extract" : "No"}
                </span>
              </div>
            ))}
          </div>
          <ShowMore
            hidden={shown.hidden}
            expanded={expanded}
            noun="fighter"
            controls={rowsId}
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </Section>
  );
}

// =============================================================================================

export function ArenaView() {
  return (
    <div className="arena-view">
      {/* THE DOCUMENT'S TITLE, WHICH THE CHROME CARRIES VISUALLY AND THE OUTLINE OTHERWISE LACKS.
          Every other screen prints its name in a `<h1 className="display">` at the top of the page;
          this one has no slot for one and should not grow one — the screen's name is in the bottom
          nav's `[00] ARENA` and the round's identity is in the top bar, both permanently on screen,
          which is exactly why the design put them there. But a screen whose heading outline starts at
          `<h2>` has no top level: "jump to the first heading" lands in the middle of the page, and a
          reader listing headings gets seven sections belonging to nothing.
          So it is hidden rather than absent. Not a workaround — the same title, in the channel the
          fixed chrome cannot reach. The two sides come from `SIDE_TOKEN` rather than being typed out,
          for the same reason every other name on this page does: the arena's tokens are a constant,
          and a hardcoded pair here would be the last place anyone looked when they change. */}
      <h1 className="sr">
        Arena — {SIDE_TOKEN[0].name} vs {SIDE_TOKEN[1].name}
      </h1>
      <TheRound />
      <TheArena />
      <Deploy />
      <Extract />
      <TheField />
      <Exchanges />
      <RoundStandings />
      <PreviousRounds />
      <ProvablyFair />
    </div>
  );
}
