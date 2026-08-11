// READING THE ARENA AND ROUND ACCOUNTS THE WAY THE BROWSER READS THEM — one decoder, shared by the
// operator scripts, so there is exactly one place where a field's offset is decided.
//
// THE INCIDENT THIS FILE IS THE REPAIR FOR. `dump-round.mjs` used to walk the `Round` account by
// hand, counting bytes from the struct order in `programs/bulls-arena/src/lib.rs`. It printed a `pot`
// of 2,680,059,919,616 for a round whose real pot was 41,916,000 — five orders of magnitude wrong,
// because the offsets had drifted past `winner`/`fighter_count`/`bump`/`house_swept`/`padding` and
// the u64 it read was not the pot at all. A number that wrong is still a number. It went unquestioned
// until somebody happened to compare it against the keeper, and the response at the time was to stop
// printing the pot rather than to fix the reading. That was the right call with the tools in hand and
// it is not the right call now.
//
// SO: ANCHOR'S OWN ACCOUNTS CODER, AGAINST `public/idl/bulls_arena.json`. Not a second hand-written
// layout, and not a third: this is the same IDL `src/chain/idl.ts` loads and the same coder
// `program.account.round.fetch()` runs behind, which is to say it is the decoder that has been
// rendering live pots on the production page for the whole life of this arena. A bug in it is a bug
// the site would have shown first. That is a far stronger guarantee than any amount of care with
// `readBigUInt64LE`.
//
// WHAT ABOUT THE CASE THE HAND-DECODER EXISTED FOR — an IDL in this tree that has already moved past
// the DEPLOYED program? It is real (`src/chain/program.ts` documents borsh walking nine bytes off the
// end of every live round when a too-new IDL was served early, and taking the page down), and it is
// exactly what `dump-round.mjs` is meant to investigate rather than trip over. The answer is
// `roundAccountSize()`: the coder can state, from the IDL alone, precisely how many bytes it expects,
// and the chain states how many the account actually has. A caller compares the two BEFORE decoding.
// Agreement means the IDL and the deployed program describe the same struct and every field below is
// trustworthy; disagreement is a fact worth printing loudly, and the caller degrades rather than
// decoding garbage into a confident-looking table. The failure that used to be invisible now has a
// number attached to it in advance.
//
// ON SHARING THIS BETWEEN SCRIPTS AT ALL. `fund-wallet.mjs` and its siblings deliberately INLINE the
// devnet guard rather than importing it, and that comment is sometimes read as a blanket rule against
// shared script code. It is not: the thing it declines is reaching across the boundary into the
// TypeScript/Vite module graph from a plain Node script. This is `.mjs` importing `.mjs` in the same
// runtime with no build step between them — the import that comment was never about. The alternative
// is two copies of an account layout, which is the precise shape of the defect described above.

import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
// Namespace import, then destructure — the pattern every other script in this directory uses.
// `@coral-xyz/anchor` is CommonJS, and a named ESM import from it depends on Node's static analysis
// of the module's exports rather than on anything the package promises.
import * as anchor from "@coral-xyz/anchor";

const { BorshAccountsCoder } = anchor;

/** `Phase` in `programs/bulls-arena/src/lib.rs`, which declares its discriminants explicitly
 *  (`Lobby = 0 … Abandoned = 4`) precisely so a client may index an array like this one. */
export const PHASE_NAMES = ["Lobby", "Drawing", "Fight", "Settled", "Abandoned"];

/** Never returns undefined: an unknown discriminant is itself the interesting output. */
export function phaseName(phase) {
  return `${PHASE_NAMES[phase] ?? "UNKNOWN"} (${phase})`;
}

/**
 * The program id, read out of the app's OWN constants rather than out of an IDL path or a literal
 * here, so that a script and the page it is being used to debug can never be pointed at two
 * different programs. This repo has already shipped a program-id bump; the file below is the one
 * place that moved, and everything that reads it moved with it for free.
 */
export function programId() {
  const src = fs.readFileSync(new URL("../src/chain/constants.ts", import.meta.url), "utf8");
  const m = src.match(/export const PROGRAM_ID = new PublicKey\("([1-9A-HJ-NP-Za-km-z]+)"\)/);
  // A thrown error naming the file, rather than the `TypeError: Cannot read properties of null` that
  // an unchecked `match(...)[1]` produces — which reads as a broken script instead of as a renamed
  // constant, and sends the next person to the wrong file.
  if (!m) throw new Error("could not read PROGRAM_ID out of src/chain/constants.ts — was it renamed?");
  return new PublicKey(m[1]);
}

/**
 * `ARENA_SEED` alone — there is ONE arena per program, not one per index.
 *
 * Deriving this with a trailing u64 index produces a PDA that simply does not exist, and
 * `getAccountInfo` answering null for it is indistinguishable from a round whose rent has been
 * reclaimed. That is a genuinely confusing wrong answer to hand a script whose whole job is telling
 * those two cases apart.
 */
export function arenaPda(program) {
  return PublicKey.findProgramAddressSync([Buffer.from("arena")], program)[0];
}

const le8 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export function roundPda(program, arena, roundNo) {
  return PublicKey.findProgramAddressSync([Buffer.from("round"), arena.toBuffer(), le8(roundNo)], program)[0];
}

/** Built once and reused. Constructing a coder parses the whole IDL, and both callers decode more
 *  than one account. */
let parsed = null;
function idl() {
  if (parsed === null) {
    const json = JSON.parse(fs.readFileSync(new URL("../public/idl/bulls_arena.json", import.meta.url), "utf8"));
    parsed = { json, coder: new BorshAccountsCoder(json) };
  }
  return parsed;
}

const accountsCoder = () => idl().coder;

/** How many bytes the IDL says a `Round` account occupies, discriminator included. Compare this
 *  against `accountInfo.data.length` BEFORE decoding — see the header. */
export function roundAccountSize() {
  return accountsCoder().size("Round");
}

/**
 * The eight bytes Anchor writes at the head of a `Round`, per this tree's IDL.
 *
 * Worth having on its own because it makes a layout mismatch DIAGNOSABLE rather than merely
 * detectable. If the size disagrees but these eight bytes match, the account really is a `Round` and
 * this tree's IDL has drifted from the deployed program — rebuild the IDL. If they do not match, the
 * account is something else entirely and the size was never the interesting fact: the program id or
 * the PDA derivation is wrong, and a size comparison would have sent the reader off to regenerate a
 * perfectly good IDL.
 *
 * Taken from the IDL's own `discriminator` array rather than recomputed as `sha256("account:Round")`.
 * Anchor's newer IDL format DECLARES the eight bytes, and a client that recomputes them is asserting
 * a naming convention the program is free to have overridden — the one place where hashing a string
 * ourselves could disagree with the very file we are checking against.
 */
export function roundDiscriminator() {
  const account = idl().json.accounts.find((a) => a.name === "Round");
  if (!account) throw new Error("public/idl/bulls_arena.json declares no Round account");
  return Buffer.from(account.discriminator);
}

/** The same, for `Arena`. */
export function arenaAccountSize() {
  return accountsCoder().size("Arena");
}

/**
 * `Arena { authority, token_a, token_b, round_counter, fee_bps, bump }`.
 *
 * NOTE THE FIELD NAMES ARE THE IDL'S, WHICH IS TO SAY snake_case. The browser's `RawArenaAccount`
 * shows camelCase because Anchor's `Program` wrapper renames on the way through; the bare
 * `BorshAccountsCoder` used here does not, and pretending otherwise by mapping the keys would put a
 * translation layer between these scripts and the file they are checking. `round_counter` and
 * `fee_bps` arrive as a `BN` and a `number` respectively.
 */
export function decodeArena(data) {
  return accountsCoder().decode("Arena", data);
}

/**
 * `Round`, including the full `[Fighter; 48]` array.
 *
 * Every fixed-size slot decodes, used or not — the unused ones hold the default pubkey and zeroes.
 * Use `activeFighters()` rather than filtering by hand: `fighter_count` is what the PROGRAM treats as
 * the population, and a client that instead counts non-default wallets is inventing a second
 * definition of "how many fighters are in this round".
 */
export function decodeRound(data) {
  return accountsCoder().decode("Round", data);
}

/** The occupied slots, in seat order, exactly as the program reads them. */
export function activeFighters(round) {
  return round.fighters.slice(0, round.fighter_count);
}

/**
 * Split a round's fighters into the arena's own and everybody else.
 *
 * THIS IS NOW THE COMPUTATION, NOT A CHECK AGAINST ONE. Until schema 5 the keeper published
 * `houseFighterCount` and `realFighterCount` and these scripts compared against them; the published
 * counts are gone, so the arithmetic happens here, from the round account plus the authenticated
 * roster. That is a strictly better position to be in than the one it replaces — the old comparison
 * could only ever agree or disagree with a claim, and it shared the claim's blind spot, since both
 * sides were reading the same list.
 *
 * @param {readonly object[]} fighters from `activeFighters()`.
 * @param {ReadonlySet<string>} houseWallets from `fetchHouseWallets()`, and ONLY from an
 *   `available: true` result. There is no defaulting here and no `?? new Set()`: a caller with no
 *   roster must take its own branch and say so, because an empty set silently reports every house
 *   fighter as a real player, which is the exact direction that makes an operator relax.
 */
export function splitFighters(fighters, houseWallets) {
  const house = [];
  const real = [];
  for (const f of fighters) {
    (houseWallets.has(f.wallet.toBase58()) ? house : real).push(f);
  }
  return { house, real };
}
