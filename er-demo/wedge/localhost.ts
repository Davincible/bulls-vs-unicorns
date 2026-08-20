// LOOPBACK GUARD — the mirror image of `src/devnet-guard.ts`, and it exists because this directory
// runs the one experiment in the repo where the danger points the other way.
//
// `devnet-guard.ts` protects the browser app from reaching MAINNET. Everything it permits — devnet,
// testnet, anything with "devnet" in the host, `api.devnet.solana.com` — is exactly what this
// directory must refuse. `wedge/` deliberately produces a `Round` that can never be undelegated,
// never resolved, never closed and never swept. On a local validator that is a disposable
// measurement (`ARENA-VAULT.md` §7 E1-M1: "the wedge is disposable — the property no devnet method
// has"). On the devnet the live arena runs on it would be an act of sabotage: `ARENA_SEED` is a
// singleton, so one wedged round on the live id permanently latches `COST-MODEL.md` §4's sweep-gap
// brake and stops the keeper's reclamation forever. §5.1 names that residual in as many words —
// "one dead round permanently halts the keeper".
//
// So this guard is not "devnet-guard with a shorter list". It is a different question with a
// different answer: is this endpoint a LOOPBACK address on this machine? Nothing else passes.
//
// WHY THIS PARSES INSTEAD OF PATTERN-MATCHING, which is where it departs from the file it mirrors.
// `devnet-guard.ts` carries a scar: a 2026-08-09 review found that matching regexes against the raw
// string let `https://api.mai\tnnet-beta.solana.com/?x=devnet` through, because the WHATWG URL
// parser strips ASCII tab and newline from ANYWHERE in the input as its first normalization step —
// so the string the regex judged and the host the socket reached were different strings. That file
// answered with `stripUrlNoise`, pre-applying the parser's own normalization before matching. That
// works, but it is a copy of the parser's behaviour that has to be kept in step with the parser.
//
// This file asks the parser instead. `new URL(u).hostname` IS the host a connection will go to;
// there is no string-level trick that can make the parser and the socket disagree, because they are
// the same parser. Then the hostname is compared against an exact set — not a regex, not a prefix,
// not a `.includes` — so `http://127.0.0.1.evil.com/` fails on the only thing that matters (its
// hostname is `127.0.0.1.evil.com`, which is not `127.0.0.1`) rather than on a pattern somebody has
// to get right.
//
// This is not a criticism of `devnet-guard.ts`, which cannot use this approach for its own job:
// "does this host mean devnet" is genuinely a substring question over an open set of provider
// domains. "Is this host loopback" is a membership question over a closed set of three, and a closed
// set should be written as one.

/** Thrown when an endpoint is not a loopback address. Named for the thing it prevents, in the same
 *  spirit as `devnet-guard.ts`'s `MainnetBlocked`: the message a developer sees should say what was
 *  refused and why, not merely that a check failed. */
export class NonLocalEndpoint extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NonLocalEndpoint";
  }
}

/** The complete set of hostnames this directory may connect to.
 *
 *  `0.0.0.0` IS DELIBERATELY ABSENT, and it is the one entry a reader is likely to want back.
 *  `devnet-guard.ts` permits it, correctly for its purpose. Here it is refused because it is a BIND
 *  address, not a destination: "listen on every interface" is a meaningful thing to configure a
 *  server with and a meaningless thing to point a client at. Some stacks route it to loopback and
 *  some do not, and "some do not" is the whole problem — an endpoint whose destination depends on
 *  the platform is precisely what a guard that fails closed must refuse. The harness in `stack.ts`
 *  binds its validators to `127.0.0.1` and connects to `127.0.0.1`, so nothing legitimate here ever
 *  needs it.
 *
 *  `127.0.0.1` and not `127.0.0.0/8`: `http://127.0.0.2:8899` also reaches this machine, but nothing
 *  in this harness uses it, and an allowlist should list what is used rather than what is possible.
 *
 *  `[::1]` carries its brackets because that is what `new URL(...).hostname` returns for an IPv6
 *  literal — verified rather than assumed, and the reason this is a comparison against parser output
 *  instead of against the string a human would type. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The only schemes an RPC or WebSocket endpoint may carry. Anything else — `file:`, `data:`,
 *  `javascript:` — is refused before the hostname is even considered, because a URL whose scheme is
 *  not a network scheme has no hostname worth trusting. */
const NETWORK_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * Refuse anything that is not a loopback endpoint on this machine.
 *
 * Fails CLOSED in every direction: an unparseable URL, an unknown scheme, an embedded credential, or
 * any hostname outside {@link LOOPBACK_HOSTNAMES} throws. There is no "probably local".
 *
 * @param url  the endpoint about to be used
 * @param what a name for it, so the message says which of several endpoints was wrong
 */
export function assertLocalhostUrl(url: string, what = "endpoint"): void {
  const raw = String(url ?? "").trim();
  if (!raw) {
    throw new NonLocalEndpoint(`${what}: empty URL — refusing to guess a host.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // An endpoint the URL parser cannot read is an endpoint nobody can predict the destination of.
    // `new Connection(...)` would throw on it later anyway; throwing here names the reason.
    throw new NonLocalEndpoint(`${what}: not a parseable URL: ${raw}`);
  }

  if (!NETWORK_PROTOCOLS.has(parsed.protocol)) {
    throw new NonLocalEndpoint(
      `${what}: scheme ${parsed.protocol} is not an RPC scheme (want http/https/ws/wss): ${raw}`,
    );
  }

  // CREDENTIALS ARE REFUSED RATHER THAN IGNORED. `http://localhost:8899@evil.example/` parses with
  // hostname `evil.example` and would be caught below on that alone — but the inverse shape,
  // `http://user:pass@localhost:8899/`, parses to a hostname that IS loopback while carrying a
  // secret into a log line. Neither belongs in a harness that only ever talks to two processes it
  // started itself, and refusing both means the hostname check below is the only thing a reader has
  // to reason about.
  if (parsed.username || parsed.password) {
    throw new NonLocalEndpoint(
      `${what}: URL carries credentials, which no local validator needs: ${parsed.protocol}//***@${parsed.hostname}`,
    );
  }

  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new NonLocalEndpoint(
      `${what} is not a loopback address: host "${parsed.hostname}" in ${raw}\n` +
        `wedge/ produces a round that can NEVER be undelegated, resolved, abandoned or closed. ` +
        `That is a disposable measurement on a throwaway local validator and permanent damage ` +
        `anywhere else — one wedged round latches the keeper's sweep-gap brake forever ` +
        `(ARENA-VAULT.md §5.1). Permitted hosts: ${[...LOOPBACK_HOSTNAMES].join(", ")}.`,
    );
  }
}

/** True when the URL is a loopback endpoint. Never throws — for call sites that want to branch
 *  rather than crash. Mirrors `devnet-guard.ts`'s `isDevnetUrl` so the two guards read the same way
 *  to anyone who has already read that one. */
export function isLocalhostUrl(url: string): boolean {
  try {
    assertLocalhostUrl(url);
    return true;
  } catch {
    return false;
  }
}
