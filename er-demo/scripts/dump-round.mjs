// Decode a Round account and print who is actually in it — and, now, WORK OUT THE SPLIT ITSELF.
//
// This script existed to check the keeper's arithmetic against the chain. The keeper published
// `realFighterCount` as a SUBTRACTION — `fighterCount - houseFighterCount`, where "house" meant
// "wallet appears in the published list" — and that arithmetic was only ever as true as the list, so
// a fighter seated from a wallet the keeper had not published would read as a real player to every
// consumer of that file.
//
// AS OF `KEEPER_STATUS_SCHEMA` 5 THERE IS NO PUBLISHED CLAIM LEFT TO CHECK. The arena's own wallets
// are internal by an owner's decision (see `houseList.mjs`), so the status file carries
// `fighterCount` and nothing about who those fighters are. The purpose of this script survives that
// change and is actually improved by it: it stops being a second opinion about somebody else's
// subtraction and becomes THE computation — the round account for the fighters, the keeper's
// authenticated roster for the classification, the arithmetic done here in front of you.
//
// It needs a credential for that, which an operator script did not used to. `houseList.mjs` carries
// the argument. What matters at this end is that WANTING THE CREDENTIAL IS NEVER A CRASH: without it
// this prints the header, the phase, the pot and every fighter pubkey it found, and says in one line
// that it could not split them and how to fix that. The version this replaced did `new
// Set(keeper.house.wallets)` on a field that no longer exists, which under schema 5 is
// `new Set(undefined)` — a TypeError, at the top of the script, on a tool somebody reaches for
// precisely when something is already wrong.
//
// TWO THINGS THAT WERE HERE ARE GONE, and they are worth naming so nobody puts them back believing
// they were lost by accident. The HAND-WRITTEN OFFSETS moved to `roundAccount.mjs` and became
// Anchor's own coder reading this tree's IDL — the file carries the story of the pot that was wrong
// by five orders of magnitude, which is the whole reason. And the 32-BYTE WINDOW SCAN, which walked
// the account looking for anything that might be a pubkey, is deleted rather than kept as a fallback:
// it existed only because the layout was unknown, it counted overlapping garbage as candidates, and
// it could say nothing about seat order or `fighter_count`. What replaced it as the mismatch
// diagnostic decides something instead of hinting — see the layout check below.
//
//   node scripts/dump-round.mjs            # the newest round (the arena's own round_counter)
//   node scripts/dump-round.mjs 23         # a specific round number

import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  activeFighters,
  arenaPda,
  decodeArena,
  decodeRound,
  phaseName,
  PHASE_NAMES,
  programId,
  roundAccountSize,
  roundDiscriminator,
  roundPda,
  splitFighters,
} from "./roundAccount.mjs";
import { fetchHouseWallets } from "./houseList.mjs";

const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");

const sol = (lamports) => `${lamports} lamports (${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL)`;

const PROGRAM_ID = programId();
const arena = arenaPda(PROGRAM_ID);

console.log("program", PROGRAM_ID.toBase58());
console.log("arena  ", arena.toBase58());

// THE DEFAULT IS THE ARENA'S OWN COUNTER, not a number baked in during some past debugging session.
// This file used to default to round 23, which was true for about an afternoon; every run after that
// dumped a long-settled round while its operator read the output as "now". `round_counter` is the
// last round the program opened, which is the round anybody typing this command without an argument
// means.
const arenaInfo = await conn.getAccountInfo(arena);
if (!arenaInfo) throw new Error(`arena ${arena.toBase58()} does not exist under program ${PROGRAM_ID.toBase58()}`);
const roundNo = process.argv[2] !== undefined ? BigInt(process.argv[2]) : BigInt(decodeArena(arenaInfo.data).round_counter.toString());

const round = roundPda(PROGRAM_ID, arena, roundNo);
console.log("round  ", round.toBase58(), `(#${roundNo})`);

const info = await conn.getAccountInfo(round);
if (!info) {
  console.log("\nACCOUNT DOES NOT EXIST — never opened, or closed and its rent reclaimed by close_round_account.");
  process.exit(0);
}
console.log("owner  ", info.owner.toBase58(), "| lamports", info.lamports, "| bytes", info.data.length);

// ---------------------------------------------------------------------------------------------
// THE LAYOUT CHECK, BEFORE ANY FIELD IS BELIEVED.
//
// `roundAccountSize()` is what `public/idl/bulls_arena.json` says a Round is; `info.data.length` is
// what the deployed program actually wrote. When they agree, the IDL and the chain describe the same
// struct and everything below is exact. When they disagree, this tree's IDL has moved ahead of (or
// behind) the deployed program — which is the very failure this script is meant to investigate — and
// decoding anyway would print a table of confident, wrong numbers. So it does not decode. It reports
// the two sizes, and then answers the question that actually decides what to do next: does the
// account's discriminator say this is a `Round` at all?
const expected = roundAccountSize();
if (info.data.length !== expected) {
  const disc = roundDiscriminator();
  const isRound = info.data.subarray(0, 8).equals(disc);
  console.log(`\nLAYOUT MISMATCH: the IDL in this tree describes ${expected} bytes, the chain holds ${info.data.length}.`);
  console.log("Not decoding. A field-by-field read against the wrong layout is how this script once");
  console.log("reported a pot of 2,680,059,919,616 for a round whose pot was 41,916,000 — a number");
  console.log("wrong by five orders of magnitude is still a number, and it went unquestioned for days.");
  if (isRound) {
    console.log("\nThe discriminator DOES match Round, so this really is a round account and it is this");
    console.log("tree's IDL that has drifted from the deployed program. Rebuild public/idl/bulls_arena.json");
    console.log("from the program that is actually deployed (or deploy the program this tree describes).");
  } else {
    console.log(`\nThe discriminator does NOT match Round (${info.data.subarray(0, 8).toString("hex")} vs ${disc.toString("hex")}),`);
    console.log("so the size was never the interesting fact: this account is not a Round at all. Check");
    console.log("PROGRAM_ID in src/chain/constants.ts and the seeds above before touching the IDL.");
  }
  process.exit(1);
}

const r = decodeRound(info.data);
console.log("\nheader:");
console.log("  arena         ", r.arena.toBase58(), r.arena.equals(arena) ? "(matches)" : "(DOES NOT MATCH the arena PDA above)");
console.log("  round_no      ", r.round_no.toString());
console.log("  phase         ", phaseName(r.phase));
console.log("  fighter_count ", r.fighter_count);
console.log("  pot           ", sol(r.pot.toString()), "— NET of the entry fee; players were charged pot + fees_collected");
console.log("  fees_collected", sol(r.fees_collected.toString()));
console.log("  penalties     ", sol(r.penalties_collected.toString()), "— extract penalties, cumulative");
console.log("  tick_count    ", r.tick_count.toString());
console.log("  house_swept   ", r.house_swept);
// `winner` is zero from the moment the round opens and only means anything once `settle_sides` has
// run, so printing it unconditionally would show "side 0 won" for every live lobby on screen.
if (PHASE_NAMES[r.phase] === "Settled") {
  console.log("  winner        ", `side ${r.winner}`, "(0 = token_a, 1 = token_b — the display names are the tokens', never hardcoded)");
}

// ---------------------------------------------------------------------------------------------
// THE SPLIT.
const fighters = activeFighters(r);
const house = await fetchHouseWallets();

if (house.available) {
  const { house: houseFighters, real } = splitFighters(fighters, house.wallets);
  console.log(`\nfighters: ${fighters.length} — ${real.length} real, ${houseFighters.length} the arena's own`);
  console.log(`(roster: ${house.count} wallet(s) from ${house.url})`);
  for (const [label, group] of [["real ", real], ["house", houseFighters]]) {
    for (const f of group) {
      console.log(`  ${label} ${f.wallet.toBase58()}  side ${f.side}  stake ${f.stake.toString()}  hp ${f.hp.toString()}  banked ${f.banked.toString()}${f.dead ? "  DEAD/EXTRACTED" : ""}`);
    }
  }
  // The program's own conservation identity, checked here because this script is already holding
  // every term of it. `extract` moves value out of the round, so `sum(hp + banked)` alone stopped
  // being equal to `pot` — `penalties_collected` is the term that closes it, and a mismatch here is
  // a real finding rather than a rounding artefact.
  const held = fighters.reduce((acc, f) => acc + BigInt(f.hp.toString()) + BigInt(f.banked.toString()), 0n);
  const closes = held + BigInt(r.penalties_collected.toString());
  const pot = BigInt(r.pot.toString());
  console.log(`\nconservation: sum(hp + banked) ${held} + penalties ${r.penalties_collected.toString()} = ${closes} vs pot ${pot} — ${closes === pot ? "EXACT" : "MISMATCH"}`);
} else {
  console.log(`\nfighters: ${fighters.length} — SPLIT NOT COMPUTED (${house.reason})`);
  console.log(`  ${house.message}`);
  console.log(`  fix: ${house.fix}`);
  console.log("  Everything else on this page is read from the chain and is unaffected; the only thing");
  console.log("  missing is which of the wallets below are the arena's own.");
  for (const f of fighters) {
    console.log(`  ? ${f.wallet.toBase58()}  side ${f.side}  stake ${f.stake.toString()}  hp ${f.hp.toString()}  banked ${f.banked.toString()}${f.dead ? "  DEAD/EXTRACTED" : ""}`);
  }
}
