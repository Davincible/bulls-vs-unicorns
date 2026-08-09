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
 *  the stretch where that costs anything is one deploy long, and the cost of it is silence.
 *
 *  3 — ADDED `entriesCloseAt` and `round.heldOpen`, for the same reason and with the same
 *  consequence. The keeper no longer cycles rounds on a timer: it opens ONE lobby with a long
 *  backstop deadline, fields the house into it so the room is never empty, and then holds it — at no
 *  marginal cost — until a real player arrives, at which point it closes entries itself. A v2 file
 *  cannot express either half of that. It has no way to say "this deadline is a backstop, not a
 *  schedule" (so a reader would draw `lobbyClosesAt` as a countdown and put "closes in 59:47" in
 *  front of a player, which is precisely the confidently-wrong number this module exists to delete),
 *  and no way to say when the keeper actually intends to stop taking entries. Defaulting the missing
 *  fields would produce exactly that wrong countdown, so v2 is rejected outright and the page says
 *  "keeper down" for the one deploy it takes for the writer to catch up.
 *
 *  4 — ADDED `keeper.lowBalance`, and this one is a fourth liveness state rather than a new detail.
 *  The keeper now refuses to OPEN a round when the payer is below its floor, while still driving any
 *  round already in flight to a terminal state. That is a keeper which is up, heartbeating, not
 *  stalled — its loop is succeeding on every pass — and from which no further round is ever coming.
 *  Every existing predicate reads it as perfectly healthy, because by their definitions it is. A v3
 *  file cannot express the difference: it does not omit the answer, it has no way to give one, so
 *  defaulting the absent field to `null` would be the reader inventing "the arena is funded" about a
 *  keeper it knows nothing about — and the page would go on promising a next lobby that will not
 *  arrive until somebody sends SOL. Rejected outright instead; writer and reader ship together, so
 *  the cost is one deploy of silence, which is this module's standing trade. */
export const KEEPER_STATUS_SCHEMA = 4;

/** WHERE THE BROWSER FETCHES THE STATUS FROM. Relative by default; absolute in production.
 *
 *  LOCALLY the keeper writes `public/keeper-status.json`, which Vite dev, `vite preview` and a
 *  production build all serve verbatim at the root — so the relative default needs no configuration
 *  and no server.
 *
 *  IN PRODUCTION THAT IS IMPOSSIBLE, and it is worth being precise about why rather than leaving the
 *  next person to discover it: the front end is a STATIC build, produced at deploy time and served
 *  from a CDN, and the keeper is a long-running process on another host entirely. It cannot write into
 *  a build that was finished before it started. Wired to the relative path, a deployed page would poll
 *  `/keeper-status.json` on its own origin, get a 404 forever, and say "keeper is down" while the
 *  keeper ran perfectly — the exact false negative this module exists to make impossible in the other
 *  direction. So the keeper serves the same bytes over HTTP (`scripts/keeper/statusServer.ts`) and
 *  this points at that endpoint.
 *
 *  SET `VITE_KEEPER_STATUS_URL` to the FULL absolute URL, e.g.
 *  `https://bulls-arena-keeper-devnet.fly.dev/keeper-status.json`. Vite inlines it at BUILD time, so
 *  it must be set in the hosting project's environment before the build, and changing it needs a
 *  redeploy — which is the correct shape for a value that is part of the artifact.
 *
 *  NOT VALIDATED HERE, DELIBERATELY. A malformed value makes `fetch` fail, which `useKeeperStatus`
 *  already treats exactly like a 404 — "there is no keeper status", the safe answer. Throwing at
 *  module load would instead white-screen the whole app over a mistyped env var, and a page that
 *  renders while saying "keeper down" is strictly better than a page that does not render.
 *
 *  THE GUARD ON `import.meta.env` IS LOAD-BEARING, not defensive habit. This module has TWO runtimes:
 *  the browser, where Vite replaces `import.meta.env` at build time with a real object, and Bun, where
 *  the keeper imports this same file to BUILD the status it publishes. `import.meta.env` is a Vite
 *  construct — it is not part of the ES module spec, and outside a Vite build `import.meta` has no
 *  `env` at all. Reading `import.meta.env.VITE_…` unguarded therefore throws a TypeError under plain
 *  Node the moment the keeper imports its own contract module, at import time, before any handler
 *  exists to catch it. The optional chain is what makes the same expression correct in all three
 *  environments (Vite replaces it; Bun aliases `import.meta.env` to `process.env`; Node leaves it
 *  undefined), and the full `import.meta.env.VITE_…` path is written out rather than destructured
 *  because that literal text is what Vite's build-time substitution matches. */
export const KEEPER_STATUS_URL: string = import.meta.env?.VITE_KEEPER_STATUS_URL || "/keeper-status.json";

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
  /** IS THIS LOBBY'S DEADLINE A BACKSTOP RATHER THAN A SCHEDULE?
   *
   *  True while the keeper is holding the lobby open waiting for a real player: the round is in
   *  `Lobby`, `lobbyClosesAt` is still in the future, and `realFighterCount` is 0. The house is in
   *  there — the room is not empty — but nothing is going to happen until a person arrives.
   *
   *  IT EXISTS TO STOP A COUNTDOWN, WHICH IS THE ONLY REASON A BOOLEAN GOES IN THIS FILE. A held-open
   *  lobby carries a deadline an hour away, and nothing happens at it except the keeper abandoning
   *  the round and opening another one. Rendering "closes in 59:47" off `lobbyClosesAt` would be a
   *  countdown to a non-event, dressed as the moment the fight starts — the same invented number
   *  `Round.lobby_closes_at` was added to the program to delete, one design change later.
   *  `keeperCountdown` therefore answers `waiting-for-players` here and refuses to draw a number at
   *  all, and the page has a specific sentence to say instead of a wrong one.
   *
   *  It is FALSE the instant a real fighter is standing in the lobby, because from that instant the
   *  keeper has a real schedule and publishes it as `entriesCloseAt`. */
  heldOpen: boolean;
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

/** THE ARENA HAS RUN OUT OF MONEY — non-null only while the keeper is refusing to open new rounds
 *  because the payer is below its configured floor.
 *
 *  IT IS A SEPARATE STATE FROM DOWN AND FROM STALLED, and that is the entire reason it is published.
 *  A keeper in this condition is alive (the heartbeat is fresh), progressing (its loop succeeds on
 *  every pass, because refusing to open IS the correct outcome of a pass), and finishing whatever
 *  round was already running. `isKeeperStale` and `isKeeperStalled` both correctly answer false. So
 *  without this field the page would keep counting down to a next lobby that nothing is going to
 *  open — the confidently-wrong number this module exists to delete, arriving through the one door
 *  every other check leaves open.
 *
 *  LATCHED at `since`, like `stalledSince` and for the same reason: it marks where the condition
 *  STARTED and does not advance while it continues, so "out of funds for 20 minutes" is a
 *  subtraction the reader can do. Cleared the moment the balance comes back above the floor.
 *
 *  Both amounts are LAMPORTS as decimal strings, not SOL as floats. A lamport count is a u64 and a
 *  JSON number cannot hold one without silently rounding it; this is the same rule `pot` follows, and
 *  it is money for the same reason. */
export interface KeeperLowBalance {
  /** Unix SECONDS — the moment the keeper FIRST went below its floor in the current stretch. */
  since: number;
  /** What the payer actually holds, in lamports. */
  lamports: string;
  /** The floor it fell below, in lamports — published so a reader never invents a threshold, exactly
   *  as `staleAfterSeconds` is. The keeper is the only party that knows what it costs itself to run
   *  a round. */
  floorLamports: string;
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
    /** Non-null while the payer is below the keeper's floor and no new round will be opened. See
     *  `KeeperLowBalance` — it is a fourth state, not a detail, and `keeperCountdown` refuses to
     *  promise a next lobby while it is set. */
    lowBalance: KeeperLowBalance | null;
  };
  chain: {
    cluster: "devnet";
    programId: string;
    arenaPda: string;
    erValidator: { identity: string; fqdn: string } | null;
  };
  round: KeeperRoundStatus | null;
  /** Unix SECONDS. WHEN THE KEEPER INTENDS TO STOP TAKING ENTRIES — its own schedule, deliberately
   *  NOT the chain's `round.lobbyClosesAt`.
   *
   *  NON-NULL ONLY once a real player has entered the current lobby and the grace window is running.
   *  Null at every other moment, including throughout a held-open lobby: before anybody arrives the
   *  keeper has no intention to publish, because it is not waiting for a clock, it is waiting for a
   *  person.
   *
   *  WHY THE KEEPER'S NUMBER AND NOT THE CHAIN'S. The two answer different questions now. The chain's
   *  `lobbyClosesAt` is the BACKSTOP: the last instant the lobby could possibly still be open, an
   *  hour out, enforced by the program so a round always reaches a terminal state even if this
   *  process dies. This field is the SCHEDULE: the instant the keeper will send the close itself,
   *  seconds away, because somebody turned up. Publishing the backstop as a countdown while a real
   *  player is standing in the lobby would be off by fifty-nine minutes in the direction that reads
   *  as "nothing is happening here".
   *
   *  It is as honest as `nextLobbyOpensAt` and for the same reason: it is a promise the keeper is
   *  about to keep, latched per round so it counts DOWN, and if the keeper is slow the time simply
   *  passes rather than sliding later (`keeperCountdown` then draws nothing). What it is NOT is a
   *  guarantee the chain enforces — a keeper that dies mid-grace leaves the lobby open to its
   *  backstop, and the stale heartbeat is what tells a reader that. */
  entriesCloseAt: number | null;
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

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
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

function parseLowBalance(raw: unknown): KeeperLowBalance | null {
  if (!isRecord(raw)) return null;
  const { since, lamports, floorLamports } = raw;
  if (!isNumber(since)) return null;
  // Through `isU64String` rather than `isString`, for the reason that guard was written: every
  // consumer's next move is `BigInt(...)`, and `BigInt("")` is a silent 0 — which here would render
  // as "the arena has 0 SOL" for a keeper that is merely below its floor, or as a floor of zero that
  // nothing could ever fall below.
  if (!isU64String(lamports) || !isU64String(floorLamports)) return null;
  return { since, lamports, floorLamports };
}

// Destructured before checking, throughout: a guard against a property PATH (`raw.no`) narrows only
// as long as nothing between the check and the use could have reassigned it, which is a property of
// the code that a later edit can quietly remove. A local cannot be reassigned by anything, so the
// narrowing is guaranteed by the shape of the function rather than by its current contents.
function parseRound(raw: unknown): KeeperRoundStatus | null {
  if (!isRecord(raw)) return null;
  const { no, pda, phase, phaseCode, lobbyOpenedAt, lobbyClosesAt, fightStartedAt } = raw;
  const { fighterCount, houseFighterCount, realFighterCount, heldOpen, winner, pot } = raw;
  if (!isNumber(no) || !isNumber(phaseCode)) return null;
  if (!isNumber(lobbyOpenedAt) || !isNumber(lobbyClosesAt) || !isNumber(fightStartedAt)) return null;
  if (!isNumber(fighterCount) || !isNumber(houseFighterCount) || !isNumber(realFighterCount)) return null;
  // REQUIRED, and `false` is not a safe default for an absent key. A writer that has never heard of
  // held-open lobbies is a writer whose `lobbyClosesAt` might be an hour of backstop; reading its
  // silence as "not held open" is what would put the 59:47 countdown on screen. The schema check
  // above already turns those files away — this catches the hand-written and the half-written one.
  if (!isBoolean(heldOpen)) return null;
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
    heldOpen,
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

  // PRESENT OR MALFORMED, same rule as `stalledSince` above and same reason: null is the normal,
  // overwhelmingly common value — a funded arena — so an explicit null is accepted and an absent key
  // is not. The schema check has already turned away every v3 file; what this catches is the
  // hand-written and the half-written one, where reading silence as "funded" would put a countdown
  // for a next lobby in front of a player when the arena cannot pay to open one.
  const lowBalance = k.lowBalance === null ? null : parseLowBalance(k.lowBalance);
  if (lowBalance === null && k.lowBalance !== null) return null;

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

  // Same rule, same reason: null is the normal value (most of a lobby's life nobody has arrived yet),
  // so an explicit null is accepted and an absent key is not.
  const rawEntries = raw.entriesCloseAt;
  const entriesCloseAt = isNumber(rawEntries) ? rawEntries : null;
  if (entriesCloseAt === null && rawEntries !== null) return null;

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
      lowBalance,
      // Copied, not aliased: the arrays in the returned value must not be views onto the object the
      // caller parsed, or a caller who mutates one is editing something another holds.
      wedgedRounds: [...wedgedRounds],
    },
    chain: { cluster: "devnet", programId, arenaPda, erValidator },
    round,
    entriesCloseAt,
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

/**
 * IS THE ARENA OUT OF MONEY — the fourth state, and the one every other predicate calls healthy.
 *
 * `isKeeperStale` asks whether the process is there. `isKeeperStalled` asks whether its being there is
 * doing any good. This asks a third thing: whether it is ALLOWED to do the one thing that matters.
 * A keeper below its funding floor is up, heartbeating, and succeeding on every pass — refusing to
 * open is the correct outcome of a pass, not a failure, so nothing increments a failure count and
 * `stalledSince` correctly stays null. It will also finish whatever round is already running, so the
 * round in the file keeps moving and looks entirely normal. Every existing signal says "fine". No
 * further round is coming until somebody sends SOL.
 *
 * DOWN AND STALLED BOTH OUTRANK IT, and it returns false for either, exactly as `isKeeperStalled`
 * defers to `isKeeperStale`. A funding report inside a stale file describes a process that has since
 * stopped saying anything, and "the keeper is down" is both the stronger sentence and the only one
 * still known to be true. Keeping the states mutually exclusive is what lets a view branch four ways
 *
 *     down  /  stalled  /  out of funds  /  healthy
 *
 * by asking independent questions in whatever order it writes them, instead of remembering a
 * precedence it has to get right.
 *
 * @param nowSec unix SECONDS. `Date.now() / 1000`, not `Date.now()`.
 */
export function isKeeperOutOfFunds(status: KeeperStatus, nowSec: number): boolean {
  return status.keeper.lowBalance !== null
    && !isKeeperStale(status, nowSec)
    && !isKeeperStalled(status, nowSec);
}

export type KeeperCountdown =
  | { kind: "entries-close"; seconds: number }
  | { kind: "next-lobby"; seconds: number }
  /** THE LOBBY IS OPEN AND WAITING FOR A PERSON, AND THERE IS NOTHING TO COUNT. Carries no `seconds`,
   *  because none exists: the keeper will close entries when somebody arrives, and nobody knows when
   *  that is. It is a separate kind rather than `none` because the two are different sentences — the
   *  page has something specific and true to say here ("waiting for players", with the house already
   *  in the room), whereas `none` is the state in which it should say nothing at all. */
  | { kind: "waiting-for-players" }
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
 * THE LOBBY BRANCH HAS THREE ANSWERS NOW, AND THEIR ORDER IS THE WHOLE RULE. A lobby carries two
 * deadlines that mean different things, and reading the wrong one is how the 59:47 countdown gets on
 * screen:
 *
 *   1. `round.heldOpen` — the keeper is waiting for a person, not for a clock. `waiting-for-players`,
 *      and `lobbyClosesAt` MUST NOT be consulted: it is an hour of backstop, and the only thing that
 *      happens at it is the keeper abandoning this round and opening another.
 *   2. `entriesCloseAt` — somebody arrived and the keeper has committed to a time. That commitment
 *      REPLACES the chain deadline for the rest of this lobby, including once it has passed: falling
 *      through to `lobbyClosesAt` at that point is exactly the hour-away lie, arriving three lines
 *      later. So a non-null `entriesCloseAt` is terminal for the Lobby branch — it counts down, and
 *      then it says nothing.
 *   3. `lobbyClosesAt` — the ordinary case, and still the honest one: no early close is coming (this
 *      keeper is running against a program that has none, or the operator is running the old fixed
 *      cadence), so the chain's own deadline is both the schedule and the backstop, and it is what
 *      the program will enforce.
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
    if (round.heldOpen) return { kind: "waiting-for-players" };
    const entriesCloseAt = status.entriesCloseAt;
    if (entriesCloseAt !== null) {
      // Terminal either way — see the doc comment. Once the keeper has named a time for THIS lobby,
      // the chain's backstop is not an alternative answer to fall back on.
      if (entriesCloseAt <= nowSec) return none;
      return { kind: "entries-close", seconds: secondsUntil(entriesCloseAt, nowSec) };
    }
    if (round.lobbyClosesAt <= nowSec) return none;
    return { kind: "entries-close", seconds: secondsUntil(round.lobbyClosesAt, nowSec) };
  }

  if (round.phase === "Settled" || round.phase === "Abandoned") {
    // OUT OF FUNDS KILLS THE NEXT-LOBBY COUNTDOWN AND NOTHING ELSE, which is why this is here rather
    // than beside the stale and stalled checks at the top. The keeper still drives an in-flight round
    // all the way to a terminal state when it is below its floor — it refuses to START work it cannot
    // finish, not to finish work already started — so a Lobby's `entriesCloseAt` and the chain's own
    // deadline remain promises it is about to keep, and blanking them would be its own kind of lie.
    // What is genuinely not coming is the NEXT round.
    //
    // THE KEEPER ALSO DECLINES TO PUBLISH `nextLobbyOpensAt` in this state, so this check is the
    // second of two. That is deliberate rather than duplicated machinery, and the two guard different
    // things: the writer's job is that the FILE never asserts a next lobby beside a keeper that will
    // not open one (property ONE of `honestNextLobbyOpensAt`), and the reader's job is that a
    // countdown already latched before the balance fell cannot keep counting down afterwards. One
    // layer cannot do both, because they are separated by up to a publish interval.
    if (status.keeper.lowBalance !== null) return none;
    const opensAt = status.nextLobbyOpensAt;
    if (opensAt === null || opensAt <= nowSec) return none;
    return { kind: "next-lobby", seconds: secondsUntil(opensAt, nowSec) };
  }

  return none; // Drawing, Fight — see the doc comment.
}

function secondsUntil(deadlineSec: number, nowSec: number): number {
  return Math.max(0, Math.ceil(deadlineSec - nowSec));
}

/** THE SLICE OF A STATUS FILE THE ROSTER ACTUALLY DEPENDS ON — one field, not the whole heartbeat.
 *
 *  `KeeperStatus` is assignable to it, so `isHouseWallet(status, wallet)` still reads exactly as it
 *  did. What the narrower type buys is a caller that can hold a roster WITHOUT holding a status: the
 *  status file is rewritten every two seconds and the house's wallet list changes approximately
 *  never, so anything that re-renders on a fresh `KeeperStatus` re-renders twice a second for a fact
 *  that did not move. `data/keeperFeed.ts` republishes one of these only when its contents change,
 *  and the fixture builds one out of thin air — neither of which can produce a `KeeperStatus`, and
 *  neither of which should have to. */
export interface HouseRoster {
  house: { wallets: readonly string[]; disclosure: string };
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
 *
 * NULL MARKS NOBODY, and that is the whole rule for a page with no keeper: "not known to be house" is
 * the honest default, and a browser that cannot read a disclosure list has no basis to accuse anyone
 * of being a bot. Callers pass null for every version of that — no status file, a stale one, a schema
 * this build cannot parse.
 */
export function isHouseWallet(roster: HouseRoster | null, pubkey: string): boolean {
  if (roster === null) return false;
  return roster.house.wallets.includes(pubkey);
}
