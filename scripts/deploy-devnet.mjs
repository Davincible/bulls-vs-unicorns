#!/usr/bin/env node
// Deploy the ER program to DEVNET. Refuses to do anything else.
//
// The guard here is not ceremony. A deploy script is exactly the kind of thing that gets run with a
// stale shell, a copied env, or a --url someone pasted from another terminal, and the failure mode
// is deploying a fork's program with a fork's authority onto the network that holds real money.
//
// So it re-derives the cluster from the RPC itself (getGenesisHash) rather than trusting the URL,
// the CLI config, or an env var. A URL can lie; a genesis hash cannot.
//
//   node scripts/deploy-devnet.mjs            # checks everything, does not deploy
//   node scripts/deploy-devnet.mjs --deploy   # deploys, after the same checks

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ARG = new Set(process.argv.slice(2));
const DO_DEPLOY = ARG.has("--deploy");

const DEVNET_RPC = "https://api.devnet.solana.com";
// Genesis hashes are per-cluster and immutable. This is the ground truth the URL cannot fake.
const GENESIS = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "MAINNET-BETA",
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG": "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

const SOL_BIN = process.env.SOLANA_BIN
  || `${process.env.USERPROFILE || process.env.HOME}/.local/share/solana/install/releases/4.1.2/solana-release/bin/solana`;

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" };
const say = (s) => console.log(s);
const die = (s) => { console.error(`${c.r}✗ ${s}${c.x}`); process.exit(1); };

function sol(args) {
  return execFileSync(SOL_BIN, args, { encoding: "utf8", timeout: 120_000 }).trim();
}

(async () => {
  say(`${c.d}ER fork deploy — ${DO_DEPLOY ? `${c.y}DEPLOY` : `${c.g}dry run`}${c.x}`);

  // 1. The RPC must be devnet by URL...
  const url = process.env.SOLANA_RPC || DEVNET_RPC;
  if (/mainnet/i.test(url)) die(`RPC url names mainnet: ${url}`);
  if (!/devnet|localhost|127\.0\.0\.1/i.test(url)) {
    die(`RPC url is not positively identifiable as devnet: ${url}\n` +
        `  This guard fails CLOSED — an unrecognised host is refused, not assumed safe.`);
  }

  // 2. ...and by GENESIS HASH, which is the check that actually matters. A proxy can be called
  //    anything; it cannot forge the cluster it fronts.
  let genesis;
  try { genesis = sol(["genesis-hash", "--url", url]); }
  catch (e) { die(`could not read genesis hash from ${url}: ${e.message}`); }
  const cluster = GENESIS[genesis];
  say(`  rpc         ${url}`);
  say(`  genesis     ${genesis} ${cluster ? `(${cluster})` : "(unknown cluster)"}`);
  if (cluster === "MAINNET-BETA") die("THIS IS MAINNET. Refusing outright.");
  if (cluster !== "devnet") {
    die(`genesis hash is not devnet's. Refusing.\n` +
        `  Expected EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG.`);
  }

  // 3. The payer must be the fork-local keypair, never a production one.
  const kp = resolve(process.env.FORK_KEYPAIR || ".devnet/fork-payer.json");
  if (!existsSync(kp)) die(`fork keypair missing: ${kp}\n  Generate one with solana-keygen; never reuse a production key.`);
  if (/\.config[\\/]solana[\\/]id\.json$/i.test(kp)) {
    die(`refusing to deploy with the DEFAULT CLI keypair (${kp}).\n` +
        `  This fork uses a dedicated devnet key so a deploy can never be signed by whatever the\n` +
        `  machine happened to have configured.`);
  }
  const payer = sol(["address", "--keypair", kp]);
  const balance = sol(["balance", payer, "--url", url]);
  say(`  payer       ${payer}`);
  say(`  balance     ${balance}`);

  const lamports = parseFloat(balance);
  if (!(lamports > 0)) {
    die(`payer has no SOL. Fund it on devnet first:\n` +
        `    solana airdrop 2 ${payer} --url ${url}\n` +
        `  The public faucet is frequently rate-limited; https://faucet.solana.com also works.`);
  }

  // 4. The artifact must exist. It will not, until ER-010 is resolved.
  const so = resolve("target/deploy/bulls_arena.so");
  if (!existsSync(so)) {
    die(`program binary not built: ${so}\n` +
        `  Build it with:  cargo-build-sbf --manifest-path programs/bulls-arena/Cargo.toml\n` +
        `  On this machine that is BLOCKED — see MEGA_QUEUE.md ER-010 (no Windows SDK, no admin).`);
  }

  if (!DO_DEPLOY) {
    say(`${c.g}✓ all checks pass.${c.x} Nothing deployed. Re-run with --deploy to proceed.`);
    return;
  }

  say(`${c.y}deploying…${c.x}`);
  const out = sol(["program", "deploy", so, "--keypair", kp, "--url", url]);
  say(out);
})();
