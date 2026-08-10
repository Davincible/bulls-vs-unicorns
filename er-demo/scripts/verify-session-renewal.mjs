#!/usr/bin/env node
// WHY REPLACING A SESSION COSTS TWO APPROVALS — proved on devnet rather than reasoned from an IDL.
//
// THE CLAIM UNDER TEST, and it decides how the live app recovers from an expired session. Since
// `data/autoSession.ts`, a session-signed transaction that the chain refuses with `InvalidToken` is
// no longer an error a player has to read: the page replaces the session and re-sends the move. HOW
// it replaces it is the question. gum-react-sdk's `createSession` only generates a keypair when it
// has none (`if (!keypairRef.current) generateKeypair()`, read from the compiled hook — the SDK
// ships no source), and the session token PDA is derived from
// `[b"session_token", target_program, session_signer, authority]`. So a second `create_session` from
// a browser that already holds a session aims at an account that already exists.
//
// If that fails, `useSessionController.renew` MUST revoke first, and the honest copy is "an approval
// or two". If it succeeds — if `create_session` were `init_if_needed`, or reinitialised in place —
// then the revoke is a wasted signature and the copy overstates the cost. Everything a player is
// told about renewal rests on which of those is true, and reading an Anchor IDL cannot tell you:
// `init` and `init_if_needed` are indistinguishable in it.
//
// WHAT IT DOES, IN ORDER — all on the base layer, no ER, no arena round, nothing to clean up but the
// session tokens it opens and closes itself:
//   1. create_session for (bulls-arena, signer K, authority A)         — must SUCCEED
//   2. create_session AGAIN, same K, same A, same program              — must FAIL
//   3. revoke_session on that token                                    — must SUCCEED
//   4. create_session a third time, same K                             — must SUCCEED
//
// (4) is what makes (2) meaningful: it proves the second attempt failed because the ACCOUNT was
// there, not because the keypair was somehow spent. Together they are the whole argument for
// revoke-then-create, and for the two approvals the copy quotes.
//
//   cd er-demo && bun run scripts/verify-session-renewal.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { GPLSESSION_PROGRAMS } from "@magicblock-labs/gum-sdk";
import gplSessionIdl from "../node_modules/@magicblock-labs/gum-sdk/lib/idl/gpl_session.json" with { type: "json" };

const { AnchorProvider, BN, Program, Wallet } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Same guard every script in this repo carries: a URL is the one thing that could point this at
// mainnet, so it is asserted rather than trusted.
const BASE_RPC = "https://api.devnet.solana.com";
if (/mainnet/i.test(BASE_RPC) || !/devnet/i.test(BASE_RPC)) {
  throw new Error(`base RPC could not be positively identified as devnet: ${BASE_RPC}. Refusing.`);
}

/** The app funds a session key with 0.02 SOL (`SESSION_TOP_UP_LAMPORTS`). Matched here so the
 *  transactions this script sends are the shape the app actually sends, rent and all. */
const TOP_UP_LAMPORTS = 0.02 * LAMPORTS_PER_SOL;
const AN_HOUR = 3600;

const c = { r: "\x1b[31m", g: "\x1b[32m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s) => console.log(`  ${c.d}${s}${c.x}`);
const heading = (s) => console.log(`\n${c.b}${s}${c.x}`);

const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const describeError = (e) =>
  e?.logs ? `${e.message}\n${e.logs.slice(-10).map((l) => "      " + l).join("\n")}` : e?.message || String(e);

(async () => {
  console.log(
    `${c.d}SESSION RENEWAL — can a second create_session reuse the same session signer?${c.x}`,
  );

  const arenaIdl = JSON.parse(readFileSync(join(__dirname, "..", "public", "idl", "bulls_arena.json"), "utf8"));
  const TARGET_PROGRAM = new PublicKey(arenaIdl.address);
  const GPL_SESSION_PROGRAM_ID = GPLSESSION_PROGRAMS.devnet;

  const base = new Connection(BASE_RPC, "confirmed");
  const authority = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
  const opts = { commitment: "confirmed", preflightCommitment: "confirmed" };
  const gpl = new Program(gplSessionIdl, new AnchorProvider(base, new Wallet(authority), opts));

  // ONE session signer for the whole script — that is the entire point. gum would reuse exactly this
  // keypair on a second `createSession`, so this script reuses it too.
  const sessionSigner = Keypair.generate();
  const [sessionToken] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("session_token"),
      TARGET_PROGRAM.toBuffer(),
      sessionSigner.publicKey.toBuffer(),
      authority.publicKey.toBuffer(),
    ],
    GPL_SESSION_PROGRAM_ID,
  );

  info(`authority      ${authority.publicKey.toBase58()}`);
  info(`session signer ${sessionSigner.publicKey.toBase58()}`);
  info(`session token  ${sessionToken.toBase58()}`);
  info(`target program ${TARGET_PROGRAM.toBase58()}`);

  const balance = await base.getBalance(authority.publicKey);
  if (balance < 3 * TOP_UP_LAMPORTS) {
    throw new Error(
      `authority holds ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL; this script opens three ` +
        `sessions at ${TOP_UP_LAMPORTS / LAMPORTS_PER_SOL} SOL each. Fund it first.`,
    );
  }

  const createSession = () =>
    gpl.methods
      .createSession(true, new BN(Math.ceil(Date.now() / 1000) + AN_HOUR), new BN(TOP_UP_LAMPORTS))
      .accounts({
        sessionToken,
        sessionSigner: sessionSigner.publicKey,
        authority: authority.publicKey,
        targetProgram: TARGET_PROGRAM,
        systemProgram: SystemProgram.programId,
      })
      .signers([sessionSigner])
      .rpc();

  heading("1. create_session — the first one, exactly as the app opens one");
  ok(`create_session  ${c.d}${await createSession()}${c.x}`);
  {
    const acct = await gpl.account.sessionToken.fetch(sessionToken);
    info(`on-chain valid_until=${acct.validUntil.toString()} authority=${acct.authority.toBase58()}`);
  }

  heading("2. create_session AGAIN, same session signer — the claim");
  try {
    const sig = await createSession();
    console.error(
      `\n${c.r}THE CLAIM IS WRONG.${c.x} A second create_session against the same session signer ` +
        `SUCCEEDED (${sig}).\n` +
        "  That means a session can be replaced with ONE approval and no revoke, and both the code " +
        "and the copy must change:\n" +
        "    · useSessionController.renew should drop its revoke step\n" +
        "    · autoSession.ts's sessionNote and walletFault.ts's session-expired copy should stop " +
        "quoting two approvals\n",
    );
    process.exit(1);
  } catch (e) {
    ok("create_session refused the second attempt, as the design assumes");
    info(describeError(e).split("\n").slice(0, 6).join("\n"));
  }

  heading("3. revoke_session — what makes room for a replacement");
  ok(
    `revoke_session  ${c.d}${await gpl.methods
      .revokeSession()
      .accounts({ sessionToken, authority: authority.publicKey, systemProgram: SystemProgram.programId })
      .rpc()}${c.x}`,
  );
  if ((await base.getAccountInfo(sessionToken)) !== null) {
    throw new Error("revoke_session returned, but the token account is still on chain.");
  }
  ok("the token account is closed — the PDA is free again");

  heading("4. create_session a third time, same session signer — proving (2) was about the ACCOUNT");
  ok(`create_session  ${c.d}${await createSession()}${c.x}`);

  heading("cleanup");
  ok(
    `revoke_session  ${c.d}${await gpl.methods
      .revokeSession()
      .accounts({ sessionToken, authority: authority.publicKey, systemProgram: SystemProgram.programId })
      .rpc()}${c.x}`,
  );

  console.log(
    `\n${c.g}${c.b}PROVED${c.x} — a session signer cannot be reused while its token exists, so ` +
      `replacing a session is revoke-then-create: two wallet approvals, which is what the app's copy says.\n`,
  );
})().catch((e) => {
  console.error(`\n${c.r}FAILED${c.x} ${describeError(e)}\n`);
  process.exit(1);
});
