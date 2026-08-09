#!/usr/bin/env bun
// TEMPORARY — drives one already-open, already-delegated round to Settled and sweeps it.
// Round #1 on the v6 arena was opened and entered by a run of verify-house-take.ts that then failed
// on a harness bug, leaving a live lobby behind. Every remaining step is either authority-signed by
// the fork payer or permissionless, so no player key is needed to finish it.
//
//   cd er-demo && bun run scripts/finish-stranded-round.ts <roundNo>

import { assertDevnetUrl } from "../src/devnet-guard.ts";
import { BASE_RPC, PHASE_NAME, Phase, PROGRAM_ID, ROUTER_URL } from "../src/chain/constants.ts";
import { createProgram } from "../src/chain/program.ts";
import { sendTx } from "../src/chain/sendTx.ts";
import { createBurnerWallet } from "../src/chain/useSigner.ts";
import * as roundIx from "../src/chain/round.ts";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

const roundNo = BigInt(process.argv[2] ?? "1");

(async () => {
  const router = new ConnectionMagicRouter(ROUTER_URL, "confirmed");
  const base = new Connection(BASE_RPC, "confirmed");
  const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
  const authority = await createProgram(router, createBurnerWallet(forkPayer));
  const authorityBase = await createProgram(base, createBurnerWallet(forkPayer));

  const arenaPda = roundIx.arenaPda();
  const treasuryPda = roundIx.treasuryPda(arenaPda);
  const roundPda = roundIx.roundPdaForRoundNo(roundNo, arenaPda);
  console.log(`finishing round #${roundNo}  ${roundPda.toBase58()}`);

  let round = await authority.account.round.fetch(roundPda);
  console.log(`  phase=${PHASE_NAME[round.phase]} fighters=${round.fighterCount} fees_collected=${round.feesCollected}`);

  if (round.phase === Phase.Lobby) {
    // Wait the deadline out rather than reaching for the authority early close. Finishing this round
    // is cleanup, but the permissionless branch is the one the keeper will actually use, and it costs
    // only the wait to put it on the record alongside the authority path.
    const closesAt = Number(round.lobbyClosesAt.toString());
    for (let left = closesAt + 2 - Math.floor(Date.now() / 1000); left > 0; left = closesAt + 2 - Math.floor(Date.now() / 1000)) {
      process.stdout.write(`  waiting out the lobby deadline: ${left}s   \r`);
      await sleep(Math.min(5000, left * 1000));
    }
    console.log("  lobby deadline passed — a permissionless close is now permitted");

    const status = (await router.getDelegationStatus(roundPda)) as { fqdn?: string };
    const fqdn = status.fqdn;
    if (!fqdn) throw new Error("no fqdn for this round");
    assertDevnetUrl(fqdn, "ER validator");
    // PERMISSIONLESS close — `authority: null`. The 600s deadline has long passed, so the deadline
    // rule permits this without any authority signature. (The authority early-close path is the one
    // verify-house-take.ts proves; this is the other branch, and it costs nothing to exercise here.)
    const { signature } = await sendTx(
      router,
      roundIx.closeLobbyAndDraw(authority, {
        payer: forkPayer.publicKey, round: roundPda, arena: arenaPda,
        clientSeed: crypto.getRandomValues(new Uint8Array(32)), authority: null,
      }),
      forkPayer,
      "close_lobby_and_draw (PERMISSIONLESS, past deadline)",
      { endpoint: fqdn },
    );
    console.log(`  closeLobbyAndDraw ${signature}`);
  }

  const drawStart = Date.now();
  round = await authority.account.round.fetch(roundPda);
  while (round.phase === Phase.Drawing) {
    if (Date.now() - drawStart > 90_000) throw new Error("VRF never landed");
    await sleep(2000);
    round = await authority.account.round.fetch(roundPda);
  }
  console.log(`  phase=${PHASE_NAME[round.phase]}`);

  // The bell is FIGHT_TIMEOUT_SECONDS = 120s after the fight starts; before then `resolve` is only
  // permitted once one side is genuinely empty. Retry across that whole window rather than guessing.
  for (let attempt = 1; ; attempt++) {
    try {
      const { signature } = await sendTx(router, roundIx.resolve(authority, { payer: forkPayer.publicKey, round: roundPda }), forkPayer, "resolve");
      console.log(`  resolve ${signature}`);
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt > 30) throw e;
      console.log(`  resolve not yet permitted (attempt ${attempt}) — ${msg.split("\n")[0]}`);
      await sleep(6000);
    }
  }

  const { signature: closeSig } = await sendTx(router, roundIx.closeRound(authority, { payer: forkPayer.publicKey, round: roundPda }), forkPayer, "close_round");
  console.log(`  closeRound ${closeSig}`);

  let home = false;
  for (let i = 0; i < 25; i++) {
    const acct = await base.getAccountInfo(roundPda);
    if (acct?.owner.equals(PROGRAM_ID)) { home = true; break; }
    await sleep(3000);
  }
  if (!home) throw new Error("round never undelegated");

  const { signature: sweepSig } = await sendTx(
    router,
    roundIx.sweepHouseTake(authority, { arena: arenaPda, round: roundPda, treasury: treasuryPda, roundNo }),
    forkPayer,
    "sweep_house_take",
  );
  console.log(`  sweepHouseTake ${sweepSig}`);

  for (let i = 0; i < 30; i++) {
    const t = await authorityBase.account.treasury.fetchNullable(treasuryPda);
    const r = await authorityBase.account.round.fetchNullable(roundPda);
    if (t && r?.houseSwept) {
      console.log(`\n  round #${roundNo} phase=${PHASE_NAME[r.phase]} swept=${r.houseSwept} fees=${r.feesCollected} penalties=${r.penaltiesCollected}`);
      console.log(`  treasury fees_accrued=${t.feesAccrued} penalties_accrued=${t.penaltiesAccrued} rounds_swept=${t.roundsSwept}`);
      process.exit(0);
    }
    await sleep(2000);
  }
  throw new Error("treasury/round never reflected the sweep");
})().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
