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

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import fs from "node:fs";

const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const KEEPER_STATUS = process.env.KEEPER_STATUS_URL || "https://bulls-arena-keeper-devnet.fly.dev/keeper-status.json";
const KEY_PATH = process.env.ARENA_AUTHORITY_KEY || new URL("../../.devnet/fork-payer.json", import.meta.url).pathname;

/** Mirrors `MAX_FEE_BPS` in programs/bulls-arena/src/lib.rs. Checked here too so a typo fails before
 *  it costs a transaction, not because this side is authoritative — the program is. */
const MAX_FEE_BPS = 1_000;

const constantsSrc = fs.readFileSync(new URL("../src/chain/constants.ts", import.meta.url), "utf8");
const PROGRAM_ID = new PublicKey(constantsSrc.match(/export const PROGRAM_ID = new PublicKey\("([1-9A-HJ-NP-Za-km-z]+)"\)/)[1]);
const [arenaPda] = PublicKey.findProgramAddressSync([Buffer.from("arena")], PROGRAM_ID);

const conn = new Connection(RPC, "confirmed");

/** Anchor's instruction discriminator: the first 8 bytes of sha256("global:<snake_case_name>"). */
const discriminator = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

function readArena(data) {
  // Arena { authority: Pubkey, token_a: Pubkey, token_b: Pubkey, round_counter: u64, fee_bps: u16, bump: u8 }
  let o = 8;
  const pk = () => { const v = new PublicKey(data.subarray(o, o + 32)); o += 32; return v; };
  const authority = pk(); const tokenA = pk(); const tokenB = pk();
  const roundCounter = data.readBigUInt64LE(o); o += 8;
  const feeBps = data.readUInt16LE(o); o += 2;
  return { authority, tokenA, tokenB, roundCounter, feeBps, bump: data[o] };
}

const info = await conn.getAccountInfo(arenaPda);
if (!info) throw new Error(`arena ${arenaPda.toBase58()} does not exist under program ${PROGRAM_ID.toBase58()}`);
const arena = readArena(info.data);

const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
console.log("program  ", PROGRAM_ID.toBase58());
console.log("arena    ", arenaPda.toBase58());
console.log("authority", arena.authority.toBase58());
console.log("rounds   ", arena.roundCounter.toString());
console.log("fee_bps  ", arena.feeBps, `(${pct(arena.feeBps)})`);

const arg = process.argv[2];
if (arg === undefined) { console.log("\n(read-only — pass a bps value to change it)"); process.exit(0); }

const next = Number(arg);
if (!Number.isInteger(next) || next < 0 || next > MAX_FEE_BPS) {
  throw new Error(`fee must be a whole number of basis points between 0 and ${MAX_FEE_BPS} (got ${arg})`);
}
if (next === arena.feeBps) { console.log(`\nalready ${next} bps — nothing to do`); process.exit(0); }

// The mid-lobby guard. Best-effort: the keeper's status file is the cheapest view of the current
// round, and if it cannot be reached that is a reason to say so, not a reason to pretend the round
// is idle.
try {
  const s = await (await fetch(KEEPER_STATUS)).json();
  const r = s.round ?? {};
  console.log(`\ncurrent round #${r.no} is ${r.phase} — ${r.fighterCount} fighter(s), ${r.realFighterCount} real`);
  if (r.phase === "Fight" || r.phase === "Drawing") {
    throw new Error(`refusing to change the rate during ${r.phase}: entrants are already committed. Run this between rounds.`);
  }
  if (r.phase === "Lobby" && (r.realFighterCount ?? 0) > 0) {
    console.warn(`WARNING: ${r.realFighterCount} real player(s) already entered round #${r.no} at ${pct(arena.feeBps)}. ` +
      `They keep that rate; anyone entering after this lands pays ${pct(next)}.`);
  }
} catch (e) {
  if (String(e.message).startsWith("refusing")) throw e;
  console.warn(`could not read the keeper status (${e.message}) — proceeding without the mid-lobby check`);
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

console.log(`\nsending set_fee_bps ${arena.feeBps} -> ${next} (${pct(arena.feeBps)} -> ${pct(next)})`);
const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [authority], { commitment: "confirmed" });
console.log("signature", sig);

const after = readArena((await conn.getAccountInfo(arenaPda)).data);
console.log(`confirmed on chain: fee_bps = ${after.feeBps} (${pct(after.feeBps)})`);
if (after.feeBps !== next) throw new Error("read-back disagrees with what was sent");
