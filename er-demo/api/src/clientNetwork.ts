// WHICH NETWORK A REQUEST CAME FROM — a /24 or a /48, never an address.
//
// The write path needs a per-caller rate-limit subject, and the obvious one is the client IP. This
// module deliberately never produces one.
//
// ================================================================================================
// WHY THE NETWORK AND NOT THE ADDRESS, WHICH IS A PRIVACY DECISION BEFORE IT IS ANYTHING ELSE.
//
// A rate-limit table keyed by IP, written by the same request that writes a wallet, is a table that
// pairs IP addresses with wallet addresses. That is a deanonymisation database, and a WORSE one than
// the link register it exists to protect: the register only ever holds identities people chose to
// publish, while an IP↔wallet log holds a fact nobody consented to about every player who tried.
// This project does not keep that, so the address is truncated to its network BEFORE it is hashed
// (`rateLimit.ts`), which means no individual address is ever hashed, stored, or recoverable from
// storage — not by us, not by somebody holding a dump, and not by somebody holding a dump and the
// derivation secret.
//
// It also happens to be the better rate limit. A single machine with a /64 of IPv6 or a handful of
// addresses in one /24 defeats a per-address counter for free; the network is the smallest unit an
// ordinary abuser cannot cheaply multiply.
//
// The cost is honest and small: players sharing a /24 (a campus, an office, mobile CGNAT) share a
// counter. `rateLimit.ts` sets the per-network limit several times the per-wallet one for exactly
// that reason, and the numbers there are argued against a shared subnet rather than against one desk.
// ================================================================================================
//
// ------------------------------------------------------------------------------------------------
// WHERE THE ADDRESS COMES FROM, AND WHAT A SPOOFED HEADER CAN AND CANNOT BUY.
//
// There is no socket to ask: a Vercel Function receives a web-standard `Request` and the peer address
// only exists as a header the platform set. Three headers can carry it and they are tried
// most-trusted first — `x-vercel-forwarded-for` (set by Vercel's own edge and not settable by a
// client), then `x-real-ip`, then the leftmost element of `x-forwarded-for`.
//
// If a client could forge the header it reaches us with, the only thing it buys is CHOOSING WHICH
// BUCKET TO LAND IN. That is worth stating precisely because it sounds worse than it is:
//
//   * the per-WALLET limit is unaffected — the wallet is the one named inside a message the server
//     composed, and no header changes it;
//   * a request with no usable header at all lands in the shared `unknown` bucket rather than in no
//     bucket, so "unparseable" is stricter than "parseable", not laxer.
//
// REJECTED: a global counter across all callers as a backstop against header forgery. It bounds total
// spend, and it hands any single client a way to lock every player out of linking by spending the
// global budget alone. A limiter whose worst case is a total outage caused by one attacker is worse
// than the leak it closes.
// ------------------------------------------------------------------------------------------------

/** What the counter counts. An opaque label, already coarsened; nothing downstream needs to know
 *  whether it came from IPv4, IPv6 or nowhere. */
export type ClientNetwork = string;

/** The subject a request with no usable address is counted against. SHARED between all such
 *  requests, on purpose — see the header. */
export const UNKNOWN_NETWORK: ClientNetwork = "unknown";

/** Platform headers, most trusted first. See the header for why the order is this and not any other. */
const ADDRESS_HEADERS: readonly string[] = ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"];

/** Dotted quad, 0-255 per octet. Anchored, and it rejects `01` — a leading zero is an octal
 *  invitation and no platform emits one. */
const IPV4_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;

/**
 * `1.2.3.4` -> `1.2.3.0/24`. Returns `null` for anything that is not an IPv4 literal.
 *
 * /24 rather than /32 (no truncation at all) or /16 (an ISP region). A /24 is the smallest block that
 * is routinely allocated as a unit, so it is the smallest unit an abuser cannot enlarge by asking
 * their host for another address.
 */
export function ipv4Network(address: string): string | null {
  if (!IPV4_RE.test(address)) return null;
  const octets = address.split(".");
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/**
 * An IPv6 address -> its /48, e.g. `2001:db8:1:2::3` -> `2001:db8:1::/48`. Returns `null` for
 * anything that is not an IPv6 literal.
 *
 * /48 IS THE SITE, and it is the right unit for the same reason /24 is: a /64 is one LAN and a
 * residential customer is routinely handed a /56 or a /48, so counting per-/64 or per-address would
 * let one household present thousands of subjects. It is coarser than the IPv4 case in address terms
 * and equivalent in *customer* terms, which is what is being counted.
 *
 * `::ffff:1.2.3.4` — an IPv4-mapped address, which is how some proxies spell an IPv4 client — is
 * handed back to `ipv4Network` by the caller rather than truncated as IPv6, because a /48 of a mapped
 * range would collapse the entire IPv4 internet into one bucket.
 */
export function ipv6Network(address: string): string | null {
  // Reject anything that is not plausibly IPv6 before expanding: hex groups and colons only, at most
  // one `::`, no more than 8 groups.
  if (!/^[0-9A-Fa-f:]{2,45}$/.test(address)) return null;
  if (!address.includes(":")) return null;
  const doubleColons = address.split("::").length - 1;
  if (doubleColons > 1) return null;

  let groups: string[];
  if (doubleColons === 1) {
    const [head, tail] = address.split("::");
    const headGroups = head === "" ? [] : head.split(":");
    const tailGroups = tail === "" ? [] : tail.split(":");
    if (headGroups.length + tailGroups.length > 7) return null;
    const fill = new Array<string>(8 - headGroups.length - tailGroups.length).fill("0");
    groups = [...headGroups, ...fill, ...tailGroups];
  } else {
    groups = address.split(":");
    if (groups.length !== 8) return null;
  }
  for (const g of groups) {
    if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return null;
  }
  // The first three groups are the /48. Normalised to lowercase with no leading zeros so that
  // `2001:0DB8:1::` and `2001:db8:1::` are one bucket rather than two.
  const prefix = groups.slice(0, 3).map((g) => parseInt(g, 16).toString(16));
  return `${prefix.join(":")}::/48`;
}

/**
 * The network of one address literal, or `null` if it is not an address.
 *
 * Handles the two spellings a proxy can hand us for an IPv4 client: the literal, and the
 * IPv4-mapped-IPv6 form `::ffff:1.2.3.4`. Both must reach `ipv4Network`, or every mapped client on the
 * internet shares one /48-shaped bucket.
 */
export function networkOf(address: string): string | null {
  const raw = address.trim();
  if (raw === "") return null;
  // `[2001:db8::1]:443` — some proxies bracket and port IPv6. Strip both before parsing.
  const unbracketed = /^\[(.+)\](:\d{1,5})?$/.exec(raw);
  const candidate = unbracketed === null ? raw : unbracketed[1];

  const mapped = /^::ffff:(.+)$/i.exec(candidate);
  if (mapped !== null) return ipv4Network(mapped[1]);

  const v4 = ipv4Network(candidate);
  if (v4 !== null) return v4;
  return ipv6Network(candidate);
}

/**
 * The network this request came from, or `UNKNOWN_NETWORK`.
 *
 * Only the LEFTMOST element of a comma-separated header is considered. That is the original client in
 * a correctly-behaved proxy chain, and taking the rightmost (a common "trust the last hop" instinct)
 * would count every request against Vercel's own edge — one bucket for the whole internet, which is
 * either useless or an outage depending on the limit.
 *
 * The first header that yields a parseable network wins. A header that is present but unparseable
 * does NOT fall through to the next one: a platform that set `x-vercel-forwarded-for` to something we
 * cannot read is a platform whose other headers we have no more reason to believe, and falling through
 * would let a client that can set the weaker headers pick its bucket by breaking the stronger one.
 */
export function clientNetwork(headers: Headers): ClientNetwork {
  for (const name of ADDRESS_HEADERS) {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === "") continue;
    const first = raw.split(",")[0];
    const network = networkOf(first);
    return network === null ? UNKNOWN_NETWORK : network;
  }
  return UNKNOWN_NETWORK;
}
