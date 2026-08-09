// Which ER validators are serving the CURRENT build of our program — the one-second preflight that
// turns MagicBlock's documented bytecode-cache trap into a clear message instead of a spent round.
//
// Extracted from verify-stepped-fight.ts when a second verification script needed the same check.
// Deliberately shared rather than copied: the whole value of this preflight is that it encodes a
// correction we had to learn twice (see `pickValidator` below), and a second copy is a second place
// for that correction to rot.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { assertDevnetUrl } from "../src/devnet-guard.ts";
import { PROGRAM_ID, ROUTER_URL } from "../src/chain/constants.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ErValidator {
  identity: PublicKey;
  fqdn: string;
}

/** The router's OWN list of ER validators, rather than a hardcoded one. Asking is both more honest and
 *  strictly better informed — it turned up `devnet-tee` alongside the three endpoints this repo's
 *  scripts had been assuming, and that mattered: the search below has to cover every validator before
 *  it can conclude that a fresh program id is the only way forward. */
export async function routerValidators(): Promise<ErValidator[]> {
  const res = await fetch(ROUTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getRoutes", params: [] }),
  });
  const body = await res.json() as { result?: { identity: string; fqdn: string }[]; error?: { message: string } };
  if (!body.result) throw new Error(`getRoutes: ${body.error?.message ?? "no result"}`);
  return body.result.map((r) => ({ identity: new PublicKey(r.identity), fqdn: r.fqdn }));
}

/** THE PREFLIGHT THAT TURNS A DOCUMENTED TRAP INTO A ONE-SECOND CHECK.
 *
 *  MagicBlock's ER validators clone a program's executable into their own LoaderV4-owned account on
 *  first use and do NOT re-clone it when the base-layer program is upgraded (MAGICBLOCK_FEEDBACK.md;
 *  MEGA_QUEUE.md task #15, where this cost a whole round and a very confusing failure). So right
 *  after a deploy, a round delegated to whichever validator the router happens to pick may run the
 *  PREVIOUS build — and the symptom is an error about the code you are testing, not about the cache.
 *
 *  It is directly observable, though: read the clone and compare its bytes against the local artifact.
 *
 *  The obvious cheap version of this check — compare LENGTHS — is wrong, and worth recording because
 *  it looked right and produced a confident answer. A LoaderV4 clone is 48 bytes of header plus the
 *  program data account's whole allocation, so its length tracks the deploy's `--max-len`, not the
 *  ELF inside it. Two different builds deployed under the same `max_len` measure identically. What
 *  the length DID reveal, correctly, was a clone frozen at a `max_len` the base layer had since grown
 *  past — genuinely stale, but only visible because that particular upgrade happened to extend the
 *  account. Comparing the bytes answers the actual question in every case. */
export async function pickValidator(pinned: PublicKey | null): Promise<ErValidator | null> {
  const soPath = join(__dirname, "..", "..", "target", "deploy", "bulls_arena.so");
  const localElf = new Uint8Array(readFileSync(soPath));
  const LOADER_V4_HEADER = 48;
  console.log(`  \x1b[2mlocal build ${localElf.length} B (${soPath.replace(/.*\/target/, "target")})\x1b[0m`);

  const fresh: ErValidator[] = [];
  for (const { identity, fqdn } of await routerValidators()) {
    assertDevnetUrl(fqdn, "ER validator");
    try {
      const acct = await new Connection(fqdn, "confirmed").getAccountInfo(PROGRAM_ID);
      let state: string;
      let usable: boolean;
      if (!acct) {
        state = "no clone yet — will pull the current build on first use";
        usable = true;
      } else {
        const cloned = acct.data.subarray(LOADER_V4_HEADER, LOADER_V4_HEADER + localElf.length);
        usable = cloned.length === localElf.length && Buffer.from(cloned).equals(Buffer.from(localElf));
        state = usable ? "CURRENT — byte-identical to the local build" : "STALE — serving a different build";
      }
      console.log(`    ${fqdn.padEnd(38)} ${identity.toBase58().slice(0, 8)}…  ${state}`);
      if (usable) fresh.push({ identity, fqdn });
    } catch (e) {
      console.log(`    ${fqdn.padEnd(38)} unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (pinned) {
    const match = fresh.find((v) => v.identity.equals(pinned));
    if (!match) throw new Error(`--validator ${pinned.toBase58()} is not among the validators serving the current build`);
    return match;
  }
  return fresh[0] ?? null;
}

/** The message worth printing when `pickValidator` finds nothing — the recovery is expensive and
 *  specific, so it is spelled out rather than left as "no validator available". */
export const NO_FRESH_VALIDATOR =
  "every public ER validator is still serving a PREVIOUS build of this program id.\n" +
  "  Their bytecode cache is keyed by program id and is not refreshed by an upgrade, so there is\n" +
  "  no route on which a delegated round can run the code under test. The documented recovery is\n" +
  "  to deploy under a FRESH program id (see lib.rs's declare_id! note and MEGA_QUEUE.md #15).";
