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
// WHAT THE `false` DIRECTION IS WORTH, WHICH IS A LOT — AND IT IS MEASURED, NOT REASONED ABOUT.
// Anchor builds instructions from this IDL, so an account the IDL does not declare cannot reach the
// transaction. Built both ways against the currently served IDL and printed the account list:
//
//     closeLobbyAndDraw({ ... })                        ->  7 accounts, one signer
//     closeLobbyAndDraw({ ..., authority: <operator> })  ->  7 accounts, one signer   (IDENTICAL)
//
// No error, no warning: `arena` and `authority` are dropped on the floor and an ordinary
// permissionless close is built instead, which the program then answers with `LobbyStillOpen` — an
// error about the CLOCK, for a keeper whose actual problem is that the feature it is relying on
// cannot be encoded. A real player would be standing in the lobby while that repeated every twenty
// seconds. That is the silent-wrong-thing failure this repo keeps deleting, and one boot-time refusal
// makes it impossible.
//
// (The same probe is the evidence that the reverse is safe: the permissionless call is byte-identical
// to what it has always been, so a keeper running against the deployed program is unaffected by any
// of this.)
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
  /** Can a finished round's ACCOUNT be closed, handing its rent deposit back?
   *
   *  This is the capability the auto-close policy is gated on, and it is the one where the `false`
   *  direction is worth the most so far. `close_round_account` is v7; every earlier deployment has
   *  no such instruction, so `program.methods.closeRoundAccount` is `undefined` and calling it
   *  throws — once per pass, at 1Hz, forever, on a policy that is ON BY DEFAULT. A capability that
   *  defaults to on has to be able to prove it is unavailable, or the default is a promise the
   *  keeper cannot keep.
   *
   *  IT ALSO REQUIRES THE SWEEP, and that is a chain rule rather than a tidiness preference:
   *  `check_close_permitted` refuses with `RoundNotSwept` unless `Round.house_swept` is set, because
   *  `fees_collected` and `penalties_collected` live only on the round account and closing an
   *  unswept round would forfeit that take permanently and silently. A keeper that could close but
   *  not sweep would therefore close nothing — every attempt refused — so the honest answer to "can
   *  this keeper reclaim rent" is no. Stating the dependency here keeps that reasoning in one place
   *  instead of as a surprise in the loop.
   *
   *  `authority` is checked as an ACCOUNT, not just the instruction's presence, for the reason this
   *  file exists: Anchor builds account lists by walking the IDL and silently drops names it does
   *  not find, so an IDL carrying the instruction without the account would build a close that
   *  cannot satisfy `has_one = authority` and fail with a constraint error rather than a missing
   *  account. A missing METHOD throws loudly on its own; a missing ACCOUNT is the quiet one. */
  roundAccountClose: boolean;
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
  const houseTakeSweep =
    hasInstruction(shape, "sweep_house_take") &&
    hasInstruction(shape, "init_treasury") &&
    accountHasField(shape, "Round", "house_swept");
  return {
    authorityEarlyClose:
      instructionTakesAccount(shape, "close_lobby_and_draw", "authority") &&
      instructionTakesAccount(shape, "close_lobby_and_draw", "arena"),
    houseTakeSweep,
    roundAccountClose:
      hasInstruction(shape, "close_round_account") &&
      instructionTakesAccount(shape, "close_round_account", "authority") &&
      // The chain refuses to close an unswept round, so a keeper that cannot sweep cannot close —
      // see the field's doc comment. Expressed as a dependency rather than left for the loop to
      // discover as a stream of `RoundNotSwept` failures.
      houseTakeSweep,
  };
}

export async function readProgramFeatures(): Promise<ProgramFeatures> {
  return programFeaturesOf(await loadIdl());
}
