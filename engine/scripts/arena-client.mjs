// THE ONE PLACE THESE SCRIPTS ARE ALLOWED TO KNOW THE PROGRAM'S SHAPE.
//
// er-roundtrip.mjs and er-cu-bench.mjs used to hand-build every instruction (sha256("global:<name>")
// for the discriminator, then args packed by hand into a Buffer) and hand-read every account field at
// a literal byte offset (`d[48]` for phase, `d.readUInt16LE(51)` for fighter_count, `104` for the
// arena's round_counter). Both halves of that failed, and they failed in the two different ways this
// module exists to make impossible.
//
// THE INSTRUCTIONS FAILED LOUDLY BUT LATE. `open_round` gained a third argument (`lobby_seconds`) and
// the hand-packed data went short; `reveal`, `settle` and `tick(u16)` stopped existing altogether when
// the seed moved to the VRF oracle, and a hand-computed discriminator for a deleted instruction still
// assembles a perfectly valid transaction. Nothing catches that until devnet answers with a number.
//
// THE OFFSETS FAILED SILENTLY — or rather, they had not failed YET, which is worse. Checked against a
// real settled round on devnet: `48/49/51/53` still read the right four fields, because
// `penalties_collected`, `lobby_opened_at` and `lobby_closes_at` all landed AFTER them. Correct by
// luck. The same three insertions did break a sibling script (er-demo/scripts/verify-session-extract
// .mjs), whose decoder reaches the fighter array and therefore had to be repaired twice — its own
// comment PREDICTED the second failure, in writing, and it happened anyway. Predicting a bug twice is
// not a defence, and a hand-decoder that is currently right is not a decoder that is right.
//
// THE LUCK HAS SINCE RUN OUT, and it is worth recording exactly how: `Round` moved to `zero_copy`
// (MAX_FIGHTERS 16 -> 48, FIGHT_TIMEOUT_SECONDS 120 -> 180), and the migration reordered the struct —
// `fighter_count` moved ahead of `bump`, `house_swept` came up beside it, and `Fighter` grew from 58
// bytes to 64 with its own fields in a different order. Every one of `48/49/51/53` reads a different
// field today than it did when that paragraph was written. This module noticed nothing, because it
// never held an opinion about where those bytes lived — it decodes through the IDL, which regenerated
// itself off the same struct and kept reading the right fields under new names and new offsets with
// zero lines changed here. That is the whole argument this file's header was making, now settled by
// the exact event it predicted rather than merely by reasoning about it in advance.
//
// So no ACCOUNT LAYOUT and no INSTRUCTION ENCODING is transcribed here. The IDL is the artifact
// `anchor build` emits from the same source the program is compiled from, and Anchor's coder derives
// both from it. A field added to `Round` tomorrow is picked up by regenerating the IDL — which the
// build already does — and a field added WITHOUT regenerating the IDL is caught by `decodeAccount`
// below, loudly, at the moment of the read.
//
// SAY WHAT THIS DOES NOT COVER, because the guarantee is narrower than "nothing is transcribed" and a
// reader who believes the wider version will trust the wrong things. The pacing and phase values
// re-exported below — MIN_LOBBY_SECONDS, FIGHT_TIMEOUT_SECONDS, MAX_STEPS_PER_CALL, Phase, PHASE_NAME,
// stepsPerSecond — are hand-mirrored from lib.rs into er-demo/src/chain/constants.ts, and this module
// imports that mirror rather than a machine-generated fact. `Phase` cannot come from the IDL at all:
// `#[repr(u8)] pub enum Phase` derives no Anchor traits, so it appears nowhere in the IDL's types.
// They drive real decisions here (the lobby length, the bell, the VRF wait's phase check), and if
// lib.rs moves one and the mirror is not updated, nothing in this module notices. Closing that would
// mean `#[constant]` on them in lib.rs so `anchor build` emits them into `idl.constants` — a change
// to the program, not to these scripts.
//
// Nothing in here reaches the network. It builds instructions and decodes bytes; the scripts own the
// connections, so the same module serves the base layer, the Magic Router and a specific ER validator
// without knowing which it is talking to.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
// Fixed addresses owned by MagicBlock's SDK rather than by us — re-exported below from the SDK's own
// constants for the same reason everything else here comes from the IDL: a literal is a copy, and a
// copy is a thing that can rot. The old scripts each spelled all three out by hand.
import {
  DELEGATION_PROGRAM_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
// The devnet-only chain facts the browser app already keeps in one place — imported rather than
// re-stated, because a copy is a thing that can disagree. Node strips the TypeScript annotations
// natively (v22.6+ behind a flag, on by default from v23; this repo runs v26), so a .ts module is
// directly importable from a .mjs script with no build step and no tsx wrapper.
//
// IMPORTING IT ALSO ARMS THE DEVNET GUARD: constants.ts runs `assertDevnetUrl` over every endpoint
// literal at module-load time, so a mainnet URL that found its way in there fails this import
// outright instead of quietly connecting. That is a reason to import it, not merely a side effect.
import * as app from "../../er-demo/src/chain/constants.ts";

const { AnchorProvider, BN, Program, Wallet } = anchor;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

/** `app` resolves `@solana/web3.js` from er-demo/node_modules, which is a DIFFERENT copy of the
 *  package than the one engine/node_modules gives this file. Its `PublicKey` instances are therefore
 *  not `instanceof` ours — verified, not assumed — and Anchor does `instanceof` checks when it
 *  encodes a pubkey argument. Round-tripping through base58 is the cheap, total fix: one class, one
 *  representation, and any future addition to constants.ts goes through the same door. */
const localKey = (key) => new PublicKey(key.toBase58());

// ---- chain facts, all of them re-exported from the app's single source ---------------------------
export const PROGRAM_ID = localKey(app.PROGRAM_ID);
export const BASE_RPC = app.BASE_RPC;
export const ROUTER_URL = app.ROUTER_URL;
export const EPHEMERAL_QUEUE = localKey(app.DEFAULT_EPHEMERAL_QUEUE);
export const VRF_PROGRAM_ID = localKey(app.VRF_PROGRAM_ID);
export const SLOT_HASHES_SYSVAR = localKey(app.SLOT_HASHES_SYSVAR);
// Only what these scripts actually use. constants.ts exports more (MAX_LOBBY_SECONDS,
// DEFAULT_LOBBY_SECONDS, canonicalCursor, lobbyIsOpen); re-exporting those here would be a second
// surface to keep in step for no caller's benefit.
//
// BOTH HALVES OF THE OLD `MAX_STEPS`, because the scripts need both and they are different numbers.
// `MAX_STEPS_PER_CALL` is job (b), the per-call compute bound — what er-cu-bench.mjs measures against.
// `finalCursor` is job (a), how far a fight of a given lineup can ever get, which is no longer the
// same number at any lineup above a duel.
//
// `finalCursor` IS RE-EXPORTED RATHER THAN LEFT TO CALLERS, and that is a reversal worth explaining
// because the previous revision of this comment argued the other way. It said a caller wanting the
// fight's ceiling should reach for the app constants directly — which was right when no caller wanted
// it, and stopped being right the moment two did. What actually happened is that er-roundtrip.mjs and
// er-cu-bench.mjs each hand-wrote `FIGHT_TIMEOUT_SECONDS * stepsPerSecond(n)` instead: two copies of a
// derivation that already exists, in a repo whose Rust constants carry a standing note about being
// bitten twice by exactly that (the DUST floor, and `bench_fight` drifting from `run_fight`). The
// rule this block is written to — "only what these scripts actually use" — is a rule about surface
// area, not a reason to make callers re-derive arithmetic the mirror already exports.
export const {
  MIN_LOBBY_SECONDS, FIGHT_TIMEOUT_SECONDS, MAX_STEPS_PER_CALL, PHASE_NAME, Phase, stepsPerSecond,
  finalCursor,
} = app;

/** Devnet's genesis hash. The cluster is proven by asking the node what chain it is on, not by
 *  trusting that a URL containing "devnet" reaches devnet — the guard in constants.ts checks the
 *  string, this checks the chain, and neither substitutes for the other. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export { DELEGATION_PROGRAM_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID };

/** Where the IDL is read from by default: the artifact `anchor build` writes next to the program
 *  source. er-demo/public/idl/bulls_arena.json is a byte-copy of it for the browser bundle; this is
 *  the original. */
const DEFAULT_IDL_PATH = join(REPO_ROOT, "programs", "bulls-arena", "idl", "bulls_arena.json");

/** Loads the IDL and refuses to hand back one that disagrees with the app about which program is
 *  deployed.
 *
 *  `ARENA_IDL` points at a different build's IDL — the one case that genuinely needs it is
 *  `er-cu-bench.mjs`, whose `bench_fight` probe is feature-gated off in every normal deploy, so
 *  measuring requires `anchor build -- --features bench` and a deploy of THAT binary under its own
 *  program id. The address check is relaxed in that case (the two are SUPPOSED to differ) and the
 *  substitution is announced instead, because a bench build silently standing in for the real
 *  deployment is worth one line of output.
 *
 *  @returns {{ idl: object, programId: PublicKey, path: string, isOverride: boolean,
 *              stalePdas: {instruction: string, account: string, declared: string}[] }}
 */
export function loadArenaIdl() {
  const override = process.env.ARENA_IDL;
  // `resolve`, not `join`: an override is as likely to be an absolute path as a relative one, and
  // `join(cwd, "/abs/path")` silently produces a nonexistent path under cwd rather than the file
  // that was asked for. Found by doing exactly that.
  const path = override ? resolve(override) : DEFAULT_IDL_PATH;
  let idl;
  try {
    idl = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`could not read the bulls-arena IDL at ${path}: ${e.message}`);
  }
  if (typeof idl.address !== "string") {
    throw new Error(`${path} is not an Anchor IDL — it has no "address" field.`);
  }

  const programId = new PublicKey(idl.address);
  if (!override && !programId.equals(PROGRAM_ID)) {
    throw new Error(
      `IDL address mismatch — refusing to run against a program whose layout is unknown.\n` +
      `  ${path}\n    declares ${idl.address}\n` +
      `  er-demo/src/chain/constants.ts\n    declares ${PROGRAM_ID.toBase58()}\n` +
      `These must agree: the IDL is what decodes the accounts, and PROGRAM_ID is what says which ` +
      `accounts. If the program was just redeployed under a new id, re-run the build so the IDL is ` +
      `regenerated, and copy it to er-demo/public/idl/bulls_arena.json.`);
  }
  return { idl, programId, path, isOverride: Boolean(override), stalePdas: stalePdaPrograms(idl) };
}

/** Finds IDL accounts whose PDA is declared to live under a CONSTANT program id that is not this
 *  IDL's own — an internal inconsistency, and one this repo actually has.
 *
 *  `delegate_round`'s `buffer_round_pda` is derived by the `#[delegate]` macro from `crate::ID`,
 *  which the macro bakes into the IDL as a literal byte array at expansion time. This program's id
 *  has been rolled four times (v1…v4, for MagicBlock's bytecode-cache reasons — see constants.ts),
 *  and the baked constant did not come with it: the committed IDL says the buffer lives under
 *  CchN3JPW… while `address` says CH7K8rDX…, so Anchor's account resolver derives a buffer PDA the
 *  deployed program rejects with ConstraintSeeds on exactly that account. Reproduced on devnet
 *  before this function was written; the deployed program is right and the IDL metadata is stale.
 *
 *  So the three delegation PDAs are derived from the SDK instead (`delegationPdas` below) and this
 *  exists to make sure the discrepancy is SAID rather than silently routed around. It is a warning
 *  and not a refusal because nothing here consumes the stale metadata — but a reader who sees
 *  ConstraintSeeds on some future account deserves to have been told where it comes from. */
function stalePdaPrograms(idl) {
  // Two constants are legitimately allowed to appear here, and both have to be excused explicitly or
  // this warns about correct IDL. `idl.address` is the ordinary case (a PDA of our own program), and
  // the Delegation Program is the other real one — `process_undelegation.buffer` is genuinely one of
  // ITS PDAs, not ours, so a naive "anything that isn't idl.address" rule cries wolf on every run.
  // Anything else is a constant nobody can account for, which is exactly the shape of a `crate::ID`
  // that got left behind by a program-id roll.
  const legitimate = new Set([idl.address, DELEGATION_PROGRAM_ID.toBase58()]);
  const stale = [];
  for (const ix of idl.instructions ?? []) {
    for (const acc of ix.accounts ?? []) {
      if (acc.pda?.program?.kind !== "const") continue;
      const declared = new PublicKey(Uint8Array.from(acc.pda.program.value)).toBase58();
      if (!legitimate.has(declared)) stale.push({ instruction: ix.name, account: acc.name, declared });
    }
  }
  return stale;
}

/** The three accounts the delegation CPI needs alongside the delegated one. Derived from MagicBlock's
 *  own SDK rather than from the IDL's `pda` metadata — see `stalePdaPrograms` for why that
 *  distinction is load-bearing rather than a matter of taste. */
export function delegationPdas(delegated, programId = PROGRAM_ID) {
  return {
    buffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(delegated, programId),
    record: delegationRecordPdaFromDelegatedAccount(delegated),
    metadata: delegationMetadataPdaFromDelegatedAccount(delegated),
  };
}

/** An Anchor `Program` bound to `connection`, signing as `keypair`.
 *
 *  `keypair` is a fee payer and a signer, nothing more — this program has no notion of an owner and
 *  every read below goes through the coder rather than through the provider, so the same Program
 *  object decodes accounts it has no relationship to. */
export function createArenaProgram(connection, keypair, idl = loadArenaIdl().idl) {
  const provider = new AnchorProvider(connection, new Wallet(keypair), {
    commitment: "confirmed", preflightCommitment: "confirmed",
  });
  return new Program(idl, provider);
}

const enc = new TextEncoder();

export function arenaPda(programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([enc.encode("arena")], programId)[0];
}

/** u64 little-endian — the byte form the `round` PDA's third seed takes on-chain.
 *
 *  Accepts a BN as well as a number or bigint. This module exports `BN`, so `roundPda(new BN(n))` is
 *  a natural thing to write, and a bare `BigInt(bn)` answers it with "Cannot convert object to a
 *  BigInt" — an error that says nothing about the actual mistake. */
export function u64le(n) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(BN.isBN(n) ? n.toString() : n), true);
  return new Uint8Array(buf);
}

export function roundPda(roundNo, arena = arenaPda(), programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("round"), arena.toBuffer(), u64le(roundNo)], programId)[0];
}

/** THE GUARD. Decodes an account through the IDL, and refuses to decode one whose length the IDL
 *  cannot account for.
 *
 *  The length check is the entire point, and it is not belt-and-braces. Anchor's borsh coder reads
 *  fields in declaration order and STOPS when it has read them all: hand it a `Round` that has grown
 *  a field since the IDL was generated and it returns a complete, plausible object built from the
 *  first 1,093 bytes — no error, no warning, and every field after the new one holding a different
 *  number than the chain does. arena-client.test.mjs calls the bare coder to demonstrate exactly
 *  that, because it is the premise this whole module rests on and a premise nobody executes is a
 *  belief.
 *
 *  A SHORTER account is layout-dependent rather than universally silent, which is worth stating
 *  precisely: `@coral-xyz/borsh` reads a `u64` through a Blob-backed BN, so a short read comes back
 *  as zeroes with no complaint, but a `pubkey` is a `Blob(32)` handed to `new PublicKey()`, which
 *  throws on a short slice. Losing eight bytes off `Round` lands inside the final `Fighter.banked`
 *  and is therefore silent; losing a different eight might not be. Either way the length check
 *  catches it first, which is the point of checking length rather than reasoning about which field
 *  a truncation happens to land in.
 *
 *  `Round` and `Arena` are both fixed-size — every field is a scalar, a `Pubkey`, or a fixed-length
 *  array — so `coder.accounts.size()` is an EXACT expected length rather than a minimum, and equality
 *  is the right test. If someone later adds a `Vec`, `String`, `Option` or a DATA-CARRYING ENUM to
 *  one of them, this throws on a perfectly valid account — Anchor sizes an enum as its largest
 *  variant plus a byte, so an account holding a smaller variant is legitimately short. The message
 *  below says so, because a variable-length field in a delegated ER account is a decision worth
 *  stopping for rather than one to discover through a loosened assertion.
 *
 *  It also does NOT use `program.account.<name>.fetch()`, deliberately: Anchor's fetch path checks
 *  that the program owns the account, and a round living in the Ephemeral Rollup is owned by the
 *  Delegation Program. The coder has no such opinion, so this reads a round identically on the base
 *  layer, through the router, or straight off the ER validator — which is exactly the sequence these
 *  scripts walk.
 *
 *  @param {import("@coral-xyz/anchor").Program} program
 *  @param {"round"|"arena"} name  the IDL account name, camelCased as Anchor exposes it
 *  @param {{data: Buffer, owner: PublicKey}|null} info  the raw account, as getAccountInfo returns it
 *  @param {string} where  human-readable origin, quoted in the error — "the base layer", a URL, …
 */
export function decodeAccount(program, name, info, where = "chain") {
  if (!info) throw new Error(`no ${name} account found on ${where}`);
  const expected = program.coder.accounts.size(name);
  if (info.data.length !== expected) {
    throw new Error(
      `${name} account on ${where} is ${info.data.length} bytes; the IDL describes ${expected}.\n` +
      `  Decoding it anyway would return plausible, WRONG numbers — every field past the point the ` +
      `two layouts diverge would be read from the wrong bytes — so this refuses instead.\n` +
      `  Almost always: the program gained or lost a field and the IDL was not regenerated. Rebuild ` +
      `the program, then copy programs/bulls-arena/idl/bulls_arena.json to ` +
      `er-demo/public/idl/bulls_arena.json.\n` +
      `  If instead a variable-length field (Vec/String/Option, or a data-carrying enum) was ` +
      `deliberately added to ${name}, ` +
      `this equality check is no longer the right one and needs replacing with a minimum-length ` +
      `check — see this function's doc comment.`);
  }
  // Discriminator mismatch throws on its own ("Invalid account discriminator"), which is the check
  // that catches decoding an Arena as a Round — a different mistake, already covered.
  return program.coder.accounts.decode(name, info.data);
}

/** True when one side has nobody still standing — the client-side mirror of `fight_is_over` in
 *  lib.rs, and the condition `resolve` requires (or the bell, `FIGHT_TIMEOUT_SECONDS`).
 *
 *  A mirror rather than a read of chain state because there is nothing on the account that says it:
 *  it is a predicate over the fighter array, and a script that wants to know whether `resolve` will
 *  be accepted has to compute it. `dead` covers extraction as well as death, exactly as the Rust
 *  does — pull the last opponent out of the ring and the fight is genuinely over. */
export function fightIsOver(round) {
  let a = 0, b = 0;
  for (const f of round.fighters.slice(0, round.fighterCount)) {
    if (f.dead !== 0) continue;
    if (f.side === 0) a++; else b++;
  }
  return a === 0 || b === 0;
}

export { BN };
