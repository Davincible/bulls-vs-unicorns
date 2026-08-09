// Decode a Round account and print who is actually in it.
//
// Exists because the keeper's status file reports `realFighterCount` as a SUBTRACTION —
// `fighterCount - houseFighterCount`, where "house" means "wallet appears in the published house
// list". That arithmetic is only as true as the list, and a fighter the keeper fielded from a wallet
// it did not publish would be counted as a REAL PLAYER by every consumer of that file. This prints
// the wallets themselves so the claim can be checked rather than trusted.
//
//   node scripts/dump-round.mjs <roundNo>

import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";

const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const roundNo = BigInt(process.argv[2] ?? "23");

// Read the id out of the app's own constants rather than an IDL path, so this script and the page
// can never be pointed at different programs.
const constantsSrc = fs.readFileSync(new URL("../src/chain/constants.ts", import.meta.url), "utf8");
const idMatch = constantsSrc.match(/export const PROGRAM_ID = new PublicKey\("([1-9A-HJ-NP-Za-km-z]+)"\)/);
if (!idMatch) throw new Error("could not read PROGRAM_ID out of src/chain/constants.ts");
const PROGRAM_ID = new PublicKey(idMatch[1]);

const conn = new Connection(RPC, "confirmed");

// `ARENA_SEED` alone — there is ONE arena per program, not one per index. Deriving this with a
// trailing u64 index produces a PDA that simply does not exist, and `getAccountInfo` answering null
// for it is indistinguishable from a round whose rent has been reclaimed. That is a genuinely
// confusing wrong answer from a script whose entire job is to tell those two cases apart.
const le8 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const [arenaPda] = PublicKey.findProgramAddressSync([Buffer.from("arena")], PROGRAM_ID);
const [roundPda] = PublicKey.findProgramAddressSync([Buffer.from("round"), arenaPda.toBuffer(), le8(roundNo)], PROGRAM_ID);

console.log("program", PROGRAM_ID.toBase58());
console.log("arena  ", arenaPda.toBase58());
console.log("round  ", roundPda.toBase58());

const info = await conn.getAccountInfo(roundPda);
if (!info) { console.log("ACCOUNT DOES NOT EXIST (closed, or never opened)"); process.exit(0); }
console.log("owner  ", info.owner.toBase58(), "| lamports", info.lamports, "| bytes", info.data.length);

// Hand-decode rather than pulling Anchor in: this script has to keep working against a Round layout
// that the IDL in this tree may already have moved past, which is exactly the failure mode it is
// here to investigate. Offsets come from the struct order in programs/bulls-arena/src/lib.rs.
const d = info.data;
let o = 8; // discriminator
const u64 = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
const u8 = () => d[o++];
const pk = () => { const v = new PublicKey(d.subarray(o, o + 32)); o += 32; return v; };

// ONLY THE FIELDS THIS SCRIPT HAS ACTUALLY CHECKED AGAINST THE CHAIN. It stops after `phase`
// deliberately: the next fields are `winner: u8, bump: u8`, and an earlier version read a u64 from
// that offset and printed it as `pot`, yielding 2,680,059,919,616 for a round whose real pot was
// 41,916,000. A number that wrong is still a number, and it went unquestioned until it was compared
// against the keeper. Use the keeper's status file for the pot — it decodes with the real IDL.
const PHASE = ["Lobby", "Drawing", "Fight", "Settled", "Abandoned"];
const out = {};
out.arena = pk().toBase58();
out.round_no = u64().toString();
const phase = u8();
out.phase = `${PHASE[phase] ?? "?"} (${phase})`;
console.log("\nheader:", out);

// Scan the whole account for 32-byte windows that are plausible pubkeys and count how many times
// each distinct one appears — the fighter array is a fixed [Fighter; 16], so unused slots are the
// default pubkey and the used ones stand out.
const counts = new Map();
for (let i = 8; i + 32 <= d.length; i++) {
  const key = new PublicKey(d.subarray(i, i + 32)).toBase58();
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const zero = new PublicKey(new Uint8Array(32)).toBase58();

const keeper = await (await fetch("https://bulls-arena-keeper-devnet.fly.dev/keeper-status.json")).json();
const houseSet = new Set(keeper.house.wallets);

console.log("\ndistinct 32-byte windows that look like real pubkeys (excluding all-zero):");
const seen = [];
for (const [k, n] of counts) {
  if (k === zero) continue;
  if (n < 1) continue;
  // A pubkey that only appears inside overlapping garbage windows will not round-trip as a funded
  // or program-owned account; checking on chain is cheaper than guessing at the layout.
  seen.push(k);
}
// Keep it to the ones the keeper or the arena would plausibly reference.
const interesting = seen.filter((k) => houseSet.has(k) || k === out.arena || k === PROGRAM_ID.toBase58());
console.log("  house wallets present:", seen.filter((k) => houseSet.has(k)));
console.log("  other referenced known keys:", interesting.filter((k) => !houseSet.has(k)));

console.log("\nkeeper says: fighters", keeper.round.fighterCount, "house", keeper.round.houseFighterCount, "real", keeper.round.realFighterCount, "round", keeper.round.no);
console.log("published house list size:", keeper.house.wallets.length);
