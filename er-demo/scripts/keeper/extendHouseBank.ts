// GROW AND FUND THE HOUSE WALLET POOL, AND DO NOTHING ELSE.
//
//   KEEPER_HOUSE_WALLET_COUNT=30 npx tsx scripts/keeper/extendHouseBank.ts --dry-run
//   KEEPER_HOUSE_WALLET_COUNT=30 npx tsx scripts/keeper/extendHouseBank.ts
//
// WHY THIS EXISTS RATHER THAN "just run the keeper once". Growing the pool means generating keys and
// funding them, and both already happen at keeper boot — so the obvious instruction is to run the
// keeper locally without --dry-run and let it do it. That instruction is dangerous, and the danger is
// the single worst failure this system has:
//
//   The Fly keeper is running. A local keeper is a SECOND KEEPER. Both read `arena.round_counter`,
//   both try to open `counter + 1`, and the loser's round is left BEHIND the counter — delegated,
//   past its deadline, holding ~0.0235 SOL of rent that no instruction reclaims. That is a PERMANENT
//   loss even now that `close_round_account` exists: the round never reaches a terminal phase, so it
//   can never be swept, so it can never be closed (COST-MODEL §4.2). `fly.toml` opens
//   with this as rule 1 and says "there is no configuration of this app in which a second machine is
//   an improvement". A second PROCESS is the same thing wearing different clothes.
//
// The keeper has no "just fund the bank" flag, so the safe way to do the job is a tool that cannot do
// anything else. This imports the two functions that touch the bank and calls nothing that opens,
// delegates, ticks, closes or settles a round. It is safe to run while the Fly keeper is live.
//
// It is deliberately NOT wired into the keeper's own boot path: growing a pool is a decision someone
// makes, and it costs real SOL and changes the published disclosure list.

import { loadOrCreateHouseBank, fundHouseBank } from "./houseBank.ts";
import { createChainClient } from "./chainClient.ts";
import { HOUSE_WALLET_COUNT, HOUSE_WALLET_TARGET_SOL } from "./config.ts";
import { Keypair } from "@solana/web3.js";
import fs from "node:fs";

const dryRun = process.argv.includes("--dry-run");

/** The operator key, read the same way the keeper reads it. Kept local rather than imported because
 *  `keeper.ts`'s `loadOperator` is not exported and importing that module would pull in the round
 *  loop this tool exists to avoid. */
function loadOperator(): Keypair {
  const inline = process.env.KEEPER_OPERATOR_KEY;
  const raw = inline ?? fs.readFileSync(new URL("../../../.devnet/fork-payer.json", import.meta.url), "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

const operator = loadOperator();
console.log(`operator            ${operator.publicKey.toBase58()}`);
console.log(`wallets wanted      ${HOUSE_WALLET_COUNT}`);
console.log(`target per wallet   ${HOUSE_WALLET_TARGET_SOL} SOL`);
if (dryRun) console.log("DRY RUN — no keys will be written and no SOL will move\n");

// Generates and PERSISTS any wallets that are missing, or reports what it would generate under
// --dry-run. This is the step that grows `.devnet/keeper-house-wallets.json`.
const bank = loadOrCreateHouseBank(dryRun);
console.log(`\npool now holds      ${bank.bankPubkeys.length} wallet(s)`);

const client = await createChainClient({ operator, dryRun, stopSignal: AbortSignal.timeout(120_000) });
const before = await client.balance(operator.publicKey);
console.log(`operator balance    ${(before / 1e9).toFixed(4)} SOL`);

const moved = await fundHouseBank(client, operator, bank, dryRun);

if (!dryRun) {
  const after = await client.balance(operator.publicKey);
  console.log(`\noperator balance    ${(after / 1e9).toFixed(4)} SOL  (spent ${((before - after) / 1e9).toFixed(4)})`);
  console.log(moved ? "funded." : "nothing needed funding.");
  console.log("\nNEXT: publish the new pool to the deployment, or the keeper will refuse to boot:");
  console.log(`  fly secrets set KEEPER_HOUSE_WALLETS="$(cat ../.devnet/keeper-house-wallets.json)" --app bulls-arena-keeper-devnet`);
  console.log(`  fly deploy --ha=false --app bulls-arena-keeper-devnet`);
}
process.exit(0);
