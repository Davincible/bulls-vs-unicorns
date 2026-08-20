#!/usr/bin/env bun
// WHAT BYTECODE EACH ER VALIDATOR IS SERVING FOR OUR PROGRAM, compared against the BASE LAYER rather
// than against a local build artifact.
//
//   cd er-demo && bun run scripts/er-bytecode-probe.ts
//
// WHY NOT `erValidator.ts`'s OWN CHECK. That one compares each validator's clone against
// `target/deploy/bulls_arena.so`, the local `anchor build` output, and it is right to for its purpose
// (a preflight before spending a round). But COST-MODEL.md §7 records it producing a FALSE POSITIVE
// exactly once: four validators reported STALE when the validators were fine and the PROBE was wrong,
// because a Rust build is not byte-reproducible across differing toolchains, so "local .so != clone"
// answered a question nobody asked.
//
// This probe compares the clone against `solana program dump` of the deployed program — two things
// that came off the same chain, so a difference is a real difference. It needs no build artifact,
// which also means it works on a machine that has never run `anchor build`.
//
// WHAT IT IS FOR. MagicBlock's ER validators cache program bytecode BY PROGRAM ID and do not
// invalidate on upgrade (ARENA-VAULT.md §3.1; MAGICBLOCK_FEEDBACK.md has four entries). The
// documented workaround for shipping a fix is a NEW PROGRAM ID. That claim is load-bearing for two
// separate decisions — whether the pending program bundle can ship as an in-place upgrade, and
// whether ARENA-VAULT.md's E1 can manufacture a dead delegation on demand — and until now nothing in
// this repo could observe it directly. Run this immediately before and immediately after an upgrade;
// the diff between the two runs is the answer.

import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { routerValidators } from "./erValidator.ts";
import { BASE_RPC, PROGRAM_ID, ROUTER_URL } from "../src/chain/constants.ts";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 16);

/** The executable bytes, not the account bytes. A BPF-upgradeable program's `ProgramData` account is
 *  a 45-byte header followed by the ELF, and it is right-padded with zeros to whatever length was
 *  allocated at deploy — so comparing whole accounts reports a difference on padding alone. Trailing
 *  zeros are trimmed for the same reason. */
function executableBytes(data: Uint8Array): Uint8Array {
  const HEADER = 45;
  let end = data.length;
  while (end > HEADER && data[end - 1] === 0) end -= 1;
  return data.subarray(HEADER, end);
}

const base = new Connection(BASE_RPC, "confirmed");
const programId = new PublicKey(PROGRAM_ID);

// The base layer's copy, via the ProgramData account the loader actually executes from.
const [programDataAddr] = PublicKey.findProgramAddressSync(
  [programId.toBytes()],
  new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
);
const pd = await base.getAccountInfo(programDataAddr);
if (!pd) throw new Error(`no ProgramData account at ${programDataAddr.toBase58()}`);
const truth = executableBytes(pd.data);

console.log(`program        ${programId.toBase58()}`);
console.log(`ProgramData    ${programDataAddr.toBase58()}`);
console.log(`BASE LAYER     ${sha(truth)}  (${truth.length} bytes of ELF)\n`);

const validators = await routerValidators(ROUTER_URL);
console.log(`${validators.length} validator(s) on the router\n`);

let fresh = 0;
let stale = 0;
let absent = 0;

for (const v of validators) {
  // Each validator serves its own clone of the program account at the SAME address. Reading it
  // through the validator's own fqdn rather than the router is deliberate: the router picks a route
  // per account, so asking it would answer for whichever validator it chose rather than for this one.
  const conn = new Connection(v.fqdn, "confirmed");
  let verdict: string;
  try {
    const clonePd = await conn.getAccountInfo(programDataAddr);
    if (!clonePd) {
      verdict = "NOT CLONED — this validator has never been asked for the program";
      absent += 1;
    } else {
      const clone = executableBytes(clonePd.data);
      if (sha(clone) === sha(truth)) {
        verdict = `FRESH  ${sha(clone)}`;
        fresh += 1;
      } else {
        verdict = `STALE  ${sha(clone)}  (${clone.length} bytes) <- serving different bytecode`;
        stale += 1;
      }
    }
  } catch (e) {
    verdict = `unreachable: ${(e as Error).message.slice(0, 70)}`;
  }
  console.log(`${v.fqdn}\n  ${verdict}`);
}

console.log(`\nfresh ${fresh} · stale ${stale} · not-cloned ${absent}`);
if (stale > 0) {
  console.log(
    "\nSTALE VALIDATORS CONFIRM THE CACHE TRAP: an in-place upgrade does NOT reach the rollup, so a\n" +
    "program change ships only behind a new program id.\n" +
    "\n" +
    "WHAT THIS DOES *NOT* MEAN, corrected 2026-08-20. This line used to end \"and a round delegated to\n" +
    "a stale validator is exactly ARENA-VAULT.md §5.1's unsettleable round\". THAT IS FALSE AND THIS\n" +
    "SCRIPT DISPROVED IT: on 2026-08-17 all four validators went stale and the arena kept running —\n" +
    "round 743 fought 39 fighters, settled, swept and closed. A stale clone is a COMPLETE, previously\n" +
    "working build; it wedges only if it disagrees with the account about LAYOUT, or lacks an\n" +
    "instruction the round needs, or its owner program cannot execute on the base layer. An upgrade\n" +
    "that changes behaviour inside a fixed layout satisfies none of those — which is a safety property\n" +
    "worth knowing: an accidental in-place upgrade does not strand rounds. See ARENA-VAULT.md §7 E1.",
  );
}
