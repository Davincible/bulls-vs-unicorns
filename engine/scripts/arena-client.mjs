// THE ONE PLACE THESE SCRIPTS ARE ALLOWED TO KNOW THE PROGRAM'S SHAPE.
//
// er-roundtrip.mjs and er-cu-bench.mjs used to hand-build every instruction (sha256("global:<name>")
// for the discriminator, then args packed by hand into a Buffer) and hand-read every account field at
// a literal byte offset (`d[48]` for phase, `d.readUInt16LE(51)` for fighter_count, `104` for the
// arena's round_counter). That works exactly until the program changes, and then it does the worst
// possible thing: `open_round` gained a third argument and the hand-built instruction started failing
// to deserialise, while `Round` gained `penalties_collected` and then `lobby_opened_at`/
// `lobby_closes_at` and every hand-decoded field after them silently became a different number. A
// sibling script's decoder carried a comment PREDICTING that failure for `penalties_collected`, and
// then it happened a second time for the lobby fields. Predicting a bug twice is not a defence.
//
// So nothing here is transcribed. The IDL is the artifact `anchor build` emits from the same source
// the program is compiled from, and Anchor's coder derives both the instruction encoding and the
// account layout from it. A field added to `Round` tomorrow is picked up by regenerating the IDL —
// which the build already does — and a field added WITHOUT regenerating the IDL is caught by
// `decodeAccount` below, loudly, at the moment of the read.
//
// Nothing in here reaches the network. It builds instructions and decodes bytes; the scripts own the
// connections, so the same module serves the base layer, the Magic Router and a specific ER validator
// without knowing which it is talking to.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
// Fixed addresses owned by MagicBlock's SDK rather than by us — re-exported below from the SDK's own
// constants for the same reason everything else here comes from the IDL: a literal is a copy, and a
// copy is a thing that can rot. The old scripts each spelled all three out by hand.
import {
  DELEGATION_PROGRAM_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID,
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
export const {
  MIN_LOBBY_SECONDS, MAX_LOBBY_SECONDS, DEFAULT_LOBBY_SECONDS,
  FIGHT_TIMEOUT_SECONDS, MAX_STEPS, PHASE_NAME, Phase,
  stepsPerSecond, canonicalCursor, lobbyIsOpen,
} = app;

/** Devnet's genesis hash. The cluster is proven by asking the node what chain it is on, not by
 *  trusting that a URL containing "devnet" reaches devnet — the guard in constants.ts checks the
 *  string, this checks the chain, and neither substitutes for the other. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

// Fixed addresses owned by MagicBlock's SDK rather than by us — taken from the SDK's own exports for
// the same reason everything else here comes from the IDL: a literal is a copy that can rot.
export const {
  DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID,
} = await import("@magicblock-labs/ephemeral-rollups-sdk");

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
 *  @returns {{ idl: object, programId: PublicKey, path: string, isOverride: boolean }}
 */
export function loadArenaIdl() {
  const override = process.env.ARENA_IDL;
  const path = override ? join(process.cwd(), override) : DEFAULT_IDL_PATH;
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
  return { idl, programId, path, isOverride: Boolean(override) };
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

/** u64 little-endian — the byte form the `round` PDA's third seed takes on-chain. */
export function u64le(n) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(n), true);
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
 *  number than the chain does. Hand it a SHORTER account and buffer-layout reads past the end as
 *  zeroes, which is worse. Both were reproduced against this exact Anchor version (0.32.1) before
 *  this function was written; see arena-client.test.mjs, which asserts them.
 *
 *  `Round` and `Arena` are both fixed-size — every field is a scalar, a `Pubkey`, or a fixed-length
 *  array — so `coder.accounts.size()` is an EXACT expected length rather than a minimum, and equality
 *  is the right test. If someone later adds a `Vec`, `String` or `Option` to one of them, this throws
 *  on a perfectly valid account; the message below says so, because a variable-length field in a
 *  delegated ER account is a decision worth stopping for rather than one to discover through a
 *  loosened assertion.
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
      `  If instead a variable-length field (Vec/String/Option) was deliberately added to ${name}, ` +
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
