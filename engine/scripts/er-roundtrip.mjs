#!/usr/bin/env node
// ER-050 — the delegation round-trip on DEVNET, end to end:
//
//   init_arena → open_round → delegate_round → (owner is the Delegation Program)
//     → enter ×2 → close_lobby_and_draw → VRF callback → tick → resolve → close_round
//     → (owner is our program again)
//
// This is the item that actually proves the integration. Everything else is source that compiles;
// this is the only thing that demonstrates a round can live in an Ephemeral Rollup and come back.
//
// EVERY INSTRUCTION AND EVERY ACCOUNT READ GOES THROUGH THE IDL — see arena-client.mjs for why, at
// length. What that fixed here, specifically: this script hand-packed `open_round` and had not been
// told about `lobby_seconds`, and it still called `reveal`, `settle` and `tick(u16)`, none of which
// exist any more — the seed comes from the VRF oracle now. A hand-computed discriminator for a
// deleted instruction assembles a perfectly valid transaction and fails on chain with a number;
// through the IDL `program.methods.reveal` is simply `undefined`, which is how this was found.
//
//   node engine/scripts/er-roundtrip.mjs
//
// Needs a funded devnet payer (FORK_KEYPAIR, default .devnet/fork-payer.json). Measured cost of a
// full run: about 0.009 SOL, nearly all of it rent for the one Round account it opens — the Round is
// permanent, so that part is not recoverable. The two throwaway fighters are floated and then swept
// back, on the failure path as well as the success path.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  BASE_RPC, BN, DELEGATION_PROGRAM_ID, DEVNET_GENESIS, EPHEMERAL_QUEUE, FIGHT_TIMEOUT_SECONDS,
  MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID, MIN_LOBBY_SECONDS, PHASE_NAME, Phase, PROGRAM_ID, ROUTER_URL,
  SLOT_HASHES_SYSVAR, VRF_PROGRAM_ID, arenaPda, createArenaProgram, decodeAccount, delegationPdas,
  fightIsOver, loadArenaIdl, roundPda, stepsPerSecond,
} from "./arena-client.mjs";

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s) => console.log(`  ${c.d}${s}${c.x}`);
const head = (s) => console.log(`\n${c.y}${s}${c.x}`);
/** Ends the run with a reason. THROWS rather than calling `process.exit`, and that is the difference
 *  between the fighters' float coming back and not: `process.exit` runs no handler, so every `die`
 *  after the funding transaction would have stranded it — including the two that fire on a stuck
 *  round, which is exactly when a run is abandoned and never repeated. Throwing reaches the catch at
 *  the bottom, which prints the same line and then sweeps. */
const die = (s) => { throw new Error(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

/** The lobby this script opens, in seconds: the FLOOR the program clamps to, not the 60 the demo
 *  runs at. `close_lobby_and_draw` is refused until the deadline passes and this round enters two
 *  fighters rather than filling to sixteen, so every extra second of lobby is a second spent waiting
 *  for the part being proven. */
const LOBBY_SECONDS = MIN_LOBBY_SECONDS;

/** Added to every deadline wait. `open_round` stamps the deadline from the BASE layer's clock and
 *  `close_lobby_and_draw` judges it against the ER's, so the two can disagree by a small skew. Waking
 *  late costs two seconds; waking early costs a LobbyStillOpen failure and the whole run. */
const CLOCK_SKEW_MARGIN_MS = 2_000;

/** How long to wait for the VRF oracle to deliver a seed before calling it a failure. `Drawing` has
 *  no exit instruction (see `abandon_round`'s doc comment in lib.rs — the hole is known and
 *  documented), so a round that never gets its callback is stuck, and this script should say that
 *  plainly rather than hang. */
const VRF_TIMEOUT_MS = 120_000;

/** What each throwaway fighter is floated with. Comfortably above the ~5,000-lamport fee for the one
 *  transaction it sends, and above the 890,880-lamport rent-exempt minimum so the account survives
 *  long enough to sign it. Nearly all of it comes back — see `sweepFighters`. */
const FIGHTER_FLOAT_LAMPORTS = 2_000_000;

/** Set just BEFORE the fighters are funded, so the float can be recovered on the way out whether the
 *  run succeeds or fails — including when the funding transfer lands but its confirmation does not.
 *  A verification script that leaves two dead wallets holding dust on every run is litter, and litter
 *  that accumulates silently is the kind nobody ever cleans up. */
let sweepFighters = null;

async function send(conn, ixs, signers, label, quiet = false) {
  const tx = new Transaction().add(...ixs);
  // signers[0] pays. Which account that is matters more than it looks: a transaction that writes an
  // ER-delegated account may carry exactly ONE writable base-layer account, and the fee payer is
  // always writable — so on the ER legs the fee payer has to BE the instruction's own signer rather
  // than a convenient third party. See step 3.
  tx.feePayer = signers[0].publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const t0 = Date.now();
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  const ms = Date.now() - t0;
  if (!quiet) ok(`${label}  ${c.d}${ms}ms  ${sig}${c.x}`);
  return { sig, ms };
}

/** Reads the round off whichever layer is asked, through the IDL, with the length guard. Works
 *  identically on the base layer and inside the rollup — see `decodeAccount`. */
async function readRound(program, conn, pda) {
  return decodeAccount(program, "round", await conn.getAccountInfo(pda), conn.rpcEndpoint);
}

/** Counts down out loud until `until` (unix seconds, from the account) has passed. */
async function waitUntil(untilSec, what) {
  let remaining = untilSec * 1000 + CLOCK_SKEW_MARGIN_MS - Date.now();
  if (remaining <= 0) return info(`${what}: already elapsed`);
  while (remaining > 0) {
    process.stdout.write(`  ${c.d}${what}: ${Math.ceil(remaining / 1000)}s${c.x}\r`);
    await sleep(Math.min(1000, remaining));
    remaining = untilSec * 1000 + CLOCK_SKEW_MARGIN_MS - Date.now();
  }
  process.stdout.write(`${" ".repeat(56)}\r`);
}

(async () => {
  console.log(`${c.d}ER-050 delegation round-trip — DEVNET${c.x}\n`);

  const { idl, path: idlPath, stalePdas } = loadArenaIdl();
  const base = new Connection(BASE_RPC, "confirmed");

  // The cluster is proven by genesis hash, not by the URL string. A URL can be anything.
  const genesis = await base.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) die(`not devnet — genesis ${genesis}`);
  ok(`cluster verified devnet (${genesis.slice(0, 8)}…)`);
  info(`idl     ${idlPath.replace(process.cwd() + "/", "")}`);
  info(`program ${PROGRAM_ID.toBase58()}`);
  for (const stale of stalePdas) {
    console.log(`  ${c.y}!${c.x} the IDL says ${stale.instruction}.${stale.account} lives under ` +
      `${stale.declared}, not ${PROGRAM_ID.toBase58()} — deriving it from the SDK instead. ` +
      `See stalePdaPrograms() in arena-client.mjs.`);
  }

  const payer = load(process.env.FORK_KEYPAIR || ".devnet/fork-payer.json");
  const startingBalance = await base.getBalance(payer.publicKey);
  info(`payer   ${payer.publicKey.toBase58()}  ${(startingBalance / 1e9).toFixed(4)} SOL`);
  if (startingBalance < 0.05e9) die("payer needs at least 0.05 SOL");

  const executable = await base.getAccountInfo(PROGRAM_ID);
  if (!executable?.executable) die(`program ${PROGRAM_ID.toBase58()} is not executable on devnet`);
  ok(`program executable`);

  const baseProgram = createArenaProgram(base, payer, idl);
  const arena = arenaPda();

  // ---- init_arena (idempotent: skip if it already exists) ----------------------------------------
  head("1. arena");
  let arenaInfo = await base.getAccountInfo(arena);
  if (!arenaInfo) {
    await send(base, [await baseProgram.methods
      // 20 bps matches the engine's 0.2%; the two mint addresses are placeholders — this program
      // custodies nothing, so nothing reads them.
      .initArena(20, PublicKey.default, PublicKey.default)
      .accounts({ arena, authority: payer.publicKey, systemProgram: SystemProgram.programId })
      .instruction()], [payer], "init_arena");
    arenaInfo = await base.getAccountInfo(arena);
  } else {
    info(`arena ${arena.toBase58()} already initialised — reusing`);
  }

  // The round number comes off the arena's own counter, decoded through the IDL. This was
  // `arena.data.readBigUInt64LE(104)`: correct today, silently wrong the first time a field is
  // inserted before `round_counter`.
  const arenaState = decodeAccount(baseProgram, "arena", arenaInfo, "the base layer");
  const roundNo = BigInt(arenaState.roundCounter.toString()) + 1n;
  const round = roundPda(roundNo, arena);
  info(`round #${roundNo} → ${round.toBase58()}`);

  // ---- open_round --------------------------------------------------------------------------------
  head("2. open_round + delegate_round");
  // The seed commitment is vestigial now that the real seed comes from the VRF oracle (see
  // `open_round` in lib.rs), but the argument is still there and still recorded, so it is still sent.
  const seedCommit = Array.from(randomBytes(32));
  await send(base, [await baseProgram.methods
    .openRound(new BN(roundNo.toString()), seedCommit, LOBBY_SECONDS)
    .accounts({ arena, round, authority: payer.publicKey, systemProgram: SystemProgram.programId })
    .instruction()], [payer], `open_round #${roundNo} (${LOBBY_SECONDS}s lobby)`);

  const opened = await readRound(baseProgram, base, round);
  ok(`round open — phase ${PHASE_NAME[opened.phase]}, lobby closes at ` +
    `${new Date(opened.lobbyClosesAt.toNumber() * 1000).toLocaleTimeString()}`);

  // ---- delegate_round: hand it to the ER validator ------------------------------------------------
  // Anchor gets the ACCOUNT ORDER from the IDL, which is the thing this used to get wrong by hand
  // (the `#[delegate]` macro injects buffer/record/metadata immediately before the delegated field,
  // then appends owner_program, delegation_program, system_program — an ordering the old script had
  // to state, and once stated wrongly).
  //
  // But the three PDAs themselves are passed EXPLICITLY rather than left to Anchor's resolver, and
  // that is not belt-and-braces: the IDL's own `pda` metadata for `buffer_round_pda` names a stale
  // program id, so the resolver derives an address the deployed program rejects. See
  // `stalePdaPrograms` in arena-client.mjs — this is a real devnet failure, not a precaution.
  const del = delegationPdas(round);
  await send(base, [await baseProgram.methods
    .delegateRound(new BN(roundNo.toString()))
    .accounts({
      authority: payer.publicKey, arena, roundPda: round, ownerProgram: PROGRAM_ID,
      bufferRoundPda: del.buffer,
      delegationRecordRoundPda: del.record,
      delegationMetadataRoundPda: del.metadata,
      delegationProgram: DELEGATION_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .instruction()], [payer], "delegate_round");

  const delegated = await base.getAccountInfo(round);
  if (!delegated.owner.equals(DELEGATION_PROGRAM_ID)) {
    die(`delegation did not transfer ownership (owner ${delegated.owner.toBase58()})`);
  }
  ok(`OWNER IS NOW THE DELEGATION PROGRAM — the round is in the ER`);
  ok(`this is the round-trip's core assertion: ${delegated.owner.toBase58()}`);

  // ---- FROM HERE THE ACCOUNT LIVES IN THE ER ------------------------------------------------------
  //
  // The Magic Router decides where a transaction goes by inspecting the OWNER of its writable
  // accounts. The round PDA is now owned by the delegation program, so these route to the rollup
  // automatically — the client does not choose, the account state does. That is why the same
  // instruction encoding works against a different endpoint with no other change.
  const router = new ConnectionMagicRouter(ROUTER_URL, "confirmed");
  const erProgram = createArenaProgram(router, payer, idl);

  head("3. two fighters enter, inside the rollup");
  // TWO DISTINCT WALLETS, not the payer twice: `run_fight` refuses to let a wallet damage itself, so
  // a round whose fighters are the same identity never lands a blow, never satisfies `fight_is_over`,
  // and can only end at the 120-second bell in a tie. Two identities make it a real fight.
  //
  // EACH PAYS ITS OWN FEE, which is why they have to be funded at all. The frugal-looking version —
  // payer as fee payer, fighter as a second signer — is rejected by the router with "transaction
  // loads a writable account that cannot be written": `enter`'s `signer` is `mut`, so that shape puts
  // TWO writable base-layer accounts in a transaction that also writes an ER-delegated one, and the
  // router reconciles exactly one. Found by trying it. The float goes back to the payer at the end.
  const fighters = [Keypair.generate(), Keypair.generate()];

  // ARMED BEFORE THE MONEY MOVES, not after, and the order is the whole point. `send` awaits
  // `confirmTransaction`, which can reject — blockhash expiry, an RPC hiccup — on a transfer that
  // DID land. Assigning this afterwards leaves exactly that window where the float exists and
  // nothing knows how to recover it. Arming first costs nothing: the closure reads balances at call
  // time and does nothing when they are zero, so running it against fighters that were never funded
  // is a no-op rather than an error.
  sweepFighters = async () => {
    // Every lamport, leaving each account at zero so the runtime reaps it. The payer signs as fee
    // payer, so a fighter emptied to nothing does not then owe a fee it cannot pay.
    //
    // The signer list is built from the same filter as the instruction list rather than from
    // `fighters` wholesale: `Transaction.sign` throws `unknown signer` for a keypair that appears in
    // no instruction, so a run where only one fighter ever got funded would fail to sweep the one
    // that did.
    const funding = [];
    for (const f of fighters) {
      const lamports = await base.getBalance(f.publicKey);
      if (lamports > 0) funding.push({ f, lamports });
    }
    if (funding.length === 0) return;
    await send(base,
      funding.map(({ f, lamports }) =>
        SystemProgram.transfer({ fromPubkey: f.publicKey, toPubkey: payer.publicKey, lamports })),
      [payer, ...funding.map(({ f }) => f)],
      "swept the fighters' float back");
  };

  await send(base, fighters.map((f) => SystemProgram.transfer({
    fromPubkey: payer.publicKey, toPubkey: f.publicKey, lamports: FIGHTER_FLOAT_LAMPORTS,
  })), [payer], `float ${(FIGHTER_FLOAT_LAMPORTS / 1e9).toFixed(3)} SOL to each fighter`);

  for (const [side, fighter] of fighters.entries()) {
    await send(router, [await erProgram.methods
      .enter(side, new BN(1_000_000))
      .accounts({ arena, round, player: fighter.publicKey, sessionToken: null, signer: fighter.publicKey })
      .instruction()], [fighter], `enter side ${side}  ${c.d}${fighter.publicKey.toBase58().slice(0, 8)}…${c.x}`);
  }

  head("4. close_lobby_and_draw — a real VRF request");
  // Known and already documented (MEGA_QUEUE.md ER-040 finding #3): the GENERIC router refuses this
  // one instruction, because its writable set mixes the ER-delegated round with the VRF queue
  // singleton, whose own delegation record names the System Program as authority. The router cannot
  // reconcile those. It has to go straight to the validator actually hosting this round.
  const { fqdn } = await router.getDelegationStatus(round);
  const validator = new Connection(fqdn, "confirmed");
  info(`this round's validator: ${fqdn}`);

  // The deadline is READ OFF THE ACCOUNT, not reconstructed as "LOBBY_SECONDS after we sent
  // open_round": the chain clamps the duration and stamps the timestamp from its own clock, so the
  // account is the only thing that knows the real deadline.
  const inLobby = await readRound(erProgram, validator, round);
  await waitUntil(inLobby.lobbyClosesAt.toNumber(), "waiting out the lobby");
  ok(`lobby deadline passed — close_lobby_and_draw is now permitted`);

  await send(validator, [await erProgram.methods
    .closeLobbyAndDraw(Array.from(randomBytes(32)))
    .accounts({
      // `program_identity` is omitted rather than derived here: the IDL declares its seeds
      // (`["identity"]`), so Anchor's resolver produces it. Same for delegate_round's three
      // delegation PDAs above. Deriving them by hand in the script would be one more copy of a
      // layout the IDL already states.
      payer: payer.publicKey, arena, round, oracleQueue: EPHEMERAL_QUEUE,
      // The PERMISSIONLESS close — the deadline has passed, which is the path this round-trip is
      // exercising. Naming the arena authority here would bypass the deadline instead, which is how
      // a keeper holding a single lobby open starts a fight the moment a real player joins.
      //
      // `null` rather than omitted: `arena` above could equally have been left to the IDL resolver
      // (its seeds are `["arena"]`, like `program_identity`'s), but an OPTIONAL account has no seeds
      // to resolve from, so absence has to be stated.
      authority: null,
      vrfProgram: VRF_PROGRAM_ID, slotHashes: SLOT_HASHES_SYSVAR,
      systemProgram: SystemProgram.programId,
    })
    .instruction()], [payer], "close_lobby_and_draw");

  head("5. waiting for the oracle callback (Drawing → Fight)");
  const drawStart = Date.now();
  let state = await readRound(erProgram, validator, round);
  while (state.phase === Phase.Drawing && Date.now() - drawStart < VRF_TIMEOUT_MS) {
    await sleep(2000);
    state = await readRound(erProgram, validator, round);
  }
  if (state.phase !== Phase.Fight) {
    die(`round is ${PHASE_NAME[state.phase]}, not Fight, ${((Date.now() - drawStart) / 1000).toFixed(0)}s ` +
      `after the draw was requested. Drawing has no exit instruction — see abandon_round in lib.rs.`);
  }
  ok(`phase is FIGHT — the VRF callback landed (${((Date.now() - drawStart) / 1000).toFixed(1)}s)`);

  head("6. tick to the finish — the hot path, and the whole reason for the ER");
  // TICKING IS WHAT MAKES THE FIGHT HAPPEN, so this is one loop rather than the "tick three times,
  // then separately wait for the fight to end" it was: the CANONICAL cursor advances with real time
  // whether anyone ticks or not, but the fighter array on the account only moves when someone runs
  // the steps. Waiting without ticking therefore watched a fight that could never end, and reached
  // `resolve` at the 120-second bell every single time — a tie, decided by a timeout, reported as a
  // round-trip. `resolve` would have caught the whole fight up itself in one call, which is exactly
  // why that bug was invisible.
  //
  // `steps` is a hint: the program runs min(steps, backlog) and succeeds having done nothing when the
  // fight is already up to date, so asking for two seconds' worth every second is always legal and
  // simply keeps the account level with the clock.
  const perSecond = stepsPerSecond(state.fighterCount);
  const ticks = [];
  let current = state;
  while (!fightIsOver(current)) {
    // The same race step 7 documents, caught one stage earlier: a keeper sharing this devnet can
    // settle the round out from under this loop, and `tick` on anything but a Fight answers
    // NotFighting. Checked before sending rather than caught after, so a legitimate outcome does not
    // arrive as an exception.
    if (current.phase !== Phase.Fight) {
      process.stdout.write(`${" ".repeat(72)}\r`);
      info(`round became ${PHASE_NAME[current.phase]} while ticking — someone else settled it`);
      break;
    }
    const bellAt = current.fightStartedAt.toNumber() + FIGHT_TIMEOUT_SECONDS;
    // The SAME skew margin `waitUntil` applies, in the mirror-image comparison and for the mirror-
    // image reason: this compares local wall-clock against a timestamp the ER stamped, and `resolve`
    // will judge the bell against the ER's clock, not ours. Breaking a second early costs
    // FightNotOverYet and the whole run, two minutes in — and with two fighters the fight almost
    // always ends on its own first, so it is a failure that would never show up in testing.
    if (Date.now() / 1000 >= bellAt + CLOCK_SKEW_MARGIN_MS / 1000) {
      process.stdout.write(`${" ".repeat(72)}\r`);
      info("the bell rang with both sides still standing — settling on holdings");
      break;
    }
    // The first three are printed in full, signatures and all, because the latency of a tick inside
    // the rollup is one of the two numbers this script exists to produce. After that a fight can run
    // for two minutes and sixty more signature lines would bury the result.
    const loud = ticks.length < 3;
    const { ms } = await send(validator, [await erProgram.methods
      .tick(perSecond * 2)
      .accounts({ round })
      .instruction()], [payer], `tick (#${ticks.length + 1})`, !loud);
    ticks.push(ms);
    current = await readRound(erProgram, validator, round);
    if (!loud) {
      process.stdout.write(`  ${c.d}tick #${ticks.length} — cursor ${current.tickCount}, ` +
        `bell in ${Math.ceil(bellAt - Date.now() / 1000)}s${c.x}\r`);
    }
    await sleep(1000);
  }
  process.stdout.write(`${" ".repeat(72)}\r`);
  // Defensive rather than expected: this script always enters one fighter per side, so `fightIsOver`
  // is false on the first read and the loop runs at least once. It is here because the alternative is
  // `median` reading `undefined` off an empty array and printing it — and the predicate genuinely can
  // be true at the first instant for a lineup that is entirely on one side, which is a round shape
  // this script does not create but `fightIsOver` is written to handle.
  if (ticks.length === 0) {
    info("no ticks — the fight was already over before the first one could be sent");
  } else {
    // Upper-middle element rather than a true median (no averaging of the two middles on an even
    // count) — named for what it is, because "median" on a latency figure someone may quote later
    // should not be approximately true.
    const sorted = [...ticks].sort((a, b) => a - b);
    const mid = sorted[Math.floor(ticks.length / 2)];
    info(`${ticks.length} ticks, ${mid}ms typical, ${sorted[0]}–${sorted[sorted.length - 1]}ms range` +
      `  (the base layer is ~400ms/slot for comparison)`);
  }
  info(`cursor ${current.tickCount} steps, ${perSecond}/s with ${current.fighterCount} fighters`);
  if (fightIsOver(current)) ok(`the fight ended on its own — one side has nobody standing`);

  head("7. resolve — decide the winner and COMMIT to the base layer");
  const settleAccounts = {
    payer: payer.publicKey, round, magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID,
  };

  // RESOLVE IS PERMISSIONLESS, AND SO LOSING THE RACE FOR IT IS NOT A FAILURE. Found the hard way:
  // this run shared devnet with a keeper, which entered two more fighters into the round and settled
  // it a moment before this transaction landed. The script reported `NotFighting` (6003) and exited
  // non-zero on a round that had, in fact, completed the entire round-trip — the thing it exists to
  // verify — with somebody else's signature on the last step.
  //
  // Re-reading the phase first is the honest encoding of the claim. What is being proven is "a round
  // can live in an Ephemeral Rollup and come back", not "this process personally sent every
  // transaction". Step 9 asserts the part that actually matters and does not care who got there.
  const beforeResolve = await readRound(erProgram, validator, round);
  if (beforeResolve.phase === Phase.Fight) {
    await send(router, [await erProgram.methods.resolve().accounts(settleAccounts).instruction()],
      [payer], "resolve + commit");
  } else {
    info(`already ${PHASE_NAME[beforeResolve.phase]} — someone else resolved it first ` +
      `(resolve is permissionless). Skipping to the base-layer check.`);
  }

  head("8. close_round — commit_and_undelegate");
  // Same reasoning, and one extra state to respect: `close_round` cannot run on a round that has
  // already been undelegated, because the account is no longer the ER's to commit.
  const stillDelegated = (await base.getAccountInfo(round))?.owner.equals(DELEGATION_PROGRAM_ID);
  if (stillDelegated) {
    await send(router, [await erProgram.methods.closeRound().accounts(settleAccounts).instruction()],
      [payer], "close_round");
  } else {
    info("already undelegated — the round is home. Nothing left to close.");
  }

  // ---- back on the BASE LAYER: did it actually come home? -----------------------------------------
  head("9. verifying on the base layer");
  for (let i = 0; i < 20; i++) {
    const back = await base.getAccountInfo(round);
    if (back && back.owner.equals(PROGRAM_ID)) {
      ok(`OWNER REVERTED TO OUR PROGRAM — the round came back from the ER`);
      // The old version of this read `d[48]`, `d[49]`, `d.readUInt16LE(51)`, `d.readBigUInt64LE(53)`.
      // Worth being exact about what was wrong with that, because it is not what it looks like:
      // checked against a real settled round, all four offsets were still CORRECT — the three fields
      // inserted since were added after them. It was right by luck, it could say nothing at all about
      // `penaltiesCollected` or the lobby window, and the next inserted field decided whether the
      // luck held.
      //
      // THAT FIELD HAS NOW LANDED AND THE LUCK WOULD HAVE HELD AGAIN — `fees_collected` and
      // `house_swept` went in between `penalties_collected` and `seed_commit`, still after all four —
      // which is the least reassuring possible outcome and exactly why the argument was never about
      // those four offsets. Nine bytes moved the fighter array from 165 to 174, and the only work this
      // file had to do to keep up was name one more field. `verify-session-extract.mjs`, which still
      // hand-rolls its decoder because it deliberately imports nothing, had to move every offset
      // after the pot and now carries a length tripwire so that the next one fails loudly. That is
      // the whole argument for reading through the IDL rather than a repair.
      const final = decodeAccount(baseProgram, "round", back, "the base layer");
      const big = (v) => BigInt(v.toString());
      // The three quantities every verifier in this repo computes, named the same way in each — see
      // `Round.fees_collected` in lib.rs and `ui/verifyRound.ts`.
      //
      // The fee is on BOTH sides of the identity and therefore cancels: it was taken at the door and
      // never entered the ring, so this is not a stronger check than the `held + penalties === pot` it
      // replaces, and a version that dropped the term would pass and fail on exactly the same rounds.
      // It is here because `pot` is the sum of NET stakes and was being printed as though it were what
      // players paid, and because the house's take should be one named number rather than a
      // subtraction each script does differently — as three of the four devnet scripts did.
      const playersHold = final.fighters.slice(0, final.fighterCount)
        .reduce((n, f) => n + big(f.hp) + big(f.banked), 0n);
      const houseTook = big(final.penaltiesCollected) + big(final.feesCollected);
      const grossDeposits = big(final.pot) + big(final.feesCollected);
      info(`phase       ${PHASE_NAME[final.phase]}`);
      info(`winner      side ${final.winner}`);
      info(`fighters    ${final.fighterCount}`);
      info(`cursor      ${final.tickCount} steps`);
      info(`pot         ${final.pot}  (NET of the entry fee — players were charged ${grossDeposits})`);
      info(`books       playersHold ${playersHold} + houseTook ${houseTook} ` +
           `(${final.penaltiesCollected} penalties + ${final.feesCollected} fees) = ${playersHold + houseTook}`);
      if (playersHold + houseTook !== grossDeposits) {
        die(`value is not conserved — playersHold ${playersHold} + houseTook ${houseTook} should equal ` +
            `grossDeposits ${grossDeposits} exactly`);
      }
      ok(`value conserved exactly across the round-trip`);
      info(`round pda   ${round.toBase58()}`);
      await sweepFighters();
      const spent = startingBalance - await base.getBalance(payer.publicKey);
      info(`spent       ${(spent / 1e9).toFixed(6)} SOL`);
      return;
    }
    await sleep(3000);
  }
  die("still delegated after 60s — the commit may still be finalising");
})().catch(async (e) => {
  console.error(`\n  ${c.r}✗ ${e.message}${c.x}`);
  if (e.logs) console.error(e.logs.slice(-8).map((l) => "    " + l).join("\n"));
  process.exitCode = 1;
  // Recover the float even from a failed run — a failure is when litter is MOST likely, because
  // nobody comes back to a script that already told them it did not work.
  if (sweepFighters) await sweepFighters().catch((x) => console.error(`  ${c.d}sweep failed: ${x.message}${c.x}`));
});
