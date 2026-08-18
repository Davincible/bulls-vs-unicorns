// Four states and a probe. Small enough to enumerate exhaustively, and worth enumerating: every
// wrong answer here renders a wrong instruction to a stranger, and two of them ("install Phantom" to
// someone who has Phantom, "connecting…" over a live account) are the kind that make a working page
// look broken.

import { describe, expect, it } from "vitest";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import {
  hasInjectedPhantom,
  injectedPhantom,
  phantomFromStandardWallets,
  phantomIsPresent,
  statusForReadyState,
} from "./walletConnection.ts";

describe("statusForReadyState", () => {
  it("reports connected regardless of what else the adapter is claiming", () => {
    // The adapter reports `connecting` and `connected` together for a moment while a connection
    // settles. Showing "connecting…" over a live public key invites a second, pointless popup.
    for (const rs of Object.values(WalletReadyState)) {
      expect(statusForReadyState(rs, true, true), rs).toBe("connected");
      expect(statusForReadyState(rs, false, true), rs).toBe("connected");
    }
  });

  it("reports connecting only while nothing is connected yet", () => {
    expect(statusForReadyState(WalletReadyState.Installed, true, false)).toBe("connecting");
  });

  it("treats Installed and Loadable alike — both mean a wallet is there to talk to", () => {
    // `Loadable` is meaningless for an extension, but it is a POSITIVE readiness signal and reading
    // it as absent would tell someone with a working wallet to install one.
    expect(statusForReadyState(WalletReadyState.Installed, false, false)).toBe("disconnected");
    expect(statusForReadyState(WalletReadyState.Loadable, false, false)).toBe("disconnected");
  });

  it("reports unsupported when the adapter found nothing", () => {
    expect(statusForReadyState(WalletReadyState.NotDetected, false, false)).toBe("unsupported");
    expect(statusForReadyState(WalletReadyState.Unsupported, false, false)).toBe("unsupported");
  });
});

describe("hasInjectedPhantom", () => {
  it("finds the provider at either injection point", () => {
    // Phantom injects `window.phantom.solana` and, for backwards compatibility, `window.solana`.
    expect(hasInjectedPhantom({ phantom: { solana: { isPhantom: true } } })).toBe(true);
    expect(hasInjectedPhantom({ solana: { isPhantom: true } })).toBe(true);
  });

  it("is false for a page with no wallet, and for a non-Phantom provider squatting window.solana", () => {
    expect(hasInjectedPhantom({})).toBe(false);
    expect(hasInjectedPhantom({ solana: {} })).toBe(false);
    // Another wallet claiming the legacy global must not be mistaken for Phantom — `isPhantom` is
    // the only thing that distinguishes them, and it must be exactly `true`, not merely truthy.
    expect(hasInjectedPhantom({ solana: { isPhantom: "yes" } })).toBe(false);
  });

  it("survives being handed anything at all", () => {
    // It reads a global, and a global can be absent or replaced by anything in a hostile page.
    for (const junk of [null, undefined, 0, "", false, [], "window"]) {
      expect(hasInjectedPhantom(junk), String(junk)).toBe(false);
    }
  });

  it("does not throw when window.phantom exists but window.phantom.solana does not", () => {
    // A partially-initialised injection, which is exactly the window in which the adapter's own
    // polling detection is still running.
    expect(hasInjectedPhantom({ phantom: {} })).toBe(false);
  });
});

describe("injectedPhantom", () => {
  const provider = (extra: Record<string, unknown> = {}) => ({
    isPhantom: true,
    connect: () => Promise.resolve(),
    ...extra,
  });

  it("hands back the provider under either global, preferring window.phantom.solana", () => {
    // The adapter's own `connect()` resolves `window.phantom?.solana || window.solana` in that
    // order. Disagreeing here would mean eagerly connecting one object and adapting the other.
    const preferred = provider();
    const other = provider();
    expect(injectedPhantom({ phantom: { solana: preferred }, solana: other })).toBe(preferred);
    expect(injectedPhantom({ solana: other })).toBe(other);
  });

  it("refuses anything that is not a Phantom-shaped provider with a connect method", () => {
    expect(injectedPhantom(undefined)).toBeNull();
    expect(injectedPhantom(null)).toBeNull();
    expect(injectedPhantom("window")).toBeNull();
    expect(injectedPhantom({})).toBeNull();
    // isPhantom must be exactly true, not merely truthy — same rule hasInjectedPhantom applies.
    expect(injectedPhantom({ solana: { isPhantom: "yes", connect: () => {} } })).toBeNull();
    // Present but unusable: no eager call can be made through it.
    expect(injectedPhantom({ solana: { isPhantom: true } })).toBeNull();
  });

  it("is STRICTER than hasInjectedPhantom, on purpose", () => {
    // A provider with no `connect` still means Phantom is installed. If these two agreed, that
    // visitor would be told to go and install the extension they already have.
    const malformed = { solana: { isPhantom: true } };
    expect(hasInjectedPhantom(malformed)).toBe(true);
    expect(injectedPhantom(malformed)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// THE OBSERVED FAILURE: Firefox, Phantom AND MetaMask installed, and the page said "install Phantom".
//
// MetaMask ships Solana support and injects `window.solana`, which is a single slot two extensions
// want. These tests pin the union that fixes it, and — more importantly — pin that the union cannot
// become a stricter false negative, which is the bug wearing a hat.
describe("phantomIsPresent, against a browser holding two wallets", () => {
  const metamaskOwnsWindowSolana = { solana: { isPhantom: false } };

  it("finds Phantom in the registry when MetaMask has taken window.solana", () => {
    // The reported case. Legacy probe says no — correctly, it is looking at MetaMask.
    expect(hasInjectedPhantom(metamaskOwnsWindowSolana)).toBe(false);
    expect(phantomIsPresent(metamaskOwnsWindowSolana, [{ name: "Phantom" }])).toBe(true);
  });

  it("does NOT read MetaMask as Phantom, which is the confusion this must not introduce", () => {
    expect(phantomIsPresent(metamaskOwnsWindowSolana, [{ name: "MetaMask" }])).toBe(false);
  });

  it("still finds Phantom from the legacy namespace with no registry at all", () => {
    // Older builds register nothing. Requiring the registry would break them.
    expect(phantomIsPresent({ phantom: { solana: { isPhantom: true } } }, undefined)).toBe(true);
    expect(phantomIsPresent({ solana: { isPhantom: true } }, [])).toBe(true);
  });

  it("says no when neither channel has it", () => {
    expect(phantomIsPresent({}, [])).toBe(false);
    expect(phantomIsPresent({}, undefined)).toBe(false);
    expect(phantomIsPresent(undefined, undefined)).toBe(false);
  });

  it("matches the name exactly rather than loosely", () => {
    // `includes("Phantom")` would match a wallet named "Phantom Clone"; a chains-based match would
    // read every Solana wallet as Phantom. Both were rejected — see the function's comment.
    expect(phantomFromStandardWallets([{ name: "Phantom Deceiver" }])).toBe(false);
    expect(phantomFromStandardWallets([{ name: " Phantom " }])).toBe(true); // trimmed, deliberately
    expect(phantomFromStandardWallets([{ name: 42 }])).toBe(false);
    expect(phantomFromStandardWallets([{}])).toBe(false);
  });
});
