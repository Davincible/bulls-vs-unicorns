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

// The deployed bulls-arena program (v2 address). Matches idl.address in
// public/idl/bulls_arena.json — asserted equal at runtime in idl.ts rather than trusted blindly.
//
// v2 because MagicBlock's ER validators cache a program's bytecode on first use and don't re-clone
// it after a base-layer upgrade (MAGICBLOCK_FEEDBACK.md). Every public devnet validator had a
// pre-Phase-6 clone of the v1 id, so no route could run the current code on a delegated round. The
// cache is keyed by program id, so a fresh id sidesteps it. v1
// (F59NksP2bYZhP4wD7fgR1sP729UHNPitrBiYrrKF1sYW) remains a valid deployment of this same source and
// every verification signature recorded against it still stands — see lib.rs's declare_id! note.
export const PROGRAM_ID = new PublicKey("4uqVSyHtx7CBaXUL2qy7cN4eV3MzqmvucapGHN1imFYm");

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

// The on-chain floor `resolve()` enforces before a fight is allowed to settle (FightNotOverYet
// below this). Matches the constant er-client-canary.mjs waits out at step 8.
export const MIN_FIGHT_SECONDS = 5;
