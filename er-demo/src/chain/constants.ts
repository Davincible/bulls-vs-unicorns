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

// The deployed bulls-arena program (v3 address). Matches idl.address in
// public/idl/bulls_arena.json — asserted equal at runtime in idl.ts rather than trusted blindly.
//
// v3 for the same infrastructure reason v2 existed: MagicBlock's ER validators clone a program's
// bytecode on first use and don't re-clone it after a base-layer upgrade (MAGICBLOCK_FEEDBACK.md), so
// after upgrading v2 in place, all four validators the router advertises were still serving the
// previous build and no route could run the stepped fight on a delegated round. The cache is keyed by
// program id, so a fresh id sidesteps it. v1 (F59NksP2…) and v2 (4uqVSyHt…) remain valid deployments
// of this same source and every verification signature recorded against them still stands — see
// lib.rs's declare_id! note, which now documents how to MEASURE the staleness rather than infer it.
//
// A ROUND NUMBER FROM AN OLDER ID DOES NOT EXIST HERE: a new program id has its own Arena PDA and its
// own counter, so this deployment's rounds start again at #1. App.tsx already follows the arena's own
// `round_counter`, so nothing needs to be told; its `DEFAULT_ROUND_NO` is only a pre-load placeholder.
export const PROGRAM_ID = new PublicKey("8s3x42af7gcNXDCTNheDtteQxeBS2D1p9xuU8C5Jgfrt");

// Verified from the ephemeral-vrf-sdk crate source (MEGA_QUEUE.md ER-060) — the EPHEMERAL queue,
// not the base one, because by the time close_lobby_and_draw runs the round is already
// ER-delegated.
export const DEFAULT_EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");

// From the committed IDL (programs/bulls-arena/idl/bulls_arena.json), close_lobby_and_draw's
// vrf_program account — a fixed address, not derived.
export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
export const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");

export const Phase = { Lobby: 0, Drawing: 1, Fight: 2, Settled: 3 } as const;
export const PHASE_NAME = ["Lobby", "Drawing", "Fight", "Settled"] as const;

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
