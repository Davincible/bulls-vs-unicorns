// The two fixed black bars. The reference site's signature, and the only part of the page that is
// never scrolled away — so it carries exactly the facts a player must not have to hunt for while
// they're reading a table: what the round is doing, and whether their key can sign.

import { SIDE_TOKEN, finalCursor, usdCompactSigned, type ViewId } from "../contract.ts";
import type { PlayBlock } from "../data/playGate.ts";
import { useArena } from "../data/useArena.ts";
import { RoundClockSlot } from "./RoundClockSlot.tsx";
import { useShell } from "./shell.ts";
import { TokenIcon } from "./TokenIcon.tsx";
import { SCREEN_KEYS } from "./useKeyboardNav.ts";
import { NARROW, useMediaQuery } from "./useMediaQuery.ts";

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

/** Twelve blocks of the fight's step budget. The chain's own ceiling is `finalCursor(fighterCount)` —
 *  PER LINEUP, not a flat number — and this is how much of it the current round has spent, which is
 *  the real clock a mid-fight extract races.
 *
 *  `fighterCount` is 0 with no round in scope (no wallet, no live round yet), which would otherwise
 *  divide by a zero ceiling; that reads as zero blocks lit rather than as NaN blocks, which is the
 *  same "nothing to show yet" the rest of the chrome already renders in that state. */
function StepBlocks({ steps, fighterCount }: { steps: number; fighterCount: number }) {
  const max = finalCursor(fighterCount);
  const on = max > 0 ? Math.round((Math.min(steps, max) / max) * 12) : 0;
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
        {/* NOT `clock(elapsedSec)` ANY MORE. This cell read `0:00` beside `LOBBY` for the whole of a
            held-open lobby — a stopped clock on the one strip of the page that never scrolls away,
            which is the worst place on the site to put a figure that reads as broken. `RoundClockSlot`
            shows the state when there is no clock and the clock when there is; the `<b>` stays because
            `.tele b` is what makes this cell white (shell.css), and the slot inherits it. */}
        <b><RoundClockSlot /></b>
        <StepBlocks steps={live?.stepsNow ?? 0} fighterCount={live?.fighters.length ?? 0} />
      </div>

      {/* THREE DASHES ARE NOT A STATE. With no wallet connected these cells read `— / — / OFF`,
          which is what a bar full of figures that failed to load looks like — and this strip's whole
          job is to be the thing a player does not have to hunt for. An absent wallet is one fact, so
          it is one cell, and it says the fact rather than leaving three blanks to be interpreted. */}
      <div className="chrome-right">
        {wallet.status === "connected" ? (
          <>
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
          </>
        ) : (
          <span className="nowrap">
            <span className="u">Wallet</span> <b>NOT CONNECTED</b>
          </span>
        )}
      </div>
    </header>
  );
}

/** WHAT THE WALLET BUTTON SHOULD SAY, given what is standing between this reader and playing.
 *
 *  The button opens the RAIL, so it names what the rail will help with rather than echoing the CTA
 *  inside it verbatim — "Reload the page" would be a promise this button does not keep. The three
 *  kinds a reader can act on get their own word; everything else is the resting label, because
 *  `no-program` and `connecting` both clear on their own and neither is something to go and press. */
function walletButtonLabel(gate: PlayBlock | null, sessionOn: boolean): string {
  switch (gate?.cta?.kind) {
    case "connect":
      return "Connect wallet";
    case "install":
      return "Get a wallet";
    case "faucet":
      return "Get devnet SOL";
    default:
      return sessionOn ? "Wallet · session on" : "Wallet";
  }
}

export function BottomChrome() {
  const { view, setView, rail, setRail, openIntro } = useShell();
  const { session, gate } = useArena();
  const narrow = useMediaQuery(NARROW);

  // THE ONE ENTRY POINT THAT IS ON ALL FIVE SCREENS AND NEVER SCROLLS AWAY. Connecting is the whole
  // funnel for a new visitor, so while they are blocked this button stops being a quiet utility and
  // becomes the page's call to action.
  const calling = gate?.cta?.kind === "connect" || gate?.cta?.kind === "install" || gate?.cta?.kind === "faucet";

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

      {/* THE WAY BACK TO THE RULES. The takeover shows once per browser and had no second door: the
          extract penalty, the caveat that Mayhem/Extraction is this page's intent rather than
          anything the program enforces, and what the `sim` marker means were all one dismissal away
          from being unreachable forever.
          This bar is where it belongs and not the arena screen, for the same reason the wallet
          button is here: it is on all five screens and never scrolls away, and "what are the rules
          of this thing" is a question that gets asked from the Leaderboard as readily as from the
          field. It sits before the wallet button because it is the quieter of the two — the wallet
          is a call to action while a visitor is blocked, and nothing may come between that and the
          right-hand edge the reader reaches for. */}
      <button
        type="button"
        className="cbtn"
        data-testid="chrome-intro-btn"
        // It opens the takeover, which is a real `role="dialog"` with a focus trap — so say so.
        //
        // THE PRINTED LABEL SHORTENS BELOW `NARROW`; THE ACCESSIBLE NAME NEVER DOES. Measured at
        // 390px: five nav buttons need 284px and the wallet button 66, which with the bar's gaps and
        // padding is the whole viewport — so every character spent here is taken off the scrolling
        // nav beside it. `[?]` is the page's own bracket idiom (`[00]`, `[$]`, `[F]`, `[W]`) doing
        // the job the word did, at a third of the width, and `aria-label` keeps the sentence for
        // anyone who is not reading pixels.
        aria-haspopup="dialog"
        aria-label="How this works"
        title="How this works — the rules, the extract penalty, and what the sim marker means"
        onClick={openIntro}
      >
        {narrow ? "[?]" : "How this works"}
      </button>

      <button
        type="button"
        className={`cbtn${rail?.kind === "wallet" ? " on" : ""}${calling ? " cbtn--call" : ""}`}
        data-testid="chrome-wallet-btn"
        aria-expanded={rail?.kind === "wallet"}
        onClick={() => setRail(rail?.kind === "wallet" ? null : { kind: "wallet" })}
      >
        {walletButtonLabel(gate, session.active)}
      </button>
    </nav>
  );
}
