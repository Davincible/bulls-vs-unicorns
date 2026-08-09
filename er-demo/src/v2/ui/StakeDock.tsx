// THE DOCK — the money move, always within reach.
//
// Putting value into a round is the one thing this page exists to let someone do, and until now it
// lived in exactly one place: section 00-3, four screens down, gone the moment you scrolled past it.
// This is a compact, permanent second surface for it, bottom-right, two taps from anywhere on the
// page. 00-3 stays the canonical, full-detail control (custom amount, slider, repeat-every-round,
// the mode toggle); this is the shortcut, and it says so.
//
// IT IS PHASE-AWARE, WHICH IS THE WHOLE DESIGN.
//
//   `enter()` is only accepted in Lobby, and a Lobby is a small fraction of a round's life. A dock
//   that permanently read "add more" would therefore be lying for most of the time it was on screen,
//   and every press during a fight would come back as a rejected transaction. So the dock shows the
//   move the chain would actually accept RIGHT NOW: Deploy in Lobby, Extract during Fight, and in
//   Drawing/Settled a plain sentence saying why there is nothing to press. Nothing in here ever
//   offers an action the program would refuse.
//
//   Handing the Fight phase to Extract is not a consolation prize. Extract is the single most
//   time-critical control in the game — it has to land inside a running fight, before anyone settles
//   the round — and "permanently within reach" is exactly what it wants to be. A player who has
//   scrolled to the rosters to see who is still standing is precisely the player who needs it.
//
// WHAT IT COSTS IS ON THE CONTROL. The arena deducts `FEE_BPS` on entry, so the figure typed is not
// the figure that reaches the ring, and extracting is charged a decaying penalty. Both are printed
// beside the button that incurs them — a compact surface is a reason to be brief, never a reason to
// drop the price.

import { useCallback, useEffect, useState } from "react";
import {
  FEE_BPS,
  SIDE_TOKEN,
  STAKE_CAP_USD,
  STAKE_PRESETS,
  bpsPct,
  usd,
  usdToUnits,
  type Side,
} from "../contract.ts";
import { useArena } from "../data/ArenaProvider.tsx";
import { Seg } from "./primitives.tsx";
import { useShell } from "./shell.ts";
import { TokenIcon } from "./TokenIcon.tsx";

/** OPEN ON EVERY LOAD, and closing lasts only for that visit (Max's direction: "it should be open by
 *  default, users can close it, but when you enter the site it's open by default").
 *
 *  This deliberately reverses the previous behaviour, which persisted the closed state to
 *  localStorage under `v2_dock_open` and argued that a panel returning after dismissal had not really
 *  been dismissed. That argument holds for a notice or an ad. It does not hold for the primary
 *  control of the product: deploying into the round is the thing a visitor came to do, the dock IS
 *  that control, and a player who collapsed it once during a settled round three days ago should not
 *  arrive to a lobby with no obvious way in. Closing it still works and still lasts as long as you are
 *  on the page; it just does not follow you to the next visit.
 *
 *  The old key is intentionally not read any more, so anyone carrying a stored `0` from the previous
 *  build gets the new behaviour rather than staying mysteriously collapsed forever. */
const OPEN_KEY = "v2_dock_open";

/** Below this the right-hand rail is full-bleed (`shell.css`: `.rail { width: 100vw }`), so there is
 *  no "beside it" for the dock to move to. Same threshold as every other layout break on this page.
 *  Also the width at which the toast column and the dock start sharing a horizontal band. */
const NARROW_Q = "(max-width: 900px)";

/** Always open on arrival. The one concession to small screens is that the dock renders as a compact
 *  bar there rather than a full panel (see the narrow branch below) — so "open" costs a strip, not a
 *  third of the viewport, and the request holds at every width without a special case that would
 *  leave phone visitors unable to find the deploy control at all. */
function readOpen(): boolean {
  // Clear any stored dismissal from the previous build, so a collapsed dock can't outlive it.
  try {
    localStorage.removeItem(OPEN_KEY);
  } catch {
    /* Storage blocked (private mode, embedded frame) — nothing to clear, nothing to do. */
  }
  return true;
}

function useMatches(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatch(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [query]);
  return match;
}

/** HOW THE DOCK STAYS OFF THE TOAST STACK.
 *
 *  The toasts are bottom-LEFT and grow upward, capped at five (`data/useToasts.ts`), and their
 *  column is `min(520px, 60vw)` wide — so on a wide page they and the dock never meet, and on a
 *  narrow one they always would. The brief for this dock is that it adjusts to them and not the
 *  other way round, so this measures the toast column's real rendered height and publishes it as
 *  `--toasts-h`; `shell.css` lifts the dock by it, but only under the narrow breakpoint.
 *
 *  Measured rather than counted: a toast wraps to two or three lines when it carries an RPC error,
 *  and `items.length * 34px` would put the dock straight through the middle of one. Read-only, and
 *  the one DOM query in this file — `.toasts` is a `base.css` primitive shared by the whole page,
 *  not another workstream's internal markup. If it ever goes missing the custom property simply
 *  stays unset and the fallback in the stylesheet is 0. */
function useToastClearance(): void {
  useEffect(() => {
    const el = document.querySelector(".toasts");
    const root = document.documentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      root.style.setProperty("--toasts-h", h > 0 ? `${h + 10}px` : "0px");
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--toasts-h");
    };
  }, []);
}

// ---------------------------------------------------------------------------------------------

function DeployBody() {
  const { actions, toasts } = useArena();
  // Deliberately NOT shared with 00-3's stake state. Two controls that silently rewrote each other's
  // amount across four screens of scroll would be a worse surprise than two independent ones, and
  // there is no chain state here to keep in sync — `enter()` takes the amount at the moment it is
  // pressed. $20 rather than the section's $5: this is the "put more in" control.
  const [stake, setStake] = useState(20);
  const stakeUnits = usdToUnits(stake);
  const feeUnits = (stakeUnits * BigInt(FEE_BPS)) / 10_000n;

  const deploy = useCallback(
    async (side: Side) => {
      try {
        await actions.enter(side, stakeUnits);
        toasts.push(
          `Deployed ${usd(stakeUnits)} to ${SIDE_TOKEN[side].name}`,
          side === 0 ? "a" : "b",
        );
        // Deliberately does NOT collapse afterwards: deploying both sides, or topping up the side
        // you already backed, is two presses of this same panel and closing it under the cursor
        // would make the second one a hunt.
      } catch (e) {
        toasts.push(e instanceof Error ? e.message : "Deploy failed", "error");
      }
    },
    [actions, stakeUnits, toasts],
  );

  return (
    <>
      <div className="dock-row">
        <span className="u">Stake</span>
        <Seg<number>
          ariaLabel="Stake amount"
          value={stake}
          onChange={setStake}
          options={STAKE_PRESETS.map((p) => ({ id: p, label: `$${p}` }))}
        />
      </div>

      {/* The entry fee, stated on the surface that charges it. The full section says the same thing
          in a sentence; a dock that quietly dropped it would be showing a player one number and
          sending another. */}
      <p className="u dock-fee">
        {usd(stakeUnits, 2)} → <span className="num">{usd(stakeUnits - feeUnits, 2)}</span> in the
        ring · {(FEE_BPS / 100).toFixed(2)}% fee
      </p>

      <div className="dock-sides">
        <button
          type="button"
          className="btn btn--a btn--wide"
          disabled={actions.entering}
          onClick={() => void deploy(0)}
        >
          <TokenIcon token={SIDE_TOKEN[0]} /> {SIDE_TOKEN[0].name}
        </button>
        <button
          type="button"
          className="btn btn--b btn--wide"
          disabled={actions.entering}
          onClick={() => void deploy(1)}
        >
          <TokenIcon token={SIDE_TOKEN[1]} /> {SIDE_TOKEN[1].name}
        </button>
      </div>

      {/* `.lede`, not `.u`: a tracked-out uppercase sentence is the house voice for a LABEL, and
          three lines of it is a wall. Sentences on this page are sentence case. */}
      <p className="lede dock-note">
        {actions.entering
          ? "Sending…"
          : `Presets only, up to the $${STAKE_CAP_USD} per-side cap. Custom amounts, the slider and repeat-every-round are in 00-3.`}
      </p>
    </>
  );
}

function ExtractBody() {
  const { live, actions, session, toasts } = useArena();
  const eligible = actions.extractEligible;
  const terms = live?.extractTerms ?? null;

  const run = useCallback(async () => {
    // Quoted before the await, exactly as 00-3.1 does: by the time the transaction lands the cursor
    // has moved and the chain will charge slightly less, so the toast says "~".
    const quoted =
      eligible.keep !== null && terms
        ? ` — ~${usd(eligible.keep, 2)} banked at the quoted ${bpsPct(terms.penaltyBps)}`
        : "";
    try {
      await actions.extract();
      toasts.push(`Extracted${quoted}`, "info");
    } catch (e) {
      toasts.push(e instanceof Error ? e.message : "Extract failed", "error");
    }
  }, [actions, eligible.keep, terms, toasts]);

  return (
    <>
      {/* THE HEADLINE IS WHAT YOU KEEP, never what is in the ring — the same rule 00-3.1 is built on.
          The penalty is quoted as a RATE and not a dollar figure: the rate is exact at this cursor,
          whereas a sub-cent charge rendered by `usd()` at two places prints as `$0.00`, which in a
          four-word line reads as "this is free" to a player about to be charged. */}
      <div className={`num num--xl dock-keep${eligible.keep === null ? " none" : ""}`}>
        {eligible.keep === null ? "—" : usd(eligible.keep, 2)}
      </div>
      <p className="u dock-fee">
        What you would bank now
        {terms
          ? terms.penaltyBps === 0
            ? " · no penalty left"
            : ` · house takes ${bpsPct(terms.penaltyBps)}`
          : ""}
      </p>

      <button
        type="button"
        className="btn btn--fill btn--wide dock-xt"
        disabled={!eligible.ok || actions.extracting}
        onClick={() => void run()}
      >
        <span>{actions.extracting ? "Extracting…" : "Extract"}</span>
        <span className="dock-xt-s">
          {eligible.keep === null ? "unavailable" : `bank ${usd(eligible.keep, 2)} and leave`}
        </span>
      </button>

      <p className="lede dock-note">
        {!eligible.ok && eligible.reason
          ? `Unavailable — ${eligible.reason}.${
              !session.active ? " A session key signs this without a wallet prompt (Wallet, bottom right)." : ""
            }`
          : "Your fighter leaves the fight immediately and stops being a target. Full terms in 00-3.1."}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

export function StakeDock() {
  const { live, status } = useArena();
  const { rail } = useShell();
  const [open, setOpen] = useState(readOpen);
  const narrow = useMatches(NARROW_Q);
  useToastClearance();

  // Local state only — deliberately NOT persisted, see `OPEN_KEY`'s note. Closing it is a "not right
  // now", not a standing preference.
  const toggle = useCallback((next: boolean) => setOpen(next), []);

  const phase = live?.phase ?? null;
  // A dead program is not a phase, but it is a reason nothing can be pressed — and it outranks the
  // phase, because with no program there is no `enter()` and no `extract()` either.
  const fatal = status.programError !== null;
  const mode: "deploy" | "extract" | "closed" =
    fatal ? "closed" : phase === "Lobby" ? "deploy" : phase === "Fight" ? "extract" : "closed";

  const closedWhy = fatal
    ? "No program — nothing on this page can reach the chain."
    : phase === "Drawing"
      ? "The lobby has closed and the VRF seed is being drawn. Deposits reopen at the next lobby."
      : phase === "Settled"
        ? "This round has settled. Deposits reopen at the next lobby."
        : status.loading
          ? "Reading the round…"
          : "There is no round to enter.";

  const title = mode === "deploy" ? "Deploy" : mode === "extract" ? "Extract" : "Closed";

  // The rail is `min(420px, 100vw)` of fixed, opaque paper on the same edge. Wide enough and the
  // dock steps aside (`.dock--railed`); narrow, and the rail is the whole screen, so there is
  // nowhere to step to and the dock leaves rather than sitting invisibly underneath it holding a
  // tab stop. Unmounting, not hiding: an aria-hidden panel with live buttons in it is exactly the
  // trap a keyboard user falls into.
  if (rail !== null && narrow) return null;

  if (!open) {
    return (
      <button
        type="button"
        className={`dock-handle${rail !== null ? " dock--railed" : ""}`}
        aria-expanded={false}
        aria-controls="stake-dock"
        onClick={() => toggle(true)}
      >
        <span className="dock-handle-i" aria-hidden="true">
          +
        </span>
        {title === "Closed" ? "Round" : title}
      </button>
    );
  }

  return (
    <section
      id="stake-dock"
      className={`dock${rail !== null ? " dock--railed" : ""}`}
      aria-label="Quick deploy and extract"
      onKeyDown={(e) => {
        // Escape collapses the dock and goes no further: `useKeyboardNav` also listens for Escape on
        // the window (to close the rail), and one Escape must do exactly one thing.
        if (e.key === "Escape") {
          e.stopPropagation();
          toggle(false);
        }
      }}
    >
      <div className="dock-head">
        <span className="idx">[$]</span>
        <span className="h h--sm">{title}</span>
        <button
          type="button"
          className="dock-x"
          aria-expanded
          aria-controls="stake-dock"
          aria-label="Collapse the deploy dock"
          onClick={() => toggle(false)}
        >
          –
        </button>
      </div>

      {mode === "deploy" ? (
        <DeployBody />
      ) : mode === "extract" ? (
        <ExtractBody />
      ) : (
        <p className="lede dock-note dock-note--only">{closedWhy}</p>
      )}
    </section>
  );
}
