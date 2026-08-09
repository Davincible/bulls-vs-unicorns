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

/** A `BN` off a decoded account THAT MAY NOT BE THERE AT ALL, as a `bigint`.
 *
 *  Anchor decodes against whatever IDL this build shipped with, and that IDL can be a revision AHEAD
 *  of the program actually deployed — the normal state of affairs for the minutes or days between a
 *  program change and its deploy, and the permanent state for anyone pointing this app at an older
 *  arena. Fields added in the newer revision come back `undefined`, and `undefined.toString()` throws
 *  at the point of the read: one field the chain has not heard of yet, and the page can read no round
 *  at all.
 *
 *  ZERO IS NOT A PLACEHOLDER, WHICH IS WHY THIS IS SAFE. A revision that has never heard of
 *  `fees_collected` never collected any; a round with no `lobby_closes_at` has no deadline. In both
 *  cases zero is the true value, so every conservation identity in this repo stays exact when read
 *  through here — see `Round.fees_collected` in lib.rs.
 *
 *  It lives in THIS file, next to the shapes it defends, rather than beside either of its two callers
 *  (chain/useRound.ts, v2/data/roundLog.ts). Both decode the same accounts against the same IDL and
 *  face the same skew; the version that lived privately in one of them left the other reading new
 *  fields bare, which is exactly how `penalties_collected` acquired a latent throw that survived
 *  until `fees_collected` was added beside it. */
export function bnOr0(value: { toString(): string } | undefined | null): bigint {
  return value === undefined || value === null ? 0n : BigInt(value.toString());
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
  /** The arena's entry fee, cumulative over every `enter` this round saw, top-ups included. The fee
   *  was charged from the first day of the program and recorded nowhere until this revision — see
   *  `Round.fees_collected` in lib.rs for why (a rollup transaction cannot write the base-layer
   *  `Arena`, so the round was the only writable home for it).
   *
   *  It matters to a READER of this account because `pot` is the sum of NET stakes: `pot` alone is
   *  not what players were charged. `pot + feesCollected` is.
   *
   *  OPTIONAL, AND THAT IS NOT DEFENSIVENESS — IT IS THE TRUTH ABOUT TODAY. `public/idl/bulls_arena
   *  .json` is fetched at runtime and is a contract with the DEPLOYED program, not with lib.rs.
   *  The deployed program's `Round` has fifteen fields; this one and `houseSwept` are the sixteenth
   *  and seventeenth, and they arrive only once the matching program is deployed. Until then Anchor
   *  decodes without them and hands back `undefined`.
   *
   *  Serving the seventeen-field IDL early is not a shortcut around that — it was tried, and borsh
   *  walked nine bytes off the end of every real round account (`Invalid bool: 205`) and took the
   *  live page down. The IDL must lag the source until the deploy lands.
   *
   *  So `undefined` is a state this app is IN, not one it might reach, and typing this as a plain
   *  `BN` would be a lie the compiler would then help enforce. Read it through `bnOr0`, which is
   *  where the optionality stops: everything downstream gets a plain `bigint`. */
  feesCollected?: BN;
  /** Has `sweep_house_take` already moved this round's fees and penalties onto the arena's
   *  `Treasury`? The sweep leaves the totals in place for auditing, so this flag is the only thing
   *  that distinguishes a swept round from an unswept one.
   *
   *  Optional for the same reason as `feesCollected` above, and read as `?? false` — a program that
   *  has no sweep instruction has swept nothing, so `false` is the true value there. */
  houseSwept?: boolean;
  seedCommit: number[];
  seed: number[];
  /** On-chain unix seconds: when `open_round` stamped the lobby, and when it stops taking entries.
   *  The program enforces both ends (`enter` refuses at or after `lobbyClosesAt`,
   *  `close_lobby_and_draw` refuses before it), so a countdown drawn from these is the same clock the
   *  chain is keeping — see `Round.lobby_opened_at` in lib.rs. Both are needed, not just the
   *  deadline: the remaining time comes from `lobbyClosesAt`, but a progress bar needs the duration,
   *  which is the difference. */
  lobbyOpenedAt: BN;
  lobbyClosesAt: BN;
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
    /** `lobbySeconds` is a DURATION the chain adds to its own clock, clamped on-chain to
     *  [MIN_LOBBY_SECONDS, MAX_LOBBY_SECONDS] — passing an out-of-range value succeeds with the
     *  clamped one rather than failing, and the round records what was actually used. */
    openRound(roundNo: BN, seedCommit: number[], lobbySeconds: number): MethodsBuilder;
    delegateRound(roundNo: BN): MethodsBuilder;
    enter(side: number, stake: BN): MethodsBuilder;
    closeLobbyAndDraw(clientSeed: number[]): MethodsBuilder;
    /** `steps` is a u32 hint — the program runs `min(steps, backlog)`; see chain/round.ts's `tick`. */
    tick(steps: number): MethodsBuilder;
    extract(): MethodsBuilder;
    resolve(): MethodsBuilder;
    /** The terminal state for a lobby that hit its deadline with fewer than two fighters — it can
     *  never fight, so this ends it and undelegates in one call. Permissionless; every precondition
     *  is on the account. See `abandon_round` in lib.rs. */
    abandonRound(): MethodsBuilder;
    closeRound(): MethodsBuilder;
    /** THE THREE HOUSE-BOOKS INSTRUCTIONS. Declared here because `chain/round.ts` builds all three;
     *  see that file for what each one is for.
     *
     *  THEY TYPE-CHECK BEFORE THEY WORK, and the gap is worth stating once rather than being
     *  rediscovered from a runtime error. This interface is hand-written against lib.rs. Anchor
     *  builds instructions from the IDL FETCHED AT RUNTIME, which is a contract with the deployed
     *  program and currently predates all three — so `program.methods.sweepHouseTake` is `undefined`
     *  at runtime today and calling it throws, with nothing the compiler can say about it.
     *
     *  That is the right way round, and deliberately not fixed by deleting these. The alternative is
     *  serving an IDL ahead of the deploy, which breaks decoding for every account the program
     *  already owns (see `feesCollected` above for the incident). A caller that must not fail on an
     *  older deployment should check `arena.feeBps`-style evidence or guard on the presence of the
     *  method, not on the type. */
    setFeeBps(feeBps: number): MethodsBuilder;
    initTreasury(): MethodsBuilder;
    /** `roundNo` is a seeds argument — the program derives the round PDA from it and checks it
     *  against the account passed in, so it is not redundant with `accounts({ round })`. */
    sweepHouseTake(roundNo: BN): MethodsBuilder;
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
