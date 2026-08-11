// Whether the page is allowed to promise a player that another round is coming.
//
// Most of this file is about one failure: a number on screen that nothing is backing. The keeper
// status file is the only thing that can back one, so these check the three ways it can fail to — by
// being unreadable (`parseKeeperStatus`), by being OLD (`isKeeperStale`), and by being written by a
// keeper that is up and no longer getting anywhere (`isKeeperStalled`) — and then check that
// `keeperCountdown` says nothing in each of the seven situations where there is genuinely nothing to
// say. The last two are the interesting cases throughout, because their files still look perfectly
// healthy: well-formed, a lobby deadline comfortably in the future, and written either by a process
// that stopped running four minutes ago or by one whose every pass has thrown since.
//
// THERE IS A SECOND SUBJECT NOW, and it is worth saying out loud rather than leaving somebody to
// infer it from three tests that look like the others. Schema 5 took fields AWAY — the house
// disclosure, the two fighter counts, and the text of whatever exception the keeper last caught —
// because a status file is a thing every browser fetches and nothing about "the UI stopped rendering
// it" keeps bytes out of a browser. Those tests assert what does NOT come out of the parser, which
// makes them inverted in shape and easy to write vacuously: an assertion that a key is absent passes
// beautifully against a value that was never built. So each of them either proves the file it fed in
// was accepted before checking what survived, or is paired with a rejection test that proves the
// opposite half. Read them together; alone, each says less than it appears to.
//
// All fixtures come off ONE base object, so a field added to the contract is added in one place.
// Phases are set through `inPhase()` rather than by hand, because a fixture whose `phase` and
// `phaseCode` disagreed would be testing the parser's rejection path by accident.

import { describe, expect, it } from "vitest";
import { PHASE_NAME } from "../../chain/constants.ts";
import {
  KEEPER_STATUS_SCHEMA,
  isKeeperOutOfFunds,
  isKeeperStale,
  isKeeperStalled,
  keeperCountdown,
  parseKeeperStatus,
  type KeeperPhaseName,
  type KeeperRoundStatus,
  type KeeperStatus,
} from "./keeperStatus.ts";

/** A fixed unix SECOND to hang every fixture off, so no test depends on when it was run. */
const NOW = 1_800_000_000;
const STALE_AFTER = 10;

/** A stand-in for one of the arena's own wallets, and it now appears only in files the parser must
 *  refuse to hand on whole or in part: the v4 file a keeper that has not been redeployed is still
 *  writing, the regressed v5 file that started republishing the disclosure under the new schema
 *  number, and — in the place an RPC error would really have put it — the exception text inside a
 *  `lastError`. There is deliberately no fixture in which it reaches a parsed status, because "this
 *  string never comes out the other end, by whichever door it went in" is the whole of what the three
 *  inversions in `parseKeeperStatus` exist to hold. */
const HOUSE_WALLET = "H0useWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const BASE_ROUND: KeeperRoundStatus = {
  no: 7,
  pda: "R0undPdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  phase: "Lobby",
  phaseCode: 0,
  lobbyOpenedAt: NOW - 30,
  lobbyClosesAt: NOW + 30,
  fightStartedAt: 0,
  // The only fighter count the file carries, and it is the CHAIN's — a copy of the `Round` account
  // anybody can read for themselves. Nothing here splits it into house and real; see schema 5.
  fighterCount: 4,
  // The base fixture is the pre-hold-open shape on purpose: a lobby with a real deadline the keeper
  // is going to let run out. The held-open cases set it explicitly, so every test that draws a
  // `lobbyClosesAt` countdown is visibly a test about a lobby that has one.
  heldOpen: false,
  winner: 0,
  pot: "4000000",
};

const BASE: KeeperStatus = {
  schema: KEEPER_STATUS_SCHEMA,
  keeper: {
    startedAt: NOW - 3_600,
    heartbeatAt: NOW,
    heartbeatIntervalSeconds: 2,
    staleAfterSeconds: STALE_AFTER,
    stalledSince: null,
    roundsCompleted: 42,
    lastError: null,
    wedgedRounds: [],
    lowBalance: null,
  },
  chain: {
    cluster: "devnet",
    programId: "CH7K8rDXgPQRs9CCHG9EK5kd1YSDZyPkCDGArcz4PSNP",
    arenaPda: "ArenaPdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    erValidator: { identity: "Va1idat0rAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", fqdn: "devnet.magicblock.app" },
  },
  round: BASE_ROUND,
  entriesCloseAt: null,
  nextLobbyOpensAt: null,
};

/** Both encodings of a phase at once — see this file's header. */
function inPhase(name: KeeperPhaseName): Pick<KeeperRoundStatus, "phase" | "phaseCode"> {
  return { phase: name, phaseCode: PHASE_NAME.indexOf(name) };
}

function status(over: Partial<KeeperStatus> = {}): KeeperStatus {
  return { ...BASE, ...over };
}

function round(over: Partial<KeeperRoundStatus> = {}): KeeperRoundStatus {
  return { ...BASE_ROUND, ...over };
}

function withKeeper(over: Partial<KeeperStatus["keeper"]>): KeeperStatus {
  return { ...BASE, keeper: { ...BASE.keeper, ...over } };
}

/** `withKeeper`, but against a status that is not the base one — for asking the liveness questions of
 *  a held-open lobby, where both the round and the keeper half have been moved off the fixture. */
function withHeldRound(from: KeeperStatus, over: Partial<KeeperStatus["keeper"]>): KeeperStatus {
  return { ...from, keeper: { ...from.keeper, ...over } };
}

/** The base object as it actually arrives: through JSON, off the network, typed `unknown`. */
function rawStatus(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(BASE)) as Record<string, unknown>;
}

describe("isKeeperStale", () => {
  it("uses the threshold the keeper published, not one the page chose for itself", () => {
    const s = withKeeper({ heartbeatAt: NOW - STALE_AFTER });
    expect(isKeeperStale(s, NOW)).toBe(false); // exactly at the threshold is still alive
    expect(isKeeperStale(s, NOW + 1)).toBe(true);

    // Same heartbeat, same clock, different published tolerance — the only input that moved is the
    // one the keeper owns.
    const patient = { ...s, keeper: { ...s.keeper, staleAfterSeconds: STALE_AFTER * 10 } };
    expect(isKeeperStale(patient, NOW + 1)).toBe(false);
  });
});

describe("isKeeperStalled", () => {
  it("is true for a keeper that is still writing heartbeats but has stopped getting anywhere", () => {
    // The state schema 1 could not express. Every check that existed before this one calls this file
    // healthy, and the loop that would open the next lobby has been failing for a minute and a half.
    const wedged = withKeeper({ stalledSince: NOW - 90 });
    expect(isKeeperStale(wedged, NOW)).toBe(false);
    expect(isKeeperStalled(wedged, NOW)).toBe(true);
  });

  it("is false for a keeper that is simply doing its job", () => {
    expect(isKeeperStalled(BASE, NOW)).toBe(false);
  });

  it("is false once a stalled keeper has gone quiet, because down outranks stalled", () => {
    // THE CASE MOST LIKELY TO BE GOT WRONG LATER, and the reason the precedence is in the predicate
    // rather than left to each caller. This file says both things at once: it has been stalled for
    // five minutes AND it stopped being written four minutes ago. Only one of those is still known to
    // be true — a report about a bad stretch, from a process that has since stopped reporting at all —
    // so the answer here is "down", said once, by `isKeeperStale`.
    const gone = withKeeper({ stalledSince: NOW - 300, heartbeatAt: NOW - 240 });
    // The two assertions together are the mutual exclusivity a three-way view relies on: exactly one
    // of down / stalled / healthy is ever the answer, whichever order the view asks in.
    expect(isKeeperStale(gone, NOW)).toBe(true);
    expect(isKeeperStalled(gone, NOW)).toBe(false);
  });
});

describe("keeperCountdown", () => {
  it("counts entries down while the lobby is still taking them", () => {
    expect(keeperCountdown(status(), NOW)).toEqual({ kind: "entries-close", seconds: 30 });
  });

  it("says waiting-for-players for a held-open lobby, and never counts its hour-away backstop", () => {
    // THE REGRESSION `round.heldOpen` WAS ADDED TO THIS FILE FOR. The keeper opens one lobby with an
    // hour of backstop and holds it until somebody arrives; the room is not empty while it waits, it
    // is simply not going anywhere. Reading `lobbyClosesAt` here would put "closes in 59:59" in front
    // of a player — a countdown to a non-event (the keeper abandoning this round and opening
    // another), which reads as a dead arena.
    //
    // NOTHING IN THIS FIXTURE SAYS HOW MANY OF THE FOUR FIGHTERS THE ARENA PUT THERE, and nothing
    // needs to: `keeperCountdown` branches on `heldOpen` and on `entriesCloseAt`, never on a count of
    // anybody. The flag is the keeper stating its own intention, which since schema 5 is the only
    // form of this fact the file carries — and it is the better one to branch on regardless, because
    // "I am still waiting" is a claim the writer owns, whereas a count is a thing a reader would have
    // to interpret. The same goes for the two tests below.
    const held = status({
      round: round({ heldOpen: true, lobbyClosesAt: NOW + 3_600 }),
    });
    expect(keeperCountdown(held, NOW)).toEqual({ kind: "waiting-for-players" });

    // And it is genuinely `heldOpen` deciding it: the same file with the flag cleared falls through
    // to the chain deadline, which is the honest answer for a lobby that really does close then.
    const notHeld = status({ round: round({ heldOpen: false, lobbyClosesAt: NOW + 3_600 }) });
    expect(keeperCountdown(notHeld, NOW)).toEqual({ kind: "entries-close", seconds: 3_600 });
  });

  it("counts to the keeper's own close once a real player has arrived and the grace is running", () => {
    // The moment that ends the hold. `entriesCloseAt` is seconds away and `lobbyClosesAt` is still an
    // hour away; the number a player is owed is the one the keeper is about to act on.
    //
    // The arrival shows up in this file as two things and only two: the chain's `fighterCount` up by
    // one, and a `heldOpen` the keeper has cleared in favour of a time it has committed to. Which of
    // those five fighters is the new one is not something the file says any more.
    const arrived = status({
      round: round({ heldOpen: false, lobbyClosesAt: NOW + 3_600, fighterCount: 5 }),
      entriesCloseAt: NOW + 18,
    });
    expect(keeperCountdown(arrived, NOW)).toEqual({ kind: "entries-close", seconds: 18 });
  });

  it("says nothing once the keeper's close is due, rather than falling back to the backstop", () => {
    // THE CASE MOST LIKELY TO BE GOT WRONG BY A LATER EDIT. The grace has run out and the keeper is
    // sending the close. If this branch fell through to `lobbyClosesAt` the page would jump from
    // "0:01" to "59:42" at the exact instant the fight was about to start — the hour-away lie
    // arriving three lines later than the one `heldOpen` deletes.
    // Same lobby as the test above, one grace window later — hence the same `fighterCount: 5`, which
    // is the whole of what this file now says about somebody having turned up.
    const due = status({
      round: round({ heldOpen: false, lobbyClosesAt: NOW + 3_600, fighterCount: 5 }),
      entriesCloseAt: NOW,
    });
    expect(keeperCountdown(due, NOW)).toEqual({ kind: "none" });
    expect(keeperCountdown({ ...due, entriesCloseAt: NOW - 4 }, NOW)).toEqual({ kind: "none" });
  });

  it("says nothing for a held-open lobby the moment the keeper writing it goes quiet", () => {
    // Down outranks waiting-for-players exactly as it outranks every countdown. "Waiting for players"
    // is a claim that a process is watching for them; a stale file is the claim that it is not.
    const held = status({ round: round({ heldOpen: true, lobbyClosesAt: NOW + 3_600 }) });
    expect(keeperCountdown(withHeldRound(held, { heartbeatAt: NOW - 240 }), NOW)).toEqual({ kind: "none" });
    expect(keeperCountdown(withHeldRound(held, { stalledSince: NOW - 90 }), NOW)).toEqual({ kind: "none" });
  });

  it("says nothing when the heartbeat is stale, however live the round still looks", () => {
    // THE POINT OF THE HEARTBEAT, in one test. This status has a lobby closing in 30 seconds and is
    // well-formed in every other respect; the only thing wrong with it is that the process which
    // would draw that lobby stopped writing four minutes ago. A countdown here would be a promise
    // nothing is keeping.
    const dead = withKeeper({ heartbeatAt: NOW - 240 });
    expect(dead.round?.lobbyClosesAt).toBeGreaterThan(NOW);
    expect(keeperCountdown(dead, NOW)).toEqual({ kind: "none" });

    // And the same file, one heartbeat fresher, does count down — so it is genuinely the heartbeat
    // deciding this and not some other property of the fixture.
    expect(keeperCountdown(withKeeper({ heartbeatAt: NOW - 2 }), NOW)).toEqual({
      kind: "entries-close",
      seconds: 30,
    });
  });

  it("says nothing while the keeper is stalled, in both of the situations that would otherwise count", () => {
    // A fresh heartbeat is no longer enough to justify a number, and these are the only two branches
    // that produce one, so both are checked: a live lobby, and a finished round with a next lobby the
    // keeper has already committed to. Nobody is going to open either of them.
    const lobby = withKeeper({ stalledSince: NOW - 90 });
    expect(lobby.round?.lobbyClosesAt).toBeGreaterThan(NOW);
    expect(keeperCountdown(lobby, NOW)).toEqual({ kind: "none" });

    const betweenRounds: KeeperStatus = {
      ...lobby,
      round: round(inPhase("Settled")),
      nextLobbyOpensAt: NOW + 8,
    };
    expect(keeperCountdown(betweenRounds, NOW)).toEqual({ kind: "none" });

    // And the same file with the stall cleared does count down — so it is genuinely `stalledSince`
    // deciding this and not some other property of the fixture.
    expect(keeperCountdown({ ...betweenRounds, keeper: BASE.keeper }, NOW)).toEqual({
      kind: "next-lobby",
      seconds: 8,
    });
  });

  it("says nothing when no status has been fetched at all", () => {
    expect(keeperCountdown(null, NOW)).toEqual({ kind: "none" });
  });

  it("says nothing once a lobby is past its deadline, though it is still in Lobby phase", () => {
    // What happens next is a draw or an abandonment depending on the fighter count, and when it
    // happens depends on the keeper's next pass. 0:00 held on screen is the display this whole
    // module exists to prevent.
    const expired = status({ round: round({ lobbyClosesAt: NOW - 1 }) });
    expect(keeperCountdown(expired, NOW)).toEqual({ kind: "none" });
    // Including the exact instant of the deadline: the chain stops accepting entries there too.
    expect(keeperCountdown(status({ round: round({ lobbyClosesAt: NOW }) }), NOW)).toEqual({ kind: "none" });
  });

  it("says nothing during a fight, because a fight ends when it ends", () => {
    // Its length depends on a VRF seed and on who extracts. The keeper does not know it either, so
    // there is no next-lobby time published here to show — and `nextLobbyOpensAt` being null mid-
    // fight is the contract, not an omission.
    const fighting = status({
      round: round({ ...inPhase("Fight"), fightStartedAt: NOW - 5, lobbyClosesAt: NOW + 30 }),
    });
    expect(fighting.nextLobbyOpensAt).toBeNull();
    expect(keeperCountdown(fighting, NOW)).toEqual({ kind: "none" });

    const drawing = status({ round: round({ ...inPhase("Drawing"), lobbyClosesAt: NOW + 30 }) });
    expect(keeperCountdown(drawing, NOW)).toEqual({ kind: "none" });
  });

  it("counts down to the next lobby once a round is over and the keeper knows when", () => {
    for (const phase of ["Settled", "Abandoned"] as const) {
      const done = status({ round: round(inPhase(phase)), nextLobbyOpensAt: NOW + 8 });
      expect(keeperCountdown(done, NOW), phase).toEqual({ kind: "next-lobby", seconds: 8 });
    }
  });

  it("says nothing between rounds when the keeper has not published a next lobby", () => {
    // The keeper is up but has not committed to a time — mid-settlement, or holding on an error.
    // "Keeper alive" is not the same claim as "the next round is at 12:04:31".
    expect(keeperCountdown(status({ round: round(inPhase("Settled")) }), NOW)).toEqual({ kind: "none" });
    // Nor is a next-lobby time that has already come and gone: the keeper is late, and counting
    // upward from a missed schedule is a different (and unasked) question.
    const late = status({ round: round(inPhase("Settled")), nextLobbyOpensAt: NOW - 3 });
    expect(keeperCountdown(late, NOW)).toEqual({ kind: "none" });
  });

  it("says nothing when the keeper is running but holds no round", () => {
    expect(keeperCountdown(status({ round: null }), NOW)).toEqual({ kind: "none" });
  });

  it("never yields a negative or fractional countdown, at any point across a deadline", () => {
    // A browser's clock is a float in seconds and lands anywhere. Sweeping across the deadline is
    // the only way to catch the two failures that live at the boundary: a "-1" flashed on the way
    // past, and a "0" shown while the branch still claims to be counting.
    for (let t = NOW + 27; t <= NOW + 33; t += 0.25) {
      const c = keeperCountdown(status(), t);
      // Narrowed on the FIELD, not on a list of kinds. `KeeperCountdown` has two variants that carry
      // no countdown (`none` and `waiting-for-players`) and this loop only has something to assert
      // about the ones that do — excluding them by name meant the next variant added without
      // `seconds` broke the build, which is exactly what happened.
      if (!("seconds" in c)) continue;
      expect(Number.isInteger(c.seconds), `at ${t}`).toBe(true);
      expect(c.seconds, `at ${t}`).toBeGreaterThan(0);
    }
  });
});

describe("parseKeeperStatus", () => {
  it("accepts the file the keeper writes, once it has been through JSON", () => {
    expect(parseKeeperStatus(rawStatus())).toEqual(BASE);
  });

  it("accepts the between-rounds file, where there is no round and there is a next lobby", () => {
    const raw = rawStatus();
    raw.round = null;
    raw.nextLobbyOpensAt = NOW + 8;
    const parsed = parseKeeperStatus(raw);
    expect(parsed?.round).toBeNull();
    expect(parsed?.nextLobbyOpensAt).toBe(NOW + 8);
  });

  it("rejects a schema it does not recognise, so a newer keeper reads as no keeper", () => {
    // Deliberately including a HIGHER schema: a page left open across a keeper upgrade must fall
    // back to "keeper down" rather than to a status whose fields it half-understands. The right
    // number as a STRING is in there for the same reason — `raw.schema !== KEEPER_STATUS_SCHEMA` is
    // the check, and it has to stay the check that `==` would have got wrong.
    const wrong = [KEEPER_STATUS_SCHEMA + 1, KEEPER_STATUS_SCHEMA - 1, String(KEEPER_STATUS_SCHEMA), null, undefined];
    for (const schema of wrong) {
      const raw = rawStatus();
      raw.schema = schema;
      expect(parseKeeperStatus(raw), String(schema)).toBeNull();
    }
  });

  it("rejects the v4 file a not-yet-redeployed keeper is still writing, pubkeys and all", () => {
    // The literal 4, for the reason the v2 and v1 cases below use their literals: v4 files exist —
    // on disk in `public/`, in any browser cache holding one, and coming out of a keeper process that
    // nobody has restarted yet — and they go on being v4 files forever, whereas `SCHEMA - 1` stops
    // naming them the moment somebody bumps to 6.
    //
    // AND THE DIRECTION OF THE TRADE INVERTS HERE, which is the whole reason this belongs beside
    // those two rather than being one more entry in the same list. Every earlier bump rejected an old
    // file to protect its READER: a v1 file has no way to say "stalled", a v2 file none to say "held
    // open", a v3 file none to say "out of funds", and letting any of them through with the absent
    // field defaulted would have the page assert a fact the keeper never asserted — this module's own
    // failure mode arriving through the back door. NOTHING IS MISSING FROM THE FILE BELOW. It is
    // complete, well-formed, internally consistent, and every field the UI reads is correct. The only
    // thing wrong with it is that it still SAYS the thing we stopped saying, and it is turned away to
    // protect its SUBJECT rather than its reader. First bump that has ever done that.
    //
    // WHICH IS ALSO WHY IT HAD TO BE A BUMP AND NOT A QUIETER FIX. A parser that merely ignored
    // `house` and the two counts would hand this file's ordinary fields to the page and the
    // forty-eight pubkeys would go on being fetched, cached and sitting in memory in every browser
    // exactly as before — the only thing changed being that nothing rendered them. Refusing the file
    // outright is what makes the removal a property of the SYSTEM rather than a habit of the UI, and
    // this assertion is the place that stays checkable when somebody later decides the reject is
    // inconvenient during a deploy.
    //
    // BUILT WITH BOTH LEAKS IN IT, because that is what a v4 file on disk actually looks like: the
    // disclosure it was written to publish, and the caught exception text it published without anyone
    // deciding to. The second one is why a reject beats a field-by-field fix here even in principle —
    // `house` is a leak you can enumerate, `lastError.message` was found by reading, and a v4 file is
    // turned away for the ones nobody has looked for yet as well as for these two.
    const raw = rawStatus();
    raw.schema = 4;
    raw.house = { wallets: [HOUSE_WALLET], disclosure: "House-operated fighters, disclosed per README." };
    (raw.round as Record<string, unknown>).houseFighterCount = 4;
    (raw.round as Record<string, unknown>).realFighterCount = 0;
    (raw.keeper as Record<string, unknown>).lastError = {
      at: NOW - 12,
      context: "house entries",
      message: `3 of 12 house entries failed on round #23: ${HOUSE_WALLET} insufficient funds`,
    };
    expect(parseKeeperStatus(raw)).toBeNull();
  });

  it("hands back no house identification, however much of it the file it parsed was carrying", () => {
    // THE OTHER HALF OF THE REMOVAL, and the half the schema number does not enforce.
    //
    // The first assertion is the cheap one: the ordinary file the keeper writes has no `house` key,
    // so neither does the value the UI holds. The second is the one worth having. That raw body is a
    // valid v5 — right schema number, every required field present and well-typed — written by a
    // keeper that has REGRESSED and started republishing the disclosure and the two counts under the
    // new number. The schema check does not turn it away and should not: it is a current file, and
    // everything the page reads out of it is right. So the reject tested above cannot be what protects
    // us here, and something else has to.
    //
    // WHAT PROTECTS US HERE IS ONE SENTENCE IN `parseKeeperStatus`'s DOC COMMENT — that the returned
    // object is BUILT FIELD BY FIELD, never the parsed `raw` with a type assertion on top. That rule
    // has been written down since the parser was, where it was a claim about type HONESTY: the type
    // should describe what is actually in the value rather than assert it. It is now load-bearing for
    // a privacy property, which is a great deal of weight for a sentence nobody had ever checked, and
    // that is exactly why it gets a test it never needed before. `return raw as KeeperStatus` written
    // by somebody in a hurry passes every other test in this file.
    expect(Object.keys(parseKeeperStatus(rawStatus())!)).not.toContain("house");

    const regressed = rawStatus();
    regressed.house = { wallets: [HOUSE_WALLET], disclosure: "House-operated fighters." };
    (regressed.round as Record<string, unknown>).houseFighterCount = 4;
    (regressed.round as Record<string, unknown>).realFighterCount = 1;

    const parsed = parseKeeperStatus(regressed);
    // Asserted BEFORE the interesting checks, and not as a formality: if this file were rejected
    // outright, every `not.toContain` below would hold for a reason that has nothing to do with what
    // it is testing, and the test would go on passing while proving nothing.
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!)).not.toContain("house");
    for (const field of ["houseFighterCount", "realFighterCount"]) {
      expect(Object.keys(parsed!.round!), field).not.toContain(field);
    }
    // And the round came through otherwise intact, so it is genuinely the extra fields being left
    // behind rather than the round having been dropped on the way past.
    expect(parsed!.round!.fighterCount).toBe(BASE_ROUND.fighterCount);
  });

  it("hands back an error with no exception text in it, even when the file it parsed had some", () => {
    // THE SAME GUARANTEE AS THE TEST ABOVE, ONE FIELD ALONG — and the field is worth a test of its
    // own because it is the one that was not found by looking for the word "house".
    //
    // `lastError.message` used to be `describeError(e)`: whatever exception the main loop caught,
    // truncated and forwarded verbatim to every browser polling the file. Nobody wrote those bytes.
    // Libraries write them, the RPC writes them, the chain writes them, and they name whatever
    // account the failing instruction happened to touch — so a failed house `enter` is an exception
    // with one of the arena's own wallets inside it, which is why the fixture below puts
    // `HOUSE_WALLET` in exactly the place an RPC simulation failure would have put it. A sampled
    // status file really did carry a full simulation failure here, program id and transaction logs
    // and all, out of the process that holds the arena authority key, into a field no view has ever
    // rendered.
    //
    // AND THE SHAPE OF THE FIX IS WHAT THIS TEST PINS. Sanitising the text was the alternative, and a
    // filter over strings you did not write has to be right every time forever, against every library
    // that ever rewords a message — the one time it is wrong, the leak is silent and permanent. So
    // the field was removed and `context` was closed to a fixed vocabulary written at the call sites,
    // which has no inputs and therefore nothing to get wrong. Here, as with `house`, what actually
    // keeps the bytes out of the browser is `parseError` building its result from named fields rather
    // than spreading `raw` — the second field for which "built field by field" has become a privacy
    // property rather than only a statement about type honesty.
    const raw = rawStatus();
    (raw.keeper as Record<string, unknown>).lastError = {
      at: NOW - 12,
      context: "enter",
      message: `Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1 [account ${HOUSE_WALLET}]`,
    };
    const parsed = parseKeeperStatus(raw);
    // It PARSES — `message` is ignored, not rejected, so a v5 keeper that has not caught up on this
    // detail still produces a usable file rather than reading as "keeper down". The schema check is
    // what turns away the v4 file that carries one; this is the hand-written and half-written case.
    expect(parsed!.keeper.lastError).toEqual({ at: NOW - 12, context: "enter" });
    // ASSERTED ON THE KEY SET AS WELL, and the second assertion is not the first one restated:
    // `toEqual` treats a property whose value is `undefined` as absent, so an implementation that
    // wrote `message: undefined` into the returned object would satisfy the line above while still
    // being one careless edit away from writing `raw.message` there instead. The claim is that the
    // key does not exist, so that is what gets checked. Sorted, because the claim is about which keys
    // are there and not about the order `parseError` happens to write them in — a test that failed
    // when somebody swapped two lines of a return statement would be teaching the next person that
    // this file is noise.
    expect(Object.keys(parsed!.keeper.lastError!).sort()).toEqual(["at", "context"]);
  });

  it("rejects the v2 file a deployed keeper really wrote, which is what the bump to 3 was for", () => {
    // The literal 2, for the same reason the v1 case below uses the literal 1: v2 files exist on disk
    // and in browser caches and go on being v2 files forever. A v2 file is a v3 file minus
    // `entriesCloseAt` and `round.heldOpen` — the exact shape that, if the missing fields were
    // defaulted, would have the page draw an hour-long countdown on a lobby that is being held open.
    const raw = rawStatus();
    raw.schema = 2;
    delete raw.entriesCloseAt;
    delete (raw.round as Record<string, unknown>).heldOpen;
    expect(parseKeeperStatus(raw)).toBeNull();
  });

  it("rejects the v1 file a deployed keeper really wrote, which is what the bump to 2 was for", () => {
    // The literal 1, not `KEEPER_STATUS_SCHEMA - 1`: v1 files exist — on disk in `public/`, in any
    // browser cache holding one — and they go on being v1 files forever, whereas `SCHEMA - 1` stops
    // naming them the moment somebody bumps to 3. A v1 file is a v2 file minus `stalledSince`, so it
    // is built that way here: this is the exact shape that, if it were let through with the missing
    // field defaulted, would read to the page as a keeper claiming to be progressing when it never
    // made that claim at all.
    const raw = rawStatus();
    raw.schema = 1;
    delete (raw.keeper as Record<string, unknown>).stalledSince;
    expect(parseKeeperStatus(raw)).toBeNull();
  });

  it("rejects anything that is not a status object at all", () => {
    // The realistic inputs: an SPA fallback serving HTML, an empty file, a truncated write.
    for (const raw of [null, undefined, 1, "keeper-status.json", [], [BASE], {}]) {
      expect(parseKeeperStatus(raw)).toBeNull();
    }
  });

  it("rejects a file missing or mistyping any field the UI will read", () => {
    const broken: Array<(raw: Record<string, unknown>) => void> = [
      (raw) => delete raw.keeper,
      (raw) => delete raw.round,          // absent is NOT the same as an explicit null
      (raw) => delete raw.nextLobbyOpensAt,
      (raw) => delete raw.entriesCloseAt,
      (raw) => (raw.entriesCloseAt = "when someone shows up"),
      // Absent is a writer that never heard of held-open lobbies, whose `lobbyClosesAt` may be an
      // hour of backstop; a string is a writer that answered a different question.
      (raw) => delete (raw.round as Record<string, unknown>).heldOpen,
      (raw) => ((raw.round as Record<string, unknown>).heldOpen = "no"),
      (raw) => ((raw.round as Record<string, unknown>).heldOpen = 0),
      (raw) => ((raw.keeper as Record<string, unknown>).heartbeatAt = "now"),
      (raw) => delete (raw.keeper as Record<string, unknown>).staleAfterSeconds,
      // Absent is a writer that never heard the question, not a keeper saying it is fine; `false` is
      // the writer that read the field as "is it stalled?" and answered the wrong one.
      (raw) => delete (raw.keeper as Record<string, unknown>).stalledSince,
      (raw) => ((raw.keeper as Record<string, unknown>).stalledSince = "yes"),
      (raw) => ((raw.keeper as Record<string, unknown>).stalledSince = false),
      (raw) => ((raw.keeper as Record<string, unknown>).wedgedRounds = ["12"]),
      // A `lastError` with no `context`, carrying instead the one field that stopped counting for
      // anything. It used to be enough to write `{ at: NOW }` here, back when the entry was pinning
      // "half an error object is rejected" against a shape with three required fields; that mutator
      // no longer says which of the missing two did the rejecting. Since `message` is now IGNORED
      // rather than required — see `KeeperError` — an error that has only `at` and `message` is an
      // error with nothing in it the parser reads, and this is the entry that keeps `context`'s
      // absence fatal after somebody has stopped thinking of `message` as a field at all.
      (raw) => ((raw.keeper as Record<string, unknown>).lastError = { at: NOW, message: "boom" }),
      (raw) => ((raw.chain as Record<string, unknown>).cluster = "mainnet-beta"),
      (raw) => ((raw.chain as Record<string, unknown>).erValidator = { identity: "x" }),
      (raw) => ((raw.round as Record<string, unknown>).pot = 4_000_000),
      (raw) => delete (raw.round as Record<string, unknown>).pda,
      (raw) => ((raw.round as Record<string, unknown>).lobbyClosesAt = null),
      (raw) => (raw.nextLobbyOpensAt = "soon"),
    ];
    for (const [i, breakIt] of broken.entries()) {
      const raw = rawStatus();
      breakIt(raw);
      expect(parseKeeperStatus(raw), `case ${i}`).toBeNull();
    }
  });

  it("carries stalledSince through, as an explicit null and as a real timestamp", () => {
    // Null survives the round trip rather than being dropped by `JSON.stringify` or defaulted by the
    // parser, and a real second arrives as the same second — this is the field `isKeeperStalled`
    // reads, so a value that changed in transit would change what the page says about the keeper.
    expect(parseKeeperStatus(rawStatus())?.keeper.stalledSince).toBeNull();
    const raw = rawStatus();
    (raw.keeper as Record<string, unknown>).stalledSince = NOW - 90;
    expect(parseKeeperStatus(raw)?.keeper.stalledSince).toBe(NOW - 90);
  });

  it("carries the two hold-open fields through, as explicit nulls/false and as real values", () => {
    // Both are read by `keeperCountdown` and both have a value that means "draw nothing" — so a value
    // that changed in transit would change what the page says, silently and in the wrong direction.
    expect(parseKeeperStatus(rawStatus())?.entriesCloseAt).toBeNull();
    expect(parseKeeperStatus(rawStatus())?.round?.heldOpen).toBe(false);

    const raw = rawStatus();
    raw.entriesCloseAt = NOW + 18;
    (raw.round as Record<string, unknown>).heldOpen = true;
    expect(parseKeeperStatus(raw)?.entriesCloseAt).toBe(NOW + 18);
    expect(parseKeeperStatus(raw)?.round?.heldOpen).toBe(true);
  });

  it("rejects a round whose phase name and phase code disagree", () => {
    // Two encodings of one fact. Nothing on the page could tell which of them was the true state,
    // and one of them is what somebody will branch on.
    const raw = rawStatus();
    (raw.round as Record<string, unknown>).phaseCode = PHASE_NAME.indexOf("Fight");
    expect(parseKeeperStatus(raw)).toBeNull();
  });

  it("keeps the pot exact, because a u64 does not survive being a JSON number", () => {
    const raw = rawStatus();
    const huge = "18446744073709551615"; // u64::MAX — 2,048 away from itself as a double
    (raw.round as Record<string, unknown>).pot = huge;
    expect(parseKeeperStatus(raw)?.round?.pot).toBe(huge);
    expect(BigInt(parseKeeperStatus(raw)!.round!.pot)).toBe(2n ** 64n - 1n);
  });

  it("rejects a pot that is not a u64, rather than letting BigInt() throw inside a render", () => {
    // `BigInt("")` is a silent zero and `BigInt("$4.00")` throws — both of them at a call site with
    // nothing to catch them, on data that arrived over the network.
    for (const pot of ["", "abc", "-1", "4.5", " 4", "1e6", "18446744073709551616"]) {
      const raw = rawStatus();
      (raw.round as Record<string, unknown>).pot = pot;
      expect(parseKeeperStatus(raw), JSON.stringify(pot)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Out of funds — the fourth state, and the one every other predicate calls healthy
// ---------------------------------------------------------------------------------------------

/** A payer below the keeper's floor. 0.03 SOL against a 0.05 floor, in lamports as the file carries
 *  them — decimal strings, because a lamport count is a u64 and a JSON number would round it. */
const LOW = { since: NOW - 300, lamports: "30000000", floorLamports: "50000000" };

describe("isKeeperOutOfFunds", () => {
  it("is true for a live keeper that has stopped being able to open rounds", () => {
    // The state that made this field necessary: up, heartbeating, loop succeeding on every pass —
    // because refusing to open IS the correct outcome of a pass — and no round will ever come again.
    const s = withKeeper({ lowBalance: LOW });
    expect(isKeeperStale(s, NOW)).toBe(false);
    expect(isKeeperStalled(s, NOW)).toBe(false);
    expect(isKeeperOutOfFunds(s, NOW)).toBe(true);
  });

  it("is false for a funded keeper", () => {
    expect(isKeeperOutOfFunds(BASE, NOW)).toBe(false);
  });

  it("defers to DOWN, because a dead keeper's funding report describes a process that stopped", () => {
    // Same precedence argument as `isKeeperStalled`: "the keeper is down" is both the stronger
    // sentence and the only one still known to be true.
    const s = withKeeper({ lowBalance: LOW, heartbeatAt: NOW - STALE_AFTER - 1 });
    expect(isKeeperStale(s, NOW)).toBe(true);
    expect(isKeeperOutOfFunds(s, NOW)).toBe(false);
  });

  it("defers to STALLED, so the three states stay mutually exclusive", () => {
    // What lets a view branch four ways by asking independent questions in whatever order it writes
    // them, instead of remembering a precedence it has to get right.
    const s = withKeeper({ lowBalance: LOW, stalledSince: NOW - 60 });
    expect(isKeeperStalled(s, NOW)).toBe(true);
    expect(isKeeperOutOfFunds(s, NOW)).toBe(false);
  });
});

describe("keeperCountdown while the arena is out of funds", () => {
  it("refuses to promise a next lobby", () => {
    // THE WHOLE POINT OF THE FIELD. Without it this is a settled round with a next-lobby time beside
    // a perfectly healthy-looking keeper, and the page counts down to a round nothing will open.
    const settled = { ...BASE, round: round({ ...inPhase("Settled") }), nextLobbyOpensAt: NOW + 8 };
    expect(keeperCountdown(settled, NOW)).toEqual({ kind: "next-lobby", seconds: 8 });
    expect(keeperCountdown({ ...settled, keeper: { ...settled.keeper, lowBalance: LOW } }, NOW))
      .toEqual({ kind: "none" });
  });

  it("still counts an in-flight lobby down, because that round IS being finished", () => {
    // The keeper drives a round already in flight to a terminal state whatever the balance says — it
    // refuses to START work it may not finish, not to finish work already started. Blanking this
    // countdown would be its own kind of lie, about a fight that is genuinely about to happen.
    const lobby = { ...BASE, keeper: { ...BASE.keeper, lowBalance: LOW }, entriesCloseAt: NOW + 12 };
    expect(keeperCountdown(lobby, NOW)).toEqual({ kind: "entries-close", seconds: 12 });
  });
});

describe("parsing the funding field", () => {
  it("carries it through as an explicit null and as a real report", () => {
    expect(parseKeeperStatus(rawStatus())!.keeper.lowBalance).toBeNull();
    const raw = rawStatus();
    (raw.keeper as Record<string, unknown>).lowBalance = { ...LOW };
    expect(parseKeeperStatus(raw)!.keeper.lowBalance).toEqual(LOW);
  });

  it("rejects a file that omits it entirely", () => {
    // PRESENT OR MALFORMED, the same rule as `stalledSince`. Reading silence as "funded" would be the
    // reader inventing the one fact that decides whether a countdown may be drawn.
    const raw = rawStatus();
    delete (raw.keeper as Record<string, unknown>).lowBalance;
    expect(parseKeeperStatus(raw)).toBeNull();
  });

  it("rejects amounts that are not u64 strings", () => {
    // Every consumer's next move is `BigInt(...)`, and `BigInt("")` is a silent 0 — which would render
    // as an arena holding nothing, or as a floor nothing could fall below.
    for (const bad of [{ ...LOW, lamports: 30_000_000 }, { ...LOW, lamports: "" }, { ...LOW, floorLamports: "1.5" }]) {
      const raw = rawStatus();
      (raw.keeper as Record<string, unknown>).lowBalance = bad;
      expect(parseKeeperStatus(raw)).toBeNull();
    }
  });
});
