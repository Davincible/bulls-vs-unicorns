// The voice's copy, pinned. `commentary()` is the throttle's other half — the rate limit decides HOW
// OFTEN the page speaks, and this decides that a burst collapses into at most two sentences however
// many exchanges are in it. Both halves have to hold or the toast stack turns over faster than
// anybody can read it, so the ceiling is asserted rather than assumed.

import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { shortKey, UNITS_PER_USD, type CombatEvent, type FighterView } from "../contract.ts";
import { linkMapFrom, NO_LINKS, type LinkMap } from "../data/xLink.ts";
import { attestationKeyFrom, signAttestation } from "../data/xLinkSign.ts";
import { commentary, deathLine, resultLine } from "./combatVoice.ts";

/** 44 base58 characters with a distinct head and tail, so `shortKey` gives each fighter a legible
 *  and DIFFERENT truncation — which is what the copy below prints now that the wallet-derived
 *  pseudonym is gone. The alphabet excludes `0`, `O`, `I` and `l`; `verifyAttestation` checks it. */
const key = (head: string, tail: string) => head + "x".repeat(36) + tail;

const YOU_KEY = key("You1", "AAAA");
const TURBO_KEY = key("Turb", "BBBB");
const GRAVEL_KEY = key("Grav", "CCCC");

function fighter(over: Partial<FighterView> & Pick<FighterView, "id" | "wallet">): FighterView {
  return {
    short: shortKey(over.wallet),
    side: 0,
    stake: 10n * UNITS_PER_USD,
    hp: 10n * UNITS_PER_USD,
    banked: 0n,
    dead: false,
    isYou: false,
    avatarSrc: null,
    ...over,
  };
}

const YOU = fighter({ id: 0, wallet: YOU_KEY, isYou: true, side: 0 });
const TURBO = fighter({ id: 1, wallet: TURBO_KEY, side: 1 });
const GRAVEL = fighter({ id: 2, wallet: GRAVEL_KEY, side: 1 });

/** What the lines below print for each opponent: the truncated address, because neither has linked.
 *  Named rather than inlined so the copy assertions read as sentences instead of as base58. */
const TURBO_NAME = shortKey(TURBO_KEY);
const GRAVEL_NAME = shortKey(GRAVEL_KEY);

/** A verified `LinkMap`, minted the only way one can be: signed, then put through the real verifier.
 *  A `LinkRecord` is branded so no test can invent one. */
const ATTESTATION_KEY = attestationKeyFrom(sha256(new TextEncoder().encode("combatVoice.test key")));
const NOW = 1_800_000_000;
const TURBO_LINKED: LinkMap = (() => {
  const { links, rejected } = linkMapFrom(
    {
      links: [
        signAttestation(
          {
            wallet: TURBO_KEY,
            xId: "111000000000000001",
            handle: "blknoiz06",
            displayName: "",
            avatarPath: "",
            linkedAt: NOW - 86_400,
          },
          ATTESTATION_KEY,
          NOW,
        ),
      ],
    },
    [ATTESTATION_KEY.publicKey],
    NOW,
  );
  // A fixture that quietly failed verification would make the handle assertion below pass for the
  // wrong reason — an unverified record and an unlinked wallet both render as the address.
  if (rejected.length > 0) throw new Error(`fixture did not verify: ${rejected.join(", ")}`);
  return links;
})();

/** `$x.xx` in units. */
function usd(dollars: number): bigint {
  return BigInt(Math.round(dollars * Number(UNITS_PER_USD)));
}

function hit(step: number, attacker: FighterView, defender: FighterView, dollars: number): CombatEvent {
  return { step, attacker, defender, amount: usd(dollars), mine: attacker.isYou || defender.isYou };
}

describe("commentary", () => {
  it("names the fighter when one exchange is the whole window", () => {
    expect(commentary([hit(10, YOU, TURBO, 4.1)], NO_LINKS)).toEqual([
      { kind: "a", text: `You raided $4.10 off ${TURBO_NAME}` },
    ]);
  });

  it("names an unlinked opponent by their address, never by an invented name", () => {
    // THE OPERATOR'S COMPLAINT, IN THIS SURFACE. `nameFor()` used to mint `TURBO_12` here for any
    // wallet at all, and a toast is where an invented name is least checkable: it is gone in five
    // seconds and there is no key printed beside it to check it against. The address is what the
    // line carries now, and it is the same address the rosters and the log show.
    const [line] = commentary([hit(10, YOU, TURBO, 4.1)], NO_LINKS);
    expect(line?.text).toContain(shortKey(TURBO_KEY));
  });

  it("names a linked opponent by their @handle", () => {
    // The other half of the same rule: a name appears when, and only when, somebody proved one.
    expect(commentary([hit(10, YOU, TURBO, 4.1)], TURBO_LINKED)).toEqual([
      { kind: "a", text: "You raided $4.10 off @blknoiz06" },
    ]);
  });

  it("puts the opponent first when you are the one being raided", () => {
    // The original game's grammar, kept: you are the subject when you are winning and the object when
    // you are not, which is what made it feel like the fight was happening to somebody.
    expect(commentary([hit(11, GRAVEL, YOU, 2.8)], NO_LINKS)).toEqual([
      { kind: "b", text: `${GRAVEL_NAME} hit you for $2.80` },
    ]);
  });

  it("colours a line by the ATTACKER's side in both directions", () => {
    // Not by "yours vs theirs": the side marks are the page's only colour and they mean one thing
    // everywhere — who did it.
    const out = commentary([hit(1, YOU, TURBO, 1)], NO_LINKS)[0];
    const inbound = commentary([hit(2, TURBO, YOU, 1)], NO_LINKS)[0];
    expect(out?.kind).toBe("a");
    expect(inbound?.kind).toBe("b");
  });

  it("sums a burst against one opponent and counts it", () => {
    expect(
      commentary([hit(1, YOU, TURBO, 1), hit(2, YOU, TURBO, 2), hit(3, YOU, TURBO, 0.5)], NO_LINKS),
    ).toEqual([{ kind: "a", text: `You raided $3.50 off ${TURBO_NAME} · 3 raids` }]);
  });

  it("reports the spread instead of picking a name when several opponents are involved", () => {
    expect(commentary([hit(1, YOU, TURBO, 1), hit(2, YOU, GRAVEL, 2)], NO_LINKS)).toEqual([
      { kind: "a", text: "You raided $3.00 · 2 raids on 2 fighters" },
    ]);
    expect(commentary([hit(1, TURBO, YOU, 1), hit(2, GRAVEL, YOU, 2)], NO_LINKS)).toEqual([
      { kind: "b", text: "You took $3.00 · 2 hits from 2 fighters" },
    ]);
  });

  it("never emits more than one line per direction, however big the burst", () => {
    // THE CEILING THE WHOLE THROTTLE RESTS ON. A sixteen-fighter lobby runs at 32 exchanges a second
    // and this window is three seconds wide, so ~100 events in one window is the real worst case —
    // and it has to come out as two sentences, not a hundred.
    const flood: CombatEvent[] = [];
    for (let i = 0; i < 100; i++) {
      flood.push(i % 2 === 0 ? hit(i, YOU, TURBO, 0.4) : hit(i, GRAVEL, YOU, 0.3));
    }
    const lines = commentary(flood, NO_LINKS);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe(`You raided $20.00 off ${TURBO_NAME} · 50 raids`);
    expect(lines[1]?.text).toBe(`${GRAVEL_NAME} hit you for $15.00 · 50 hits`);
  });

  it("says nothing about a window worth less than a cent", () => {
    // The damage roll is a percentage of remaining hp, so a fight's closing stretch is thousands of
    // sub-cent exchanges. Narrating them would spend the whole budget on `<$0.01`.
    expect(commentary([hit(1, YOU, TURBO, 0.002), hit(2, YOU, TURBO, 0.003)], NO_LINKS)).toEqual([]);
  });

  it("speaks about the direction that clears the floor and stays silent about the other", () => {
    const lines = commentary([hit(1, YOU, TURBO, 0.001), hit(2, GRAVEL, YOU, 5)], NO_LINKS);
    expect(lines).toEqual([{ kind: "b", text: `${GRAVEL_NAME} hit you for $5.00` }]);
  });

  it("has nothing to say about an empty window", () => {
    expect(commentary([], NO_LINKS)).toEqual([]);
  });
});

describe("deathLine", () => {
  it("tells an extractor what survived", () => {
    const line = deathLine(fighter({ id: 0, wallet: YOU_KEY, isYou: true, dead: true, hp: 0n, banked: usd(12.4) }));
    expect(line.kind).toBe("error");
    expect(line.text).toBe("Your fighter is out — $12.40 banked stays yours, the ring is gone");
  });

  it("tells a Mayhem player plainly what it cost", () => {
    const line = deathLine(fighter({ id: 0, wallet: YOU_KEY, isYou: true, dead: true, hp: 0n }));
    expect(line.text).toBe("Your fighter is out — nothing was banked, and the ring is gone");
  });
});

describe("resultLine", () => {
  it("carries your own result when you were in the round", () => {
    expect(resultLine(0, YOU, usd(4.1)).text).toBe("ANSEM takes the round — you finished +$4.10");
    expect(resultLine(1, YOU, -usd(2.8)).text).toBe("UWU takes the round — you finished −$2.80");
  });

  it("reads level rather than +$0.00 for a player who broke even", () => {
    // Same rule `usdSigned` keeps: `+$0.00` reads as a win of nothing, which is a different claim.
    expect(resultLine(0, YOU, 0n).text).toBe("ANSEM takes the round — you finished level");
  });

  it("states the winner and nothing about a spectator's position", () => {
    expect(resultLine(1, null, null).text).toBe("UWU takes the round");
  });
});
