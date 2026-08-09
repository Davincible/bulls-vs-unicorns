// The first-visit takeover. The original's intro modal said three things — what the game is, what
// the two modes mean, and that it is provably fair — and this keeps all three. What it does NOT
// keep is the original's framing: that page was a mainnet product with a custodial vault and five
// arenas. This one is a devnet program with one arena and a localStorage cashier, so the takeover
// says so, on the first screen, before anyone reads a dollar sign. A takeover that oversells is
// worse than no takeover.

import { useEffect, useRef } from "react";
import {
  EXTRACT_PENALTY_START_BPS,
  FIGHT_TIMEOUT_SECONDS,
  MAX_STEPS,
  SIDE_TOKEN,
  UNITS_PER_USD,
  bpsPct,
} from "../contract.ts";
import { useArena } from "../data/useArena.ts";
import { feeNote, feePhrase } from "../views/feeCopy.ts";
import { useFocusTrap } from "./useFocusTrap.ts";

/** The opening-bell rate, said in words. Formatted from the program's own constant rather than
 *  typed as "20%" — the intro is the first thing a player reads, and a hardcoded rate here would be
 *  the last place anyone would think to look when the constant next moves. */
const START_PENALTY = bpsPct(Number(EXTRACT_PENALTY_START_BPS));

export function IntroOverlay({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // THE ENTRY RATE IS READ, NOT COMPILED IN. This overlay is the reason: it is the first thing a
  // first-time player reads, and when the rate moved 20 -> 100 on devnet mid-session this paragraph
  // spent the gap until the next build quoting a fifth of what the chain was charging. See `FEE_BPS`.
  const { fee } = useArena();

  // A DIALOGUE IS TWO CLAIMS, AND THE MARKUP ONLY MADE ONE. `aria-modal="true"` below tells a screen
  // reader that nothing outside this takeover exists; it tells the browser nothing at all, so Tab
  // used to walk straight out of here onto the page behind — measured: one Tab out, three more onto
  // live controls. `useFocusTrap` is the other claim, and the two together are what makes "read this
  // once" true for a keyboard as well as for a reading cursor. It also remembers where focus came
  // from and puts it back on dismissal, which is what stops Escape from leaving the reader on
  // whatever control focus had leaked to. See useFocusTrap.ts for why it does not own Escape itself.
  useFocusTrap(overlayRef, { active: true, initialFocus: ref });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="intro-h" ref={overlayRef}>
      <div className="overlay-body">
        <div className="ovl-idx">
          <span className="idx">[00]</span>
          <span className="u u--ink">Read this once</span>
        </div>

        <h1 className="display" id="intro-h" style={{ margin: "22px 0 16px" }}>
          {SIDE_TOKEN[0].name} vs {SIDE_TOKEN[1].name}
        </h1>

        <p className="lede" style={{ marginBottom: 26 }}>
          Two memecoins, one arena. Deploy into a side and send a fighter in. When two fighters
          collide, one takes value off the other. Whichever side is holding more when the round is
          settled takes it.
        </p>

        <ul className="ovl-list">
          {/* FIRST, BECAUSE IT IS THE ONLY ITEM IN THIS LIST A READER HAS TO ACT ON. Everything else
              here explains the game; this one explains why the buttons might not work yet, and a
              visitor who reads it now does not spend their first lobby wondering. Kept to one line
              per requirement — the panel behind the Connect button says the rest, and turning the
              takeover into a setup manual would push the three things it exists to say off screen. */}
          <li>
            <b>What you need</b>
            {/* IT USED TO SAY "set to Solana devnet", WHICH IS A SETUP STEP THIS APP DOES NOT NEED
                and the rest of the page says so. `walletFault.ts` establishes it at length: the
                wallet's selected cluster changes only what PHANTOM displays and simulates, because
                this page takes the signature and submits the bytes to devnet itself. Listing it as a
                requirement in the first thing a visitor reads sends them into Phantom's settings
                before they have seen the arena, to fix something that is not stopping them. */}
            <span>
              A Phantom wallet holding a little devnet SOL for transaction fees. Devnet SOL is free —
              the wallet panel has the link, and Connect wallet is in the bar at the bottom of every
              screen. Nothing here touches mainnet or real funds, whatever network your wallet is set
              to show you.
            </span>
          </li>
          <li>
            <b>Mayhem</b>
            <span>
              Everything you raid compounds inside your fighter. It grows, it hits harder, and every
              bit of it is still at risk.
            </span>
          </li>
          <li>
            <b>Extraction</b>
            <span>
              Bank what you have raided while the fight is still running — but leaving early is not
              free: the house takes a slice of whatever you pull out, {START_PENALTY} at the opening
              bell and less with every step after, down to nothing once the fight has run its course.
              It is a premium on an option, and it decays because the option does. Your fighter can
              still die; what you already pulled out is already safe. On chain there is only one mode
              — <code>extract()</code> exists and any player may call it. The toggle changes what
              this page urges you to do, not what the program enforces.
            </span>
          </li>
          <li>
            <b>Provably fair</b>
            <span>
              The seed's sha256 is committed before the lobby closes, and the seed itself is revealed
              by the VRF callback when the fight starts — so no outcome can be chosen after the fact.
              Section 00-7 recomputes the whole round in your browser and diffs it against what the
              chain settled to.
            </span>
          </li>
          <li>
            <b>This build</b>
            <span>
              One arena, on Solana devnet, with a real VRF seed. The other four arenas in the picker
              are inert and say so. Deposits, withdrawals, conversions and referrals are simulated in
              your browser's storage — the program custodies no tokens — and every figure that comes
              from that ledger is marked <span className="sim">sim</span>.
            </span>
          </li>
          <li>
            <b>The numbers</b>
            <span>
              Stakes are on-chain u64 units, pegged for display at{" "}
              {UNITS_PER_USD.toLocaleString("en-US")} units = $1.00. Value leaves a round in exactly
              two places: the arena deducts{" "}
              <span title={feeNote(fee)}>{feePhrase(fee)}</span> from your stake on entry, and the
              extract penalty above takes its slice of anything you pull out early.
              Everything else only ever moves between fighters. A fight runs at two steps per second
              per fighter and stops at {MAX_STEPS.toLocaleString("en-US")} steps; once one side has
              nobody left standing — or the {FIGHT_TIMEOUT_SECONDS}-second bell rings — anyone may
              settle the round.
            </span>
          </li>
        </ul>

        <button
          ref={ref}
          type="button"
          className="btn btn--fill btn--wide"
          style={{ marginTop: 28 }}
          onClick={onClose}
        >
          Let&apos;s go
        </button>
      </div>
    </div>
  );
}
