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

import { useMemo, useState } from "react";
import { useArena } from "../data/ArenaProvider.tsx";
import { Empty, Mark, Money, Section, Tag } from "../ui/primitives.tsx";
import {
  SIDE_TOKEN,
  usd,
  usdSigned,
  type RoundPlayer,
  type RoundSummary,
} from "../contract.ts";
import "./screens.css";

/** One of your entries, carrying the round it belongs to so the row can be expanded in place. */
interface MyEntry {
  round: RoundSummary;
  me: RoundPlayer;
  /** 1-based finish among that round's field, by P/L. */
  rank: number;
}

export function HistoryView() {
  const { history, you, live, source } = useArena();

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

  return (
    <div className="scr">
      <header className="scr-head">
        <span className="idx">04</span>
        <div className="scr-head-main">
          <h1 className="display">History</h1>
          <p className="lede">
            Every round this arena has ever run, and every player in it. Read from the round
            accounts themselves — the log survives reloads, wallets and operators, because it was
            never in the browser to begin with.
          </p>
        </div>
        <div className="scr-head-meta">
          <span className="u">
            Rounds logged · <span className="u--ink">{history.rounds.length}</span>
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
        lede="What you deployed, everything you got back — raided, banked and extracted included — and the difference. Your side can lose the round and you can still come out ahead: raids bank as you take them. Open a row for the round it happened in."
        tools={
          mine.length ? (
            <span className="u">
              {mine.length} rounds ·{" "}
              <span className={totals.pnl >= 0n ? "pos" : "neg"}>{usdSigned(totals.pnl)}</span> net
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
              <div className="r sc-s">Deposit</div>
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
              <div className="r sc-s num">{usd(totals.staked)}</div>
              <div className="r sc-s num">{usd(totals.back)}</div>
              <div className={`r num ${totals.pnl >= 0n ? "pos" : "neg"}`}>{usdSigned(totals.pnl)}</div>
              <div />
            </div>
          </div>
        )}
      </Section>

      <Section
        index="04-2"
        title="Every round — all players"
        lede="Newest first. Each round opens to everyone who deployed in it, what they staked and what they walked away with."
      >
        {history.rounds.length === 0 ? (
          <Empty>
            {history.loading
              ? "Reading the round log…"
              : "No rounds yet — the first appears as soon as one settles."}
          </Empty>
        ) : (
          <div className="sc-wrap">
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
          </div>
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
        <span className="num r sc-s">{usd(me.stake)}</span>
        <span className="num r sc-s">{usd(me.final)}</span>
        <Money units={me.pnl} signed className="r" />
        <span className={`sc-chev${open ? " sc-chev--on" : ""}`} aria-hidden="true">
          ▸
        </span>
      </button>
      {open ? (
        <div className="sc-det">
          <div className="sc-g4">
            <div className="sc-grp">
              <div className="sc-grp-h">
                <span className="u u--ink">The round</span>
              </div>
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
              <Fact n="Deployed · USD" v={usd(me.stake, 2)} />
              <Fact n="Returned · USD" v={usd(me.final, 2)} />
              <Fact
                n="Return"
                v={me.stake > 0n ? `${(Number(me.final) / Number(me.stake)).toFixed(2)}×` : "—"}
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
        <span className="num r">{usd(round.pot)}</span>
        <span className="num r dim sc-s">{round.tickCount.toLocaleString("en-US")}</span>
        <span className={`sc-chev${open ? " sc-chev--on" : ""}`} aria-hidden="true">
          ▸
        </span>
      </button>
      {open ? (
        <div className="sc-det">
          <div className="rows sc-tbl sc-tbl--plr" role="table" aria-label={`Round ${round.roundNo} players`}>
            <div className="row row--head" role="row">
              <div role="columnheader">Fighter</div>
              <div role="columnheader">Side</div>
              <div role="columnheader" className="r sc-s">
                Staked
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
                  {usd(p.stake)}
                </div>
                {/* $0.00, not `—`: this player was wiped out, which is a measured result. The
                    dash is reserved for figures the page has no data behind at all. */}
                <div role="cell" className="num r sc-s">
                  {usd(p.final)}
                </div>
                <div role="cell" className="r">
                  <Money units={p.pnl} signed />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
