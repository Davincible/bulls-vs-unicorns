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

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ARENAS,
  EXTRACT_PENALTY_START_BPS,
  FEE_BPS,
  FIGHT_TIMEOUT_SECONDS,
  MAX_STEPS,
  MIN_STAKE_USD,
  ONE_CENT_UNITS,
  SIDE_TOKEN,
  STAKE_CAP_USD,
  STAKE_PRESETS,
  UNITS_PER_USD,
  bpsPct,
  clock,
  entriesOpen,
  nameFor,
  shortKey,
  sideTotals,
  stepsPerSecond,
  usd,
  usdToUnits,
  worth,
  type ArenaMeta,
  type BoardStyle,
  type FighterView,
  type LiveRound,
  type Mode,
  type Side,
} from "../contract.ts";
import { useArena } from "../data/useArena.ts";
import { abandonText, simBankrollUsd, type AmountRule } from "../data/autoDeploy.ts";
import { ArenaCanvas } from "../arena/ArenaCanvas.tsx";
import { Bar, Dash, Empty, KV, KVs, Mark, Money, Section, Seg, Tag } from "../ui/primitives.tsx";
import { RoundPhaseNote } from "../ui/RoundPhaseNote.tsx";
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

/** Time left on the bell — the outer bound on a fight, after which anyone may settle it. */
function bellLeft(live: LiveRound): string {
  return clock(Math.max(0, FIGHT_TIMEOUT_SECONDS - live.elapsedSec));
}

/** The pace THIS round runs at. It is per-fighter (`n * 2`), not a constant: a 2-fighter duel and a
 *  16-fighter brawl cannot share one rate, and a caption quoting a fixed number would be describing
 *  a fight the chain is not running. */
function paceLine(fighterCount: number): string {
  const rate = stepsPerSecond(fighterCount);
  return `${rate} steps/sec · 2 per fighter · stops at ${MAX_STEPS.toLocaleString("en-US")}`;
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
  const fighters = live?.fighters ?? [];
  const [aTot, bTot] = sideTotals(fighters);
  const alive = fighters.filter((f) => !f.dead).length;

  // One slot, three different facts depending on where the round is: who won, that anyone may end
  // it right now, or how long is left on the bell. All three answer the same question — how much
  // longer is this open — which is why they share a cell instead of taking three.
  const settleKv =
    live?.phase === "Settled" && live.winner !== null
      ? { value: SIDE_TOKEN[live.winner].name, label: "Winner" }
      : live?.resolvable
        ? { value: "ANYONE MAY", label: "Settle now" }
        : live?.phase === "Fight"
          ? { value: bellLeft(live), label: "Bell in" }
          : { value: <Dash />, label: "Bell in" };

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
              Pot on the table · {fighters.length} fighters · {alive} still alive
            </p>
          </div>
          <div className="hero-r">
            <div className="hero-phase">
              {live ? live.phase : status.loading ? "Loading" : "No round"}
            </div>
            <div className="num num--lg" style={{ marginTop: 8 }}>
              {clock(live?.elapsedSec ?? 0)}
            </div>
            <div className="u" style={{ marginTop: 6 }}>
              {(live?.stepsNow ?? 0).toLocaleString("en-US")} / {MAX_STEPS.toLocaleString("en-US")}{" "}
              steps
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
        {/* Not a countdown. A round becomes settleable when one side has nobody left standing, or
            when the bell rings — whichever comes first — so the honest readout is the flag plus,
            during a fight, how long is left on the bell. */}
        <KV
          value={<span className="num">{settleKv.value}</span>}
          label={settleKv.label}
          title={`A round can be settled by anyone once one side has nobody left standing, or once the ${FIGHT_TIMEOUT_SECONDS}s bell rings. That moment — not a fixed countdown — is the deadline an extract is racing.`}
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
      <span className="num">{ticker.stepsAdvanced.toLocaleString("en-US")}</span> steps advanced
    </span>
  );
}

function TheArena() {
  const { live, hitEvents, arenaId, setArenaId, board, setBoard, mode, sideRecord } = useArena();
  const { setRail, inspectedWallet } = useShell();
  // The pre-fight plate below says the same thing the dock and 00-3 say, from the same object.
  const phaseCopy = useRoundPhase();

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
        </>
      }
    >
      <StrengthBar a={aTot} b={bTot} />

      {/* The board style is carried by the FRAME, and the overlays inside it are styled off that one
          class (`.frame--blank .ovl`). Threading a modifier onto each overlay would be three places
          for the two halves of one look to fall out of step. */}
      <div className={`frame frame--${board}`}>
        <div className="frame-fill">
          <ArenaCanvas
            fighters={fighters}
            hitEvents={hitEvents}
            fightStartedAtMs={live?.fightStartedAtMs ?? null}
            phase={phase}
            board={board}
            sideRecord={sideRecord}
            onSelect={onSelect}
            selectedId={selectedId}
          />
        </div>

        <div className="ovl ovl--tl">
          <div className="ovl-line">
            <span className="u u--ink">{phase}</span>
            <span className="num">{clock(live?.elapsedSec ?? 0)}</span>
            <span className="u">
              {(live?.stepsNow ?? 0).toLocaleString("en-US")}/{MAX_STEPS.toLocaleString("en-US")}
            </span>
          </div>
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
  const { live, status, actions, autoDeploy, mode, setMode, toasts } = useArena();
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
  const feeUnits = (stakeUnits * BigInt(FEE_BPS)) / 10_000n;

  /** A LIVE CLOCK, because the deposit deadline is a time and not a phase.
   *
   *  `live` only changes when a poll lands or, during Fight, on the 250ms clock — neither of which
   *  runs down the lobby. Without a tick of its own, this panel would keep offering deposits for as
   *  long as the phase said Lobby, which is exactly the window in which the chain refuses them (see
   *  `LiveRound.lobbyClosesAtMs`). One second is the resolution the countdown is read at, and
   *  `useSecondTick` is the same clock the phase note runs on — two intervals at one rate cannot
   *  disagree about which second it is, which a 1s and a 250ms one could. */
  const nowMs = useSecondTick(phase === "Lobby");

  const open = entriesOpen(live, nowMs) && !status.programError;

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
          ? `Stake is an on-chain u64, shown at ${UNITS_PER_USD.toLocaleString("en-US")} units = $1.00. The arena deducts ${(FEE_BPS / 100).toFixed(2)}% on entry, so ${usd(stakeUnits)} puts ${usd(stakeUnits - feeUnits)} in the ring. Max ${usd(usdToUnits(STAKE_CAP_USD))} a side.`
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
  const eligible = actions.extractEligible;
  const terms = live?.extractTerms ?? null;
  const fighting = live?.phase === "Fight";

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
              {!session.active && fighting
                ? " A session key would sign this without a wallet prompt (panel, bottom right)."
                : ""}
            </p>
          ) : (
            <p className="lede" style={{ marginTop: 10 }}>
              Your fighter leaves the fight immediately and stops being a target. Anything already
              banked stays banked; what is in the ring is split — most of it into your bank, the rest
              out of the round entirely, to the house. Nothing of yours stays on the field.
            </p>
          )}
          {fighting && live ? (
            <p className="u" style={{ marginTop: 12 }}>
              {live.resolvable
                ? "Settleable now — anyone can end this round at any moment"
                : `Bell in ${bellLeft(live)} · ${stepsPerSecond(live.fighters.length)} steps/sec`}
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
              title={`A fight's length in steps grows with the lineup, so the horizon does too: ${live?.fighters.length ?? 0} fighters here. From this step on, extracting costs nothing.`}
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
  const { setRail } = useShell();
  const all = live?.fighters ?? [];
  const rows = all.filter((f) => f.side === side).sort((x, y) => (y.hp > x.hp ? 1 : y.hp < x.hp ? -1 : 0));
  const total = rows.reduce((s, f) => s + worth(f), 0n);
  const alive = rows.filter((f) => !f.dead).length;

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
        <Empty>No fighters on this side yet</Empty>
      ) : (
        rows.map((f, i) => (
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
            <span className="trunc">{f.isYou ? "YOU" : f.name}</span>
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
        ))
      )}
    </div>
  );
}

function TheField() {
  const { live } = useArena();
  const fighters = live?.fighters ?? [];

  return (
    <Section
      index="00-4"
      title="The field"
      tools={<RoundTag />}
      lede={
        fighters.length === 0
          ? "Nobody has entered yet. The lobby stays open until an operator closes it and draws the seed."
          : undefined
      }
    >
      <div className="two">
        <Roster side={0} />
        <Roster side={1} />
      </div>
    </Section>
  );
}

// =============================================================================================
// 00-5 STANDINGS (this round)
// =============================================================================================

function RoundStandings() {
  const { live } = useArena();
  const { setRail } = useShell();
  const rows = [...(live?.fighters ?? [])].sort((x, y) => {
    const d = pnlOf(y) - pnlOf(x);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });
  const alive = rows.filter((f) => !f.dead).length;
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
        rows.map((f, i) => (
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
            <span className="trunc">{f.isYou ? "YOU" : f.name}</span>
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
        ))
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
  const rows = history.rounds.slice(0, 8);

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

      {history.loading && rows.length === 0 ? (
        <Empty>Reading round accounts…</Empty>
      ) : rows.length === 0 ? (
        <Empty>No settled rounds in this arena yet</Empty>
      ) : (
        rows.map((r) => {
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
        })
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
  const settled = live?.phase === "Settled";
  const result = verify.result;

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
          {result.fighters.map((f) => (
            <div key={f.wallet} className="row verifyrow">
              {/* Named, not raw base58: this is the same cast as the roster two sections up, and a
                  column of keys nobody can match to a row proves nothing to a reader. */}
              <span className="trunc" title={f.wallet}>
                {nameFor(f.wallet)} <span className="dim num">{shortKey(f.wallet)}</span>
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
      <RoundStandings />
      <PreviousRounds />
      <ProvablyFair />
    </div>
  );
}
