// The classifier is the only thing standing between a stranger and a raw `SendTransactionError`, so
// the cases here are the SHAPES the three throwing libraries actually produce — a bare Phantom
// object with a numeric code, an adapter `WalletError` with the provider nested under `.error`, and
// an anchor error whose useful half is in `transactionLogs` — rather than hand-written strings that
// only prove the regexes match themselves.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEVNET_ONLY_NOTE,
  PHANTOM_DEVNET_STEPS,
  SESSION_INVALID_TOKEN_CODE,
  classifyWalletError,
  connectFailedFault,
} from "./walletFault.ts";
import { baseLayerError, routerError } from "./chainErrorShapes.ts";
import gplSessionIdl from "../../../node_modules/@magicblock-labs/gum-sdk/lib/idl/gpl_session.json" with { type: "json" };

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
    // THIS BLOCK USED TO BE ENTIRELY BASE-LAYER, AND THAT IS WHY THE FEATURE IT GUARDS WAS DEAD.
    //
    // `session-expired` is not a message; it is a TRIGGER. `autoSession.ts`'s `afterRefusal` reads it
    // and answers by replacing the session key and re-sending the move, so a lapsed session is
    // something a player watches happen rather than something they have to read. Every case below the
    // rollup ones is a base-layer shape — Anchor's `Error Code:` line, or an SDK sentence — and the
    // base layer is not where a session-signed transaction runs. Every live round is delegated, so
    // `enter` and `extract` go through the Magic Router into the ER, and the ER answers with
    // `custom program error: 0x1771` and NOTHING ELSE. The renewal therefore never fired in
    // production: the player got a raw hex toast mid-fight, and six green tests said otherwise.
    //
    // WHAT IS PROVEN AND WHAT IS RECONSTRUCTED, said plainly, because guessing at wording is the
    // exact bug being fixed here and doing it twice would be worse than not fixing it:
    //
    //   PROVEN — the ROLLUP'S SHAPE. Captured off devnet (`chainErrorShapes.ts`), and independently
    //   corroborated by a green run of `scripts/verify-house-take.ts`, whose non-authority negative
    //   control could only pass through its `custom program error: 0x([0-9a-f]+)` + IDL-lookup
    //   fallback, because the `Error Code:` path found nothing to read on the ER.
    //
    //   PROVEN — THAT AN EXPIRED TOKEN IS REFUSED WITH `InvalidToken`. `verify-session-base.mjs`
    //   step 5, green, quoted in `autoSession.ts`: a real expired token presented by its own real
    //   session key. BASE LAYER, deliberately — that script exists because names survive there.
    //
    //   RECONSTRUCTED — THE TWO PUT TOGETHER. No capture exists anywhere in this repo of a dead
    //   session key failing THROUGH the ER. `verify-session-real.mjs` has two negative controls aimed
    //   at exactly that (`expectInvalidToken`, steps 5 and 9) and commit e7976cf records that the only
    //   run of it aborted at validator selection, long before reaching them; MEGA_QUEUE.md claims no
    //   green run of it either. So `routerError("0x1771")` below is the rollup shape carrying the
    //   number the base layer proved, not a transcription of an observed failure. If somebody ever
    //   lands a real ER session capture, it belongs in `chainErrorShapes.ts` and this note should say
    //   so instead.

    it("reads the ROLLUP's hex code, which on that path is the only signal there is", () => {
      // See the reconstruction note above: the SHAPE is captured, the NUMBER is proven, the
      // combination is inferred. `0x1771` is `SessionError::InvalidToken` (6001).
      expect(classifyWalletError(routerError("0x1771")).code).toBe("session-expired");
    });

    it("is what makes the automatic renewal reachable at all, which is the whole point", () => {
      // A CLASSIFICATION IS NOT THE FEATURE. `afterRefusal` is, and it is keyed on this exact code —
      // so this assertion is the one that says the rollup path now renews instead of shouting hex at
      // somebody mid-fight. Asserted here rather than in `autoSession.test.ts` because the thing that
      // was broken is the classification, and that file already proves the plan given the code.
      const fault = classifyWalletError(routerError("0x1771"));
      expect(fault.code).toBe("session-expired");
      expect(fault.detail).toMatch(/press the button again/i);
    });

    it("still refuses the hex codes that are NOT the session, on the same shape", () => {
      // The rollup gives no name, so the number is the entire discrimination and a classifier that
      // claimed the shape rather than the code would swallow every program error on the page into a
      // session renewal — spending two Phantom approvals and 0.02 SOL answering `NothingToExtract`.
      for (const hex of ["0x1772", "0x1786", "0x177b", "0x1770"]) {
        expect(classifyWalletError(routerError(hex)).code, hex).toBe("unknown");
      }
    });

    it("agrees with `entryWindow.ts` about who owns 0x1771", () => {
      // TWO CLASSIFIERS, ONE NUMBER, AND THEY MUST NOT BOTH CLAIM IT. `entryWindow.test.ts` asserts
      // that the entry-refusal classifier returns null for `0x1771` — because in ITS vocabulary the
      // number is `ArenaError::RoundOutOfOrder` and rewriting a session refusal as "the round moved
      // on" would stop `afterRefusal` renewing anything, silently. This is the other half of that
      // agreement, and the two tests should be read together.
      expect(classifyWalletError(routerError("0x1771")).code).toBe("session-expired");
    });

    it("reads the BASE layer's Anchor logs too, which must not regress", () => {
      // `AnchorError caused by account: session_token` is the constraint form, which is how a lapsed
      // token names itself when logs survive — a round that has undelegated, or any script under
      // `scripts/` that deliberately tests on the base layer.
      const e = baseLayerError("InvalidToken", SESSION_INVALID_TOKEN_CODE, "Invalid session token", "session_token");
      expect(classifyWalletError(e).code).toBe("session-expired");
    });

    it("pins 6001 against gum-sdk's own IDL, since nothing else can", () => {
      // THE ONE NUMBER ON THIS PAGE THAT IS WRITTEN DOWN RATHER THAN LOOKED UP, and this is what
      // stops it rotting. `SessionError` belongs to the session-keys crate, not to bulls-arena, so it
      // is in NEITHER our IDL nor our error table and `errorCodeOf` has nothing to read. The true
      // source is `session-keys 3.1.1`'s Rust enum (pinned at `programs/bulls-arena/Cargo.toml:52`,
      // `ValidityTooLong` then `InvalidToken`); gum-sdk ships the same crate's IDL, which is the
      // nearest thing to it JavaScript can reach. If a session-keys upgrade ever inserts a variant
      // above `InvalidToken`, this fails here rather than in front of a player.
      const invalidToken = gplSessionIdl.errors.find((e) => e.name === "InvalidToken");
      expect(invalidToken?.code).toBe(SESSION_INVALID_TOKEN_CODE);
    });

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

    it("points at the one action that fixes it — which is now the button they already pressed", () => {
      // It used to send the reader to the wallet panel to start a session by hand. A lapsed session
      // is replaced by the next move on its own (`autoSession.ts`'s `afterRefusal`), so these words
      // only surface when THAT failed too — and the thing to do then is press again, not go hunting
      // for a control. It must also not promise a single approval: replacing a session costs two,
      // because the old key has to be closed before a new one can be opened.
      const detail = classifyWalletError(new Error("SessionTokenNotFound")).detail;
      expect(detail).toMatch(/press the button again/i);
      expect(detail).not.toMatch(/wallet panel/i);
      expect(detail).not.toMatch(/one Phantom approval/i);
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

// ---------------------------------------------------------------------------------------------
// The premise underneath `SESSION_INVALID_TOKEN_CODE`, held up rather than remembered
// ---------------------------------------------------------------------------------------------

describe("the assumption that lets this module read 0x1771 as a session", () => {
  /** Every named import this bundle takes from `chain/round.ts`, with aliases resolved back to the
   *  exported name. Source-level rather than runtime because the question is what the BUNDLE can
   *  send, and a module that is imported but never called is still a module somebody will call. */
  function instructionsTheBrowserImports(): Set<string> {
    const src = join(import.meta.dirname, "..", "..");
    const imported = new Set<string>();
    for (const rel of readdirSync(src, { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/.test(rel) || rel.endsWith(join("chain", "round.ts"))) continue;
      const text = readFileSync(join(src, rel), "utf8");
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*(?:\.\/|\/)round\.ts"/g)) {
        for (const clause of m[1].split(",")) {
          const name = clause.trim().split(/\s+as\s+/)[0].trim();
          if (name !== "" && name !== "type") imported.add(name);
        }
      }
    }
    return imported;
  }

  it("never builds an authority instruction, which is what makes 6001 unambiguous here", () => {
    // THE ARGUMENT THIS TEST EXISTS TO STOP ROTTING. `SessionError::InvalidToken` and
    // `ArenaError::RoundOutOfOrder` are BOTH 6001, both returned by the same program id, and through
    // the rollup both arrive as a bare `custom program error: 0x1771` with no name attached — a
    // collision this repo reported upstream in `MAGICBLOCK_FEEDBACK.md` and which `verify-session-
    // base.mjs` calls "the whole point" of matching names on the base layer.
    //
    // This module can read the number anyway, for one reason and one only: `RoundOutOfOrder` is
    // raised in exactly one place — `open_round` (`programs/bulls-arena/src/lib.rs:1558`), gated on
    // the arena authority — and NOTHING IN THE BROWSER BUILDS IT. That is a property of the caller,
    // not of the error, so it is the kind of claim that is true until an admin panel lands in this
    // bundle and nobody connects the two. Then an operator whose round counter was out of step would
    // be told their session expired, and the page would burn two Phantom approvals renewing a
    // perfectly good session key.
    //
    // FAILS LOUDLY AND POINTS AT THE RIGHT PLACE. If this goes red, the fix is not to widen the list:
    // it is to give `classifyWalletError` a way to tell the two apart, or to stop reading the number.
    const authorityOnly = [
      "initArena", "openRound", "delegateRound", "closeLobbyAndDraw", "resolve",
      "abandonRound", "closeRound", "setFeeBps", "initTreasury", "sweepHouseTake", "closeRoundAccount",
    ];
    const imported = instructionsTheBrowserImports();
    // Real first: a scan that matched nothing would satisfy every absence below while proving nothing.
    expect(imported).toContain("enter");
    expect(imported).toContain("extract");
    expect(imported).toContain("tick");
    for (const name of authorityOnly) expect([...imported], name).not.toContain(name);
  });
});
