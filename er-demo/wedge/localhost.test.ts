// THIS FILE IS IN `npm test`, AND THAT PLACEMENT IS THE POINT.
//
// `g1.wedge.ts` next door needs two validators, a compiled `.so` and about ninety seconds, so it
// runs under its own config (`npm run test:wedge`) and NOT in the browserless suite. Its safety
// guard has no such excuse. A guard that is only exercised by the run it guards is a guard that
// stops being exercised the moment that run stops being convenient — and this repo has already paid
// for that lesson once, with a staleness gate that silently switched itself off and reported green.
//
// So `localhost.ts` is pure, and it is tested here, in the suite that runs on every commit. The
// wedge harness can rot without anybody noticing; the reason it can never be pointed at devnet
// cannot.

import { describe, expect, it } from "vitest";
import { assertLocalhostUrl, isLocalhostUrl, NonLocalEndpoint } from "./localhost.ts";
import { isDevnetUrl } from "../src/devnet-guard.ts";

describe("wedge/localhost — loopback endpoints are accepted", () => {
  // Every shape `stack.ts` actually constructs, plus the ones a developer would reasonably type by
  // hand when pointing the harness at an already-running stack.
  const accepted = [
    "http://127.0.0.1:8919",
    "http://localhost:8919",
    "ws://127.0.0.1:8920",
    "wss://localhost:7820",
    "https://127.0.0.1:8919",
    "http://127.0.0.1:8919/",
    "http://localhost", // no port — the parser fills in 80, and the host is still loopback
    "http://[::1]:7819",
  ];

  for (const url of accepted) {
    it(`accepts ${url}`, () => {
      expect(() => assertLocalhostUrl(url)).not.toThrow();
      expect(isLocalhostUrl(url)).toBe(true);
    });
  }
});

describe("wedge/localhost — everything else is refused", () => {
  const refused: [string, string][] = [
    ["https://api.devnet.solana.com", "the cluster the live arena runs on"],
    ["https://api.mainnet-beta.solana.com", "mainnet"],
    ["https://api.testnet.solana.com", "testnet"],
    ["https://devnet-router.magicblock.app", "the Magic Router — chain/constants.ts's ROUTER_URL"],
    ["https://devnet.helius-rpc.com/?api-key=k", "a paid devnet endpoint"],
    ["wss://devnet.magicblock.app", "a real ER validator"],
    // The bypass that bit `src/devnet-guard.ts` on 2026-08-09. The URL parser deletes the tab, so
    // the string a regex would judge and the host a socket would reach are different strings. This
    // guard asks the parser for the hostname, so the two can never disagree — the tab is gone by the
    // time anything is compared, and `api.mainnet-beta.solana.com` is simply not loopback.
    ["https://api.mai\tnnet-beta.solana.com/?x=localhost", "tab-injected mainnet"],
    ["http://127.0.0.1.evil.example/", "a hostname that merely BEGINS with a loopback address"],
    ["http://localhost.evil.example/", "a hostname that merely begins with `localhost`"],
    ["http://evil.example/?host=localhost", "loopback in the query string only"],
    ["http://evil.example/#http://localhost", "loopback in the fragment only"],
    // `0.0.0.0` is the deliberate divergence from `devnet-guard.ts`, which permits it. See the
    // comment on LOOPBACK_HOSTNAMES: it is a bind address, and where it routes when used as a
    // destination is platform-dependent.
    ["http://0.0.0.0:8919", "a bind address, not a destination"],
    ["http://user:pass@localhost:8919", "loopback, but carrying a credential"],
    ["file:///etc/passwd", "not a network scheme"],
    ["javascript:alert(1)", "not a network scheme"],
    ["", "empty"],
    ["   ", "whitespace"],
    ["localhost:8919", "no scheme, so the parser reads `localhost:` as the scheme"],
    ["not a url at all", "unparseable"],
  ];

  for (const [url, why] of refused) {
    it(`refuses ${JSON.stringify(url)} — ${why}`, () => {
      expect(() => assertLocalhostUrl(url)).toThrow(NonLocalEndpoint);
      expect(isLocalhostUrl(url)).toBe(false);
    });
  }

  it("names the endpoint it was given, so a failure says WHICH of several was wrong", () => {
    expect(() => assertLocalhostUrl("https://api.devnet.solana.com", "rollup RPC")).toThrow(
      /rollup RPC/,
    );
  });
});

// THE RELATIONSHIP BETWEEN THE TWO GUARDS, AS A TEST RATHER THAN AS A PARAGRAPH.
//
// `localhost.ts`'s header claims it is not "devnet-guard with a shorter list" — that the two guards
// answer different questions and that this one is strictly narrower. That is the kind of claim which
// is true when written and quietly false a year later, after somebody widens one list for a good
// local reason. Asserting it costs four lines and turns a comment into an invariant.
describe("wedge/localhost is strictly narrower than src/devnet-guard", () => {
  const permittedByDevnetGuard = [
    "https://api.devnet.solana.com",
    "https://api.testnet.solana.com",
    "https://devnet.helius-rpc.com",
    "https://devnet-router.magicblock.app",
    "http://0.0.0.0:8899",
  ];

  it("refuses every non-loopback endpoint that devnet-guard is happy to permit", () => {
    for (const url of permittedByDevnetGuard) {
      expect(isDevnetUrl(url), `${url} should be fine for the app`).toBe(true);
      expect(isLocalhostUrl(url), `${url} must NOT be reachable from wedge/`).toBe(false);
    }
  });

  it("permits nothing devnet-guard would refuse — loopback is a subset, not an escape hatch", () => {
    for (const url of ["http://127.0.0.1:8919", "http://localhost:8919", "ws://127.0.0.1:8920"]) {
      expect(isLocalhostUrl(url)).toBe(true);
      expect(isDevnetUrl(url), `${url} must be safe under BOTH guards`).toBe(true);
    }
  });
});
