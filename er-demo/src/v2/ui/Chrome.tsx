// The two fixed black bars. The reference site's signature, and the only part of the page that is
// never scrolled away — so it carries exactly the facts a player must not have to hunt for while
// they're reading a table: what the round is doing, and whether their key can sign.

import { MAX_STEPS, SIDE_TOKEN, clock, usdCompactSigned, type ViewId } from "../contract.ts";
import { useArena } from "../data/useArena.ts";
import { useShell } from "./shell.ts";
import { TokenIcon } from "./TokenIcon.tsx";
import { SCREEN_KEYS } from "./useKeyboardNav.ts";

const NAV: { id: ViewId; index: string; label: string }[] = [
  { id: "arena", index: "00", label: "Arena" },
  { id: "leaderboard", index: "01", label: "Leaderboard" },
  { id: "dashboard", index: "02", label: "Dashboard" },
  { id: "referrals", index: "03", label: "Referrals" },
  { id: "history", index: "04", label: "History" },
];

/** The big-wins marquee. Profit only, by construction (`bigWins` is filtered upstream) — a ticker
 *  that occasionally announces someone's loss is a different, meaner product. The track is rendered
 *  twice so the -50% translation loops seamlessly; the copy is `aria-hidden` so a screen reader
 *  hears the list once. */
function WinsTicker() {
  const { bigWins } = useArena();
  const items = bigWins.slice(0, 24);

  if (items.length === 0) {
    return (
      <div className="tick-win">
        <span className="u">No wins recorded yet</span>
      </div>
    );
  }

  // Keyed by position, not by round+wallet: one wallet can win twice in the same round (two entries,
  // two sides), and a colliding key silently drops one of them from the marquee.
  const track = (dup: boolean) => (
    <div
      className="tick-track"
      aria-hidden={dup || undefined}
      style={dup ? { marginLeft: 26 } : undefined}
    >
      {items.map((w, i) => (
        <span key={`${dup ? "d" : "o"}-${i}`}>
          <TokenIcon token={SIDE_TOKEN[w.side]} /> {w.name}{" "}
          {/* The marquee is a one-line strip repeated 24-wide and looping — the widest surface on
              the page for this kind of overflow risk, and the one furthest from any table where a
              reader could ask for the exact figure anyway. `usdCompactSigned` also retires the
              hardcoded `+`: `BigWin.amount` is always > 0 (bigWins is filtered upstream, per the
              comment above), so the sign it prints is identical to the old literal and no longer a
              second place that has to agree with the filter. */}
          <span className="tick-amt">{usdCompactSigned(w.amount)}</span> R{w.roundNo.toString()}
        </span>
      ))}
    </div>
  );

  return (
    <div className="tick-win">
      {track(false)}
      {track(true)}
    </div>
  );
}

/** Twelve blocks of the fight's step budget. The chain's own ceiling is `MAX_STEPS`; this is how
 *  much of it the current round has spent, which is the real clock a mid-fight extract races. */
function StepBlocks({ steps }: { steps: number }) {
  const on = Math.round((Math.min(steps, MAX_STEPS) / MAX_STEPS) * 12);
  return (
    <span className="blocks" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <i key={i} className={i < on ? "on" : undefined} />
      ))}
    </span>
  );
}

export function TopChrome() {
  const { live, status, session, wallet } = useArena();

  return (
    <header className="chrome chrome--top">
      <div className="tick-box">
        <span className="u nowrap">Wins</span>
        <WinsTicker />
      </div>

      <div className="tele">
        <span>
          <span className="u">R</span> <b>{status.roundNo === null ? "—" : status.roundNo.toString()}</b>
        </span>
        <span className="chrome-sep">/</span>
        <b>{live ? live.phase.toUpperCase() : status.loading ? "LOADING" : "NO ROUND"}</b>
        <span className="chrome-sep">/</span>
        <b>{clock(live?.elapsedSec ?? 0)}</b>
        <StepBlocks steps={live?.stepsNow ?? 0} />
      </div>

      <div className="chrome-right">
        <span className="nowrap">
          <span className="u">Sol</span>{" "}
          <b>{wallet.solBalance === null ? "—" : wallet.solBalance.toFixed(3)}</b>
        </span>
        <span className="chrome-sep">/</span>
        <span className="nowrap">
          <span className="u">Key</span> <b>{wallet.short}</b>
        </span>
        <span className="chrome-sep">/</span>
        <span className="nowrap">
          <span className="u">Session</span> <b>{session.active ? "ON" : "OFF"}</b>
        </span>
      </div>
    </header>
  );
}

export function BottomChrome() {
  const { view, setView, rail, setRail } = useShell();
  const { session } = useArena();

  return (
    <nav className="chrome chrome--bottom" aria-label="Screens">
      <div className="nav">
        {/* The printed index doubles as the keyboard shortcut (see useKeyboardNav.ts) — `[02]` IS
            the `2` key. Stating it in the tooltip is the only legend the page needs. */}
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            aria-current={view === n.id ? "page" : undefined}
            aria-keyshortcuts={String(SCREEN_KEYS.indexOf(n.id))}
            title={`${n.label} — press ${SCREEN_KEYS.indexOf(n.id)}`}
            className={view === n.id ? "on" : undefined}
            onClick={() => setView(n.id)}
          >
            <span className="nav-i">[{n.index}]</span>
            {n.label}
          </button>
        ))}
      </div>

      <span className="chrome-spacer" />

      <button
        type="button"
        className={`cbtn${rail?.kind === "wallet" ? " on" : ""}`}
        aria-expanded={rail?.kind === "wallet"}
        onClick={() => setRail(rail?.kind === "wallet" ? null : { kind: "wallet" })}
      >
        Wallet {session.active ? "· session on" : ""}
      </button>
    </nav>
  );
}
