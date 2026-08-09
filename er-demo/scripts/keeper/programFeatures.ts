// WHAT THE IDL CAN EXPRESS — a ONE-DIRECTIONAL check, and the direction matters more than the answer.
//
// READ THIS BEFORE USING IT FOR ANYTHING. A `false` here PROVES a feature is unusable. A `true` here
// proves NOTHING about devnet. `public/idl/bulls_arena.json` is generated from lib.rs, so it tracks
// SOURCE and can be regenerated the moment a program change is written — hours or days before that
// change is deployed. Auto-enabling behaviour on a `true` from this file would therefore be a keeper
// deciding it can do something because somebody edited Rust. Whether a program is DEPLOYED is not a
// question any local file can answer, and the keeper does not pretend otherwise: the hold-open policy
// is turned on by the operator (`--hold-open`), who is the only party that knows.
//
// WHAT THE `false` DIRECTION IS WORTH, WHICH IS A LOT. Anchor builds instructions from this IDL. If
// `close_lobby_and_draw` has no `authority` account here, then an early close is not EXPRESSIBLE —
// the account is silently dropped from the transaction, an ordinary permissionless close is built
// instead, and the program answers `LobbyStillOpen`: an error about the clock, for a keeper whose
// actual problem is that the feature it is relying on cannot be encoded. That is the silent-wrong
// -thing failure this repo keeps deleting, and it is worth one boot-time refusal to make impossible.
//
// (A missing METHOD, by contrast, throws loudly on its own — `program.methods.sweepHouseTake` is
// `undefined` at runtime today and calling it says so. It is a missing ACCOUNT that fails quietly,
// because Anchor builds the account list by walking the IDL and ignores names it does not find.)
//
// It reads the SAME IDL object Anchor is going to build from — `loadIdl()`, cached — rather than a
// second copy or a version number. A version number would be a claim about the IDL; this is the IDL.

import type { Idl } from "@coral-xyz/anchor";

import { loadIdl } from "../../src/chain/idl.ts";

/** What this IDL can and cannot encode. Read the file header on which direction each answer is worth
 *  anything in: `false` is proof of absence, `true` is not proof of a deploy. */
export interface ProgramFeatures {
  /** Can an authority-signed EARLY close (bypassing the deadline) be encoded at all?
   *
   *  False is the veto on `--hold-open`: a keeper that held a lobby open without being able to
   *  express the close would watch a real player stand in a room until the backstop expired. */
  authorityEarlyClose: boolean;
  /** Can a finished round's house take be swept onto the arena's `Treasury`?
   *
   *  Three things have to be there, not one: the sweep instruction, `init_treasury` (the treasury PDA
   *  has to be creatable at all), and `Round.house_swept` — without the flag the keeper cannot tell a
   *  swept round from an unswept one, and would re-send `sweep_house_take` on every pass of every
   *  hold for the rest of the process's life. */
  houseTakeSweep: boolean;
}

/** The IDL's own shape, narrowed to the two questions asked of it. Written out here rather than
 *  reached for through `Idl`'s published types because those model account GROUPS as well as
 *  accounts, and this file only ever wants "is there an account with this name at the top level" —
 *  a shape the traversal below can state in four lines and check honestly. */
interface IdlShape {
  instructions?: { name?: unknown; accounts?: { name?: unknown }[] }[];
  types?: { name?: unknown; type?: { fields?: { name?: unknown }[] } }[];
}

function hasInstruction(idl: IdlShape, name: string): boolean {
  return (idl.instructions ?? []).some((ix) => ix.name === name);
}

function instructionTakesAccount(idl: IdlShape, instruction: string, account: string): boolean {
  const ix = (idl.instructions ?? []).find((candidate) => candidate.name === instruction);
  return (ix?.accounts ?? []).some((a) => a.name === account);
}

function accountHasField(idl: IdlShape, account: string, field: string): boolean {
  const type = (idl.types ?? []).find((t) => t.name === account);
  return (type?.type?.fields ?? []).some((f) => f.name === field);
}

/** Read the features off an IDL that has already been loaded. Pure, so the whole probe is exercisable
 *  from a test against a hand-built IDL rather than against whatever happens to be deployed today. */
export function programFeaturesOf(idl: Idl): ProgramFeatures {
  // Names are the RAW, snake_case IDL names. Anchor camel-cases at `new Program(...)` time, but this
  // is the file on disk, before that ever happens — `closeLobbyAndDraw` would silently match nothing.
  const shape = idl as unknown as IdlShape;
  return {
    authorityEarlyClose:
      instructionTakesAccount(shape, "close_lobby_and_draw", "authority") &&
      instructionTakesAccount(shape, "close_lobby_and_draw", "arena"),
    houseTakeSweep:
      hasInstruction(shape, "sweep_house_take") &&
      hasInstruction(shape, "init_treasury") &&
      accountHasField(shape, "Round", "house_swept"),
  };
}

export async function readProgramFeatures(): Promise<ProgramFeatures> {
  return programFeaturesOf(await loadIdl());
}
