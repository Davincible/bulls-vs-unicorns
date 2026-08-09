// THE TEST THAT MAKES arena-client.mjs WORTH HAVING.
//
// The claim these scripts now rest on is: "when a field is added to `Round`, the scripts fail loudly
// rather than reading the wrong number." That is a claim about a failure mode, so it is only
// believable if the failure mode is exercised. Every assertion below is about what happens when the
// program and the IDL DISAGREE — the well-formed cases are here only to prove the disagreement tests
// are testing something.
//
//   cd engine && npm run test:scripts    (or: node --test engine/scripts/*.test.mjs)
//
// No network. Every buffer is synthetic, every offset is walked from the IDL's own field list, and
// every length comes from `coder.accounts.size()` — so this file contains no transcribed layout of
// its own. Writing one would reintroduce exactly the thing arena-client.mjs exists to delete, and a
// test that goes stale with the program is worse than no test, because it goes on passing.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  BN, PROGRAM_ID, arenaPda, createArenaProgram, decodeAccount, delegationPdas, fightIsOver,
  loadArenaIdl, roundPda,
} from "./arena-client.mjs";

// A provider needs a Connection; nothing here ever sends through it, and Connection's constructor
// does not dial. The URL still goes through constants.ts's devnet guard by way of the import.
const program = createArenaProgram(
  new Connection("https://api.devnet.solana.com", "confirmed"), Keypair.generate());

/** Planted into `lobby_opened_at` by `wellFormed("round")`, so a test can tell "the coder read the
 *  field" apart from "the coder read a zero from somewhere". Its OFFSET is computed from the IDL's
 *  own field list rather than written down — a test that hardcodes an offset is the thing this
 *  module exists to delete, and it would go stale in exactly the same way. */
const PLANTED_LOBBY_OPENED_AT = 1_700_000_042;

/** Byte width of the fixed-size IDL types `Round` uses before `lobby_opened_at`. Deliberately does
 *  NOT cover every type Anchor can express: it throws on anything it does not know rather than
 *  guessing, so a future field of an unhandled type fails here loudly instead of producing a
 *  plausible offset. */
function fixedWidth(type) {
  if (typeof type === "string") {
    const scalar = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, pubkey: 32 }[type];
    if (scalar === undefined) throw new Error(`fixedWidth: unhandled IDL type ${type}`);
    return scalar;
  }
  if (type.array) return fixedWidth(type.array[0]) * type.array[1];
  throw new Error(`fixedWidth: unhandled IDL type ${JSON.stringify(type)}`);
}

/** Byte offset of `field` within an account, discriminator included — walked from the IDL. */
function offsetOf(accountTypeName, field) {
  const { idl } = loadArenaIdl();
  let offset = 8;
  for (const f of idl.types.find((t) => t.name === accountTypeName).type.fields) {
    if (f.name === field) return offset;
    offset += fixedWidth(f.type);
  }
  throw new Error(`offsetOf: ${accountTypeName} has no field ${field}`);
}

/** A syntactically perfect account of the size the IDL declares, with the right discriminator. */
function wellFormed(name) {
  const idlName = name[0].toUpperCase() + name.slice(1);
  const { idl } = loadArenaIdl();
  const disc = Buffer.from(idl.accounts.find((a) => a.name === idlName).discriminator);
  const data = Buffer.alloc(program.coder.accounts.size(name));
  disc.copy(data, 0);
  if (name === "round") {
    data.writeBigInt64LE(BigInt(PLANTED_LOBBY_OPENED_AT), offsetOf("Round", "lobby_opened_at"));
  }
  return { data, owner: PROGRAM_ID };
}

test("the IDL and the app agree on which program is deployed", () => {
  // The other half of the guard: `decodeAccount` catches a layout that has drifted from the deployed
  // bytes, and this catches a layout that describes a DIFFERENT program entirely. Both have to hold
  // for a decoded field to mean anything.
  const { idl, programId } = loadArenaIdl();
  assert.equal(idl.address, PROGRAM_ID.toBase58());
  assert.ok(programId.equals(PROGRAM_ID));
});

test("Round decodes through the IDL with every field the IDL declares", () => {
  const round = decodeAccount(program, "round", wellFormed("round"), "a synthetic account");
  const { idl } = loadArenaIdl();
  const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const declared = idl.types.find((t) => t.name === "Round").type.fields.map((f) => camel(f.name));
  // Derived from the IDL on both sides, so this keeps passing when a field is added — which is the
  // point. It is asserting that the decoder reads the IDL, not that Round has fifteen fields today.
  assert.deepEqual(Object.keys(round).sort(), declared.sort());
  assert.equal(round.fighters.length, 16);
});

test("Anchor's coder ALONE decodes a grown Round silently — the premise this module rests on", () => {
  // THE ASSERTION THE REST OF THE FILE DEPENDS ON, and the one it is easiest to leave unwritten:
  // every other test here goes through `decodeAccount`, whose length check short-circuits before the
  // coder is ever reached, so none of them demonstrate that the coder needs guarding at all. This
  // calls the bare coder. If a future Anchor starts rejecting a long buffer on its own, this test
  // fails and the guard's whole justification is up for re-examination — which is the right outcome,
  // and cannot happen if nobody executes the premise.
  const size = program.coder.accounts.size("round");
  const grown = Buffer.concat([wellFormed("round").data, Buffer.alloc(8)]);
  const decoded = program.coder.accounts.decode("round", grown);
  assert.equal(decoded.fighters.length, 16, "a complete object, from a buffer 8 bytes too long");
  assert.equal(decoded.lobbyOpenedAt.toNumber(), PLANTED_LOBBY_OPENED_AT,
    "and every field read from the offsets the STALE layout implies, with no error raised");
  assert.equal(grown.length, size + 8);
});

test("a Round that GAINED a field is refused, not silently misread", () => {
  // The exact shape of the bug being killed: the program grows an i64, the IDL has not caught up,
  // and the account arrives eight bytes longer than the layout describes. The test above proves the
  // coder says nothing about that; this proves the guard does.
  const size = program.coder.accounts.size("round");
  const grown = wellFormed("round");
  grown.data = Buffer.concat([grown.data, Buffer.alloc(8)]);
  assert.throws(
    () => decodeAccount(program, "round", grown, "the base layer"),
    (e) => {
      assert.match(e.message, new RegExp(`${size + 8} bytes`));       // what arrived
      assert.match(e.message, new RegExp(`IDL describes ${size}`));   // what was expected
      assert.match(e.message, /the base layer/);                      // where it came from
      assert.match(e.message, /regenerate|regenerated|Rebuild/i);     // what to do about it
      return true;
    });
});

test("a Round that LOST a field is refused too", () => {
  // The mirror case. Eight bytes off the end of `Round` lands inside the last `Fighter.banked`, a
  // u64, which `@coral-xyz/borsh` reads through a Blob-backed BN — so the short read comes back as
  // zeroes and the account decodes to a round that looks merely uneventful. Asserted, not assumed,
  // for the same reason as the test above: a truncation landing on a `pubkey` would throw instead,
  // and the guard exists precisely so nobody has to reason about which field it lands in.
  const size = program.coder.accounts.size("round");
  const shrunk = wellFormed("round");
  shrunk.data = shrunk.data.subarray(0, size - 8);
  assert.doesNotThrow(() => program.coder.accounts.decode("round", shrunk.data),
    "the bare coder is silent on this truncation — which is what the guard is for");
  assert.throws(() => decodeAccount(program, "round", shrunk, "an ER validator"),
    new RegExp(`${size - 8} bytes`));
});

test("an Arena decoded as a Round is refused on its discriminator", () => {
  // Right length is not enough on its own — but here the length is wrong too, so this proves the
  // ordering: length first, and it is the length message that comes out.
  assert.throws(() => decodeAccount(program, "round", wellFormed("arena"), "chain"),
    new RegExp(`${program.coder.accounts.size("arena")} bytes`));
  // With the length check satisfied, Anchor's own discriminator check is what catches it.
  const impostor = wellFormed("round");
  impostor.data.writeUInt8(impostor.data[0] ^ 0xff, 0);
  assert.throws(() => decodeAccount(program, "round", impostor, "chain"), /discriminator/i);
});

test("a missing account is named rather than dereferenced", () => {
  assert.throws(() => decodeAccount(program, "round", null, "the router"), /no round account found on the router/);
});

test("an instruction the program does not have cannot be built", () => {
  // The instruction-side half of the same guarantee. `reveal` and `settle` were real instructions
  // when these scripts were written and are not any more; a hand-built discriminator for either
  // would still assemble a transaction and still be rejected on chain with an opaque error, whereas
  // going through the IDL there is nothing to call.
  assert.equal(program.methods.reveal, undefined);
  assert.equal(program.methods.settle, undefined);
  assert.equal(typeof program.methods.openRound, "function");
});

test("open_round built through the IDL carries every argument the IDL declares", async () => {
  const { idl } = loadArenaIdl();
  const args = idl.instructions.find((i) => i.name === "open_round").args;
  const accounts = {
    arena: arenaPda(), round: roundPda(1), authority: Keypair.generate().publicKey,
    systemProgram: SystemProgram.programId,
  };
  const ix = await program.methods
    .openRound(new BN(1), Array(32).fill(0), 60)
    .accounts(accounts).instruction();
  // 8 discriminator + the sum of the IDL's own arg list, through the same `fixedWidth` walker the
  // offset helper uses — so this describes the rule and not today's answer, and an argument of a type
  // the walker does not handle fails loudly here rather than silently summing `undefined`.
  const expected = 8 + args.reduce((n, a) => n + fixedWidth(a.type), 0);
  assert.equal(ix.data.length, expected);
  assert.ok(ix.programId.equals(PROGRAM_ID));

  // And the failure that started all this: an argument the caller forgot. Anchor refuses to build
  // the instruction at all — the old hand-packed version happily sent a short one and let devnet
  // answer with a deserialisation error from inside the program.
  await assert.rejects(
    program.methods.openRound(new BN(1), Array(32).fill(0)).accounts(accounts).instruction());
});

test("fightIsOver mirrors lib.rs: one side with nobody standing", () => {
  const f = (side, dead) => ({ wallet: PublicKey.default, side, dead, stake: new BN(0), hp: new BN(0), banked: new BN(0) });
  const round = (fighters) => ({ fighterCount: fighters.length, fighters });
  assert.equal(fightIsOver(round([f(0, 0), f(1, 0)])), false);
  assert.equal(fightIsOver(round([f(0, 0), f(1, 1)])), true, "side 1 has nobody left");
  // Extraction sets dead = 1, so pulling the last opponent out ends the fight — the same rule the
  // Rust states explicitly, and the one that decides whether `resolve` will be accepted.
  assert.equal(fightIsOver(round([f(0, 0), f(0, 0)])), true, "a one-sided lineup is over from the start");
  // Fighters past `fighterCount` are the zeroed tail of a fixed [Fighter; 16] array and must not
  // count as standing side-0 fighters — reading the tail is the same class of mistake as reading a
  // field at the wrong offset.
  assert.equal(fightIsOver({ fighterCount: 2, fighters: [f(0, 1), f(1, 1), f(0, 0), f(0, 0)] }), true);
});

test("the stale-PDA detector flags the buffer, and does NOT flag the delegation program's own", () => {
  // Both halves matter. The first is the real defect it exists to surface: `delegate_round`'s buffer
  // is derived under `crate::ID` and the IDL's baked copy of that constant did not follow the program
  // id when it rolled, which costs a ConstraintSeeds failure on devnet. The second is the false
  // positive that made the first useless — `process_undelegation.buffer` is a Delegation Program PDA
  // and always will be, so a detector that reports it reports something on every single run and gets
  // ignored.
  const { stalePdas } = loadArenaIdl();
  const named = stalePdas.map((s) => `${s.instruction}.${s.account}`);
  assert.deepEqual(named, ["delegate_round.buffer_round_pda"]);
});

test("the delegation buffer is derived under our program, whatever the IDL claims", () => {
  // The fix that follows from the test above: the SDK derives from the owner program id, which is
  // what the deployed constraint actually checks against.
  const round = roundPda(1);
  const { buffer } = delegationPdas(round);
  const underOurProgram = PublicKey.findProgramAddressSync(
    [Buffer.from("buffer"), round.toBuffer()], PROGRAM_ID)[0];
  assert.ok(buffer.equals(underOurProgram));
});
