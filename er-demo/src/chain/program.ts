// Anchor's `Program<IDL extends Idl>` only gets its nice per-account/per-method typing (`.methods.enter(...)`,
// `.account.round.fetch(...)`) when `IDL` is a literal const type, e.g. a statically-imported IDL module
// with `as const`. This app loads the IDL at RUNTIME (chain/idl.ts — the same module both the browser
// bundle and Node/Bun scripts use, see its own comment on why), so TypeScript only ever sees the base
// `Idl` interface, under which `Program<Idl>["account"]` and `["methods"]` have no named keys at all
// (`Property 'round' does not exist on type 'AccountNamespace<Idl>'`, confirmed while building this).
//
// Rather than reach for `any` at every call site, this file hand-writes the exact structural surface
// this app actually uses — verified against public/idl/bulls_arena.json and a runtime probe of
// `program.idl.types` (see chain/useRound.ts's own note on that). One cast bridges Anchor's loose
// runtime type into this precise one, contained to `createProgram` below; every other file in chain/
// gets full type-checking against a shape that matches the real, camelCased, on-chain IDL.

import { AnchorProvider, Program, type BN, type Wallet } from "@coral-xyz/anchor";
import type { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { loadIdl } from "./idl.ts";

/** The chainable shape every `program.methods.x(...)` call returns, up through `.transaction()` —
 *  matches (and is assignable to) chain/sendTx.ts's `TransactionBuilder`.
 *
 *  `accounts()` allows `PublicKey | null` per key, not just `PublicKey`, because of `enter`/
 *  `extract`'s `session_token: Option<Account<SessionToken>>` (Phase 6, Session Keys) — Anchor's own
 *  account resolver (`resolveOptionalsHelper` in `@coral-xyz/anchor`'s `accounts-resolver.js`)
 *  requires an EXPLICIT `null` for an absent optional account, which it then substitutes with the
 *  program's own id (the sentinel `Option::None` reads as on-chain); omitting the key entirely
 *  leaves it unresolved and the transaction build throws. See chain/round.ts's `enter`/`extract`. */
export interface MethodsBuilder {
  accounts(accounts: Record<string, PublicKey | null>): MethodsBuilder;
  preInstructions(ixs: TransactionInstruction[]): MethodsBuilder;
  signers(signers: { publicKey: PublicKey }[]): MethodsBuilder;
  /** Needed for exactly one thing: pinning `delegate_round` to a SPECIFIC ER validator, which the
   *  delegation CPI reads from `remaining_accounts[0]`. That is not a nicety — MagicBlock's
   *  validators cache program bytecode per program id and do not re-clone it after a base-layer
   *  upgrade (MAGICBLOCK_FEEDBACK.md), so after every deploy the router's default choice may run old
   *  code, and the only way to land a round on a validator with a current clone is to name it. */
  remainingAccounts(accounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]): MethodsBuilder;
  transaction(): Promise<Transaction>;
}

export interface RawFighter {
  wallet: PublicKey;
  side: number;
  dead: number;
  stake: BN;
  hp: BN;
  banked: BN;
}

export interface RawRoundAccount {
  arena: PublicKey;
  roundNo: BN;
  phase: number;
  winner: number;
  bump: number;
  fighterCount: number;
  tickCount: BN;
  pot: BN;
  /** Extract penalties this round has paid out to the house, cumulative. Value LEAVES the round now,
   *  so `sum(hp + banked)` no longer equals `pot` on its own — this is the term that closes the gap
   *  (see `Round.penalties_collected` in lib.rs, and `ui/verifyRound.ts`). */
  penaltiesCollected: BN;
  seedCommit: number[];
  seed: number[];
  fightStartedAt: BN;
  fighters: RawFighter[];
}

export interface RawArenaAccount {
  authority: PublicKey;
  tokenA: PublicKey;
  tokenB: PublicKey;
  roundCounter: BN;
  feeBps: number;
  bump: number;
}

export interface BullsArenaProgram {
  methods: {
    initArena(feeBps: number, tokenA: PublicKey, tokenB: PublicKey): MethodsBuilder;
    openRound(roundNo: BN, seedCommit: number[]): MethodsBuilder;
    delegateRound(roundNo: BN): MethodsBuilder;
    enter(side: number, stake: BN): MethodsBuilder;
    closeLobbyAndDraw(clientSeed: number[]): MethodsBuilder;
    /** `steps` is a u32 hint — the program runs `min(steps, backlog)`; see chain/round.ts's `tick`. */
    tick(steps: number): MethodsBuilder;
    extract(): MethodsBuilder;
    resolve(): MethodsBuilder;
    closeRound(): MethodsBuilder;
  };
  account: {
    arena: {
      fetch(pda: PublicKey): Promise<RawArenaAccount>;
      fetchNullable(pda: PublicKey): Promise<RawArenaAccount | null>;
    };
    round: {
      fetch(pda: PublicKey): Promise<RawRoundAccount>;
      fetchNullable(pda: PublicKey): Promise<RawRoundAccount | null>;
    };
  };
}

const CONFIRM_OPTS = { commitment: "confirmed", preflightCommitment: "confirmed" } as const;

/** Builds a fully-typed `BullsArenaProgram` bound to `connection`/`wallet`. Fetches (and caches, via
 *  `loadIdl`'s own cache) the IDL on first call. */
export async function createProgram(connection: Connection, wallet: Wallet): Promise<BullsArenaProgram> {
  const idl = await loadIdl();
  const provider = new AnchorProvider(connection, wallet, CONFIRM_OPTS);
  // THE bridge cast — see this file's header comment for why it's needed and why it's safe: the
  // structural shape above was verified against the real IDL, not guessed.
  return new Program(idl, provider) as unknown as BullsArenaProgram;
}
