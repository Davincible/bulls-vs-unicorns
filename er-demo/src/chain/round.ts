// Instruction-builder wrappers for the bulls-arena program — thin, one function per instruction,
// each returning an Anchor `MethodsBuilder` (NOT yet `.transaction()`'d) so callers pass it straight
// into `sendTx()`. Account lists and args are ported exactly from
// engine/scripts/er-client-canary.mjs, which already worked out every PDA and account for each
// instruction against real devnet. Anchor camel-cases the raw (snake_case) IDL at `new Program(...)`
// time — every key below is the camelCase form (see chain/idl.ts's own note on this).

import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
// BN from anchor's own re-export, not a direct `bn.js` dependency — anchor's runtime does
// `instanceof BN` checks when encoding u64 args, which only pass against ITS copy of the class, not
// a separately-resolved one from a second `bn.js` install.
import { BN } from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { DEFAULT_EPHEMERAL_QUEUE, MAX_STEPS, PROGRAM_ID, SLOT_HASHES_SYSVAR, VRF_PROGRAM_ID } from "./constants.ts";
import type { BullsArenaProgram } from "./program.ts";

const textEncoder = new TextEncoder();

/** The ceiling a Solana transaction can request. `resolve` and `extract` both ask for it because both
 *  can, in the worst case, have to run the whole fight (MAX_STEPS steps) in one call — see
 *  `catch_up`'s doc comment in lib.rs. Matches CU_CEILING in engine/scripts/er-cu-bench.mjs. */
const CU_CEILING = 1_400_000;

/** Upper bound on one fight step, from the task-#15 re-measurement: the real cost falls from ~271 to
 *  ~198 CU/step as fighters die, so 300 is a ceiling rather than an average — a `tick` sized with this
 *  cannot run out of budget partway and leave the round mid-flight. The default 200,000 CU budget
 *  would silently cover a small tick and fail on a large one, which is the kind of intermittent
 *  failure that is worst to diagnose. */
const CU_PER_STEP = 300;
const CU_TX_OVERHEAD = 40_000;

/** u64, little-endian — the exact byte layout the program's `round` PDA seeds expect. Built on
 *  DataView/Uint8Array rather than Node's Buffer so this file has no browser-polyfill dependency of
 *  its own (`PublicKey.findProgramAddressSync` accepts `Buffer | Uint8Array` seeds either way). */
export function u64le(n: bigint | number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(n), true);
  return new Uint8Array(buf);
}

export function arenaPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode("arena")], programId)[0];
}

export function roundPdaForRoundNo(
  roundNo: bigint | number,
  arena: PublicKey = arenaPda(),
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode("round"), arena.toBuffer(), u64le(roundNo)],
    programId,
  )[0];
}

export function programIdentityPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode("identity")], programId)[0];
}

// ---- init_arena -----------------------------------------------------------------------------
export function initArena(
  program: BullsArenaProgram,
  params: { arena: PublicKey; authority: PublicKey; feeBps: number; tokenA?: PublicKey; tokenB?: PublicKey },
) {
  return program.methods
    .initArena(params.feeBps, params.tokenA ?? PublicKey.default, params.tokenB ?? PublicKey.default)
    .accounts({
      arena: params.arena,
      authority: params.authority,
      systemProgram: SystemProgram.programId,
    });
}

// ---- open_round -------------------------------------------------------------------------------
export function openRound(
  program: BullsArenaProgram,
  params: { arena: PublicKey; round: PublicKey; authority: PublicKey; roundNo: bigint | number; seedCommit: Uint8Array },
) {
  return program.methods
    .openRound(new BN(params.roundNo.toString()), Array.from(params.seedCommit))
    .accounts({
      arena: params.arena,
      round: params.round,
      authority: params.authority,
      systemProgram: SystemProgram.programId,
    });
}

// ---- delegate_round — hand the round to the ER validator ---------------------------------------
// `validator` pins the round to a SPECIFIC ER validator identity instead of taking whichever one the
// router picks. Optional, and normally omitted — but it is the documented recovery for MagicBlock's
// bytecode cache: validators clone a program's executable on first use and do not re-clone it after a
// base-layer upgrade, so immediately after a deploy the router's default may still be running the old
// code (MAGICBLOCK_FEEDBACK.md, MEGA_QUEUE.md task #15). The delegation CPI reads it from
// `remaining_accounts[0]` — see `DelegateConfig.validator` in `delegate_round`.
export function delegateRound(
  program: BullsArenaProgram,
  params: {
    arena: PublicKey; round: PublicKey; authority: PublicKey; roundNo: bigint | number;
    programId?: PublicKey; validator?: PublicKey;
  },
) {
  const programId = params.programId ?? PROGRAM_ID;
  const bufferPda = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(params.round, programId);
  const recordPda = delegationRecordPdaFromDelegatedAccount(params.round);
  const metadataPda = delegationMetadataPdaFromDelegatedAccount(params.round);
  const builder = program.methods
    .delegateRound(new BN(params.roundNo.toString()))
    .accounts({
      authority: params.authority,
      arena: params.arena,
      bufferRoundPda: bufferPda,
      delegationRecordRoundPda: recordPda,
      delegationMetadataRoundPda: metadataPda,
      roundPda: params.round,
      ownerProgram: programId,
      delegationProgram: DELEGATION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    });
  return params.validator
    ? builder.remainingAccounts([{ pubkey: params.validator, isSigner: false, isWritable: false }])
    : builder;
}

// ---- enter — player joins a side with a stake ---------------------------------------------------
//
// SESSION KEYS (Phase 6). `player` is the fighter identity credited on-chain — unchanged by which
// key actually signs. `signer` is whoever DOES sign this transaction: the session key when a
// session is active, or `player`'s own wallet directly when it isn't (the pre-Phase-6 behaviour).
// `sessionToken` is the on-chain `SessionToken` PDA when a session is active, or `null` when not —
// `null` is REQUIRED, not merely permitted, when there's no session: see `MethodsBuilder.accounts`'s
// own doc comment in chain/program.ts for why omitting the key entirely doesn't work. Callers with
// no active session pass `signer: params.player, sessionToken: null` — chain/session/
// useSessionKeyManager.ts's `ActiveSession` is `null` in exactly that case, so this shape falls out
// of the caller naturally rather than needing an if/else at every call site (see EnterForm.tsx).
export function enter(
  program: BullsArenaProgram,
  params: {
    arena: PublicKey;
    round: PublicKey;
    player: PublicKey;
    signer: PublicKey;
    sessionToken: PublicKey | null;
    side: 0 | 1;
    stake: bigint | number;
  },
) {
  return program.methods
    .enter(params.side, new BN(params.stake.toString()))
    .accounts({
      arena: params.arena,
      round: params.round,
      player: params.player,
      sessionToken: params.sessionToken,
      signer: params.signer,
    });
}

// ---- close_lobby_and_draw — request randomness from the VRF oracle ------------------------------
export function closeLobbyAndDraw(
  program: BullsArenaProgram,
  params: { payer: PublicKey; round: PublicKey; clientSeed: Uint8Array; programId?: PublicKey },
) {
  const programId = params.programId ?? PROGRAM_ID;
  return program.methods
    .closeLobbyAndDraw(Array.from(params.clientSeed))
    .accounts({
      payer: params.payer,
      round: params.round,
      oracleQueue: DEFAULT_EPHEMERAL_QUEUE,
      programIdentity: programIdentityPda(programId),
      vrfProgram: VRF_PROGRAM_ID,
      slotHashes: SLOT_HASHES_SYSVAR,
      systemProgram: SystemProgram.programId,
    });
}

// ---- extract — bank a fighter's current hp and stop it being a valid target -----------------------
//
// SESSION KEYS (Phase 6). Same `player`/`signer`/`sessionToken` shape as `enter` — see that
// function's own comment. Extract is the mid-fight decision under real time pressure, so it's the
// instruction Session Keys matters most for: no fresh wallet popup once a session is active.
// The CU ceiling is NOT belt-and-braces here. `extract` now brings the fight up to the current
// on-chain second before it banks anything (lib.rs `catch_up`) — because otherwise the payout would
// depend on whether anyone had bothered to `tick` recently, which is the free-refund bug wearing a
// different hat. In the normal case that is a handful of steps; on a round nobody has ticked it can
// be the whole fight, and an extract that failed on compute budget at the moment a player pressed the
// button would be the single worst failure this app has.
export function extract(
  program: BullsArenaProgram,
  params: { round: PublicKey; player: PublicKey; signer: PublicKey; sessionToken: PublicKey | null },
) {
  return program.methods
    .extract()
    .accounts({
      round: params.round,
      player: params.player,
      sessionToken: params.sessionToken,
      signer: params.signer,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: CU_CEILING })]);
}

// ---- tick — advance the live fight, mid-round, in the rollup ---------------------------------------
//
// Permissionless: no player, no session token, no authority — just the round account and whoever pays
// the fee. It cannot advance the fight past where real elapsed time already says it is, so there is
// nothing for an authority check to protect (see `tick`'s doc comment in lib.rs).
//
// `steps` is a hint: the program runs `min(steps, backlog)` and succeeds having done nothing when the
// fight is already up to date, so two clients ticking the same round never fail each other's calls.
// The CU limit is sized from the REQUESTED steps rather than the ceiling — a tick is meant to be the
// cheap, frequent call, and asking for 1.4M CU to run four steps would misreport what it costs.
export function tick(program: BullsArenaProgram, params: { round: PublicKey; steps: number }) {
  const steps = Math.max(1, Math.min(Math.floor(params.steps), MAX_STEPS));
  return program.methods
    .tick(steps)
    .accounts({ round: params.round })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({
        units: Math.min(CU_CEILING, CU_TX_OVERHEAD + steps * CU_PER_STEP),
      }),
    ]);
}

// ---- resolve — finalises the round: catches the fight up, picks the winner, commits -----------------
// Takes NO arguments (security fix — steps are derived from real on-chain elapsed time, not a
// caller-supplied count). Still asks for the full ceiling: `tick` normally leaves it almost nothing to
// do, but a round nobody ticked makes it run the whole fight, exactly as the old one-shot resolve did.
export function resolve(program: BullsArenaProgram, params: { payer: PublicKey; round: PublicKey }) {
  return program.methods
    .resolve()
    .accounts({
      payer: params.payer,
      round: params.round,
      magicProgram: MAGIC_PROGRAM_ID,
      magicContext: MAGIC_CONTEXT_ID,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: CU_CEILING })]);
}

// ---- close_round — commit_and_undelegate back to the base layer -------------------------------------
export function closeRound(program: BullsArenaProgram, params: { payer: PublicKey; round: PublicKey }) {
  return program.methods
    .closeRound()
    .accounts({
      payer: params.payer,
      round: params.round,
      magicProgram: MAGIC_PROGRAM_ID,
      magicContext: MAGIC_CONTEXT_ID,
    });
}
