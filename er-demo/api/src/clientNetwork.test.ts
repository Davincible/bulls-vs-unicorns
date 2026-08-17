// THE ONE PROPERTY THESE TESTS EXIST FOR: NO INDIVIDUAL IP ADDRESS COMES OUT OF THIS MODULE.
//
// `clientNetwork.ts`'s header makes the privacy argument — a rate-limit table keyed by IP, written by
// the same request that writes a wallet, is an IP↔wallet correlation log and a worse deanonymisation
// surface than the register it protects. That argument is only true if the truncation is right, so it is
// asserted here rather than trusted, in both address families and in the awkward spellings a proxy can
// produce.

import { describe, expect, it } from "vitest";
import { clientNetwork, ipv4Network, ipv6Network, networkOf, UNKNOWN_NETWORK } from "./clientNetwork.ts";

const headers = (entries: Record<string, string>): Headers => new Headers(entries);

describe("ipv4Network", () => {
  it("keeps the /24 and discards the host", () => {
    expect(ipv4Network("203.0.113.42")).toBe("203.0.113.0/24");
    expect(ipv4Network("203.0.113.42")).not.toContain("42");
  });

  it("collapses every address in one /24 to one subject", () => {
    // Which is the point: a handful of addresses in one block is the cheapest way to defeat a
    // per-address counter, and it costs an abuser nothing.
    expect(ipv4Network("198.51.100.1")).toBe(ipv4Network("198.51.100.254"));
  });

  it("refuses anything that is not a dotted quad", () => {
    for (const bad of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.4/24", "hello"]) {
      expect(ipv4Network(bad)).toBeNull();
    }
  });
});

describe("ipv6Network", () => {
  it("keeps the /48 — the site, not the LAN and not the interface", () => {
    expect(ipv6Network("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1::/48");
  });

  it("expands `::` before truncating", () => {
    expect(ipv6Network("2001:db8:1::9")).toBe("2001:db8:1::/48");
    expect(ipv6Network("::1")).toBe("0:0:0::/48");
  });

  it("normalises case and leading zeros, so one network is one bucket", () => {
    expect(ipv6Network("2001:0DB8:0001::1")).toBe(ipv6Network("2001:db8:1::2"));
  });

  it("refuses malformed addresses rather than guessing", () => {
    for (const bad of ["", "2001:db8", "2001::db8::1", "2001:db8:1:2:3:4:5:6:7", "2001:xyz::1", "1.2.3.4"]) {
      expect(ipv6Network(bad)).toBeNull();
    }
  });
});

describe("networkOf", () => {
  it("treats an IPv4-mapped IPv6 address as IPv4", () => {
    // Some proxies spell an IPv4 client this way. Truncated as IPv6 it would put the whole IPv4
    // internet into one /48-shaped bucket — either useless or an outage, depending on the limit.
    expect(networkOf("::ffff:203.0.113.42")).toBe("203.0.113.0/24");
    expect(networkOf("::FFFF:203.0.113.42")).toBe("203.0.113.0/24");
  });

  it("strips a bracketed IPv6 host and its port", () => {
    expect(networkOf("[2001:db8:1::1]:443")).toBe("2001:db8:1::/48");
    expect(networkOf("[2001:db8:1::1]")).toBe("2001:db8:1::/48");
  });

  it("returns null for anything unparseable", () => {
    expect(networkOf("")).toBeNull();
    expect(networkOf("   ")).toBeNull();
    expect(networkOf("not-an-address")).toBeNull();
  });
});

describe("clientNetwork", () => {
  it("prefers the platform's own header over the client-settable ones", () => {
    // `x-vercel-forwarded-for` is set by Vercel's edge and cannot be supplied by a caller. Trusting it
    // first means a request that forges `x-forwarded-for` cannot pick its own bucket.
    const h = headers({
      "x-vercel-forwarded-for": "203.0.113.7",
      "x-real-ip": "198.51.100.7",
      "x-forwarded-for": "192.0.2.7",
    });
    expect(clientNetwork(h)).toBe("203.0.113.0/24");
  });

  it("takes the LEFTMOST element of a chain, which is the original client", () => {
    // Taking the rightmost — a common "trust the last hop" instinct — would count every request in the
    // world against Vercel's own edge: one bucket for the internet.
    expect(clientNetwork(headers({ "x-forwarded-for": "203.0.113.9, 70.41.3.18, 150.172.238.178" })))
      .toBe("203.0.113.0/24");
  });

  it("does NOT fall through to a weaker header when a stronger one is unparseable", () => {
    // Otherwise a caller who can set `x-forwarded-for` picks its bucket by corrupting the header above
    // it, which is the whole hierarchy defeated with one extra request header.
    const h = headers({ "x-vercel-forwarded-for": "garbage", "x-forwarded-for": "203.0.113.1" });
    expect(clientNetwork(h)).toBe(UNKNOWN_NETWORK);
  });

  it("puts a request with no usable address into ONE shared bucket, which is stricter", () => {
    // Unparseable must not mean unlimited. Everyone in this state shares a counter, so "we could not
    // identify you" is a tighter limit than "you are on your own /24" rather than a way around it.
    expect(clientNetwork(new Headers())).toBe(UNKNOWN_NETWORK);
    expect(clientNetwork(headers({ "x-forwarded-for": "" }))).toBe(UNKNOWN_NETWORK);
    expect(clientNetwork(headers({ "x-real-ip": "not-an-ip" }))).toBe(UNKNOWN_NETWORK);
  });

  it("never returns a whole address", () => {
    // The property the whole module exists for, asserted directly.
    for (const raw of ["203.0.113.42", "2001:db8:1:2:3:4:5:6", "::ffff:198.51.100.9"]) {
      const bucket = clientNetwork(headers({ "x-vercel-forwarded-for": raw }));
      expect(bucket).not.toBe(raw);
      expect(bucket).toMatch(/\/(24|48)$/);
    }
  });
});
