// TWO VALIDATORS, ONE OF WHICH IS SUPPOSED TO DIE.
//
// This module boots a base layer and a rollup on loopback, and provides the one operation the whole
// experiment turns on: killing the rollup in a way that is verified rather than assumed.
// `ARENA-VAULT.md` §7 E1-M1 step 6 is "SIGKILL the ephemeral-validator. Never restart it." Steps 7
// and 8 — the actual measurement — are only worth reading if step 6 really happened, so "we sent a
// signal" is not good enough here. `sigkillRollup` does not return until the process is reaped, the
// RPC refuses connections, and the port is free.
//
// Three things in this file were learned by getting them wrong, and each is commented where it lives:
// the readiness gate (without it the rollup boots into a base layer that has not finished loading
// programs and exits), the identity provisioning (a freshly-minted validator identity cannot start
// against MagicBlock's shipped genesis without one extra account), and process-group killing (the
// obvious `pkill -f ephemeral-validator` kills the BASE validator too).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID,
  magicFeeVaultPdaFromValidator,
  validatorFeesVaultPdaFromValidator,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { assertLocalhostUrl } from "./localhost.ts";
import { isPortFree, type Toolchain } from "./preconditions.ts";

/**
 * Ports, deliberately NOT the defaults.
 *
 * `solana-test-validator` wants 8899/8900/9900 and `ephemeral-validator` wants 7799/7800/9000 —
 * which is exactly what a developer running `mb-stack` by hand on this machine already has. This
 * harness refuses to adopt a validator it did not start (see `requireFreePorts`), so sitting on the
 * conventional ports would turn "I have a local stack open in another terminal" into a hard failure
 * of an unrelated test suite. Offsetting by twenty leaves the conventional stack alone, and the
 * free-port precondition still fires if something is genuinely in the way.
 *
 * The WebSocket ports are not configurable on either binary: both derive them as `rpc + 1`. They are
 * listed anyway because the precondition check must know every port that will be bound, and a port
 * that is claimed implicitly is exactly the one nobody remembers to check.
 *
 * THE ROLLUP'S METRICS PORT IS ABSENT, AND NOT BY OVERSIGHT. `ephemeral-validator` binds a Prometheus
 * endpoint on `0.0.0.0:9000` and documents `-m, --metrics <METRICS>` as "Listen address for the
 * metrics endpoint". That flag does not work in 0.14.10 — every value is rejected by the config
 * deserializer, including the one the binary itself produces:
 *
 *     -m 9019            -> invalid type: found string "127.0.0.1:9019", expected struct MetricsConfig
 *     -m 127.0.0.1:9019  -> invalid type: found string "127.0.0.1:9019", expected struct MetricsConfig
 *
 * i.e. it normalizes a bare port into `host:port` and then fails to parse its own normalization. So
 * the metrics port cannot be moved, and 9000 is not listed here because it is not a precondition of
 * the MEASUREMENT: if it is taken and that turns out to be fatal, the rollup exits during boot and
 * `waitUntilReady` reports it with the log tail, which is already the loud, actionable failure. A
 * free-port check for a port we cannot move and may not need is a check that fails runs for no
 * reason, and a check that fails for no reason is a check somebody deletes. Worth re-testing after
 * any ephemeral-validator upgrade; the flag is the cheap thing to watch.
 */
export const WEDGE_PORTS = {
  baseRpc: 8919,
  baseWs: 8920,
  baseFaucet: 9919,
  rollupRpc: 7819,
  rollupWs: 7820,
} as const;

export const BASE_RPC_URL = `http://127.0.0.1:${WEDGE_PORTS.baseRpc}`;
export const BASE_WS_URL = `ws://127.0.0.1:${WEDGE_PORTS.baseWs}`;
export const ROLLUP_RPC_URL = `http://127.0.0.1:${WEDGE_PORTS.rollupRpc}`;

/** A supervised child, plus the log it is writing and whether it has exited. */
export interface Process {
  readonly name: string;
  readonly child: ChildProcess;
  readonly logPath: string;
  exited: boolean;
}

/** The identity the rollup runs as and the delegation is pinned to. */
export interface ValidatorIdentity {
  readonly keypair: Keypair;
  /** What `ephemeral-validator -k` wants: base58 of the full 64-byte secret key. */
  readonly secretBase58: string;
}

/** A `solana account --output json`-shaped genesis fixture, as `solana-test-validator --account`
 *  consumes it. */
interface GenesisAccount {
  pubkey: string;
  account: {
    lamports: number;
    data: [string, "base64"];
    owner: string;
    executable: boolean;
    rentEpoch: number;
    space: number;
  };
}

const running: Process[] = [];
let workDir: string | null = null;

/** The scratch directory holding both ledgers, both logs and the genesis fixtures. */
export function workspace(): string {
  if (!workDir) workDir = mkdtempSync(join(tmpdir(), "bulls-wedge-"));
  return workDir;
}

/**
 * Mint the validator identity and the genesis accounts that let it start.
 *
 * THIS IS THE HALF OF §10's UNKNOWN THAT NOBODY HAD LOOKED AT, and the answer is more interesting
 * than yes-or-no. §10 asks "whether a locally-run ephemeral-validator accepts a delegation naming
 * its own identity, AND whether that identity is settable from its keypair". The second half looks
 * trivial — `ephemeral-validator -k <base58 secret>` exists and works, and the startup banner prints
 * the key you gave it. It is not trivial, because setting the identity is not the same as being able
 * to RUN as it. Measured on 2026-08-20, in this order:
 *
 *   -k <a fresh keypair>, unfunded      -> ValidatorInsufficientlyFunded(<key>, 5); exits
 *   -k <a fresh keypair>, funded 100 SOL -> "Magic fee vault absent, initializing"
 *                                          "Magic fee vault setup failed … Invalid account owner"
 *                                          exits
 *   no -k at all                         -> identity mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev
 *                                          "Magic fee vault initialized" … "delegated"; runs
 *
 * The vendor's built-in default identity works and an arbitrary one does not, which reads at first
 * like the identity is effectively fixed. It is not. `InitMagicFeeVault` requires the validator's
 * `["v-fees-vault", identity]` PDA to already exist and be owned by the delegation program; for an
 * identity with no such account, the runtime sees a System-owned (i.e. absent) account and returns
 * `Invalid account owner`. MagicBlock's shipped genesis dumps contain exactly one of these — and it
 * is not labelled as such. `EpJnX7ueXk7fKojBymqmVuCuwyhDQsYcLVL1XMsBbvDX`, an 8-byte, all-zero,
 * DELeGG-owned account in `bin/local-dumps`, IS `validatorFeesVaultPdaFromValidator(mAGicPQY…)`;
 * that identity works because its vault ships with the binary, not because the binary is attached
 * to it.
 *
 * So we synthesize the same account for an identity we mint, and an arbitrary identity starts
 * cleanly. Verified: a fresh keypair, funded and given its vault in genesis, reaches "Magic fee
 * vault initialized" and "Magic fee vault delegated" and stays up.
 *
 * WHY THIS IS WORTH THE THIRTY LINES rather than just using the default identity, which also works.
 * §7 E1-M1's step 6 is "SIGKILL the ephemeral-validator. NEVER RESTART IT." With the vendor default,
 * "never" is a promise the test makes to itself: the key is built into a binary every reader of this
 * file has installed, so anyone could stand the validator back up and undo the wedge. With a minted
 * identity the secret exists only in this process and in a temp directory that `afterAll` deletes,
 * so after teardown the pinned key is gone from the universe. That turns "we chose not to restart
 * it" into "it cannot be restarted", which is the difference between illustrating §5.1's dead
 * validator and instantiating one.
 *
 * The residual, stated rather than hidden: the 8-zero-byte layout of a `v-fees-vault` is read off
 * MagicBlock's own dump rather than from documentation. If they change it, this fails LOUDLY — the
 * rollup exits during boot and `startRollup` throws with the log tail — which is the acceptable
 * direction for an undocumented dependency to break in.
 */
export function mintValidatorIdentity(): { identity: ValidatorIdentity; genesis: GenesisAccount[] } {
  const keypair = Keypair.generate();
  const secretBase58 = utils.bytes.bs58.encode(keypair.secretKey);

  // The identity's own lamports. The validator checks its balance before anything else and wants at
  // least 5 SOL — `ValidatorInsufficientlyFunded(<key>, 5)`, measured. Funding it in GENESIS rather
  // than by airdrop removes the faucet from the critical path entirely: one fewer subsystem that can
  // be slow, rate-limited or not-yet-ready at the moment the rollup boots.
  const funded = systemAccount(keypair.publicKey, 500 * LAMPORTS_PER_SOL);

  // `["v-fees-vault", identity]`, 8 zero bytes, owned by the delegation program — a byte-for-byte
  // copy of the shape MagicBlock ships for their own identity. The PDA is derived with the SDK's own
  // helper rather than by writing the seed out here, so the seed string lives in exactly one place
  // and that place is upstream's.
  const feesVault = dlpAccount(validatorFeesVaultPdaFromValidator(keypair.publicKey), 946_560, 8);

  return { identity: { keypair, secretBase58 }, genesis: [funded, feesVault] };
}

/** A System-owned account with a balance and no data — how `solana-test-validator` is told about a
 *  pre-funded wallet without involving the faucet. */
export function systemAccount(pubkey: PublicKey, lamports: number): GenesisAccount {
  return {
    pubkey: pubkey.toBase58(),
    account: {
      lamports,
      data: ["", "base64"],
      owner: SystemProgram.programId.toBase58(),
      executable: false,
      // Zero rather than u64::MAX (which is what a real `solana account --output json` dump carries
      // for a rent-exempt account). u64::MAX does not survive a JSON round trip through JavaScript
      // — `18446744073709551615` reads back as `18446744073709552000` — and genesis does not care,
      // so the honest thing is to write a number that means what it says.
      rentEpoch: 0,
      space: 0,
    },
  };
}

/** A delegation-program-owned account of `space` zero bytes. */
function dlpAccount(pubkey: PublicKey, lamports: number, space: number): GenesisAccount {
  return {
    pubkey: pubkey.toBase58(),
    account: {
      lamports,
      data: [Buffer.alloc(space).toString("base64"), "base64"],
      owner: DELEGATION_PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
      space,
    },
  };
}

function writeGenesis(dir: string, accounts: GenesisAccount[]): string[] {
  return accounts.map((a) => {
    const path = join(dir, `genesis-${a.pubkey}.json`);
    writeFileSync(path, JSON.stringify(a));
    return path;
  });
}

function spawnSupervised(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv): Process {
  const logPath = join(workspace(), `${name}.log`);
  const fd = openSync(logPath, "a");
  // `detached: true` makes the child a process-group leader so the whole subtree can be signalled
  // with `kill(-pid)`. Both binaries here are Node wrappers that spawn a Rust grandchild
  // (`ephemeralValidator.js` -> the platform binary, `mbTestValidator.js` -> solana-test-validator),
  // so signalling only the direct child leaves the thing that actually holds the port running. This
  // is the same reasoning — and the same fix — as `mb-stack`'s own `killGroup`.
  const child = spawn(cmd, args, { detached: true, stdio: ["ignore", fd, fd], env });
  const proc: Process = { name, child, logPath, exited: false };
  child.on("exit", () => {
    proc.exited = true;
  });
  running.push(proc);
  return proc;
}

/** The last few lines of a process's log, ANSI stripped — for putting inside a thrown error, which
 *  is the only place anybody will look when a validator refuses to start. */
export function logTail(proc: Process, lines = 25): string {
  try {
    return readFileSync(proc.logPath, "utf8")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, "")
      .trimEnd()
      .split("\n")
      .slice(-lines)
      .map((l) => `    | ${l}`)
      .join("\n");
  } catch {
    return "    | (no log)";
  }
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(2_000),
  });
  return ((await res.json()) as { result?: unknown }).result ?? null;
}

async function rpcOrNull(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  try {
    return await rpc(url, method, params);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `ready` until it is true, failing fast if the process died in the meantime. */
async function waitUntilReady(proc: Process, what: string, timeoutMs: number, ready: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exited) {
      throw new Error(
        `${proc.name} exited during startup, before ${what}.\n${logTail(proc)}\n` +
          `  full log: ${proc.logPath}`,
      );
    }
    if (await ready()) return;
    await sleep(500);
  }
  throw new Error(
    `${proc.name} did not reach "${what}" within ${timeoutMs}ms.\n${logTail(proc)}\n` +
      `  full log: ${proc.logPath}`,
  );
}

/**
 * The base layer: `solana-test-validator` with MagicBlock's genesis programs, our program, and any
 * accounts we want pre-funded.
 *
 * IT SHELLS OUT TO `mb-test-validator` RATHER THAN REBUILDING ITS ARGUMENT LIST. That wrapper is a
 * hundred lines of `--bpf-program` and `--account` pairs naming eight programs and thirteen accounts
 * — the delegation program, the VRF oracle, the permission program, the ephemeral SPL token program,
 * their fee vaults and queues. Copying that list here would work today and would be wrong within a
 * release: it is upstream's genesis, it changes when upstream changes, and a copy has no way to
 * learn that. Extra arguments are appended AFTER the wrapper's own, and `solana-test-validator` is
 * last-wins on repeated flags, so everything below overrides cleanly.
 *
 * `--bind-address 127.0.0.1` because the default binds every interface. A validator that exists to
 * hold a deliberately-broken round has no business being reachable from the network.
 */
export async function startBaseLayer(
  tools: Toolchain,
  genesisAccounts: GenesisAccount[],
): Promise<Process> {
  assertLocalhostUrl(BASE_RPC_URL, "base layer RPC");
  const dir = workspace();
  const accountArgs = writeGenesis(dir, genesisAccounts).flatMap((path, i) => [
    "--account",
    genesisAccounts[i].pubkey,
    path,
  ]);

  const proc = spawnSupervised(
    "base-layer",
    tools.mbTestValidator,
    [
      "--rpc-port", String(WEDGE_PORTS.baseRpc),
      "--faucet-port", String(WEDGE_PORTS.baseFaucet),
      "--bind-address", "127.0.0.1",
      "--ledger", join(dir, "base-ledger"),
      // Redundant with a fresh `mkdtemp` directory and kept anyway: §7 names
      // `solana-test-validator --reset` as M1's cleanup story, and a reader checking this harness
      // against the document should find it.
      "--reset",
      "--limit-ledger-size", "10000000",
      ...accountArgs,
      // The program under test, at its real id, loaded at genesis. `--upgradeable-program` rather
      // than `solana program deploy` because the address is given directly: no program keypair is
      // needed, and this harness therefore never opens `.devnet/program-keypair-v9.json` — the key
      // that can write to the LIVE arena's program id. An upgrade authority of "none" makes the
      // local copy immutable, which is correct: E1-M1 wedges by killing a validator, not by
      // upgrading anything (that was E1-M2, and §7 records that the in-place-upgrade method does not
      // wedge at all).
      "--upgradeable-program", tools.programId.toBase58(), tools.programSo, "none",
    ],
    { ...process.env },
  );

  // THE READINESS GATE, AND WHY EVERY CLAUSE IN IT IS THERE.
  //
  // This gate was wrong twice, in the same direction both times, and the shape of the mistake is
  // worth more than the fix. Each version asked a question that was ANSWERABLE earlier than the
  // thing it stood for, so it passed while the validator was not yet able to do the one job the next
  // step needs.
  //
  //   v1: wait for `solana cluster-version` to answer.  -> rollup died: "Unsupported program id"
  //   v2: + getHealth == "ok", + the programs read back executable.
  //                                                     -> rollup died: "Unsupported program id"
  //
  // v2 looked airtight and is what `mb-stack` does, so the failure was surprising until the slot was
  // printed: the gate passed **1 second** after spawn with `getSlot` returning **0**, while
  // solana-test-validator's own stdout still read "Waiting for first slot 1...". A validator at
  // genesis has a bank, so it answers `getHealth` with "ok" and serves every genesis account with
  // `executable: true` — but it has produced no block, and a program in a bank that has never
  // produced a block cannot be invoked. "Unsupported program id" is precisely that: the rollup's
  // first setup transaction reaching a delegation program that reads as present and is not yet
  // runnable.
  //
  // `mb-stack` does not have this bug, and its own comment says why in a sentence this harness read
  // and did not act on: it also waits for solana-test-validator's readiness line "because Agave can
  // answer health checks before that startup gate has completed". That fix is a stdout scrape, which
  // this harness cannot use (its child is a Node wrapper, and a banner's format is not an interface).
  //
  // So the gate asks for the thing itself. BLOCK PRODUCTION IS OBSERVED, NOT INFERRED: the slot must
  // be non-zero AND strictly greater than a slot seen on an earlier poll. One reading of a non-zero
  // slot would be satisfied by a validator that had produced one block and then wedged; two
  // increasing readings mean the chain is live. Everything else — health, the two programs, every
  // genesis account we asked for — is checked as well, because a gate should wait for what the next
  // step needs rather than for a proxy for it.
  let slotSeen = -1;
  await waitUntilReady(proc, "the base layer is producing blocks with our genesis loaded", 120_000, async () => {
    if ((await rpcOrNull(BASE_RPC_URL, "getHealth")) !== "ok") return false;

    const slot = (await rpcOrNull(BASE_RPC_URL, "getSlot")) as number | null;
    if (typeof slot !== "number" || slot < 1) return false;
    if (slot <= slotSeen) return false;
    if (slotSeen < 0) {
      // First non-zero reading. Record it and come back — the NEXT poll is the one that can show the
      // chain has moved, and "has moved" is the claim.
      slotSeen = slot;
      return false;
    }

    for (const key of [DELEGATION_PROGRAM_ID, tools.programId]) {
      const info = (await rpcOrNull(BASE_RPC_URL, "getAccountInfo", [
        key.toBase58(),
        { encoding: "base64" },
      ])) as { value?: { executable?: boolean } } | null;
      if (!info?.value?.executable) return false;
    }
    for (const account of genesisAccounts) {
      const info = (await rpcOrNull(BASE_RPC_URL, "getAccountInfo", [
        account.pubkey,
        { encoding: "base64" },
      ])) as { value?: unknown } | null;
      if (!info?.value) return false;
    }
    return true;
  });

  return proc;
}

/** The rollup, pinned to `identity`, cloning from and committing to the local base layer. */
export async function startRollup(tools: Toolchain, identity: ValidatorIdentity): Promise<Process> {
  assertLocalhostUrl(ROLLUP_RPC_URL, "rollup RPC");
  assertLocalhostUrl(BASE_RPC_URL, "rollup's base-layer remote");
  assertLocalhostUrl(BASE_WS_URL, "rollup's base-layer websocket remote");

  const proc = spawnSupervised(
    "rollup",
    tools.ephemeralValidator,
    [
      "--remotes", BASE_RPC_URL,
      "--remotes", BASE_WS_URL,
      "--listen", `127.0.0.1:${WEDGE_PORTS.rollupRpc}`,
      // "clone all accounts - write to delegated accounts" — the mode a real ER runs in, and the
      // only one under which the delegation actually governs anything. `replica` would let the
      // rollup write undelegated accounts, which would make the experiment meaningless.
      "--lifecycle", "ephemeral",
      // The published binary has the TUI feature compiled in and exits immediately when its stdio is
      // not a TTY. Ours is a log file. mb-stack carries the same flag and the same note.
      "--no-tui",
      "--reset",
      "--storage", join(workspace(), "rollup-storage"),
      "-k", identity.secretBase58,
    ],
    // The npm wrapper defaults RUST_LOG to "quiet", which is the right default for a tool somebody
    // is watching and the wrong one for a process whose log is the only evidence available when it
    // refuses to start.
    { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" },
  );

  await waitUntilReady(proc, "the rollup answers getIdentity", 120_000, async () => {
    const res = (await rpcOrNull(ROLLUP_RPC_URL, "getIdentity")) as { identity?: string } | null;
    return typeof res?.identity === "string";
  });

  // The rollup's boot sequence continues after the RPC opens: it initializes and then DELEGATES its
  // own magic fee vault, and a delegation that arrives while that is in flight can race it. Waiting
  // for the vault to be delegated on the base layer is waiting for the thing itself rather than for
  // a sleep to expire.
  await waitUntilReady(proc, "the rollup's magic fee vault is delegated", 60_000, async () => {
    const vault = magicFeeVaultPdaFromValidator(identity.keypair.publicKey);
    const info = (await rpcOrNull(BASE_RPC_URL, "getAccountInfo", [
      vault.toBase58(),
      { encoding: "base64" },
    ])) as { value?: { owner?: string } } | null;
    return info?.value?.owner === DELEGATION_PROGRAM_ID.toBase58();
  });

  return proc;
}

/** Read the rollup's own view of who it is. The delegation is pinned to whatever this returns, never
 *  to a key the harness merely believes the rollup is using — a pin computed from an assumption is
 *  the one way E1-M1 could produce a green run that means nothing. */
export async function rollupIdentity(): Promise<PublicKey> {
  const res = (await rpc(ROLLUP_RPC_URL, "getIdentity")) as { identity?: string } | null;
  if (!res?.identity) throw new Error(`rollup at ${ROLLUP_RPC_URL} did not report an identity`);
  return new PublicKey(res.identity);
}

function killGroup(proc: Process, signal: NodeJS.Signals): void {
  const pid = proc.child.pid;
  if (pid === undefined || proc.exited) return;
  try {
    // NEGATIVE PID — the process GROUP, not the process. And by pid, never by pattern.
    //
    // The obvious `pkill -9 -f ephemeral-validator` is a trap that this harness fell into once and
    // that anybody debugging it will reach for: it also kills the BASE validator, because
    // `mb-test-validator` passes the local-dumps paths on the command line and every one of them
    // contains the string "ephemeral-validator". The base layer died silently in the middle of an
    // experiment whose entire subject is what the base layer says afterwards.
    process.kill(-pid, signal);
  } catch {
    // ESRCH — already gone.
  }
}

/**
 * Step 6, performed and then VERIFIED.
 *
 * §7 says "SIGKILL the ephemeral-validator. Never restart it." SIGKILL rather than SIGTERM is the
 * whole point and not a convenience: SIGTERM gives the validator a chance to run a shutdown path,
 * and a graceful ER shutdown is entitled to commit and undelegate what it holds. That would produce
 * a round that settled normally — the opposite of the measurement. This models the validator that
 * dies, which is the case `ARENA-VAULT.md` §5.1 is written about.
 *
 * Everything after the kill returns only once the death is established three independent ways: the
 * child is reaped, the RPC refuses connections, and the port is free. A test that asserts "nothing
 * can move this round" while the validator that could move it is still draining its queues has
 * measured nothing.
 */
export async function sigkillRollup(proc: Process): Promise<void> {
  killGroup(proc, "SIGKILL");

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rpcDead = (await rpcOrNull(ROLLUP_RPC_URL, "getIdentity")) === null;
    if (proc.exited && rpcDead && (await isPortFree(WEDGE_PORTS.rollupRpc))) return;
    await sleep(250);
  }
  throw new Error(
    `the rollup would not die: exited=${proc.exited}, ` +
      `port ${WEDGE_PORTS.rollupRpc} free=${await isPortFree(WEDGE_PORTS.rollupRpc)}. ` +
      `The wedge cannot be asserted while the pinned validator may still be running.`,
  );
}

/** True when nothing answers on the rollup's RPC — the post-kill control. */
export async function rollupIsUnreachable(): Promise<boolean> {
  return (await rpcOrNull(ROLLUP_RPC_URL, "getHealth")) === null;
}

/**
 * Kill everything and delete the workspace.
 *
 * THE DISPOSABILITY IS THE FEATURE. §7 lists it as M1's advantage over both devnet methods: "Cleanup:
 * `solana-test-validator --reset`. The wedge is disposable — the property no devnet method has."
 * Deleting the whole temp directory disposes of more than the ledger: the rollup's storage, the
 * genesis fixtures, and — the part that matters — the only copy of the pinned validator's secret
 * key, which was minted in this process and written nowhere else. After this returns, the wedged
 * round and the key that could have unwedged it are both gone.
 */
export async function teardown(): Promise<void> {
  for (const proc of running) killGroup(proc, "SIGKILL");
  // Give the group a moment to be reaped before the directory holding its ledger disappears.
  await sleep(500);
  running.length = 0;
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
}

// LAST-DITCH CLEANUP. If vitest is interrupted (Ctrl-C, a timeout that takes the runner down, an
// unhandled rejection) `afterAll` may never run, and two detached validators would outlive the
// terminal that started them — holding ports, writing to a temp directory nobody will ever look in.
// `exit` handlers may only do synchronous work, which is exactly enough for `process.kill`.
process.on("exit", () => {
  for (const proc of running) killGroup(proc, "SIGKILL");
});
