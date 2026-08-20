#!/usr/bin/env bun
// ARENA-VAULT.md §7 E4 — "Two session tokens, one transaction, one signer keypair. Ten lines."
// This is that experiment, and it is not ten lines because a green run has to be unfalsifiable.
//
//   cd er-demo && bun run scripts/probe-two-session-tokens.ts [--fund-from-operator]
//
// WHAT IS BEING ASKED. §6.3 states the hazard: a `SessionToken` is scoped to ONE `target_program`
// (it is a PDA seed), and under custody the two instructions a player signs live in two different
// programs — `arena-vault::enter_delegated` and `bulls-arena::extract`. So a playing session needs
// TWO tokens. §6.3 then asserts the fix — "Both tokens should be created for the same session signer
// keypair in one transaction, two `create_session` instructions, one wallet approval" — and marks it
// **unverified**. Nothing in this repo, and nothing in MagicBlock's documentation, has run it.
//
// WHAT FLIPS IF THE ANSWER FLIPS. If the two instructions do not compose, §6.3's fix is dead and the
// custody session path costs TWO wallet approvals to open and (per the renewal defect below) two more
// to renew — four popups a day for a game whose whole session-key premise is "approve once, then
// play". That is not a papercut; it is the reason the design would have to change shape instead of
// schedule: either `extract` moves into `arena-vault` so one token covers both (which re-couples the
// two programs the split exists to separate — ARENA-VAULT.md §9.2), or session keys are dropped under
// custody and every entry is a wallet dialog mid-lobby. S3 in §8.1 is sequenced on the assumption that
// none of that is necessary. This script is what makes that assumption a measurement.
//
// WHY IT CAN RUN TODAY, BEFORE `arena-vault` EXISTS. The property under test belongs to `gpl_session`,
// not to either target program: `create_session` checks exactly one thing about `target_program` — that
// the account is executable — and then writes its pubkey into a PDA seed. It never calls it, never
// reads it, and has no opinion about what it does. So a second, distinct, real, executable devnet
// program is a complete stand-in for the vault, and the answer transfers verbatim to the real one.
// bulls-arena v1 (F59NksP2…) is used for that: still deployed, still executable, used by nothing,
// never delegated. Waiting for `arena-vault` to exist before answering an `arena-vault` gate was the
// obvious alternative and it is exactly backwards — E4 is in S0 precisely so it cannot surprise S3.
//
// HOW IT CREATES SESSIONS, AND WHAT IT DELIBERATELY DOES NOT USE. Same approach as
// `scripts/verify-session-base.mjs`: `create_session` built directly with `@coral-xyz/anchor` against
// the `gpl_session` IDL shipped in `@magicblock-labs/gum-sdk`. NOT `useSessionKeyManager` — that hook
// holds a single keypair for a single target and cannot be asked for a second token at all
// (`MAGICBLOCK_FEEDBACK.md`: "it generates a keypair only when it has none"), which is the very defect
// §6.3 quotes. Reaching for the hook here would be measuring the limitation instead of the fix.
//
// SAFE TO RUN BESIDE THE LIVE KEEPER — the property `scripts/reclaim-status.ts` was written to have,
// and the reason this one is runnable without stopping production. Every instruction it sends belongs
// to `gpl_session`. It never touches the Arena PDA, never opens/enters/draws/resolves a round, never
// sends a `bulls-arena` instruction, and never signs with the arena authority by default (see step 0).
// The two program ids below appear ONLY as `target_program` bytes inside a PDA seed.
//
// WHAT IT COSTS AND WHO PAYS. Two throwaway keypairs, funded with 0.05 SOL, of which everything except
// transaction fees comes back in step 6. MEASURED, first full run 2026-08-20: net 40,000 lamports
// (0.000040 SOL) — eight transactions at the 5,000-lamport base fee and nothing else. The rent for both
// session tokens and both top-ups was recovered in full. `.devnet/fork-payer.json` — the arena authority
// AND the live keeper's operator key — is NEVER read unless `--fund-from-operator` is passed, and even
// then only as funder and fee payer. See step 0's note on why that is opt-in rather than a fallback.
// (On that first run the public faucet answered "Internal error", which is what made the flag the path
// actually taken rather than the theoretical one — the opt-in is not decoration.)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { TransactionInstruction } from "@solana/web3.js";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { GPLSESSION_PROGRAMS } from "@magicblock-labs/gum-sdk";
import { assertDevnetUrl } from "../src/devnet-guard.ts";
import { BASE_RPC, PROGRAM_ID } from "../src/chain/constants.ts";

// THE GUARD, CALLED HERE RATHER THAN INHERITED. `chain/constants.ts` already asserts this same URL at
// import time, so this line is redundant to the machine and load-bearing to the reader: a script that
// generates keypairs and moves lamports should show its refusal in its own text, not delegate it to a
// side effect two modules away that a future import reshuffle could quietly drop.
assertDevnetUrl(BASE_RPC, "base devnet RPC (probe-two-session-tokens)");

const __dirname = dirname(fileURLToPath(import.meta.url));
const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s: string) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s: string) => console.log(`  ${c.d}${s}${c.x}`);
const warn = (s: string) => console.log(`  ${c.y}!${c.x} ${s}`);
const heading = (s: string) => console.log(`\n${c.b}${s}${c.x}`);
const sol = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

/** Message plus the tail of the program's own logs — the same shape and the same twelve lines as
 *  `verify-session-base.mjs`'s `describeError`, because the failures this script is most likely to hit
 *  (`create_session` on a live account, an unfunded authority) say nothing useful in the message and
 *  everything useful in the logs. */
function describeError(e: unknown): string {
  const withLogs = e as { logs?: string[]; message?: string };
  if (withLogs?.logs) {
    return `${withLogs.message}\n${withLogs.logs.slice(-12).map((l) => "      " + l).join("\n")}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Everything in the error, flattened, for the ONE substring match step 5 makes. Kept separate from
 *  `describeError` so the human-facing text and the machine-facing text cannot drift apart. */
function errorText(e: unknown): string {
  const withLogs = e as { logs?: string[]; message?: string };
  return `${withLogs?.message ?? String(e)}\n${(withLogs?.logs ?? []).join("\n")}`;
}

// ---- the two targets ---------------------------------------------------------------------------

/** `bulls-arena::extract`'s target — the live v9 program, imported rather than pasted so this probe
 *  can never be measuring an id the app has moved off. Read-only here in every sense: no instruction
 *  of this program is built, simulated or sent. */
const EXTRACT_TARGET = PROGRAM_ID;

/** STAND-IN FOR `arena-vault`, which does not exist yet (ARENA-VAULT.md §8.1 S2). bulls-arena v1 —
 *  still deployed, still executable, no longer used by anything, never delegated, and listed as a dead
 *  deployment in `chain/constants.ts`'s own note on the id history.
 *
 *  THE SUBSTITUTION IS SOUND, and this is the load-bearing claim of the whole script, so it is stated
 *  rather than assumed: the ONLY property `create_session` asserts about `target_program` is that the
 *  account is executable (its IDL doc comment is literally "CHECK the target program is actually a
 *  program"). The pubkey is then used as a PDA seed and nothing else — no CPI, no owner check, no data
 *  read. Two distinct executable accounts therefore produce two distinct tokens by exactly the
 *  mechanism the real pair would, and swapping this id for the real `arena-vault` id on the day it
 *  exists changes no byte of the reasoning. Step 1 asserts the executable property rather than
 *  trusting this paragraph, because a green run against a non-program would mean nothing at all. */
const VAULT_TARGET_STANDIN = new PublicKey("F59NksP2bYZhP4wD7fgR1sP729UHNPitrBiYrrKF1sYW");

/** Sourced from the SDK, not hardcoded — the same discipline `useSessionKeyManager.ts` and
 *  `verify-session-base.mjs` keep, so the app and its probes can never disagree about which program
 *  mints a token. Round-tripped through base58 because gum-sdk's `.d.ts` types this as the `PublicKey`
 *  of its OWN bundled `@coral-xyz/anchor@0.30`, a different class identity from this project's 0.32;
 *  the string is the one thing both copies agree on, and it keeps a single `PublicKey` type in here. */
const GPL_SESSION_PROGRAM_ID = new PublicKey(GPLSESSION_PROGRAMS.devnet.toBase58());

/** An hour. Long enough that step 4's "valid_until is in the future" assertion cannot be a clock-skew
 *  coin flip, short enough that a token this script somehow fails to revoke expires the same morning. */
const SESSION_SECONDS = 3_600;

/** Stamped ONCE, at start-up, rather than recomputed per build. Step 5 re-sends "the identical
 *  transaction", and a `valid_until` read off `Date.now()` inside the builder would make the replay's
 *  instruction DATA differ from the original by however many seconds the run took — which is a
 *  difference the negative control would then be quietly relying on. Pinning it means the two
 *  transactions differ in exactly one field, the blockhash, and nothing else. */
const SESSION_VALID_UNTIL = Math.ceil(Date.now() / 1000) + SESSION_SECONDS;

/** Per token. The real app tops up with 0.02 (`useSessionKeyManager.ts`'s `SESSION_TOP_UP_LAMPORTS`)
 *  because its session key must pay for a round's worth of enter/extract; this one signs nothing after
 *  step 2, so a twentieth of that exercises the identical `top_up` code path without putting 0.04 SOL
 *  through a throwaway key for no extra evidence. `top_up = true` itself is NOT reduced — that is what
 *  the app does, and a probe that skipped it would be testing a transaction shape nobody sends. Both
 *  top-ups come back in step 6. */
const TOP_UP_LAMPORTS = 0.001 * LAMPORTS_PER_SOL;

/** Two tokens' rent, two top-ups, and fees for eight transactions, with headroom. Sized small on
 *  purpose: the devnet faucet rate-limits by IP, and a modest request is likelier to land.
 *
 *  MEASURED, so the headroom is now known rather than guessed: a `SessionToken` is 1,670,400 lamports
 *  of rent (0.001670 SOL) at 112 bytes, so the pair peaks at 0.003341 SOL of rent plus 0.002 of top-up
 *  plus 0.00004 of fees — under a sixth of this. Left at 0.05 anyway. The binding constraint on this
 *  number is not what the run needs, it is what the faucet will hand over in one request. */
const FUNDING_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;

const FLAG_FUND_FROM_OPERATOR = "--fund-from-operator";
const argv = process.argv.slice(2);
const unrecognised = argv.filter((a) => a !== FLAG_FUND_FROM_OPERATOR);
if (unrecognised.length > 0) {
  // Refused rather than ignored: the one flag this script has decides whether the operator key is
  // touched, and a typo'd `--fund-from-op` that silently ran the default path would be a confusing way
  // to learn the faucet is down.
  console.error(`unrecognised argument(s): ${unrecognised.join(" ")}\nusage: bun run scripts/probe-two-session-tokens.ts [${FLAG_FUND_FROM_OPERATOR}]`);
  process.exit(2);
}
const fundFromOperator = argv.includes(FLAG_FUND_FROM_OPERATOR);

// ---- the gpl_session client --------------------------------------------------------------------

// READ OFF DISK, NOT IMPORTED. This project has no `resolveJsonModule`, so `import idl from "….json"`
// does not typecheck — `src/chain/idl.ts` reads the bulls-arena IDL exactly this way for its own
// (different) reason, and this follows that precedent rather than inventing a second one.
const gplSessionIdl = JSON.parse(readFileSync(
  join(__dirname, "..", "node_modules", "@magicblock-labs", "gum-sdk", "lib", "idl", "gpl_session.json"),
  "utf8",
)) as Idl;

// The same address check `chain/idl.ts` makes about the bulls-arena IDL, for the same reason: an IDL
// that has drifted from the program it is used against decodes garbage confidently.
if (gplSessionIdl.address !== GPL_SESSION_PROGRAM_ID.toBase58()) {
  throw new Error(
    `gum-sdk's gpl_session IDL declares ${gplSessionIdl.address} but GPLSESSION_PROGRAMS.devnet is ` +
    `${GPL_SESSION_PROGRAM_ID.toBase58()}. The SDK's IDL and its constant disagree — nothing below would mean anything.`,
  );
}

const conn = new Connection(BASE_RPC, "confirmed");

const player = Keypair.generate();
const sessionSigner = Keypair.generate();

// A WALLET THAT CANNOT SIGN, exactly as `reclaim-status.ts` builds one and for the same reason: Anchor
// needs a wallet to construct a `Program`, this script builds every instruction with `.instruction()`
// and signs its own transactions explicitly, and a provider that could sign would be a second, silent
// path by which something might get sent. An accidental `.rpc()` anywhere below fails instead.
const nonSigningWallet = {
  publicKey: player.publicKey,
  signTransaction: async (t: unknown) => t,
  signAllTransactions: async (t: unknown) => t,
} as never;

const gplSession = new Program(gplSessionIdl, new AnchorProvider(conn, nonSigningWallet, {
  commitment: "confirmed", preflightCommitment: "confirmed",
}));

/** `[b"session_token", target_program, session_signer, authority]` under `gpl_session` — the seed order
 *  `useSessionKeyManager.ts` re-derives and documents, and the reason two targets give two tokens. */
const sessionTokenPda = (targetProgram: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("session_token"), targetProgram.toBuffer(), sessionSigner.publicKey.toBuffer(), player.publicKey.toBuffer()],
    GPL_SESSION_PROGRAM_ID,
  )[0];

const VAULT_TOKEN = sessionTokenPda(VAULT_TARGET_STANDIN);
const EXTRACT_TOKEN = sessionTokenPda(EXTRACT_TARGET);

/** The decoded `SessionToken` — 8-byte discriminator then these four fields, camelCased by Anchor from
 *  the snake_case IDL. Decoded THROUGH Anchor rather than sliced by hand so the layout claim in
 *  ARENA-VAULT.md is checked against the IDL the program itself published. */
interface SessionTokenAccount {
  authority: PublicKey;
  targetProgram: PublicKey;
  sessionSigner: PublicKey;
  validUntil: BN;
}

/** The account namespace, named. Anchor's `AccountNamespace<IDL>` is keyed off a CONST-typed IDL, and
 *  this one is `JSON.parse`d at runtime and therefore just `Idl` — so the mapped type resolves to no
 *  keys at all and `gplSession.account.sessionToken` does not typecheck, however real it is at run
 *  time. `reclaim-status.ts` hits exactly this and answers it exactly this way: name the shape you are
 *  about to use and cast once, here, rather than sprinkling `any` at three call sites. The decoding
 *  itself still goes through Anchor's coder built from the IDL — this only restores the type. */
const sessionTokens = gplSession.account as never as {
  sessionToken: { fetch(address: PublicKey): Promise<SessionTokenAccount> };
};

const createSessionIx = (targetProgram: PublicKey): Promise<TransactionInstruction> =>
  gplSession.methods
    .createSession(true, new BN(SESSION_VALID_UNTIL), new BN(TOP_UP_LAMPORTS))
    .accountsPartial({
      sessionToken: sessionTokenPda(targetProgram),
      sessionSigner: sessionSigner.publicKey,
      authority: player.publicKey,
      targetProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

/** ONE transaction, TWO `create_session` instructions, one session signer, two targets — the shape
 *  §6.3 proposes, built in one place because step 5 has to re-send the IDENTICAL thing for its
 *  negative control and a second hand-assembled copy could differ in a way that explains the failure.
 *
 *  NO BLOCKHASH IS SET HERE, and that is deliberate rather than an omission. `Connection.sendTransaction`
 *  overwrites `recentBlockhash`/`lastValidBlockHeight` on every legacy transaction it is handed
 *  (verified in `node_modules/@solana/web3.js/lib/index.cjs.js`, not assumed), so a blockhash chosen
 *  here would be discarded — and worse, it would read as the thing keeping step 5 honest when it is
 *  not. What actually keeps step 5 honest is in the same function: web3 derives the signature, notices
 *  it has already sent that exact signature on the cached blockhash, disables the cache and fetches a
 *  new one. Without that, two identical messages would produce one signature, the RPC would dedup the
 *  second, and step 5 would report a "success" that never executed. Step 5 checks for that anyway.
 *
 *  `feePayer` IS set, because `Transaction.sign` otherwise takes signers[0] — and then the order of an
 *  argument array would silently decide who pays. */
async function buildTwoTokenTx(): Promise<Transaction> {
  const tx = new Transaction().add(
    await createSessionIx(VAULT_TARGET_STANDIN),
    await createSessionIx(EXTRACT_TARGET),
  );
  tx.feePayer = player.publicKey;
  return tx;
}

const send = (tx: Transaction, signers: Keypair[]) =>
  sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", preflightCommitment: "confirmed" });

// ================================================================================================

console.log(`${c.d}ARENA-VAULT.md §7 E4 — two session tokens, one signer keypair, one transaction${c.x}`);

let operator: Keypair | null = null;
/** The balance the COST block is measured against — the operator's before it funded anything, or the
 *  player's the instant the faucet's lamports landed. A faucet is not a balance, so in the default
 *  case there is nothing else it could honestly be. */
let costStart = 0;
let tokenRentEach = 0;
let verdict: string | null = null;

heading("0. throwaway keypairs, and the money");
info(`player  (the session AUTHORITY — stands in for a real wallet)  ${player.publicKey.toBase58()}`);
info(`session (ONE signer keypair, deliberately, for BOTH tokens)   ${sessionSigner.publicKey.toBase58()}`);

// WHY THE DEFAULT IS A FAUCET AND THE OPERATOR KEY IS OPT-IN. `.devnet/fork-payer.json` is not a
// convenient wallet — it IS the arena authority and the key the live keeper signs with. A script that
// reached for it automatically when the faucet said no would put the program's authority into a run
// nobody asked to involve it in, at whatever moment devnet happened to be rate-limiting, and would do
// it silently. So: airdrop by default, and if that fails, say precisely what the fallback is and stop.
// Choosing to spend the operator key is the operator's decision, made by typing the flag.
if (fundFromOperator) {
  operator = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
  costStart = await conn.getBalance(operator.publicKey);
  warn(`funding from .devnet/fork-payer.json (${operator.publicKey.toBase58()}) — FUNDER AND FEE PAYER ONLY.`);
  warn(`it never becomes a session authority and never signs a bulls-arena instruction; step 6 returns the remainder to it.`);
  info(`operator start balance  ${sol(costStart)}`);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: operator.publicKey, toPubkey: player.publicKey, lamports: FUNDING_LAMPORTS,
  }));
  ok(`funded player with ${sol(FUNDING_LAMPORTS)}  ${c.d}${await send(tx, [operator])}${c.x}`);
} else {
  try {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const signature = await conn.requestAirdrop(player.publicKey, FUNDING_LAMPORTS);
    await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    ok(`airdropped ${sol(FUNDING_LAMPORTS)}  ${c.d}${signature}${c.x}`);
  } catch (e) {
    console.error(
      `\n${c.r}${c.b}AIRDROP REFUSED${c.x} — ${describeError(e)}\n\n` +
      `  The public devnet faucet rate-limits by IP and this is the ordinary way that looks. Nothing\n` +
      `  was created and nothing was spent.\n\n` +
      `  The fallback is EXPLICIT, and this script will not take it on your behalf:\n\n` +
      `      cd er-demo && bun run scripts/probe-two-session-tokens.ts ${FLAG_FUND_FROM_OPERATOR}\n\n` +
      `  That reads .devnet/fork-payer.json — the ARENA AUTHORITY and the live keeper's operator key —\n` +
      `  and uses it as funder and fee payer only. ${sol(FUNDING_LAMPORTS)} leaves it and all but\n` +
      `  transaction fees comes back in step 6.\n`,
    );
    process.exit(1);
  }
}

const funded = await conn.getBalance(player.publicKey);
if (funded === 0) throw new Error(`funding reported success but ${player.publicKey.toBase58()} holds 0 lamports`);
if (!fundFromOperator) costStart = funded;
info(`player balance  ${sol(funded)}`);

heading("1. both target_programs must be real, executable, and DIFFERENT");
// Asserted, not assumed. `create_session`'s only check on `target_program` is executability, so a
// typo'd id that happened to be a data account would fail here rather than at step 2 — and an id that
// was somehow the SAME account twice would make step 2 a test of nothing, since one target is one
// token. Everything this script concludes rests on these three facts.
if (EXTRACT_TARGET.equals(VAULT_TARGET_STANDIN)) {
  throw new Error("the two target_programs are the same account — there would be only one token, and no experiment");
}
for (const [label, target] of [
  ["arena-vault stand-in (bulls-arena v1)", VAULT_TARGET_STANDIN],
  ["bulls-arena v9 (extract)             ", EXTRACT_TARGET],
] as const) {
  const account = await conn.getAccountInfo(target);
  if (!account) throw new Error(`${label}: no account at ${target.toBase58()} — expected a deployed program`);
  if (!account.executable) {
    throw new Error(`${label}: ${target.toBase58()} exists but is NOT executable. create_session would refuse it, and a run against a non-program proves nothing.`);
  }
  ok(`${label}  ${c.d}${target.toBase58()}  executable, owner ${account.owner.toBase58()}${c.x}`);
}

heading("2. THE TEST — one transaction, two create_session instructions, one session signer");
info(`token for the vault stand-in  ${VAULT_TOKEN.toBase58()}`);
info(`token for bulls-arena         ${EXTRACT_TOKEN.toBase58()}`);

const experiment = await buildTwoTokenTx();
try {
  const firstSignature = await send(experiment, [player, sessionSigner]);
  ok(`BOTH TOKENS MINTED IN ONE TRANSACTION  ${c.d}${firstSignature}${c.x}`);

  heading("3. one wallet approval — read off the compiled message, not asserted");
  // THE MESSAGE, NOT A CLAIM ABOUT IT. `numRequiredSignatures` is what the runtime enforces and what a
  // wallet is asked to satisfy, so the count and the identities are the evidence; everything else is
  // commentary. Read from the transaction that was just SENT — the signature printed above is over
  // exactly these bytes.
  //
  // `getTransaction` was the other way to read this, and it was rejected: it would fail whenever the
  // RPC has confirmed the transaction but not yet indexed it, which is a race about RPC plumbing and
  // not about §6.3. `compileMessage()` on the sent object is the same message, with no race.
  const message = experiment.compileMessage();
  const required = message.header.numRequiredSignatures;
  const signerKeys = message.accountKeys.slice(0, required);
  info(`numRequiredSignatures = ${required}`);
  for (const key of signerKeys) {
    const who = key.equals(player.publicKey) ? "the PLAYER'S WALLET — the one human approval"
      : key.equals(sessionSigner.publicKey) ? "the session key the app generates and holds — signed locally, no human"
      : "UNEXPECTED SIGNER";
    info(`  ${key.toBase58()}  ${who}`);
  }
  if (required !== 2) {
    throw new Error(`expected exactly 2 required signatures (player + session key), got ${required}`);
  }
  if (!signerKeys.some((k) => k.equals(player.publicKey)) || !signerKeys.some((k) => k.equals(sessionSigner.publicKey))) {
    throw new Error(`the 2 required signers are not {player, session key}: ${signerKeys.map((k) => k.toBase58()).join(", ")}`);
  }
  // Second read of the same fact from a different structure: `Transaction.signatures` is populated by
  // signing, and it agreeing with the compiled header is what rules out a message that was compiled
  // differently from the one that got signed.
  if (experiment.signatures.length !== required) {
    throw new Error(`compiled message wants ${required} signatures but the sent transaction carries ${experiment.signatures.length}`);
  }
  ok("TWO required signatures, exactly one of which is a human being.");
  info("Both create_session instructions name the SAME `authority`, so the wallet signs once and");
  info("authorises both tokens. ONE APPROVAL — which is precisely what §6.3 claims and is here read");
  info("off the message the cluster accepted, not inferred from the instruction count.");

  heading("4. both tokens, decoded from chain through the gpl_session IDL");
  const vault = await sessionTokens.sessionToken.fetch(VAULT_TOKEN);
  const extract = await sessionTokens.sessionToken.fetch(EXTRACT_TOKEN);
  const nowSec = Math.floor(Date.now() / 1000);

  for (const [label, token, expectedTarget] of [
    ["vault stand-in", vault, VAULT_TARGET_STANDIN],
    ["bulls-arena   ", extract, EXTRACT_TARGET],
  ] as const) {
    info(`${label}  authority=${token.authority.toBase58()}`);
    info(`${label}  session_signer=${token.sessionSigner.toBase58()}`);
    info(`${label}  target_program=${token.targetProgram.toBase58()}  valid_until=${token.validUntil.toString()}`);
    if (!token.authority.equals(player.publicKey)) {
      throw new Error(`${label}: expected authority ${player.publicKey.toBase58()} (the player), got ${token.authority.toBase58()}`);
    }
    if (!token.sessionSigner.equals(sessionSigner.publicKey)) {
      throw new Error(`${label}: expected session_signer ${sessionSigner.publicKey.toBase58()} (the ONE shared keypair), got ${token.sessionSigner.toBase58()}`);
    }
    if (!token.targetProgram.equals(expectedTarget)) {
      throw new Error(`${label}: expected target_program ${expectedTarget.toBase58()}, got ${token.targetProgram.toBase58()}`);
    }
    if (Number(token.validUntil.toString()) <= nowSec) {
      throw new Error(`${label}: valid_until ${token.validUntil.toString()} is not in the future (now ${nowSec}) — the token is already dead`);
    }
  }
  // The whole point, stated as the one comparison that could still fail after all of the above: same
  // authority, same signer, DIFFERENT scope. Two tokens that agreed on target_program would be one
  // token written twice, and §6.3's hazard would have no fix because it would have no second scope.
  if (vault.targetProgram.equals(extract.targetProgram)) {
    throw new Error("both tokens carry the SAME target_program — they are not two scopes, and §6.3's fix does not work");
  }
  ok("same authority (the player) on both");
  ok("same session_signer on both — ONE keypair the app must hold, not two");
  ok("DIFFERENT target_program, matching the two inputs — two scopes, as §6.3 requires");
  ok("both valid_until in the future");

  const vaultInfo = await conn.getAccountInfo(VAULT_TOKEN);
  tokenRentEach = vaultInfo?.lamports ?? 0;

  heading("5. NEGATIVE CONTROL — the identical transaction, sent twice, must fail the second time");
  // NOT DECORATION. If a re-send SUCCEEDED, `create_session` would be silently replacing live tokens
  // and MAGICBLOCK_FEEDBACK.md's renewal entry would be describing a defect that no longer exists —
  // which would change the session lifetime argument in `useSessionKeyManager.ts` (24 hours, chosen
  // partly because renewal costs revoke-then-create, i.e. two approvals). So this step is asked in
  // both directions: it must fail, AND it must fail for the recorded reason.
  const replay = await buildTwoTokenTx();
  try {
    const replaySig = await send(replay, [player, sessionSigner]);
    if (replaySig === firstSignature) {
      // NOT A FINDING — nothing executed. Two identical messages on one blockhash are ONE transaction,
      // and the cluster returned step 2's own signature. See `buildTwoTokenTx`'s note on the machinery
      // that is supposed to prevent this; if it is reached, the control did not run and says nothing.
      warn(`${c.b}THE RE-SEND WAS DEDUPLICATED, NOT EXECUTED${c.x} — same signature as step 2 (${replaySig}).`);
      warn("The negative control did not actually run. Nothing is proven or disproven about renewal here.");
    } else {
      warn(`${c.r}${c.b}THE RE-SEND SUCCEEDED${c.x}  ${replaySig}`);
      warn("This is a FINDING, not a pass. `create_session` was believed unable to replace a live token");
      warn("(MAGICBLOCK_FEEDBACK.md; scripts/verify-session-renewal.mjs). Re-read both before trusting them.");
    }
  } catch (e) {
    console.log(`  ${c.d}the failure, verbatim:${c.x}\n      ${describeError(e).split("\n").join("\n      ")}`);
    if (/custom program error: 0x0\b/.test(errorText(e))) {
      ok("failed with `custom program error: 0x0` — exactly what MAGICBLOCK_FEEDBACK.md records");
      ok("(Anchor `init` against an account that already exists). The recorded note is still accurate.");
      // THE CONSEQUENCE FOR RENEWAL, which composition makes worse rather than better and which is
      // easy to miss in a green run. The System Program's `Allocate` fails on the FIRST token, so the
      // whole transaction reverts — there is no partial renewal, and no way to refresh one scope while
      // leaving the other. A renewal is therefore revoke-BOTH-then-create-BOTH: still one approval per
      // half, but both halves are now all-or-nothing across two tokens instead of one. That is the
      // number `useSessionKeyManager.ts`'s 24-hour lifetime argument should be re-read against when
      // custody lands, and it is why `revoke_session` needing no signature from the authority (step 6)
      // is worth more than it first looks.
      info("renewal is therefore revoke-BOTH-then-create-BOTH: `Allocate` fails on the first token and");
      info("the transaction reverts whole, so there is no partial refresh of one scope.");
    } else {
      warn(`${c.b}IT FAILED, BUT NOT WITH THE RECORDED ERROR.${c.x}`);
      warn("MAGICBLOCK_FEEDBACK.md and scripts/verify-session-renewal.mjs both record a bare");
      warn("`custom program error: 0x0` here. This run says otherwise, so that note is now STALE —");
      warn("read the verbatim failure above and update it rather than trusting either.");
    }
  }

  verdict =
    `${c.g}${c.b}§6.3 HOLDS.${c.x} Two session tokens, scoped to two different target_programs, for ONE session\n` +
    `         signer keypair, created by TWO create_session instructions in ONE transaction requiring TWO\n` +
    `         signatures — the player's wallet and the app's own session key. That is one wallet approval.\n` +
    `         ARENA-VAULT.md §6.3's "unverified" and §7's E4 can both be marked measured, by this script.`;
} catch (e) {
  console.error(`\n${c.r}${c.b}THE EXPERIMENT FAILED${c.x}\n  ${c.r}${describeError(e)}${c.x}`);
  verdict =
    `${c.r}${c.b}§6.3 IS NOT ESTABLISHED.${c.x} See the failure above. If the two create_session instructions\n` +
    `         cannot compose, the custody session path costs two wallet approvals and ARENA-VAULT.md §8.1's\n` +
    `         S3 needs reshaping — do not mark E4 done on this run.`;
  process.exitCode = 1;
}

// ---- step 6 ------------------------------------------------------------------------------------
//
// WRAPPED SO IT CANNOT SPEAK FOR THE EXPERIMENT. Cleanup runs after the verdict is already decided and
// its own failures are warnings, never a verdict: a devnet hiccup while sweeping dust must not be able
// to print "§6.3 does not hold". What it CAN do is leave money somewhere, so a failure names the
// addresses that still hold it.
heading("6. clean up, and account for the money");
try {
  // revoke_session refunds the token's rent to `authority` (the player) and closes the account. Worth
  // recording while here: the IDL marks `authority` writable but NOT a signer, so the transaction
  // needs no signature from the token's owner at all — anyone can revoke anyone's token, and the rent
  // always goes home. Harmless, and useful under custody: a keeper could reclaim abandoned tokens.
  const revokes: TransactionInstruction[] = [];
  for (const token of [VAULT_TOKEN, EXTRACT_TOKEN]) {
    if (!(await conn.getAccountInfo(token))) continue;
    revokes.push(await gplSession.methods
      .revokeSession()
      .accountsPartial({ sessionToken: token, authority: player.publicKey, systemProgram: SystemProgram.programId })
      .instruction());
  }
  if (revokes.length > 0) {
    const tx = new Transaction().add(...revokes);
    tx.feePayer = player.publicKey;
    ok(`revoked ${revokes.length} session token(s), rent back to the player  ${c.d}${await send(tx, [player])}${c.x}`);
  } else {
    info("no session token accounts to revoke");
  }

  // The session key's own lamports (the two top-ups) back to the player. The PLAYER pays this fee, not
  // the session key — that is what lets the transfer be the session key's ENTIRE balance and leave it
  // at exactly zero, with no fee arithmetic to get wrong.
  const sessionBalance = await conn.getBalance(sessionSigner.publicKey);
  if (sessionBalance > 0) {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: sessionSigner.publicKey, toPubkey: player.publicKey, lamports: sessionBalance,
    }));
    tx.feePayer = player.publicKey;
    ok(`swept ${sol(sessionBalance)} from the session key back to the player  ${c.d}${await send(tx, [player, sessionSigner])}${c.x}`);
  }

  const playerBalance = await conn.getBalance(player.publicKey);
  if (operator && playerBalance > 0) {
    // Same trick, one level up: the OPERATOR pays the fee for the transaction that drains the player,
    // so the player's whole balance can move and nothing is stranded. The operator is still only a fee
    // payer and a funder here — it signs no session instruction and authorises nothing.
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: player.publicKey, toPubkey: operator.publicKey, lamports: playerBalance,
    }));
    tx.feePayer = operator.publicKey;
    ok(`returned ${sol(playerBalance)} to the operator  ${c.d}${await send(tx, [operator, player])}${c.x}`);
  } else if (playerBalance > 0) {
    // The faucet has no address to give lamports back to — devnet SOL comes from nowhere and returns
    // there. Said out loud rather than left as an unexplained non-zero balance in the COST block.
    info(`${sol(playerBalance)} left with the throwaway player. The faucet is not an address, so there is`);
    info(`nowhere to return it to; the keypair is discarded when this process exits.`);
  }
} catch (e) {
  warn(`${c.b}CLEANUP FAILED — the verdict below still stands.${c.x} ${describeError(e)}`);
  warn(`funds may remain at:  player ${player.publicKey.toBase58()}`);
  warn(`                      session key ${sessionSigner.publicKey.toBase58()}`);
  warn(`                      session tokens ${VAULT_TOKEN.toBase58()} / ${EXTRACT_TOKEN.toBase58()}`);
}

const costEnd = operator
  ? await conn.getBalance(operator.publicKey)
  : (await conn.getBalance(player.publicKey)) + (await conn.getBalance(sessionSigner.publicKey));

heading("COST");
info(`measured on      ${operator ? `the operator, ${operator.publicKey.toBase58()}` : "the throwaway player (the faucet is not a balance to measure)"}`);
info(`start balance    ${costStart} lamports  (${sol(costStart)})`);
info(`end balance      ${costEnd} lamports  (${sol(costEnd)})`);
info(`net spent        ${costStart - costEnd} lamports  (${sol(costStart - costEnd)})`);
if (tokenRentEach > 0) {
  // The number ARENA-VAULT.md's cost model actually wants out of this run: under custody every player
  // carries TWO of these for the life of a session, paid by the player and refunded on revoke.
  info(`session token rent  ${tokenRentEach} lamports each (${sol(tokenRentEach)}), ${sol(tokenRentEach * 2)} for the pair — recoverable by revoke_session`);
}

console.log(`\n${c.b}VERDICT${c.x} — ${verdict}`);
