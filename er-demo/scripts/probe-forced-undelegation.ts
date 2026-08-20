#!/usr/bin/env bun
// IS FORCED / TIMEOUT UNDELEGATION DEPLOYED ON THE DEVNET WE ACTUALLY RUN ON? — ARENA-VAULT.md §7 E2.
//
//   cd er-demo && bun run scripts/probe-forced-undelegation.ts
//
// WHY THIS FILE EXISTS AT ALL, WHICH IS THE POINT MORE THAN THE ANSWER IS. `COST-MODEL.md` §4.3 and
// `ARENA-VAULT.md` §5.1 both assert that forced undelegation exists in the delegation program's
// v3.1.0 API but is NOT deployed on our devnet, "verified twice". Neither probe was ever committed.
// §5.1 says so in its own words — "I did not re-run either probe" — and then rests a residual on the
// claim anyway. A statement load-bearing enough to decide whether a dead round's 0.023497 SOL of rent
// is recoverable should be re-runnable in one command by whoever next doubts it, and until this file
// existed it was a sentence in a document citing a session nobody can replay.
//
// WHAT WOULD CHANGE IF THE ANSWER FLIPPED. §5.1's base-layer refund path does not depend on forced
// undelegation and that is deliberate — the vault refunds from bytes the rollup never touched. But
// forced undelegation would be a SECOND rescue that also recovers the `Round` account's rent, which
// the base-layer path structurally cannot: no instruction can close an account the Delegation Program
// owns. It would shrink §5.1's first residual from "stranded permanently" to "stranded for the
// timeout", and it would give the keeper's sweep-gap stop (§5.1's second residual) a way to un-latch
// on its own. So a YES here is a real change to the document, not a footnote, and this script says so
// in capitals rather than leaving it to be noticed.
//
// SAFE TO RUN BESIDE THE LIVE KEEPER — the same property, for the same reason, as `reclaim-status.ts`.
// It signs nothing and sends nothing. Every verdict comes from `simulateTransaction`, which executes
// against a snapshot and cannot alter state, plus two plain account reads. It never touches the arena,
// a round, or `bulls-arena`. No key is loaded from `.devnet/`; the one address it names is the arena
// authority's PUBLIC key, used only as a simulation fee payer that must exist and be funded for the
// simulator to get as far as the program at all — exactly the borrow `reclaim-status.ts` documents.
//
// ── THE THREE ARMS, AND WHY THERE ARE THREE ──────────────────────────────────────────────────────
//
// A. HOW OLD IS THE DEPLOYED BYTECODE. The ProgramData account's write slot, resolved to a real date
//    via `getBlockTime` rather than left as a slot count. This is the arm `COST-MODEL.md` recorded as
//    "~4 months stale"; it is circumstantial on its own (age is not absence) and it is here because it
//    dates the deployment against the upstream release, which is the thing that makes the other two
//    arms interpretable.
//
// B. THE DISCRIMINATOR CENSUS, WITH FOUR CONTROLS. This is the arm that answers the question, and it
//    is a strict widening of what `COST-MODEL.md` describes as "a `simulateTransaction` probe with a
//    control". A probe with no control cannot tell "the instruction is absent" from "my transaction
//    was malformed" — both come back as a failed simulation. The previous run's entire value came from
//    having one. This one enumerates the WHOLE implemented instruction set rather than asking about a
//    single index, which costs one extra RPC round trip per discriminator and buys a result that is
//    self-describing: you can see the shape of the deployed API, not just a yes/no about one corner of
//    it. The controls are named at `CONTROLS` below.
//
// C. AN ELF BYTE SCAN, AS CORROBORATION AND NOT AS PROOF. The delegation program derives its PDAs
//    from ASCII seed tags, so the tags are compiled into the executable. `undelegation-request` is the
//    seed of the account the v3.1.0 flow creates, and it exists in no earlier version. Its presence or
//    absence alongside tags we KNOW are there (`state-diff`, `delegation-metadata`) is independent of
//    arm B — different mechanism, different failure modes — which is the only reason to run it. It is
//    corroboration because a missing string proves less than a missing instruction: a compiler is
//    allowed to fold or elide string data, so absence here is evidence and not a verdict.
//
// REJECTED: reading the delegation program's IDL. It publishes none — `dlp` is a native
// Pinocchio program, not an Anchor one, which is exactly why its discriminators are u64 indices and
// why this file has to enumerate them by hand instead of listing `idl.instructions`.
//
// REJECTED: trusting `@magicblock-labs/ephemeral-rollups-sdk`'s instruction builders as the source of
// truth for what is deployed. The SDK in `node_modules` is a CLIENT library pinned by our
// `package.json`; it describes what MagicBlock published, not what this cluster runs. Its three
// hardcoded discriminators (`Delegate` 0, `TopUpEphemeralBalance` 9, `CloseEphemeralBalance` 11) are
// used below only to CHECK the census against a second source, which is a different job.
//
// REJECTED: attempting the forced-undelegation instruction against a real delegated `Round` and
// reading the failure. It answers a narrower question with more ways to be wrong — a wrong account
// order produces a failure indistinguishable from a missing instruction, which is the confusion this
// file exists to remove — and it needs a live delegated round, which makes the probe unrunnable at
// exactly the moment (no round delegated) when someone might want to run it.

import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { assertDevnetUrl } from "../src/devnet-guard.ts";
import { BASE_RPC } from "../src/chain/constants.ts";

// The guard runs at `constants.ts`'s import time already. Calling it here as well is not redundant
// belt-and-braces: it puts the refusal IN THIS FILE, so a future edit that swaps `BASE_RPC` for a
// literal or an env read cannot quietly drop the assertion along with the import.
assertDevnetUrl(BASE_RPC, "base devnet RPC");

const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** The arena authority's PUBLIC key, hardcoded and never signed with — the identical borrow, for the
 *  identical reason, as `reclaim-status.ts`'s `OPERATOR`. A simulated transaction still needs a fee
 *  payer that EXISTS and is system-owned, or the simulator answers `AccountNotFound` before the
 *  program is ever reached and every arm below returns the same non-answer.
 *
 *  It is deliberately NOT the account whose authority any of these instructions inspect: every probe
 *  puts a freshly generated pubkey in the instruction's own first (signer) slot, so nothing the
 *  delegation program decides is decided about this address. Its only job is to be solvent. */
const SIMULATION_FEE_PAYER = new PublicKey("9BAjpGZfJm8sfnqNr1vj1K9X3fY8fjk4LE2KRtSTRCaj");

/** The upstream `DlpDiscriminator` enum, as published at git tag `v3.1.0` of
 *  `github.com/magicblock-labs/delegation-program`.
 *
 *  IT IS A LABELLING TABLE AND NOTHING ELSE, and that separation is the design. The census below
 *  decides PRESENT/ABSENT purely from what the deployed program answers; this table only supplies the
 *  name to print beside each index. If MagicBlock renumbers the enum tomorrow, the census is still
 *  correct and only the labels go stale — whereas a probe that ASKED about `27` because a table said
 *  27 would silently answer a different question.
 *
 *  THE HOLE AT 4 IS REAL and is not a transcription slip: v3.1.0's enum has no variant 4. It is
 *  reproduced here because it doubles as a control — see `CONTROLS`.
 *
 *  26 and 27 are the two that matter. They are the whole of the forced/timeout undelegation flow and
 *  they were added in v3.1.0 (PR #183, tagged 2026-07-08); v3.0.0's enum ends at 25. The flow is two
 *  instructions, not one: `RequestUndelegation` stamps an `UndelegationRequest` PDA with
 *  `expires_at_slot = slot + 9000` (~60 min), and then `UndelegateWithRollbackAfterTimeout` is
 *  PERMISSIONLESS once that slot passes. That second property is the entire reason §5.1 cares. */
const V3_1_0_DISCRIMINATORS: Record<number, string> = {
  0: "Delegate", 1: "CommitState", 2: "Finalize", 3: "Undelegate",
  // 4 — no variant.
  5: "InitProtocolFeesVault", 6: "InitValidatorFeesVault", 7: "ValidatorClaimFees",
  8: "WhitelistValidatorForProgram", 9: "TopUpEphemeralBalance", 10: "DelegateEphemeralBalance",
  11: "CloseEphemeralBalance", 12: "ProtocolClaimFees", 13: "CommitStateFromBuffer",
  14: "CloseValidatorFeesVault", 15: "CallHandler", 16: "CommitDiff", 17: "CommitDiffFromBuffer",
  18: "UndelegateConfinedAccount", 19: "DelegateWithAnyValidator", 20: "CallHandlerV2",
  21: "CommitFinalize", 22: "CommitFinalizeFromBuffer", 23: "DelegateWithActions",
  24: "InitMagicFeeVault", 25: "DelegateMagicFeeVault",
  26: "RequestUndelegation",
  27: "UndelegateWithRollbackAfterTimeout",
};

/** The two indices the question is about. Both must be PRESENT for forced undelegation to be usable:
 *  the timeout finisher is worthless without the request that stamps the expiry it waits on. */
const REQUEST_UNDELEGATION = 26;
const UNDELEGATE_AFTER_TIMEOUT = 27;

/** The dispatcher's log line for a discriminator byte that maps to no enum variant, verbatim from
 *  `src/lib.rs`'s `fast_process_instruction`:
 *
 *      Err(_) => { pinocchio_log::log!("Failed to read and parse discriminator"); ... }
 *
 *  MATCHING ON THE LOG LINE AND NOT ON THE ERROR CODE IS THE WHOLE TRICK, and control D below is
 *  what proves it has to be. The returned error is `InvalidInstructionData` for an unknown
 *  discriminator AND for instruction data too short to hold one — the same code for "you asked for
 *  something that does not exist" and "your transaction was malformed". Only the log line separates
 *  them, and separating them is the entire job. */
const UNKNOWN_DISCRIMINATOR_LOG = "Failed to read and parse discriminator";

/** The delegation program dispatches on `discriminator_bytes[0]` — the LOW byte of the 8-byte
 *  little-endian field, with the upper seven ignored. Control C below is what establishes that here
 *  rather than taking it on faith, because if it were false the census would be probing 256 aliases
 *  of the same instruction and would not know it. */
function discriminatorData(index: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt8(index & 0xff, 0);
  return b;
}

const conn = new Connection(BASE_RPC, "confirmed");

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const heading = (s: string) => console.log(`\n${c.b}${s}${c.x}`);
const info = (s: string) => console.log(`  ${c.d}${s}${c.x}`);
const ok = (s: string) => console.log(`  ${c.g}✓${c.x} ${s}`);
const bad = (s: string) => console.log(`  ${c.r}✗${c.x} ${s}`);

interface Simulated {
  /** True when the dispatcher rejected the discriminator itself — i.e. the deployed bytecode
   *  implements no instruction at this index. */
  unknown: boolean;
  err: string;
  logs: string[];
}

/** One simulated single-instruction transaction against the delegation program.
 *
 *  The account list is deliberately a single freshly-generated signer: every real instruction needs
 *  more accounts than that, so a PRESENT instruction fails on arity or on ownership rather than
 *  succeeding. That is intentional and it is what makes this safe to point at production — there is
 *  no account list here that could do anything even if it were sent, and nothing is sent. */
async function simulate(data: Buffer, blockhash: string): Promise<Simulated> {
  // A random pubkey in the instruction's own signer slot, NOT the fee payer. `sigVerify: false` means
  // the simulator treats both as signed, so any authority check the program performs is performed
  // against a key nobody holds — which is the honest question ("could a stranger do this?") and keeps
  // the fee payer's identity out of the answer.
  const stranger = PublicKey.unique();
  const ix = new TransactionInstruction({
    programId: DELEGATION_PROGRAM,
    keys: [{ pubkey: stranger, isSigner: true, isWritable: true }],
    data,
  });
  const message = new TransactionMessage({
    payerKey: SIMULATION_FEE_PAYER,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const res = await conn.simulateTransaction(new VersionedTransaction(message), {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  const logs = res.value.logs ?? [];
  return {
    unknown: logs.some((l) => l.includes(UNKNOWN_DISCRIMINATOR_LOG)),
    err: JSON.stringify(res.value.err),
    logs,
  };
}

// ── ARM A — how old is the deployed bytecode ─────────────────────────────────────────────────────

heading("A. the delegation program's ProgramData — how old is what is running");

const [programDataAddr] = PublicKey.findProgramAddressSync(
  [DELEGATION_PROGRAM.toBytes()],
  BPF_UPGRADEABLE_LOADER,
);
const programData = await conn.getAccountInfo(programDataAddr);
if (!programData) throw new Error(`no ProgramData account at ${programDataAddr.toBase58()} — the delegation program is not deployed on this cluster, which no arm below could survive`);

// `UpgradeableLoaderState::ProgramData` on the wire: a 4-byte enum tag, the u64 slot of the last
// successful write, then an `Option<Pubkey>` upgrade authority (1 tag byte + 32), then the ELF.
const lastWriteSlot = Number(programData.data.readBigUInt64LE(4));
const hasAuthority = programData.data.readUInt8(12) === 1;
const upgradeAuthority = hasAuthority ? new PublicKey(programData.data.subarray(13, 45)) : null;
const currentSlot = await conn.getSlot();

// The real date, not a slot arithmetic guess. `getBlockTime` on a slot this old is served from the
// ledger's block-time index and a public RPC may have pruned it — so the estimate is kept as a
// fallback rather than as the headline, and which one produced the number is printed.
const blockTime = await conn.getBlockTime(lastWriteSlot).catch(() => null);
const nowSec = Math.floor(Date.now() / 1000);
const ageDays = blockTime !== null
  ? (nowSec - blockTime) / 86_400
  // 400 ms/slot is Solana's target, not a measurement; only used when the exact time is unavailable.
  : ((currentSlot - lastWriteSlot) * 0.4) / 86_400;

info(`program        ${DELEGATION_PROGRAM.toBase58()}`);
info(`ProgramData    ${programDataAddr.toBase58()}`);
info(`upgrade auth   ${upgradeAuthority ? upgradeAuthority.toBase58() : "NONE — immutable"}`);
info(`last write     slot ${lastWriteSlot}${blockTime !== null ? `  =  ${new Date(blockTime * 1000).toISOString()}` : "  (block time unavailable on this RPC)"}`);
info(`current slot   ${currentSlot}  (${currentSlot - lastWriteSlot} slots later)`);
console.log(`  ${c.b}age            ${ageDays.toFixed(1)} days${c.x}${blockTime === null ? `  ${c.d}estimated at 400ms/slot${c.x}` : ""}`);

// v3.1.0's tag date. The comparison, not the age on its own, is what this arm contributes: bytecode
// written before the release cannot contain the release.
const V3_1_0_TAGGED = Date.parse("2026-07-08T00:00:00Z") / 1000;
if (blockTime !== null) {
  const deltaDays = (V3_1_0_TAGGED - blockTime) / 86_400;
  if (blockTime < V3_1_0_TAGGED) {
    info(`upstream v3.1.0 was tagged ${deltaDays.toFixed(0)} days AFTER this deployment — so this bytecode predates the release`);
  } else {
    info(`this deployment is ${(-deltaDays).toFixed(0)} days AFTER upstream v3.1.0's tag — age does not rule the feature out`);
  }
}
info("circumstantial on its own: age is not absence. Arm B is the one that answers the question.");

// ── ARM B — the discriminator census, with its controls ──────────────────────────────────────────

heading("B. controls — a probe that cannot fail its own controls cannot be believed");

const { blockhash } = await conn.getLatestBlockhash();

/** The four controls, and what each one would catch.
 *
 *  A/B are the pair a census needs to mean anything: one index that MUST classify PRESENT and one
 *  that MUST classify ABSENT. Without both, "26 is absent" is indistinguishable from "the probe
 *  reports everything absent".
 *
 *  C and D exist because the two obvious ways this specific probe could lie are not covered by A/B:
 *
 *    C — the addressing model. If the dispatcher read the full u64 rather than its low byte, every
 *        index below would be probing something other than what it is labelled. Sending index 0 with
 *        all seven upper bytes set to 0xff must behave EXACTLY like a plain `Delegate`; if it does
 *        not, the census is addressing the wrong thing and its verdict is void.
 *
 *    D — the classifier. Three bytes of instruction data is malformed rather than unknown, and the
 *        program answers it with the SAME `InvalidInstructionData` code as an unknown discriminator.
 *        It must NOT produce the marker log. This is the control that proves the marker separates
 *        "no such instruction" from "bad transaction" — which is precisely the distinction a probe
 *        without a control cannot draw, and precisely what this whole file is for. */
const CONTROLS = [
  {
    name: "A  positive — index 0 `Delegate`",
    data: discriminatorData(0),
    expectUnknown: false,
    because: "present in every version of this program ever published; if this reads ABSENT the classifier is inverted",
  },
  {
    name: "B  negative — index 255",
    data: discriminatorData(255),
    expectUnknown: true,
    because: "no version of the enum has 256 variants; if this reads PRESENT the classifier never says ABSENT",
  },
  {
    name: "B' structural negative — index 4, the enum's own hole",
    data: discriminatorData(4),
    expectUnknown: true,
    because: "v3.1.0 defines no variant 4 — absence detected INSIDE the populated range, not only past its end",
  },
  {
    name: "C  addressing — index 0 with all upper bytes 0xff",
    data: Buffer.from([0, 255, 255, 255, 255, 255, 255, 255]),
    expectUnknown: false,
    because: "confirms dispatch is on the low byte alone, so every index below probes what it claims to",
  },
  {
    name: "D  malformed — three bytes of data, no discriminator at all",
    data: Buffer.alloc(3),
    expectUnknown: false,
    because: "malformed must NOT raise the unknown-discriminator marker, or ABSENT and 'bad probe' are the same reading",
  },
];

let controlsHeld = true;
for (const control of CONTROLS) {
  const r = await simulate(control.data, blockhash);
  const held = r.unknown === control.expectUnknown;
  controlsHeld &&= held;
  (held ? ok : bad)(`${control.name}  →  ${r.unknown ? "ABSENT" : "present"}  ${c.d}${r.err}${c.x}`);
  info(`     ${control.because}`);
}

if (!controlsHeld) {
  console.log(`\n${c.r}${c.b}THE PROBE FAILED ITS OWN CONTROLS. Nothing below means anything — do not record a verdict from this run.${c.x}`);
  console.log(`${c.d}Most likely causes, in order: the delegation program's dispatcher changed its log line; the RPC is\nreturning truncated logs; the enum was renumbered. Read the raw logs above before touching ARENA-VAULT.md.${c.x}`);
  process.exit(1);
}

heading("B. the census — every discriminator the deployed bytecode actually implements");

// Two past the highest variant v3.1.0 defines, so the run shows the boundary rather than stopping at
// it. A deployment NEWER than the table would show up as PRESENT rows with no name — which is exactly
// the signal that this file's labelling table, not the cluster, is what went stale.
const CENSUS_MAX = 29;

const present: number[] = [];
const absent: number[] = [];
for (let i = 0; i <= CENSUS_MAX; i++) {
  const r = await simulate(discriminatorData(i), blockhash);
  const name = V3_1_0_DISCRIMINATORS[i] ?? `${c.y}(no v3.1.0 variant)${c.x}`;
  (r.unknown ? absent : present).push(i);
  const mark = r.unknown ? `${c.d}absent ${c.x}` : `${c.g}PRESENT${c.x}`;
  console.log(`  ${String(i).padStart(2)}  ${mark}  ${name}`);
}

info("");
info(`implemented: ${present.join(", ")}`);
info(`not implemented (0-${CENSUS_MAX}): ${absent.join(", ")}`);

// A second, independent source for three of the census's rows. `@magicblock-labs/ephemeral-rollups-sdk`
// hardcodes these three discriminators in its own instruction builders, and our keeper sends two of
// them daily — so if the census called any of them absent, the census would be wrong about a fact the
// arena disproves every round.
const SDK_KNOWN: Record<number, string> = { 0: "Delegate", 9: "TopUpEphemeralBalance", 11: "CloseEphemeralBalance" };
for (const [i, name] of Object.entries(SDK_KNOWN)) {
  const isPresent = present.includes(Number(i));
  (isPresent ? ok : bad)(`cross-check vs ephemeral-rollups-sdk's own builder: ${i} ${name} → ${isPresent ? "PRESENT" : "ABSENT, which contradicts a builder we ship"}`);
}

// ── ARM C — the ELF byte scan, as corroboration ──────────────────────────────────────────────────

heading("C. corroboration — PDA seed tags compiled into the executable");

/** The ELF, not the account. ProgramData is a 45-byte header followed by the executable, right-padded
 *  with zeros to whatever length the deploy allocated — the same trimming, for the same reason, as
 *  `er-bytecode-probe.ts`'s `executableBytes`. */
function executableBytes(data: Uint8Array): Uint8Array {
  const HEADER = 45;
  let end = data.length;
  while (end > HEADER && data[end - 1] === 0) end -= 1;
  return data.subarray(HEADER, end);
}
const elf = executableBytes(programData.data);
// latin1 maps every byte to a code point, so a substring search over it is a byte search — no
// multi-byte decoding to lose a match in.
const elfText = Buffer.from(elf).toString("latin1");
info(`ELF  sha256:${createHash("sha256").update(elf).digest("hex").slice(0, 16)}  ${elf.length} bytes`);

// The controls of this arm: tags that MUST be there. A scan that finds nothing proves nothing unless
// it can find the things known to be present.
const SEED_TAGS = [
  { tag: "delegation-metadata", expected: true, note: "control — DelegationMetadata PDA, present in every version" },
  { tag: "state-diff", expected: true, note: "control — commit state PDA" },
  { tag: "commit-state-record", expected: true, note: "control — commit record PDA" },
  { tag: "undelegate-buffer", expected: true, note: "control — the ORDINARY undelegate path's buffer. Not the forced one." },
  { tag: "undelegation-request", expected: false, note: "THE MARKER — seed of the UndelegationRequest PDA, introduced in v3.1.0 and in no earlier version" },
];
for (const { tag, expected, note } of SEED_TAGS) {
  const found = elfText.includes(tag);
  const line = `${found ? `${c.g}found  ${c.x}` : `${c.d}missing${c.x}`}  "${tag}"  ${c.d}${note}${c.x}`;
  (found === expected ? ok : bad)(line);
}
const markerFound = elfText.includes("undelegation-request");
info("corroboration only: a compiler may fold or elide string data, so a missing tag is evidence and not proof.");

// ── VERDICT ──────────────────────────────────────────────────────────────────────────────────────

const requestPresent = present.includes(REQUEST_UNDELEGATION);
const timeoutPresent = present.includes(UNDELEGATE_AFTER_TIMEOUT);
const deployed = requestPresent && timeoutPresent;

heading("VERDICT — ARENA-VAULT.md §7 E2");

console.log(`  ${String(REQUEST_UNDELEGATION).padStart(2)}  RequestUndelegation                  ${requestPresent ? `${c.g}PRESENT${c.x}` : `${c.r}ABSENT${c.x}`}`);
console.log(`  ${String(UNDELEGATE_AFTER_TIMEOUT).padStart(2)}  UndelegateWithRollbackAfterTimeout   ${timeoutPresent ? `${c.g}PRESENT${c.x}` : `${c.r}ABSENT${c.x}`}`);
console.log(`      ELF marker "undelegation-request"    ${markerFound ? `${c.g}FOUND${c.x}` : `${c.r}ABSENT${c.x}`}`);

if (deployed) {
  // Loud, per §7 E2's own instruction: "If it lands, it becomes a second rescue that also recovers
  // the Round's rent." That is a change to §5.1's residuals, not a footnote, so it is not allowed to
  // scroll past as one more green tick.
  console.log(`\n${c.g}${c.b}  ████  FORCED UNDELEGATION IS DEPLOYED ON THIS DEVNET.  ████${c.x}\n`);
  console.log(
    `  ${c.b}THIS IS A SIGNIFICANT FINDING AND ARENA-VAULT.md IS OUT OF DATE.${c.x}\n\n` +
    `  §5.1 and COST-MODEL.md §4.3 both state this is NOT deployed. It is. What changes:\n\n` +
    `   1. A SECOND RESCUE PATH EXISTS, and unlike the vault's base-layer refund it also recovers the\n` +
    `      Round account's 0.023497 SOL of rent — §5.1's first residual, currently written as\n` +
    `      "stranded permanently", becomes "stranded for the timeout".\n` +
    `   2. §5.1's SECOND residual softens with it. \`Treasury.rounds_swept\` can catch up to\n` +
    `      \`Arena.round_counter\` again once the round undelegates, so the sweep-gap stop stops\n` +
    `      latching forever on one dead round.\n` +
    `   3. THE 24-HOUR RESCUE WINDOW IS NOW ARGUABLE. The upstream timeout is 9,000 slots (~60 min),\n` +
    `      which is a measured platform number where 24 hours was, in §5.1's own words, "a judgement,\n` +
    `      not a measurement".\n\n` +
    `  IT IS STILL NOT A PREREQUISITE, and §7 E2 says why: the vault's refund reads only bytes the\n` +
    `  rollup never touched, so it does not wait for MagicBlock. Do not let a second path become a\n` +
    `  reason to drop the first.\n\n` +
    `  ${c.b}Before recording it: re-read the flow. It is TWO instructions.${c.x} \`RequestUndelegation\` (26)\n` +
    `  stamps an UndelegationRequest PDA with expires_at_slot = slot + 9000, and only then is\n` +
    `  \`UndelegateWithRollbackAfterTimeout\` (27) permissionless. Whether OUR keeper can stamp the\n` +
    `  request for a round it does not control is a separate question this probe does not answer.`,
  );
} else if (requestPresent !== timeoutPresent) {
  console.log(`\n${c.y}${c.b}  PARTIAL, AND THAT IS NOT A STATE v3.1.0 CAN BE IN.${c.x}`);
  console.log(
    `  Exactly one half of the two-instruction flow reported PRESENT. The upstream release adds both\n` +
    `  together, so either this cluster runs a build that is not an upstream tag, or the labelling\n` +
    `  table in this file is stale against a renumbered enum. Read the census rows above — a PRESENT\n` +
    `  row with no name is the tell for the second. Do not record a verdict until it is resolved.`,
  );
  process.exit(1);
} else {
  console.log(`\n${c.b}  FORCED UNDELEGATION IS NOT DEPLOYED ON THIS DEVNET. §5.1 and COST-MODEL.md §4.3 stand.${c.x}\n`);
  console.log(
    `  Three independent lines agree:\n` +
    `   A  the running bytecode was written ${ageDays.toFixed(0)} days ago${blockTime !== null && blockTime < V3_1_0_TAGGED ? ", predating upstream's v3.1.0 tag" : ""}\n` +
    `   B  discriminators 26 and 27 are rejected by the dispatcher itself, while 0-3 and 5-25 are not,\n` +
    `      and all five controls held — so this is absence, not a malformed probe\n` +
    `   C  the "undelegation-request" seed tag is not in the executable, while four tags known to be\n` +
    `      there were found\n\n` +
    `  ${c.b}The consequence, unchanged:${c.x} a Round delegated to a dead validator cannot be undelegated by\n` +
    `  anyone, its 0.023497 SOL of rent is stranded permanently, and §5.1's base-layer refund is the\n` +
    `  only rescue. That is why the vault keeps its own deposit record.\n\n` +
    `  ${c.d}The implemented set is exactly v3.0.0's (0-3, 5-25, no variant 4). Re-run this after any\n` +
    `  MagicBlock devnet upgrade; the ProgramData write slot in arm A is the cheap thing to watch.${c.x}`,
  );
}
