// THE BYTES A PLAYER IS ASKED TO SIGN, ASSERTED AS BYTES.
//
// These tests are deliberately brittle about the exact string, and the brittleness is the value. The
// message is the CONSENT: a signature is worth what the words said, and a change to the words is a
// change to what every future signature means. A test that only checked "contains the wallet" would
// let somebody quietly drop the line that says this is not a transaction — which is the line
// `TWITTER-CONNECT.md` §4.2 put there because "a wallet prompt with no explanation is how players get
// trained to sign anything".
//
// If one of these fails after an intentional edit, read the new message out loud, decide whether you
// would sign it, and then update the expectation.

import { describe, expect, it } from "vitest";
import {
  challengeMessage,
  CHALLENGE_TTL_SECONDS,
  DEFAULT_ORIGIN,
  isoSecond,
  newNonce,
  NONCE_RE,
  originFrom,
} from "./challenge.ts";
import { countingRandom, NOW, wallet } from "./testKit.ts";

const W = wallet(3);

describe("challengeMessage", () => {
  it("binds the wallet, the handle AND the numeric X id into the signed bytes", () => {
    // §4.1's whole guarantee. Fact A (the X account) is inside the bytes that prove fact B (the
    // wallet), so a signature collected here cannot be pointed at another X account and one collected
    // elsewhere cannot be replayed here.
    const message = challengeMessage({
      purpose: "link",
      origin: DEFAULT_ORIGIN,
      wallet: W,
      handle: "someone",
      xId: "1234567890",
      nonce: "a".repeat(64),
      issuedAtSec: NOW,
      expiresAtSec: NOW + CHALLENGE_TTL_SECONDS,
    });

    expect(message).toBe(
      [
        "bullsvsunicorns.fun wants to link your X account.",
        "",
        `Wallet:  ${W}`,
        "X:       @someone  (id 1234567890)",
        `Nonce:   ${"a".repeat(64)}`,
        "Issued:  2027-01-15T08:00:00Z",
        "Expires: 2027-01-15T08:05:00Z",
        "",
        "Signing this proves you control this wallet. It is not a",
        "transaction, it moves no funds, and it costs nothing.",
        "",
        "Anyone will then be able to see that this wallet belongs to",
        "your X account, including its entire on-chain history.",
      ].join("\n"),
    );
  });

  it("prints the wallet in FULL, never abbreviated", () => {
    // §4.2 says full base58 where `SOCIAL.md`'s sketch abbreviates. The abbreviation is unusable for
    // the one thing the line is for — comparing against the account the wallet has selected — and the
    // first and last four characters of a base58 key are cheap to grind.
    const message = challengeMessage({
      purpose: "link",
      origin: DEFAULT_ORIGIN,
      wallet: W,
      handle: "h",
      xId: "1",
      nonce: "b".repeat(64),
      issuedAtSec: NOW,
      expiresAtSec: NOW + 1,
    });
    expect(message).toContain(W);
    expect(message).not.toContain("…");
    expect(message).not.toContain("...");
  });

  it("names no X account at all in an unlink, and states what it cannot undo", () => {
    // An unlink needs no X credential (a player who lost their X account must still be able to leave),
    // so there is no identity to name and the words must not imply one.
    const message = challengeMessage({
      purpose: "unlink",
      origin: DEFAULT_ORIGIN,
      wallet: W,
      nonce: "c".repeat(64),
      issuedAtSec: NOW,
      expiresAtSec: NOW + CHALLENGE_TTL_SECONDS,
    });
    expect(message).toContain("wants to unlink your X account.");
    expect(message).not.toContain("@");
    expect(message).not.toContain("(id ");
    expect(message).toContain("It cannot undo what anyone has already seen or copied.");
  });

  it("says it is not a transaction, in both ceremonies", () => {
    // The sentence §4.2 requires. Losing it is the most consequential silent edit available here.
    for (const purpose of ["link", "unlink"] as const) {
      const message = challengeMessage({
        purpose,
        origin: DEFAULT_ORIGIN,
        wallet: W,
        handle: "h",
        xId: "1",
        nonce: "d".repeat(64),
        issuedAtSec: NOW,
        expiresAtSec: NOW + 1,
      });
      expect(message).toContain("not a");
      expect(message).toContain("transaction, it moves no funds, and it costs nothing.");
    }
  });

  it("warns about deanonymisation on the link path, matching the consent screen", () => {
    // `xConsent.ts#CONSENT_COPY.deanonymisation` says this before the redirect; the signed bytes say it
    // again at the moment of consent, because the wallet prompt is the last screen a player sees and
    // the only one they are asked to approve.
    const message = challengeMessage({
      purpose: "link",
      origin: DEFAULT_ORIGIN,
      wallet: W,
      handle: "h",
      xId: "1",
      nonce: "e".repeat(64),
      issuedAtSec: NOW,
      expiresAtSec: NOW + 1,
    });
    expect(message).toContain("entire on-chain history");
  });

  it("is stable byte for byte for one input", () => {
    // The stored copy and the returned copy are the same string; if this function were not
    // deterministic, a signature over one could fail against the other.
    const input = {
      purpose: "link" as const,
      origin: "preview.example",
      wallet: W,
      handle: "someone",
      xId: "9",
      nonce: "f".repeat(64),
      issuedAtSec: NOW,
      expiresAtSec: NOW + 300,
    };
    expect(challengeMessage(input)).toBe(challengeMessage(input));
  });
});

describe("originFrom", () => {
  it("prints the host the request actually arrived at", () => {
    // On a preview deployment a hardcoded production domain would be a lie, and if somebody ever
    // proxies this API from a domain of their own the message should say so rather than lend them our
    // name.
    expect(originFrom("bulls-vs-unicorns-git-preview.vercel.app")).toBe(
      "bulls-vs-unicorns-git-preview.vercel.app",
    );
    expect(originFrom("localhost:5173")).toBe("localhost:5173");
  });

  it("falls back to the canonical domain rather than printing junk", () => {
    // Newlines and spaces are the ones that matter: this string is laid out on labelled lines in front
    // of a person, and a header that could inject a line could forge one.
    expect(originFrom("evil.example\nWallet:  attacker")).toBe(DEFAULT_ORIGIN);
    expect(originFrom("has space")).toBe(DEFAULT_ORIGIN);
    expect(originFrom("user:pass@evil.example")).toBe(DEFAULT_ORIGIN);
    expect(originFrom(null)).toBe(DEFAULT_ORIGIN);
    expect(originFrom(undefined)).toBe(DEFAULT_ORIGIN);
    expect(originFrom("")).toBe(DEFAULT_ORIGIN);
    expect(originFrom("a".repeat(200))).toBe(DEFAULT_ORIGIN);
  });
});

describe("isoSecond", () => {
  it("has no milliseconds — the line is read by a person", () => {
    expect(isoSecond(NOW)).toBe("2027-01-15T08:00:00Z");
    expect(isoSecond(NOW)).not.toContain(".000");
  });
});

describe("newNonce", () => {
  it("returns 32 bytes as lowercase hex, matching the column's CHECK", () => {
    const nonce = newNonce(countingRandom(0x0f));
    expect(nonce).toMatch(NONCE_RE);
    expect(nonce).toHaveLength(64);
  });

  it("returns exactly what the source produced, byte for byte", () => {
    // The nonce that is returned must be the nonce that is stored. A transcription bug here would
    // produce a challenge nobody can redeem, which reads as "that expired" — a failure with a
    // plausible innocent explanation, which is the worst kind.
    const nonce = newNonce((out) => {
      for (let i = 0; i < out.length; i += 1) out[i] = i;
    });
    expect(nonce).toBe(
      Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join(""),
    );
  });

  it("does not repeat itself across calls from one source", () => {
    const random = countingRandom(1);
    expect(newNonce(random)).not.toBe(newNonce(random));
  });
});
