// 02 — DASHBOARD. Three bands, in descending order of "would a player care": the arena right now,
// your position, the house. Built to UI-SPEC.md Part 2, including the tiles it says to DROP —
// "accounts / created / busted", the ~9,000 "all-time total" that was never a real figure, and the
// per-side damage counters are not here and are not coming back.
//
// THE FOUR RULES, which is most of why this file looks the way it does:
//   1. Every figure names its unit. No bare numbers anywhere.
//   2. Nothing is derived from live balances. All-time facts come from the round log via
//      `standings`/`history`, which is survivorship-free; the only live reads are the CURRENT
//      round's own pot and your own ring position, which is what "right now" means.
//   3. A figure with no backing data shows `—`, never `0`. `0` is a claim; `—` is the truth.
//   4. Token names come from `SIDE_TOKEN`, never hardcoded — "Bulls"/"Unicorns" is ANSEM's old
//      label and was wrong on every screen the moment a second arena existed.
//
// AND ONE MORE, which the ER program forces: it custodies nothing. There are no token accounts, no
// deposits, no house treasury and no referral split on chain. Those figures come from the local
// simulated ledger and every one of them carries a `SIM` marker. A money-shaped number with nothing
// behind it, unlabelled, is the single thing this page must never ship.

import { useMemo } from "react";
import type { ReactNode } from "react";
import { useArena } from "../data/useArena.ts";
import { Dash, Empty, Mark, Section, Tag } from "../ui/primitives.tsx";
import {
  EXTRACT_PENALTY_START_BPS,
  FEE_BPS,
  FIGHT_TIMEOUT_SECONDS,
  SIDE_TOKEN,
  bpsPct,
  clock,
  usd,
  usdCompact,
  usdCompactSigned,
  usdToUnits,
  worth,
  type RoundSummary,
} from "../contract.ts";
import "./screens.css";

export function DashboardView() {
  const { live, standings, history, you, sim, status, source } = useArena();

  // Round-derived figures are only "chain" when the round log actually came off the chain. When the
  // page has fallen back to the fixture, every one of them is marked SIM alongside the treasury —
  // the marker means "this is not on chain", and a fixture round is not on chain.
  const chain = source === "chain" ? "live" : "sim";

  // Everything all-time, in one pass over the round log. Deliberately NOT from live balances: a
  // balance sheet is a survey of survivors, and it reads ~0 for anyone whose stake is in the ring.
  const log = useMemo(() => {
    let stakedA = 0n;
    let stakedB = 0n;
    let takenA = 0n;
    let takenB = 0n;
    let winsA = 0;
    let winsB = 0;
    let settled = 0;
    let potAll = 0n;
    for (const r of history.rounds) {
      potAll += r.pot;
      for (const p of r.players) {
        if (p.side === 0) {
          stakedA += p.stake;
          // In a closed ring every dollar a player ends up with above their stake was raided off
          // the other side. Summing the positive P/L of one side is therefore exactly what that
          // side took — and the two figures are never added together, per UI-SPEC.
          if (p.pnl > 0n) takenA += p.pnl;
        } else {
          stakedB += p.stake;
          if (p.pnl > 0n) takenB += p.pnl;
        }
      }
      if (r.phase === "Settled") {
        settled += 1;
        if (r.winner === 0) winsA += 1;
        else if (r.winner === 1) winsB += 1;
      }
    }
    return { stakedA, stakedB, takenA, takenB, winsA, winsB, settled, potAll };
  }, [history.rounds]);

  // The newest settled round that isn't the one on screen.
  const last = useMemo<RoundSummary | null>(() => {
    for (const r of history.rounds) {
      if (r.phase !== "Settled") continue;
      if (live && r.roundNo >= live.roundNo) continue;
      return r;
    }
    return null;
  }, [history.rounds, live]);

  // From `standings`, filtered to this wallet — the SAME row the leaderboard draws, so a profile
  // and the board it was opened from cannot disagree. That disagreement was bug #1 in UI-SPEC.md.
  const mine = useMemo(
    () => standings.find((s) => s.wallet === you.pubkey) ?? null,
    [standings, you.pubkey],
  );

  // Your position in the CURRENT round only. This one is a live read, and it should be: "in the
  // ring" is a statement about right now, not an all-time aggregate.
  const inRing = useMemo(() => {
    const fs = live?.fighters.filter((f) => f.isYou) ?? [];
    if (!fs.length) return null;
    return {
      hp: fs.reduce((s, f) => s + f.hp, 0n),
      banked: fs.reduce((s, f) => s + f.banked, 0n),
      stake: fs.reduce((s, f) => s + f.stake, 0n),
      side: fs[0].side,
      alive: fs.some((f) => !f.dead),
    };
  }, [live]);

  const [tokA, tokB] = SIDE_TOKEN;
  const fighters = live?.fighters.length ?? 0;
  const deployTotal = log.stakedA + log.stakedB;
  const pctA = deployTotal > 0n ? (Number(log.stakedA) / Number(deployTotal)) * 100 : 50;

  // Treasury is the simulated ledger's, in dollars. Zero here means "no simulated deploy has been
  // made in this browser", which is an absence of data, not a house that has taken nothing.
  const treasury = sim.ledger.treasury.ansem + sim.ledger.treasury.uwu;

  // Chain-derived, unlike everything else in this band: `penalties_collected` is written by the
  // program itself on every extract, so summing it over the round log is a real house take rather
  // than a model of one.
  const penaltyTake = history.rounds.reduce((sum, r) => sum + r.penaltiesCollected, 0n);
  const roundsWithExits = history.rounds.filter((r) => r.penaltiesCollected > 0n).length;

  return (
    <div className="scr">
      <header className="scr-head">
        <span className="idx">02</span>
        <div className="scr-head-main">
          <h1 className="display">Dashboard</h1>
          <p className="lede">
            What is on the table, where you stand, and what the house is doing. Every all-time
            figure is read from the permanent round log; anything the arena program cannot custody
            is marked <Tag kind="sim" />.
          </p>
        </div>
        <div className="scr-head-meta">
          <span className="u">
            Arena · <span className="u--ink">{tokA.name} vs {tokB.name}</span>
          </span>
          <span className="u">
            Round · <span className="u--ink">{status.roundNo === null ? "—" : `#${status.roundNo}`}</span>
          </span>
          <span className="u">
            Settled rounds · <span className="u--ink">{log.settled}</span>
          </span>
          <span className="u">
            Round data · <Tag kind={chain} />
            {source === "fixture" ? <span className="u--faint"> fixture, not a live round</span> : null}
          </span>
        </div>
      </header>

      {/* ------------------------------------------------------------------ BAND A */}
      <Section
        index="02-1"
        title="The arena right now"
        lede="The live round, straight off its own account, and the one before it."
      >
        <div className="sc-hero">
          {/* THE ONE FULL-PRECISION FIGURE ON THIS SCREEN. This is the dashboard's own hero, the
              same role `usd()`'s doc comment carves out for the arena's 00-1 pot — a single big
              headline, not a grid cell fighting a fixed track, so there is no column for a compact
              figure to protect. Everywhere else on this screen the same `live.pot` is shown again
              inside a 1fr-grid tile below, and THAT copy compacts. */}
          <span className="display display--mono sc-hero-fig">
            {live ? usd(live.pot, 2) : <Dash />}
          </span>
          <span className="sc-hero-sub">
            {live
              ? `on the table this round, across ${fighters} ${fighters === 1 ? "fighter" : "fighters"}`
              : status.loading
                ? "reading the round…"
                : "no round open — the figure returns the moment one does"}
          </span>
        </div>

        <div className="sc-g4">
          <Group title="This round" tag={chain}>
            {/* Every `Fx` value below lives in a 1fr grid column, not a headline — compact, unlike
                the hero above it that repeats this same pot. */}
            <Fx n="Pot · USD" v={live ? usdCompact(live.pot) : <Dash />} />
            <Fx n="Fighters" v={live ? `${fighters}` : <Dash />} />
            <Fx n="Phase" v={live ? live.phase.toUpperCase() : <Dash />} />
            <Fx
              n="Fight clock"
              v={live && live.phase === "Fight" ? `${clock(live.elapsedSec)} elapsed` : <Dash />}
              // The bell is the only fixed deadline in the round: after it, anyone may settle,
              // whatever the fight is doing. It is the clock an extraction is really racing.
              note={
                live && live.phase === "Fight"
                  ? `bell at ${clock(FIGHT_TIMEOUT_SECONDS)} — after it, anyone may settle`
                  : undefined
              }
            />
          </Group>

          <Group title="Last round" tag={chain}>
            <Fx n="Round" v={last ? `#${last.roundNo}` : <Dash />} />
            <Fx
              n="Winner"
              v={
                last && last.winner !== null ? (
                  <span className="sc-side" style={{ justifyContent: "flex-end" }}>
                    <Mark side={last.winner} />
                    {SIDE_TOKEN[last.winner].name}
                  </span>
                ) : (
                  <Dash />
                )
              }
            />
            <Fx n="Pot · USD" v={last ? usdCompact(last.pot) : <Dash />} />
            <Fx n="Fighters" v={last ? `${last.fighterCount}` : <Dash />} />
          </Group>

          {/* House float grows from top-ups with no ceiling — a browser that has hit "+ $100" a
              few hundred times is not hypothetical, it's the fastest way to test the referral band
              below. Compact. */}
          <Group title="House float" tag="sim">
            <Fx
              n={`${tokA.name} · USD`}
              v={sim.ledger.balances.ansem > 0 ? usdCompact(usdToUnits(sim.ledger.balances.ansem)) : <Dash />}
            />
            <Fx
              n={`${tokB.name} · USD`}
              v={sim.ledger.balances.uwu > 0 ? usdCompact(usdToUnits(sim.ledger.balances.uwu)) : <Dash />}
            />
            <Fx
              n="Deposited all-time · USD"
              v={sim.ledger.deposited > 0 ? usdCompact(usdToUnits(sim.ledger.deposited)) : <Dash />}
            />
            <Fx n="Custodied on chain" v={<Dash />} note="the program holds no tokens" />
          </Group>

          <Group title="Backing" tag="sim">
            <Fx n="Coverage" v={<Dash />} />
            <Fx n="Shortfall" v={<Dash />} />
            <Fx n="Solvency source" v="none" note="no custody, nothing to cover" />
            <Fx n="Fee · deploy" v={`${(FEE_BPS / 100).toFixed(2)}%`} />
          </Group>
        </div>
        <p className="lede" style={{ marginTop: 16 }}>
          House float and backing are <b>simulated</b>. The arena program custodies no tokens: your
          stake lives in the round account for the length of the round and settles out of it, so
          there is no float to hold and no solvency ratio to report. Those two groups model the
          original product's treasury locally and are marked accordingly.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ BAND B */}
      <Section
        index="02-2"
        title="Your position"
        lede={`Every all-time figure below is the ${you.name} row of the all-time leaderboard, not a second calculation — the two can never disagree.`}
        tools={<span className="u">{you.short}</span>}
      >
        {/* The whole of 02-2 is `Fx` tiles in a 1fr grid, same as 02-1 — every money figure below
            compacts, including the all-time ones: a wallet's lifetime staked/returned on the
            live chain path has no cap the way a single round's stake does. */}
        {mine === null && inRing === null ? (
          <Empty>
            {history.loading
              ? "Reading the round log…"
              : "You have not played a settled round here yet — deploy once and this band fills in."}
          </Empty>
        ) : (
          <div className="sc-g4">
            <Group title="Record" tag={chain}>
              <Fx
                n="Net P/L · USD"
                v={
                  mine ? (
                    <span className={mine.pnl >= 0n ? "pos" : "neg"}>{usdCompactSigned(mine.pnl)}</span>
                  ) : (
                    <Dash />
                  )
                }
              />
              <Fx
                n="Net · coins"
                v={<Dash />}
                note="one settlement unit on chain — no per-coin split exists to report"
              />
              <Fx n="Rounds played" v={mine ? `${mine.rounds}` : <Dash />} />
              <Fx
                n="Won / lost"
                v={mine ? `${mine.wins} / ${mine.rounds - mine.wins}` : <Dash />}
                note={mine && mine.rounds > 0 ? `${Math.round((mine.wins / mine.rounds) * 100)}% win rate` : undefined}
              />
            </Group>

            <Group title="Flow" tag={chain}>
              <Fx n="Staked all-time · USD" v={mine ? usdCompact(mine.staked) : <Dash />} />
              <Fx n="Returned all-time · USD" v={mine ? usdCompact(mine.returned) : <Dash />} />
              <Fx
                n="Return"
                v={
                  mine && mine.roi !== null ? (
                    <span className={mine.roi >= 1 ? "pos" : "neg"}>{mine.roi.toFixed(2)}×</span>
                  ) : (
                    <Dash />
                  )
                }
                note="returned ÷ staked, over every round"
              />
              <Fx
                n="Best round · USD"
                v={mine && mine.best > 0n ? <span className="pos">{usdCompactSigned(mine.best)}</span> : <Dash />}
              />
            </Group>

            <Group title="In the ring right now" tag={chain}>
              <Fx
                n="Side"
                v={
                  inRing ? (
                    <span className="sc-side" style={{ justifyContent: "flex-end" }}>
                      <Mark side={inRing.side} dead={!inRing.alive} />
                      {SIDE_TOKEN[inRing.side].name}
                    </span>
                  ) : (
                    <Dash />
                  )
                }
              />
              <Fx n="Deployed this round · USD" v={inRing ? usdCompact(inRing.stake) : <Dash />} />
              <Fx n="Still fighting · USD" v={inRing ? usdCompact(inRing.hp) : <Dash />} />
              <Fx
                n="Raided this round · USD"
                v={inRing && inRing.banked > 0n ? usdCompact(inRing.banked) : <Dash />}
              />
            </Group>

            <Group title="This round's P/L" tag={chain}>
              <Fx
                n="Worth now · USD"
                v={inRing ? usdCompact(inRing.hp + inRing.banked) : <Dash />}
                note="what is still fighting plus what has been raided"
              />
              <Fx
                n="Against deployed"
                v={inRing ? <Delta units={inRing.hp + inRing.banked - inRing.stake} /> : <Dash />}
                note="unsettled — it moves until the fight ends or the bell rings"
              />
              <Fx n="Status" v={inRing ? (inRing.alive ? "IN" : "OUT") : "not deployed"} />
              <Fx
                n="Round"
                v={live ? `#${live.roundNo}` : <Dash />}
              />
            </Group>
          </div>
        )}
      </Section>

      {/* ------------------------------------------------------------------ BAND C */}
      <Section
        index="02-3"
        title="The house"
        lede={`Where the money went, all-time, across ${history.rounds.length} logged ${history.rounds.length === 1 ? "round" : "rounds"}.`}
      >
        <div className="two" style={{ alignItems: "start" }}>
          <div>
            {/* All-time sums over the whole round log — the one figure on this half of the screen
                with no per-round cap to bound it. Compact throughout, including the legend under
                the split bar. */}
            <div className="line" style={{ paddingBottom: 8 }}>
              <span className="u u--ink">Deployed all-time · by side</span>
              <span className="push u">{usdCompact(deployTotal)} total</span>
            </div>
            {deployTotal > 0n ? (
              <>
                <div className="split">
                  <span className="split-a" style={{ width: `${pctA}%` }}>
                    {tokA.name}
                  </span>
                  <span className="split-b" style={{ width: `${100 - pctA}%` }}>
                    {tokB.name}
                  </span>
                </div>
                <div className="sc-splitleg">
                  <span className="u">
                    <span className="u--ink">{usdCompact(log.stakedA)}</span> · {pctA.toFixed(0)}%
                  </span>
                  <span className="u">
                    <span className="u--ink">{usdCompact(log.stakedB)}</span> · {(100 - pctA).toFixed(0)}%
                  </span>
                </div>
              </>
            ) : (
              <Empty>No settled rounds yet — the split appears with the first one.</Empty>
            )}

            <div className="sc-g2" style={{ marginTop: 26 }}>
              <Group title={`Taken by ${tokA.name}`} tag={chain}>
                <Fx n="All-time · USD" v={log.takenA > 0n ? usdCompact(log.takenA) : <Dash />} />
                {/* With nothing settled there is no win record to report — "0 of 0" would be a
                    claim about a season that has not started. */}
                <Fx n="Rounds won" v={log.settled > 0 ? `${log.winsA} of ${log.settled}` : <Dash />} />
              </Group>
              <Group title={`Taken by ${tokB.name}`} tag={chain}>
                <Fx n="All-time · USD" v={log.takenB > 0n ? usdCompact(log.takenB) : <Dash />} />
                <Fx n="Rounds won" v={log.settled > 0 ? `${log.winsB} of ${log.settled}` : <Dash />} />
              </Group>
            </div>
            <p className="lede" style={{ marginTop: 12 }}>
              Raids <b>take</b> the other side's stake, so each figure is what that side pulled off
              the other. They belong to two different sides of the same ring and are never summed.
            </p>
          </div>

          <div>
            <div className="sc-g2">
              {/* THE FIRST HOUSE FIGURE ON THIS PAGE THAT IS ACTUALLY REAL. Every other treasury
                  number here models the original product's economy in localStorage, because this
                  program custodies no tokens. The extract penalty is different: it is charged by the
                  program, recorded on each Round account as `penalties_collected`, and read back out
                  of the round log — so it carries the `chain` tag, and it is worth showing next to
                  the simulated ones precisely so the contrast is visible. */}
              <Group title="Early-exit take" tag={chain}>
                <Fx
                  n="All-time · USD"
                  v={penaltyTake > 0n ? usdCompact(penaltyTake) : <Dash />}
                  note="what the house took from mid-fight extracts, across every logged round"
                />
                <Fx n="At the opening bell" v={bpsPct(Number(EXTRACT_PENALTY_START_BPS))} />
                <Fx
                  n="Rounds with an exit"
                  v={roundsWithExits > 0 ? `${roundsWithExits} of ${history.rounds.length}` : <Dash />}
                  note="decays to nothing as a fight runs, so a late exit pays nothing"
                />
              </Group>
              {/* Treasury accrues at FEE_BPS on every simulated deploy with no reset besides the
                  ledger's own — same unbounded-growth shape as the house float above, so it
                  compacts for the same reason. */}
              <Group title="Treasury" tag="sim">
                <Fx
                  n={`${tokA.name} · USD`}
                  v={sim.ledger.treasury.ansem > 0 ? usdCompact(usdToUnits(sim.ledger.treasury.ansem)) : <Dash />}
                />
                <Fx
                  n={`${tokB.name} · USD`}
                  v={sim.ledger.treasury.uwu > 0 ? usdCompact(usdToUnits(sim.ledger.treasury.uwu)) : <Dash />}
                />
                <Fx n="Fee taken on deploy" v={`${(FEE_BPS / 100).toFixed(2)}%`} />
                <Fx
                  n="Total taken · USD"
                  v={treasury > 0 ? usdCompact(usdToUnits(treasury)) : <Dash />}
                  note="simulated ledger, this browser only"
                />
              </Group>
              <Group title="Round anchors" tag={chain}>
                <Fx n="Rounds in the log" v={`${history.rounds.length}`} />
                <Fx n="Settled" v={`${log.settled}`} />
                <Fx n="Latest round" v={status.roundNo === null ? <Dash /> : `#${status.roundNo}`} />
                <Fx
                  n="Anchor signature"
                  v={<Dash />}
                  note="each round IS its own account — there is no separate memo to link"
                />
              </Group>
            </div>
            <div className="sc-g2" style={{ marginTop: 26 }}>
              <Group title="Volume" tag={chain}>
                <Fx n="Pot, all rounds · USD" v={log.potAll > 0n ? usdCompact(log.potAll) : <Dash />} />
                <Fx
                  n="Average pot · USD"
                  v={
                    history.rounds.length > 0 ? (
                      usdCompact(log.potAll / BigInt(history.rounds.length))
                    ) : (
                      <Dash />
                    )
                  }
                />
              </Group>
              <Group title="On the table now" tag={chain}>
                <Fx n="Pot · USD" v={live ? usdCompact(live.pot) : <Dash />} />
                <Fx
                  n="Value in play · USD"
                  v={
                    live && live.fighters.length
                      ? usdCompact(live.fighters.reduce((s, f) => s + worth(f), 0n))
                      : <Dash />
                  }
                  note="stakes plus everything raided so far"
                />
              </Group>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
   The two pieces this screen is made of. A "group" is a labelled column of facts separated by
   hairlines — deliberately not a tile: no fill, no border box, no shadow.
   --------------------------------------------------------------------------------------------- */

function Group({
  title,
  tag,
  children,
}: {
  title: string;
  /** Every group states its provenance once, at the top, rather than repeating a marker per row. */
  tag: "live" | "sim";
  children: ReactNode;
}) {
  return (
    <div className="sc-grp">
      <div className="sc-grp-h">
        <span className="u u--ink">{title}</span>
        <Tag kind={tag} />
      </div>
      {children}
    </div>
  );
}

/** A signed change. Exactly zero gets neither a sign nor a colour: "+$0.00" in green reads as a
 *  gain, and nothing has happened yet — that rule is kept exactly, only the formatter under it is
 *  now the compact one, since every caller of `Delta` sits inside a 1fr `Fx` grid tile. */
function Delta({ units }: { units: bigint }) {
  if (units === 0n) return <span className="dim">{usdCompact(0n)}</span>;
  return <span className={units > 0n ? "pos" : "neg"}>{usdCompactSigned(units)}</span>;
}

function Fx({ n, v, note }: { n: string; v: ReactNode; note?: string }) {
  return (
    <div className="sc-fx">
      <span className="sc-fx-n">{n}</span>
      <span className="sc-fx-v">{v}</span>
      {note ? <span className="sc-fx-note">{note}</span> : null}
    </div>
  );
}
