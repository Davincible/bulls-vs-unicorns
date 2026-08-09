// THE KEEPER'S PUBLISHED STATUS FILE — one shape, defined once, WRITTEN by the keeper process and
// READ by the browser.
//
// WHY THIS FILE EXISTS AT ALL. The front end must never invent a "next lobby" time. Before the
// keeper there was no schedule for it to know: a round existed because an operator had run
// `admin-open-round.mjs`, and nothing anywhere could say whether another one was coming. Any
// countdown a client drew between rounds was therefore a guess wearing the clothes of a fact —
// precisely the invented number `Round.lobby_closes_at` exists to delete from the lobby, reappearing
// one phase later where nobody was looking for it.
//
// This file is the contract that lets the UI tell
//
//     "keeper running, next lobby in 0:08"   from   "keeper is down, no round is coming"
//
// and draw a number only in the first case. The second case is not a degraded version of the first;
// it is a different sentence, and a page that showed 0:08 there would be lying about a process that
// is not running.
//
// ONE MODULE, BOTH ENDS. `scripts/keeper/` imports this to build the file; `useKeeperStatus.ts`
// imports it to read one. A writer and a reader each holding their own copy of a shape is a schema
// that drifts silently, and it always drifts the same way — the UI keeps rendering a field the
// keeper stopped writing, because `undefined` formats as an empty string and nothing throws.
//
// EVERY TIMESTAMP IN HERE IS UNIX SECONDS, NEVER MILLISECONDS. That is the unit of the program's own
// `Clock::get()?.unix_timestamp`, and most of these fields are copied straight off a `Round` account,
// so seconds is the unit that requires no conversion at the point where a mistake would be a
// thousand-fold error. A browser holds `Date.now()` in milliseconds: divide before comparing against
// anything in this file, and never multiply what is in it.

import { PHASE_NAME } from "../../chain/constants.ts";

/** Bumped whenever a field changes meaning or disappears. `parseKeeperStatus` requires an EXACT
 *  match, so an old page against a new keeper (or the reverse) reads as "keeper down" rather than as
 *  a status it half-understands. Degrading to silence is the only safe direction here: the failure
 *  this whole module prevents is a confidently-drawn wrong number.
 *
 *  2 — ADDED `keeper.stalledSince`, and the first time this mechanism has actually been used rather
 *  than merely provided for. A v1 file cannot say "alive but not progressing"; it does not omit that
 *  answer, it has no way to give one. So a v1 file read by this version must not be defaulted to
 *  `stalledSince: null` — that would be the reader inventing a healthy status for a keeper it knows
 *  nothing about, which is this module's own failure mode arriving through the back door. v1 is
 *  rejected outright and the page says "keeper down" instead. Writer and reader ship together, so
 *  the stretch where that costs anything is one deploy long, and the cost of it is silence. */
export const KEEPER_STATUS_SCHEMA = 2;

/** Where the keeper writes it and the browser fetches it. `public/` is served verbatim at the root
 *  by Vite dev, preview and a production build alike. */
export const KEEPER_STATUS_URL = "/keeper-status.json";

/** The five phases of `Phase` in `chain/constants.ts`, by name — DERIVED from that list rather than
 *  spelled out again, because a sixth phase added there must not be able to arrive here as a string
 *  this file's union silently rejects. */
export type KeeperPhaseName = (typeof PHASE_NAME)[number];

export interface KeeperRoundStatus {
  no: number;
  pda: string;
  phase: KeeperPhaseName;
  /** 0..4, matching `Phase` in `chain/constants.ts`. Redundant with `phase` on purpose — a numeric
   *  code is what comparisons and ordering want, a name is what a reader wants — and the parser
   *  checks the two against each other, since redundancy nobody verifies is just two chances to be
   *  wrong. */
  phaseCode: number;
  /** Unix SECONDS, on-chain clock — see this file's header. */
  lobbyOpenedAt: number;
  lobbyClosesAt: number;
  /** 0 until `callback_seed` lands, exactly as the account stores it: the bell has not rung yet, and
   *  0 is the program's own way of saying so. */
  fightStartedAt: number;
  fighterCount: number;
  houseFighterCount: number;
  realFighterCount: number;
  winner: number;
  /** u64 as a decimal string. JSON numbers are IEEE doubles and cannot hold a u64 without silently
   *  rounding it — a pot is money, and money that rounds in transport is not money. */
  pot: string;
}

export interface KeeperError {
  /** Unix seconds. */
  at: number;
  context: string;
  message: string;
}

export interface KeeperStatus {
  schema: number;
  keeper: {
    startedAt: number;
    /** Rewritten every `heartbeatIntervalSeconds`, ALWAYS — including while the keeper is doing
     *  nothing at all, which is the only reason the field means anything. A heartbeat that only
     *  advanced when work happened would go stale during a healthy quiet stretch and be
     *  indistinguishable from a dead process. */
    heartbeatAt: number;
    heartbeatIntervalSeconds: number;
    /** How old a heartbeat has to be before the keeper counts as down. PUBLISHED, so the UI never
     *  invents its own threshold: the keeper is the only party that knows how long its own slowest
     *  legitimate operation takes, and a browser guessing "5 seconds" would flap on every draw. */
    staleAfterSeconds: number;
    /** Unix SECONDS — this file's rule, and worth restating here because this is a timestamp a
     *  reader subtracts from `Date.now() / 1000` with no round number beside it to make a
     *  thousand-fold error obvious. The moment the keeper FIRST crossed its own consecutive-failure
     *  threshold, or null while it is progressing normally. The keeper clears it back to null on any
     *  clean pass, so it marks where the current bad stretch STARTED and does not advance while that
     *  stretch continues — "stalled for 4 minutes" is a subtraction the reader can do, and "stalled
     *  since a moment that keeps moving" would be a number that never grows.
     *
     *  WHY THE KEEPER SAYS THIS RATHER THAN THE PAGE WORKING IT OUT. The keeper's main loop catches
     *  its own errors, records them, backs off — to a ceiling, so the retrying never stops — and goes
     *  round again, while an independent interval keeps rewriting `heartbeatAt` throughout. That
     *  independence is deliberate and `heartbeatAt`'s own comment explains why it has to be, but it
     *  means a keeper wedged on a `resolve` that fails every pass, or on a chain read that never
     *  succeeds, is genuinely alive and genuinely getting nowhere — and until this field existed it
     *  reached the browser as perfectly healthy, so the page kept promising a player that another
     *  round was coming. Whether a loop is making progress is a fact about that loop and not about
     *  the chain: no amount of RPC tells a reader, `lastError` says only that something went wrong
     *  once, and `roundsCompleted` sitting still is also exactly what a quiet healthy stretch looks
     *  like. Same reason `staleAfterSeconds` is published rather than guessed — the party that owns
     *  the fact is the party that states it. */
    stalledSince: number | null;
    roundsCompleted: number;
    lastError: KeeperError | null;
    /** Rounds stuck in `Drawing` that the keeper walked away from — the hole `abandon_round`'s own
     *  doc comment describes, where a VRF callback never lands and no signer has an instruction
     *  left to send. Published rather than logged so the count is visible without shell access. */
    wedgedRounds: number[];
  };
  chain: {
    cluster: "devnet";
    programId: string;
    arenaPda: string;
    erValidator: { identity: string; fqdn: string } | null;
  };
  round: KeeperRoundStatus | null;
  /** Unix SECONDS. NON-NULL ONLY when the keeper is holding between rounds and the next lobby's open
   *  time is genuinely known. Null at every other moment — during a Fight there is no honest answer,
   *  because a fight ends when it ends. */
  nextLobbyOpensAt: number | null;
  house: { wallets: string[]; disclosure: string };
}

// ---------------------------------------------------------------------------------------------
// Parsing — hand-rolled, because `raw` comes off the network
// ---------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  // `Number.isFinite` rather than `typeof === "number"`: `JSON.parse` cannot produce NaN or Infinity,
  // but this function is also the guard for anything hand-edited or hand-mocked, and a NaN timestamp
  // makes every comparison below false — which reads as "fresh", the one wrong answer.
  return typeof v === "number" && Number.isFinite(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** A u64 as the keeper writes it: decimal digits, nothing else, in range. Checked rather than merely
 *  typed as a string, because every consumer's very next move is `BigInt(pot)` — and `BigInt("")` is
 *  a silent 0 while `BigInt("$4.00")` throws, from inside a render, on data that came off the
 *  network. A pot that cannot be a u64 makes the whole status unusable, so it fails here where the
 *  answer is already "no keeper", rather than at a call site with no way to recover. */
function isU64String(v: unknown): v is string {
  return typeof v === "string" && /^\d{1,20}$/.test(v) && BigInt(v) <= 18_446_744_073_709_551_615n;
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(isNumber);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function parseError(raw: unknown): KeeperError | null {
  if (!isRecord(raw)) return null;
  if (!isNumber(raw.at) || !isString(raw.context) || !isString(raw.message)) return null;
  return { at: raw.at, context: raw.context, message: raw.message };
}

// Destructured before checking, throughout: a guard against a property PATH (`raw.no`) narrows only
// as long as nothing between the check and the use could have reassigned it, which is a property of
// the code that a later edit can quietly remove. A local cannot be reassigned by anything, so the
// narrowing is guaranteed by the shape of the function rather than by its current contents.
function parseRound(raw: unknown): KeeperRoundStatus | null {
  if (!isRecord(raw)) return null;
  const { no, pda, phase, phaseCode, lobbyOpenedAt, lobbyClosesAt, fightStartedAt } = raw;
  const { fighterCount, houseFighterCount, realFighterCount, winner, pot } = raw;
  if (!isNumber(no) || !isNumber(phaseCode)) return null;
  if (!isNumber(lobbyOpenedAt) || !isNumber(lobbyClosesAt) || !isNumber(fightStartedAt)) return null;
  if (!isNumber(fighterCount) || !isNumber(houseFighterCount) || !isNumber(realFighterCount)) return null;
  if (!isNumber(winner)) return null;
  if (!isString(pda) || !isU64String(pot)) return null;
  if (!Number.isInteger(phaseCode) || phaseCode < 0 || phaseCode >= PHASE_NAME.length) return null;
  // The two encodings of one fact have to agree. A file whose `phase` says "Lobby" while its
  // `phaseCode` says 2 is not a file with a cosmetic inconsistency — one of the two is what some
  // caller will branch on, and nothing on the page can tell which of them is the true state. Reject
  // it, and let the keeper's own tests catch it long before a browser has to.
  if (phase !== PHASE_NAME[phaseCode]) return null;
  return {
    no,
    pda,
    phase: PHASE_NAME[phaseCode],
    phaseCode,
    lobbyOpenedAt,
    lobbyClosesAt,
    fightStartedAt,
    fighterCount,
    houseFighterCount,
    realFighterCount,
    winner,
    pot,
  };
}

/**
 * Validate a status file and hand back a value of exactly the declared shape, or `null`.
 *
 * NULL IS A COMPLETE ANSWER, not an error to be recovered from: every caller already has to handle
 * "no keeper has ever run here" (a 404), so a file that cannot be understood collapses into that
 * same state rather than into a special one. A UI must render nothing rather than garbage, and a
 * future schema bump must degrade to "keeper down" rather than to a wrong countdown.
 *
 * Hand-rolled checks rather than a schema library, and that is a considered choice: this is one
 * object of eleven fields read by one page, the checks below are the documentation of what the file
 * must contain, and a dependency whose job is to be *slightly* more general than fifty lines is a
 * dependency that will be updated for reasons that have nothing to do with this program.
 *
 * The returned object is BUILT FIELD BY FIELD, never the parsed `raw` with a type assertion on top:
 * anything extra the keeper writes stays out of the value the UI holds, so the type is a description
 * of what is actually there rather than a claim about it.
 */
export function parseKeeperStatus(raw: unknown): KeeperStatus | null {
  if (!isRecord(raw)) return null;
  if (raw.schema !== KEEPER_STATUS_SCHEMA) return null;

  const k = raw.keeper;
  if (!isRecord(k)) return null;
  const { startedAt, heartbeatAt, heartbeatIntervalSeconds, staleAfterSeconds } = k;
  const { roundsCompleted, wedgedRounds } = k;
  if (!isNumber(startedAt) || !isNumber(heartbeatAt)) return null;
  if (!isNumber(heartbeatIntervalSeconds) || !isNumber(staleAfterSeconds)) return null;
  if (!isNumber(roundsCompleted) || !isNumberArray(wedgedRounds)) return null;
  const lastError = k.lastError === null ? null : parseError(k.lastError);
  if (lastError === null && k.lastError !== null) return null;
  // PRESENT OR MALFORMED, exactly like `round` and `nextLobbyOpensAt`: null is a normal, frequent
  // value here — most of the keeper's life is spent progressing — so an explicit null is accepted and
  // an absent key is not. The two are the same JavaScript value at the point of use and completely
  // different claims: one is the keeper saying "I am fine", the other is a writer that has never
  // heard of the question. The schema check above already turns away every v1 file, so what this
  // catches is the hand-written and the half-written one, which is the same file the parser exists
  // for. Narrowed through the type guard rather than by comparing against null, for the reason
  // spelled out at `nextLobbyOpensAt` below.
  const rawStalled = k.stalledSince;
  const stalledSince = isNumber(rawStalled) ? rawStalled : null;
  if (stalledSince === null && rawStalled !== null) return null;

  const c = raw.chain;
  if (!isRecord(c)) return null;
  // ER-000: this fork is structurally prevented from reaching mainnet, and the status file says so
  // out loud rather than leaving the cluster to be inferred from an RPC URL nobody displays.
  if (c.cluster !== "devnet") return null;
  const { programId, arenaPda } = c;
  if (!isString(programId) || !isString(arenaPda)) return null;
  let erValidator: { identity: string; fqdn: string } | null = null;
  if (c.erValidator !== null) {
    const v = c.erValidator;
    if (!isRecord(v) || !isString(v.identity) || !isString(v.fqdn)) return null;
    erValidator = { identity: v.identity, fqdn: v.fqdn };
  }

  const h = raw.house;
  if (!isRecord(h)) return null;
  const { wallets, disclosure } = h;
  if (!isStringArray(wallets) || !isString(disclosure)) return null;

  // `round: null` is a normal, frequent state — the keeper between rounds — so an explicit null is
  // accepted, and anything else that fails to parse (an absent field included) is not.
  const round = raw.round === null ? null : parseRound(raw.round);
  if (round === null && raw.round !== null) return null;

  // Narrowed through the type guard rather than by comparing against null, because this project
  // builds without `strictNullChecks` — `x !== null` tells the compiler nothing about an `unknown`,
  // so a check written that way would leave `unknown` in the returned object.
  const rawNext = raw.nextLobbyOpensAt;
  const nextLobbyOpensAt = isNumber(rawNext) ? rawNext : null;
  if (nextLobbyOpensAt === null && rawNext !== null) return null;

  return {
    schema: KEEPER_STATUS_SCHEMA,
    keeper: {
      startedAt,
      heartbeatAt,
      heartbeatIntervalSeconds,
      staleAfterSeconds,
      stalledSince,
      roundsCompleted,
      lastError,
      // Copied, not aliased: the arrays in the returned value must not be views onto the object the
      // caller parsed, or a caller who mutates one is editing something another holds.
      wedgedRounds: [...wedgedRounds],
    },
    chain: { cluster: "devnet", programId, arenaPda, erValidator },
    round,
    nextLobbyOpensAt,
    house: { wallets: [...wallets], disclosure },
  };
}

// ---------------------------------------------------------------------------------------------
// The three questions the UI actually asks
// ---------------------------------------------------------------------------------------------

/**
 * IS THE KEEPER DOWN — THE LOAD-BEARING PREDICATE OF THIS ENTIRE MODULE.
 *
 * Everything else here is shape; this is the one line that decides whether the page is allowed to
 * promise a player that another round is coming. A status file is a file: it stays on disk, perfectly
 * well-formed and perfectly readable, for as long as the web server runs, whether or not the process
 * that wrote it is still alive. The heartbeat is the only thing separating "this describes now" from
 * "this describes the last moment before the keeper died", and this comparison is where that
 * distinction is drawn.
 *
 * The threshold comes off the file (`staleAfterSeconds`), never from the caller — see that field.
 *
 * @param nowSec unix SECONDS. `Date.now() / 1000`, not `Date.now()`.
 */
export function isKeeperStale(status: KeeperStatus, nowSec: number): boolean {
  return nowSec - status.keeper.heartbeatAt > status.keeper.staleAfterSeconds;
}

/**
 * IS THE KEEPER UP BUT GETTING NOWHERE — the third state, and the one that used to read as the first.
 *
 * `isKeeperStale` asks whether the process is still there. This asks whether its being there is doing
 * anybody any good. The two are genuinely independent: the heartbeat runs on its own interval and
 * knows nothing about the main loop, so a keeper whose every pass throws goes on writing a perfectly
 * fresh `heartbeatAt` for as long as it is up. Live observation is what put this function here — a
 * keeper wedged on a failing `resolve`, retrying behind a capped backoff, reading to the page as
 * healthy while the round it was describing was never going to move again. "Alive" stopped being
 * enough to justify a countdown; this is the missing half of that judgement. See
 * `KeeperStatus.keeper.stalledSince`, which is where the fact comes from and where the keeper's side
 * of it is written down.
 *
 * DOWN OUTRANKS STALLED, which is the whole reason this returns FALSE for a stale file rather than
 * true. `stalledSince` in a stale file is a report about a bad stretch that has since ended the only
 * way it could: the process making the report stopped saying anything at all. "The keeper is down" is
 * both the stronger sentence and the more useful one to put in front of a player, and it is also the
 * only one still known to be true. Making the two states mutually exclusive is what lets a view
 * branch three ways
 *
 *     down  /  stalled  /  healthy
 *
 * by asking two independent questions in whichever order it happens to write them, rather than by
 * remembering that one check has to come before the other. An ordering a caller has to hold in its
 * head is exactly the mistake `keeperCountdown` exists to take away from callers for countdowns; this
 * is the same mistake wearing different clothes, and it gets the same treatment.
 *
 * @param nowSec unix SECONDS. `Date.now() / 1000`, not `Date.now()`.
 */
export function isKeeperStalled(status: KeeperStatus, nowSec: number): boolean {
  return status.keeper.stalledSince !== null && !isKeeperStale(status, nowSec);
}

export type KeeperCountdown =
  | { kind: "entries-close"; seconds: number }
  | { kind: "next-lobby"; seconds: number }
  | { kind: "none" };

/**
 * THE ONE FUNCTION THE UI NEEDS, and the only place the honesty rule is written down.
 *
 * It exists as a single function rather than as three fields a view assembles for itself because the
 * rule is entirely made of cases where the answer is "say nothing", and a caller re-deriving it will
 * get four of the seven right. `none` is not a fallback here — it is the correct, deliberate answer
 * at every moment the schedule is genuinely unknown:
 *
 *   * no status, or a stale one — the keeper is down, so no round is coming, so there is nothing to
 *     count down to. This case outranks every other: a lobby deadline eight seconds in the future is
 *     still meaningless if the process that would draw that lobby has stopped;
 *   * a STALLED keeper — up, heartbeat fresh, round fields all intact, and its loop failing and
 *     retrying since `keeper.stalledSince` rather than progressing. The same argument as the case
 *     above, one state along, and it arrived here the same way: by being watched happening. Nothing
 *     about a healthy-looking file opens the next lobby; only the keeper does, and this one is not
 *     going to. Outranks everything below it for the same reason the stale case does;
 *   * a lobby PAST its deadline — the next thing to happen is a draw or an abandonment, and which of
 *     those it is depends on the fighter count and on when the keeper's next pass runs. "0:00" held
 *     on screen is the exact display this project keeps deleting;
 *   * `Drawing` or `Fight` — a fight ends when it ends. Its length depends on a VRF seed and on who
 *     extracts, and the keeper does not know it either, so there is no next-lobby time to publish
 *     and none to show.
 *
 * Seconds are whole and never negative. They are CEILED rather than floored, matching
 * `entrySecondsLeft` in `contract.ts`: while a countdown is live it must never read 0, because 0 is
 * the thing it says at the end.
 *
 * @param nowSec unix SECONDS.
 */
export function keeperCountdown(status: KeeperStatus | null, nowSec: number): KeeperCountdown {
  const none: KeeperCountdown = { kind: "none" };
  // Both liveness questions first and together, ahead of every case below — see the doc comment. Asked
  // through the two predicates rather than by reading `heartbeatAt` and `stalledSince` here, so this
  // function and every view agree on what down and stalled mean by construction.
  if (status === null) return none;
  if (isKeeperStale(status, nowSec) || isKeeperStalled(status, nowSec)) return none;

  const round = status.round;
  if (round === null) return none;

  if (round.phase === "Lobby") {
    if (round.lobbyClosesAt <= nowSec) return none;
    return { kind: "entries-close", seconds: secondsUntil(round.lobbyClosesAt, nowSec) };
  }

  if (round.phase === "Settled" || round.phase === "Abandoned") {
    const opensAt = status.nextLobbyOpensAt;
    if (opensAt === null || opensAt <= nowSec) return none;
    return { kind: "next-lobby", seconds: secondsUntil(opensAt, nowSec) };
  }

  return none; // Drawing, Fight — see the doc comment.
}

function secondsUntil(deadlineSec: number, nowSec: number): number {
  return Math.max(0, Math.ceil(deadlineSec - nowSec));
}

/**
 * Is this fighter one of the house's?
 *
 * The roster has to be able to mark bots, because README.md carries "Bot disclosure in UI" as a
 * requirement and an undisclosed house fighter in a list of players is a misrepresentation of who
 * a player is up against.
 *
 * THE PUBLISHED LIST IS THE INTERIM MECHANISM, and it is worth being clear about why. It is a claim
 * made by the same process that runs the bots, in a file it writes itself — believable, but not
 * verifiable by anyone reading the chain. The better design is to register the house wallets on the
 * Arena account on-chain, where the disclosure is as public and as tamper-evident as the round it
 * describes and where a client can check it without trusting the keeper at all. That is planned
 * separately; until it lands, this is disclosure on the keeper's word.
 *
 * Base58 is case-sensitive, so the comparison is too — a case-insensitive match here would be a
 * different (and wrong) claim about which key is which.
 */
export function isHouseWallet(status: KeeperStatus | null, pubkey: string): boolean {
  if (status === null) return false;
  return status.house.wallets.includes(pubkey);
}
