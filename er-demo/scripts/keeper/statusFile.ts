// PUBLISHING THE KEEPER'S STATUS — ONE SERIALIZER, TWO CHANNELS.
//
// The shape, and every rule about what may appear in it, live in `src/v2/data/keeperStatus.ts`, which
// this module imports and the front end imports too. One module, both ends: a writer and a reader
// each holding their own copy of a shape is a schema that drifts silently, and it always drifts the
// same way — the page keeps rendering a field the keeper stopped writing, because `undefined` formats
// as an empty string and nothing throws.
//
// THE SAME ARGUMENT NOW APPLIES ONE LAYER DOWN, because the status leaves this process by two routes:
//
//   * `public/keeper-status.json`, written atomically once a second. Vite dev, `vite preview` and a
//     production build all serve `public/` verbatim, so locally this needs no server at all.
//   * `GET /keeper-status.json` on the keeper's own HTTP port (`statusServer.ts`), which is the only
//     route that works in production: the front end is a static build on another host and a keeper
//     cannot write into a bundle that was finished before it started.
//
// BOTH EMIT THE SAME BYTES, from `serializeKeeperStatus`, rendered ONCE per publish and handed to
// both. Two serializers over one in-memory object would be the drift this whole contract module
// exists to prevent, re-entering by the back door — and it would be the hard kind to see, because
// both channels would keep working and only DISAGREE, which no exception and no schema check catches.
//
// Rendering once per publish rather than once per request is also what keeps the HTTP server from
// having any opinion about keeper state. `render()` below RECONCILES before it serializes — it decides
// `nextLobbyOpensAt` against the round, and advances the per-round latch that makes that countdown
// monotonic. If a request rendered its own body it would run that reconciliation too, so an HTTP GET
// would mutate the latch, and a page polling twice a second would be participating in the keeper's
// state machine. The body a request gets is therefore the last one published: at most one publish
// interval old, which is the same staleness the file has, reported by the same heartbeat.
//
// THE WRITE IS ATOMIC, AND THAT IS NOT BELT-AND-BRACES. A browser polls this file while this process
// rewrites it roughly once a second. `writeFileSync` truncates and then fills, so a fetch landing
// inside that window reads a prefix of a JSON document — and `JSON.parse` on half an object throws
// rather than returning something the reader's validator can reject cleanly. Writing to a temp file
// in the SAME DIRECTORY and then `rename()`ing over the target avoids the window entirely: rename
// within one filesystem is atomic, so every reader sees either the whole previous file or the whole
// new one, never a boundary. Same directory matters — a temp file in /tmp would be a cross-device
// rename, which is a copy, which is not atomic.
//
// `parseKeeperStatus` is strict in ways that are easy to violate by accident, and every violation has
// the same symptom: the file parses as `null` and the page says "keeper is down" while the keeper is
// running perfectly. The four that this module has to get right, and does:
//   * `phase` is written as `PHASE_NAME[phaseCode]` from that one source — the parser cross-checks
//     the two encodings against each other and rejects the file if they disagree;
//   * `pot` is `BN.toString()`, a plain decimal u64 string. Never via `Number`, which would silently
//     round a u64, and never a float;
//   * `round`, `nextLobbyOpensAt` and `stalledSince` are always PRESENT, as explicit `null` when they
//     are null. An absent key reads as malformed, and `JSON.stringify` drops `undefined` — so these
//     are assigned real nulls rather than left off;
//   * `chain.cluster` is exactly `"devnet"`.

import { readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PublicKey } from "@solana/web3.js";

import { PHASE_NAME, Phase } from "../../src/chain/constants.ts";
import type { RawRoundAccount } from "../../src/chain/program.ts";
import {
  KEEPER_STATUS_SCHEMA,
  type KeeperError,
  type KeeperRoundStatus,
  type KeeperStatus,
} from "../../src/v2/data/keeperStatus.ts";
import { HEARTBEAT_INTERVAL_SECONDS, STALE_AFTER_SECONDS } from "./config.ts";
import { error as logError, warn } from "./log.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** `public/` is copied verbatim to the served root by Vite dev, `vite preview` and a production build
 *  alike, so this one path is reachable at `/keeper-status.json` in all three without any server
 *  configuration. It is gitignored: the file is generated, and its ABSENCE is meaningful — a 404 is
 *  correctly read by the front end as "no keeper has ever run here". */
export const STATUS_FILE_PATH = join(here, "..", "..", "public", "keeper-status.json");

/**
 * THE ONE SERIALIZER. Every byte that leaves this process describing the keeper's status comes from
 * here — the file, and the HTTP body, identically. See this file's header for why that is a rule and
 * not a tidiness preference.
 *
 * Pretty-printed with a trailing newline, which is a deliberate choice rather than a leftover:
 * `curl`ing this endpoint during an incident is the fastest way anyone will ever read it, and two
 * kilobytes of minified JSON on one line is a diagnostic nobody can use. The cost is about 700 bytes
 * a second against a poll nobody is paying for by the byte.
 */
export function serializeKeeperStatus(status: KeeperStatus): string {
  return `${JSON.stringify(status, null, 2)}\n`;
}

/** Build the round half of the status from the account as the chain reports it.
 *
 *  Everything here is copied, not computed. The one derived field is `phase`, and it is derived from
 *  `phaseCode` through `PHASE_NAME` precisely so the two cannot disagree. */
export function roundStatusFrom(
  round: RawRoundAccount,
  roundPda: PublicKey,
  houseFighters: number,
  realFighters: number,
  heldOpen: boolean,
): KeeperRoundStatus {
  const phaseName = PHASE_NAME[round.phase];
  if (phaseName === undefined) {
    throw new Error(`round ${roundPda.toBase58()} reports phase ${round.phase}, which is not one of ${PHASE_NAME.join("/")}`);
  }
  return {
    no: Number(round.roundNo.toString()),
    pda: roundPda.toBase58(),
    phase: phaseName,
    phaseCode: round.phase,
    lobbyOpenedAt: Number(round.lobbyOpenedAt.toString()),
    lobbyClosesAt: Number(round.lobbyClosesAt.toString()),
    fightStartedAt: Number(round.fightStartedAt.toString()),
    fighterCount: round.fighterCount,
    houseFighterCount: houseFighters,
    realFighterCount: realFighters,
    // Decided by `lobbyIsHeldOpen` in lobbyPolicy.ts and passed in, not recomputed here: it is the
    // same predicate the keeper's own branch runs on, and a second copy of it in the publisher is how
    // the file would come to disagree with what the keeper is actually doing.
    heldOpen,
    // The account's own `winner`, unmodified — 0 until `resolve` writes it, exactly as the chain
    // stores it. Reporting anything else before settlement would be this keeper inventing a result.
    winner: round.winner,
    // u64 as a decimal string. A JSON number is an IEEE double and cannot hold a u64 without silently
    // rounding it, and a pot is money.
    pot: round.pot.toString(),
  };
}

// ---------------------------------------------------------------------------------------------
// The countdown rule — pure, so it can be tested and so it cannot be got wrong by accident
// ---------------------------------------------------------------------------------------------

/** What has already been promised, for which round. */
export interface CountdownLatch {
  roundNo: number;
  at: number;
}

/** The two phases in which a next-lobby countdown can honestly exist. During Lobby the chain's own
 *  `lobby_closes_at` is the countdown; during Drawing and Fight there is no honest answer at all. */
const HOLD_PHASES: number[] = [Phase.Settled, Phase.Abandoned];

/**
 * THE ONLY PLACE `nextLobbyOpensAt` IS DECIDED, and it enforces two properties that were each
 * violated in a real run.
 *
 * ONE: IT NEVER CONTRADICTS THE PUBLISHED PHASE. The pair `{round.phase, nextLobbyOpensAt}` is
 * written by two different parts of a pass, and a sample caught the file asserting a next-lobby time
 * beside a round that still read `Fight` — the phase snapshot was taken before `resolve` landed and
 * the countdown after. `keeperCountdown` happens to ignore the countdown in that phase, so no user saw
 * a wrong number, but the FILE said something untrue, and the next person to read it has no way to
 * know that. A countdown is published only alongside a round that is genuinely in a hold phase.
 *
 * TWO: IT IS LATCHED PER ROUND, so the countdown counts DOWN. A sample of one result hold showed
 * `0:11, 0:09, 0:07, 0:05, 0:11, 0:09, 0:07, 0:11…` — sawtoothing for fifty seconds instead of
 * counting twelve down to zero once. Every reset is one more process (or one more pass) freshly
 * observing the settled round and computing "now + RESULT_HOLD_SECONDS" again. The entire
 * justification for the result hold is that it is the ONE interval where this number is honest, and a
 * clock that jumps backwards is not honest — it is an invented number with extra steps. So the first
 * value published for a round is the value that round keeps.
 *
 * The latch is what makes it monotonic, and it also removes the need for any "slip" logic: if
 * `close_round` overruns the hold, the latched time simply passes, `keeperCountdown` returns nothing
 * once it does, and the next round opens as soon as the work finishes. Moving the promise later
 * because the keeper was slow would be the same lie in the other direction.
 */
export function honestNextLobbyOpensAt(
  round: KeeperRoundStatus | null,
  candidate: number | null,
  latch: CountdownLatch | null,
): { at: number | null; latch: CountdownLatch | null } {
  // `keeperCountdown` returns nothing when `round` is null, so a countdown without a round is a
  // promise nothing can render — and it would be a promise about a round that is not described.
  if (round === null || !HOLD_PHASES.includes(round.phaseCode)) return { at: null, latch };
  if (latch !== null && latch.roundNo === round.no) return { at: latch.at, latch };
  if (candidate === null) return { at: null, latch };
  return { at: candidate, latch: { roundNo: round.no, at: candidate } };
}

/**
 * THE SAME RULE FOR `entriesCloseAt`, MINUS THE LATCH — and the missing latch is the interesting part.
 *
 * PROPERTY ONE IS IDENTICAL AND IS WHY THIS FUNCTION EXISTS AT ALL: a close time is published only
 * beside a round that is genuinely still in `Lobby`. The pair `{round.phase, entriesCloseAt}` is
 * written by two different parts of a pass, so the same contradiction `honestNextLobbyOpensAt` was
 * written for is available here — the phase snapshot taken before the early close lands and the
 * countdown set during it, leaving the file claiming that entries close in eight seconds beside a
 * round that is already `Drawing`. `keeperCountdown` happens to ignore it in that phase; the FILE
 * would still be asserting something untrue, and the next reader has no way to know.
 *
 * PROPERTY TWO NEEDS NOTHING HERE, WHICH IS WORTH SAYING RATHER THAN LEAVING TO BE NOTICED.
 * `nextLobbyOpensAt` has to be latched because its candidate is recomputed as `now + hold` on every
 * pass, so an unlatched one sawtooths. This candidate is `firstRealEntryObservedAt + grace`, and
 * `firstRealEntryObservedAt` is ALREADY latched per round, in the keeper's timeline, by the branch
 * that stamps it. So the value proposed on every pass of a lobby is the same value, and a second
 * latch here would be machinery guarding an invariant that is already true one layer up — which is
 * worse than useless, because it would hide a regression in the layer that actually holds it.
 */
export function honestEntriesCloseAt(
  round: KeeperRoundStatus | null,
  candidate: number | null,
): number | null {
  if (round === null || round.phaseCode !== Phase.Lobby) return null;
  return candidate;
}

// ---------------------------------------------------------------------------------------------

export interface StatusPublisherOptions {
  programId: string;
  arenaPda: string;
  houseWallets: string[];
  disclosure: string;
  /** The CHAIN's clock, in unix seconds. Every timestamp in the file comes from here so a reader
   *  comparing them against its own clock has ONE offset to contend with rather than two: the round's
   *  own fields are chain-stamped, and a heartbeat on a different clock would make "how stale is
   *  this" and "how long until the lobby closes" answerable only in different units. */
  nowSec: () => number;
  /** Where to write the file. Defaults to `STATUS_FILE_PATH`, which is what the keeper uses.
   *
   *  It exists so a test can publish somewhere harmless. The status file is a SINGLE-WRITER resource
   *  and there is usually a real keeper running against `public/` — a test that took the default path
   *  would overwrite a live keeper's status with a fixture, and a page watching at that moment would
   *  read a different process's `startedAt` and `roundsCompleted`. One optional field is a cheap price
   *  for a test suite that cannot interfere with a running arena. */
  filePath?: string;
}

export interface StatusPublisher {
  path: string;
  /** THE CURRENT PAYLOAD, exactly as the file holds it — the second of the two channels in this
   *  file's header. Never null: the publisher renders once at construction, so a request that arrives
   *  before the first `publish()` still gets a well-formed status (with a heartbeat that is honestly
   *  the boot instant) rather than an empty body a reader would have to have a case for. */
  body(): string;
  /** How long ago the published heartbeat was written, in seconds, from memory. For the health
   *  endpoint — no chain call, no filesystem, no allocation worth mentioning. */
  heartbeatAgeSeconds(): number;
  setErValidator(validator: { identity: string; fqdn: string } | null): void;
  setRound(round: KeeperRoundStatus | null): void;
  /** Proposes a next-lobby time. What actually reaches the file is decided by
   *  `honestNextLobbyOpensAt` against the round currently set — see that function. */
  setNextLobbyOpensAt(at: number | null): void;
  /** Proposes the instant the keeper intends to stop taking entries. Reconciled at write time by
   *  `honestEntriesCloseAt` against the round currently set — see that function. */
  setEntriesCloseAt(at: number | null): void;
  setLastError(err: KeeperError | null): void;
  setStalledSince(at: number | null): void;
  /** Report the payer below (or back above) the keeper's funding floor.
   *
   *  LATCHED HERE RATHER THAN AT THE CALL SITE. The caller re-derives its balance every pass and has
   *  no memory, so it would hand over a fresh `since` each time and the published timestamp would
   *  advance for as long as the condition lasted — "out of funds since a moment that keeps moving",
   *  which is a duration that never grows. That is the same failure `nextLobbyOpensAt`'s latch exists
   *  to prevent, one field along, so it gets the same treatment: the first `since` for a stretch is
   *  the one that stretch keeps, and passing null clears it. The AMOUNTS still update on every call,
   *  because those are observations rather than promises. */
  setLowBalance(low: { lamports: bigint; floorLamports: bigint; nowSec: number } | null): void;
  /** True when this round number had not been recorded before — so the caller can raise the alarm
   *  once rather than on every pass. */
  addWedgedRound(roundNo: number): boolean;
  setRoundsCompleted(count: number): void;
  /** Write the current snapshot now, without touching the heartbeat. */
  publish(): void;
  startHeartbeat(): void;
  stopHeartbeat(): void;
}

export function createStatusPublisher(options: StatusPublisherOptions): StatusPublisher {
  const filePath = options.filePath ?? STATUS_FILE_PATH;
  cleanStaleTempFiles(filePath);

  const startedAt = options.nowSec();
  const status: KeeperStatus = {
    schema: KEEPER_STATUS_SCHEMA,
    keeper: {
      startedAt,
      heartbeatAt: startedAt,
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      staleAfterSeconds: STALE_AFTER_SECONDS,
      roundsCompleted: 0,
      lastError: null,
      stalledSince: null,
      wedgedRounds: [],
      lowBalance: null,
    },
    chain: {
      // ER-000: this fork is structurally prevented from reaching mainnet, and the status file says so
      // out loud rather than leaving the cluster to be inferred from an RPC URL nobody displays.
      cluster: "devnet",
      programId: options.programId,
      arenaPda: options.arenaPda,
      erValidator: null,
    },
    round: null,
    entriesCloseAt: null,
    nextLobbyOpensAt: null,
    house: { wallets: options.houseWallets, disclosure: options.disclosure },
  };

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let latch: CountdownLatch | null = null;
  let proposedNextLobbyOpensAt: number | null = null;
  let proposedEntriesCloseAt: number | null = null;
  let writeFailures = 0;

  /** Reconcile, then serialize. The RESULT is what both channels emit — see this file's header.
   *
   *  Both countdowns are reconciled against the round at RENDER time, not at set time, because the
   *  three are assigned by different parts of a pass and only their final pairing is what a reader
   *  sees. That reconciliation advances the per-round latch, which is exactly why this runs once per
   *  publish on the keeper's own schedule and never from a request handler. */
  function render(): string {
    const decided = honestNextLobbyOpensAt(status.round, proposedNextLobbyOpensAt, latch);
    latch = decided.latch;
    status.nextLobbyOpensAt = decided.at;
    status.entriesCloseAt = honestEntriesCloseAt(status.round, proposedEntriesCloseAt);
    return serializeKeeperStatus(status);
  }

  function writeFile(bytes: string): void {
    // Same directory as the target — see this file's header on why a cross-device rename would not be
    // atomic. The pid keeps two keeper processes (a stray one and its replacement) from writing the
    // same temp path, which would reintroduce the torn read by the back door.
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, filePath);
  }

  /** The last rendered payload. Seeded here rather than left empty so `body()` has an answer from the
   *  moment the publisher exists — the HTTP server starts before the first loop pass, and a request
   *  landing in that window must get a real status, not a special case. */
  let published = render();

  /** Every publish goes through here. A status file that cannot be written must never take the keeper
   *  down: the rounds are what matter, and a keeper that stopped running them because a disk was full
   *  would be trading the product for its own telemetry. It goes stale, the UI says "keeper down",
   *  and the log says why — ONCE, and then once per hundred failures. A permanent failure otherwise
   *  emits an error line on every publish and every heartbeat, roughly 1.5 lines a second forever,
   *  which buries the diagnosis it is trying to deliver.
   *
   *  THE RENDER IS OUTSIDE THE `try`, AND THAT IS THE POINT OF SPLITTING THEM. The two channels fail
   *  independently: a full disk, a read-only container filesystem, a `public/` that does not exist in
   *  the image — none of those are reasons for the HTTP body to stop advancing, and in production the
   *  file is the channel nobody is reading. So the payload is rendered first and unconditionally, and
   *  only the write is guarded. (`render` itself cannot throw: `status` holds numbers, strings, nulls
   *  and arrays of those — no BigInt, no cycles, nothing `JSON.stringify` refuses.) */
  function publishSafely(context: string): void {
    published = render();
    try {
      writeFile(published);
      writeFailures = 0;
    } catch (e) {
      writeFailures += 1;
      if (writeFailures === 1 || writeFailures % 100 === 0) {
        logError(
          `could not write the status file (${context}, failure #${writeFailures}) — the keeper keeps ` +
          `running and the HTTP status endpoint is unaffected, but anything reading the file will see ` +
          `it as down: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return {
    path: filePath,
    body: () => published,
    heartbeatAgeSeconds: () => options.nowSec() - status.keeper.heartbeatAt,
    setErValidator(validator) { status.chain.erValidator = validator; },
    setRound(round) { status.round = round; },
    setNextLobbyOpensAt(at) { proposedNextLobbyOpensAt = at; },
    setEntriesCloseAt(at) { proposedEntriesCloseAt = at; },
    setLastError(err) { status.keeper.lastError = err; },
    setStalledSince(at) { status.keeper.stalledSince = at; },
    setLowBalance(low) {
      if (low === null) {
        status.keeper.lowBalance = null;
        return;
      }
      // The latch — see the interface's doc comment. `since` survives from the first call of a
      // stretch; the amounts are refreshed every call, because a balance is an observation and a
      // reader watching it fall is watching something true.
      status.keeper.lowBalance = {
        since: status.keeper.lowBalance?.since ?? low.nowSec,
        lamports: low.lamports.toString(),
        floorLamports: low.floorLamports.toString(),
      };
    },
    addWedgedRound(roundNo) {
      if (status.keeper.wedgedRounds.includes(roundNo)) return false;
      status.keeper.wedgedRounds.push(roundNo);
      return true;
    },
    setRoundsCompleted(count) { status.keeper.roundsCompleted = count; },
    publish() { publishSafely("publish"); },
    startHeartbeat() {
      if (heartbeat) return;
      // ITS OWN TIMER, INDEPENDENT OF THE MAIN LOOP, and that independence is the entire point. The
      // loop can be inside one long await — waiting out a 60-second lobby, waiting on a VRF callback,
      // waiting for an undelegate commit — and during every one of those the keeper is healthy and
      // must keep saying so. A heartbeat driven from the loop would go stale in exactly the stretches
      // where a reader most needs to know the process is alive, and "quiet" would be
      // indistinguishable from "dead".
      //
      // It rewrites `heartbeatAt` whether or not anything else changed, which is what makes the field
      // mean "this process was alive at this moment" rather than "something happened at this moment".
      // That is also precisely why `stalledSince` exists: alive is not the same as progressing, and
      // this timer cannot tell the difference.
      heartbeat = setInterval(() => {
        status.keeper.heartbeatAt = options.nowSec();
        publishSafely("heartbeat");
      }, HEARTBEAT_INTERVAL_SECONDS * 1_000);
    },
    stopHeartbeat() {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    },
  };
}

/** Remove `keeper-status.json.tmp-*` left behind by a process killed between the write and the rename.
 *
 *  They accumulate in `public/`, which is served verbatim — so a stale temp file is publicly fetchable
 *  at a URL nobody expects, and `vite build` would copy every one of them into `dist/`. Cleaned at
 *  boot rather than at exit, because the case that creates them is precisely the exit that does not
 *  get to run any code. */
function cleanStaleTempFiles(statusFilePath: string): void {
  const dir = dirname(statusFilePath);
  const prefix = `${statusFilePath.slice(dir.length + 1)}.tmp-`;
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix)) {
        unlinkSync(join(dir, name));
        warn(`removed a stale status temp file left by a killed keeper: ${name}`);
      }
    }
  } catch (e) {
    warn(`could not sweep stale status temp files: ${e instanceof Error ? e.message : String(e)}`);
  }
}
