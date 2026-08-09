// The one piece of UI that exists purely to prevent a misunderstanding.
//
// bulls-arena is a fork of a real-money mainnet product. This demo is devnet-only by construction —
// src/devnet-guard.ts is an allowlist that fails CLOSED and runs at import time on every hardcoded
// endpoint in chain/constants.ts, so the app cannot even finish booting against mainnet. That
// property is enforced in code; this component's job is to make it legible to someone watching a
// screen who has no way to read the code, so that nobody in a demo audience could mistake what
// they're seeing for the live money game.
//
// Deliberately NOT a decorative "DEVNET" sticker: it renders the ACTUAL hosts this build talks to,
// read from the same constants the transactions are sent through. A viewer can check the claim
// against the label instead of being asked to take it on faith — the same reasoning VerifyPanel.tsx
// is built on. If someone ever repoints an endpoint, the badge changes with it or the app doesn't
// start; there is no third outcome where the badge says one thing and the wire does another.
//
// Rendered `position: fixed` (App.css) rather than as a normal block at the top of the page: the
// demo layout is taller than a laptop viewport, and a badge that scrolls out of view is exactly as
// good as no badge for the ten minutes it matters.

import { BASE_RPC, PROGRAM_ID, ROUTER_URL } from "../chain/constants.ts";

/** Hostname only — the full URLs are noise in a one-line badge, and the host is the part that
 *  actually identifies the cluster. Falls back to the raw string for anything unparseable rather
 *  than throwing inside a render. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function truncate(base58: string): string {
  return `${base58.slice(0, 4)}…${base58.slice(-4)}`;
}

export function DevnetBadge() {
  const programId = PROGRAM_ID.toBase58();

  return (
    <div className="devnet-badge" aria-label="devnet-badge" role="note">
      <strong className="devnet-badge__flag">DEVNET ONLY</strong>
      <span className="devnet-badge__claim">test SOL — no real money at stake</span>
      <span className="devnet-badge__endpoints">
        <code>{hostOf(BASE_RPC)}</code>
        <code>{hostOf(ROUTER_URL)}</code>
        <code title={programId}>program {truncate(programId)}</code>
      </span>
    </div>
  );
}
