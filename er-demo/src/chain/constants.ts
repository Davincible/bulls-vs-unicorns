// Chain constants — copied from engine/scripts/er-client-canary.mjs's top-of-file constants
// (lines ~68-80 at the time of the port). Every network endpoint gets checked by the SAME guard
// that gates env-configured ones in the engine app — assertDevnetUrl() runs on each hardcoded
// literal below, at module load time, so a mainnet URL pasted in here by mistake fails the import
// outright instead of quietly connecting.

import { PublicKey } from "@solana/web3.js";
import { assertDevnetUrl } from "../devnet-guard.ts";

export const ROUTER_URL = "https://devnet-router.magicblock.app";
export const BASE_RPC = "https://api.devnet.solana.com";
assertDevnetUrl(ROUTER_URL, "Magic Router");
assertDevnetUrl(BASE_RPC, "base devnet RPC");

// The deployed bulls-arena program (v4 address). Matches idl.address in
// public/idl/bulls_arena.json — asserted equal at runtime in idl.ts rather than trusted blindly.
//
// v4 for the same infrastructure reason v2 and v3 existed, now observed a fourth time: MagicBlock's
// ER validators clone a program's bytecode on first use and don't re-clone it after a base-layer
// upgrade (MAGICBLOCK_FEEDBACK.md). The extract-penalty build was upgraded into v3 on the base layer
// and all four validators the router advertises were STILL serving the previous build immediately
// afterward — byte-compared, not guessed (`scripts/erValidator.ts`). The cache is keyed by program
// id, so a fresh id sidesteps it. v1 (F59NksP2…), v2 (4uqVSyHt…) and v3 (8s3x42af…) remain valid
// deployments of this same source and every verification signature recorded against them still
// stands — see lib.rs's declare_id! note.
//
// A ROUND NUMBER FROM AN OLDER ID DOES NOT EXIST HERE: a new program id has its own Arena PDA and its
// own counter, so this deployment's rounds start again at #1. App.tsx already follows the arena's own
// `round_counter`, so nothing needs to be told; its `DEFAULT_ROUND_NO` is only a pre-load placeholder.
export const PROGRAM_ID = new PublicKey("CchN3JPWta2uVxKhwScBQhtPG5gpsaRzf3RA4aPCDam2");

// Verified from the ephemeral-vrf-sdk crate source (MEGA_QUEUE.md ER-060) — the EPHEMERAL queue,
// not the base one, because by the time close_lobby_and_draw runs the round is already
// ER-delegated.
export const DEFAULT_EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");

// From the committed IDL (programs/bulls-arena/idl/bulls_arena.json), close_lobby_and_draw's
// vrf_program account — a fixed address, not derived.
export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
export const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");

// `Abandoned` is the terminal state of a lobby that reached `lobbyClosesAt` holding fewer than two
// fighters: it can never fight (the program refuses entries past the deadline and refuses to draw
// with one fighter), so `abandon_round` ends it rather than leaving it counting down at 0:00 forever.
// A fifth phase rather than a flag on `Settled`, because nothing was settled — there is no winner, no
// seed and no fight to verify, and a UI that read `Settled` would go looking for all three.
export const Phase = { Lobby: 0, Drawing: 1, Fight: 2, Settled: 3, Abandoned: 4 } as const;
export const PHASE_NAME = ["Lobby", "Drawing", "Fight", "Settled", "Abandoned"] as const;

// ---- fight pacing — mirrored from programs/bulls-arena/src/lib.rs ------------------------------
//
// These four live here, not in render/, because they are chain facts: the program derives the
// fight's cursor from them, and anything client-side that disagrees is drawing a different fight
// from the one being settled. render/gameLoop.ts re-exports MAX_STEPS rather than keeping its own
// copy — it used to hold `STEPS_PER_SECOND = 175 / MAX_STEPS = 7_000`, both already stale against
// the deployed program, which is exactly the failure mode a single source of truth prevents.
//
// Read lib.rs's own doc comments for the measurements behind them; the short version is that the
// rate is PER FIGHTER because a fight's length in steps grows ~n^1.5, so no flat rate can pace both
// a two-fighter duel and a sixteen-fighter brawl.
export const STEPS_PER_FIGHTER_PER_SECOND = 2;
export const MAX_STEPS = 4_000;
/** The bell: after this long, `resolve()` succeeds even with fighters still standing. */
export const FIGHT_TIMEOUT_SECONDS = 120;

export function stepsPerSecond(fighterCount: number): number {
  return fighterCount * STEPS_PER_FIGHTER_PER_SECOND;
}

// ---- the lobby deadline — mirrored from programs/bulls-arena/src/lib.rs -------------------------
//
// Chain facts, for the same reason the fight pacing above is: the program clamps `open_round`'s
// `lobby_seconds` into [MIN, MAX] and decides both "may I still enter" and "may this be drawn" from
// the stored deadline. A client that disagreed would draw a countdown the chain isn't keeping, which
// is precisely the invented number `Round.lobby_closes_at` exists to delete.

/** The floor `open_round` clamps up to: 20s, the length the off-chain engine's ONLINE lobby ran at
 *  (`web/index.html`: `w.lobbyMs || 20000`) and therefore a window already proven long enough for a
 *  human to see a round open and get into it.
 *
 *  The ER delegation hand-off comes OUT of that window rather than being added to it — the countdown
 *  starts when `open_round` lands but nobody can enter until the round is delegated. That hand-off
 *  was timed against real devnet at 1.70s and 1.87s, so a 20s lobby is ~18s genuinely enterable. It
 *  was briefly 30 on the strength of `admin-open-round.mjs` polling ten times at one-second
 *  intervals, which is where the script gives up, not how long the thing takes. See
 *  `MIN_LOBBY_SECONDS` in lib.rs for the full account. */
export const MIN_LOBBY_SECONDS = 20;
/** The ceiling. It exists to catch milliseconds passed where seconds were meant, not to express a
 *  view on pacing — see `MAX_LOBBY_SECONDS` in lib.rs. */
export const MAX_LOBBY_SECONDS = 3_600;

/** WHAT WE ACTUALLY OPEN LOBBIES AT — a product choice, not a chain rule, which is why it lives here
 *  and not in lib.rs (the program only clamps; it has no opinion about pacing).
 *
 *  The off-chain engine's own comment on this number was "shorter = less dead air", and its online
 *  default was 20 seconds of entry window. On-chain, three things that did not exist there sit inside
 *  the same window: the ER delegation hand-off before anyone can enter at all (~2s, measured), a
 *  session-key approval, and a router round-trip per entry. 60 leaves ~58 seconds of genuine entry
 *  window — roughly three times the proven 20, which is the margin a first-time player fumbling a
 *  wallet dialog actually needs — while keeping the whole round near two minutes (lobby, then a
 *  20-85s fight), the cadence a keeper can reproduce with no gap between rounds.
 *
 *  It is deliberately well above `MIN_LOBBY_SECONDS`: the floor is the point at which the feature
 *  breaks, not a suggestion, and running the demo at the floor would leave nothing for a slow RPC. */
export const DEFAULT_LOBBY_SECONDS = 60;

/** The Rust `lobby_is_open()` — true while the round is still taking entries. Whole seconds, because
 *  the chain compares whole seconds; a client animating a smooth countdown should still gate the
 *  ENTER button on this so the button dies at the same instant the program starts refusing.
 *
 *  ONLY MEANINGFUL IN `Lobby` PHASE, and that is a real trap rather than pedantry: a FULL round may
 *  be drawn early (the program has nothing left to wait for once nobody else can enter), so a round
 *  can be in Drawing or Fight with a deadline still in the future. Check the phase first; this
 *  answers "has the clock run out", not "is this round still a lobby". */
export function lobbyIsOpen(lobbyClosesAtSec: number, nowSec: number): boolean {
  return Math.floor(nowSec) < lobbyClosesAtSec;
}

/** The Rust `lobby_is_dead()` — a lobby past its deadline holding fewer than two fighters. It can
 *  never become a fight, and `abandon_round` is the only thing left that can happen to it. This is
 *  what lets a UI say "this lobby expired without a fight" instead of showing 0:00 indefinitely.
 *
 *  Same caveat as `lobbyIsOpen`: only ask it of a round in `Lobby` phase. Once the phase is
 *  `Abandoned` the chain has already said so and there is nothing left to derive. */
export function lobbyIsDead(fighterCount: number, lobbyClosesAtSec: number, nowSec: number): boolean {
  return !lobbyIsOpen(lobbyClosesAtSec, nowSec) && fighterCount < 2;
}

/** The Rust `canonical_cursor()`, in whole on-chain seconds — how far the fight has genuinely got.
 *
 *  This is what `tick`/`extract`/`resolve` each catch the stored `tick_count` up to, so it is also
 *  what a client should believe about the current fight regardless of whether anyone has ticked
 *  recently. `render/gameLoop.ts` computes the same quantity at sub-second precision for smooth
 *  animation; the two agree exactly at every whole-second mark, which is the only place the chain
 *  itself ever moves. */
export function canonicalCursor(fightStartedAtSec: number, fighterCount: number, nowSec: number): number {
  const elapsed = Math.max(0, Math.floor(nowSec) - fightStartedAtSec);
  return Math.min(elapsed * stepsPerSecond(fighterCount), MAX_STEPS);
}
