// Chain constants — copied from engine/scripts/er-client-canary.mjs's top-of-file constants
// (lines ~68-80 at the time of the port). Every network endpoint gets checked by the SAME guard
// that gates env-configured ones in the engine app — assertDevnetUrl() runs on each hardcoded
// literal below, at module load time, so a mainnet URL pasted in here by mistake fails the import
// outright instead of quietly connecting.

import { PublicKey } from "@solana/web3.js";
import { assertDevnetUrl } from "../devnet-guard.ts";

/** A build-time override, read defensively because THIS MODULE HAS TWO RUNTIMES.
 *
 *  Vite inlines `import.meta.env.VITE_*` into the browser bundle at build time; Bun populates
 *  `import.meta.env` from the process environment for the keeper and the scripts under `scripts/`.
 *  Neither runtime may assume the other's shape, and a bare `import.meta.env.X` throws where `env`
 *  is undefined — which would take down every importer of this file, i.e. all of chain/.
 *
 *  Empty is treated as unset: an unset variable and one set to "" are the same intent, and a Vercel
 *  field someone cleared should fall back rather than fail. */
function envOverride(name: string): string | undefined {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const value = env?.[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

/** The MagicBlock Magic Router. NOT overridable, deliberately: it routes per account and is what
 *  places a delegated round's transactions on the right ER validator. A general Solana RPC cannot
 *  serve it, so an override here would not be a tuning knob, it would be a way to break every
 *  rollup transaction the app sends. */
export const ROUTER_URL = "https://devnet-router.magicblock.app";

/** The base-layer Solana RPC.
 *
 *  OVERRIDABLE VIA `VITE_BASE_RPC`, because the public `api.devnet.solana.com` rate-limits (HTTP
 *  429) under load we can actually reach — one browser plus one status poller was enough. A paid
 *  endpoint drops in without a code change. The keeper has its own equivalent (`KEEPER_BASE_RPC`,
 *  see `scripts/keeper/endpoints.ts`) so the two halves can point at different endpoints, which is
 *  the point: the browser's key is public by construction and the keeper's is not.
 *
 *  THE GUARD STILL RUNS ON WHATEVER COMES BACK. That is the whole reason the override is safe to
 *  add — this file's header promises that no endpoint leaves here unasserted, and an env-supplied
 *  value must not become the hole in it. A mainnet URL in a Vercel setting fails the import
 *  outright rather than quietly connecting to the wrong cluster. */
export const BASE_RPC = envOverride("VITE_BASE_RPC") ?? "https://api.devnet.solana.com";

assertDevnetUrl(ROUTER_URL, "Magic Router");
assertDevnetUrl(BASE_RPC, "base devnet RPC");

// The deployed bulls-arena program (v7 address). Matches idl.address in
// public/idl/bulls_arena.json — asserted equal at runtime in idl.ts rather than trusted blindly.
//
// v7 for the same infrastructure reason every id since v2 existed, now observed a seventh time:
// MagicBlock's ER validators clone a program's bytecode on first use and don't re-clone it after a
// base-layer upgrade (MAGICBLOCK_FEEDBACK.md). The extract-penalty build was upgraded into v3 on the
// base layer and all four validators the router advertises were STILL serving the previous build
// immediately afterward — byte-compared, not guessed (`scripts/erValidator.ts`). The cache is keyed
// by program id, so a fresh id sidesteps it.
//
// v1 (F59NksP2…), v2 (4uqVSyHt…), v3 (8s3x42af…) and v6 (D5S8oJ3s…) remain deployments of this same
// source. v4 (CchN3JPW…) and v5 (CH7K8rDX…) DO NOT — both were closed on 2026-08-10 to fund this
// deploy, reclaiming 4.72 SOL between them, and a closed program id can never be redeployed. Their
// ledger history and every signature recorded against them are untouched; the executables are gone.
// See lib.rs's declare_id! note for the two closing signatures.
//
// A ROUND NUMBER FROM AN OLDER ID DOES NOT EXIST HERE: a new program id has its own Arena PDA and its
// own counter, so this deployment's rounds start again at #1. App.tsx already follows the arena's own
// `round_counter`, so nothing needs to be told; its `DEFAULT_ROUND_NO` is only a pre-load placeholder.
export const PROGRAM_ID = new PublicKey("ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe");

// ---- round retention — mirrored from programs/bulls-arena/src/lib.rs ---------------------------
//
// HOW MANY OF THE NEWEST ROUNDS THE CHAIN GUARANTEES ARE STILL FETCHABLE. `close_round_account`
// reclaims a finished round's ~0.023497 SOL rent and this is the floor it refuses to cross, enforced
// on chain rather than by the keeper so that no client has to trust an operator's configuration for
// it. (~0.008561 at `MAX_FIGHTERS = 16`, before the cap grew the account from 1,102 to 3,248 bytes.)
// The old note put that at "95.4% of what a round costs"; that ratio was measured on v6 and has NOT
// been re-measured at the new size, so it is dropped rather than carried forward — see the same
// deliberate omission at `closeRoundAccount` in round.ts.
//
// IT IS HERE BECAUSE IT IS A LABELLING RULE, not because anything in the browser calls the
// instruction (nothing does — the keeper owns that). Round history is now a rolling window of this
// many rounds, so every figure derived from the round log is a newest-N statistic: `useHistory`
// reads round accounts by address, a closed round comes back `null`, and the row silently vanishes.
// SPEC.md already forbids labelling `sideRecord` "all time" for exactly this reason; that rule now
// binds standings, the leaderboard, the hall of fame and the dashboard too, and this constant is the
// number those captions must state. The `Treasury` account is the one honest source of an all-time
// figure, because `sweep_house_take` accumulates into it before the round it came from is destroyed.
//
// Checked against the Rust by `the_browser_carries_the_same_chain_constants` — a window the client
// advertises but the program does not enforce would be the worst of both.
export const MIN_RETAINED_ROUNDS = 20;

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
// These live here, not in render/, because they are chain facts: the program derives the fight's
// cursor from them, and anything client-side that disagrees is drawing a different fight from the
// one being settled. render/gameLoop.ts derives its playhead from these rather than keeping its own
// copy — it used to hold `STEPS_PER_SECOND = 175 / MAX_STEPS = 7_000`, both already stale against
// the deployed program, which is exactly the failure mode a single source of truth prevents.
//
// Read lib.rs's own doc comments for the measurements behind them; the short version is that the
// rate is PER FIGHTER because a fight's length in steps grows ~n^1.5, so no flat rate can pace both
// a two-fighter duel and a forty-eight-fighter brawl.
export const STEPS_PER_FIGHTER_PER_SECOND = 2;

/** THE MOST FIGHT ANY ONE TRANSACTION MAY RUN — a compute bound, and nothing else.
 *
 *  IT REPLACES `MAX_STEPS`, which was doing two jobs: the ceiling the cursor saturated at (i.e. how
 *  long a fight may ever be) AND the ceiling on how much arithmetic one instruction could be handed.
 *  At sixteen fighters the two coincided harmlessly — the bell was 3,840 steps and the cap 4,000, so
 *  no real fight met either — and they stop coinciding the moment the lineup grows: a 48-fighter
 *  fight needs ~11,900 steps to reach a conclusion. How LONG a fight may be is now
 *  `FIGHT_TIMEOUT_SECONDS`; how much work one CALL may do is this.
 *
 *  THE ONLY THING IN THE BROWSER THAT SHOULD USE IT IS `roundIx.tick`'s `steps` argument. Anything
 *  asking "how far can this fight ever get" wants `finalCursor(fighterCount)` below — the two used
 *  to be the same number and are not any more, so a progress bar drawn against this one would fill
 *  up and stop at 3,000 of a 17,280-step round.
 *
 *  Measured on the compiled SBF binary under litesvm (`programs/bulls-arena/tests/compute.rs`), at
 *  `MAX_FIGHTERS` rather than at sixteen because cost per step RISES with the lineup. It is a CU
 *  number, not a design number. */
export const MAX_STEPS_PER_CALL = 3_000;

/** THE BELL: after this long, `resolve()` succeeds even with fighters still standing — and it is now
 *  also the cursor ceiling, which it was not before. `canonicalCursor` clamps ELAPSED SECONDS to it
 *  rather than clamping the step product to a separate constant, which is the same statement made
 *  where it belongs: a fight advances until the bell and then stops, at every lineup rather than by
 *  coincidence at one.
 *
 *  180s, RAISED FROM 120s alongside the 16 -> 48 fighter cap. The old number was justified against a
 *  sixteen-fighter worst case of 84s, but that measurement predated the `min(ring_a, ring_d)` damage
 *  rule and every fight got longer under it: re-measured, a 120s bell was already settling a quarter
 *  of live sixteen-fighter rounds on who was ahead rather than on a wipeout (74.2% concluded). 180s
 *  is what a 48-fighter round needs to beat that same bar (76.2%). No lineup runs at a different
 *  SPEED — the bell is a backstop, and a fight that finishes at 40 seconds still settles at 40. */
export const FIGHT_TIMEOUT_SECONDS = 180;

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
/** The ceiling — a week, and it stopped being a unit-error guard when it stopped being an hour.
 *
 *  It used to catch milliseconds passed where seconds were meant (`20_000` unclamped is 5.5 hours).
 *  It no longer does: 20,000 is inside this range and passes through untouched. The deadline is now
 *  the BACKSTOP for "nobody ever came" rather than the thing that ends a lobby — `closeLobbyAndDraw`
 *  takes an authority-signed early close, so the operator starts the fight when a real player
 *  arrives, and a lobby is meant to be held open until one does. A wrong duration therefore no longer
 *  has a consequence worth guarding against, which is a better outcome than detecting it.
 *
 *  A UI drawing a countdown off `lobbyClosesAt` should not assume it is a number anyone is waiting
 *  for. Against a held-open lobby it can be days away and completely irrelevant to when the fight
 *  actually starts. See `MAX_LOBBY_SECONDS` in lib.rs for the rent argument behind the change and for
 *  what is still NOT proven about holding a round delegated that long. */
export const MAX_LOBBY_SECONDS = 604_800;

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
 *  itself ever moves.
 *
 *  THE CLAMP IS ON ELAPSED TIME, NOT ON THE PRODUCT. It used to be `.min(MAX_STEPS)` — a flat 4,000,
 *  which is a statement about how much arithmetic one caller may be handed, applied to a quantity
 *  that means how long a FIGHT is. Clamping the seconds to the bell says the thing that was actually
 *  meant, and it is true at every lineup rather than only at the one where the two numbers happened
 *  to sit near each other. */
export function canonicalCursor(fightStartedAtSec: number, fighterCount: number, nowSec: number): number {
  const elapsed = Math.max(0, Math.floor(nowSec) - fightStartedAtSec);
  return Math.min(elapsed, FIGHT_TIMEOUT_SECONDS) * stepsPerSecond(fighterCount);
}

/** The Rust `final_cursor()` — THE LAST CURSOR A FIGHT OF THIS LINEUP CAN EVER REACH, i.e. the bell
 *  expressed in steps.
 *
 *  This is the number every "how far along is the fight" denominator wants, and it is PER LINEUP: a
 *  two-fighter round tops out at 720 steps and a forty-eight-fighter round at 17,280. It used to be
 *  the single constant `MAX_STEPS` for every lineup, which was wrong even at sixteen (the bell was
 *  3,840, the constant 4,000) and merely close enough not to be noticed. Progress bars, playhead
 *  clamps and precompute budgets all derive from here rather than restating the multiplication. */
export function finalCursor(fighterCount: number): number {
  return FIGHT_TIMEOUT_SECONDS * stepsPerSecond(fighterCount);
}
