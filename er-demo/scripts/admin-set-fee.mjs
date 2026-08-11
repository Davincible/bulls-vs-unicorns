// Change the arena's entry fee, live, without a redeploy.
//
//   node scripts/admin-set-fee.mjs               # read the current rate and stop
//   node scripts/admin-set-fee.mjs 100           # set it to 100 bps (1.00%)
//
// WHY THE READ-ONLY FORM IS THE DEFAULT. `set_fee_bps` re-opens a decision players made when they
// entered, so the failure mode worth engineering against is a fat-fingered argument, not a missing
// feature. Running it bare prints the rate and changes nothing.
//
// WHEN TO RUN IT. `enter` reads `arena.fee_bps` LIVE, so a change that lands mid-lobby charges later
// entrants a different rate than the ones already standing in it. Nothing on chain forbids that and
// nothing here can detect every case, but the obvious guard is cheap: this refuses while the current
// round is in Fight, and warns if the open lobby already holds fighters.
//
// THE GUARD NOW READS THE CHAIN, NOT THE KEEPER'S STATUS FILE, and that is a repair rather than a
// preference. It used to take `phase` and `realFighterCount` off `/keeper-status.json`. As of
// `KEEPER_STATUS_SCHEMA` 5 the arena's own wallets are internal by an owner's decision, so the file
// no longer publishes any split at all — and the old guard read `(r.realFighterCount ?? 0) > 0`,
// which meant the warning about changing the rate under real players SILENTLY STOPPED FIRING the
// moment that field disappeared. No error, no missing-field complaint, just a check that always
// passes. Reading the round account directly fixes the immediate hole and closes the class: the
// fighters are on the same chain this transaction is about to be sent to, the phase comes from the
// same place, and there is no intermediary whose schema can change out from under a safety check.
// The one thing the chain cannot tell us is which of those wallets are the arena's own, and that is
// what the authenticated roster in `houseList.mjs` is for — with an explicit, louder branch for when
// it is unavailable.
//
// THE FRONT END FOLLOWS ON ITS OWN — nothing to redeploy, and no source file to edit afterwards.
// The site reads `Arena.fee_bps` off the arena poll it was already running (`src/v2/data/useChain.ts`)
// and re-reads it every five seconds, so a rate set here is on every surface that quotes it — the
// intro overlay, the deploy panels, the dashboard tile, the referrals maths — within seconds of this
// transaction confirming. `FEE_BPS` in `src/v2/contract.ts` is now only what the page shows in the
// moment before that first read lands, and it is labelled as unread while it is on screen.
//
// That was NOT true until this was wired, and the gap cost a live page: the rate moved 20 -> 100 here
// while the front end was serving a hardcoded 20, and it kept quoting a fifth of what players were
// being charged until the next Vercel build. Verify with a browser, not with the console line below:
// this script confirms what the ACCOUNT says, which was never the part that was wrong.
//
// It is deliberately NOT wired into the keeper. A rate change is a decision somebody makes, and a
// process that could make it on its own is a process that could make it by accident.

import { Connection, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  activeFighters,
  arenaPda as deriveArenaPda,
  decodeArena,
  decodeRound,
  phaseName,
  PHASE_NAMES,
  programId,
  roundAccountSize,
  roundPda,
  splitFighters,
} from "./roundAccount.mjs";
import { fetchHouseWallets } from "./houseList.mjs";

const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const KEY_PATH = process.env.ARENA_AUTHORITY_KEY || new URL("../../.devnet/fork-payer.json", import.meta.url).pathname;

/** Mirrors `MAX_FEE_BPS` in programs/bulls-arena/src/lib.rs. Checked here too so a typo fails before
 *  it costs a transaction, not because this side is authoritative — the program is. */
const MAX_FEE_BPS = 1_000;

// The program id, the PDA derivations and the account layouts all come from `roundAccount.mjs`, which
// decodes with Anchor's coder against this tree's IDL. This file used to hand-roll `readArena` from
// the struct order in lib.rs; that is the same technique that once made `dump-round.mjs` print a pot
// wrong by five orders of magnitude, and one hand-written layout per script is one drift per script.
const PROGRAM_ID = programId();
const arenaPda = deriveArenaPda(PROGRAM_ID);

const conn = new Connection(RPC, "confirmed");

/** Anchor's instruction discriminator: the first 8 bytes of sha256("global:<snake_case_name>"). */
const discriminator = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const info = await conn.getAccountInfo(arenaPda);
if (!info) throw new Error(`arena ${arenaPda.toBase58()} does not exist under program ${PROGRAM_ID.toBase58()}`);
// snake_case field names: this is Anchor's bare accounts coder, which does not rename the way the
// browser's `Program` wrapper does. See `roundAccount.mjs`.
const arena = decodeArena(info.data);

const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
console.log("program  ", PROGRAM_ID.toBase58());
console.log("arena    ", arenaPda.toBase58());
console.log("authority", arena.authority.toBase58());
console.log("rounds   ", arena.round_counter.toString());
console.log("fee_bps  ", arena.fee_bps, `(${pct(arena.fee_bps)})`);

const arg = process.argv[2];
if (arg === undefined) { console.log("\n(read-only — pass a bps value to change it)"); process.exit(0); }

const next = Number(arg);
if (!Number.isInteger(next) || next < 0 || next > MAX_FEE_BPS) {
  throw new Error(`fee must be a whole number of basis points between 0 and ${MAX_FEE_BPS} (got ${arg})`);
}
if (next === arena.fee_bps) { console.log(`\nalready ${next} bps — nothing to do`); process.exit(0); }

// ---------------------------------------------------------------------------------------------
// THE MID-LOBBY GUARD.
//
// Two checks of deliberately different force: a HARD REFUSAL while the current round is in Fight or
// Drawing, and a WARNING when an open lobby already holds real players. The change is never
// retroactive — `enter` charged what `fee_bps` said at the moment it ran — so the warning is not
// about correcting anything, it is about an operator knowing they have just split one lobby across
// two rates.
//
// THE FAILURE THIS BLOCK IS SHAPED AROUND IS NOT A BAD FEE VALUE. That is caught above, cheaply, by
// arithmetic. It is the guard that stops working without anybody noticing. The version this replaces
// asked the keeper's status file for `realFighterCount` and tested `(r.realFighterCount ?? 0) > 0`.
// When schema 5 removed that field the `?? 0` quietly turned "I do not know" into "there are none",
// and the warning never fired again. Nothing threw. Nothing logged. An operator could have changed
// the rate under a full lobby and been told precisely nothing — which is the worst available
// direction for a safety check to fail in, because the absence of a warning reads exactly like the
// all-clear.
//
// SO: NEVER DEFAULT A MISSING FACT INTO A PASSING CHECK. A safety check's "unknown" branch must be
// at least as loud as its "yes" branch and never as quiet as its "no". Every place below where this
// script cannot establish something, it says so and warns anyway. There is no `??` in this block on
// purpose, and if one appears here later it is almost certainly reintroducing this bug.

/**
 * The current round, read from the chain, WITHOUT throwing. The caller decides what each outcome is
 * worth — which is what lets the refusal below be a plain `throw` at the top level instead of the
 * previous version's `if (String(e.message).startsWith("refusing")) throw e`, a `catch` block sniffing
 * its own error text to tell a deliberate refusal from an incidental failure.
 */
async function readCurrentRound() {
  const roundNo = BigInt(arena.round_counter.toString());
  let account;
  try {
    account = await conn.getAccountInfo(roundPda(PROGRAM_ID, arenaPda, roundNo));
  } catch (e) {
    return { kind: "unknown", roundNo, why: `RPC error reading the round account: ${e.message}` };
  }
  // No account is not ambiguity: `close_round_account` reclaims a round's rent only after it has
  // settled, so a round PDA that does not exist is a round that is over. There is no lobby to warn
  // about and nothing is being guessed at.
  if (!account) return { kind: "closed", roundNo };
  const expected = roundAccountSize();
  if (account.data.length !== expected) {
    return { kind: "unknown", roundNo, why: `the round account is ${account.data.length} bytes and this tree's IDL describes ${expected} — run scripts/dump-round.mjs, which diagnoses exactly this` };
  }
  try {
    const round = decodeRound(account.data);
    return { kind: "open", roundNo, phase: round.phase, fighters: activeFighters(round) };
  } catch (e) {
    return { kind: "unknown", roundNo, why: `could not decode the round account: ${e.message}` };
  }
}

const current = await readCurrentRound();

if (current.kind === "closed") {
  console.log(`\nround #${current.roundNo} has been settled and its account closed — no lobby is open.`);
} else if (current.kind === "unknown") {
  // WARNS RATHER THAN REFUSES, and the asymmetry is reasoned rather than lazy. Refusing here would
  // block a legitimate rate change behind a stale IDL or one flaky read, and the harm it would be
  // preventing is small: `enter` is closed during Fight and Drawing, so a change that lands then
  // touches nobody already committed — the refusal below is a matter of principle and tidiness, not
  // of money. What is genuinely expensive is the OTHER check, and this line makes its absence
  // impossible to miss.
  console.warn(`\nWARNING: could not read round #${current.roundNo} from the chain — ${current.why}.`);
  console.warn("         NEITHER the Fight/Drawing refusal NOR the mid-lobby warning ran. You are");
  console.warn("         changing the rate with no idea what the current round is doing.");
} else {
  console.log(`\ncurrent round #${current.roundNo} is ${phaseName(current.phase)} — ${current.fighters.length} fighter(s)`);
  const phase = PHASE_NAMES[current.phase];

  if (phase === "Fight" || phase === "Drawing") {
    throw new Error(`refusing to change the rate during ${phase}: entrants are already committed. Run this between rounds.`);
  }

  if (phase === "Lobby") {
    // The roster is only fetched on the one path that needs it — a bare, read-only run of this
    // script exits long before here and never asks for a credential.
    const house = await fetchHouseWallets();
    if (house.available) {
      const { real } = splitFighters(current.fighters, house.wallets);
      if (real.length > 0) {
        console.warn(`WARNING: ${real.length} real player(s) already entered round #${current.roundNo} at ${pct(arena.fee_bps)}. ` +
          `They keep that rate; anyone entering after this lands pays ${pct(next)}.`);
      }
    } else if (current.fighters.length > 0) {
      // THE FAIL-CLOSED BRANCH. Without the roster this cannot tell a real player from one of the
      // arena's own, so it warns on ANY occupied lobby and says exactly why it is over-warning. An
      // operator who sees a warning about fighters that turn out to be ours has lost a few seconds;
      // an operator who sees nothing because the count could not be computed has lost the guard.
      console.warn(`WARNING: ${current.fighters.length} fighter(s) already entered round #${current.roundNo} at ${pct(arena.fee_bps)}. ` +
        `They keep that rate; anyone entering after this lands pays ${pct(next)}.`);
      console.warn(`         Could not tell real players from the arena's own (${house.reason}: ${house.message})`);
      console.warn(`         — so this warns on any occupied lobby. Some or all of those fighters may be ours.`);
      console.warn(`         fix: ${house.fix}`);
    }
  }
}

const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KEY_PATH, "utf8"))));
if (!authority.publicKey.equals(arena.authority)) {
  throw new Error(`${KEY_PATH} is ${authority.publicKey.toBase58()}, but the arena's authority is ${arena.authority.toBase58()}`);
}

const data = Buffer.concat([discriminator("set_fee_bps"), Buffer.from(Uint16Array.of(next).buffer)]);
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: arenaPda, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
  ],
  data,
});

console.log(`\nsending set_fee_bps ${arena.fee_bps} -> ${next} (${pct(arena.fee_bps)} -> ${pct(next)})`);
const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [authority], { commitment: "confirmed" });
console.log("signature", sig);

const after = decodeArena((await conn.getAccountInfo(arenaPda)).data);
console.log(`confirmed on chain: fee_bps = ${after.fee_bps} (${pct(after.fee_bps)})`);
if (after.fee_bps !== next) throw new Error("read-back disagrees with what was sent");
