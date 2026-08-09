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
import { BASE_RPC, PROGRAM_ID, ROUTER_URL } from "../src/chain/constants.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The Rust build artifact this preflight compares against when it is there. Gitignored, at the REPO
 *  ROOT, and produced by `anchor build` — so it exists on a developer's machine and cannot exist in a
 *  deployed container. See `referenceBytecode`. */
const LOCAL_SO_PATH = join(__dirname, "..", "..", "target", "deploy", "bulls_arena.so");

/** `BPFLoaderUpgradeable`'s ProgramData header: 4-byte enum discriminant, 8-byte slot, 1-byte
 *  `Option` tag, 32-byte upgrade authority. The ELF starts immediately after it. */
const PROGRAMDATA_HEADER = 45;

/** The header on an ER validator's LoaderV4 clone, before the ELF it copied. */
const LOADER_V4_HEADER = 48;

/**
 * THE BYTES THIS PREFLIGHT COMPARES A VALIDATOR'S CLONE AGAINST, from whichever source exists.
 *
 * WHY THERE ARE TWO SOURCES, AND WHY THE SECOND ONE HAD TO BE ADDED. This check used to read the local
 * `target/deploy/bulls_arena.so` unconditionally. That artifact is a Rust build output at the repo
 * root: gitignored, absent from a fresh checkout, and — the reason this changed — absent from any
 * container built from `er-demo/`. A deployed keeper therefore died at boot with
 * `ENOENT: /app/../target/deploy/bulls_arena.so`, before it opened a single round, on a file that
 * cannot be shipped and could not be reproduced in the image if it were. This was found by running
 * the keeper against a copy of exactly the file tree the Dockerfile builds, rather than by deploying.
 *
 * LOCAL FIRST, DELIBERATELY, so nothing changes for the people already relying on this. The two
 * sources answer subtly different questions and the local one is the stricter:
 *
 *   local `.so`      "is the validator serving what I just BUILT?" — which also catches a build that
 *                    was never deployed. That conflation is a feature on a developer's machine: right
 *                    after `anchor build && anchor deploy` is exactly when this trap fires.
 *   base layer       "is the validator serving what is actually DEPLOYED?" — the precise question this
 *                    preflight exists to ask, and the only one answerable everywhere. A deployment
 *                    does not build the program; it runs against a program id that was deployed long
 *                    before the image was.
 *
 * VERIFIED AGAINST REAL DEVNET RATHER THAN REASONED ABOUT, because the offsets below are the kind of
 * detail that looks right and is wrong. Program `D5S8oJ3s…`: the local artifact is 360,824 bytes; its
 * ProgramData account is 360,869 = 360,824 + 45, and `programdata[45..]` is byte-identical to the
 * artifact; all four ER validators the router advertises hold clones of 360,872 = 360,824 + 48 whose
 * `[48..]` is byte-identical to both. So the substitution is exact, not approximate.
 *
 * `subarray(PROGRAMDATA_HEADER)` deliberately keeps whatever trails the ELF. A program deployed with
 * `--max-len` headroom carries zero padding there, and the clone carries the same padding — the
 * existing comparison already slices the clone to the reference's length, so padding is compared
 * against padding and a shorter reference simply compares less. What must never happen is trimming
 * the reference by guessing where the ELF ends, which would silently weaken the check.
 */
async function referenceBytecode(baseRpcUrl: string): Promise<{ elf: Uint8Array; source: string }> {
  try {
    return { elf: new Uint8Array(readFileSync(LOCAL_SO_PATH)), source: "target/deploy/bulls_arena.so (local build)" };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }

  assertDevnetUrl(baseRpcUrl, "base devnet RPC");
  const base = new Connection(baseRpcUrl, "confirmed");
  const program = await base.getAccountInfo(PROGRAM_ID);
  if (!program) throw new Error(`${PROGRAM_ID.toBase58()} does not exist on the base layer — nothing is deployed there.`);
  // An upgradeable program account is 36 bytes: a 4-byte enum then the ProgramData address. Checked
  // rather than assumed, because a non-upgradeable (or LoaderV4) program would slice 32 arbitrary
  // bytes into a PublicKey and fail one call later with a message about a missing account.
  if (program.data.length !== 36) {
    throw new Error(
      `${PROGRAM_ID.toBase58()} is not a BPFLoaderUpgradeable program account (${program.data.length} bytes, ` +
      `expected 36), so its bytecode cannot be read from the base layer. Build the program locally so ` +
      `${LOCAL_SO_PATH} exists, or deploy it upgradeably.`,
    );
  }
  const programDataAddress = new PublicKey(program.data.subarray(4, 36));
  const programData = await base.getAccountInfo(programDataAddress);
  if (!programData || programData.data.length <= PROGRAMDATA_HEADER) {
    throw new Error(`the ProgramData account ${programDataAddress.toBase58()} is missing or empty — nothing is deployed.`);
  }
  return {
    elf: new Uint8Array(programData.data.subarray(PROGRAMDATA_HEADER)),
    source: `the deployed program on the base layer (${programDataAddress.toBase58().slice(0, 8)}…)`,
  };
}

export interface ErValidator {
  identity: PublicKey;
  fqdn: string;
}

/** The router's OWN list of ER validators, rather than a hardcoded one. Asking is both more honest and
 *  strictly better informed — it turned up `devnet-tee` alongside the three endpoints this repo's
 *  scripts had been assuming, and that mattered: the search below has to cover every validator before
 *  it can conclude that a fresh program id is the only way forward. */
export async function routerValidators(
  /** Which router to ask. Defaults to the hardcoded one; the keeper passes whatever
   *  `KEEPER_ROUTER_URL` resolved to, because a variable that exists and is silently ignored by one
   *  of its two consumers is worse than one that does not exist. */
  routerUrl: string = ROUTER_URL,
): Promise<ErValidator[]> {
  assertDevnetUrl(routerUrl, "Magic Router");
  const res = await fetch(routerUrl, {
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
export async function pickValidator(
  pinned: PublicKey | null,
  /** Where to read the deployed bytecode from when there is no local build artifact — see
   *  `referenceBytecode`. Passed by the caller rather than resolved here so this shared module does
   *  not acquire an opinion about the keeper's environment variables; the keeper hands it the endpoint
   *  it is actually using, and the verification scripts get the public default they already assume. */
  baseRpcUrl: string = BASE_RPC,
  /** Which router to ask for the validator list — see `routerValidators`. */
  routerUrl: string = ROUTER_URL,
): Promise<ErValidator | null> {
  const { elf: localElf, source } = await referenceBytecode(baseRpcUrl);
  console.log(`  \x1b[2mreference build ${localElf.length} B (${source})\x1b[0m`);

  const fresh: ErValidator[] = [];
  for (const { identity, fqdn } of await routerValidators(routerUrl)) {
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
        // "the reference", not "the local build": since the reference can now come from the base layer
        // in an environment with no build artifact, naming it "local" would be a line that is simply
        // untrue on every deployment — and this line is the evidence an operator reads to decide
        // whether a confusing round failure was a cache problem.
        state = usable ? "CURRENT — byte-identical to the reference" : "STALE — serving a different build";
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
