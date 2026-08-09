// THE REDACTOR, AND THE TWO GUARD BEHAVIOURS ITS EXTRACTION TOUCHED.
//
// `redactUrlSecrets` was three inlined copies of a query-string regex until a paid RPC endpoint became
// reachable through configuration (`scripts/keeper/endpoints.ts`). It is now one function with real
// logic, its output goes into the keeper's boot banner — i.e. into `fly logs`, which is not a secret
// store — and the thing it is protecting is an API key somebody is paying for.
//
// EVERY CASE BELOW IS A URL SHAPE A REAL PROVIDER ISSUES, and each one passes `assertDevnetUrl`, so
// each is something an operator can legitimately be running. The query-string form was the only one
// the original regex covered; three of the four put the credential in the PATH, where it was printed
// verbatim. A test that only checked the Helius shape would have agreed with the broken version.
//
// The two `assertDevnetUrl` cases are here because this change rewrote both of its throw sites to call
// the extracted redactor. They are not a general test of the guard — they pin that the refusals still
// refuse, and that the control-character bypass its own comment documents is still closed.

import { describe, expect, it } from "vitest";
import { MainnetBlocked, assertDevnetUrl, isDevnetUrl, redactUrlSecrets } from "./devnet-guard.ts";

describe("redactUrlSecrets keeps credentials out of the log", () => {
  it("masks an api-key query parameter (Helius)", () => {
    const out = redactUrlSecrets("https://devnet.helius-rpc.com/?api-key=abc123secretvalue");
    expect(out).not.toContain("abc123secretvalue");
    expect(out).toContain("api-key=***");
  });

  it("masks a token in the PATH (QuickNode)", () => {
    // The shape the original query-only regex printed in full.
    const out = redactUrlSecrets("https://cold-frosty-sun.solana-devnet.quiknode.pro/9f3c1e7a55b2/");
    expect(out).not.toContain("9f3c1e7a55b2");
  });

  it("masks a token in the PATH (Triton / rpcpool)", () => {
    const out = redactUrlSecrets("https://node.devnet.rpcpool.com/1b2c3d4e5f6a7b8c");
    expect(out).not.toContain("1b2c3d4e5f6a7b8c");
  });

  it("masks a key after a short route segment (Alchemy)", () => {
    // `/v2` must survive as a recognisable route while the key after it does not — the whole point of
    // masking by segment length rather than masking the path wholesale.
    const out = redactUrlSecrets("https://solana-devnet.g.alchemy.com/v2/KeyThatIsSecret123");
    expect(out).not.toContain("KeyThatIsSecret123");
    expect(out).toContain("/v2/");
  });

  it("returns a credential-free endpoint COMPLETELY untouched, not merely recognisable", () => {
    // Exact equality on purpose. The banner line exists so an operator can confirm the endpoint in
    // use is the one they configured, and `new URL(x).toString()` normalises — it would silently
    // turn `https://api.devnet.solana.com` into `…com/`. A redactor that edits a URL it found no
    // secret in is answering a different question than the one asked.
    for (const url of [
      "https://api.devnet.solana.com",
      "https://devnet-router.magicblock.app",
      "https://devnet-eu.magicblock.app/",
      "http://localhost:8899",
    ]) {
      expect(redactUrlSecrets(url)).toBe(url);
    }
  });

  it("keeps the host visible even while masking the path", () => {
    const out = redactUrlSecrets("https://node.devnet.rpcpool.com/1b2c3d4e5f6a7b8c");
    expect(out).toContain("node.devnet.rpcpool.com");
  });

  it("does not throw on something that is not a URL", () => {
    // It is called from the guard's OWN error messages, which run on values that failed to be
    // endpoints. Throwing from inside the reporting path would replace a clear refusal with a
    // confusing one.
    expect(() => redactUrlSecrets("not a url at all")).not.toThrow();
  });
});

describe("the guard still refuses what it refused before the extraction", () => {
  it("refuses mainnet", () => {
    expect(() => assertDevnetUrl("https://api.mainnet-beta.solana.com")).toThrow(MainnetBlocked);
  });

  it("refuses an endpoint it cannot positively identify as devnet", () => {
    // Fails CLOSED: an allowlist, not a denylist. A bare API-key host with no cluster in the name
    // could be either cluster, and "probably devnet" is not good enough.
    expect(() => assertDevnetUrl("https://rpc.example.com/?api-key=x")).toThrow(MainnetBlocked);
  });

  it("still closes the control-character bypass", () => {
    // The URL parser strips ASCII tab from anywhere in the input as its first normalisation step, so
    // `mai\tnnet` resolves to real mainnet while matching neither list textually. See the SEC finding
    // recorded in devnet-guard.ts.
    expect(() => assertDevnetUrl("https://api.mai\tnnet-beta.solana.com/?x=devnet")).toThrow(MainnetBlocked);
  });

  it("does not leak a credential into the refusal message", () => {
    // The refusal path prints the offending URL, and an operator who pasted the wrong endpoint has
    // still pasted a real key.
    try {
      assertDevnetUrl("https://rpc.example.com/?api-key=SuperSecretValue");
      expect.unreachable("should have refused");
    } catch (e) {
      expect((e as Error).message).not.toContain("SuperSecretValue");
    }
  });

  it("accepts the endpoints this repo actually uses", () => {
    expect(isDevnetUrl("https://api.devnet.solana.com")).toBe(true);
    expect(isDevnetUrl("https://devnet-router.magicblock.app")).toBe(true);
    expect(isDevnetUrl("https://devnet-eu.magicblock.app/")).toBe(true);
    expect(isDevnetUrl("http://localhost:8899")).toBe(true);
  });
});
