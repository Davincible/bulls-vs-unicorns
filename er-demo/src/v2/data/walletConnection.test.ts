// Four states and a probe. Small enough to enumerate exhaustively, and worth enumerating: every
// wrong answer here renders a wrong instruction to a stranger, and two of them ("install Phantom" to
// someone who has Phantom, "connecting…" over a live account) are the kind that make a working page
// look broken.

import { describe, expect, it } from "vitest";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { hasInjectedPhantom, injectedPhantom, statusForReadyState } from "./walletConnection.ts";

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
