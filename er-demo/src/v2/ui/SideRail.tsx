// The right-hand rail: one column, two tenants — the wallet/session panel and the fighter
// inspector. See the note in shell.css for why there is only one of them.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  SIDE_TOKEN,
  TOKENS,
  usdCompact,
  usdCompactSigned,
  usdToUnits,
  worth,
  type TokenKey,
} from "../contract.ts";
import { useArena } from "../data/useArena.ts";
import { PaperTheme } from "./PaperTheme.tsx";
import { Bar, Dash, Mark, Tag } from "./primitives.tsx";
import { useShell, type Rail } from "./shell.ts";
import { useFocusTrap } from "./useFocusTrap.ts";
import { NARROW, useMediaQuery } from "./useMediaQuery.ts";

/** The width at which `shell.css` takes `.rail` to `width: 100vw`. Below it the rail is not a panel
 *  beside the page, it IS the page — which is the only condition under which containing the keyboard
 *  inside it is honest. Same break as every other layout decision on this page. */

/** Simulated balances are plain numbers, not chain units — but they must still be FORMATTED by the
 *  one shared money formatter, or two panels end up disagreeing about what "$5" looks like. Compact:
 *  the rail is 420px wide and these grow without a ceiling — "+ $100 & $100" is one button press
 *  away, repeatable forever, and a balance sheet that has absorbed a hundred top-ups is not a
 *  hypothetical here the way a fixed on-chain stake is. */
function simUsd(amount: number): string {
  return usdCompact(usdToUnits(amount));
}

function Block({ title, tools, children }: { title: string; tools?: ReactNode; children: ReactNode }) {
  return (
    <div className="blk">
      <div className="blk-h">
        <span className="u u--ink">{title}</span>
        {tools ? <span className="push">{tools}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="fact">
      <span className="u fact-n">{name}</span>
      <span className="fact-v num">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Tenant 1 — wallet, session, and the simulated cashier
// ---------------------------------------------------------------------------------------------

function WalletTenant() {
  const { wallet, session, sim, toasts } = useArena();
  const [amount, setAmount] = useState(50);
  const [token, setToken] = useState<TokenKey>("ansem");
  const [convertTo, setConvertTo] = useState<TokenKey>("uwu");

  const copy = () => {
    navigator.clipboard?.writeText(wallet.pubkey).then(
      () => toasts.push("Burner address copied"),
      () => toasts.push("Clipboard refused the copy", "error"),
    );
  };

  return (
    <>
      <Block
        title="Burner"
        tools={
          <button type="button" className="btn btn--sm btn--ghost" onClick={copy}>
            Copy
          </button>
        }
      >
        <p className="key" style={{ margin: "0 0 10px" }}>
          {wallet.pubkey}
        </p>
        <Fact name="SOL (devnet)">
          {wallet.solBalance === null ? <Dash /> : wallet.solBalance.toFixed(4)} <Tag kind="live" />
        </Fact>
        <div className="line" style={{ marginTop: 12, gap: 8 }}>
          <button
            type="button"
            className="btn btn--sm"
            disabled={wallet.airdropping}
            onClick={() => void wallet.airdrop()}
          >
            {wallet.airdropping ? "Requesting…" : "Airdrop 1 SOL"}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={wallet.refresh}>
            Refresh
          </button>
        </div>
        <p className="lede" style={{ marginTop: 12, fontSize: 12 }}>
          Devnet only. This key is generated in your browser and pays the fees for your own entries.
        </p>
      </Block>

      <Block title="Session key">
        <Fact name="Status">{session.active ? "ACTIVE" : "NOT STARTED"}</Fact>
        {session.error ? (
          <p className="key" style={{ color: "var(--hot)", margin: "10px 0 0" }}>
            {session.error}
          </p>
        ) : null}
        <div className="line" style={{ marginTop: 12, gap: 8 }}>
          <button
            type="button"
            className="btn btn--sm"
            disabled={session.busy || session.active}
            onClick={() => void session.start()}
          >
            Start
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={session.busy || !session.active}
            onClick={() => void session.end()}
          >
            Stop
          </button>
        </div>
        <p className="lede" style={{ marginTop: 12, fontSize: 12 }}>
          A session key signs your extract in the rollup without a wallet prompt. Extracting mid-fight
          is a race; a modal in the middle of it costs you the round.
        </p>
      </Block>

      <Block
        title="Simulated balances"
        tools={<Tag kind="sim" />}
      >
        {(["ansem", "uwu", "sol"] as TokenKey[]).map((k) => (
          <Fact key={k} name={TOKENS[k].name}>
            {simUsd(sim.ledger.balances[k])}
          </Fact>
        ))}
        <p className="lede" style={{ marginTop: 12, fontSize: 12 }}>
          The arena program custodies no tokens: there are no deposits, no withdrawals and no house
          balance on chain. These are localStorage numbers modelling the original game's cashier, and
          they buy nothing.
        </p>
      </Block>

      <Block title="Simulated cashier" tools={<Tag kind="sim" />}>
        <label className="u" htmlFor="rail-amt">
          Amount (USD)
        </label>
        <input
          id="rail-amt"
          type="number"
          min={1}
          step={1}
          value={amount}
          onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
        />
        <div className="line" style={{ marginTop: 12, gap: 0 }}>
          <div className="seg">
            {(["ansem", "uwu", "sol"] as TokenKey[]).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={token === k}
                onClick={() => {
                  setToken(k);
                  if (convertTo === k) setConvertTo(k === "ansem" ? "uwu" : "ansem");
                }}
              >
                {TOKENS[k].name}
              </button>
            ))}
          </div>
        </div>
        <div className="line line--wrap" style={{ marginTop: 12, gap: 8 }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => sim.actions.deposit(token, amount)}
          >
            Deposit
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={sim.ledger.balances[token] < amount}
            onClick={() => sim.actions.withdraw(token, amount)}
          >
            Withdraw
          </button>
        </div>

        <div className="line line--wrap" style={{ marginTop: 16, gap: 8 }}>
          <span className="u">Convert {TOKENS[token].name} →</span>
          <div className="seg">
            {(["ansem", "uwu", "sol"] as TokenKey[])
              .filter((k) => k !== token)
              .map((k) => (
                <button key={k} type="button" aria-pressed={convertTo === k} onClick={() => setConvertTo(k)}>
                  {TOKENS[k].name}
                </button>
              ))}
          </div>
          <button
            type="button"
            className="btn btn--sm"
            disabled={sim.ledger.balances[token] < amount}
            onClick={() => sim.actions.convert(token, convertTo, amount)}
          >
            Convert
          </button>
        </div>

        <div className="line line--wrap" style={{ marginTop: 20, gap: 8 }}>
          <button type="button" className="btn btn--sm btn--ghost" onClick={sim.actions.topUp}>
            + $100 &amp; $100
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={sim.actions.reset}>
            Reset ledger
          </button>
        </div>
      </Block>

      {/* Last, and deliberately below the money: it is the only thing in this rail that is about the
          page rather than about the player, and while it is being reviewed it should be the easiest
          thing here to walk past. */}
      <PaperTheme />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Tenant 2 — the fighter inspector
// ---------------------------------------------------------------------------------------------

function FighterTenant({ wallet }: { wallet: string }) {
  const { live, standings, source } = useArena();
  const prov = source === "chain" ? "live" : "fixture";
  const f = live?.fighters.find((x) => x.wallet === wallet) ?? null;
  const record = standings.find((s) => s.wallet === wallet) ?? null;

  if (!f && !record) {
    return (
      <p className="lede">
        This wallet isn&apos;t in the round on screen and has no settled rounds behind it yet.
      </p>
    );
  }

  const pnl = f ? worth(f) - f.stake : null;
  const status = f ? (f.dead ? (f.banked > 0n ? "OUT — BANKED" : "DEAD") : "ALIVE") : "NOT IN THIS ROUND";

  return (
    <>
      <div className="line" style={{ gap: 8, marginBottom: 4 }}>
        {f ? <Mark side={f.side} dead={f.dead} /> : null}
        <span className="h">{f?.name ?? record?.name ?? "—"}</span>
        {f?.isYou ? <span className="u u--ink">· you</span> : null}
      </div>
      <p className="key" style={{ margin: "0 0 4px" }}>
        {wallet}
      </p>

      {/* This whole block sits in a `.fact` row of a 420px rail — the narrowest money surface on
          the page besides the dock — so every figure in it compacts. */}
      {f ? (
        <Block title={`This round · ${SIDE_TOKEN[f.side].name}`} tools={<Tag kind={prov} />}>
          <Fact name="Status">{status}</Fact>
          <Fact name="Stake (net of fee)">{usdCompact(f.stake)}</Fact>
          <Fact name="In the ring">{usdCompact(f.hp)}</Fact>
          <Fact name="Banked">{f.banked > 0n ? usdCompact(f.banked) : <Dash />}</Fact>
          <Fact name="Worth now">{usdCompact(worth(f))}</Fact>
          <Fact name="P/L">
            {pnl === null ? (
              <Dash />
            ) : (
              <span className={pnl > 0n ? "pos" : pnl < 0n ? "neg" : undefined}>{usdCompactSigned(pnl)}</span>
            )}
          </Fact>
          <div style={{ marginTop: 12 }}>
            <Bar value={f.hp} max={f.stake} side={f.side} large />
            <div className="line" style={{ marginTop: 6 }}>
              <span className="u">Health</span>
              <span className="u push">
                {f.stake > 0n ? `${Math.round((Number(f.hp) / Number(f.stake)) * 100)}%` : "—"}
              </span>
            </div>
          </div>
        </Block>
      ) : null}

      <Block title="All time" tools={<Tag kind={prov} />}>
        {record ? (
          <>
            <Fact name="Rounds">{record.rounds}</Fact>
            <Fact name="Rounds on the winning side">{record.wins}</Fact>
            <Fact name="Staked">{usdCompact(record.staked)}</Fact>
            <Fact name="Returned">{usdCompact(record.returned)}</Fact>
            <Fact name="P/L">
              <span className={record.pnl > 0n ? "pos" : record.pnl < 0n ? "neg" : undefined}>
                {usdCompactSigned(record.pnl)}
              </span>
            </Fact>
            <Fact name="Return on stake">
              {record.roi === null ? <Dash /> : `${(record.roi * 100).toFixed(0)}%`}
            </Fact>
            <Fact name="Best round">{record.best > 0n ? usdCompactSigned(record.best) : <Dash />}</Fact>
          </>
        ) : (
          <p className="u" style={{ padding: "8px 0" }}>
            No settled rounds for this wallet yet
          </p>
        )}
        <p className="lede" style={{ marginTop: 12, fontSize: 12 }}>
          Read from every round account that exists, never from a live balance.
        </p>
      </Block>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

export function SideRail() {
  const { rail, setRail } = useShell();
  const [shown, setShown] = useState<Rail>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);

  // Hold the last tenant through the close transition, so the rail slides out with its content
  // intact rather than emptying first.
  useEffect(() => {
    if (rail) setShown(rail);
  }, [rail]);

  useEffect(() => {
    if (!rail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rail, setRail]);

  const open = rail !== null;
  const tenant = rail ?? shown;

  // TRAPPED ONLY WHERE IT IS THE WHOLE SCREEN. On a desktop this rail is a complementary landmark
  // 420px wide, beside a page that is still visible and still legitimately operable — trapping the
  // keyboard in it would be pretending it is a dialogue when a reader can plainly see it is not.
  // Below `shell.css`'s one layout break the same element is `width: 100vw` and covers everything,
  // and "tab behind it" means "tab to controls nobody can see". So the trap follows the width, from
  // the same query the rest of the page breaks at.
  const fullScreen = useMediaQuery(NARROW);

  // FOCUS IS RESTORED AT BOTH WIDTHS, and that half is not optional anywhere. Closing used to set
  // `aria-hidden` on an <aside> that still contained the focused element and then let CSS take it to
  // `visibility: hidden` — so focus was destroyed rather than moved, and the reader was dropped back
  // at the top of the document having lost the row they opened the rail from. The hook captures the
  // opener on open and puts focus back on close — after the commit, which for this component is
  // load-bearing rather than incidental: React re-focuses whatever was focused before a commit if it
  // is still in the document, and a rail that stays mounted to slide out always is. See the note at
  // the top of useFocusTrap.ts; it was measured here.
  useFocusTrap(railRef, {
    active: open,
    trapTab: fullScreen,
    initialFocus: closeRef,
    // `rail`, not `open`: the panel head is re-focused on every tenant swap, which is what this
    // component did before the hook took the focus over.
    refocusKey: rail,
  });

  return (
    <aside
      ref={railRef}
      className={`rail${open ? " rail--open" : ""}`}
      aria-label={tenant?.kind === "fighter" ? "Fighter profile" : "Wallet and session"}
      aria-hidden={!open}
    >
      <div className="rail-head">
        <span className="idx">[{tenant?.kind === "fighter" ? "F" : "W"}]</span>
        <span className="h h--sm">{tenant?.kind === "fighter" ? "Fighter" : "Wallet"}</span>
        <button ref={closeRef} type="button" className="rail-x" aria-label="Close panel" onClick={() => setRail(null)}>
          ✕
        </button>
      </div>
      {tenant?.kind === "fighter" ? <FighterTenant wallet={tenant.wallet} /> : <WalletTenant />}
    </aside>
  );
}
