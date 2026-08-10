// THE HOUSE WALLETS — the keys, their funding, and the two-stage entry that makes "seed early
// liquidity, throttle down as real players join" (README.md, ARENAS.md) an actual behaviour rather
// than a sentence.
//
// HOW MUCH the house fields is not decided here. That is `./houseSizing.ts`, which is a pure function
// of the real fighter counts and has its own tests. This file decides WHEN the house enters, WHICH
// wallet enters which side, and what happens when an entry fails — the operational half.
//
// THE TWO STAGES, AND WHY THEY ARE TWO — with one rule sitting above both of them:
//
//   THE TREASURY RULE FIRST. A lobby holding no real fighter gets exactly ONE house fighter, at every
//   stage and under every configuration, because one is below `enough_to_fight` and a round the chain
//   refuses to draw is a round that cannot become a house-versus-house fight. See
//   `HOUSE_MAX_WITHOUT_REAL_PLAYER`. Everything below describes a room somebody real is standing in.
//
//   SEED, immediately after the first real player arrives. Exactly `MIN_FIGHTERS_TO_FIGHT` fighters,
//   one per side. Two is not a sizing preference — it is `enough_to_fight` in lib.rs, the threshold
//   `close_lobby_and_draw` requires and `abandon_round` requires the negation of. So the seed stage is
//   the floor that guarantees the round can fight AT ALL, and it is also what stops a player who
//   arrives ten seconds in from finding an empty room.
//
//   FILL, `HOUSE_FILL_LEAD_SECONDS` before the deadline. Re-read the round, recount the REAL fighters,
//   and top up to whatever the sizing policy now says. THE LATENESS IS THE MECHANISM: a house that had
//   already committed its full roster at the opening bell would have nothing left to give up, and a
//   real arrival would ADD to a full lobby rather than displace a bot from it. Entering late is the
//   only thing that makes displacement real.
//
// NO SESSION KEYS HERE, AND THAT IS A DELIBERATE DECLINE. The brief offered them; they buy nothing.
// A session key exists to spare a HUMAN the wallet dialog per transaction — that is the entire
// problem it solves (see `enter`'s own comment in src/chain/round.ts, and `extract`'s, where it
// matters most because a human is under time pressure). There is no human here. The keeper holds
// these secret keys on disk and signs with them directly, so a session would add a `create_session`
// transaction, a token PDA, an expiry to renew and a second failure mode, in exchange for removing a
// dialog nobody was ever going to see. Every house `enter` therefore passes
// `signer: player, sessionToken: null` — the pre-Phase-6 direct-signing path, which
// `verify-session-real.mjs` step 6 proves is unchanged.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Keypair, LAMPORTS_PER_SOL, type PublicKey, SystemProgram, Transaction,
} from "@solana/web3.js";

import type { BullsArenaProgram, RawRoundAccount } from "../../src/chain/program.ts";
import { enter } from "../../src/chain/round.ts";
import type { ChainClient } from "./chainClient.ts";
import {
  CLOCK_SKEW_MARGIN_SECONDS, HOUSE_FILL_LEAD_SECONDS, HOUSE_WALLET_COUNT, HOUSE_WALLET_MIN_SOL,
  HOUSE_WALLET_TARGET_SOL, MIN_FIGHTERS_TO_FIGHT, REAL_SEATS_RESERVED,
} from "./config.ts";
import { c, describeError, info, ok, warn } from "./log.ts";
import { asSecretKeyBytes, parseSecretJson, readSecretText, type SecretSource } from "./secrets.ts";
import {
  allocateHouseSides, houseFighterCount, HOUSE_FLOOR, HOUSE_MAX_WITHOUT_REAL_PLAYER, houseStake,
  type SideCounts,
} from "./houseSizing.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** PERSISTED, and that is the point rather than a convenience. The status file publishes these
 *  pubkeys as the house's disclosure list, and a list that changed on every boot would be worthless —
 *  a player checking whether the wallet they just fought was a bot would be checking against keys that
 *  did not exist when the round ran. `.devnet/` is already gitignored, alongside the fork payer these
 *  are funded from. */
export const HOUSE_WALLETS_PATH = join(here, "..", "..", "..", ".devnet", "keeper-house-wallets.json");

/** The same file's CONTENTS, as an environment variable, for a deployment that has no `.devnet/` and
 *  must not have one — see `secrets.ts` for the precedence rule and why env wins.
 *
 *  IT TAKES THE WHOLE FILE, not a bare array of keys, and that is chosen so the migration is one
 *  command with nothing to reformat:
 *
 *      fly secrets set KEEPER_HOUSE_WALLETS="$(cat .devnet/keeper-house-wallets.json)"
 *
 *  A second accepted shape would be a second contract to keep working, for the sake of saving an
 *  operator from a `cat`. One shape, one parser — `readWalletFile` below reads both sources through
 *  the same validation, so a malformed secret fails exactly as a malformed file does. */
export const HOUSE_WALLETS_ENV = "KEEPER_HOUSE_WALLETS";

/** The prose published in the status file. Deliberately plain: it is read by a player, not an
 *  operator, and its job is to say what these wallets are without requiring the reader to know what a
 *  keeper is.
 *
 *  THE PUBLISHED LIST IS AN INTERIM MECHANISM AND SAYS SO. It is a claim made by the same process
 *  that runs the bots, in a file that process writes itself — believable, not verifiable. The better
 *  design is registering the house wallets on the Arena account on-chain, where the disclosure is as
 *  public and as tamper-evident as the round it describes and a client can check it without trusting
 *  the keeper at all. That is planned separately (see `isHouseWallet`'s doc comment in
 *  src/v2/data/keeperStatus.ts, which carries the same note at the reading end); until it lands, this
 *  is disclosure on the keeper's word. */
export const HOUSE_DISCLOSURE =
  "These wallets are operated by the arena keeper, an automated process that opens each round and " +
  "fields house fighters so the arena is never an empty room. They are not other players. The keeper " +
  "holds their keys and enters on the house's behalf, and it fields fewer of them as real players " +
  "join. Any fighter whose wallet appears in this list is one of the house's.";

export interface HouseWallet {
  /** Position in the bank, stable across restarts because the file is. `houseStake` takes it, so a
   *  given wallet's stake for a given round number is reproducible. */
  index: number;
  keypair: Keypair;
}

export interface FighterSplit {
  houseCount: number;
  realCount: number;
  /** Real fighters per side — the input the sizing policy is a function of. */
  real: SideCounts;
  house: SideCounts;
  /** Base58 of the house wallets that already hold a fighter in this round. */
  houseIn: Set<string>;
}

export interface HouseEntry {
  wallet: HouseWallet;
  side: 0 | 1;
  stake: bigint;
}

/** THE LOBBY AS THE KEEPER'S POLICY SEES IT, which is not quite as the round account describes it.
 *
 *  It comes from `planLobby` (lobbyPolicy.ts) and is passed in rather than re-derived here, so there
 *  is exactly one place that decides when a lobby ends. Deriving it a second time in this file is how
 *  the house would end up sizing itself against a close time the keeper is not going to honour.
 *
 *  IT USED TO CARRY `heldOpen` TOO, and the field is gone rather than merely unused. Hold-open was
 *  the switch that decided whether the house was allowed to put a second fighter into an empty room;
 *  that decision now lives in `houseFighterCount`, which gives the same answer whether or not
 *  `KEEPER_HOLD_OPEN` is set — see `HOUSE_MAX_WITHOUT_REAL_PLAYER`. A flag that no longer changes any
 *  outcome is a flag the next reader will assume still does. */
export interface HouseLobbyView {
  /** The instant the lobby will actually be drawn — the keeper's own close when it has committed to
   *  one, otherwise the chain's deadline. The fill stage is scheduled backwards from this. */
  drawAt: number;
}

export interface HousePlan {
  entries: HouseEntry[];
  /** The split the plan was computed from, handed back so the caller does not classify the same
   *  account a second time to log what it just decided. */
  split: FighterSplit;
}

export interface HouseEntryResult {
  landed: number;
  failed: number;
  /** Planned, then abandoned because the lobby will be drawn before the entry could land. Separate
   *  from `failed` because nothing was sent and nothing was spent — but it is still a board that came
   *  up short, so the caller must surface it. See `enterHouseFighters`. */
  dropped: number;
}

export interface HouseBank {
  /** The wallets that may enter a round: the first `HOUSE_WALLET_COUNT` in the file. */
  active: HouseWallet[];
  /** EVERY wallet the file holds, base58. Wider than `active` on purpose — if `HOUSE_WALLET_COUNT` is ever
   *  reduced, a key that fought yesterday is still a house key, and both the disclosure list and the
   *  house/real classifier must keep saying so. */
  disclosedPubkeys: string[];
  isHouse(pubkey: PublicKey): boolean;
  classify(round: RawRoundAccount): FighterSplit;
}

interface HouseWalletFile {
  note: string;
  secretKeys: number[][];
}

const FILE_NOTE =
  "Keeper house-fighter wallets. Generated and topped up by er-demo/scripts/keeper. Devnet only. " +
  "Persisted so the pubkeys disclosed in public/keeper-status.json are stable across restarts.";

/** The keys the process booted with, and where they came from. */
interface StoredWallets {
  secretKeys: number[][];
  source: SecretSource;
  where: string;
}

function readWalletFile(): StoredWallets | null {
  const secret = readSecretText(HOUSE_WALLETS_ENV, HOUSE_WALLETS_PATH);
  if (secret === null) return null; // neither source — the first boot creates one
  const parsed = parseSecretJson(secret, `the contents of ${HOUSE_WALLETS_PATH}`) as Partial<HouseWalletFile>;
  const keys = parsed?.secretKeys;
  if (!Array.isArray(keys)) {
    // Refusing loudly rather than regenerating: silently replacing a damaged file would rotate every
    // disclosed pubkey and strand whatever devnet SOL the old ones held. Same refusal for a malformed
    // secret, and for the stronger version of the same reason — a deployment that quietly generated a
    // fresh set of house wallets would publish a disclosure list nobody can check against the rounds
    // those wallets fought, and would strand the funded ones.
    throw new Error(
      `${secret.where} is not a keeper wallet file (expected {"secretKeys": [[...]]}). ` +
      (secret.source === "env"
        ? `Set it to the verbatim contents of a wallet file: fly secrets set ${HOUSE_WALLETS_ENV}="$(cat ${HOUSE_WALLETS_PATH})".`
        : `Move it aside if you genuinely want a fresh set of house wallets.`),
    );
  }
  // EACH KEY THROUGH THE SAME VALIDATOR THE OPERATOR KEY GETS. The looser check this replaced
  // accepted an array of any length holding any numbers, so a 32-byte seed or a base58 string in the
  // secret surfaced much later as tweetnacl's `bad secret key size` — a message that names neither
  // the source nor the expected shape, which is precisely the failure `secrets.ts` exists to
  // explain. `asSecretKeyBytes` reports the length and the origin and never the content.
  keys.forEach((key, i) => {
    asSecretKeyBytes(key, { ...secret, where: `${secret.where} (key ${i})` });
  });
  return { secretKeys: keys as number[][], source: secret.source, where: secret.where };
}

function writeWalletFile(secretKeys: number[][]): void {
  const body: HouseWalletFile = { note: FILE_NOTE, secretKeys };
  // 0600 — these are secret keys, and the directory being gitignored protects the repository, not the
  // filesystem. Matches the mode the program keypairs in `.devnet/` already carry.
  writeFileSync(HOUSE_WALLETS_PATH, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

/** Loads the bank, creating or extending it to `HOUSE_WALLET_COUNT` wallets.
 *
 *  EXTENDS, never regenerates. Existing keys keep their index and their pubkey; only the shortfall is
 *  generated. A file holding MORE than `HOUSE_WALLET_COUNT` keeps all of them — the extras stop entering
 *  rounds but remain disclosed and remain classified as house, because they are.
 *
 *  KEYS THAT ARRIVED FROM THE ENVIRONMENT ARE NEVER WRITTEN BACK. Three reasons, and the first alone
 *  settles it: a container filesystem is not a place to put secret keys — it is ephemeral, so the
 *  write buys nothing, and it is a layer diff, so it may not be as ephemeral as it looks. Second, the
 *  path it would write to is `.devnet/`, which on a deployment does not exist and would have to be
 *  created; a keeper that creates a directory to store keys it was handed is doing something nobody
 *  asked for. Third, the secret is the source of truth in that deployment, and a file beside it is a
 *  second copy that can disagree with it after the next `fly secrets set`. */
export function loadOrCreateHouseBank(dryRun: boolean): HouseBank {
  const stored = readWalletFile();
  const secretKeys = stored ? [...stored.secretKeys] : [];
  if (stored) {
    // WHERE, not what. The pubkeys are printed by the boot banner from the bank itself; the secret
    // material never reaches a log line. See secrets.ts.
    info(`house wallets: ${secretKeys.length} loaded from ${stored.where} (${stored.source})`);
  }
  const created = Math.max(0, HOUSE_WALLET_COUNT - secretKeys.length);
  for (let i = 0; i < created; i++) {
    secretKeys.push(Array.from(Keypair.generate().secretKey));
  }
  if (created > 0 || !stored) {
    if (dryRun) {
      // A rehearsal that promises to send nothing should not leave keys on disk either. The generated
      // ones are used for this pass and thrown away, so the dry run still exercises the classifier and
      // the disclosure list — it just does not commit an identity the operator did not ask for.
      warn(`DRY RUN — ${created} house wallet(s) generated in memory and NOT written to ${HOUSE_WALLETS_PATH}`);
    } else if (stored?.source === "env") {
      // REFUSED, not warned about, and the money is why. Warning and carrying on was the first
      // version; it understated the cost by a lot. Generated wallets go into `bank.active`, so
      // `fundHouseBank` tops each of them up to HOUSE_WALLET_TARGET_SOL at boot and between rounds —
      // and they do not survive the restart, because a key from the environment is never written
      // back (see this function's doc comment). So every restart permanently strands
      // `HOUSE_WALLET_TARGET_SOL x created` SOL in wallets nothing will ever hold the keys to again,
      // silently, forever.
      //
      // The disclosure list is the other half: these pubkeys are published as this arena's bot
      // disclosure, and an unpersisted key is a different pubkey after every restart. A player
      // checking whether the wallet they just fought was a bot would be checking against a list that
      // did not exist when the round ran.
      //
      // Refusing matches what this module already does with a damaged wallet file a few lines up —
      // "refusing loudly rather than regenerating" — and for the same reason. The trigger is real and
      // foreseeable: the day HOUSE_WALLET_COUNT is raised without re-issuing the secret.
      throw new Error(
        `${HOUSE_WALLETS_ENV} holds ${secretKeys.length - created} wallet(s) but ${HOUSE_WALLET_COUNT} are wanted.\n` +
        `Generating the other ${created} would strand money: they cannot be persisted (a key from the ` +
        `environment is never written to disk), they WOULD be funded to ${HOUSE_WALLET_TARGET_SOL} SOL each ` +
        `at boot, and they are gone on the next restart — ${(HOUSE_WALLET_TARGET_SOL * created).toFixed(3)} SOL ` +
        `lost per restart — while the published bot-disclosure list changes underneath the rounds it ` +
        `describes.\n` +
        `Re-issue the secret with all ${HOUSE_WALLET_COUNT} keys: run the keeper once on a machine that can write ` +
        `${HOUSE_WALLETS_PATH}, then fly secrets set ${HOUSE_WALLETS_ENV}="$(cat ${HOUSE_WALLETS_PATH})".`,
      );
    } else {
      try {
        writeWalletFile(secretKeys);
      } catch (e) {
        // THE PRODUCTION TRAP THIS CATCHES, and it is worth the six lines. A container started with
        // no `KEEPER_HOUSE_WALLETS` reaches here, generates a full bank of wallets, and tries to persist them to
        // `.devnet/` — a directory that does not exist in the image, above a root the process cannot
        // write to as a non-root user. The raw failure is `EACCES, open '/.devnet/…'`, which is a
        // true statement about a filesystem and tells the operator nothing about the secret they
        // forgot to set. Named here, at the one moment the diagnosis is obvious.
        throw new Error(
          `could not persist the house wallets to ${HOUSE_WALLETS_PATH} ` +
          `(${e instanceof Error ? e.message : String(e)}).\n` +
          `If this is a deployment, that path is not where the keys belong: set ${HOUSE_WALLETS_ENV} to ` +
          `the contents of a wallet file instead, and nothing needs to be written at all. Generate one ` +
          `locally first (run the keeper once on a machine that can write .devnet/), then ` +
          `fly secrets set ${HOUSE_WALLETS_ENV}="$(cat ${HOUSE_WALLETS_PATH})" — the pubkeys are ` +
          `published as this arena's bot disclosure, so they must be the same on every restart.`,
        );
      }
      info(stored
        ? `house bank extended by ${created} wallet${created === 1 ? "" : "s"} -> ${HOUSE_WALLETS_PATH}`
        : `house bank created with ${secretKeys.length} wallets -> ${HOUSE_WALLETS_PATH}`);
    }
  }
  return houseBankFrom(secretKeys.map((k) => Keypair.fromSecretKey(Uint8Array.from(k))));
}

/** The bank's LOGIC, separated from where its keys came from.
 *
 *  Split out so the classifier — which decides what the status file publishes as house versus real,
 *  and therefore what the sizing policy is fed — can be exercised without a filesystem and without
 *  generating keys into `.devnet/`. `loadOrCreateHouseBank` is the only thing that touches disk. */
export function houseBankFrom(keypairs: Keypair[]): HouseBank {
  const active = keypairs.slice(0, HOUSE_WALLET_COUNT).map((keypair, index) => ({ index, keypair }));
  const disclosedPubkeys = keypairs.map((k) => k.publicKey.toBase58());
  const disclosedSet = new Set(disclosedPubkeys);

  return {
    active,
    disclosedPubkeys,
    isHouse: (pubkey) => disclosedSet.has(pubkey.toBase58()),
    classify(round) {
      const real: SideCounts = { side0: 0, side1: 0 };
      const house: SideCounts = { side0: 0, side1: 0 };
      const houseIn = new Set<string>();
      // `fighter_count` is the number of SEATS TAKEN; the array behind it is fixed at MAX_FIGHTERS and
      // the entries past the count are zeroed defaults, not fighters.
      for (const fighter of round.fighters.slice(0, round.fighterCount)) {
        const key = fighter.wallet.toBase58();
        const bucket = disclosedSet.has(key) ? house : real;
        if (fighter.side === 0) bucket.side0 += 1; else bucket.side1 += 1;
        if (disclosedSet.has(key)) houseIn.add(key);
      }
      return {
        houseCount: house.side0 + house.side1,
        realCount: real.side0 + real.side1,
        real,
        house,
        houseIn,
      };
    },
  };
}

/** Fee for a one-signature base-layer transaction, in lamports. The funding transfer has exactly one
 *  signer, and this is the amount the balance check would otherwise be blind to — a payer sitting at
 *  exactly the transfer total passes the check and then fails the transaction, which is the one case
 *  the check exists to catch. */
const SIGNATURE_FEE_LAMPORTS = 5_000;

/** Top every wallet below `HOUSE_WALLET_MIN_SOL` up to `HOUSE_WALLET_TARGET_SOL`, from the fork payer.
 *
 *  ONE TRANSACTION for all of them: a bank's worth of transfers is well inside a single transaction —
 *  a legacy transaction holds roughly twenty and `KEEPER_HOUSE_WALLET_COUNT` is capped at sixteen in
 *  `config.ts` for exactly this reason, so the chunking this does not do can never be needed. Doing it in
 *  one means the keeper either starts with a funded bank or fails with one error, rather than
 *  half-funding it and discovering the rest mid-round. Plain base-layer transfers, sent the way
 *  `scripts/fund-wallet.mjs` sends them — no router involved, because no delegated account is.
 *
 *  CALLED PERIODICALLY, NOT ONLY AT BOOT, and that is a correction rather than a nicety. `config.ts`
 *  prices these wallets at "on the order of two thousand rounds" — and this process is designed to run
 *  for days, so it WILL cross that line while running. A boot-only top-up meant that at hour thirty
 *  every house `enter` began failing on lamports, silently: the failures are swallowed so the round
 *  can continue, nothing throws, `lastError` stays null, and the UI shows a healthy keeper presiding
 *  over an empty arena whose every lobby dies under-subscribed. Re-checking between rounds costs six
 *  balance reads a couple of minutes and removes that entirely.
 *
 *  Returns true when it moved money, so a caller can say so rather than logging on every round. */
export async function fundHouseBank(
  client: ChainClient,
  forkPayer: Keypair,
  bank: HouseBank,
  dryRun: boolean,
  quiet = false,
): Promise<boolean> {
  const minLamports = Math.round(HOUSE_WALLET_MIN_SOL * LAMPORTS_PER_SOL);
  const targetLamports = Math.round(HOUSE_WALLET_TARGET_SOL * LAMPORTS_PER_SOL);

  const balances = await Promise.all(bank.active.map((w) => client.balance(w.keypair.publicKey)));
  const shortfalls = bank.active
    .map((wallet, i) => ({ wallet, lamports: targetLamports - balances[i]! }))
    .filter((_, i) => balances[i]! < minLamports);
  if (shortfalls.length === 0) {
    if (!quiet) ok(`house wallets all above ${HOUSE_WALLET_MIN_SOL} SOL — no top-up needed`);
    return false;
  }

  const total = shortfalls.reduce((sum, s) => sum + s.lamports, 0);
  const payerBalance = await client.balance(forkPayer.publicKey);
  // The payer must keep its own rent-exempt floor as well as cover the transfers and the fee, or the
  // System Program refuses the debit — asked of the chain rather than restated as a constant.
  const payerFloor = await client.base.getMinimumBalanceForRentExemption(0);
  const needed = total + SIGNATURE_FEE_LAMPORTS + payerFloor;
  if (payerBalance < needed) {
    throw new Error(
      `fork payer holds ${(payerBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL but topping up ` +
      `${shortfalls.length} house wallet(s) needs ${(needed / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
      `(${(total / LAMPORTS_PER_SOL).toFixed(4)} transferred, plus the fee and the payer's own ` +
      `rent-exempt minimum). Fund ${forkPayer.publicKey.toBase58()}.`,
    );
  }
  if (dryRun) {
    info(`${c.y}DRY RUN${c.x} — would top up ${shortfalls.length} house wallet(s) with ${(total / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    return false;
  }

  const tx = new Transaction().add(
    ...shortfalls.map((s) => SystemProgram.transfer({
      fromPubkey: forkPayer.publicKey,
      toPubkey: s.wallet.keypair.publicKey,
      lamports: s.lamports,
    })),
  );
  // Confirmed against a BLOCKHASH, not the deprecated signature-and-commitment overload. That one has
  // no `lastValidBlockHeight`, so a dropped transaction is only noticed by an internal 60-second
  // timeout and then reported as `TransactionExpiredTimeoutError` — a minute of unexplained silence
  // during boot, with an error that says nothing about house funding. This is the same shape
  // `src/chain/sendTx.ts` uses for every other transaction in this project.
  const { blockhash, lastValidBlockHeight } = await client.base.getLatestBlockhash("confirmed");
  tx.feePayer = forkPayer.publicKey;
  tx.recentBlockhash = blockhash;
  const signature = await client.base.sendTransaction(tx, [forkPayer]);
  await client.base.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  ok(`topped up ${shortfalls.length} house wallet(s) with ${(total / LAMPORTS_PER_SOL).toFixed(4)} SOL  ${c.d}${signature}${c.x}`);
  return true;
}

/** WHAT THE HOUSE SHOULD ENTER RIGHT NOW — a pure function of the round as the chain reports it plus
 *  the clock, holding no memory of what a previous pass decided.
 *
 *  That purity is what makes a failed entry self-healing. There is no "have we seeded yet" flag to get
 *  out of step with reality: the next pass recounts the house fighters actually on the round and asks
 *  for the shortfall again, so an `enter` that failed on an RPC blip is retried a second later, for
 *  free, until the deadline. It is also what makes the whole thing restart-proof — a keeper that
 *  booted into the middle of a lobby fields exactly what a keeper that had been running all along
 *  would.
 *
 *  Returns [] when the house should do nothing, which is the common case: most passes of a lobby fall
 *  between the two stages, or the house is already at target. */
export function plannedHouseEntries(
  bank: HouseBank,
  round: RawRoundAccount,
  roundNo: bigint,
  nowSec: number,
  lobby: HouseLobbyView,
): HousePlan {
  const split = bank.classify(round);

  // TOO LATE TO ENTER. `enter` refuses at or past `lobby_closes_at` against the ER's clock, so an
  // entry planned inside the skew margin is a transaction that will be rejected with `LobbyClosed`
  // for a fee. Measured against `drawAt` rather than the deadline, because an entry sent into the
  // second before the KEEPER closes the lobby is just as wasted as one sent after the chain does.
  // The fill stage makes this reachable rather than theoretical: it starts twelve seconds out and has
  // up to eight confirmed round-trips to make, which at devnet's slower moments is most of that window
  // even sent concurrently.
  if (lobby.drawAt - nowSec <= CLOCK_SKEW_MARGIN_SECONDS) return { entries: [], split };

  const fillDue = nowSec >= lobby.drawAt - HOUSE_FILL_LEAD_SECONDS;

  let target: number;
  if (split.realCount === 0) {
    // NOBODY REAL IS HERE, AT ANY STAGE. One fighter — not a sizing preference, an invariant: at one
    // the chain refuses to draw the round at all, so no house-versus-house fight is available to
    // anyone, and `abandon_round` stays legal at the deadline so the round can still end. The full
    // argument is on `HOUSE_MAX_WITHOUT_REAL_PLAYER`.
    //
    // CHECKED FIRST, AND NO LONGER GATED ON HOLD-OPEN. It used to be the `lobby.heldOpen` branch, so
    // with `KEEPER_HOLD_OPEN` off the seed stage below put two fighters into an empty room and the
    // round fought itself at its deadline. Asking about the room rather than about a mode makes the
    // guarantee hold in every configuration — and it makes the branch redundant with
    // `houseFighterCount({0,0})` below, which returns the same 1, which is the point: the treasury
    // rule has one answer and both stages give it.
    target = HOUSE_MAX_WITHOUT_REAL_PLAYER;
  } else if (fillDue) {
    target = houseFighterCount(split.real);
  } else if (split.realCount < MIN_FIGHTERS_TO_FIGHT) {
    // SEED STAGE. `HOUSE_FLOOR` comes from the sizing policy, which owns how many fighters the house
    // fields; `MIN_FIGHTERS_TO_FIGHT` is the chain's `enough_to_fight`, which owns whether a round can
    // fight at all. They are both 2 and they are not the same number — the condition asks "does this
    // round still need the house in order to be a round?", the target answers "then field the policy's
    // floor". Skipped once two real fighters are in, exactly as specified: the round can already
    // fight, so there is nothing for the floor to guarantee and the house should wait for the fill
    // stage to size itself against who actually turned up.
    target = HOUSE_FLOOR;
  } else {
    target = 0;
  }

  // Never ask the program for a seat that does not exist. `enter` refuses with `RoundFull` at
  // MAX_FIGHTERS, and the seat count is read off the account's own fixed-size fighter array rather
  // than restated here — the chain's number, not a copy of it.
  const seats = round.fighters.length;
  const seatCeiling = seats - split.realCount;
  // AND NEVER TAKE THE LAST FEW, so a real player who has not arrived yet still finds a seat. With the
  // default board of ten against sixteen seats this cannot bind; it is here for the day somebody sets
  // `KEEPER_HOUSE_BOARD_TARGET` high, because the failure it prevents — a visitor meeting `RoundFull`
  // because the arena's own bots filled the room — is worse than the empty board that motivated
  // raising it. Applied here rather than validated in `config.ts` because this is the only place that
  // knows the chain's real seat count instead of a copy of it.
  //
  // IT YIELDS ONLY TO `coverFloor`, AND ONLY BY ONE FIGHTER. An earlier version floored this at
  // `MIN_FIGHTERS_TO_FIGHT`, which was too generous by exactly one: the floor is only ever live when
  // `seatCeiling - REAL_SEATS_RESERVED < 2`, i.e. at eleven or more real fighters — and a round with
  // eleven real fighters in it already satisfies `enough_to_fight` on its own, so the MOST the house
  // can be needed for there is the single `cover` fighter that makes a one-sided lobby drawable, never
  // two. Under `KEEPER_HOUSE_BOARD_TARGET=16` with 13 real fighters already split across both sides,
  // that floor let the house take two of the last three seats for no fightability reason at all. The
  // yield now lives where it belongs, in `coverFloor` below, which grants exactly one.
  //
  // ONE CEILING, APPLIED TWICE. It bounds the target here, and it bounds the per-side top-up further
  // down — because that top-up is allowed to grow the house past its target and would otherwise be a
  // way around this line.
  const houseCeiling = Math.max(0, seatCeiling - REAL_SEATS_RESERVED);
  target = Math.min(target, houseCeiling);

  // The sizing policy is the authority on the DISTRIBUTION, so ask it for the whole target and
  // subtract what is already standing, rather than asking it for "n more" — which would be a second,
  // subtly different allocation problem that only this file would know about.
  const wanted = allocateHouseSides(target, split.real);
  let need0 = wanted.filter((s) => s === 0).length - split.house.side0;
  let need1 = wanted.filter((s) => s === 1).length - split.house.side1;

  // PER SIDE, NOT ON THE TOTAL, and the difference is a round that cannot be drawn.
  //
  // This used to be `target - split.houseCount`, which is the same number whenever both deficits are
  // non-negative — and silently the wrong one when they are not. A house already AT its target but
  // standing entirely on one side has a total shortfall of zero, so the planner returned nothing,
  // `cover` never got honoured, and the lobby reached its deadline with an empty side: undrawable,
  // abandoned, one round's rent gone, and the people who turned up got no fight.
  //
  // Found by sweeping all 5,826 lobby shapes a sixteen-seat round can hold rather than by reasoning,
  // and it is worth being honest about how reachable it is: `allocateHouseSides` always joins the
  // SMALLER side, so this keeper does not produce that skew on its own — it needs a round seeded
  // under a different configuration, or a partial send whose surviving half all landed one way. Cheap
  // to survive, expensive to meet, and the fix is strictly a no-op in every shape that was already
  // correct: with both deficits non-negative the two expressions are equal.
  //
  // AND IT DOES NOT APPLY WHEN NOBODY REAL IS HERE, which is the treasury rule outranking drawability
  // exactly as it does everywhere else in this function. A room with no real player in it is a room
  // that MUST NOT be drawable, so an empty side is the desired state and `cover` has nothing to say
  // about it. Without this branch the per-side rule would look at the lone house fighter, see a bare
  // side, and post a second one — handing a permissionless caller the house-versus-house fight this
  // whole policy exists to make impossible. It is the first thing the boundary sweep caught after the
  // per-side change, and it is the reason that change is a branch rather than a one-line swap.
  const grow = split.realCount === 0
    ? target - split.houseCount
    : Math.max(0, need0) + Math.max(0, need1);

  // THE THREE BOUNDS ON HOW MANY FIGHTERS TO ADD, and they are written as a floor and two ceilings
  // because that is the order they actually outrank each other in.
  //
  //   coverFloor   ONE fighter onto an empty side, and it outranks both ceilings below. A lobby with
  //                an empty side cannot be drawn AT ALL, so the choice there is not "a fuller board
  //                versus a leaner one", it is "a round versus a round that gets abandoned with its
  //                rent gone and the people who turned up sent away". It is zero when nobody real is
  //                here, which is the treasury rule again: that room is MEANT to be undrawable.
  //   ceilingRoom  the policy's target plus the seat reservation, i.e. the ordinary answer.
  //   freeSeats    the chain's own arithmetic. Nothing outranks this; `enter` answers `RoundFull`.
  const occupied0 = split.real.side0 + split.house.side0;
  const occupied1 = split.real.side1 + split.house.side1;
  const coverFloor = split.realCount > 0 && (occupied0 === 0 || occupied1 === 0) ? 1 : 0;
  // THE FLOOR HAS TO NAME A SIDE, not just a count. Raising the shortfall alone was not enough and
  // failed in the one case it was written for: with fifteen real fighters stacked on side 0 the
  // reservation clamps `target` to zero, so `wanted` is empty, so BOTH deficits are zero — and the
  // placement loop below skips every side whose deficit is not positive, quietly planning nothing
  // while the shortfall said one. The count and the destination are the same decision.
  if (coverFloor > 0) {
    if (occupied0 === 0) need0 = Math.max(need0, 1); else need1 = Math.max(need1, 1);
  }
  const ceilingRoom = Math.max(0, houseCeiling - split.houseCount);
  const freeSeats = Math.max(0, seats - split.realCount - split.houseCount);
  const shortfall = Math.min(Math.max(Math.min(grow, ceilingRoom), coverFloor), freeSeats);
  if (shortfall <= 0) return { entries: [], split };

  const free = bank.active.filter((w) => !split.houseIn.has(w.keypair.publicKey.toBase58()));
  const entries: HouseEntry[] = [];
  for (const wallet of free) {
    if (entries.length >= shortfall) break;
    // Fill the bigger deficit first, so a shortfall that cannot be met in full still lands on the side
    // that is furthest from where the policy wants it.
    const side: 0 | 1 = need0 >= need1 ? 0 : 1;
    if (side === 0) { if (need0 <= 0) continue; need0 -= 1; } else { if (need1 <= 0) continue; need1 -= 1; }
    entries.push({ wallet, side, stake: houseStake(Number(roundNo), wallet.index) });
  }
  return { entries, split };
}

/** Send the planned entries, ALL AT ONCE, and never let one failure end the process.
 *
 *  A failed `enter` is logged and skipped rather than thrown: it costs the round one house fighter,
 *  and the next pass of the main loop recomputes the shortfall from the chain and tries again. What it
 *  must NOT do is take down a keeper that is otherwise running a round correctly.
 *
 *  ────────────────────────────────────────────────────────────────────────────────────────────────
 *  WHY THIS IS CONCURRENT, WHICH IT DID NOT USED TO BE
 *  ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *  It sent serially, and that was sound while the fill stage was at most FOUR entries: four confirmed
 *  round-trips fit inside `HOUSE_FILL_LEAD_SECONDS`, which is what that constant was measured against.
 *  The board target of ten makes the realistic batch SEVEN (a lobby holding the lone house fighter plus
 *  the seed pair, topping up to nine) and up to EIGHT for a player who arrives inside the fill lead and
 *  skips the seed stage entirely. At devnet's slower moments a confirmed round-trip is seconds, so a
 *  serial batch of eight simply does not fit in the window — and the window cannot be widened, because
 *  `HOUSE_FILL_LEAD_SECONDS` must stay under `MIN_LOBBY_SECONDS` and the grace after a real arrival is
 *  the same twenty seconds.
 *
 *  The entries are independent by construction — distinct wallets, distinct signers, distinct fee
 *  payers, no ordering constraint, and `plannedHouseEntries` has already guaranteed no wallet appears
 *  twice — so the serialisation was buying nothing. `ChainClient.send` holds no per-call state and
 *  `sendTx` fetches its own blockhash per transaction, so it is reentrant.
 *
 *  THE CLOCK IS CHECKED PER ENTRY, STILL. Every task re-reads it immediately before sending, so a
 *  delayed event loop cannot turn a planned entry into a `LobbyClosed` fee. Checked against `drawAt`,
 *  the instant the lobby will ACTUALLY be drawn: on a held-open round that is the keeper's own early
 *  close, seconds away, rather than a backstop a week out that nothing is waiting for.
 *
 *  ────────────────────────────────────────────────────────────────────────────────────────────────
 *  AND WHY `dropped` IS A RETURN VALUE RATHER THAN A LOG LINE
 *  ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *  An entry abandoned for lack of lobby time used to increment NOTHING. It warned, and the caller
 *  raises `lastError` on `failed`, so a fill that ran out of time was a single line in a log nobody is
 *  reading: the board quietly drew at six instead of ten, the status file showed a perfectly healthy
 *  keeper, and the arena looked exactly as empty as the complaint this policy exists to answer. It is
 *  the only house-entry outcome that was invisible, and a board that is short is precisely the thing
 *  the operator needs told.
 *
 *  Returns all three counts, because the caller has to distinguish "the round is short one bot this
 *  pass" from "these entries can never succeed" — an empty house wallet would otherwise be re-planned
 *  and re-sent on every pass for the whole lobby. */
export async function enterHouseFighters(
  client: ChainClient,
  program: BullsArenaProgram,
  round: { arenaPda: PublicKey; roundPda: PublicKey; drawAt: number },
  entries: HouseEntry[],
): Promise<HouseEntryResult> {
  let landed = 0;
  let failed = 0;
  let dropped = 0;
  const send = async (entry: HouseEntry): Promise<void> => {
    if (round.drawAt - client.nowSec() <= CLOCK_SKEW_MARGIN_SECONDS) {
      dropped += 1;
      return;
    }
    const player = entry.wallet.keypair.publicKey;
    try {
      const builder = enter(program, {
        arena: round.arenaPda,
        round: round.roundPda,
        player,
        // Direct signing, no session — see this file's header for why a session key here would be
        // pure ceremony.
        signer: player,
        sessionToken: null,
        side: entry.side,
        stake: entry.stake,
      });
      await client.send(builder, entry.wallet.keypair, `enter house[${entry.wallet.index}] side ${entry.side} stake ${entry.stake}`);
      landed += 1;
    } catch (e) {
      failed += 1;
      warn(`house[${entry.wallet.index}] enter (side ${entry.side}) failed: ${describeError(e)}`);
    }
  };

  // `allSettled` rather than `all`, though `send` already swallows its own failures: `all` would reject
  // on a throw from anywhere outside that try (a builder that cannot be constructed, say) and take the
  // keeper down mid-round, which is the one thing this function exists not to do.
  await Promise.allSettled(entries.map(send));
  if (dropped > 0) {
    warn(`out of lobby time — ${dropped} of ${entries.length} house entries were dropped rather than sent into a closed lobby`);
  }
  return { landed, failed, dropped };
}
