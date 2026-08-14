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
import {
  DEFAULT_EPHEMERAL_QUEUE,
  DEFAULT_LOBBY_SECONDS,
  MAX_STEPS_PER_CALL,
  PROGRAM_ID,
  SLOT_HASHES_SYSVAR,
  VRF_PROGRAM_ID,
} from "./constants.ts";
import type { BullsArenaProgram } from "./program.ts";

const textEncoder = new TextEncoder();

/** The ceiling a Solana transaction can request. `resolve` and `extract` both ask for it because
 *  `catch_up` (lib.rs) is bounded per call at `MAX_STEPS_PER_CALL` steps, not per fight — a call can,
 *  in the worst case, have to run that many steps of backlog, and 3,000 * CU_PER_STEP + CU_TX_OVERHEAD
 *  still fits comfortably under this with room to spare (940,000 of 1,400,000).
 *
 *  THIS NO LONGER MEANS ONE CALL FINISHES THE FIGHT. A round nobody ticked can carry up to
 *  `finalCursor(fighterCount)` steps of backlog — 17,280 at 48 fighters — and `MAX_STEPS_PER_CALL`
 *  caps every call, `resolve` included, at 3,000 of them. A neglected 48-fighter round needs up to six
 *  `resolve` calls to grind through its backlog before it can settle; this constant only sizes what ONE
 *  of those calls may cost, not how many are needed. Matches CU_CEILING in
 *  engine/scripts/er-cu-bench.mjs. */
const CU_CEILING = 1_400_000;

/** Upper bound on one fight step, from the task-#15 re-measurement: the real cost falls from ~271 to
 *  ~198 CU/step as fighters die, so 300 is a ceiling rather than an average — a `tick` sized with this
 *  cannot run out of budget partway and leave the round mid-flight. The default 200,000 CU budget
 *  would silently cover a small tick and fail on a large one, which is the kind of intermittent
 *  failure that is worst to diagnose.
 *
 *  STILL VALID AFTER THE MAX_STEPS SPLIT: this is a per-step measurement, independent of how many
 *  steps any one call is allowed to request. The request itself is now clamped tighter — at most
 *  `MAX_STEPS_PER_CALL` (3,000) rather than the old MAX_STEPS (4,000) — so the headroom under
 *  CU_CEILING this was sized against has only grown. */
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

/** The arena's house books — `Treasury`, one per arena, written only by `sweepHouseTake`.
 *
 *  Derived here rather than resolved from the IDL, like every other PDA in this file. That is not
 *  only consistency: `delegate_round.buffer_round_pda` spent a whole deployment cycle with its
 *  `pda.program` pinned to a previous program id in the committed IDL, and the reason nothing broke
 *  is precisely that this file derives PDAs itself instead of letting anchor's resolver do it. */
export function treasuryPda(arena: PublicKey = arenaPda(), programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode("treasury"), arena.toBuffer()],
    programId,
  )[0];
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
// `lobbySeconds` is how long the lobby stays open, in seconds, from the moment the transaction lands.
// The chain stamps both `lobby_opened_at` and `lobby_closes_at` from its own clock and clamps the
// duration into [MIN_LOBBY_SECONDS, MAX_LOBBY_SECONDS] — so an out-of-range value opens a clamped
// lobby rather than failing, and the round records what was actually used. Defaulted here rather than
// made mandatory: every caller wants the same demo-cadence number, and the one that doesn't (a
// verification script that has to wait the deadline out) is better off saying so explicitly.
export function openRound(
  program: BullsArenaProgram,
  params: {
    arena: PublicKey; round: PublicKey; authority: PublicKey; roundNo: bigint | number;
    seedCommit: Uint8Array; lobbySeconds?: number;
  },
) {
  return program.methods
    .openRound(
      new BN(params.roundNo.toString()),
      Array.from(params.seedCommit),
      params.lobbySeconds ?? DEFAULT_LOBBY_SECONDS,
    )
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
//
// TWO WAYS TO CLOSE A LOBBY, and `authority` is what picks between them.
//
// WITHOUT it this is the permissionless call it has always been: legal once the deadline has passed,
// or once the lobby is full, and refused with `LobbyStillOpen` otherwise.
//
// WITH it — and it must be the arena's own authority, or the program answers `NotTheAuthority` rather
// than falling through — the deadline is bypassed and the fight starts now. That is what lets a
// keeper hold ONE lobby open indefinitely and begin the moment a real player joins, instead of
// cycling rounds on a timer. The saving is rent: every cycle sinks ~0.023497 SOL into a `Round`
// account whether or not anybody played. (That was ~0.0085 when this note was written at
// `MAX_FIGHTERS = 16`; the 16 -> 48 cap grew the account from 1,102 to 3,248 bytes, so the figure the
// hold-open argument rests on is 2.7x what it used to be — see the rent derivation below.)
//
// THAT RENT IS NO LONGER PERMANENT, WHICH IS A CHANGE FROM WHAT THIS NOTE USED TO SAY. It read
// "nothing ever closes a `Round` account"; as of v7 `closeRoundAccount` does, once a round is
// settled, swept and older than `MIN_RETAINED_ROUNDS`. The argument for holding a lobby open
// survives intact but is now about float rather than loss — an empty cycle ties up the deposit
// until the round ages out of the retention window, instead of forfeiting it forever. Twenty
// rounds of standing rent is ~0.171 SOL, so cycling on a timer is still the more expensive way
// to run this.
//
// It cannot influence the OUTCOME, which is the question to ask of any privileged call in this
// program. The VRF seed is requested by this instruction and delivered afterwards by `callback_seed`,
// so at the instant the authority chooses to close, the seed does not exist for anyone. And it is not
// a new trust assumption: the authority already decides when a lobby OPENS. It is authority-only
// rather than permissionless because an early close DOES decide who is in the round — a player who
// disliked the lineup could otherwise slam the lobby shut and lock the rest out.
//
// `fighterCount >= 2` still binds either way. The authority can choose the moment; it cannot conjure
// a fight out of one entrant.
export function closeLobbyAndDraw(
  program: BullsArenaProgram,
  params: {
    payer: PublicKey; round: PublicKey; clientSeed: Uint8Array;
    arena?: PublicKey; programId?: PublicKey; authority?: PublicKey;
  },
) {
  const programId = params.programId ?? PROGRAM_ID;
  return program.methods
    .closeLobbyAndDraw(Array.from(params.clientSeed))
    .accounts({
      payer: params.payer,
      // Defaulted, like `roundPdaForRoundNo` and `treasuryPda` above: `ARENA_SEED` carries no
      // discriminator, so there is exactly one arena per program and it is derivable rather than
      // something a caller should have to know. The program only reads `arena.authority` from it.
      arena: params.arena ?? arenaPda(programId),
      round: params.round,
      oracleQueue: DEFAULT_EPHEMERAL_QUEUE,
      // `null`, not `undefined` — anchor encodes an omitted optional account as the program id, and
      // it distinguishes "absent" from "present" by that sentinel. Passing `undefined` for a declared
      // optional is the shape that silently becomes a positional mismatch.
      authority: params.authority ?? null,
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
// The CU ceiling is NOT belt-and-braces here. `extract` brings the fight up to the current on-chain
// second before it banks anything (lib.rs `catch_up`) — because otherwise the payout would depend on
// whether anyone had bothered to `tick` recently, which is the free-refund bug wearing a different
// hat. In the normal case that is a handful of steps, and an extract that failed on compute budget at
// the moment a player pressed the button would be the single worst failure this app has.
//
// IT CAN NO LONGER BE "THE WHOLE FIGHT", which is what this comment used to say and is worth
// correcting rather than deleting, because the bound is the whole reason the fighter cap could rise.
// That catch-up is now capped at `MAX_STEPS_PER_CALL` per call. On a round nobody has ticked, one
// extract therefore cannot reach the present at all: the program answers `FightBehind` rather than
// pricing the payout at a stale cursor, and `data/useActions.ts` responds by sending a `tick` and
// retrying. Measured under LiteSVM, this instruction costs 651,018 CU — about 46% of the ceiling it
// asks for. The ask stays at the ceiling because the margin is worth more here than the priority fee
// it costs, but do NOT read that headroom as room to bundle a `tick` into this transaction: the two
// together measure 1,278,835 CU, 91.3%, and `useActions.ts` explains why they are kept apart.
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
  const steps = Math.max(1, Math.min(Math.floor(params.steps), MAX_STEPS_PER_CALL));
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

// ---- abandon_round — end a lobby that died under-subscribed ------------------------------------------
//
// For a round that reached `lobbyClosesAt` holding fewer than two fighters. It can never fight, so
// this is the only thing left that can happen to it: it flips the phase to `Abandoned` and commits +
// undelegates in the SAME call (settlement splits those into `resolve` + `closeRound` so a result is
// readable in the rollup while players watch it — an abandoned round has no result and nobody
// watching, so there is nothing to do between the halves).
//
// Permissionless, like `tick` and `resolve`: every precondition is on the account, so a round whose
// operator has walked away does not need that operator to come back. Nothing is refunded because
// nothing was ever custodied — see `abandon_round` in lib.rs.
export function abandonRound(program: BullsArenaProgram, params: { payer: PublicKey; round: PublicKey }) {
  return program.methods
    .abandonRound()
    .accounts({
      payer: params.payer,
      round: params.round,
      magicProgram: MAGIC_PROGRAM_ID,
      magicContext: MAGIC_CONTEXT_ID,
    });
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

// ---- set_fee_bps — re-price entry ---------------------------------------------------------------
//
// Authority only, and bounded at 1,000 bps (10%) by the program — `MAX_FEE_BPS` in lib.rs, the same
// ceiling `initArena` is held to. Before this existed the rate was welded to the arena's creation, so
// moving 20 bps to 100 bps meant standing up a whole new arena and stranding every round of history
// behind the old one.
//
// It takes effect on the NEXT `enter`, including entries into a lobby that is already open — the
// program reads `arena.fee_bps` live. Re-price between rounds, not during one. See `set_fee_bps` in
// lib.rs for why the rate is not frozen onto the round today and where it should be when `enter`
// moves to the base layer.
export function setFeeBps(
  program: BullsArenaProgram,
  params: { arena: PublicKey; authority: PublicKey; feeBps: number },
) {
  return program.methods
    .setFeeBps(params.feeBps)
    .accounts({ arena: params.arena, authority: params.authority });
}

// ---- init_treasury — open the arena's house books, once -----------------------------------------
//
// Authority only. Separate from `initArena` on purpose so an arena that predates the treasury gains
// one in a single transaction instead of having to be recreated; the cost of the split is that it can
// be forgotten, and `sweepHouseTake` then fails on a missing account until someone runs it.
export function initTreasury(
  program: BullsArenaProgram,
  params: { arena: PublicKey; treasury: PublicKey; authority: PublicKey },
) {
  return program.methods
    .initTreasury()
    .accounts({
      arena: params.arena,
      treasury: params.treasury,
      authority: params.authority,
      systemProgram: SystemProgram.programId,
    });
}

// ---- sweep_house_take — move a finished round's take onto the arena's books ----------------------
//
// THE INSTRUCTION THAT TURNS PER-ROUND HOUSE REVENUE INTO A NUMBER. Both house takes — the entry fee
// (`fees_collected`) and early-exit penalties (`penalties_collected`) — are recorded on the ROUND,
// because that is the only account a rollup transaction can write. This adds one finished round's
// pair onto the arena's `Treasury`.
//
// CALLABLE ONLY AFTER `closeRound` (or `abandonRound`) HAS UNDELEGATED THE ROUND. While the round is
// delegated its base-layer account is owned by the Delegation Program, so the program cannot even
// deserialise it — the failure is an account-owner mismatch, not a phase error. Sequence a keeper as
// resolve -> closeRound -> (undelegation confirms) -> sweepHouseTake.
//
// Permissionless, and once only: the destination is derived from seeds rather than supplied, and
// `Round.house_swept` makes a second sweep fail with `AlreadySwept` rather than silently double-count.
export function sweepHouseTake(
  program: BullsArenaProgram,
  params: { arena: PublicKey; round: PublicKey; treasury: PublicKey; roundNo: bigint | number },
) {
  return program.methods
    .sweepHouseTake(new BN(params.roundNo.toString()))
    .accounts({
      arena: params.arena,
      round: params.round,
      treasury: params.treasury,
    });
}

// ---- close_round_account — reclaim a finished round's rent ---------------------------------------
//
// THE ONLY INSTRUCTION IN THIS PROGRAM THAT DESTROYS ANYTHING. A `Round` is now 3,248 bytes (was
// 1,102 — the 16 -> 48 fighter cap grew the account far more than `house_swept`'s bool -> u8 change
// did), so its rent-exempt deposit is ~0.023497 SOL: (3,248 + 128) * 3,480 lamports/byte-year * 2
// years' exemption threshold, the same formula that produced the old ~0.008561 SOL figure at 1,102
// bytes. STALE, DELIBERATELY DROPPED RATHER THAN GUESSED: the old comment also claimed this was
// "95.4% of the 0.008971 a whole round costs to run", measured on live v6 rounds #3 and #4 — that
// percentage needs a fresh devnet measurement at the new size, which hasn't been taken, so it is not
// restated here. This hands the deposit back to the authority that paid it at `openRound`.
//
// FOUR CONDITIONS, ALL ENFORCED ON CHAIN, none of them the caller's to decide:
//   * the round is `Settled` or `Abandoned`                        — else `RoundNotTerminal`
//   * `sweepHouseTake` has already run on it                       — else `RoundNotSwept`
//   * `roundNo + MIN_RETAINED_ROUNDS <= arena.round_counter`       — else `RoundTooRecent`
//   * the signer is the arena's authority (`has_one`)              — else anchor's `ConstraintHasOne`
//
// AUTHORITY-SIGNED, UNLIKE `sweepHouseTake`, and the difference is deliberate rather than
// inconsistent: a sweep only moves counters to a seed-derived destination, so a stranger running it
// does the operator a favour. This deletes an arena's history, which is not a favour anyone can do
// on someone else's behalf.
//
// THE RETENTION WINDOW IS WHAT MAKES IT SAFE FOR THE UI. `useHistory` reads rounds by address with
// `fetchNullable` and drops nulls, so a closed round leaves the log silently — no error, no gap
// marker — and nothing in `src/` reads events, so there is no path that reconstructs it. The chain
// guaranteeing the newest `MIN_RETAINED_ROUNDS` rounds still exist is the entire safety argument,
// which is why that floor is in the program and not in the keeper's config. Its corollary is that
// anything derived from the round log is a newest-N statistic and may not be labelled "all time".
//
// Like `sweepHouseTake`, callable only once the round has UNDELEGATED: while delegated the account is
// owned by the Delegation Program and `Account<Round>` fails the owner check before it reads a byte.
export function closeRoundAccount(
  program: BullsArenaProgram,
  params: { arena: PublicKey; round: PublicKey; authority: PublicKey; roundNo: bigint | number },
) {
  return program.methods
    .closeRoundAccount(new BN(params.roundNo.toString()))
    .accounts({
      arena: params.arena,
      round: params.round,
      authority: params.authority,
    });
}
