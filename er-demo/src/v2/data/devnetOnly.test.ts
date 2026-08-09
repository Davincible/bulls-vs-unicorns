// The guard, exercised against the two endpoints this app actually runs on and against the shapes a
// mistake would take. `devnet-guard.test.ts` covers the matcher itself; this covers the wrapper and,
// more importantly, PINS THE INVARIANT — the endpoints the wallet path uses are the app's own, and
// they are devnet.

import { describe, expect, it } from "vitest";
import { Connection } from "@solana/web3.js";
import { BASE_RPC, ROUTER_URL } from "../../chain/constants.ts";
import { MainnetBlocked } from "../../devnet-guard.ts";
import { assertDevnetConnection } from "./devnetOnly.ts";

describe("assertDevnetConnection", () => {
  it("passes the endpoints this app actually connects to", () => {
    // If either of these ever stops being devnet, this fails here rather than in a browser holding
    // somebody's real funds.
    expect(() => assertDevnetConnection(new Connection(BASE_RPC))).not.toThrow();
    expect(() => assertDevnetConnection(new Connection(ROUTER_URL))).not.toThrow();
  });

  it("refuses mainnet, by name", () => {
    expect(() => assertDevnetConnection(new Connection("https://api.mainnet-beta.solana.com"))).toThrow(
      MainnetBlocked,
    );
  });

  it("refuses an endpoint it cannot positively identify — it fails CLOSED", () => {
    // The property that matters. An allowlist refuses the unfamiliar proxy domain nobody thought to
    // ban; a denylist would wave it through. Note the contrast with
    // `@solana/wallet-standard-util`'s `getChainForEndpoint`, which defaults the OTHER way, straight
    // to `solana:mainnet` — see this module's header.
    expect(() => assertDevnetConnection(new Connection("https://rpc.example.com/?api-key=abc"))).toThrow(
      MainnetBlocked,
    );
  });

  it("reads the live object's endpoint, not the constant it was built from", () => {
    // The whole reason this takes a `Connection` rather than a string: it checks what is true now.
    const c = new Connection("https://api.devnet.solana.com");
    expect(c.rpcEndpoint).toContain("devnet");
    expect(() => assertDevnetConnection(c)).not.toThrow();
  });

  it("names the caller in the refusal, so a thrown guard says which connection was wrong", () => {
    expect(() => assertDevnetConnection(new Connection("https://api.mainnet-beta.solana.com"), "session")).toThrow(
      /session/,
    );
  });
});
