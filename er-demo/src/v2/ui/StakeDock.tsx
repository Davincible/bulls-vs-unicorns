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
//   move the chain would actually accept RIGHT NOW: Deploy while entries are open, Extract during
//   Fight, and otherwise a sentence saying what is true, what can be done, and when it changes.
//   Nothing in here ever offers an action the program would refuse.
//
//   WHICH ONE, AND THE WORDS THAT GO WITH IT, ARE NOT THIS FILE'S DECISION any more — both come from
//   `ui/roundPhaseCopy.ts`, which 00-3 reads too. This dock used to pick its body off
//   `phase === "Lobby"` (offering Deploy through the whole window in which the chain refuses it, see
//   `LiveRound.lobbyClosesAtMs`) and carried its own copy of the phase sentences, one of which —
//   "This round has settled. Deposits reopen at the next lobby." — told a player nothing they could
//   act on. One module now answers both, and a test holds the words.
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

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FEE_BPS,
  SIDE_TOKEN,
  STAKE_CAP_USD,
  STAKE_PRESETS,
  bpsPct,
  usd,
  usdCompact,
  usdToUnits,
  type Side,
} from "../contract.ts";
import { useArena } from "../data/useArena.ts";
import { ConnectPanel } from "./ConnectPanel.tsx";
import { Seg } from "./primitives.tsx";
import { RoundPhaseNote } from "./RoundPhaseNote.tsx";
import { useRoundPhase } from "./useRoundPhase.ts";
import { useShell } from "./shell.ts";
import { useFullscreenTarget } from "./useFullscreenTarget.ts";
import { NARROW, useMediaQuery } from "./useMediaQuery.ts";
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

/** Open on arrival — ON A SCREEN WITH ROOM FOR IT.
 *
 *  THE BUG THIS FIXES. The comment that used to sit here claimed "the one concession to small screens
 *  is that the dock renders as a compact bar there rather than a full panel (see the narrow branch
 *  below)". There was no such branch. On a 390px phone the dock rendered its full 320px panel —
 *  82% of the width, ~250px tall, `position: fixed` — over the bottom-right of every one of the five
 *  screens, following the reader down five thousand pixels of page. An audit at 390x844 found it
 *  covering the last two rows of THE FIELD's ANSEM roster and the whole of its UWU roster, the
 *  leaderboard's entire value column, the dashboard's arena figures, and half of 00-3 — the very
 *  section this dock is a shortcut TO. The panel was not merely cramped on a phone; it was hiding the
 *  data the page exists to show.
 *
 *  So the branch the comment promised now exists (see `narrow` below), and this decides the state it
 *  starts in. Max's direction — "it should be open by default, users can close it, but when you enter
 *  the site it's open by default" — is about a visitor arriving to an obvious way in, and on a phone
 *  the compact bar IS that: it is present, it names the move, it carries the deadline, and it opens
 *  in one tap. What it does not do is spend a third of a phone viewport before being asked.
 *
 *  Read once, at mount, and deliberately not re-run on resize: once a reader has opened or closed
 *  this thing, that is their answer, and having a rotation quietly overrule it would be worse than
 *  either default. */
function readOpen(narrow: boolean): boolean {
  // Clear any stored dismissal from the previous build, so a collapsed dock can't outlive it.
  try {
    localStorage.removeItem(OPEN_KEY);
  } catch {
    /* Storage blocked (private mode, embedded frame) — nothing to clear, nothing to do. */
  }
  return !narrow;
}

/** HOW EVERYTHING ELSE ON THE BOTTOM EDGE STAYS OFF THE DOCK.
 *
 *  THIS USED TO POINT THE OTHER WAY. The previous version measured the TOAST column and published
 *  `--toasts-h` so that `shell.css` could lift the dock above it under the narrow breakpoint. That
 *  was the right relationship while the dock was a floating corner panel and the toasts were the
 *  fixture — but on a narrow screen the dock is now the bottom edge itself: a full-bleed bar sitting
 *  directly on the chrome, the same way a phone's action bar does. A floor cannot dodge the things
 *  standing on it. So the measurement inverts: the dock publishes its own height, and the toast
 *  column and the page's bottom padding stack on top of it (`shell.css`, narrow block only — on a
 *  wide page the dock is a corner again and nothing has to move).
 *
 *  Measured rather than counted, for the same reason as before: the bar is one line in Lobby and the
 *  expanded panel is anywhere from 120px to a capped 60vh, and no constant could track that.
 *
 *  A CALLBACK REF, AND NO EFFECT AT ALL. Two things force this and both cost a debugging session if
 *  you get them wrong.
 *
 *  The first is that this component renders one of three different elements (bar, panel, nothing),
 *  and React hands a callback ref `null` on the way out — which is exactly the moment `--dock-h` has
 *  to go back to zero, or the toasts spend the rest of the session floating above a dock that has
 *  unmounted.
 *
 *  The second is that the observer's whole lifetime has to live in the ref too, and not in a
 *  `useEffect` cleanup. Under `StrictMode` React mounts effects, tears them down and mounts them
 *  again — but it does NOT re-run a callback ref, and when the collapsed bar and the open panel are
 *  both a `<section>` in the same position it does not even re-attach the ref between them, it
 *  updates the same DOM node in place. So an effect cleanup that disconnected the ResizeObserver
 *  killed it on the second pass and nothing ever reconnected it: the height published at first paint
 *  (44px, the bar) stuck permanently, and opening the panel to 258px moved nothing. Attach in the
 *  ref, disconnect in the ref, and both the StrictMode replay and the in-place branch swap are
 *  correct for free. */
function useDockHeight(): (el: HTMLElement | null) => void {
  const observer = useRef<ResizeObserver | null>(null);

  return useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    const root = document.documentElement;
    if (!el) {
      root.style.setProperty("--dock-h", "0px");
      return;
    }
    const publish = () => {
      // Round up: a fractional pixel leaves a hairline of toast peeking out from behind the bar,
      // which reads as a rendering fault rather than as 0.4px.
      root.style.setProperty("--dock-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    observer.current = ro;
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
      {/* The deadline, first — a lobby with an invisible clock is how a player ends up pressing a
          side button two seconds too late and being told the round refused them. The buttons below
          answer "what can I do", so this rendering carries only the label and the countdown. */}
      <RoundPhaseNote detail="timing" announce={false} />

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
          sending another. FULL PRECISION, not compact: unlike `keep` below, this is the player's OWN
          stake, drawn off `STAKE_PRESETS`/`STAKE_CAP_USD` and never above $100 — cents are the whole
          point of a fee line at this size, and there is no chain-scale figure here to protect a
          column from. */}
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
          three lines of it is a wall. Sentences on this page are sentence case.
          The `entering` case is the one moment these buttons are disabled, so it says why they are
          and what ends it — "Sending…" said neither. */}
      <p className="lede dock-note">
        {actions.entering
          ? "Sending — the buttons come back when it lands or fails."
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
      {/* The bell, as a number. Extract is racing a deadline it cannot see otherwise: the round
          becomes settleable by anyone at `FIGHT_TIMEOUT_SECONDS`, or sooner if a side is wiped out,
          and a button offering "leave whenever you like" was the half of that story this dock told. */}
      <RoundPhaseNote detail="timing" announce={false} />

      {/* THE HEADLINE IS WHAT YOU KEEP, never what is in the ring — the same rule 00-3.1 is built on.
          The penalty is quoted as a RATE and not a dollar figure: the rate is exact at this cursor,
          whereas a sub-cent charge used to render here as `usd(keep, 2)`'s `$0.00`, which in a
          four-word line reads as "this is free" to a player about to be charged. `usdCompact` fixes
          that on its own — its `<$0.01` floor (see `ONE_CENT_UNITS` in contract.ts) is exactly the
          bound this dock needs, and it doubles as the fix for the dock being the narrowest money
          surface on the page, where a live-chain `keep` can otherwise run to a dozen digits. */}
      <div className={`num num--xl dock-keep${eligible.keep === null ? " none" : ""}`}>
        {eligible.keep === null ? "—" : usdCompact(eligible.keep)}
      </div>
      <p className="u dock-fee">
        You keep this
        {terms ? (terms.penaltyBps === 0 ? " · no fee" : ` · fee ${bpsPct(terms.penaltyBps)}`) : ""}
      </p>

      <button
        type="button"
        className="btn btn--fill btn--wide dock-xt"
        disabled={!eligible.ok || actions.extracting}
        onClick={() => void run()}
      >
        <span>{actions.extracting ? "Extracting…" : "Extract"}</span>
        <span className="dock-xt-s">
          {eligible.keep === null ? "unavailable" : `bank ${usdCompact(eligible.keep)} and leave`}
        </span>
      </button>

      {/* The two states this button spends most of its life in are both disabled ones, so both say
          why and what would end them: a reason from `extractEligibility` (with the session hint,
          which is the one a player can act on), or a transaction already in flight. */}
      <p className="lede dock-note">
        {actions.extracting
          ? "Sending…"
          : !eligible.ok && eligible.reason
            ? `${eligible.reason}.${!session.active ? " Tip: start a session key to skip wallet prompts." : ""}`
            : "You leave the fight straight away."}
      </p>
    </>
  );
}

/** THE PAGE'S ONE PHASE ANNOUNCER, and the reason it is a component of its own.
 *
 *  A round changing phase is the single fact on this page worth interrupting a screen reader for: it
 *  is what turns Deploy into Extract and what makes an unpressable button pressable. It changes a
 *  handful of times a round, so — unlike the figures in `StickyStatus` and the countdown in
 *  `RoundPhaseNote`, both of which are deliberately NOT live — it is cheap to announce and expensive
 *  to miss.
 *
 *  IT USED TO BE ANNOUNCED TWICE AND THEN NOT AT ALL. `RoundPhaseNote` carried `aria-live="polite"`
 *  on its own label, and two of them are on screen at once (00-3 and this dock), so every phase change
 *  was read out twice. Silencing 00-3 fixed the doubling and opened a hole: the dock's three renderings
 *  do not all contain a `RoundPhaseNote` with a label — the collapsed desktop handle is a bare button,
 *  and the expanded panel's no-control branch passes `showLabel={false}` because the head already
 *  prints the state. Those are Drawing, a closed lobby and Settled: precisely the states a player is
 *  waiting on.
 *
 *  So the announcement stops being a side effect of whichever surface happens to be rendered and
 *  becomes its own element, rendered beside all three branches and reading from the same
 *  `useRoundPhase()` object as the visible copy. One region, one voice, in every state, with nothing
 *  visible to keep in sync — `.sr` is clipped to 1x1 and the sighted reader keeps reading the label
 *  where it already was. */
function PhaseAnnouncer({ label }: { label: string }) {
  return (
    <span className="sr" aria-live="polite">
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------

/** THE DOCK ITSELF. Exported through the wrapper below rather than directly, because it has four
 *  return points and all four have to end up in the same place when the arena frame takes the whole
 *  screen — see `StakeDock`. */
function StakeDockBody() {
  const { rail } = useShell();
  // Below `NARROW` the rail is full-bleed (`shell.css`: `.rail { width: 100vw }`), so there is no
  // "beside it" for this to move to — and it is the width below which a 320px floating panel stops
  // being a corner and becomes a blindfold.
  const narrow = useMediaQuery(NARROW);
  // `useState`'s initialiser runs once, and `useMediaQuery` seeds itself synchronously from
  // `matchMedia` — so this is the real width on the first paint, not a wide-screen default that
  // flashes a 320px panel across a phone before an effect corrects it.
  const [open, setOpen] = useState(() => readOpen(narrow));
  const measure = useDockHeight();

  // COLLAPSING THIS PANEL DESTROYS WHATEVER IS FOCUSED INSIDE IT, so it has to hand focus on.
  //
  // Escape is handled below and, per the note there, collapses the dock and goes no further. That
  // unmounts the whole body — including the control the keypress arrived from — and a focused element
  // leaving the document drops focus to `<body>`, which announces nothing and restarts tabbing from
  // the top of the page. Measured on the running page: focus on the dock's `$50` preset, Escape,
  // focus on `<body>` within the same frame.
  //
  // The fix is the standard disclosure contract: a panel that closes returns focus to the control
  // that reopens it. Guarded on the panel actually holding focus at the moment it collapses, so a
  // mouse user who clicks ✕ from across the page is not dragged to the corner, and so the initial
  // collapsed render on a phone (`readOpen`) never steals focus from the page on arrival.
  const panelRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const handFocusOn = useRef(false);

  // Local state only — deliberately NOT persisted, see `OPEN_KEY`'s note. Closing it is a "not right
  // now", not a standing preference.
  const toggle = useCallback((next: boolean) => {
    handFocusOn.current = !next && panelRef.current !== null && panelRef.current.contains(document.activeElement);
    setOpen(next);
  }, []);

  useEffect(() => {
    if (open || !handFocusOn.current) return;
    handFocusOn.current = false;
    triggerRef.current?.focus();
  }, [open]);

  // The collapsed handle is BOTH the measured element and the control focus comes back to, and the
  // measurement is a callback ref. Composed through a stable `useCallback` rather than an inline
  // arrow: this component re-renders once a second off the round clock, and an inline ref would tear
  // down and rebuild the ResizeObserver on every one of those ticks.
  const setHandleRef = useCallback(
    (el: HTMLButtonElement | null) => {
      triggerRef.current = el;
      measure(el);
    },
    [measure],
  );

  // Which body to show, decided once and centrally: `entriesOpen()` rather than a phase check, and a
  // dead program outranks every phase. The words for the "none" case come from the same object.
  //
  // WHEN THERE IS NO CONTROL, THE HEAD CARRIES THE STATE. With a body there is a move to name and
  // the head names it; without one the head would otherwise read a flat "Closed" over a paragraph
  // explaining a settled round, so the round's own label goes there instead and the note below drops
  // it rather than printing it twice.
  const { control, label, blocked } = useRoundPhase();
  const title = control === "deploy" ? "Deploy" : control === "extract" ? "Extract" : label;

  // THE FUNNEL, ON THE ONE SURFACE THAT IS ON EVERY SCREEN. `blocked` is non-null only when the round
  // WAS offering a move and this reader's own gate took it away (`roundPhaseCopy.ts`) — which is
  // exactly, and only, when a Connect button belongs here. A settled round offers nothing to anyone
  // and gets the round's own words, with no wallet nagging attached.
  const { gate } = useArena();
  const funnel = blocked !== null && gate !== null ? gate : null;

  /** The collapsed handle and bar are one word wide, and that word is the move they open onto.
   *  "Round" is the honest word for a state with nothing on offer — but a gated one DOES have
   *  something on offer, and it is the thing standing in the way. `title` is already the gate's own
   *  short label in that case (`gateLabel`), so this only has to stop "Round" swallowing it. */
  const handleWord = control === "none" && funnel === null ? "Round" : title;

  // The rail is `min(420px, 100vw)` of fixed, opaque paper on the same edge. Wide enough and the
  // dock steps aside (`.dock--railed`); narrow, and the rail is the whole screen, so there is
  // nowhere to step to and the dock leaves rather than sitting invisibly underneath it holding a
  // tab stop. Unmounting, not hiding: an aria-hidden panel with live buttons in it is exactly the
  // trap a keyboard user falls into.
  if (rail !== null && narrow) return null;

  if (!open) {
    // THE PHONE'S COLLAPSED STATE IS NOT THE DESKTOP'S. On a wide page "collapsed" means a word-wide
    // handle tucked into a corner, because the page around it is already showing the round. On a
    // phone the dock is the only fixed surface below the fold, so collapsing it to a `+` would take
    // the deadline off screen along with the panel. This bar keeps the sentence and gives up only
    // the controls: the phase, what happens next and when, plus a button naming the move it opens.
    //
    // NOT ONE BIG BUTTON. A `<p>` cannot live inside a `<button>` (phrasing content only), and
    // `RoundPhaseNote` is a paragraph — so rather than open-coding a third rendering of copy this
    // codebase deliberately keeps in one place, the bar is a labelled group holding the note and a
    // real button. The button is the target, at the full 44px, on the thumb side.
    if (narrow) {
      return (
        <>
          <PhaseAnnouncer label={label} />
          <section ref={measure} className="dock-bar" aria-label="Quick deploy and extract">
            <RoundPhaseNote detail="timing" announce={false} />
            <button
              ref={triggerRef}
              type="button"
              className="btn btn--sm dock-bar-x"
              aria-expanded={false}
              aria-controls="stake-dock"
              onClick={() => toggle(true)}
            >
              {handleWord}
            </button>
          </section>
        </>
      );
    }

    return (
      <>
        <PhaseAnnouncer label={label} />
        <button
          ref={setHandleRef}
          type="button"
          className={`dock-handle${rail !== null ? " dock--railed" : ""}`}
          aria-expanded={false}
          aria-controls="stake-dock"
          onClick={() => toggle(true)}
        >
          <span className="dock-handle-i" aria-hidden="true">
            +
          </span>
          {/* The handle is a word wide. "Deploy"/"Extract" are the move it opens onto; every other
              state is just the round, and the panel says which once it is open. */}
          {handleWord}
        </button>
      </>
    );
  }

  return (
    <>
      <PhaseAnnouncer label={label} />
      {/* No `measure` on the panel, deliberately. `--dock-h` is what the page has to keep
          PERMANENTLY clear — the floor — and the floor is the collapsed bar. An opened sheet is
          something the reader asked for and will close again; reserving 258px of page padding for it
          would push the whole document down under a panel that is already covering that space, and
          take it all back on close, so every open and close would end in a scroll jump. The sheet
          simply overlays, and the toasts (z-index 110 against its 88) still land on top of it, which
          is the one thing that must never be buried. */}
      <section
        ref={panelRef}
        id="stake-dock"
        // Narrow: a full-bleed sheet standing on the bottom chrome, capped at 60vh and scrolling
        // inside itself, so opening it can never bury more than it reveals. Wide: the corner panel,
        // unchanged.
        className={`dock${narrow ? " dock--sheet" : ""}${rail !== null ? " dock--railed" : ""}`}
        aria-label="Quick deploy and extract"
        onKeyDown={(e) => {
          // Escape collapses the dock and goes no further: `useKeyboardNav` also listens for Escape
          // on the window (to close the rail), and one Escape must do exactly one thing. Focus is
          // handed to the collapsed trigger by `toggle` — see the note beside it.
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

        {control === "deploy" ? (
          <DeployBody />
        ) : control === "extract" ? (
          <ExtractBody />
        ) : funnel !== null ? (
          // BLOCKED, WITH A MOVE ON THE TABLE. Two different facts, and both are wanted: the round
          // is still counting down (`detail="timing"` — the clock, without repeating "what can you
          // do", which is the panel's whole job) and the reader is the reason there is no button,
          // which the panel says and then fixes.
          <>
            {/* `showLabel={false}` for the same reason the branch below carries it: with no control
                on offer `title` IS `label`, so the head is already printing this exact word and a
                second copy one line under it reads as a rendering fault. The round's own identity is
                still on the top chrome (`R 12 / LOBBY`); what this line adds is the clock. */}
            <RoundPhaseNote detail="timing" showLabel={false} announce={false} />
            <ConnectPanel block={funnel} density="compact" />
          </>
        ) : (
          // The head above is already showing this state's label — see `title`.
          <RoundPhaseNote showLabel={false} announce={false} />
        )}
      </section>
    </>
  );
}

/** THE DOCK FOLLOWS THE FIELD INTO FULLSCREEN, and this thin wrapper is the whole mechanism.
 *
 *  A fullscreen element paints nothing outside its own subtree, so with the arena frame holding the
 *  screen this panel — the extract button — simply vanished. Extracting is a race that has to land
 *  inside a running fight; a viewing mode that costs a player an Escape and a re-orientation in the
 *  middle of it is a trap with a nice view. `useFullscreenTarget.ts` sets out the rest of the
 *  reasoning, including why `position: fixed` survives the move unchanged and no second stylesheet
 *  is needed.
 *
 *  The body is a separate component rather than a portal wrapped around each of its four returns,
 *  which would be four chances to forget one. */
export function StakeDock() {
  const fullscreen = useFullscreenTarget();
  const dock = <StakeDockBody />;
  return fullscreen === null ? dock : createPortal(dock, fullscreen);
}
