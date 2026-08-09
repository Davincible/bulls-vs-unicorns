// Whether the page is allowed to promise a player that another round is coming.
//
// Every test here is about the same failure: a number on screen that nothing is backing. The keeper
// status file is the only thing that can back one, so these check the three ways it can fail to — by
// being unreadable (`parseKeeperStatus`), by being OLD (`isKeeperStale`), and by being written by a
// keeper that is up and no longer getting anywhere (`isKeeperStalled`) — and then check that
// `keeperCountdown` says nothing in each of the seven situations where there is genuinely nothing to
// say. The last two are the interesting cases throughout, because their files still look perfectly
// healthy: well-formed, a lobby deadline comfortably in the future, and written either by a process
// that stopped running four minutes ago or by one whose every pass has thrown since.
//
// All fixtures come off ONE base object, so a field added to the contract is added in one place.
// Phases are set through `inPhase()` rather than by hand, because a fixture whose `phase` and
// `phaseCode` disagreed would be testing the parser's rejection path by accident.

import { describe, expect, it } from "vitest";
import { PHASE_NAME } from "../../chain/constants.ts";
import {
  KEEPER_STATUS_SCHEMA,
  isHouseWallet,
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
const HOUSE_WALLET = "H0useWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const BASE_ROUND: KeeperRoundStatus = {
  no: 7,
  pda: "R0undPdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  phase: "Lobby",
  phaseCode: 0,
  lobbyOpenedAt: NOW - 30,
  lobbyClosesAt: NOW + 30,
  fightStartedAt: 0,
  fighterCount: 4,
  houseFighterCount: 4,
  realFighterCount: 0,
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
  },
  chain: {
    cluster: "devnet",
    programId: "CH7K8rDXgPQRs9CCHG9EK5kd1YSDZyPkCDGArcz4PSNP",
    arenaPda: "ArenaPdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    erValidator: { identity: "Va1idat0rAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", fqdn: "devnet.magicblock.app" },
  },
  round: BASE_ROUND,
  nextLobbyOpensAt: null,
  house: { wallets: [HOUSE_WALLET], disclosure: "House-operated fighters, disclosed per README." },
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
      if (c.kind === "none") continue;
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
      (raw) => delete raw.house,
      (raw) => delete raw.round,          // absent is NOT the same as an explicit null
      (raw) => delete raw.nextLobbyOpensAt,
      (raw) => ((raw.keeper as Record<string, unknown>).heartbeatAt = "now"),
      (raw) => delete (raw.keeper as Record<string, unknown>).staleAfterSeconds,
      // Absent is a writer that never heard the question, not a keeper saying it is fine; `false` is
      // the writer that read the field as "is it stalled?" and answered the wrong one.
      (raw) => delete (raw.keeper as Record<string, unknown>).stalledSince,
      (raw) => ((raw.keeper as Record<string, unknown>).stalledSince = "yes"),
      (raw) => ((raw.keeper as Record<string, unknown>).stalledSince = false),
      (raw) => ((raw.keeper as Record<string, unknown>).wedgedRounds = ["12"]),
      (raw) => ((raw.keeper as Record<string, unknown>).lastError = { at: NOW }),
      (raw) => ((raw.chain as Record<string, unknown>).cluster = "mainnet-beta"),
      (raw) => ((raw.chain as Record<string, unknown>).erValidator = { identity: "x" }),
      (raw) => ((raw.round as Record<string, unknown>).pot = 4_000_000),
      (raw) => delete (raw.round as Record<string, unknown>).pda,
      (raw) => ((raw.round as Record<string, unknown>).lobbyClosesAt = null),
      (raw) => ((raw.house as Record<string, unknown>).wallets = HOUSE_WALLET),
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

describe("isHouseWallet", () => {
  it("marks the keeper's own fighters and nobody else's", () => {
    // A false negative here is an undisclosed bot in a list of players, which README.md's "Bot
    // disclosure in UI" exists to prevent.
    expect(isHouseWallet(BASE, HOUSE_WALLET)).toBe(true);
    expect(isHouseWallet(BASE, "P1ayerWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    // Base58 is case-sensitive, and so is this.
    expect(isHouseWallet(BASE, HOUSE_WALLET.toLowerCase())).toBe(false);
  });

  it("marks nobody when there is no status to mark them from", () => {
    // No keeper means no disclosure list, which is the honest answer — not a claim that every
    // fighter on screen is human.
    expect(isHouseWallet(null, HOUSE_WALLET)).toBe(false);
  });
});
