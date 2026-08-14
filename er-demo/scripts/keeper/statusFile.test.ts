// THE COUNTDOWN RULE — the two properties a real run violated, pinned so they cannot come back.
//
// Both were found by sampling `public/keeper-status.json` every two seconds against a live keeper,
// and neither threw anything or failed to parse. That is why they are worth a test: the failure mode
// of this file is a page that draws a confident, wrong number, which no exception and no schema check
// will ever catch.
//
//   ONE — the countdown ran BACKWARDS. Sampled through a single twelve-second result hold:
//   0:11, 0:09, 0:07, 0:05, 0:11, 0:09, 0:07, 0:11 … sawtoothing for about fifty seconds. Every reset
//   is one more observer freshly computing "now + RESULT_HOLD_SECONDS" for a round that had already
//   been promised a time. The whole justification for the result hold is that it is the ONE interval
//   where that number is honest; a clock that jumps backwards is not honest, it is an invented number
//   with extra steps.
//
//   TWO — the file contradicted itself. A sample caught `nextLobbyOpensAt` set beside a round whose
//   published phase still read `Fight`, because the phase snapshot is taken at the top of a pass and
//   the countdown is set during it. `keeperCountdown` happens to ignore a countdown in that phase, so
//   nothing reached a user — but the FILE asserted something untrue, and the next person to read it
//   has no way to know that.
//
// `honestNextLobbyOpensAt` is where both rules live, as a pure function, so both can be checked here
// without a chain, a filesystem or a clock.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { PHASE_NAME, Phase } from "../../src/chain/constants.ts";
import {
  KEEPER_STATUS_SCHEMA, parseKeeperStatus, type KeeperRoundStatus,
} from "../../src/v2/data/keeperStatus.ts";
import {
  createStatusPublisher, honestEntriesCloseAt, honestNextLobbyOpensAt, roundStatusFrom,
  type CountdownLatch,
} from "./statusFile.ts";
import { RESULT_HOLD_SECONDS } from "./config.ts";

const NOW = 1_800_000_000;

/** A publisher writing somewhere harmless. ALWAYS A TEMP DIRECTORY, never `public/`: the status file
 *  is a single-writer resource and there is usually a real keeper running against that path, so a test
 *  taking the default would overwrite a live keeper's status with a fixture and a page watching at
 *  that moment would read a different process's numbers.
 *
 *  `houseOnlyRounds` is a constructor option and cannot be set afterwards — see
 *  `StatusPublisherOptions` — so a test that wants the mode on has to ask for it here, which is the
 *  same shape the keeper's own boot has. */
function publisherInTempDir(houseOnlyRounds = false) {
  const dir = mkdtempSync(join(tmpdir(), "keeper-status-"));
  return createStatusPublisher({
    programId: "Pr0gram11111111111111111111111111111111111",
    arenaPda: "Aren4Pda1111111111111111111111111111111111",
    nowSec: () => NOW,
    houseOnlyRounds,
    filePath: join(dir, "keeper-status.json"),
  });
}

function roundIn(phase: number, no = 7): KeeperRoundStatus {
  return {
    no,
    pda: "R0undPdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    phase: PHASE_NAME[phase]!,
    phaseCode: phase,
    lobbyOpenedAt: NOW - 60,
    lobbyClosesAt: NOW,
    fightStartedAt: NOW + 2,
    fighterCount: 4,
    heldOpen: false,
    winner: 1,
    pot: "4000000",
  };
}

describe("a countdown is only published beside a round that is genuinely holding", () => {
  it("publishes it for a settled round", () => {
    const { at } = honestNextLobbyOpensAt(roundIn(Phase.Settled), NOW + 12, null);
    expect(at).toBe(NOW + 12);
  });

  it("publishes it for an abandoned round, which also holds before the next one opens", () => {
    const { at } = honestNextLobbyOpensAt(roundIn(Phase.Abandoned), NOW + 3, null);
    expect(at).toBe(NOW + 3);
  });

  it("refuses it beside a round still reading Fight, however sure the caller is", () => {
    // The exact contradiction observed live: `resolve` had landed and set the countdown, but the
    // round snapshot in the file was still the pre-resolve read.
    expect(honestNextLobbyOpensAt(roundIn(Phase.Fight), NOW + 11, null).at).toBeNull();
  });

  it("refuses it during Lobby and Drawing too", () => {
    // Lobby has the chain's own `lobby_closes_at`; Drawing has no honest answer at all.
    expect(honestNextLobbyOpensAt(roundIn(Phase.Lobby), NOW + 11, null).at).toBeNull();
    expect(honestNextLobbyOpensAt(roundIn(Phase.Drawing), NOW + 11, null).at).toBeNull();
  });

  it("refuses it when there is no round to attach it to", () => {
    expect(honestNextLobbyOpensAt(null, NOW + 12, null).at).toBeNull();
  });
});

describe("what the keeper writes is what the browser can read", () => {
  // ONE MODULE, BOTH ENDS — checked rather than asserted. `roundStatusFrom` is the writer and
  // `parseKeeperStatus` is the reader, and until now nothing ran the first through the second. A
  // field the writer stops emitting, or emits under a different name, makes the whole file parse as
  // `null` and the page say "keeper down" while the keeper is running perfectly: the exact silent
  // failure both modules are covered in warnings about, with no test standing between them. It costs
  // one JSON round trip to close, and it is what makes adding a field to the contract safe.
  const roundAccount = {
    roundNo: new BN(9),
    phase: Phase.Lobby,
    winner: 0,
    fighterCount: 2,
    pot: new BN("18446744073709551615"), // u64::MAX — the value a JSON number would silently round
    lobbyOpenedAt: new BN(NOW - 30),
    lobbyClosesAt: new BN(NOW + 3_570),
    fightStartedAt: new BN(0),
  } as unknown as Parameters<typeof roundStatusFrom>[0];
  const pda = new PublicKey("11111111111111111111111111111112");

  it("round-trips a held-open round through JSON and the reader's own parser", () => {
    const written = roundStatusFrom(roundAccount, pda, true);
    const document = {
      schema: KEEPER_STATUS_SCHEMA,
      keeper: {
        startedAt: NOW - 60, heartbeatAt: NOW, heartbeatIntervalSeconds: 2, staleAfterSeconds: 15,
        stalledSince: null, roundsCompleted: 0, lastError: null, wedgedRounds: [],
        lowBalance: null, notOpeningRounds: null, houseOnlyRounds: false,
      },
      chain: { cluster: "devnet", programId: "P", arenaPda: "A", erValidator: null },
      round: written,
      entriesCloseAt: NOW + 18,
      nextLobbyOpensAt: null,
    };
    const parsed = parseKeeperStatus(JSON.parse(JSON.stringify(document)) as unknown);
    expect(parsed).not.toBeNull();
    expect(parsed?.round?.heldOpen).toBe(true);
    expect(parsed?.entriesCloseAt).toBe(NOW + 18);
    // The pot survives as a u64 rather than as a double that is 2,048 away from itself.
    expect(BigInt(parsed!.round!.pot)).toBe(2n ** 64n - 1n);
  });

  it("round-trips a lobby that is not held open, so the flag is genuinely carried either way", () => {
    const written = roundStatusFrom(roundAccount, pda, false);
    expect(written.heldOpen).toBe(false);
    expect(JSON.parse(JSON.stringify(written)).heldOpen).toBe(false); // survives, not dropped
  });
});

describe("the keeper's own close time is only published beside a lobby", () => {
  it("publishes it for a round still taking entries", () => {
    expect(honestEntriesCloseAt(roundIn(Phase.Lobby), NOW + 18)).toBe(NOW + 18);
  });

  it("refuses it in every phase where entries are already closed", () => {
    // THE SAME CONTRADICTION `honestNextLobbyOpensAt` WAS WRITTEN FOR, arriving from the other side.
    // The phase snapshot is taken at the top of a pass and the close time is set during it, so the
    // pass that sends the early close can leave the file claiming entries close in eight seconds
    // beside a round already reading `Drawing`. `keeperCountdown` ignores it there — the FILE would
    // still be asserting something untrue, and the next reader has no way to know.
    for (const phase of [Phase.Drawing, Phase.Fight, Phase.Settled, Phase.Abandoned]) {
      expect(honestEntriesCloseAt(roundIn(phase), NOW + 18), PHASE_NAME[phase]).toBeNull();
    }
  });

  it("refuses it when there is no round to attach it to", () => {
    expect(honestEntriesCloseAt(null, NOW + 18)).toBeNull();
  });

  it("passes a null straight through, which is most of a keeper's life", () => {
    // Null is the normal value: nobody has arrived, or the hold-open policy is off entirely.
    expect(honestEntriesCloseAt(roundIn(Phase.Lobby), null)).toBeNull();
  });

  it("does not latch, because the value it is given is already latched upstream", () => {
    // Stated as a test so the absence is deliberate rather than forgotten. `nextLobbyOpensAt` has to
    // be latched because its candidate is recomputed as `now + hold` every pass. This candidate is
    // `firstRealEntryObservedAt + grace`, and that stamp is latched per round in the keeper's
    // timeline — so the same value is proposed on every pass, and a second latch here would guard an
    // invariant that already holds one layer up while hiding a regression in the layer that holds it.
    const round = roundIn(Phase.Lobby);
    for (const pass of [0, 1, 2, 3]) {
      expect(honestEntriesCloseAt(round, NOW + 18), `pass ${pass}`).toBe(NOW + 18);
    }
  });
});

describe("the countdown counts down", () => {
  it("keeps the first time promised for a round, however many passes re-propose one", () => {
    // Six passes through the hold, each one arriving a second later and each one — as an unlatched
    // keeper did — proposing "now + RESULT_HOLD_SECONDS" all over again.
    const round = roundIn(Phase.Settled);
    let latch: CountdownLatch | null = null;
    const published: number[] = [];
    for (let pass = 0; pass < 6; pass++) {
      const now = NOW + pass;
      const decided = honestNextLobbyOpensAt(round, now + RESULT_HOLD_SECONDS, latch);
      latch = decided.latch;
      published.push(decided.at!);
    }
    expect(published).toEqual(Array(6).fill(NOW + RESULT_HOLD_SECONDS));
  });

  it("loses exactly one second per second — the sawtooth, stated as the property", () => {
    // Asserted as an exact ladder rather than as "never increases", because "never increases" is also
    // satisfied by a countdown frozen at 0:12 forever, which is a different lie. What a viewer is owed
    // is a number that tracks the clock: twelve passes, one second apart, counting 12 down to 1.
    const round = roundIn(Phase.Settled);
    let latch: CountdownLatch | null = null;
    const remaining: number[] = [];
    for (let pass = 0; pass < RESULT_HOLD_SECONDS; pass++) {
      const now = NOW + pass;
      const decided = honestNextLobbyOpensAt(round, now + RESULT_HOLD_SECONDS, latch);
      latch = decided.latch;
      remaining.push(decided.at! - now);
    }
    expect(remaining).toEqual(
      Array.from({ length: RESULT_HOLD_SECONDS }, (_, pass) => RESULT_HOLD_SECONDS - pass),
    );
  });

  it("does not carry one round's promise onto the next", () => {
    const first = honestNextLobbyOpensAt(roundIn(Phase.Settled, 7), NOW + 12, null);
    const second = honestNextLobbyOpensAt(roundIn(Phase.Settled, 8), NOW + 40, first.latch);
    expect(second.at).toBe(NOW + 40);
  });

  it("holds the latched time even when the caller proposes nothing", () => {
    // The pass after `close_round` proposes nothing new; the promise already made must survive it.
    const latched = honestNextLobbyOpensAt(roundIn(Phase.Settled), NOW + 12, null);
    expect(honestNextLobbyOpensAt(roundIn(Phase.Settled), null, latched.latch).at).toBe(NOW + 12);
  });

  it("lets the promised time simply pass rather than sliding it later", () => {
    // `close_round` overran the hold. The honest answer is that the time has come and gone —
    // `keeperCountdown` draws nothing once it is in the past — not a promise moved because the keeper
    // was slow, which would be the same lie in the other direction.
    const latched = honestNextLobbyOpensAt(roundIn(Phase.Settled), NOW + 12, null);
    const late = honestNextLobbyOpensAt(roundIn(Phase.Settled), NOW + 45, latched.latch);
    expect(late.at).toBe(NOW + 12);
  });
});

// ---------------------------------------------------------------------------------------------

describe("one serializer, two channels", () => {
  // THE INVARIANT THIS WHOLE MODULE WAS RESHAPED AROUND. The status leaves the process by two routes —
  // the file, and the HTTP body the front end reads in production — and they must be the same bytes.
  // Two serializers over one object is the schema drift the contract module exists to prevent,
  // re-entering one layer down, and it is the hard kind to see: both channels keep working and only
  // DISAGREE, which no exception and no schema check catches.
  //
  // Published to a TEMP DIRECTORY, never to `public/`. The status file is a single-writer resource and
  // there is usually a real keeper running against that path; a test taking the default would
  // overwrite a live keeper's status with a fixture, and a page watching at that moment would read a
  // different process's numbers.

  function publishToTempDir(): { body: string; onDisk: string; path: string } {
    const publisher = publisherInTempDir();
    publisher.setRound(roundIn(Phase.Settled));
    publisher.setNextLobbyOpensAt(NOW + RESULT_HOLD_SECONDS);
    publisher.publish();
    const { path } = publisher;
    return { body: publisher.body(), onDisk: readFileSync(path, "utf8"), path };
  }

  it("hands the HTTP body and the file byte-identical payloads", () => {
    const { body, onDisk } = publishToTempDir();
    expect(body).toBe(onDisk);
  });

  it("publishes a payload the front end's own parser accepts", () => {
    // The serializer's real contract is not "valid JSON", it is "a status `parseKeeperStatus` returns
    // an object for". A payload that parses as JSON and then as `null` is the exact failure this file
    // is about: the page says "keeper is down" while the keeper runs perfectly.
    const { body } = publishToTempDir();
    const parsed = parseKeeperStatus(JSON.parse(body));
    expect(parsed).not.toBeNull();
    expect(parsed!.nextLobbyOpensAt).toBe(NOW + RESULT_HOLD_SECONDS);
  });

  it("keeps the HTTP body advancing when the file write fails", () => {
    // THE PROPERTY `publishSafely` WAS RESTRUCTURED FOR, and the only one of the three that is about
    // the two channels failing INDEPENDENTLY. The render happens outside the try/catch, so a full
    // disk, a read-only container filesystem or a `public/` that does not exist in the image cannot
    // freeze the payload a browser is reading — and in production the file is the channel nobody
    // reads. Pointed at a path inside a file (so every write fails with ENOTDIR), the publisher must
    // keep running and its body must still move.
    const dir = mkdtempSync(join(tmpdir(), "keeper-status-"));
    const notADirectory = join(dir, "keeper-status.json");
    writeFileSync(notADirectory, "not a directory");
    const publisher = createStatusPublisher({
      programId: "Pr0gram11111111111111111111111111111111111",
      arenaPda: "Aren4Pda1111111111111111111111111111111111",
      nowSec: () => NOW,
      houseOnlyRounds: false,
      filePath: join(notADirectory, "keeper-status.json"),
    });

    publisher.setRoundsCompleted(1);
    expect(() => publisher.publish()).not.toThrow();
    const first = publisher.body();
    publisher.setRoundsCompleted(2);
    publisher.publish();

    expect(first).not.toBe(publisher.body());
    expect(parseKeeperStatus(JSON.parse(publisher.body()))!.keeper.roundsCompleted).toBe(2);
  });

  it("has a body to serve before anything has been published", () => {
    // The HTTP server starts before the first loop pass, so a request — a platform health check, most
    // likely — can arrive while the keeper is still choosing a validator. It must get a real status
    // with an honest boot-instant heartbeat, not an empty body some reader has to have a case for.
    const publisher = publisherInTempDir();
    const parsed = parseKeeperStatus(JSON.parse(publisher.body()));
    expect(parsed).not.toBeNull();
    expect(parsed!.keeper.heartbeatAt).toBe(NOW);
    expect(publisher.heartbeatAgeSeconds()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the published status identifies none of the arena's own wallets", () => {
  // WHY THIS IS ASSERTED OVER THE SERIALIZED BYTES RATHER THAN FIELD BY FIELD, which is the unusual
  // choice here and the whole reason the block exists.
  //
  // The FIELDS are already the compiler's job and it does that job better than a test could:
  // `KeeperStatus` has no `house` and `KeeperRoundStatus` has no `houseFighterCount`, so a line
  // putting either back does not compile, and no assertion is going to beat that. Writing a test for
  // it would be writing a test for the type checker.
  //
  // The leak this guards is the OTHER one, which the type system cannot see: some future field
  // carrying the same fact under a name with no "house" in it. That is not hypothetical — it is
  // exactly what happened. `keeper.lastError.message` was `describeError(e)`, arbitrary text written
  // by libraries, the RPC and the chain, published to every browser and rendered by nothing; a house
  // `enter` that fails throws an exception with one of the arena's own wallets inside it, and a
  // sampled status file had precisely that in it. Every field-by-field assertion anyone had written
  // passed throughout, because `message` was not a field anybody thought to check. Only the bytes
  // catch that, because the bytes are the thing that actually reaches the browser and they do not
  // care what the leaking field is called.
  //
  // NOT VACUOUS, WHICH IS THE FAILURE MODE OF EVERY INVERTED TEST: an assertion that a string does
  // not contain something passes beautifully against an empty string. So each case below proves the
  // payload is real first — it parses, and it carries the round and the state the case put into it —
  // and only then checks what is absent.

  /** Stand-ins for the bank, in the shape the classifier actually holds: base58, 32-byte-ish, the
   *  thing that would appear verbatim in a leak. */
  const BANK = [
    "H0use11111111111111111111111111111111111111",
    "H0use22222222222222222222222222222222222222",
    "H0use33333333333333333333333333333333333333",
  ];

  /** Every absence, in one place, so a new case cannot check three of the four by accident. */
  function expectNothingIdentifying(body: string): void {
    // THE WORD, WITH ONE DECLARED EXCEPTION — and the exception is why this is no longer a flat
    // `not.toMatch(/house/i)`. Schema 6 publishes `keeper.houseOnlyRounds`, a boolean copied from a
    // boot flag: no wallet, no count, no input of any kind, and the identical byte on the round that
    // is all house and the round a real player just won. The blanket check would fail on the field
    // name alone, and both of the easy ways out are worse than this one. Deleting the check gives up
    // the vocabulary net that catches a leak arriving under a name nobody thought of. Stripping the
    // field out of the body before matching hides anything a future leak happens to sit beside. So
    // every occurrence of the word is ENUMERATED and each one has to be the field that was argued for
    // by name — a second `house*` key in this payload fails here, which is the review the next
    // disclosure should have to pass rather than a check somebody quietly relaxes again.
    const houseWords = body.match(/[A-Za-z]*house[A-Za-z]*/gi) ?? [];
    expect([...new Set(houseWords)].filter((w) => w !== "houseOnlyRounds")).toEqual([]);
    expect(body).not.toMatch(/disclos/i);
    // The removed field names specifically, because a writer re-adding one under the old spelling is
    // the most likely single regression and it should fail with an obvious message.
    expect(body).not.toContain("realFighterCount");
    expect(body).not.toContain("houseFighterCount");
    // AND THE PUBKEYS THEMSELVES, which is the assertion that actually matters. The three above are
    // about vocabulary and could all pass while a field called `participants` carried the bank.
    for (const wallet of BANK) expect(body).not.toContain(wallet);
  }

  it("publishes nothing that identifies the arena's own wallets", () => {
    const publisher = publisherInTempDir();
    publisher.setRound(roundIn(Phase.Lobby));
    publisher.setEntriesCloseAt(NOW + 18);
    publisher.publish();

    const body = publisher.body();
    // Real first — see the block comment. A payload that failed to parse would satisfy every
    // assertion below while proving nothing at all.
    const parsed = parseKeeperStatus(JSON.parse(body));
    expect(parsed).not.toBeNull();
    expect(parsed!.round!.fighterCount).toBe(4);
    expectNothingIdentifying(body);
  });

  it("publishes nothing identifying after an entry fill has failed", () => {
    // THE CASE THAT WOULD HAVE CAUGHT THE REAL LEAK. `lastError` used to interpolate the house entry
    // count and the exception text into a published string; the failure path is therefore the one
    // where the payload is most likely to start carrying something it should not, and it is the path
    // a happy-path fixture never visits.
    const publisher = publisherInTempDir();
    publisher.setRound(roundIn(Phase.Lobby));
    publisher.setLastError({ at: NOW, context: "entry-fill" });
    publisher.publish();

    const body = publisher.body();
    const parsed = parseKeeperStatus(JSON.parse(body));
    expect(parsed).not.toBeNull();
    // The error genuinely reached the payload — without this the absences below are vacuous, because
    // a `setLastError` that silently did nothing would pass every one of them.
    expect(parsed!.keeper.lastError).toEqual({ at: NOW, context: "entry-fill" });
    expectNothingIdentifying(body);
  });

  it("carries no exception text at all, whatever the context is called", () => {
    // The complement of the case above, and the stronger statement: the guarantee is not "the message
    // is sanitised", it is "there is no message". A field with no inputs cannot be got wrong, which is
    // why a closed vocabulary was chosen over a filter — see `recordError` in keeper.ts.
    const publisher = publisherInTempDir();
    publisher.setLastError({ at: NOW, context: "main-loop" });
    publisher.publish();

    const raw = JSON.parse(publisher.body()) as { keeper: { lastError: Record<string, unknown> } };
    expect(Object.keys(raw.keeper.lastError).sort()).toEqual(["at", "context"]);
  });

  it("publishes nothing identifying in the states a keeper spends its bad days in", () => {
    // Every optional branch of the payload at once — stalled, out of funds, wedged rounds, a settled
    // round with a winner. These are the fields added latest and therefore the ones with the least
    // scrutiny behind them, and a status file is at its longest here.
    const publisher = publisherInTempDir();
    publisher.setRound(roundIn(Phase.Settled));
    publisher.setErValidator({ identity: "Val1dat0r111111111111111111111111111111111", fqdn: "er.example" });
    publisher.setStalledSince(NOW - 300);
    publisher.setLowBalance({ lamports: 1n, floorLamports: 2n, nowSec: NOW });
    publisher.addWedgedRound(4);
    publisher.setRoundsCompleted(11);
    publisher.publish();

    const body = publisher.body();
    const parsed = parseKeeperStatus(JSON.parse(body));
    expect(parsed).not.toBeNull();
    expect(parsed!.keeper.stalledSince).toBe(NOW - 300);
    expect(parsed!.keeper.lowBalance).not.toBeNull();
    expect(parsed!.keeper.wedgedRounds).toEqual([4]);
    expectNothingIdentifying(body);
  });

  // EVERY REASON, NOT A REPRESENTATIVE ONE. The sweep below is over serialized BYTES precisely
  // because it catches leaks arriving through a field nobody thought to check, and "nobody thought to
  // check it" is the state of every reason that was not the one the test happened to name. Kept as a
  // literal list rather than imported: `NOT_OPENING_REASONS` is private to `keeperStatus.ts`, and a
  // test that reads the same list the code reads asserts only that one list equals itself.
  for (const reason of ["low-balance", "rent-not-reclaimed", "rent-not-swept"] as const) {
    it(`publishes nothing identifying with the house-only mode ON and the keeper stopped: ${reason}`, () => {
      // THE CASE THAT PROVES THE DISCLOSURE DID NOT SMUGGLE ANYTHING IN BEHIND IT. Schema 6 puts a
      // field with "house" in its name into a payload that was emptied of the house on purpose, and
      // the argument for it is that the field is a literal from a boot flag with no inputs. An
      // argument is not a guarantee; this is where it gets checked against the bytes.
      //
      // Everything that could plausibly travel WITH the mode is turned on at once — the flag, a
      // stopped keeper, its funding detail, a lobby the arena is standing in by itself — because the
      // leak this whole block exists for is the one that arrives through a field nobody thought of,
      // and these are the newest fields in the file.
      //
      // `"rent-not-swept"` IS THE ONE THIS PARAMETRISATION WAS ADDED FOR. It is the first reason
      // whose EMISSION is decided by a number observed on chain — the gap between
      // `Arena.round_counter` and `Treasury.rounds_swept` — so it is exactly the shape of thing this
      // header warns about. It is safe because the observation selects BETWEEN literals and never
      // enters one, and that claim is worth no more than the bytes it is checked against.
      const publisher = publisherInTempDir(true);
      publisher.setRound(roundIn(Phase.Lobby));
      publisher.setNotOpeningRounds(reason);
      publisher.setLowBalance({ lamports: 1n, floorLamports: 2n, nowSec: NOW });
      publisher.publish();

      const body = publisher.body();
      const parsed = parseKeeperStatus(JSON.parse(body));
      expect(parsed).not.toBeNull();
      // Real first, and here that means the disclosure genuinely reached the payload: a publisher
      // that silently dropped the flag would satisfy every absence below while publishing nothing at
      // all.
      expect(parsed!.keeper.houseOnlyRounds).toBe(true);
      expect(parsed!.keeper.notOpeningRounds).toBe(reason);
      expectNothingIdentifying(body);
    });
  }

  it("publishes the same mode byte whoever is standing in the round", () => {
    // THE PROPERTY THE FIELD IS DEFENDED ON, over the bytes rather than over the parsed object: it
    // carries no information about any particular round. The house-only keeper mid-fill and the same
    // keeper with a real player in the lobby publish payloads that differ ONLY where the chain's own
    // `fighterCount` differs — so no reader can work backwards from the flag to who is in the room.
    function bodyWith(fighterCount: number): string {
      const publisher = publisherInTempDir(true);
      publisher.setRound({ ...roundIn(Phase.Lobby), fighterCount });
      publisher.publish();
      return publisher.body();
    }
    const houseOnly = bodyWith(48);
    const withPlayer = bodyWith(49);
    expect(houseOnly.replace('"fighterCount": 48', '"fighterCount": 49')).toBe(withPlayer);
    // Not vacuous: the two really were different bodies before that one substitution.
    expect(houseOnly).not.toBe(withPlayer);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the mode and the reason, as the writer publishes them", () => {
  function parsedBodyOf(publisher: ReturnType<typeof publisherInTempDir>) {
    publisher.publish();
    const parsed = parseKeeperStatus(JSON.parse(publisher.body()));
    expect(parsed).not.toBeNull();
    return parsed!;
  }

  it("carries the mode through JSON and the reader's own parser, in both values", () => {
    // ONE MODULE, BOTH ENDS. A boolean the writer emits and the reader drops is a page that says
    // nothing while the keeper plays itself in public — and it fails silently in exactly that
    // direction, because `false` and "field missing" render identically once the parser has defaulted
    // one to the other. (It does not: the parser rejects the file. This is what proves the writer
    // gives it something to accept.)
    expect(parsedBodyOf(publisherInTempDir(true)).keeper.houseOnlyRounds).toBe(true);
    expect(parsedBodyOf(publisherInTempDir(false)).keeper.houseOnlyRounds).toBe(false);
  });

  it("carries each reason through, and back to null when the keeper starts opening again", () => {
    const publisher = publisherInTempDir();
    expect(parsedBodyOf(publisher).keeper.notOpeningRounds).toBeNull();
    // EVERY MEMBER OF THE VOCABULARY, because the failure of missing one is not a missing test — it
    // is a reason the writer can emit and the reader refuses, which takes the WHOLE file to null and
    // puts "keeper is down" on the page at the exact moment the keeper is trying to say why it
    // stopped. `NotOpeningReason` is now read off `NOT_OPENING_REASONS` so the writer and the parser
    // cannot drift; this is what proves the pair actually survives a round trip.
    for (const reason of ["low-balance", "rent-not-reclaimed", "rent-not-swept"] as const) {
      publisher.setNotOpeningRounds(reason);
      expect(parsedBodyOf(publisher).keeper.notOpeningRounds, reason).toBe(reason);
    }
    // The clear is half the field: a brake that trips and never releases would leave the page saying
    // no round is coming for the rest of the process's life.
    publisher.setNotOpeningRounds(null);
    expect(parsedBodyOf(publisher).keeper.notOpeningRounds).toBeNull();
  });

  it("keeps the funding report and the reason independent, so the call site decides which is which", () => {
    // THE CONSISTENCY THIS FILE IS ASKED TO PIN, and it is pinned as an INDEPENDENCE rather than as an
    // implication, because the implication is the thing that must not be built. `setLowBalance` does
    // not set the reason: if it did, `"low-balance"` would become the published explanation for a
    // keeper stopped by the burn brake with a perfectly healthy payer — a wrong incident report,
    // arriving by inference, at the one moment somebody is reading the file to find out what broke.
    const publisher = publisherInTempDir();
    publisher.setLowBalance({ lamports: 1n, floorLamports: 2n, nowSec: NOW });
    const detailOnly = parsedBodyOf(publisher);
    expect(detailOnly.keeper.lowBalance).not.toBeNull();
    expect(detailOnly.keeper.notOpeningRounds).toBeNull();

    // And the reverse: the burn brake trips with the payer well above its floor, which is precisely
    // the state schema 4 could not express and the reason the field was hoisted out of the detail
    // block.
    const braked = publisherInTempDir();
    braked.setNotOpeningRounds("rent-not-reclaimed");
    const reasonOnly = parsedBodyOf(braked);
    expect(reasonOnly.keeper.lowBalance).toBeNull();
    expect(reasonOnly.keeper.notOpeningRounds).toBe("rent-not-reclaimed");

    // What the KEEPER does — both, in the pass that knows both — is the pairing the page reads: one
    // field that stops the countdown, one that says how much to send.
    publisher.setNotOpeningRounds("low-balance");
    const paired = parsedBodyOf(publisher);
    expect(paired.keeper.notOpeningRounds).toBe("low-balance");
    expect(paired.keeper.lowBalance?.floorLamports).toBe("2");
  });
});
