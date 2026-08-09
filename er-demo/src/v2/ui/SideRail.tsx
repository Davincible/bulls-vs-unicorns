// The right-hand rail: one column, two tenants — the wallet/session panel and the fighter
// inspector. See the note in shell.css for why there is only one of them.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { ASSUMED_SESSION_MINUTES, type SessionLife } from "../data/sessionExpiry.ts";
import { CombatLog } from "./CombatLog.tsx";
import { ConnectPanel } from "./ConnectPanel.tsx";
import { PaperTheme } from "./PaperTheme.tsx";
import { Bar, Dash, HouseTag, Mark, Tag } from "./primitives.tsx";
import { coverageFigure, coverageNote, coveragePhrase } from "../views/coverage.ts";
import { useShell, type Rail } from "./shell.ts";
import { useFocusTrap } from "./useFocusTrap.ts";
import { useFullscreenTarget } from "./useFullscreenTarget.ts";
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

/** HOW LONG THE SESSION HAS LEFT, in words — every one of them hedged, and none of them a deadline.
 *
 *  `sessionExpiry.ts` counts forward from a MIRRORED constant (the hour lives as a private const in
 *  `chain/session/useSessionKeyManager.ts`), so this is an inference and is written as one. It exists
 *  to buy a player the chance to start a fresh session BETWEEN rounds rather than discovering the
 *  problem mid-fight — which is the one moment the whole feature exists to keep smooth.
 *
 *  `{ known: false }` is a real and common answer, not an error: a session restored from a previous
 *  visit has no local record of when it began. Saying so beats inventing a clock. */
function sessionAge(life: SessionLife): string {
  if (!life.known) {
    return "Started in an earlier visit, so its age is unknown here. If a deploy or extract is refused, start a fresh session.";
  }
  if (life.lapsed) {
    return "Probably past its hour. It may still work — the chain decides, not this page — but if the next action is refused, start a fresh session.";
  }
  const elapsed = Math.max(0, ASSUMED_SESSION_MINUTES - life.minutesLeft);
  // `minutesLeft` is rounded up, so the first minute of a session reported "Started about 0 minutes
  // ago" — a number doing no work in a sentence that reads better without it.
  const age =
    elapsed < 1
      ? `Started just now · roughly ${life.minutesLeft} minutes left.`
      : `Started about ${elapsed} ${elapsed === 1 ? "minute" : "minutes"} ago · roughly ${life.minutesLeft} left.`;
  return life.lapsing ? `${age} Start a fresh one between rounds rather than mid-fight.` : age;
}

function WalletTenant() {
  const { wallet, session, sim, toasts, gate } = useArena();
  const [amount, setAmount] = useState(50);
  const [token, setToken] = useState<TokenKey>("ansem");
  const [convertTo, setConvertTo] = useState<TokenKey>("uwu");

  const burner = wallet.mode === "burner";
  const connected = wallet.status === "connected";
  /** What the ADDRESS is, for the copy toast — "Wallet address copied" is what a reader who just
   *  pressed Copy expects to see confirmed, whatever the block above it happens to be headed. */
  const noun = burner ? "Burner" : "Wallet";
  /** What the BLOCK is, which is not the same word. The rail's own head already says "Wallet" (it is
   *  the panel's identity, and it is also the fighter inspector's alternative), so a block headed
   *  "Wallet" underneath it printed the word twice in two lines and read as a rendering fault.
   *  Each state names itself instead: the key you were given, the account you connected, or the
   *  thing this block is currently for. */
  const blockTitle = burner ? "Burner key" : connected ? "Account" : "Connect";

  // THE GATE, MINUS THE ONE STATE THAT IS NOT ABOUT THE WALLET. `no-program` is the page still
  // fetching the IDL — true, blocking, and nothing to do with whose key is connected. Rendering it
  // inside a panel headed "Wallet" would send a reader hunting for a wallet fault that does not
  // exist. Every other block genuinely belongs here, and the dock still shows all of them.
  const walletGate = gate !== null && gate.code !== "no-program" ? gate : null;

  const copy = () => {
    navigator.clipboard?.writeText(wallet.pubkey).then(
      () => toasts.push(`${noun} address copied`),
      () => toasts.push("Clipboard refused the copy", "error"),
    );
  };

  /**
   * THE SESSION BUTTONS THREW INTO NOTHING, and the message they threw was the one written to
   * unblock the person pressing them.
   *
   * `createSession` (`chain/session/useSessionKeyManager.ts`) pre-flights the balance itself and
   * throws "wallet has X SOL but starting a session needs about 0.021 (it funds the session key so
   * IT can pay for enter/extract)". That throw never reaches gum, so `session.error` — which is
   * gum's channel — stays null and the panel rendered nothing at all. `void session.start()` then
   * dropped it as an unhandled rejection into the console.
   *
   * IT IS REACHABLE, NOT THEORETICAL: `playGate` blocks at a balance of exactly zero, and the
   * session top-up is 0.02 SOL. A wallet holding 0.005 devnet SOL passes the gate, gets an enabled
   * Start button, presses it, and nothing whatsoever happens. `src/ui/SessionButton.tsx` solved the
   * same problem in the legacy app for the same reason; a toast is this page's equivalent of its
   * local error state.
   */
  const runSession = (fn: () => Promise<void>) => () => {
    void (async () => {
      try {
        await fn();
      } catch (e) {
        toasts.push(e instanceof Error ? e.message : String(e), "error");
      }
    })();
  };

  return (
    <>
      <Block
        title={blockTitle}
        tools={
          connected ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={copy}>
              Copy
            </button>
          ) : null
        }
      >
        {/* NOTHING IS RENDERED FOR AN ABSENT WALLET. `wallet.pubkey` is `""` when nobody is
            connected, and an empty `.key` paragraph over a `—` balance reads as a figure that failed
            to load rather than as an account that does not exist yet. */}
        {connected ? (
          <>
            <p className="key" style={{ margin: "0 0 10px" }}>
              {wallet.pubkey}
            </p>
            <Fact name="SOL (devnet)">
              {wallet.solBalance === null ? <Dash /> : wallet.solBalance.toFixed(4)} <Tag kind="live" />
            </Fact>
            <div className="line" style={{ marginTop: 12, gap: 8 }}>
              {/* THE IN-PAGE AIRDROP IS A DEVELOPER TOOL AND STAYS ONE. Devnet's public faucet
                  rate-limits `requestAirdrop` to uselessness — five consecutive 429s, measured — so
                  offering it to a visitor would be a button that reliably fails, which is worse than
                  no button. A developer on their own machine may well have a fresh IP and a reason
                  to try, so the burner path keeps it unchanged. */}
              {burner ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={wallet.airdropping}
                  onClick={() => void wallet.airdrop()}
                >
                  {wallet.airdropping ? "Requesting…" : "Airdrop 1 SOL"}
                </button>
              ) : null}
              <button type="button" className="btn btn--sm btn--ghost" onClick={wallet.refresh}>
                Refresh
              </button>
              {burner ? null : (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => void wallet.disconnect()}>
                  Disconnect
                </button>
              )}
            </div>
            <p className="lede" style={{ marginTop: 12, fontSize: 12 }}>
              {/* IT USED TO ASSERT A NEGATIVE THAT THE BUTTON EIGHT LINES BELOW DISPROVES: "this page
                  never asks it for anything else". Starting a session signs a transfer of 0.02 SOL
                  out of the wallet and into the session key (`SESSION_TOP_UP_LAMPORTS`) — twenty
                  times a typical fee, and a transfer rather than a fee. Naming it is cheap; the
                  alternative was the same class of claim this codebase refuses everywhere else. */}
              {burner
                ? "Devnet only. This key is generated in your browser and pays the fees for your own entries."
                : "Devnet only. Your wallet pays the devnet fees for your own entries. The only other thing it is ever asked for is 0.02 SOL to fund a session key, and only when you start one."}
            </p>
          </>
        ) : null}

        {/* Shown BESIDE a connected account as well as instead of one: a connected wallet holding no
            devnet SOL is blocked, and the way out of that is the same panel. */}
        {walletGate !== null ? (
          <div style={{ marginTop: connected ? 16 : 0 }}>
            <ConnectPanel block={walletGate} density="full" />
          </div>
        ) : null}
      </Block>

      <Block title="Session key">
        <Fact name="Status">{session.active ? "ACTIVE" : "NOT STARTED"}</Fact>
        {session.active ? (
          <p className="lede" style={{ marginTop: 10, fontSize: 12 }}>
            {sessionAge(session.life)}
          </p>
        ) : null}
        {session.error ? (
          <p className="key" style={{ color: "var(--hot)", margin: "10px 0 0" }}>
            {session.error}
          </p>
        ) : null}
        <div className="line" style={{ marginTop: 12, gap: 8 }}>
          <button
            type="button"
            className="btn btn--sm"
            disabled={session.busy || session.active || gate !== null}
            onClick={runSession(session.start)}
          >
            Start
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={session.busy || !session.active}
            onClick={runSession(session.end)}
          >
            Stop
          </button>
        </div>
        {/* SPEC.md: a control a player cannot press must say why, and what would make it pressable.
            Starting a session is itself a transaction that funds the session key, so every reason
            the page cannot act is a reason this cannot either — and it is the same reason, from the
            same verdict, rather than a second opinion assembled here. */}
        {!session.active && gate !== null ? (
          <p className="lede" style={{ marginTop: 10, fontSize: 12 }}>
            Can&apos;t start one yet — {gate.short}.
          </p>
        ) : null}
        <p className="lede" style={{ marginTop: 12, fontSize: 12 }}>
          One approval now, and every deploy and extract after it signs silently for the rest of the
          hour. Extracting mid-fight is a race against whoever settles the round; a wallet popup in
          the middle of it costs you the round, which is exactly what this removes.
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
  const { live, standings, source, logCoverage } = useArena();
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
        {/* The disclosure follows the fighter into every surface that names one — this is the panel a
            reader opens to ask "who is this", and it is the last place the answer may be left out. */}
        {f?.house ? <HouseTag /> : null}
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

      {/* WHO TOOK IT. The block above says how much this fighter has left; it has never said where
          the difference went, which is the question a player opens this panel holding. Directly
          under the figures rather than at the foot of the panel, because it is the explanation of
          them — the all-time record below is a different subject entirely.
          Scoped to the LIVE round: the window `CombatFeedProvider` keeps is the fight on screen, and
          a settled round's exchanges would have to be replayed from its own account. Twelve rows is
          what a 420px rail holds without the panel becoming a scroll of its own. */}
      {f ? (
        <Block title="Exchanges · this round" tools={<Tag kind={prov} />}>
          <CombatLog wallet={wallet} limit={12} />
        </Block>
      ) : null}

      {/* THE LAST SCREEN STILL CLAIMING "ALL TIME" OVER A WINDOW. `record` is one row out of
          `standings`, which is derived from `history.rounds` — the newest N round accounts, short a
          round wherever a read failed, and (since v7's `close_round_account`) permanently missing
          every round whose rent the authority has reclaimed. The three data views were taught to say
          what they actually cover; this rail was not, so it went on asserting the strongest version
          of the claim in the one place a player reads their OWN numbers. `coveragePhrase` is the
          same wording those views use, and it is allowed to say "all time" on the days that is true.
          The footnote had the identical bug in its own words — "every round account that exists" is
          precisely what a reclaimed round is not — so it now states the mechanism instead. */}
      <Block title={record ? `Your record · ${coverageFigure(logCoverage)}` : "Your record"} tools={<Tag kind={prov} />}>
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
        <p className="lede" style={{ marginTop: 12, fontSize: 12 }} title={coverageNote(logCoverage)}>
          Counted {coveragePhrase(logCoverage)}, from the round accounts themselves — never from a
          live balance.
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

  // THE RAIL FOLLOWS THE FIELD INTO FULLSCREEN. A fullscreen element paints nothing outside its own
  // subtree, and clicking a fighter on the field is how this panel is opened — so with the frame
  // holding the screen, every click on the canvas opened a profile nobody could see. Portalled
  // rather than re-styled: `position: fixed` resolves against the viewport either way, so it lands on
  // exactly the same pixels. See `useFullscreenTarget.ts`.
  const fullscreenTarget = useFullscreenTarget();

  const panel = (
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

  return fullscreenTarget === null ? panel : createPortal(panel, fullscreenTarget);
}
