// 04 — HISTORY. Two lists over the same source, the permanent round log:
//
//   04-1 MY PREVIOUS ROUNDS — your rounds only: what you deployed, what came back, what that cost
//        or paid. Expand a row for the shape of the round it happened in and where you finished.
//   04-2 EVERY ROUND        — every round that exists, newest first, expanding to every player in
//        it. The whole field, not just the winners: a history that only shows profits is an
//        advertisement.
//
// Every row here is chain-derived. Nothing on this screen is simulated, so nothing carries a `SIM`
// marker — its absence is information too.
//
// Both lists are disclosures built from real <button> elements rather than click handlers on a div.
// That is the whole keyboard story: focus, Enter, Space and a focus ring all come for free, and
// `aria-expanded` tells a screen reader what the arrow is about to do.
//
// TWO CLAIMS THIS SCREEN USED TO MAKE AND CANNOT BACK:
//
//   "EVERY ROUND THIS ARENA HAS EVER RUN". `useHistory` fetches the newest 250 round accounts and
//   tolerates a read that fails. That is a window, and on an arena with 251 rounds the sentence
//   becomes false with nothing on screen changing. The head now prints what was read against what
//   the arena has opened, so the window is a visible figure rather than an assumption.
//
//   "DEPOSIT". `RoundPlayer.stake` is what the chain stored AFTER the arena took its entry fee at
//   the door, so a column headed "Deposit" reported less than the player was charged. The per-round
//   gross IS knowable — `grossDeposits()` off `pot + feesCollected` — and the expanded round panel
//   now shows it beside the pot and names what the house kept. Per PLAYER it is not: the fee is
//   recorded on the round, not on the fighter, so those columns carry the qualification in their
//   label instead of a number this page would have had to invent.

import { useMemo, useState } from "react";
import { useArena } from "../data/useArena.ts";
import { Empty, Mark, Money, Section, Tag } from "../ui/primitives.tsx";
import { ScrollBox } from "./ScrollBox.tsx";
import { coverageFigure, coverageNote } from "./coverage.ts";
import {
  SIDE_TOKEN,
  grossDeposits,
  houseTook,
  usd,
  usdCompact,
  usdCompactSigned,
  usdSigned,
  type RoundPlayer,
  type RoundSummary,
} from "../contract.ts";
import "./screens.css";

/** 04-2's heading, hoisted because it is said twice: printed at the top of the section, and spoken
 *  as the name of the scrolling box the log sits in. One string, so the two cannot drift. */
const EVERY_ROUND = "Every round — all players";

/** One of your entries, carrying the round it belongs to so the row can be expanded in place. */
interface MyEntry {
  round: RoundSummary;
  me: RoundPlayer;
  /** 1-based finish among that round's field, by P/L. */
  rank: number;
}

export function HistoryView() {
  const { history, logCoverage, you, live, source } = useArena();

  const mine = useMemo<MyEntry[]>(() => {
    const out: MyEntry[] = [];
    for (const round of history.rounds) {
      const me = round.players.find((p) => p.wallet === you.pubkey);
      if (!me) continue;
      const ranked = [...round.players].sort((a, b) => (b.pnl > a.pnl ? 1 : b.pnl < a.pnl ? -1 : 0));
      out.push({ round, me, rank: ranked.indexOf(me) + 1 });
    }
    return out;
  }, [history.rounds, you.pubkey]);

  const totals = useMemo(() => {
    let staked = 0n;
    let back = 0n;
    let won = 0;
    for (const e of mine) {
      staked += e.me.stake;
      back += e.me.final;
      if (e.round.winner === e.me.side) won += 1;
    }
    return { staked, back, pnl: back - staked, won };
  }, [mine]);

  // THE WINDOW THIS SCREEN IS. `logCoverage` knows both what was read back and what the arena has
  // actually opened, which is the difference between "every round" (a claim) and "the newest 250 of
  // 613" (a fact). See `views/coverage.ts`.
  const logged = logCoverage.rounds;
  const opened = logCoverage.roundsEverOpened;

  return (
    <div className="scr">
      <header className="scr-head">
        <span className="idx">04</span>
        <div className="scr-head-main">
          <h1 className="display">History</h1>
          <p className="lede">
            The rounds this page has read back, and every player in them. Read from the round
            accounts themselves — the log survives reloads, wallets and operators, because it was
            never in the browser to begin with.{" "}
            {logCoverage.complete
              ? `All ${logged} this arena has opened are here.`
              : opened === null
                ? `The ${logged} newest are here; how many the arena has opened is not known to this page.`
                : `The ${logged} newest of ${opened} are here — the rest are still on chain, they are simply not fetched.`}
          </p>
        </div>
        <div className="scr-head-meta">
          <span className="u" title={coverageNote(logCoverage)}>
            Rounds logged · <span className="u--ink">{coverageFigure(logCoverage)}</span>
          </span>
          <span className="u">
            Yours · <span className="u--ink">{mine.length}</span>
          </span>
          <span className="u">
            Live now · <span className="u--ink">{live ? `#${live.roundNo}` : "—"}</span>
          </span>
          <span className="u">
            Provenance · <Tag kind={source === "chain" ? "live" : "sim"} />
            {source === "fixture" ? <span className="u--faint"> fixture data</span> : null}
          </span>
        </div>
      </header>

      <Section
        index="04-1"
        title="My previous rounds"
        lede="What reached the ring for you — your deploy less the arena's entry fee, which is taken at the door — everything you got back, raided, banked and extracted included, and the difference. Your side can lose the round and you can still come out ahead: raids bank as you take them. Open a row for the round it happened in."
        tools={
          mine.length ? (
            <span className="u">
              {/* Header summary, not a grid cell — but a wallet with enough rounds logged can still
                  carry a live-chain P/L past what a header line should spend width on, so this
                  compacts too. */}
              {mine.length} rounds ·{" "}
              <span className={totals.pnl >= 0n ? "pos" : "neg"}>{usdCompactSigned(totals.pnl)}</span> net
            </span>
          ) : undefined
        }
      >
        {history.error ? (
          <Empty>Could not read the round log — {history.error}</Empty>
        ) : mine.length === 0 ? (
          <Empty>
            {history.loading
              ? "Reading the round log…"
              : "No settled rounds for this wallet yet. Deploy once and the first row lands here when it resolves."}
          </Empty>
        ) : (
          <div className="rows sc-tbl sc-tbl--mine">
            <div className="row row--head">
              <div>Round</div>
              <div>Side</div>
              {/* NOT "result": whether your SIDE won and whether YOU made money are different
                  questions, and this column answers the first one. A row can read "no" beside a
                  positive P/L, and that is the game working as designed. */}
              <div title="Did the side you deployed on win the round?">Side won</div>
              {/* "NET DEPOSIT": `stake` is stored after the entry fee. See the head of this file for
                  why the gross cannot be given per player. */}
              <div
                className="r sc-s"
                title="What reached the ring — your deposit net of the arena's entry fee, which is charged at the door and never enters the pot"
              >
                Net deposit
              </div>
              <div className="r sc-s">Got back</div>
              <div className="r">P/L</div>
              <div />
            </div>
            {mine.map((e) => (
              <MyRow key={e.round.roundNo.toString()} entry={e} />
            ))}
            <div className="row sc-total">
              <div className="u u--ink">Total</div>
              <div />
              <div className="u">{totals.won} of {mine.length}</div>
              <div className="r sc-s num">{usdCompact(totals.staked)}</div>
              <div className="r sc-s num">{usdCompact(totals.back)}</div>
              <div className={`r num ${totals.pnl >= 0n ? "pos" : "neg"}`}>{usdCompactSigned(totals.pnl)}</div>
              <div />
            </div>
          </div>
        )}
      </Section>

      <Section
        index="04-2"
        title={EVERY_ROUND}
        lede="Newest first. Each round opens to everyone who deployed in it, what reached the ring for them and what they walked away with. The pot is net of the arena's entry fee; an opened round states what its players were charged at the door beside it."
      >
        {history.rounds.length === 0 ? (
          <Empty>
            {history.loading
              ? "Reading the round log…"
              : "No rounds yet — the first appears as soon as one settles."}
          </Empty>
        ) : (
          // THE SAME STOP AS THE LEADERBOARD'S, AND ON PURPOSE, even though the case for it here is
          // weaker: every row of this log is a real disclosure <button>, so a keyboard could already
          // walk the list and the browser scrolled the box to follow it — this box was never the
          // WCAG 2.1.1 failure the three boards on 01 were. What it was, was a box that scrolled by
          // one rule on one screen and a different rule on another. Conditioning the stop on "this
          // box can scroll" is a fact about the box that stays true as tables change; conditioning it
          // on "and has nothing focusable inside" would silently retune itself the day someone adds a
          // sort control to a leaderboard or takes the disclosure off a round — a behaviour that
          // moves for reasons unrelated to itself. One rule, one gesture, everywhere `.sc-wrap` is.
          <ScrollBox label={EVERY_ROUND}>
            <div className="rows sc-tbl sc-tbl--rnd">
              <div className="row row--head">
                <div>Round</div>
                <div>Winner</div>
                <div className="r sc-s">Played</div>
                <div className="r">Pot</div>
                <div className="r sc-s">Steps</div>
                <div />
              </div>
              {history.rounds.map((r, i) => (
                <RoundRow
                  key={r.roundNo.toString()}
                  round={r}
                  youKey={you.pubkey}
                  defaultOpen={i === 0}
                />
              ))}
            </div>
          </ScrollBox>
        )}
      </Section>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   04-1 · one of your rounds
   --------------------------------------------------------------------------------------------- */

function MyRow({ entry }: { entry: MyEntry }) {
  const [open, setOpen] = useState(false);
  const { round, me, rank } = entry;
  const won = round.winner === me.side;
  return (
    <>
      <button
        type="button"
        className="row sc-rowbtn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="num">#{round.roundNo.toString()}</span>
        <span className="sc-side">
          <Mark side={me.side} dead={me.dead} />
          <span className="u">{SIDE_TOKEN[me.side].name}</span>
        </span>
        <span className="u u--ink">{won ? "yes" : "no"}</span>
        <Money units={me.stake} compact className="r sc-s" />
        <Money units={me.final} compact className="r sc-s" />
        <Money units={me.pnl} signed compact className="r" />
        <span className={`sc-chev${open ? " sc-chev--on" : ""}`} aria-hidden="true">
          ▸
        </span>
      </button>
      {open ? (
        // FULL PRECISION THROUGHOUT THIS PANEL, DELIBERATELY. Unlike the row above it (a fixed-width
        // grid cell you scan past), this is a workings panel a reader opens on purpose to check the
        // round's arithmetic against their own figure — `usdCompact` rounding away cents here would
        // undermine the exact reason the panel exists. Several `Fact`s below already ask for `dp={2}`
        // for the same reason; `usd()`'s default is left alone everywhere else in it.
        <div className="sc-det">
          <div className="sc-g4">
            <div className="sc-grp">
              <div className="sc-grp-h">
                <span className="u u--ink">The round</span>
              </div>
              {/* THE TWO SIDES OF THE DOOR, in the panel a reader opens precisely to check the
                  arithmetic. `pot` is net of the entry fee, so it is what was fought over; the fee
                  is what the arena took before any of it reached the ring. Shown only when the
                  round recorded a fee — a round from a program revision that predates
                  `fees_collected` genuinely collected nothing, and printing "charged $X, pot $X"
                  twice would be noise. */}
              {round.feesCollected > 0n ? (
                <Fact
                  n="Charged at the door · USD"
                  v={usd(grossDeposits(round))}
                  title="What the players in this round were actually charged: the pot plus the arena's entry fee, which is taken on the way in and never enters the pot."
                />
              ) : null}
              <Fact n="Pot · USD" v={usd(round.pot)} />
              {/* Without this the round's own books look wrong: the player finals below sum to LESS
                  than the pot whenever anyone extracted, because the extract penalty left the round
                  entirely. Naming what the house took is what closes the gap — an unexplained
                  shortfall on a money screen reads as a bug in the arithmetic, or worse. Shown only
                  when it is non-zero, so rounds nobody extracted from stay uncluttered. */}
              {round.penaltiesCollected > 0n ? (
                <Fact
                  n="House took · early exits"
                  v={usd(round.penaltiesCollected)}
                  title="The extract penalty on everything pulled out of this round mid-fight. It is the only value besides the entry fee that leaves a round — everything else moves between fighters, which is why the finals below plus this equal the pot."
                />
              ) : null}
              {/* Both sources at once, through the one definition `houseTook()` exists to be — shown
                  only when they are both in play, since either alone is already on its own line. */}
              {round.feesCollected > 0n && round.penaltiesCollected > 0n ? (
                <Fact
                  n="House took · total"
                  v={usd(houseTook(round))}
                  title="The entry fee taken at the door plus the early-exit penalties taken mid-fight — everything this round earned the house."
                />
              ) : null}
              <Fact n="Fighters" v={`${round.fighterCount}`} />
              <Fact n="Steps simulated" v={round.tickCount.toLocaleString("en-US")} />
            </div>
            <div className="sc-grp">
              <div className="sc-grp-h">
                <span className="u u--ink">The result</span>
              </div>
              <Fact
                n="Winning side"
                v={round.winner === null ? "—" : SIDE_TOKEN[round.winner].name}
              />
              <Fact n="Your side" v={SIDE_TOKEN[me.side].name} />
              <Fact n="You finished" v={`${rank} of ${round.players.length} by P/L`} />
            </div>
            <div className="sc-grp">
              <div className="sc-grp-h">
                <span className="u u--ink">Your money</span>
              </div>
              <Fact
                n="Reached the ring · USD"
                v={usd(me.stake, 2)}
                title="Your deposit less the arena's entry fee. The fee is charged per entry and recorded on the round, not on you, so what you personally paid at the door cannot be split back out here — the round's own figure is above."
              />
              <Fact n="Returned · USD" v={usd(me.final, 2)} />
              <Fact
                n="Return"
                v={me.stake > 0n ? `${(Number(me.final) / Number(me.stake)).toFixed(2)}×` : "—"}
                title="Returned ÷ what reached the ring. Both are net of the entry fee, so the ratio is like-for-like."
              />
            </div>
            <div className="sc-grp">
              <div className="sc-grp-h">
                <span className="u u--ink">Outcome</span>
              </div>
              <Fact n="P/L · USD" v={usdSigned(me.pnl)} />
              <Fact n="Wiped out" v={me.dead ? "yes" : "no"} />
              <Fact n="Round state" v={round.phase.toLowerCase()} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Fact({ n, v, title }: { n: string; v: string; title?: string }) {
  return (
    <div className="sc-fx" title={title}>
      <span className="sc-fx-n">{n}</span>
      <span className="sc-fx-v">{v}</span>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   04-2 · one round, and everyone in it
   --------------------------------------------------------------------------------------------- */

function RoundRow({
  round,
  youKey,
  defaultOpen,
}: {
  round: RoundSummary;
  youKey: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Best round first, so the row that opens reads as a result rather than as a database dump.
  const players = useMemo(
    () => [...round.players].sort((a, b) => (b.pnl > a.pnl ? 1 : b.pnl < a.pnl ? -1 : 0)),
    [round.players],
  );
  return (
    <>
      <button
        type="button"
        className="row sc-rowbtn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="num">#{round.roundNo.toString()}</span>
        <span className="sc-side">
          {round.winner === null ? (
            <span className="u">{round.phase.toLowerCase()}</span>
          ) : (
            <>
              <Mark side={round.winner} />
              <span className="u u--ink">{SIDE_TOKEN[round.winner].name}</span>
            </>
          )}
        </span>
        <span className="num r dim sc-s">{round.fighterCount} played</span>
        <Money units={round.pot} compact className="r" />
        <span className="num r dim sc-s">{round.tickCount.toLocaleString("en-US")}</span>
        <span className={`sc-chev${open ? " sc-chev--on" : ""}`} aria-hidden="true">
          ▸
        </span>
      </button>
      {open ? (
        <div className="sc-det">
          {/* THE ROUND'S BOOKS, IN ONE LINE, above the field it belongs to. The row above prints the
              pot; the pot is net of the entry fee, so on its own it understates what this round's
              players were charged. `grossDeposits` and `houseTook` are the two figures that close
              that gap, and they appear only on rounds that recorded one — a round from a program
              revision without `fees_collected` collected nothing, which is the true value, not a
              missing read. */}
          {houseTook(round) > 0n ? (
            <p className="u sc-books">
              {/* The door clause appears only when there WAS a fee. On a round from a revision that
                  charged none, gross and pot are the same number and printing both would invent a
                  distinction this round does not have. */}
              {round.feesCollected > 0n ? (
                <>
                  Charged at the door ·{" "}
                  <span className="u--ink">{usdCompact(grossDeposits(round))}</span> · reached the
                  ring <span className="u--ink">{usdCompact(round.pot)}</span> ·{" "}
                </>
              ) : null}
              House took <span className="u--ink">{usdCompact(houseTook(round))}</span>
              {round.feesCollected > 0n && round.penaltiesCollected > 0n
                ? ` — ${usdCompact(round.feesCollected)} entry fee, ${usdCompact(round.penaltiesCollected)} early exits`
                : round.penaltiesCollected > 0n
                  ? " in early-exit penalties"
                  : " in entry fees"}
            </p>
          ) : null}
          <div className="rows sc-tbl sc-tbl--plr" role="table" aria-label={`Round ${round.roundNo} players`}>
            <div className="row row--head" role="row">
              <div role="columnheader">Fighter</div>
              <div role="columnheader">Side</div>
              <div
                role="columnheader"
                className="r sc-s"
                title="What reached the ring for this player — their deposit net of the arena's entry fee"
              >
                Net stake
              </div>
              <div role="columnheader" className="r sc-s">
                Final
              </div>
              <div role="columnheader" className="r">
                P/L
              </div>
            </div>
            {players.map((p, i) => (
              <div
                key={`${p.wallet}-${i}`}
                role="row"
                className={`row${p.wallet === youKey ? " row--you" : ""}${p.dead ? " row--dead" : ""}`}
              >
                <div role="cell" className="sc-who" title={p.wallet}>
                  <span className="sc-who-n">{p.name}</span>
                  {p.wallet === youKey ? <span className="u u--ink">you</span> : null}
                  <span className="sc-who-k">{p.short}</span>
                </div>
                <div role="cell" className="sc-side">
                  <Mark side={p.side} dead={p.dead} />
                  <span className="u">{SIDE_TOKEN[p.side].name}</span>
                </div>
                <div role="cell" className="num r sc-s">
                  {usdCompact(p.stake)}
                </div>
                {/* $0.00, not `—`: this player was wiped out, which is a measured result. The
                    dash is reserved for figures the page has no data behind at all. */}
                <div role="cell" className="num r sc-s">
                  {usdCompact(p.final)}
                </div>
                <div role="cell" className="r">
                  <Money units={p.pnl} signed compact />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
