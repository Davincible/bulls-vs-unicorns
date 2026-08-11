// `?links=mock` MUST NOT BE A BYPASS — that is the whole claim this file checks.
//
// Stage 0 exists so the identity feature can be reviewed end to end with no backend, no secrets and
// no X account. That is only worth building if the mock exercises the REAL path: if `?links=mock`
// short-circuited verification, the first commit would ship an unverified route to a face, which is
// precisely the defect `xLink.ts`'s header describes (a typed handle putting a real person's name and
// photograph on your fighter). A bypass would also be invisible — a board full of mock faces looks
// identical whether the signatures were checked or waved through.
//
// So the load-bearing test here is the one that takes `mockAttestations`' output and puts it through
// the production `verifyAttestation` against `trustedKeysFor("mock")`, and the one beside it that
// puts the same output against `trustedKeysFor("api")` and demands a refusal. The published seed
// signs faces into the browser that asked for them and nowhere else.
//
// The rest divides in two:
//
//   * `parseMockFixture` DROPS rather than throws. The fixture is hand-editable by design, so a typo
//     must cost one face and not the page — a throw here happens inside a poll and takes the round's
//     entire link map with it.
//   * `assignMockIdentities` produces a state the real system could actually produce. One X account
//     belongs to exactly one wallet (a unique index on `x_id` in the schema), so a fixture showing
//     `@mock_otter` on two fighters would show something impossible, and somebody would eventually
//     spend an afternoon debugging it as if it were real. And the board must be a MIX — not everybody
//     and not nobody — because `TWITTER-CONNECT.md` §8.3 says the mix is where a row layout that
//     silently assumed an avatar column falls apart, and it is also the honest picture: most players
//     will never link.
//
// The committed `public/links.mock.json` is read off disk and run through the same pipeline, because
// a regenerated fixture that stopped verifying would render an unlinked board — which is exactly what
// a correctly-working unlinked board looks like.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assignMockIdentities, mockAttestations, parseMockFixture, type MockIdentity } from "./mockLinks.ts";
import { trustedKeysFor } from "./linkSource.ts";
import { MOCK_HISTORY, MOCK_YOU, mockFightersAt } from "./mockData.ts";
import { deriveStandings } from "./roundLog.ts";
import { rosterCast, rosterKey } from "./useLinks.ts";
import {
  ATTESTATION_TTL_SECONDS,
  avatarPathFor,
  identityText,
  linkMapFrom,
  verifyAttestation,
} from "./xLink.ts";
import { attestationKeyFrom } from "./xLinkSign.ts";
import { sha256 } from "@noble/hashes/sha256";

const NOW = 1_800_000_000;
const MOCK_KEYS = trustedKeysFor("mock");

/** Base58, 44 characters, distinct per index. The alphabet excludes `0`, `O`, `I` and `l`, which
 *  `verifyAttestation` enforces — a wallet spelled with them would be rejected as `bad-wallet` and
 *  every assertion below would pass for the wrong reason. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const walletAt = (i: number) =>
  `Wa11et${B58[Math.floor(i / 58) % 58]}${B58[i % 58]}`.padEnd(44, "q");
const roster = (n: number) => Array.from({ length: n }, (_, i) => walletAt(i));

/** A synthetic identity pool, larger than the committed one, so the assignment rules are exercised
 *  against supply that does not run out. */
const identities = (n: number): MockIdentity[] =>
  Array.from({ length: n }, (_, i) => ({
    xId: `9990000000000${String(100 + i)}`,
    handle: `mock_${B58[Math.floor(i / 58) % 58]}${B58[i % 58]}`,
    displayName: `Mock ${i}`,
    avatarHash: "a".repeat(64),
  }));

const ONE: MockIdentity = {
  xId: "9990000000000001",
  handle: "mock_kestrel",
  displayName: "Kestrel",
  avatarHash: "e".repeat(64),
};

describe("parseMockFixture", () => {
  it("reads the committed shape", () => {
    expect(parseMockFixture({ identities: [ONE] })).toEqual([ONE]);
  });

  it("returns nothing rather than throwing for a body that is not a fixture at all", () => {
    // This runs on a `fetch().json()` result. A 404 page, a proxy's HTML error, a truncated file — a
    // throw here is inside the poll in `useLinks.ts` and would be caught and logged, but only after
    // the whole round lost its links. Nothing is a complete, correct answer; an exception is not.
    for (const junk of [null, undefined, 42, "a string", true, [], [ONE]]) {
      expect(parseMockFixture(junk), JSON.stringify(junk) ?? "undefined").toEqual([]);
    }
  });

  it("returns nothing when `identities` is missing or is not a list", () => {
    expect(parseMockFixture({})).toEqual([]);
    expect(parseMockFixture({ note: "only a note" })).toEqual([]);
    expect(parseMockFixture({ identities: null })).toEqual([]);
    expect(parseMockFixture({ identities: "mock_kestrel" })).toEqual([]);
    expect(parseMockFixture({ identities: { 0: ONE } })).toEqual([]);
  });

  it("returns nothing for an empty list, which is a legitimate fixture", () => {
    // "Nobody is linked" is a layout `TWITTER-CONNECT.md` §8.3 asks for explicitly, and it must be
    // reachable by emptying the file rather than only by deleting the flag.
    expect(parseMockFixture({ identities: [] })).toEqual([]);
  });

  it("drops a malformed row and keeps the rows around it", () => {
    // THE POINT OF DROPPING. This file is edited by hand; a missing quote costs one face, not six.
    const other: MockIdentity = { ...ONE, xId: "9990000000000002", handle: "mock_otter" };
    const parsed = parseMockFixture({
      identities: [
        ONE,
        null,
        42,
        "mock_shrike",
        [],
        { handle: "mock_novole" }, // no xId
        { xId: "9990000000000003" }, // no handle
        { ...ONE, xId: 999 }, // an xId as a number, which JSON permits and the wire format does not
        { ...ONE, handle: null },
        { ...ONE, displayName: undefined },
        { ...ONE, avatarHash: 12 },
        other,
      ],
    });
    expect(parsed).toEqual([ONE, other]);
  });

  it("keeps the two rows whose fields are deliberately empty", () => {
    // `displayName: ""` is "this X account has no display name" and `avatarHash: ""` is "linked, but
    // the picture has not arrived" — both real states, both rungs on §7.3's failure ladder, and both
    // the reason the fixture has six rows rather than four. A parser that treated empty as malformed
    // would silently delete exactly the two cases the fixture exists to put on screen.
    const noName: MockIdentity = { ...ONE, displayName: "" };
    const noPicture: MockIdentity = { ...ONE, xId: "9990000000000006", avatarHash: "" };
    expect(parseMockFixture({ identities: [noName, noPicture] })).toEqual([noName, noPicture]);
  });

  it("ignores fields it was not asked about", () => {
    // The fixture carries a `note`, and a regenerator may add more. Extra keys are not corruption.
    expect(parseMockFixture({ identities: [{ ...ONE, colour: "#f0f", seed: 7 }] })).toEqual([ONE]);
  });
});

describe("assignMockIdentities", () => {
  it("always links `you` when you are in the round", () => {
    // The single most useful thing this flag does for a developer is show them the linked state of
    // their OWN wallet panel and their own disc. Asserted over thirty different wallets rather than
    // one, because one wallet that happens to pass the one-in-three rate check would prove nothing —
    // it is the wallets that FAIL that check which the `you` rule exists for.
    const wallets = roster(30);
    for (const you of wallets) {
      const assigned = assignMockIdentities(identities(20), wallets, you);
      expect(assigned.has(you), you).toBe(true);
    }
  });

  it("never links a wallet that is not in the round", () => {
    // Including `you` when the connected wallet is not a fighter — a spectator's own panel is linked
    // by `useLinks`, but the round's map must only ever key wallets that are on screen.
    const wallets = roster(20);
    const stranger = walletAt(999);
    const assigned = assignMockIdentities(identities(20), wallets, stranger);
    expect(assigned.has(stranger)).toBe(false);
    for (const key of assigned.keys()) expect(wallets, key).toContain(key);
  });

  it("never uses one X identity twice", () => {
    // An X account belongs to exactly one wallet — a unique index on `x_id` in the schema, and half
    // the reason the store is keyed on it. A fixture that put one handle on two fighters would be
    // showing a state the real system cannot produce.
    const wallets = roster(40);
    const assigned = assignMockIdentities(identities(20), wallets, wallets[0]);
    const used = [...assigned.values()];
    expect(new Set(used.map((i) => i.xId)).size).toBe(used.length);
    expect(new Set(used.map((i) => i.handle)).size).toBe(used.length);
  });

  it("is deterministic for the same wallets in the same order", () => {
    // Two screenshots of the same round have to be comparable. The mechanism used to be an internal
    // sort — the assignment depended on the SET and nothing else — and it is now the caller handing
    // over the same list twice, which `ArenaProvider` does by composing it from `[round, you,
    // standings]` (all three module constants under `?fixture=1`). What must not change is the
    // guarantee: same input, same faces, every reload.
    const wallets = roster(24);
    const you = wallets[3];
    const a = [...assignMockIdentities(identities(20), wallets, you)];
    const b = [...assignMockIdentities(identities(20), wallets, you)];
    expect(b).toEqual(a);
    // And it does not mutate what it was handed. The list is derived from `live.fighters`, where
    // positional ids name the parties in every hit event, so a sort applied in place here would
    // silently repoint the whole fight.
    const untouched = roster(24);
    const before = [...untouched];
    assignMockIdentities(identities(20), untouched, untouched[3]);
    expect(untouched).toEqual(before);
  });

  it("walks the wallets in the ORDER GIVEN, because the caller's order is the priority", () => {
    // THE PROPERTY THIS FUNCTION WAS REWRITTEN FOR. The caller composes `[the round on screen, you,
    // the leaderboard's rows]` and the identities are scarce — six of them, against a capped
    // fifty-two — so whoever is at the front of the list is who the fixture is about. Walking a
    // base58-sorted list instead spends the cast on whatever sorts lowest, which is an accident
    // rather than a decision, and the arena screen loses its faces (see this function's doc).
    //
    // Asserted as "the front of the list wins", which is the property, rather than by pinning the
    // stride's exact indices — the stride is a rate and may legitimately move.
    const wallets = roster(40);
    const front = wallets.slice(0, 6);
    const assigned = assignMockIdentities(identities(3), wallets, null);
    for (const w of assigned.keys()) expect(front, w).toContain(w);
    // Reversing the list is a DIFFERENT request, not the same one shuffled: it says a different set
    // of wallets matters most, and the answer follows it.
    const reversed = assignMockIdentities(identities(3), [...wallets].reverse(), null);
    expect([...reversed.keys()]).not.toEqual([...assigned.keys()]);
    for (const w of reversed.keys()) expect(wallets.slice(-6), w).toContain(w);
  });

  it("cannot lose the front of the list to a re-ordered tail", () => {
    // WHY THE DROPPED SORT COSTS LESS THAN IT LOOKS. On the chain path the tail of the caller's list
    // is the leaderboard, and `deriveStandings` ranks by pnl — so a settling round can re-order those
    // rows without changing the wallet set, and with no internal sort the assignment is free to move.
    // It may only move THERE. Identities are spent from index zero, so a prefix's assignment is
    // decided entirely by that prefix, and the round on screen is the prefix.
    const round = roster(9);
    const tail = Array.from({ length: 30 }, (_, i) => walletAt(100 + i));
    const a = assignMockIdentities(identities(20), [...round, ...tail], round[0]);
    const b = assignMockIdentities(identities(20), [...round, ...[...tail].reverse()], round[0]);
    const onRound = (m: ReadonlyMap<string, MockIdentity>) =>
      [...m].filter(([w]) => round.includes(w));
    expect(onRound(b)).toEqual(onRound(a));
    expect(onRound(a).length).toBeGreaterThan(1);
  });

  it("produces a genuine mix — not everybody, not nobody", () => {
    // §8.3: "the mix is where a row layout that silently assumed an avatar column falls apart", and a
    // rate of 1 (everybody) or 20 (nobody) would quietly stop producing the one board worth
    // reviewing. The band is deliberately wide because the hash is `contract.ts#nameFor`'s and may
    // legitimately change; what must not change is that both kinds of fighter are on screen.
    const wallets = roster(60);
    const pool = identities(60);
    const assigned = assignMockIdentities(pool, wallets, null);
    expect(assigned.size).toBeGreaterThan(5);
    expect(assigned.size).toBeLessThan(55);
    // And the unlinked ones were SKIPPED, not starved. Supply equals demand here, so every wallet
    // without a face was passed over while an identity was still on the shelf — which is what makes
    // the mix a property of the rate rather than of a short fixture.
    expect(pool.length - assigned.size).toBeGreaterThan(0);
    expect(wallets.length - assigned.size).toBeGreaterThan(0);
  });

  it("stops cleanly when the identities run out", () => {
    // Six identities and a full 48-fighter lobby is the realistic case, and `remaining.shift()` on an
    // empty array yields `undefined` — which would be signed, and would reach `verifyAttestation` as
    // a crash rather than a rejection.
    const wallets = roster(48);
    const assigned = assignMockIdentities(identities(2), wallets, wallets[0]);
    expect(assigned.size).toBeLessThanOrEqual(2);
    for (const [w, id] of assigned) {
      expect(id, w).toBeDefined();
      expect(typeof id.handle, w).toBe("string");
    }
  });

  it("links nobody when the fixture is empty, even for `you`", () => {
    const wallets = roster(10);
    expect(assignMockIdentities([], wallets, wallets[0]).size).toBe(0);
  });

  it("links nobody when the round is empty", () => {
    expect(assignMockIdentities(identities(6), [], null).size).toBe(0);
  });

  it("gives nobody a special place when there is no connected wallet", () => {
    // A spectator with no wallet is the default visitor. The assignment must still be a mix, and must
    // still be the same one for the same roster.
    const wallets = roster(24);
    const a = assignMockIdentities(identities(20), wallets, null);
    expect(a.size).toBeGreaterThan(0);
    expect([...assignMockIdentities(identities(20), wallets, null)]).toEqual([...a]);
  });
});

describe("mockAttestations", () => {
  const wallets = roster(24);
  const you = wallets[0];

  it("produces records that verify through the REAL verifier against the mock key", () => {
    // THE MOST IMPORTANT TEST IN THIS FILE. `?links=mock` runs `verifyAttestation` — the same
    // canonical bytes, the same expiry check, the same same-origin path check, the same branded mint —
    // and every fixture record has to survive it. If this ever passes vacuously (zero attestations),
    // the count assertion below is what says so.
    const out = mockAttestations(identities(20), wallets, you, NOW);
    expect(out.length).toBeGreaterThan(1);
    for (const a of out) {
      const v = verifyAttestation(a, MOCK_KEYS, NOW);
      expect(v.kind === "ok" ? "ok" : v.reason, a.handle).toBe("ok");
    }
  });

  it("reaches the app through `linkMapFrom` with nothing rejected", () => {
    // From this line on the mock and the real source are indistinguishable to every consumer, which
    // is the property that makes Stage 0 worth building rather than a detour.
    const out = mockAttestations(identities(20), wallets, you, NOW);
    const { links, rejected } = linkMapFrom({ links: out }, MOCK_KEYS, NOW);
    expect(rejected).toEqual([]);
    expect(links.size).toBe(out.length);
    expect(links.get(you)?.handle).toBe(identities(20)[0].handle);
    expect(identityText(links.get(you)).handle).toBe(`@${identities(20)[0].handle}`);
  });

  it("is REJECTED against the production key set", () => {
    // The seed that signed these is printed in `linkSource.ts`, so anybody can produce them. They buy
    // a face in the browser that asked for `?links=mock` and nowhere else — a mock attestation
    // arriving at a production page must fail on the trust set, before any curve work.
    const production = attestationKeyFrom(sha256(new TextEncoder().encode("a production key"))).publicKey;
    for (const a of mockAttestations(identities(20), wallets, you, NOW)) {
      // Against this build's configured production set, which is empty (see `linkSource.test.ts`).
      const v = verifyAttestation(a, trustedKeysFor("api"), NOW);
      expect(v.kind === "rejected" && v.reason).toBe("untrusted-key");
      // And against a production set that is genuinely populated, so the refusal is not an artefact
      // of the set being empty in this environment.
      const w = verifyAttestation(a, [production], NOW);
      expect(w.kind === "rejected" && w.reason).toBe("untrusted-key");
    }
    expect(MOCK_KEYS).not.toContain(production);
  });

  it("is never expired, because it is signed at load", () => {
    // The reason the fixture ships UNSIGNED. A committed signature would rot after seven days and the
    // failure would be silent and perfectly plausible: everybody renders unlinked, which is also what
    // a correct unlinked board looks like.
    const now = Math.floor(Date.now() / 1000);
    const out = mockAttestations(identities(20), wallets, you, now);
    expect(out.length).toBeGreaterThan(1);
    for (const a of out) {
      expect(a.expiresAt).toBeGreaterThan(now);
      expect(a.expiresAt).toBe(now + ATTESTATION_TTL_SECONDS);
      expect(verifyAttestation(a, MOCK_KEYS, now).kind).toBe("ok");
    }
  });

  it("is still subject to expiry — the mock path is not exempt from it", () => {
    // The other side of the same fact, and the reason `nowSec` is threaded through rather than read
    // inside: a record signed eight days ago is refused here exactly as it would be in production.
    const signedLongAgo = mockAttestations(identities(20), wallets, you, NOW - 8 * 24 * 60 * 60);
    for (const a of signedLongAgo) {
      const v = verifyAttestation(a, MOCK_KEYS, NOW);
      expect(v.kind === "rejected" && v.reason).toBe("expired");
    }
  });

  it("dates the link in the past, so the wallet panel shows what an older link looks like", () => {
    // "linked 8 Aug" is rendered from `linkedAt`. A fixture whose link date is always today never
    // shows a two-digit day, and never shows the column at its real width.
    const out = mockAttestations(identities(20), wallets, you, NOW);
    for (const a of out) {
      expect(a.linkedAt).toBe(NOW - 6 * 24 * 60 * 60);
      expect(a.linkedAt).toBeLessThan(a.issuedAt);
    }
  });

  it("carries the empty display name and the missing picture through as nulls", () => {
    // The two states the renderer branches on. `""` on the wire, `null` in the record — and both must
    // survive the round trip, or the fixture's two deliberate edge rows render as ordinary ones.
    const edge: MockIdentity[] = [
      { xId: "9990000000000003", handle: "mock_vole", displayName: "", avatarHash: "" },
    ];
    const [a] = mockAttestations(edge, [you], you, NOW);
    const v = verifyAttestation(a, MOCK_KEYS, NOW);
    expect(v.kind).toBe("ok");
    if (v.kind !== "ok") return;
    expect(v.record.displayName).toBeNull();
    expect(v.record.avatarPath).toBeNull();
    expect(identityText(v.record)).toEqual({ handle: "@mock_vole", displayName: null });
  });

  it("builds the avatar path with `avatarPathFor`, naming the account it belongs to", () => {
    // A hand-built path would be rejected as `bad-avatar-path` — and a path naming a DIFFERENT X id
    // is the impersonation `xLink.ts` guards, arriving through the one field nobody reads.
    const one: MockIdentity[] = [
      { xId: "9990000000000002", handle: "mock_otter", displayName: "Otter", avatarHash: "c".repeat(64) },
    ];
    const [a] = mockAttestations(one, [you], you, NOW);
    expect(a.avatarPath).toBe(avatarPathFor("9990000000000002", "c".repeat(64)));
    expect(a.avatarPath.startsWith("/api/avatar/9990000000000002/")).toBe(true);
  });

  it("costs one face rather than the page when a hand-edited row is invalid", () => {
    // The fixture is edited by hand and `parseMockFixture` only checks TYPES — a handle with a space
    // in it parses fine and is signed. It is `verifyAttestation` that refuses it, one record at a
    // time, and the rest of the board keeps its faces.
    const bad: MockIdentity[] = [
      { xId: "9990000000000004", handle: "not a handle", displayName: "Typo", avatarHash: "a".repeat(64) },
    ];
    const good: MockIdentity[] = [
      { xId: "9990000000000005", handle: "mock_marten", displayName: "Marten", avatarHash: "a".repeat(64) },
    ];
    const w1 = walletAt(1);
    const w2 = walletAt(2);
    const attestations = [
      ...mockAttestations(bad, [w1], w1, NOW),
      ...mockAttestations(good, [w2], w2, NOW),
    ];
    const { links, rejected } = linkMapFrom({ links: attestations }, MOCK_KEYS, NOW);
    expect(rejected).toEqual(["bad-handle"]);
    expect(links.size).toBe(1);
    expect(links.get(w2)?.handle).toBe("mock_marten");
  });

  it("produces nothing when there is nobody on screen", () => {
    expect(mockAttestations(identities(20), [], null, NOW)).toEqual([]);
  });
});

describe("the committed public/links.mock.json", () => {
  // Read off disk rather than imported, so this asserts against the FILE the browser fetches. The
  // regression it catches: somebody reruns `scripts/make-mock-links.mjs`, the shape drifts, and
  // `?links=mock` renders an unlinked board — which is indistinguishable from a correct unlinked
  // board, so nothing would report it.
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../../../public/links.mock.json", import.meta.url), "utf8"),
  );
  const parsed = parseMockFixture(raw);

  it("parses, and loses no row on the way", () => {
    const rowsInFile = (raw as { identities: unknown[] }).identities.length;
    expect(parsed.length).toBe(rowsInFile);
    expect(parsed.length).toBeGreaterThan(1);
  });

  it("names nobody real — every handle is `mock_`-prefixed", () => {
    // The fixture's own stated invariant, and the one that matters most about it: a screenshot of
    // `?links=mock` must never be mistakable for a real person's identity. That is the same failure
    // this whole feature exists to delete, arriving through a review screenshot instead of a prompt.
    for (const id of parsed) expect(id.handle, id.handle).toMatch(/^mock_/);
  });

  it("gives each row its own X account", () => {
    // One handle on two wallets is a state the real system cannot produce (unique index on `x_id`),
    // and `assignMockIdentities`' no-reuse rule cannot save a fixture that duplicates one itself.
    expect(new Set(parsed.map((i) => i.xId)).size).toBe(parsed.length);
    expect(new Set(parsed.map((i) => i.handle)).size).toBe(parsed.length);
  });

  it("still carries the three layouts the fixture exists to show", () => {
    // A row with no display name, a row with no picture, and rows with both — §8.3's mixed board plus
    // §7.3's two failure rungs. A regenerator that emitted six tidy complete rows would delete the
    // only cases worth reviewing, and every test above would still pass.
    expect(parsed.some((i) => i.displayName === "")).toBe(true);
    expect(parsed.some((i) => i.avatarHash === "")).toBe(true);
    expect(parsed.some((i) => i.displayName !== "" && i.avatarHash !== "")).toBe(true);
  });

  it("produces attestations that verify, right now, against the mock key", () => {
    // The end-to-end assertion: the committed file, the committed seed, the committed public key and
    // the production verifier, at the real current time.
    const now = Math.floor(Date.now() / 1000);
    const wallets = roster(24);
    const out = mockAttestations(parsed, wallets, wallets[0], now);
    expect(out.length).toBeGreaterThan(1);
    const { links, rejected } = linkMapFrom({ links: out }, MOCK_KEYS, now);
    expect(rejected).toEqual([]);
    expect(links.size).toBe(out.length);
    for (const record of links.values()) expect(record.handle).toMatch(/^mock_/);
  });
});

// ---------------------------------------------------------------------------------------------

// THE CAST HAS TO LAND ON THE ARENA — the fixture's actual composition, at unit-test cost.
//
// This block exists because `e2e/links.e2e.ts` depends on this property and cannot say so cheaply.
// That test proves a linked fighter's avatar travels from a verified attestation into a paint frame,
// and it discriminates the canvas from the DOM by SUBTRACTING every path an `<img>` already claims —
// `ConnectPanel` renders the local player's own face, so `you`'s avatar is fetched whether or not the
// canvas asks for anything at all. A cast that reaches only `you` therefore leaves that helper with
// an empty set BY CONSTRUCTION, and the failure arrives sixty seconds later as "timed out waiting for
// the canvas to request an avatar" — a browser, a build and a fake clock away from the one-line cause.
//
// It has already happened once. A house-wallet filter in `useLinks.ts` used to shrink the asked list
// and, undocumented, concentrate the cast onto the fighters on screen; when the filter went, the cast
// diluted across fifty-two mostly-leaderboard wallets and the arena kept exactly one face — `you`'s.
// So the requirement is asserted here, against the real fixture, in milliseconds.
describe("the fixture's cast, over the composition `ArenaProvider` actually builds", () => {
  // Exactly what `FixtureArenaProvider` composes: the round on screen, then you, then the standings
  // derived from the round log — then `rosterCast`, which dedupes and caps in that order.
  const fighters = mockFightersAt(0).map((f) => f.wallet);
  const composed = [
    ...fighters,
    MOCK_YOU,
    ...deriveStandings(MOCK_HISTORY).map((r) => r.wallet),
  ];
  const cast = rosterCast(composed);
  const committed: unknown = JSON.parse(
    readFileSync(new URL("../../../public/links.mock.json", import.meta.url), "utf8"),
  );
  const fixtureIdentities = parseMockFixture(committed);
  const onRound = (wallets: readonly string[]) => {
    const inRound = new Set(fighters);
    return [...assignMockIdentities(fixtureIdentities, wallets, MOCK_YOU)].filter(([w]) =>
      inRound.has(w),
    );
  };

  it("is the fixture the e2e drives — a short cast, a long leaderboard tail", () => {
    // The premise, pinned, so the assertions below cannot go vacuous by the fixture changing shape.
    // If the cast ever outgrows the round this is a different problem and these tests should be read
    // again rather than trusted.
    expect(fighters).toContain(MOCK_YOU);
    expect(fixtureIdentities.length).toBeLessThan(fighters.length);
    expect(cast.length).toBeGreaterThan(fighters.length * 2);
  });

  it("puts a face on a fighter who is NOT you", () => {
    // THE EXACT PROPERTY `e2e/links.e2e.ts` RESTS ON. `you`'s avatar is claimed by a DOM `<img>` and
    // subtracted, so at least one other fighter has to gain one or that test can only ever time out.
    const others = onRound(cast).filter(([w]) => w !== MOCK_YOU);
    expect(others.length).toBeGreaterThan(0);
  });

  it("puts a PICTURE on a fighter who is not you, not merely a handle", () => {
    // One rung further, and it is the rung that fails: `mock_tern` is linked with no avatar (§7.3's
    // "we do not have the picture") and draws the same flat disc as an unlinked fighter. A cast whose
    // only non-`you` fighter drew that row would satisfy the test above and still make no request.
    const withPicture = onRound(cast).filter(([w, id]) => w !== MOCK_YOU && id.avatarHash !== "");
    expect(withPicture.length).toBeGreaterThan(0);
  });

  it("is a MIX on the round — not everybody wears a face", () => {
    // §8.3: the mix is where a row layout that silently assumed an avatar column falls apart, and it
    // is the honest picture besides, because most players never link. Concentrating the cast on the
    // round must not tip into linking the whole lineup.
    expect(onRound(cast).length).toBeLessThan(fighters.length);
  });

  it("would land nowhere useful if the cast were sorted, which is why it is not", () => {
    // THE GUARD AGAINST THIS FILE GOING VACUOUS. `rosterKey` is the same wallets in base58 order — the
    // form the query key needs and the form this assignment must never be handed. If this ever starts
    // finding a non-`you` fighter, the tests above have stopped discriminating and the reason to walk
    // the caller's order needs restating rather than the expectation flipping.
    const sorted = onRound(rosterKey(composed)).filter(([w]) => w !== MOCK_YOU);
    expect(sorted).toEqual([]);
  });
});
