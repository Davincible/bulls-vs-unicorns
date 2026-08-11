// 02 — DASHBOARD. Three bands, in descending order of "would a player care": the arena right now,
// your position, the house. Built to UI-SPEC.md Part 2, including the tiles it says to DROP —
// "accounts / created / busted", the ~9,000 "all-time total" that was never a real figure, and the
// per-side damage counters are not here and are not coming back.
//
// THE FOUR RULES, which is most of why this file looks the way it does:
//   1. Every figure names its unit. No bare numbers anywhere.
//   2. Nothing is derived from live balances. Aggregates come from the round log via
//      `standings`/`history`, which is survivorship-free, and each states the window it was counted
//      over; the only live reads are the CURRENT round's own pot and your own ring position, which
//      is what "right now" means.
//   3. A figure with no backing data shows `—`, never `0`. `0` is a claim; `—` is the truth.
//   4. Token names come from `SIDE_TOKEN`, never hardcoded — "Bulls"/"Unicorns" is ANSEM's old
//      label and was wrong on every screen the moment a second arena existed.
//
// AND ONE MORE, which the ER program forces: it custodies NO PLAYER TOKENS. There are no token
// accounts, no deposits and no referral split on chain. Those figures come from the local simulated
// ledger and every one of them carries a `SIM` marker. A money-shaped number with nothing behind it,
// unlabelled, is the single thing this page must never ship.
//
// THE HOUSE'S OWN BOOKS ARE THE EXCEPTION, AND USED NOT TO BE. The program keeps a `Treasury` PDA and
// writes `fees_collected`/`penalties_collected` onto every round, so what the house has taken is
// chain truth — while this screen was rendering a `sim` treasury out of localStorage right beside it.
// That is the tile `UI-SPEC.md` Part 1 ordered fixed ("should read the treasury ACCOUNT, not the
// counter"), and 02-3 now reads the account. The simulated treasury is gone from this screen: two
// house takes side by side, one real and one modelled, is worse than either alone.
//
// TWO WORDS THIS SCREEN IS CAREFUL WITH, both because they were quietly false before:
//
//   "STAKED" / "DEPLOYED" / "VOLUME" — `pot` is NET of the entry fee. It is the money that reached
//   the ring, not the money players parted with, so any figure carrying one of those labels and
//   sourced from `pot` understates what was charged. `grossDeposits(round)` is the honest version of
//   that sentence and this screen uses it wherever the label makes a claim about what a player PUT
//   IN; `pot` survives only where the claim is "what is in the ring". The two are printed together
//   in 02-3 so the difference is a visible figure rather than a footnote.
//
//   "ALL-TIME" — `useHistory` reads the newest rounds that still exist (it stops once the accounts
//   below it have had their rent reclaimed, capped at `MAX_ROUNDS`) and tolerates a failed read, so no
//   figure derived from `history.rounds` may claim more than that window. `SideRecord` was built
//   refusing the phrase for exactly this reason. Every aggregate on this screen now states the
//   coverage it was counted over ("across N logged rounds"), which is true whatever the window did.
//   That window used to be 250 rounds wide and is now usually about `MIN_RETAINED_ROUNDS`, so this is
//   no longer a bug waiting for the arena to get popular — it is the ordinary case.

import { useMemo } from "react";
import type { ReactNode } from "react";
import { useArena } from "../data/useArena.ts";
import { Dash, Empty, Mark, Section, Tag } from "../ui/primitives.tsx";
import { coverageFigure, coverageNote, coveragePhrase } from "./coverage.ts";
import { feeFigure, feeNote } from "./feeCopy.ts";
import {
  EXTRACT_PENALTY_START_BPS,
  FIGHT_TIMEOUT_SECONDS,
  SIDE_TOKEN,
  bpsPct,
  clock,
  counted,
  grossDeposits,
  houseTook,
  usd,
  usdCompact,
  usdCompactSigned,
  usdToUnits,
  worth,
  type RoundSummary,
} from "../contract.ts";
import "./screens.css";

export function DashboardView() {
  const {
    live,
    standings,
    history,
    logCoverage,
    treasury,
    fee,
    you,
    sim,
    status,
    source,
  } = useArena();

  // Round-derived figures are only "chain" when the round log actually came off the chain. When the
  // page has fallen back to the fixture, every one of them is marked SIM alongside the treasury —
  // the marker means "this is not on chain", and a fixture round is not on chain.
  const chain = source === "chain" ? "live" : "sim";

  // Everything the log knows, in one pass over it. Deliberately NOT from live balances: a balance
  // sheet is a survey of survivors, and it reads ~0 for anyone whose stake is in the ring.
  //
  // NOT "ALL-TIME", and nothing derived from it may say so — see the note at the top of this file.
  // The window is `history.rounds`, and its size is the coverage every figure below is captioned
  // with.
  const log = useMemo(() => {
    let stakedA = 0n;
    let stakedB = 0n;
    let takenA = 0n;
    let takenB = 0n;
    let winsA = 0;
    let winsB = 0;
    let settled = 0;
    let potAll = 0n;
    // The three house figures the ROUNDS THEMSELVES record, which is a different reading from the
    // treasury account below: a round writes its take the moment it happens, the treasury only
    // learns of it when someone sweeps. Where the two disagree, the gap is the unswept rounds.
    let grossAll = 0n;
    let feesAll = 0n;
    let penaltiesAll = 0n;
    // Accumulated through `houseTook()` rather than added up from the two lines above it, so "what
    // the house made" keeps the one definition that function exists to be — see its note in
    // contract.ts on why it is a function and not a third stored field.
    let houseAll = 0n;
    let roundsWithExits = 0;
    for (const r of history.rounds) {
      potAll += r.pot;
      grossAll += grossDeposits(r);
      feesAll += r.feesCollected;
      penaltiesAll += r.penaltiesCollected;
      houseAll += houseTook(r);
      if (r.penaltiesCollected > 0n) roundsWithExits += 1;
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
    return {
      stakedA,
      stakedB,
      takenA,
      takenB,
      winsA,
      winsB,
      settled,
      potAll,
      grossAll,
      feesAll,
      penaltiesAll,
      houseAll,
      roundsWithExits,
    };
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
  const ringTotal = log.stakedA + log.stakedB;
  const pctA = ringTotal > 0n ? (Number(log.stakedA) / Number(ringTotal)) * 100 : 50;

  // THE COVERAGE EVERY AGGREGATE ON THIS SCREEN IS CAPTIONED WITH — see `views/coverage.ts`. One
  // phrase, so a caption in 02-2 and a caption in 02-3 cannot drift into claiming two different
  // windows over the same log, and so the word "all-time" appears only where `logCoverage.complete`
  // has earned it.
  const logged = logCoverage.rounds;
  const coverage = coveragePhrase(logCoverage);
  // ZERO IS A RESULT; `—` IS AN ABSENCE — and for a figure summed over the round log the difference
  // is exactly whether the log has anything in it. An empty log backs no figure at all and dashes;
  // a log of sixteen rounds in which nobody extracted genuinely took nothing, and printing `—` for
  // that would be the page disclaiming a number it has. This is the same distinction the Treasury
  // group makes between a null account and an account holding nothing, applied to the other
  // reading of the same money, so the two groups can be compared without one of them abstaining.
  const summed = (units: bigint): ReactNode => (logged > 0 ? usdCompact(units) : <Dash />);
  // How many rounds this arena has EVER opened. Null when the arena account has not been read — the
  // coverage line then claims no denominator rather than inventing one.
  const opened = logCoverage.roundsEverOpened;

  return (
    <div className="scr">
      <header className="scr-head">
        <span className="idx">02</span>
        <div className="scr-head-main">
          <h1 className="display">Dashboard</h1>
          <p className="lede">
            What is on the table, where you stand, and what the house is doing. Every aggregate here
            is counted {coverage}, and says so beside itself rather than calling itself all-time.
            Anything the arena program cannot custody is marked <Tag kind="sim" />.
          </p>
        </div>
        <div className="scr-head-meta">
          <span className="u">
            Arena · <span className="u--ink">{tokA.name} vs {tokB.name}</span>
          </span>
          <span className="u">
            Round ·{" "}
            <span className="u--ink">
              {status.roundNo === null ? "—" : `#${status.roundNo}`}
            </span>
          </span>
          <span className="u" title={coverageNote(logCoverage)}>
            Rounds logged · <span className="u--ink">{coverageFigure(logCoverage)}</span>
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
              ? `on the table this round, across ${counted(fighters, "fighter")}`
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
            {/* Moved up out of 02-3, where it sat under a second copy of the pot beside it. This is
                the band called "the arena right now"; a duplicate of the live pot three sections
                further down was a reader being asked to check two tiles against each other. */}
            <Fx
              n="Value in play · USD"
              v={
                live && live.fighters.length
                  ? usdCompact(live.fighters.reduce((s, f) => s + worth(f), 0n))
                  : <Dash />
              }
              note="stakes plus everything raided so far"
            />
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
              n="Deposited · USD"
              v={sim.ledger.deposited > 0 ? usdCompact(usdToUnits(sim.ledger.deposited)) : <Dash />}
              // This one IS a lifetime total and is allowed to say so — it is the ledger's own
              // running sum in this browser's localStorage, not a window over a fetched log. It said
              // "all-time" before, which was true here and false everywhere else on the screen; the
              // word is gone so no reader has to work out which figures earned it.
              note="every simulated deposit this browser has made"
            />
            <Fx n="Custodied on chain" v={<Dash />} note="the program holds no tokens" />
          </Group>

          {/* The fee rate used to be the fourth row here, inside a group marked SIM — a real program
              constant wearing the marker for "modelled locally". It is in 02-3 now, beside the fees
              the chain has actually collected, which is the only place it can be checked. */}
          <Group title="Backing" tag="sim">
            <Fx n="Coverage" v={<Dash />} />
            <Fx n="Shortfall" v={<Dash />} />
            <Fx n="Solvency source" v="none" note="no custody, nothing to cover" />
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
        lede={`Every aggregate below is the ${you.name} row of the standings board, not a second calculation — the two can never disagree. Both are counted ${coverage}.`}
        tools={<span className="u">{you.short}</span>}
      >
        {/* The whole of 02-2 is `Fx` tiles in a 1fr grid, same as 02-1 — every money figure below
            compacts, including the aggregates: a wallet's staked/returned over the log on the live
            chain path has no cap the way a single round's stake does. */}
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
              {/* "STAKED", NET OF THE FEE, AND SAYING SO. `StandingsRow.staked` sums per-player
                  `stake`, which the chain stores after the entry fee has been taken at the door —
                  so it is what reached the ring, not what this wallet was charged. `grossDeposits`
                  cannot fix it here: the fee is recorded per ROUND, not per fighter, so there is no
                  honest way to hand one player their share of it. The label carries the
                  qualification instead of implying the wrong number. */}
              <Fx
                n="Staked · net of fee · USD"
                v={mine ? usdCompact(mine.staked) : <Dash />}
                note={`what reached the ring ${coverage} — the entry fee was taken before it`}
              />
              <Fx n="Returned · USD" v={mine ? usdCompact(mine.returned) : <Dash />} />
              <Fx
                n="Return"
                v={
                  mine && mine.roi !== null ? (
                    <span className={mine.roi >= 1 ? "pos" : "neg"}>{mine.roi.toFixed(2)}×</span>
                  ) : (
                    <Dash />
                  )
                }
                note={`returned ÷ staked, ${coverage} — both sides of it net of the fee, so it is like-for-like`}
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
              {/* Same qualification as "Staked" above, and for the same reason: `FighterView.stake`
                  is net-of-fee starting hp. "Deployed" claimed the gross. */}
              <Fx
                n="Reached the ring · USD"
                v={inRing ? usdCompact(inRing.stake) : <Dash />}
                note="your deploy less the entry fee, which the arena takes at the door"
              />
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
                n="Against what reached the ring"
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
        lede={`Where the money went, ${coverage} — and what the house's own books say it took.`}
      >
        <div className="two" style={{ alignItems: "start" }}>
          <div>
            {/* Sums over the whole round log — the figures on this half of the screen with no
                per-round cap to bound them. Compact throughout, including the legend under the
                split bar.
                "IN THE RING", NOT "DEPLOYED": this is `sum(player.stake)` per side, and the chain
                stores that net of the entry fee. What players were charged is in the Volume group
                opposite, where the round-level `feesCollected` makes it derivable; it cannot be
                split per side, because the fee is not recorded per side. */}
            {/* The coverage is stated once, in the section's lede three lines above — repeating it
                in this label pushed the total onto a second line on a phone for no new fact. */}
            <div className="line" style={{ paddingBottom: 8 }}>
              <span className="u u--ink">In the ring · by side</span>
              <span className="push u">{usdCompact(ringTotal)} total</span>
            </div>
            {ringTotal > 0n ? (
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
                <Fx
                  n="Raided · USD"
                  v={summed(log.takenA)}
                  note={coverage}
                />
                {/* With nothing settled there is no win record to report — "0 of 0" would be a
                    claim about a season that has not started. */}
                <Fx n="Rounds won" v={log.settled > 0 ? `${log.winsA} of ${log.settled}` : <Dash />} />
              </Group>
              <Group title={`Taken by ${tokB.name}`} tag={chain}>
                <Fx
                  n="Raided · USD"
                  v={summed(log.takenB)}
                  note={coverage}
                />
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
              {/* THE HOUSE'S OWN BOOKS, OFF THE ACCOUNT — the tile `UI-SPEC.md` Part 1 ordered fixed.
                  What stood here was a localStorage counter accruing `FEE_BPS` on every SIMULATED
                  deploy: a house take invented in this browser, sitting one column away from real
                  chain money. The program has kept a `Treasury` PDA the whole time and nothing read
                  it.

                  NULL IS NOT ZERO, and this is the group where that rule earns its keep.
                  `init_treasury` is a separate admin instruction, so an arena can legitimately exist
                  without a treasury; and a page that has not read the account yet knows nothing
                  either. Both render `—`. A treasury that exists and holds nothing renders `$0.00`,
                  because "the house has taken nothing" is a fact worth being able to state. */}
              <Group title="Treasury account" tag={chain}>
                <Fx
                  n="Entry fees · USD"
                  v={treasury === null ? <Dash /> : usdCompact(treasury.feesAccrued)}
                />
                <Fx
                  n="Early-exit penalties · USD"
                  v={treasury === null ? <Dash /> : usdCompact(treasury.penaltiesAccrued)}
                />
                <Fx
                  n="Total taken · USD"
                  v={
                    treasury === null ? (
                      <Dash />
                    ) : (
                      usdCompact(treasury.feesAccrued + treasury.penaltiesAccrued)
                    )
                  }
                />
                {/* THE COVERAGE OF THE TWO FIGURES ABOVE, and the reason neither may be called
                    all-time: the treasury only learns of a round when `sweep_house_take` runs on it,
                    so every unswept round is money the account has not counted yet. Printed against
                    the rounds this arena has opened, which is what makes the gap visible. */}
                <Fx
                  n="Rounds swept"
                  v={
                    treasury === null ? (
                      <Dash />
                    ) : opened === null ? (
                      treasury.roundsSwept.toString()
                    ) : (
                      `${treasury.roundsSwept} of ${opened}`
                    )
                  }
                  note={
                    treasury === null
                      ? "the treasury account has not been read, or init_treasury has never been run on this arena — either way there is nothing to report, and a zero would be a claim"
                      : "what the account has counted. Rounds settled but not yet swept are money it does not know about yet"
                  }
                />
              </Group>

              {/* THE SAME MONEY, COUNTED THE OTHER WAY. Each round records its own take as it
                  happens (`fees_collected`, `penalties_collected`); the treasury only hears about it
                  when someone sweeps. Both readings are chain truth and they are allowed to
                  disagree — the gap IS the unswept rounds, which is why the two groups sit side by
                  side rather than one being picked as the answer. */}
              <Group title="The rounds' own books" tag={chain}>
                <Fx
                  n="House took · USD"
                  v={summed(log.houseAll)}
                  note={`entry fees plus early-exit penalties, ${coverage}`}
                />
                <Fx n="Entry fees · USD" v={summed(log.feesAll)} />
                <Fx
                  n="Early-exit penalties · USD"
                  v={summed(log.penaltiesAll)}
                />
                <Fx
                  n="Rounds with an exit"
                  v={logged > 0 ? `${log.roundsWithExits} of ${logged}` : <Dash />}
                  note={`the penalty is ${bpsPct(Number(EXTRACT_PENALTY_START_BPS))} at the opening bell and decays to nothing as a fight runs, so a late exit pays nothing`}
                />
              </Group>
            </div>
            <div className="sc-g2" style={{ marginTop: 26 }}>
              {/* WHAT PLAYERS WERE CHARGED vs WHAT REACHED THE RING, printed together. `pot` is net
                  of the entry fee, so every figure this screen used to label "volume" or "deployed"
                  off it was quietly smaller than what came out of players' wallets. `grossDeposits`
                  is the honest version of that sentence and the two lines below are the same money
                  either side of the door. */}
              <Group title="Volume" tag={chain}>
                <Fx
                  n="Charged at the door · USD"
                  v={summed(log.grossAll)}
                  note={`what players parted with ${coverage} — pot plus the entry fee taken on the way in`}
                />
                <Fx
                  n="Reached the ring · USD"
                  v={summed(log.potAll)}
                  note="the pots, summed — what was actually fought over"
                />
                <Fx
                  n="Average pot · USD"
                  v={logged > 0 ? usdCompact(log.potAll / BigInt(logged)) : <Dash />}
                />
                {/* THE RATE, READ BACK OFF `Arena.fee_bps` — it used to be a client-side mirror of
                    `init_arena(fee_bps)`, which is what a comment here said and what made this tile
                    wrong for as long as it took to redeploy after `set_fee_bps` moved the rate. It
                    sits in a `chain` group because it now belongs in one.

                    IT DASHES WHEN UNREAD, exactly like "Rounds opened" three tiles away and off the
                    same account: a standalone figure with nothing behind it is a `—` on this page,
                    and a rate is the last figure that should be guessed at in a column of collected
                    money. The two are different facts, which is why they can differ — the rate is
                    what the door charges now, the fees are what past rounds actually paid. */}
                <Fx
                  n="Fee at the door"
                  v={feeFigure(fee) ?? <Dash />}
                  // The shared note says where the figure comes from; the clause after it is this
                  // tile's own, and it is the one that stops a reader holding the rate against the
                  // two collected-fee figures directly above and finding them inconsistent.
                  note={`${feeNote(fee)} The fees above are what it actually collected, at whatever rate was in force at the time.`}
                />
              </Group>
              {/* THE GROUP THAT LICENSES EVERY OTHER FIGURE ON THIS SCREEN. Each aggregate carries
                  its own coverage phrase, and this is where the window itself is stated once. */}
              <Group title="Coverage" tag={chain}>
                <Fx
                  n="Rounds in the log"
                  v={coverageFigure(logCoverage)}
                  note={coverageNote(logCoverage)}
                />
                <Fx n="Settled" v={`${log.settled}`} />
                <Fx
                  n="Rounds opened"
                  v={opened === null ? <Dash /> : `${opened}`}
                  note={opened === null ? "the arena account has not been read" : undefined}
                />
                <Fx
                  n="Anchor signature"
                  v={<Dash />}
                  note="each round IS its own account — there is no separate memo to link"
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
