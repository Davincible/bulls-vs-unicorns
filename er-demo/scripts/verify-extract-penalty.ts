#!/usr/bin/env bun
// THE ONE CLAIM THIS SCRIPT EXISTS TO PROVE, ON REAL DEVNET, WITH REAL SIGNATURES:
//
//     bailing out EARLY costs materially more than bailing out LATE — and by the published curve.
//
// A single extract proves nothing about decay. Two of them, in the SAME round, at clearly different
// points of the same fight, is the whole point: same seed, same lineup, same stakes, same pot, one
// variable — when the button was pressed. `verify-stepped-fight.ts` proves the other half (that
// extracting banks only what REMAINS in the ring); this proves what it now costs to do so.
//
// FOUR FIGHTERS, TWO PER SIDE, and that is not incidental. With one fighter a side, the first extract
// ends the fight (`fight_is_over` — pull the last opponent out and there is nobody left to raid), so
// the second extractor would be deciding under no risk at all and the comparison would be between a
// real decision and a formality. Two a side means the fight is genuinely still running when the late
// extract lands. It also sets the horizon this round is measured against: 4 fighters -> 8 steps/s and
// a 200-step (25-second) penalty horizon, which is short enough to walk the curve end to end inside
// one round.
//
// WHAT ELSE IS CHECKED, because each of these would quietly hollow out the claim:
//
//   * the three-term conservation identity — sum(hp + banked) + penalties_collected == pot — at every
//     checkpoint, on the ER and again on the base layer after undelegation. Value now LEAVES the
//     round, and the only honest way to keep conservation provable is to record where it went;
//   * that the on-chain penalty equals what the independent TypeScript mirror derives from the same
//     cursor, for BOTH extracts. The rate is a published curve, so "the house took something" is not
//     the claim — "the house took exactly this" is;
//   * that the `Extracted` event carries the same numbers the account does, so a client can show
//     "you banked X, penalty Y" without trusting anything it didn't read itself.
//
//   cd er-demo && bun run scripts/verify-extract-penalty.ts [--validator <identity-pubkey>]

import { assertDevnetUrl } from "../src/devnet-guard.ts";
import {
  BASE_RPC, canonicalCursor, PHASE_NAME, Phase, PROGRAM_ID, ROUTER_URL, stepsPerSecond,
} from "../src/chain/constants.ts";
import { createProgram, type BullsArenaProgram, type RawRoundAccount } from "../src/chain/program.ts";
import { sendTx } from "../src/chain/sendTx.ts";
import { createBurnerWallet } from "../src/chain/useSigner.ts";
import * as roundIx from "../src/chain/round.ts";
import { NO_FRESH_VALIDATOR, pickValidator } from "./erValidator.ts";
// The independent replay — the same mirror VerifyPanel re-derives a settled round with. Used here to
// name what each extract actually moved, which the account diff alone cannot: an extract transaction
// also runs catch-up steps, so the change in `banked` across it is the payout PLUS whatever the
// player raided on the way (verify-stepped-fight.ts records that trap in full).
import { buildRoundFromEntries, computeHitEvents, type HitEventEntry } from "../src/sim/hitEvents.ts";
import { extract as simExtract, extractPenaltyBps, penaltyHorizonSteps } from "../src/sim/erSim.ts";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from "@solana/web3.js";
import { AnchorError, BorshCoder, EventParser } from "@coral-xyz/anchor";
import { ConnectionMagicRouter, DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { loadIdl } from "../src/chain/idl.ts";

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

const STAKE = 1_000_000;
/** Where the late extract aims, as a fraction of the penalty horizon. 0.75 leaves the late rate at a
 *  quarter of the early one by construction, which is a difference nobody can call noise, while still
 *  landing well before the median 4-fighter fight (236 steps) has run out of fighters to hit. */
const LATE_TARGET_FRACTION = 0.75;

interface Fighter {
  wallet: PublicKey; side: number; dead: number; stake: bigint; hp: bigint; banked: bigint;
}
interface Snapshot {
  phase: number; tickCount: bigint; pot: bigint; penaltiesCollected: bigint; fighters: Fighter[];
}

function snapshot(raw: RawRoundAccount): Snapshot {
  return {
    phase: raw.phase,
    tickCount: BigInt(raw.tickCount.toString()),
    pot: BigInt(raw.pot.toString()),
    penaltiesCollected: BigInt(raw.penaltiesCollected.toString()),
    fighters: raw.fighters.slice(0, raw.fighterCount).map((f) => ({
      wallet: f.wallet, side: f.side, dead: f.dead,
      stake: BigInt(f.stake.toString()), hp: BigInt(f.hp.toString()), banked: BigInt(f.banked.toString()),
    })),
  };
}

/** The identity, with the leak named: what the table still holds, plus what the house has taken, is
 *  exactly what was staked. An exact equality rather than an inequality on purpose — `>=` would pass
 *  just as happily if the house took twice what the curve says. */
function assertConserved(s: Snapshot, where: string): void {
  const held = s.fighters.reduce((n, f) => n + f.hp + f.banked, 0n);
  if (held + s.penaltiesCollected !== s.pot) {
    throw new Error(
      `value not conserved ${where}: sum(hp+banked)=${held} + penalties=${s.penaltiesCollected} vs pot=${s.pot}`,
    );
  }
}

const pct = (part: bigint, whole: bigint) => `${(Number(part) / Number(whole) * 100).toFixed(2)}%`;
const rateOf = (penalty: bigint, taken: bigint) => (taken === 0n ? 0 : Number(penalty * 10_000n / taken));

interface ExtractOutcome {
  who: string;
  signature: string;
  cursor: bigint;
  taken: bigint;
  kept: bigint;
  penalty: bigint;
  rateBps: number;
}

(async () => {
  console.log(`${c.d}EXTRACT PENALTY — proving the cost of bailing DECAYS, on real devnet${c.x}`);

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
  if (!validator) throw new Error(NO_FRESH_VALIDATOR);
  ok(`pinning ${validator.fqdn} (${validator.identity.toBase58()})`);
  const erConn = new Connection(validator.fqdn, "confirmed");

  try {
    heading("1. init_arena / open_round / delegate_round");
    let arena = await authorityBase.account.arena.fetchNullable(arenaPda);
    if (!arena) {
      signatures.initArena = (await sendTx(router,
        roundIx.initArena(authority, { arena: arenaPda, authority: forkPayer.publicKey, feeBps: 20 }),
        forkPayer, "init_arena")).signature;
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

    heading("2. four fighters enter — two a side, so the fight survives the first extract");
    // Fresh keypairs per run rather than the shared burner: this round needs FOUR distinct fighter
    // identities, and `enter` merges a repeat entry from the same wallet on the same side into the
    // existing fighter rather than creating a second one.
    const players = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const labels = ["A1 (side 0, bails early)", "A2 (side 0, holds on)", "B1 (side 1)", "B2 (side 1)"];
    {
      const tx = new Transaction().add(...players.map((p) => SystemProgram.transfer({
        fromPubkey: forkPayer.publicKey, toPubkey: p.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL,
      })));
      const sig = await base.sendTransaction(tx, [forkPayer]);
      await base.confirmTransaction(sig, "confirmed");
      players.forEach((p, i) => info(`funded ${labels[i].padEnd(26)} ${p.publicKey.toBase58()}`));
    }
    const progs = await Promise.all(players.map(async (p) => createProgram(router, createBurnerWallet(p))));
    for (let i = 0; i < players.length; i++) {
      signatures[`enter${i}`] = (await sendTx(router, roundIx.enter(progs[i], {
        arena: arenaPda, round: roundPda, player: players[i].publicKey, signer: players[i].publicKey,
        sessionToken: null, side: (i < 2 ? 0 : 1) as 0 | 1, stake: STAKE,
      }), players[i], `enter ${labels[i]}`)).signature;
    }

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
    const seed = Buffer.from(raw.seed);
    const fightStartedAt = Number(raw.fightStartedAt.toString());
    const fighterCount = raw.fighterCount;
    const horizon = Number(penaltyHorizonSteps(fighterCount));
    ok(`phase FIGHT — ${fighterCount} fighters, ${stepsPerSecond(fighterCount)} steps/s, ` +
       `penalty horizon ${horizon} steps (${(horizon / stepsPerSecond(fighterCount)).toFixed(0)}s)`);
    assertConserved(s, "at fight start");
    if (s.penaltiesCollected !== 0n) throw new Error(`a fresh round must start with no penalties, got ${s.penaltiesCollected}`);

    // The mirror walks the same fight the chain does: ticked to each extract's cursor, extracted in
    // the same order. Every number this script reports about a payout comes from here, and every one
    // of them is checked against the chain.
    const entries: HitEventEntry[] = s.fighters.map((f) => ({
      wallet: f.wallet.toBase58(), side: f.side as 0 | 1, stake: f.stake,
    }));
    const mirror = buildRoundFromEntries(seed, entries);
    const outcomes: ExtractOutcome[] = [];

    /** Extract `player`, then reconcile every number three ways: the chain's account diff, the
     *  mirror's replay, and the program's own `Extracted` event. */
    async function extractAndReconcile(index: number, label: string): Promise<ExtractOutcome> {
      const before = await readRound();
      const { signature } = await sendTx(router, roundIx.extract(progs[index], {
        round: roundPda, player: players[index].publicKey, signer: players[index].publicKey, sessionToken: null,
      }), players[index], `extract — ${label}`);
      const after = await readRound();
      assertConserved(after, `after the ${label} extract`);

      const cursor = after.tickCount;
      // Walk the mirror to exactly where the chain ended up, then extract there. `extract()` catches
      // the fight up itself, so this cursor is the one the payout was priced at.
      computeHitEvents(mirror, Number(cursor) - Number(mirror.tickCount));
      if (mirror.tickCount !== cursor) throw new Error(`mirror at ${mirror.tickCount}, chain at ${cursor}`);
      const { taken, kept, penalty } = simExtract(mirror, players[index].publicKey.toBase58());

      // 1. the chain's fighters must equal the mirror's, one by one — the parity claim ER-051 exists
      //    for, re-checked at this exact cursor rather than assumed to still hold.
      for (let i = 0; i < entries.length; i++) {
        const chainF = after.fighters[i], simF = mirror.fighters[i];
        if (chainF.hp !== simF.hp || chainF.banked !== simF.banked || BigInt(chainF.dead) !== BigInt(simF.dead)) {
          throw new Error(`chain and mirror disagree at cursor ${cursor}, fighter ${i}: ` +
            `chain hp=${chainF.hp} banked=${chainF.banked} dead=${chainF.dead} vs ` +
            `mirror hp=${simF.hp} banked=${simF.banked} dead=${simF.dead}`);
        }
      }
      // 2. the house's take must be the published curve's answer, not merely "something".
      const onChainPenalty = after.penaltiesCollected - before.penaltiesCollected;
      if (onChainPenalty !== penalty) {
        throw new Error(`penalty disagrees: chain took ${onChainPenalty}, the curve says ${penalty} at cursor ${cursor}`);
      }
      if (mirror.penaltiesCollected !== after.penaltiesCollected) {
        throw new Error(`cumulative penalties disagree: chain ${after.penaltiesCollected}, mirror ${mirror.penaltiesCollected}`);
      }
      const expectedBps = Number(extractPenaltyBps(fighterCount, cursor));
      if (penalty !== taken * BigInt(expectedBps) / 10_000n) {
        throw new Error(`penalty ${penalty} is not ${expectedBps}bps of ${taken}`);
      }
      // 3. the event must say the same thing the account does, or a client cannot show the split
      //    without re-deriving it.
      await assertEventAgrees(signature, players[index].publicKey, { taken, penalty, cursor });

      const outcome: ExtractOutcome = {
        who: label, signature, cursor, taken, kept, penalty, rateBps: rateOf(penalty, taken),
      };
      outcomes.push(outcome);
      ok(`${label}: cursor ${cursor}/${horizon} — ${taken} left the ring, ${kept} banked, ` +
         `${c.b}${penalty} to the house (${(outcome.rateBps / 100).toFixed(2)}%)${c.x}`);
      return outcome;
    }

    /** The `Extracted` event, read back off the ER and decoded with our own IDL. Its contract is
     *  `amount` gross, `penalty` to the house, `banked = amount - penalty`, `cursor` where the fight
     *  stood — which is what makes the rate re-derivable from the event alone. */
    async function assertEventAgrees(
      signature: string,
      player: PublicKey,
      expect: { taken: bigint; penalty: bigint; cursor: bigint },
    ): Promise<void> {
      const idl = await loadIdl();
      const parser = new EventParser(PROGRAM_ID, new BorshCoder(idl));
      let logs: string[] | null = null;
      for (let i = 0; i < 8 && !logs; i++) {
        const tx = await erConn.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
        logs = tx?.meta?.logMessages ?? null;
        if (!logs) await sleep(1000);
      }
      if (!logs) {
        // Reading a confirmed transaction back is the ER endpoint's business, not the program's, and
        // it is the one thing here that can fail for reasons that have nothing to do with the claim.
        // Say so loudly rather than silently skipping — the account-level checks above already
        // passed, so this is a gap in OBSERVATION, not in the result.
        warn(`could not read logs for ${signature} back from ${validator!.fqdn} — event contract UNVERIFIED for this extract`);
        return;
      }
      const events = [...parser.parseLogs(logs)].filter((e) => e.name === "extracted" || e.name === "Extracted");
      if (events.length !== 1) throw new Error(`expected exactly one Extracted event, got ${events.length}`);
      const d = events[0].data as { player: PublicKey; amount: bigint | { toString(): string }; penalty: bigint | { toString(): string }; cursor: bigint | { toString(): string } };
      const big = (v: { toString(): string }) => BigInt(v.toString());
      if (!d.player.equals(player)) throw new Error(`event names ${d.player.toBase58()}, expected ${player.toBase58()}`);
      if (big(d.amount) !== expect.taken) throw new Error(`event amount ${big(d.amount)} vs ${expect.taken}`);
      if (big(d.penalty) !== expect.penalty) throw new Error(`event penalty ${big(d.penalty)} vs ${expect.penalty}`);
      if (big(d.cursor) !== expect.cursor) throw new Error(`event cursor ${big(d.cursor)} vs ${expect.cursor}`);
      if (big(d.amount) - big(d.penalty) !== expect.taken - expect.penalty) throw new Error("event split does not reconcile");
    }

    heading("4. THE EARLY BAIL — the exploit this penalty exists to price");
    info("extracting immediately, having taken essentially no damage: the near-free option");
    const early = await extractAndReconcile(0, "A1 early");

    heading(`5. tick the fight on, then THE LATE BAIL at ~${Math.round(LATE_TARGET_FRACTION * 100)}% of the horizon`);
    const lateTarget = Math.floor(horizon * LATE_TARGET_FRACTION);
    const tickSigs: string[] = [];
    while (true) {
      const now = await readRound();
      const a2 = now.fighters[1];
      if (Number(now.tickCount) >= lateTarget) break;
      // A2 is the only fighter left on side 0, so it takes every blow side 1 lands. If it is about to
      // be finished off, extract NOW and compare at whatever cursor we reached — a smaller gap than
      // planned still proves decay, whereas a dead fighter proves nothing at all.
      if (a2.dead === 1 || a2.hp * 20n < a2.stake) {
        warn(`A2 is down to ${a2.hp} of ${a2.stake} at cursor ${now.tickCount} — extracting before the fight ends it`);
        break;
      }
      const allowed = canonicalCursor(fightStartedAt, fighterCount, Date.now() / 1000);
      const backlog = allowed - Number(now.tickCount);
      if (backlog <= 0) { await sleep(700); continue; }
      const { signature } = await sendTx(router,
        roundIx.tick(authority, { round: roundPda, steps: backlog }), forkPayer, `tick(${backlog})`);
      tickSigs.push(signature);
      const after = await readRound();
      assertConserved(after, "after a tick");
      info(`  cursor ${now.tickCount} -> ${after.tickCount}  A2.hp=${after.fighters[1].hp} ` +
           `(${pct(after.fighters[1].hp, after.fighters[1].stake)} of stake)  ` +
           `rate here would be ${(Number(extractPenaltyBps(fighterCount, after.tickCount)) / 100).toFixed(2)}%`);
      await sleep(700);
    }
    signatures.ticks = tickSigs.join(",");
    const late = await extractAndReconcile(1, "A2 late");

    // ---- THE COMPARISON THIS SCRIPT EXISTS FOR ------------------------------------------------------
    heading("6. THE POINT: the same decision, priced by WHEN it was made");
    signatures.extractEarly = early.signature;
    signatures.extractLate = late.signature;
    console.log(`     ${"".padEnd(10)} ${"cursor".padStart(8)} ${"left ring".padStart(12)} ${"banked".padStart(12)} ${"penalty".padStart(10)} ${"rate".padStart(8)}`);
    for (const o of [early, late]) {
      console.log(`     ${o.who.padEnd(10)} ${String(o.cursor).padStart(8)} ${String(o.taken).padStart(12)} ` +
                  `${String(o.kept).padStart(12)} ${String(o.penalty).padStart(10)} ${((o.rateBps / 100).toFixed(2) + "%").padStart(8)}`);
    }
    if (late.cursor <= early.cursor) {
      throw new Error(`the two extracts landed at cursors ${early.cursor} and ${late.cursor} — there is no ` +
        `"early vs late" to compare. The fight did not advance between them.`);
    }
    if (early.rateBps <= late.rateBps) {
      throw new Error(`the penalty did NOT decay: early ${early.rateBps}bps at cursor ${early.cursor} vs ` +
        `late ${late.rateBps}bps at cursor ${late.cursor}. This is the entire claim.`);
    }
    ok(`the early bail paid ${(early.rateBps / 100).toFixed(2)}% and the late one ${(late.rateBps / 100).toFixed(2)}% — ` +
       `${(early.rateBps / Math.max(late.rateBps, 1)).toFixed(1)}x cheaper to hold your nerve ` +
       `(cursor ${early.cursor} -> ${late.cursor} of a ${horizon}-step horizon)`);

    const afterBoth = await readRound();
    if (afterBoth.penaltiesCollected !== early.penalty + late.penalty) {
      throw new Error(`the round records ${afterBoth.penaltiesCollected} in penalties, but the two extracts ` +
        `took ${early.penalty} + ${late.penalty} = ${early.penalty + late.penalty}`);
    }
    ok(`the round records exactly what the house took: ${afterBoth.penaltiesCollected} of a ${afterBoth.pot} pot`);

    heading("7. resolve + close_round — and the identity again, on the base layer");
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        signatures.resolve = (await sendTx(router,
          roundIx.resolve(authority, { payer: forkPayer.publicKey, round: roundPda }), forkPayer, "resolve")).signature;
        break;
      } catch (e) {
        if (e instanceof AnchorError && e.error.errorCode.code === "FightNotOverYet" && attempt < 6) {
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
    if (final.penaltiesCollected !== early.penalty + late.penalty) {
      throw new Error(`the base layer disagrees about the house's take: ${final.penaltiesCollected}`);
    }
    ok("round came home; the penalty and the identity both survived the commit and undelegate");

    heading("FINAL STATE (read from the base layer)");
    for (const f of final.fighters) {
      console.log(`  ${f.wallet.toBase58().slice(0, 8)}…  side ${f.side}  stake ${f.stake}  hp ${f.hp}  banked ${f.banked}  dead ${f.dead}`);
    }
    const held = final.fighters.reduce((n, f) => n + f.hp + f.banked, 0n);
    console.log(`  pot ${final.pot}  cursor ${final.tickCount}`);
    console.log(`  ${held} held + ${final.penaltiesCollected} penalties = ${held + final.penaltiesCollected}`);

    console.log(`\n${c.g}${c.b}PASS${c.x} — the extract penalty decays, and the round proves where the value went.`);
    console.log(JSON.stringify({ roundPda: roundPda.toBase58(), ...signatures }, null, 2));
  } catch (e) {
    console.error(`\n${c.r}${c.b}FAILED${c.x}\n  ${c.r}${describeError(e)}${c.x}`);
    console.error(JSON.stringify({ roundPda: roundPda.toBase58(), ...signatures }, null, 2));
    process.exit(1);
  }
})();
