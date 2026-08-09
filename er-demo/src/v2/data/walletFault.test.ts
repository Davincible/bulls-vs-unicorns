// The classifier is the only thing standing between a stranger and a raw `SendTransactionError`, so
// the cases here are the SHAPES the three throwing libraries actually produce — a bare Phantom
// object with a numeric code, an adapter `WalletError` with the provider nested under `.error`, and
// an anchor error whose useful half is in `transactionLogs` — rather than hand-written strings that
// only prove the regexes match themselves.

import { describe, expect, it } from "vitest";
import {
  DEVNET_ONLY_NOTE,
  PHANTOM_DEVNET_STEPS,
  classifyWalletError,
  connectFailedFault,
} from "./walletFault.ts";

/** The adapter's own shape: a named Error subclass carrying the provider's object untyped. */
function walletError(name: string, message: string, nested?: unknown) {
  const e = new Error(message) as Error & { error?: unknown };
  e.name = name;
  if (nested !== undefined) e.error = nested;
  return e;
}

describe("classifyWalletError", () => {
  it("always returns two strings, whatever it is handed", () => {
    // The white-screen guarantee. `chain/session/useSessionKeyManager.ts` documents the incident
    // this promise exists to prevent: a channel typed `string | null` carrying an object, rendered
    // into JSX, taking the whole page down. Anything at all may arrive here.
    for (const junk of [null, undefined, 0, false, "", {}, [], new Error(), Symbol("x")]) {
      const f = classifyWalletError(junk);
      expect(typeof f.short, String(String(junk))).toBe("string");
      expect(typeof f.detail).toBe("string");
      expect(f.short.length).toBeGreaterThan(0);
      expect(f.detail.length).toBeGreaterThan(0);
    }
  });

  describe("rejected — the popup was cancelled", () => {
    it("reads Phantom's bare 4001", () => {
      expect(classifyWalletError({ code: 4001, message: "User rejected the request." }).code).toBe("rejected");
    });

    it("finds 4001 nested under the adapter's WalletError.error", () => {
      // This is the case a top-level `e.code` check misses entirely: the adapter wraps, and the
      // number only exists one level down.
      const e = walletError("WalletConnectionError", "Unexpected error", { code: 4001 });
      expect(classifyWalletError(e).code).toBe("rejected");
    });

    it("falls back to the wording when no code is present", () => {
      for (const msg of ["User rejected the request", "user denied transaction", "Request rejected", "User declined"]) {
        expect(classifyWalletError(new Error(msg)).code, msg).toBe("rejected");
      }
    });

    it("says nothing was spent, because that is the question a cancel raises", () => {
      const f = classifyWalletError({ code: 4001 });
      expect(f.detail).toMatch(/nothing was sent/i);
      expect(f.detail).toMatch(/again/i);
    });
  });

  describe("not-installed", () => {
    it("recognises the adapter's own error class by name", () => {
      expect(classifyWalletError(walletError("WalletNotReadyError", "")).code).toBe("not-installed");
    });

    it("recognises the plain wordings", () => {
      for (const msg of ["Phantom not detected", "wallet not installed", "no provider found"]) {
        expect(classifyWalletError(new Error(msg)).code, msg).toBe("not-installed");
      }
    });

    it("tells the reader the page needs a reload after installing", () => {
      expect(classifyWalletError(walletError("WalletNotReadyError", "")).detail).toMatch(/reload/i);
    });
  });

  describe("session-expired", () => {
    it("reads the program's own Error Code line out of transactionLogs", () => {
      // How this failure ACTUALLY arrives: anchor's message is the generic simulation wrapper, and
      // the only mention of the session is a log line.
      const e = {
        message: "Transaction simulation failed",
        transactionLogs: ["Program log: AnchorError caused by account: session_token. Error Code: InvalidToken."],
      };
      expect(classifyWalletError(e).code).toBe("session-expired");
    });

    it("recognises an expired session by wording", () => {
      expect(classifyWalletError(new Error("session token has expired")).code).toBe("session-expired");
    });

    it("outranks the network inference, because a lapsed session is the specific cause", () => {
      // Both patterns are present. The session is the finding; the blockhash is the symptom.
      const e = { message: "Transaction simulation failed", transactionLogs: ["Error Code: InvalidToken."] };
      expect(classifyWalletError(e).code).toBe("session-expired");
    });

    it("points at the one action that fixes it", () => {
      expect(classifyWalletError(new Error("SessionTokenNotFound")).detail).toMatch(/start a new session/i);
    });
  });

  describe("disconnected — Phantom hung up on us", () => {
    it("recognises the adapter's error class and the plain wording", () => {
      expect(classifyWalletError(walletError("WalletDisconnectedError", "")).code).toBe("disconnected");
      expect(classifyWalletError(new Error("Wallet disconnected")).code).toBe("disconnected");
    });

    it("reassures the player that their fighter is unaffected", () => {
      // The question a mid-round disconnect actually raises. The stake is on chain; the wallet going
      // away does not pull it out of the ring, and saying so is the whole job of this copy.
      const f = classifyWalletError(walletError("WalletDisconnectedError", ""));
      expect(f.detail).toMatch(/already deployed is on chain/i);
      expect(f.detail).toMatch(/reconnect|press connect/i);
    });
  });

  describe("wrong-network — an advisory about a popup, never a claim about the network", () => {
    it("fires on the RPC's own expired/unknown-blockhash strings", () => {
      for (const msg of [
        "Blockhash not found",
        "unknown blockhash",
        "block height exceeded",
        "Transaction has expired",
        "could not find blockhash",
      ]) {
        expect(classifyWalletError(new Error(msg)).code, msg).toBe("wrong-network");
      }
    });

    it("does NOT swallow a real program error behind a network story", () => {
      // A failed simulation is usually a genuine program failure. It used to match this branch, which
      // would have replaced the one message that names the actual cause with advice about a menu.
      const f = classifyWalletError({
        message: "Transaction simulation failed",
        transactionLogs: ["Program log: Error Code: NothingToExtract."],
      });
      expect(f.code).toBe("unknown");
      expect(f.detail).toContain("NothingToExtract");
    });

    it("leads with the fix that actually works — press it again", () => {
      // The blockhash is the finding; a network setting is at most a guess about a scary popup.
      const f = classifyWalletError(new Error("Blockhash not found"));
      expect(f.detail).toMatch(/^press the button again/i);
    });

    it("states the architecture truthfully: this page submits, so the wallet's network does not decide", () => {
      // The correction that matters. We call `signTransaction` and send the bytes ourselves over the
      // router — never `adapter.sendTransaction` — so a Phantom set to mainnet still produces a
      // signature that lands on devnet. Copy claiming otherwise would send people chasing a setting
      // that was never the problem.
      const f = classifyWalletError(new Error("Blockhash not found"));
      expect(f.detail).toMatch(/submits to devnet itself/i);
      expect(f.detail).toMatch(/does not decide whether a transaction lands/i);
    });

    it("explains the scary popup, and offers the switch path as a way to silence it", () => {
      const f = classifyWalletError(new Error("Blockhash not found"));
      expect(f.detail).toMatch(/looked unsafe/i);
      expect(f.detail).toContain(PHANTOM_DEVNET_STEPS);
    });

    it("never claims to have detected the wallet's network, because nothing can", () => {
      // There is no API for it: no property, no event, no usable Wallet Standard signal. If this
      // copy ever starts asserting a finding, it is asserting something unknowable.
      const f = classifyWalletError(new Error("Blockhash not found"));
      expect(f.detail).not.toMatch(/your wallet is on mainnet|phantom is on mainnet|detected/i);
    });
  });

  describe("the shared copy constants", () => {
    it("names the menu path by verbs, not by pixels", () => {
      // Phantom ships UI weekly; a path survives that, a screenshot description does not.
      expect(PHANTOM_DEVNET_STEPS).toContain("Developer Settings");
      expect(PHANTOM_DEVNET_STEPS).toContain("Testnet Mode");
      // Devnet and Testnet are two different networks and picking the wrong one looks identical.
      expect(PHANTOM_DEVNET_STEPS).toContain("not Solana Testnet");
    });

    it("states the page's own network unconditionally — the only thing that is always true", () => {
      expect(DEVNET_ONLY_NOTE).toMatch(/devnet only/i);
      expect(DEVNET_ONLY_NOTE).toMatch(/real funds/i);
    });
  });

  describe("unknown — the chain's own words, unedited", () => {
    it("keeps a program error verbatim rather than paraphrasing it", () => {
      const msg = "custom program error: NothingToExtract";
      const f = classifyWalletError(new Error(msg));
      expect(f.code).toBe("unknown");
      // The presenter-reads-it-aloud rule. A paraphrase here would be a regression.
      expect(f.short).toContain(msg);
      expect(f.detail).toContain(msg);
    });

    it("still says something useful when the throw carries no text at all", () => {
      const f = classifyWalletError({});
      expect(f.code).toBe("unknown");
      expect(f.detail).toMatch(/try the action again|reload/i);
    });
  });
});

/**
 * THE EMPTY-MESSAGE CLASS, which is the gap that let a blank red toast ship.
 *
 * Every `WalletError` subclass in `@solana/wallet-adapter-base` is `constructor() { super(...arguments) }`
 * and `PhantomWalletAdapter` throws them with NO ARGUMENTS, so `.message` is `""` and `.name` is the
 * only information that exists. These are constructed here EXACTLY as the adapter constructs them —
 * a test that passed a message string would have gone green while the real path rendered nothing.
 *
 * Rebuilt locally rather than imported so the shape under test is the shape observed in the compiled
 * package, and so a future version that starts supplying default messages cannot quietly make this
 * test stop covering the case it was written for.
 */
function adapterError(name: string): Error {
  const e = new Error();
  e.name = name;
  return e;
}

describe("the wallet-adapter errors that arrive with nothing but a class name", () => {
  it.each([
    ["WalletNotConnectedError", "disconnected"],
    ["WalletDisconnectedError", "disconnected"],
    ["WalletDisconnectionError", "disconnected"],
  ])("%s classifies as %s rather than falling through to unknown", (name, code) => {
    const f = classifyWalletError(adapterError(name));
    expect(f.code).toBe(code);
  });

  // The one that actually reached a player: Phantom goes away mid-`enter`, `signTransaction` throws
  // `WalletNotConnectedError`, and the toast got `e.message` — an empty string.
  it("gives a mid-action disconnect the reassurance that matters, not a blank toast", () => {
    const f = classifyWalletError(adapterError("WalletNotConnectedError"));
    expect(f.detail).toMatch(/reconnect/i);
    // Their fighter is still in the round; a player watching a fight needs to hear that first.
    expect(f.detail).toMatch(/already deployed|unaffected/i);
  });

  it.each([
    "WalletAccountError",
    "WalletConnectionError",
    "WalletPublicKeyError",
    "WalletSendTransactionError",
    "WalletSignTransactionError",
  ])("%s still yields copy a person can act on", (name) => {
    const f = classifyWalletError(adapterError(name));
    // Never the bare class name as the whole answer, and never empty.
    expect(f.short.trim()).not.toBe("");
    expect(f.detail.trim()).not.toBe("");
    expect(f.detail).not.toBe(name);
    expect(f.detail.length).toBeGreaterThan(name.length + 20);
    // It still names the class, so a bug report can quote it.
    expect(f.detail).toContain(name);
    expect(f.detail).toMatch(/try the action again|reload|unlocked/i);
  });

  it("does not mistake a nameless empty Error for a wallet class", () => {
    const f = classifyWalletError(new Error(""));
    expect(f.code).toBe("unknown");
    expect(f.detail).toMatch(/without reporting a reason/i);
  });
});

describe("connectFailedFault", () => {
  it("covers the case with no error to classify — connect resolved with no account", () => {
    const f = connectFailedFault();
    expect(f.code).toBe("connect-failed");
    expect(f.detail).toMatch(/unlocked/i);
  });
});
