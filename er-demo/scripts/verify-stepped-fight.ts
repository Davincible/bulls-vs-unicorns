#!/usr/bin/env bun
// THE ONE CLAIM THIS SCRIPT EXISTS TO PROVE, ON REAL DEVNET, WITH REAL SIGNATURES:
//
//     extracting mid-fight banks LESS than the entry stake.
//
// Everything else here is scaffolding for that assertion. Before this session it was false — and not
// approximately false, exactly false: `run_fight()` was called in a single place, at the very end of
// `resolve()`, so throughout the whole Fight phase every fighter's on-chain `hp` was still their full
// net stake and `extract()` returned 100% of it whenever it was pressed (measured: hp=499000 ->
// banked=499000). The rollup animated health draining that the chain did not believe in.
//
// So the script does what the game now does: it TICKS the fight forward in the rollup, checks that hp
// genuinely fell, extracts, and requires the payout to be strictly less than the stake. It also
// checks four things that would each quietly undo that if they broke:
//
//   * value conservation (sum of hp+banked across fighters == pot) at every checkpoint — the
//     invariant that catches an economics bug in one line;
//   * that `extract()` advances the fight ITSELF, without anyone having ticked first — otherwise a
//     player could simply refuse to tick and extract at a stale, larger hp, which is the same free
//     refund in a different disguise;
//   * that no caller can tick the fight PAST what the clock allows, however large an argument they
//     pass — the property that justifies `tick` having no authority check at all;
//   * that the chain and `engine/src/er-sim.ts`'s mirror agree fighter-for-fighter at the cursor the
//     extract landed on, so the payout is the number the independent replay says it should be.
//
//   cd er-demo && bun run scripts/verify-stepped-fight.ts [--validator <identity-pubkey>]

import { assertDevnetUrl } from "../src/devnet-guard.ts";
import {
  BASE_RPC, canonicalCursor, MAX_STEPS, PHASE_NAME, Phase, PROGRAM_ID, ROUTER_URL, stepsPerSecond,
} from "../src/chain/constants.ts";
import { createProgram, type BullsArenaProgram, type RawRoundAccount } from "../src/chain/program.ts";
import { sendTx } from "../src/chain/sendTx.ts";
import { createBurnerWallet, loadOrCreateBurnerKeypair } from "../src/chain/useSigner.ts";
import * as roundIx from "../src/chain/round.ts";
// The independent replay — the same mirror `VerifyPanel.tsx` re-derives a settled round with, used
// here to name the exact hp the chain's `extract()` moved. Not a second implementation of the fight:
// it is the parity oracle this repo already maintains for exactly this purpose (ER-051).
import { buildRoundFromEntries, computeHitEvents, type HitEventEntry } from "../src/sim/hitEvents.ts";
import { extract as simExtract } from "../src/sim/erSim.ts";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from "@solana/web3.js";
import { AnchorError } from "@coral-xyz/anchor";
import { ConnectionMagicRouter, DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s: string) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s: string) => console.log(`  ${c.d}${s}${c.x}`);
const warn = (s: string) => console.log(`  ${c.y}!${c.x} ${s}`);
const heading = (s: string) => console.log(`\n${c.b}${s}${c.x}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

function describeError(e: unknown): string {
  if (e instanceof AnchorError) return `${e.error.errorCode.code} (${e.error.errorCode.number}): ${e.error.errorMessage}`;
  const withLogs = e as { logs?: string[]; message?: string };
  if (withLogs?.logs) return `${withLogs.message}\n${withLogs.logs.slice(-12).map((l) => "      " + l).join("\n")}`;
  return e instanceof Error ? e.message : String(e);
}

/** The router's OWN list of ER validators, rather than a hardcoded one. Asking is both more honest and
 *  strictly better informed — it turned up `devnet-tee` alongside the three endpoints this repo's
 *  scripts had been assuming, and that mattered: the search below has to cover every validator before
 *  it can conclude that a fresh program id is the only way forward. */
async function routerValidators(): Promise<{ identity: PublicKey; fqdn: string }[]> {
  const res = await fetch(ROUTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getRoutes", params: [] }),
  });
  const body = await res.json() as { result?: { identity: string; fqdn: string }[]; error?: { message: string } };
  if (!body.result) throw new Error(`getRoutes: ${body.error?.message ?? "no result"}`);
  return body.result.map((r) => ({ identity: new PublicKey(r.identity), fqdn: r.fqdn }));
}

/** THE PREFLIGHT THAT TURNS A DOCUMENTED TRAP INTO A ONE-SECOND CHECK.
 *
 *  MagicBlock's ER validators clone a program's executable into their own LoaderV4-owned account on
 *  first use and do NOT re-clone it when the base-layer program is upgraded (MAGICBLOCK_FEEDBACK.md;
 *  MEGA_QUEUE.md task #15, where this cost a whole round and a very confusing failure). So right
 *  after a deploy, a round delegated to whichever validator the router happens to pick may run the
 *  PREVIOUS build — and the symptom is an error about the code you are testing, not about the cache.
 *
 *  It is directly observable, though: read the clone and compare its bytes against the local artifact.
 *
 *  The obvious cheap version of this check — compare LENGTHS — is wrong, and worth recording because
 *  it looked right and produced a confident answer. A LoaderV4 clone is 48 bytes of header plus the
 *  program data account's whole allocation, so its length tracks the deploy's `--max-len`, not the
 *  ELF inside it. Two different builds deployed under the same `max_len` measure identically. What
 *  the length DID reveal, correctly, was a clone frozen at a `max_len` the base layer had since grown
 *  past — genuinely stale, but only visible because that particular upgrade happened to extend the
 *  account. Comparing the bytes answers the actual question in every case. */
async function pickValidator(pinned: PublicKey | null): Promise<{ identity: PublicKey; fqdn: string } | null> {
  const soPath = join(__dirname, "..", "..", "target", "deploy", "bulls_arena.so");
  const localElf = new Uint8Array(readFileSync(soPath));
  const LOADER_V4_HEADER = 48;
  info(`local build ${localElf.length} B (${soPath.replace(/.*\/target/, "target")})`);

  const fresh: { identity: PublicKey; fqdn: string }[] = [];
  for (const { identity, fqdn } of await routerValidators()) {
    assertDevnetUrl(fqdn, "ER validator");
    try {
      const acct = await new Connection(fqdn, "confirmed").getAccountInfo(PROGRAM_ID);
      let state: string;
      let usable: boolean;
      if (!acct) {
        state = "no clone yet — will pull the current build on first use";
        usable = true;
      } else {
        const cloned = acct.data.subarray(LOADER_V4_HEADER, LOADER_V4_HEADER + localElf.length);
        usable = cloned.length === localElf.length && Buffer.from(cloned).equals(Buffer.from(localElf));
        state = usable ? "CURRENT — byte-identical to the local build" : "STALE — serving a different build";
      }
      console.log(`    ${fqdn.padEnd(38)} ${identity.toBase58().slice(0, 8)}…  ${state}`);
      if (usable) fresh.push({ identity, fqdn });
    } catch (e) {
      console.log(`    ${fqdn.padEnd(38)} unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (pinned) {
    const match = fresh.find((v) => v.identity.equals(pinned));
    if (!match) throw new Error(`--validator ${pinned.toBase58()} is not among the validators serving the current build`);
    return match;
  }
  return fresh[0] ?? null;
}

interface Snapshot {
  phase: number;
  tickCount: bigint;
  pot: bigint;
  fighters: { wallet: PublicKey; side: number; dead: number; stake: bigint; hp: bigint; banked: bigint }[];
}

function snapshot(raw: RawRoundAccount): Snapshot {
  return {
    phase: raw.phase,
    tickCount: BigInt(raw.tickCount.toString()),
    pot: BigInt(raw.pot.toString()),
    fighters: raw.fighters.slice(0, raw.fighterCount).map((f) => ({
      wallet: f.wallet, side: f.side, dead: f.dead,
      stake: BigInt(f.stake.toString()), hp: BigInt(f.hp.toString()), banked: BigInt(f.banked.toString()),
    })),
  };
}

/** Value MOVES; it is never created or destroyed. Asserted at every checkpoint rather than once at
 *  the end, so a break is attributed to the instruction that caused it. */
function assertConserved(s: Snapshot, where: string): void {
  const total = s.fighters.reduce((n, f) => n + f.hp + f.banked, 0n);
  if (total !== s.pot) throw new Error(`value not conserved ${where}: sum(hp+banked)=${total} vs pot=${s.pot}`);
}

const pct = (part: bigint, whole: bigint) => `${(Number(part) / Number(whole) * 100).toFixed(1)}%`;

(async () => {
  console.log(`${c.d}STEPPED FIGHT — proving extract() banks only what REMAINS, on real devnet${c.x}`);

  const argv = process.argv.slice(2);
  const pinArg = argv.indexOf("--validator");
  const pinned = pinArg >= 0 ? new PublicKey(argv[pinArg + 1]) : null;

  const router = new ConnectionMagicRouter(ROUTER_URL, "confirmed");
  const base = new Connection(BASE_RPC, "confirmed");
  const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
  info(`program ${PROGRAM_ID.toBase58()}`);
  info(`payer   ${forkPayer.publicKey.toBase58()}  ${((await base.getBalance(forkPayer.publicKey)) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const forkPayerWallet = createBurnerWallet(forkPayer);
  const authority = await createProgram(router, forkPayerWallet);
  const authorityBase = await createProgram(base, forkPayerWallet);
  const arenaPda = roundIx.arenaPda();
  const signatures: Record<string, string> = {};
  let roundPda = PublicKey.default;
  const readRound = async (p: BullsArenaProgram = authority) => snapshot(await p.account.round.fetch(roundPda));

  heading("0. which ER validators are serving the CURRENT build?");
  const validator = await pickValidator(pinned);
  if (!validator) {
    throw new Error(
      "every public ER validator is still serving a PREVIOUS build of this program id.\n" +
      "  Their bytecode cache is keyed by program id and is not refreshed by an upgrade, so there is\n" +
      "  no route on which a delegated round can run the code under test. The documented recovery is\n" +
      "  to deploy under a FRESH program id (see lib.rs's declare_id! note and MEGA_QUEUE.md #15).",
    );
  }
  ok(`pinning ${validator.fqdn} (${validator.identity.toBase58()})`);

  try {
    heading("1. init_arena / open_round / delegate_round");
    let arena = await authorityBase.account.arena.fetchNullable(arenaPda);
    if (!arena) {
      const { signature } = await sendTx(router,
        roundIx.initArena(authority, { arena: arenaPda, authority: forkPayer.publicKey, feeBps: 20 }),
        forkPayer, "init_arena");
      signatures.initArena = signature;
      // `sendTx` confirms against the endpoint it SENT to (the router). Reading straight back from an
      // independent base-layer connection can land before that connection has caught up, which reads
      // as "account does not exist" — a confusing way to describe a fresh account. Poll it.
      for (let i = 0; i < 20 && !arena; i++) {
        await sleep(1000);
        arena = await authorityBase.account.arena.fetchNullable(arenaPda);
      }
      if (!arena) throw new Error("init_arena confirmed but the arena never appeared on the base layer");
      ok(`arena created for this program id (fee ${arena.feeBps} bps)`);
    }
    const roundNo = BigInt(arena.roundCounter.toString()) + 1n;
    roundPda = roundIx.roundPdaForRoundNo(roundNo, arenaPda);
    info(`round #${roundNo}  pda ${roundPda.toBase58()}`);
    signatures.openRound = (await sendTx(router,
      roundIx.openRound(authority, {
        arena: arenaPda, round: roundPda, authority: forkPayer.publicKey, roundNo,
        seedCommit: crypto.getRandomValues(new Uint8Array(32)),
      }), forkPayer, `open_round #${roundNo}`)).signature;

    signatures.delegateRound = (await sendTx(router,
      roundIx.delegateRound(authority, {
        arena: arenaPda, round: roundPda, authority: forkPayer.publicKey, roundNo,
        validator: validator.identity,
      }), forkPayer, "delegate_round (pinned)")).signature;

    for (let i = 0; i < 10; i++) {
      const acct = await base.getAccountInfo(roundPda);
      if (acct?.owner.equals(DELEGATION_PROGRAM_ID)) break;
      await sleep(1000);
    }
    ok("round delegated to the ER");

    heading("2. two fighters enter");
    const playerA = loadOrCreateBurnerKeypair();
    const playerB = loadOrCreateBurnerKeypair();
    {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: playerA.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
        SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: playerB.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
      );
      const sig = await base.sendTransaction(tx, [forkPayer]);
      await base.confirmTransaction(sig, "confirmed");
      info(`funded A ${playerA.publicKey.toBase58()}`);
      info(`funded B ${playerB.publicKey.toBase58()}`);
    }
    const progA = await createProgram(router, createBurnerWallet(playerA));
    const progB = await createProgram(router, createBurnerWallet(playerB));
    signatures.enterA = (await sendTx(router, roundIx.enter(progA, {
      arena: arenaPda, round: roundPda, player: playerA.publicKey, signer: playerA.publicKey,
      sessionToken: null, side: 0, stake: 1_000_000,
    }), playerA, "enter A (side 0, 1,000,000)")).signature;
    signatures.enterB = (await sendTx(router, roundIx.enter(progB, {
      arena: arenaPda, round: roundPda, player: playerB.publicKey, signer: playerB.publicKey,
      sessionToken: null, side: 1, stake: 1_000_000,
    }), playerB, "enter B (side 1, 1,000,000)")).signature;

    heading("3. close_lobby_and_draw + the real VRF callback");
    const status = (await router.getDelegationStatus(roundPda)) as { fqdn?: string };
    const fqdn = status.fqdn;
    if (!fqdn) throw new Error("no fqdn for the delegated round");
    assertDevnetUrl(fqdn, "ER validator");
    info(`round's own validator: ${fqdn}`);
    signatures.closeLobby = (await sendTx(router,
      roundIx.closeLobbyAndDraw(authority, {
        payer: forkPayer.publicKey, round: roundPda, clientSeed: crypto.getRandomValues(new Uint8Array(32)),
      }), forkPayer, "close_lobby_and_draw", { endpoint: fqdn })).signature;

    const drawStart = Date.now();
    let s = await readRound();
    while (Date.now() - drawStart < 120_000 && s.phase !== Phase.Fight) {
      if (s.phase !== Phase.Drawing) throw new Error(`unexpected phase ${PHASE_NAME[s.phase]}`);
      await sleep(1500);
      s = await readRound();
    }
    if (s.phase !== Phase.Fight) throw new Error("VRF callback never landed within 120s");
    const raw = await authority.account.round.fetch(roundPda);
    const fightStartedAt = Number(raw.fightStartedAt.toString());
    const fighterCount = raw.fighterCount;
    ok(`phase FIGHT after ${((Date.now() - drawStart) / 1000).toFixed(1)}s — pace is ${stepsPerSecond(fighterCount)} steps/s for ${fighterCount} fighters`);

    // ---- the baseline the old code never left ------------------------------------------------------
    heading("4. BEFORE any ticking: hp is the full stake, as it always was");
    assertConserved(s, "at fight start");
    const stakeA = s.fighters[0].stake;
    info(`A: hp=${s.fighters[0].hp} stake=${stakeA} · B: hp=${s.fighters[1].hp} · cursor=${s.tickCount}`);
    if (s.fighters[0].hp !== stakeA) warn("hp already below stake before we ticked — someone else is ticking this round");

    // ---- tick the fight forward, in the rollup ------------------------------------------------------
    heading("5. tick() — advancing the fight on-chain, a second at a time");
    const tickSigs: string[] = [];
    const TICKS = 5;
    for (let i = 0; i < TICKS; i++) {
      const target = canonicalCursor(fightStartedAt, fighterCount, Date.now() / 1000);
      const cur = (await readRound()).tickCount;
      const backlog = Number(target) - Number(cur);
      if (backlog <= 0) { await sleep(600); continue; }
      // Tick the WHOLE backlog, not one second's worth. A round-trip to the ER costs ~850ms here, so a
      // client that only ever advances one second per call falls further behind on every call and
      // never catches up — measured on the first run of this script, where five ticks left the stored
      // cursor 42 steps behind the clock.
      const steps = backlog;
      const { signature, elapsedMs } = await sendTx(router,
        roundIx.tick(authority, { round: roundPda, steps }), forkPayer, `tick(${steps})`);
      tickSigs.push(signature);
      const after = await readRound();
      assertConserved(after, `after tick ${i + 1}`);
      info(`  cursor ${cur} -> ${after.tickCount}  A.hp=${after.fighters[0].hp} (${pct(after.fighters[0].hp, stakeA)}) ` +
           `B.hp=${after.fighters[1].hp}  ${elapsedMs}ms`);
      await sleep(900);
    }
    signatures.ticks = tickSigs.join(",");

    const ticked = await readRound();
    if (ticked.tickCount === 0n) throw new Error("cursor never moved — tick() did nothing at all");
    if (ticked.fighters[0].hp >= stakeA) {
      throw new Error(`hp did NOT decay: A.hp=${ticked.fighters[0].hp} is still >= the stake ${stakeA}. ` +
        `This is exactly the bug this change exists to fix.`);
    }
    ok(`${tickSigs.length} ticks advanced the fight to cursor ${ticked.tickCount}; A's hp fell ${stakeA} -> ${ticked.fighters[0].hp} (${pct(ticked.fighters[0].hp, stakeA)} of stake)`);

    // ---- the property that makes `tick` safe to leave permissionless --------------------------------
    //
    // Not "a repeat tick does nothing" — that was this script's first attempt at the assertion and it
    // was simply wrong, because a tick legitimately catches up whatever backlog exists. The real
    // property, the one the missing authority check is justified by, is that NO caller can push the
    // fight past where the clock already says it is, however large an argument they pass.
    heading("6. a caller cannot tick the fight past the clock, whatever they ask for");
    {
      const sig = (await sendTx(router,
        roundIx.tick(authority, { round: roundPda, steps: MAX_STEPS }), forkPayer,
        `tick(${MAX_STEPS}) — asking for the entire fight at once`)).signature;
      signatures.tickGreedy = sig;
      const after = await readRound();
      const allowed = canonicalCursor(fightStartedAt, fighterCount, Date.now() / 1000);
      if (Number(after.tickCount) > allowed) {
        throw new Error(`tick(${MAX_STEPS}) reached cursor ${after.tickCount} but the clock only allows ${allowed} — ` +
          `a caller who can outrun the clock can choose where the fight stops, which is the exact bug ` +
          `the 'steps' argument was removed from resolve() for.`);
      }
      assertConserved(after, "after a greedy tick");
      ok(`asked for ${MAX_STEPS} steps, got cursor ${after.tickCount} (clock allows ${allowed}) — bounded by time, not by the argument`);
    }

    // ---- extract must catch the fight up BY ITSELF ---------------------------------------------------
    heading("7. deliberately stop ticking, then extract — extract must catch up on its own");
    const IDLE_SECONDS = 4;
    info(`not ticking for ${IDLE_SECONDS}s, so the stored cursor falls behind real time…`);
    await sleep(IDLE_SECONDS * 1000);
    const beforeExtract = await readRound();
    const owedCursor = canonicalCursor(fightStartedAt, fighterCount, Date.now() / 1000);
    info(`stored cursor=${beforeExtract.tickCount}, real time says ${owedCursor} — a backlog of ${owedCursor - Number(beforeExtract.tickCount)} steps`);
    if (owedCursor <= Number(beforeExtract.tickCount)) warn("no backlog built up (fight may already have finished) — the catch-up assertion below is vacuous");

    const hpAtDecision = beforeExtract.fighters[0].hp;
    signatures.extract = (await sendTx(router, roundIx.extract(progA, {
      round: roundPda, player: playerA.publicKey, signer: playerA.publicKey, sessionToken: null,
    }), playerA, "extract (player A, mid-fight)")).signature;

    const afterExtract = await readRound();
    const a = afterExtract.fighters[0];
    assertConserved(afterExtract, "after extract");

    if (afterExtract.tickCount < BigInt(owedCursor)) {
      throw new Error(`extract() did not catch the fight up: cursor is ${afterExtract.tickCount}, real time says ${owedCursor}. ` +
        `A stale cursor here means a player can be paid out at an hp the clock says they no longer have.`);
    }
    ok(`extract() advanced the fight itself: cursor ${beforeExtract.tickCount} -> ${afterExtract.tickCount} with nobody ticking`);

    if (a.hp !== 0n) throw new Error(`hp should be 0 after extract, got ${a.hp}`);
    if (a.dead !== 1) throw new Error(`dead should be 1 after extract, got ${a.dead}`);

    // ---- THE ASSERTION THIS SCRIPT EXISTS FOR --------------------------------------------------------
    //
    // The quantity under test is what EXTRACT PAID OUT: the hp still in the ring at the instant it ran.
    //
    // Two obvious ways to get that number are both wrong, and both were tried against real devnet
    // before this one, which is why they are named here rather than quietly replaced:
    //
    //   * `banked` itself — that is the player's whole purse, raids included. A player who has been
    //     winning finishes with more in it than they staked (measured: 100.2% of stake), which is the
    //     game working, not the mechanic failing.
    //   * the CHANGE in `banked` across the extract transaction — that is the payout PLUS whatever the
    //     player raided during the catch-up steps the same transaction ran (measured: 33,330 against
    //     11,213 hp, which reads as value creation and is not).
    //
    // The honest source is the deterministic replay. The fight is a pure function of (seed, entries,
    // cursor), so running the TypeScript mirror to the cursor the chain ended on gives A's hp at that
    // exact moment — which IS the payout — and comparing the whole post-extract state against the
    // chain proves the two implementations agree, rather than just the one number.
    heading("8. THE POINT: extract paid out only what was left in the ring");
    const entries: HitEventEntry[] = beforeExtract.fighters.map((f) => ({
      wallet: f.wallet.toBase58(), side: f.side as 0 | 1, stake: f.stake,
    }));
    const mirror = buildRoundFromEntries(Buffer.from(raw.seed), entries);
    computeHitEvents(mirror, Number(afterExtract.tickCount));
    const taken = simExtract(mirror, playerA.publicKey.toBase58());

    for (let i = 0; i < entries.length; i++) {
      const chainF = afterExtract.fighters[i];
      const simF = mirror.fighters[i];
      if (chainF.hp !== simF.hp || chainF.banked !== simF.banked || BigInt(chainF.dead) !== BigInt(simF.dead)) {
        throw new Error(`chain and mirror disagree at cursor ${afterExtract.tickCount}, fighter ${i}: ` +
          `chain hp=${chainF.hp} banked=${chainF.banked} dead=${chainF.dead} vs ` +
          `mirror hp=${simF.hp} banked=${simF.banked} dead=${simF.dead}`);
      }
    }
    ok(`chain and the TypeScript mirror agree exactly at cursor ${afterExtract.tickCount}, for every fighter`);

    console.log(`     stake at entry         ${stakeA}`);
    console.log(`     hp before the catch-up ${hpAtDecision}`);
    console.log(`     ${c.b}EXTRACT PAID OUT       ${taken}   ${pct(taken, stakeA)} of the stake${c.x}`);
    console.log(`     final purse (raids included) ${a.banked}`);
    if (taken >= stakeA) {
      throw new Error(`extract paid out ${taken} against a stake of ${stakeA} — a full refund, which is ` +
        `precisely the decorative extract() this change exists to remove.`);
    }
    ok(`extract paid ${taken} < stake ${stakeA}: staying in this long cost the player ${stakeA - taken} of what pulling out at the opening bell would have returned`);

    // ---- finish and settle ---------------------------------------------------------------------------
    heading("9. resolve + close_round");
    // Side 0's only fighter has extracted, so the fight is over by the program's own rule and
    // `resolve` is legal immediately. The retry covers the case where it isn't yet.
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        signatures.resolve = (await sendTx(router,
          roundIx.resolve(authority, { payer: forkPayer.publicKey, round: roundPda }), forkPayer, "resolve")).signature;
        break;
      } catch (e) {
        if (e instanceof AnchorError && e.error.errorCode.code === "FightNotOverYet" && attempt < 4) {
          warn("resolve refused — both sides still standing and the bell has not rung; waiting 5s");
          await sleep(5000);
          continue;
        }
        throw e;
      }
    }
    const settled = await readRound();
    if (settled.phase !== Phase.Settled) throw new Error(`phase is ${PHASE_NAME[settled.phase]}, expected Settled`);
    assertConserved(settled, "after resolve");
    if (settled.tickCount > BigInt(MAX_STEPS)) throw new Error(`cursor ${settled.tickCount} exceeded MAX_STEPS ${MAX_STEPS}`);
    ok(`settled at cursor ${settled.tickCount}; winner side ${(await authority.account.round.fetch(roundPda)).winner}`);

    signatures.closeRound = (await sendTx(router,
      roundIx.closeRound(authority, { payer: forkPayer.publicKey, round: roundPda }), forkPayer, "close_round")).signature;

    let cameHome = false;
    for (let i = 0; i < 20; i++) {
      const acct = await base.getAccountInfo(roundPda);
      if (acct?.owner.equals(PROGRAM_ID)) { cameHome = true; break; }
      await sleep(3000);
    }
    if (!cameHome) throw new Error("round never came back from the ER");
    const final = snapshot(await authorityBase.account.round.fetch(roundPda));
    assertConserved(final, "on the base layer after undelegation");
    ok("round came home; value conserved on the base layer too");

    heading("FINAL STATE (read from the base layer)");
    for (const f of final.fighters) {
      console.log(`  ${f.wallet.toBase58().slice(0, 8)}…  side ${f.side}  stake ${f.stake}  hp ${f.hp}  banked ${f.banked}  dead ${f.dead}`);
    }
    console.log(`  pot ${final.pot}  cursor ${final.tickCount}`);

    console.log(`\n${c.g}${c.b}PASS${c.x} — the fight advanced on-chain and extract banked only what remained.`);
    console.log(JSON.stringify(signatures, null, 2));
  } catch (e) {
    console.error(`\n${c.r}${c.b}FAILED${c.x}\n  ${c.r}${describeError(e)}${c.x}`);
    console.error(JSON.stringify(signatures, null, 2));
    process.exit(1);
  }
})();
