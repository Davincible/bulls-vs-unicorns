// EVERY REASON THIS EXPERIMENT COULD FAIL TO BE AN EXPERIMENT, CHECKED BEFORE IT STARTS.
//
// `ARENA-VAULT.md` §0.1 lists G1 — "the rescue path is exercised against a genuinely unsettleable
// round, not reasoned about, run" — as the gate that holds up the whole custody programme, and it
// has the status "never attempted by anyone". A test standing in front of a gate like that has one
// failure mode worse than being red: being GREEN for a reason unrelated to the thing it claims to
// have measured. This repo has the receipt. `tsconfig.json`'s own header records `npx tsc --noEmit`
// reported as clean three times in one session, in commit messages, over a tree it had never read a
// single file of — a green result that meant nothing, produced by a gate that had quietly switched
// itself off.
//
// So there is no `it.skipIf`, no `describe.runIf`, no "ephemeral-validator not found, skipping" in
// this directory. Every one of those reads as a pass in CI. Everything below THROWS, and every throw
// names the exact command that fixes it. The worst outcome available to a run of `npm run
// test:wedge` is a red suite with an actionable message; "wedge produced ✓" is reachable only by
// producing a wedge.
//
// The rejected alternative, stated because it is the tempting one: make the suite skip when the
// toolchain is absent, so CI stays green on machines without a Solana install. That is how a test
// becomes decorative. §7 is explicit that "G1 SHOULD NOT BE AN EXPERIMENT. IT SHOULD BE A TEST" and
// that "M1 is cheap enough for CI" — a CI that runs it on zero machines has satisfied the letter of
// that and none of it. If this suite cannot run somewhere, the answer is to install the two binaries
// (both are one command) or to not schedule the suite there, not to teach it to lie.

import { accessSync, constants as fsConstants, existsSync, openSync, readSync, closeSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PROGRAM_ID } from "../src/chain/constants.ts";

/** A precondition that is not met. Distinct from an assertion failure on purpose: this class means
 *  "the experiment did not run", which is a different report from "the experiment ran and the wedge
 *  did not form". Conflating those two is how §10's `unverified` rows get marked settled by mistake. */
export class MissingPrecondition extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "MissingPrecondition";
  }
}

/** Everything the harness needs, resolved to absolute paths and verified to exist. */
export interface Toolchain {
  /** MagicBlock's own base-layer wrapper — `solana-test-validator` plus their genesis dumps. */
  readonly mbTestValidator: string;
  /** The rollup binary under test. */
  readonly ephemeralValidator: string;
  /** `.../@magicblock-labs/ephemeral-validator/bin/local-dumps` — the shipped genesis fixtures. */
  readonly localDumpsDir: string;
  /** `target/deploy/bulls_arena.so`, verified fresh against `lib.rs`. */
  readonly programSo: string;
  /** The committed IDL, parsed. */
  readonly idl: WedgeIdl;
  /** The program id the wedge is produced on — from the IDL, cross-checked against the app's. */
  readonly programId: PublicKey;
}

/** The slice of the IDL this harness reads. Anchor's own `Idl` type is imported where a `Program` is
 *  constructed; here we only need to interrogate the file, and naming the two fields we actually
 *  look at is more honest than pretending to validate the whole schema. */
export interface WedgeIdl {
  address: string;
  instructions: { name: string }[];
  [key: string]: unknown;
}

const HERE = import.meta.dirname;
/** `er-demo/wedge` -> `er-demo` -> repo root. */
const REPO_ROOT = resolve(HERE, "..", "..");
const ER_DEMO = resolve(HERE, "..");

const PROGRAM_SO = join(REPO_ROOT, "target", "deploy", "bulls_arena.so");
const LIB_RS = join(REPO_ROOT, "programs", "bulls-arena", "src", "lib.rs");
const IDL_PATH = join(ER_DEMO, "public", "idl", "bulls_arena.json");

/** The instructions `g1.wedge.ts` actually drives. Checked up front so a renamed handler is a clear
 *  "the IDL has no `delegate_round`" rather than an Anchor `TypeError: not a function` sixty seconds
 *  into a run that has already booted two validators. */
const REQUIRED_INSTRUCTIONS = [
  "init_arena",
  "init_treasury",
  "open_round",
  "delegate_round",
  "enter",
  "tick",
  "resolve",
  "abandon_round",
  "close_round",
  "close_round_account",
  "process_undelegation",
] as const;

const INSTALL_EPHEMERAL_VALIDATOR = "npm install -g @magicblock-labs/ephemeral-validator@latest";

/** Locate an executable on `PATH` without a shell.
 *
 *  `spawnSync("which", ...)` would be shorter and is deliberately not used: it inherits whatever
 *  shell and profile the developer has, and this project's shell is `fish`, where `which` is a
 *  builtin with different semantics from the POSIX one. Walking `PATH` is what
 *  `@magicblock-labs/ephemeral-validator`'s own `ephemeralValidator.js` does to find its sibling
 *  binary, so the harness and the tool it drives agree on what "installed" means. */
function whichBinary(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not here; keep walking. An unreadable PATH entry is not an error worth reporting.
    }
  }
  return null;
}

function requireBinary(name: string, why: string, install: string): string {
  const found = whichBinary(name);
  if (!found) {
    throw new MissingPrecondition(
      `\`${name}\` is not on PATH.\n` + `  needed for: ${why}\n` + `  install:    ${install}`,
    );
  }
  return found;
}

/**
 * Find the genesis fixtures MagicBlock ships inside the npm package.
 *
 * THIS IS THE FINDING THAT MAKES E1-M1 TRULY OFFLINE, and it is worth stating because §7's own
 * recipe does not know it. Step 1 there reads "solana-test-validator, cloning
 * DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh" — i.e. fetch the delegation program FROM DEVNET.
 * That is a read-only fetch and it would probably be harmless, but `wedge/`'s whole safety argument
 * is that it never opens a socket to the cluster the live arena runs on, and "we only READ devnet"
 * is a weaker sentence than "we never contact devnet". It turns out we do not have to:
 * `@magicblock-labs/ephemeral-validator` ships `bin/local-dumps/DELeGG….so` (459,416 bytes) plus the
 * VRF, permission, ephemeral-SPL and keyspace programs and thirteen genesis accounts, and its own
 * `mb-test-validator` wrapper loads exactly those. So the delegation program arrives with the
 * validator, `--clone`/`--url` never appear, and this harness has no devnet endpoint to guard.
 *
 * Resolution goes through `realpathSync` of the wrapper scripts rather than `require.resolve`,
 * because the package is installed GLOBALLY (`npm install -g`) and is therefore not in `er-demo`'s
 * `node_modules` — Node's resolver cannot see it from here at all. The wrappers are symlinks from
 * the bin directory into the package, so their real path IS the package root.
 */
function findLocalDumps(binaries: string[]): string {
  const tried: string[] = [];
  for (const bin of binaries) {
    let packageRoot: string;
    try {
      packageRoot = dirname(realpathSync(bin));
    } catch {
      continue;
    }
    const dumps = join(packageRoot, "bin", "local-dumps");
    tried.push(dumps);
    if (existsSync(join(dumps, `${DELEGATION_PROGRAM_ID.toBase58()}.so`))) return dumps;
  }
  throw new MissingPrecondition(
    `the delegation program's local dump was not found.\n` +
      `  looked for: <package>/bin/local-dumps/${DELEGATION_PROGRAM_ID.toBase58()}.so\n` +
      `  tried:      ${tried.join("\n              ") || "(no resolvable wrapper on PATH)"}\n` +
      `  install:    ${INSTALL_EPHEMERAL_VALIDATOR}\n` +
      `Without the delegation program on the base layer there is no delegation, and therefore no ` +
      `wedge to measure. This harness will NOT fall back to cloning it from devnet.`,
  );
}

/**
 * The compiled program, verified present, plausible and NOT STALE.
 *
 * TAKES ITS PATHS AS ARGUMENTS SO IT CAN BE TESTED, which is not a stylistic preference here. This
 * is the staleness gate, and the specific failure this whole directory is written against is a gate
 * that stops firing without anybody noticing. A gate reachable only by running the ninety-second
 * suite on a machine with a Solana toolchain is a gate almost nothing exercises; injecting the two
 * paths lets `preconditions.test.ts` drive all four of its branches — absent, truncated, stale,
 * fresh — against temp files in the suite that runs on every commit. The wrapper below binds it to
 * the real artifact.
 *
 * WHY THIS REFUSES RATHER THAN BUILDS, which is the decision a reader will want argued. Running
 * `cargo-build-sbf` from inside a test would make the suite self-sufficient, and that is genuinely
 * attractive. It is rejected for two reasons, in order of weight:
 *
 *   1. `target/deploy/` is SHARED MUTABLE STATE. `anchor build`, the docker verify path in
 *      `docker/`, and anyone else's in-flight work all write there. A test that rebuilds it can
 *      invalidate an artifact another process is mid-way through using, and it would do so as a side
 *      effect of a command whose name promises only to measure something. A test may read the world;
 *      it should be very reluctant to reshape it.
 *   2. A build is minutes and a wedge run is ninety seconds. Folding the slow, occasionally-failing
 *      step into the fast, load-bearing one means the fast one inherits the slow one's failure modes
 *      and its flakiness budget, and "the wedge test is slow and sometimes red" is how a suite stops
 *      being run.
 *
 * The freshness comparison is mtime against `lib.rs`, which is coarse and deliberately so: it has no
 * false positives (a `.so` newer than the source it was built from is the normal, correct state) and
 * its one false negative — editing `lib.rs`, rebuilding, then touching `lib.rs` again — leaves the
 * artifact newer anyway. It answers the question that actually goes wrong in practice, which is
 * "somebody changed the program and forgot to rebuild".
 *
 * A STRONGER GATE WAS CONSIDERED AND MEASURED AND REJECTED: comparing the committed IDL against
 * `target/idl/bulls_arena.json` (the IDL emitted by the same build as the `.so`), so that a program
 * whose *shape* has drifted from the IDL we drive it with is caught structurally. As of 2026-08-20
 * those two files disagree — `target/idl` presents `Round` as `{ state: RoundState }` where the
 * committed IDL inlines the fields, and names `close_round_account`'s argument `_round_no` where the
 * committed one says `round_no`. Neither difference changes a single byte on the wire: the full
 * choreography in `g1.wedge.ts` runs green against the committed IDL and the `target/deploy` binary,
 * `program.account.round.fetch()` decodes, and `fighter_count` reads correctly on both layers. A
 * gate that is red for cosmetic reasons is a gate somebody deletes, and it would have taken this one
 * with it. The residual — a genuine layout change landing without the committed IDL following — is
 * not silent either: Anchor fails loudly on the first instruction, which is a red suite naming the
 * instruction, and is exactly the E1-M2 failure mode §7 describes.
 */
export function assertProgramIsFresh(programSo: string, sourceFile: string): void {
  if (!existsSync(programSo)) {
    throw new MissingPrecondition(
      `${programSo} does not exist.\n` +
        `  build it: cd ${REPO_ROOT} && anchor build\n` +
        `  note:     \`cargo-build-sbf\` lives at ~/.local/share/solana/install/active_release/bin, ` +
        `and this machine needs CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/usr/bin/cc for host links.`,
    );
  }

  // ELF magic. Catches a truncated or aborted build, which otherwise reaches
  // `solana-test-validator` as an unhelpful genesis error minutes later.
  const fd = openSync(programSo, "r");
  const magic = Buffer.alloc(4);
  let read = 0;
  try {
    read = readSync(fd, magic, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  if (read < 4 || magic.toString("latin1") !== "\x7fELF") {
    throw new MissingPrecondition(
      `${programSo} is not an ELF object (first ${read} bytes: ${magic.subarray(0, read).toString("hex")}). ` +
        `A previous build almost certainly failed part-way. Re-run \`anchor build\`.`,
    );
  }

  if (!existsSync(sourceFile)) return;
  const built = statSync(programSo).mtimeMs;
  const source = statSync(sourceFile).mtimeMs;
  if (built < source) {
    const behind = ((source - built) / 1000 / 60).toFixed(1);
    throw new MissingPrecondition(
      `${programSo} is STALE — it is ${behind} minutes older than ${sourceFile}.\n` +
        `  rebuild: cd ${REPO_ROOT} && anchor build\n` +
        `This harness deploys the .so into a genesis block and then asserts what the program does. ` +
        `Measuring last week's bytecode and reporting it as today's is the failure this check exists ` +
        `to prevent — see ARENA-VAULT.md §11 on E1's first method, where a stale ER clone was ` +
        `reasoned about for weeks and turned out to behave nothing like the reasoning.`,
    );
  }
}

function requireFreshProgram(): string {
  assertProgramIsFresh(PROGRAM_SO, LIB_RS);
  return PROGRAM_SO;
}

/** The committed IDL, with the two things about it that can silently be wrong made loud. */
function requireIdl(): { idl: WedgeIdl; programId: PublicKey } {
  if (!existsSync(IDL_PATH)) {
    throw new MissingPrecondition(
      `${IDL_PATH} does not exist. It is a byte-identical copy of ` +
        `programs/bulls-arena/idl/bulls_arena.json — see src/chain/idl.ts.`,
    );
  }
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8")) as WedgeIdl;

  let programId: PublicKey;
  try {
    programId = new PublicKey(idl.address);
  } catch {
    throw new MissingPrecondition(`${IDL_PATH} has no usable \`address\`: ${String(idl.address)}`);
  }

  // THE CROSS-CHECK, and why it imports from the app rather than restating the id.
  //
  // `src/chain/constants.ts` is where this repo writes down which program it drives, and it is
  // guarded — `assertDevnetUrl` runs at ITS import time over ITS endpoints, so importing it here
  // cannot introduce a cluster this file did not ask for. Restating `FcLNVuH9…` as a literal in this
  // directory was the alternative, and it was rejected on the plainest possible grounds: this repo
  // has burned NINE program ids (§7), and lib.rs's own header records a propagation that updated the
  // string form of an id and left a byte array pinned to the previous one. A third hand-maintained
  // copy of the program id is a third thing to forget. Two independent statements that must agree is
  // the useful number; three copies that might not is worse than one.
  if (!programId.equals(PROGRAM_ID)) {
    throw new MissingPrecondition(
      `program id disagreement:\n` +
        `  ${IDL_PATH} says ${programId.toBase58()}\n` +
        `  src/chain/constants.ts says ${PROGRAM_ID.toBase58()}\n` +
        `The wedge must be produced on the id the app actually drives, or it measures a different program.`,
    );
  }

  const have = new Set(idl.instructions.map((i) => i.name));
  const missing = REQUIRED_INSTRUCTIONS.filter((n) => !have.has(n));
  if (missing.length > 0) {
    throw new MissingPrecondition(
      `${IDL_PATH} is missing instructions this experiment drives: ${missing.join(", ")}.\n` +
        `Either the IDL is stale, or the program no longer has them — both change what G1 means.`,
    );
  }

  return { idl, programId };
}

/** True when nothing is listening on `127.0.0.1:port`.
 *
 *  Exported because `stack.ts` uses it for a second, different job: confirming after SIGKILL that
 *  the rollup really is gone. Binding the port is the strongest available proof of that — a process
 *  can be un-reaped, or reaped but with a child still holding the socket, and neither shows up in an
 *  exit code. It is the same question ("is anything on this port?") asked before and after, so it is
 *  one function rather than two that could drift. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const server = createServer();
    server.once("error", () => res(false));
    server.once("listening", () => server.close(() => res(true)));
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Every port the harness binds, verified free.
 *
 * REFUSING IS THE WHOLE POINT; reusing is the disaster. If something already answers on the base
 * layer's port, the tempting behaviour is to use it — one fewer validator to boot. That would mean
 * this suite delegating a round to a validator it did not start, on a ledger it does not own, and
 * then SIGKILLing a process somebody else is using. `e2e/globalSetup.ts` reaches the same conclusion
 * for a far less destructive reason and says it well: "if something else is on 5199, that is a fact
 * worth failing on, not a reason to quietly test whatever is answering."
 */
async function requireFreePorts(ports: Record<string, number>): Promise<void> {
  const busy: string[] = [];
  for (const [name, port] of Object.entries(ports)) {
    if (!(await isPortFree(port))) busy.push(`${name} (127.0.0.1:${port})`);
  }
  if (busy.length > 0) {
    throw new MissingPrecondition(
      `these ports are already in use: ${busy.join(", ")}.\n` +
        `wedge/ starts its own throwaway validators and will not adopt one it did not start — it ` +
        `SIGKILLs the rollup as the experiment's central act, and doing that to somebody else's ` +
        `process is not a measurement. Stop whatever is listening, or run this suite alone.`,
    );
  }
}

/** Resolve and verify everything, or throw naming the fix. Called once, before anything is spawned. */
export async function checkPreconditions(ports: Record<string, number>): Promise<Toolchain> {
  const mbTestValidator = requireBinary(
    "mb-test-validator",
    "the base layer — solana-test-validator preloaded with MagicBlock's genesis programs and accounts",
    INSTALL_EPHEMERAL_VALIDATOR,
  );
  const ephemeralValidator = requireBinary(
    "ephemeral-validator",
    "the rollup whose death produces the wedge (ARENA-VAULT.md §7 E1-M1 step 6)",
    INSTALL_EPHEMERAL_VALIDATOR,
  );
  // `mb-test-validator` only spawns `solana-test-validator`; if the latter is absent the failure
  // arrives as a wrapper exiting with a bare ENOENT and no explanation of what was missing.
  requireBinary(
    "solana-test-validator",
    "the base layer itself — mb-test-validator is only a wrapper around it",
    "https://docs.anza.xyz/cli/install  (or: brew install solana)",
  );

  const localDumpsDir = findLocalDumps([ephemeralValidator, mbTestValidator]);
  const programSo = requireFreshProgram();
  const { idl, programId } = requireIdl();
  await requireFreePorts(ports);

  return { mbTestValidator, ephemeralValidator, localDumpsDir, programSo, idl, programId };
}
