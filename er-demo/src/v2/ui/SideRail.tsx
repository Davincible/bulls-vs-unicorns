// The right-hand rail: one column, two tenants — the wallet/session panel and the fighter
// inspector. See the note in shell.css for why there is only one of them.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  SIDE_TOKEN,
  TOKENS,
  usd,
  usdSigned,
  usdToUnits,
  worth,
  type TokenKey,
} from "../contract.ts";
import { useArena } from "../data/ArenaProvider.tsx";
import { Bar, Dash, Mark, Tag } from "./primitives.tsx";
import { useShell, type Rail } from "./shell.ts";

/** Simulated balances are plain numbers, not chain units — but they must still be FORMATTED by the
 *  one shared money formatter, or two panels end up disagreeing about what "$5" looks like. */
function simUsd(amount: number): string {
  return usd(usdToUnits(amount));
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

      {f ? (
        <Block title={`This round · ${SIDE_TOKEN[f.side].name}`} tools={<Tag kind={prov} />}>
          <Fact name="Status">{status}</Fact>
          <Fact name="Stake (net of fee)">{usd(f.stake)}</Fact>
          <Fact name="In the ring">{usd(f.hp)}</Fact>
          <Fact name="Banked">{f.banked > 0n ? usd(f.banked) : <Dash />}</Fact>
          <Fact name="Worth now">{usd(worth(f))}</Fact>
          <Fact name="P/L">
            {pnl === null ? (
              <Dash />
            ) : (
              <span className={pnl > 0n ? "pos" : pnl < 0n ? "neg" : undefined}>{usdSigned(pnl)}</span>
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
            <Fact name="Staked">{usd(record.staked)}</Fact>
            <Fact name="Returned">{usd(record.returned)}</Fact>
            <Fact name="P/L">
              <span className={record.pnl > 0n ? "pos" : record.pnl < 0n ? "neg" : undefined}>
                {usdSigned(record.pnl)}
              </span>
            </Fact>
            <Fact name="Return on stake">
              {record.roi === null ? <Dash /> : `${(record.roi * 100).toFixed(0)}%`}
            </Fact>
            <Fact name="Best round">{record.best > 0n ? usdSigned(record.best) : <Dash />}</Fact>
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

  // Hold the last tenant through the close transition, so the rail slides out with its content
  // intact rather than emptying first.
  useEffect(() => {
    if (rail) setShown(rail);
  }, [rail]);

  useEffect(() => {
    if (!rail) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rail, setRail]);

  const open = rail !== null;
  const tenant = rail ?? shown;

  return (
    <aside
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
