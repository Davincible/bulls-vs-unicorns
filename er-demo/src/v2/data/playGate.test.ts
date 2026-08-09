// The funnel, enumerated. Every branch here renders as an instruction to a stranger who has never
// seen this page, so the tests check the WORDS as well as the code — a `PlayBlock` with the right
// `code` and useless copy is exactly the failure SPEC.md's copy rule was written against.
//
// The invariants at the bottom are the ones worth keeping forever: every block answers all three
// questions, and no block is a dead end.

import { describe, expect, it } from "vitest";
import { playBlock, type PlayGateInput } from "./playGate.ts";
import { classifyWalletError } from "./walletFault.ts";

const PUBKEY = "6dQmS8x1YAtLPMuVfrfeQGKtZRDe6dTr8SafMDaFhTd2";

/** A connected wallet with money — every field in the state where it blocks nothing. */
const READY: PlayGateInput = {
  mode: "wallet",
  programReady: true,
  walletStatus: "connected",
  providerPresent: true,
  fault: null,
  solBalance: 1.5,
  pubkey: PUBKEY,
};

describe("playBlock — when nothing is in the way", () => {
  it("returns null for a connected, funded wallet", () => {
    expect(playBlock(READY)).toBeNull();
  });

  it("returns null for the burner path, which is connected by construction", () => {
    expect(playBlock({ ...READY, mode: "burner", walletStatus: "connected" })).toBeNull();
  });

  it("does not block on an unread balance — not-read-yet is not zero", () => {
    // The first balance poll can land after the first round poll. Blocking here would dark every
    // control on the page for a second on every single load; `shouldDriveFight` already treats the
    // same `null` the same way, and the two must not disagree.
    expect(playBlock({ ...READY, solBalance: null })).toBeNull();
  });

  it("does not require a session key — a session is ergonomics, not a precondition", () => {
    // There is no session input at all, and that is the point: `enter`/`extract` work without one,
    // just with a popup each. A gate that demanded a session would invent a rule the chain does not
    // have. This test exists to make removing that property a deliberate act.
    expect(playBlock(READY)).toBeNull();
  });
});

describe("playBlock — the order is the order of the funnel", () => {
  it("puts the program first: with nothing to build, nothing else matters yet", () => {
    const b = playBlock({ ...READY, programReady: false, walletStatus: "unsupported", solBalance: 0 });
    expect(b?.code).toBe("no-program");
  });

  it("does not also tell a visitor with no extension that they have no SOL", () => {
    // One thing to fix at a time. Two instructions at once is how a funnel loses people.
    const b = playBlock({ ...READY, walletStatus: "unsupported", providerPresent: false, solBalance: 0 });
    expect(b?.code).toBe("not-installed");
  });

  it("asks for a connection before it asks about money", () => {
    const b = playBlock({ ...READY, walletStatus: "disconnected", solBalance: 0 });
    expect(b?.code).toBe("not-connected");
  });
});

describe("no wallet extension", () => {
  it("offers the install, and says the page needs a reload afterwards", () => {
    const b = playBlock({ ...READY, walletStatus: "unsupported", providerPresent: false });
    expect(b?.code).toBe("not-installed");
    expect(b?.detail).toMatch(/reload/i);
    expect(b?.cta).toEqual({ kind: "install", label: "Install Phantom", href: "https://phantom.app/download" });
  });

  it("says up front that this is a devnet page, since nothing can detect the wallet's network", () => {
    const b = playBlock({ ...READY, walletStatus: "unsupported", providerPresent: false });
    expect(b?.detail).toMatch(/devnet only/i);
  });

  it("does NOT tell someone who has Phantom to install Phantom", () => {
    // The adapter needs `window.isPhantomInstalled` AND a provider; a build that injects only the
    // provider sits at NotDetected forever. Telling that visitor to install the thing they are
    // looking at is the worst copy this page could produce.
    const b = playBlock({ ...READY, walletStatus: "unsupported", providerPresent: true });
    expect(b?.code).toBe("wallet-unannounced");
    expect(b?.detail).not.toMatch(/install phantom/i);
    expect(b?.detail).toMatch(/reload/i);
    // And the escape hatch, for a developer who just wants to work.
    expect(b?.detail).toContain("?signer=burner");
  });
});

describe("connecting, and the ways connecting ends badly", () => {
  it("says where the popup is and when the wait ends", () => {
    const b = playBlock({ ...READY, walletStatus: "connecting" });
    expect(b?.code).toBe("connecting");
    expect(b?.detail).toMatch(/approve/i);
    expect(b?.detail).toMatch(/toolbar/i);
    // Nothing to press — the control is in the extension, not on the page.
    expect(b?.cta).toBeNull();
  });

  it("carries the wallet's own reason forward rather than a generic failure", () => {
    // "You cancelled", "Phantom disconnected this site" and "your session key is no longer valid"
    // need three different next actions. Flattening them to "connection failed" deletes all three.
    const fault = classifyWalletError({ code: 4001 });
    const b = playBlock({ ...READY, walletStatus: "disconnected", fault });
    expect(b?.code).toBe("connect-failed");
    expect(b?.short).toBe(fault.short);
    expect(b?.detail).toBe(fault.detail);
    expect(b?.cta?.kind).toBe("connect");
  });

  it("reassures a player disconnected mid-round that their fighter is still in", () => {
    const fault = classifyWalletError(Object.assign(new Error(""), { name: "WalletDisconnectedError" }));
    const b = playBlock({ ...READY, walletStatus: "disconnected", fault });
    expect(b?.detail).toMatch(/already deployed is on chain/i);
  });

  it("invites a first-time visitor plainly when nothing has gone wrong yet", () => {
    const b = playBlock({ ...READY, walletStatus: "disconnected", fault: null });
    expect(b?.code).toBe("not-connected");
    // The page is worth reading before connecting, and saying so is what stops a connect wall from
    // reading as a paywall.
    expect(b?.detail).toMatch(/without connecting/i);
    expect(b?.cta?.kind).toBe("connect");
  });
});

describe("zero balance", () => {
  it("names the faucet for a real visitor, and says when the number moves", () => {
    const b = playBlock({ ...READY, solBalance: 0 });
    expect(b?.code).toBe("no-sol");
    expect(b?.detail).toMatch(/faucet\.solana\.com/);
    expect(b?.detail).toMatch(/fifteen seconds/i);
    expect(b?.cta).toEqual({ kind: "faucet", label: "Get devnet SOL", href: "https://faucet.solana.com" });
  });

  it("never offers the in-app airdrop as the answer", () => {
    // Devnet's faucet rate-limits `requestAirdrop` to uselessness — five consecutive 429s, measured
    // 2026-08-09. Offering it here would be offering a button that does not work.
    const b = playBlock({ ...READY, solBalance: 0 });
    expect(b?.detail).not.toMatch(/airdrop/i);
    expect(b?.cta?.kind).not.toBe("retry");
  });

  it("states the balance as a fact about devnet, not as a diagnosis of the wallet's network", () => {
    // The correction that matters most in this file. This number comes from OUR devnet RPC, so
    // Phantom's setting cannot move it: zero means zero devnet SOL and nothing else. The Mainnet
    // sentence describes what PHANTOM is showing the reader — it must never read as a finding about
    // what we detected, because no dapp can detect it.
    //
    // The Mainnet sentence now lives on `aside` rather than `detail` — a hierarchy change, not a
    // retreat from the claim. It is asserted here just as strictly, in its new home, because the way
    // it is phrased is the whole point of this test.
    const b = playBlock({ ...READY, solBalance: 0 });
    expect(b?.short).toBe("this wallet holds no devnet SOL");
    expect(b?.aside).toMatch(/Seeing a balance in Phantom\? That is your Mainnet balance/);
    const said = `${b?.detail ?? ""} ${b?.aside ?? ""}`;
    expect(said).not.toMatch(/you are on mainnet|your wallet is on mainnet|we detected/i);
  });

  it("tells a developer to run the script instead of chasing a faucet", () => {
    const b = playBlock({ ...READY, mode: "burner", solBalance: 0 });
    expect(b?.code).toBe("no-sol");
    expect(b?.detail).toContain(`bun scripts/fund-wallet.mjs ${PUBKEY}`);
    // The public faucet is not the burner's route — the script is the one that always works.
    expect(b?.detail).not.toMatch(/faucet\.solana\.com/);
  });
});

describe("invariants every block must hold", () => {
  /** One input per reachable code, so the loops below cover the whole surface. */
  const EVERY: PlayGateInput[] = [
    { ...READY, programReady: false },
    { ...READY, walletStatus: "unsupported", providerPresent: false },
    { ...READY, walletStatus: "unsupported", providerPresent: true },
    { ...READY, walletStatus: "connecting" },
    { ...READY, walletStatus: "disconnected", fault: classifyWalletError({ code: 4001 }) },
    { ...READY, walletStatus: "disconnected" },
    { ...READY, solBalance: 0 },
    { ...READY, mode: "burner", solBalance: 0 },
  ];

  it("covers every code, so nothing below is vacuous", () => {
    const codes = EVERY.map((i) => playBlock(i)?.code);
    // Every input blocks — a `null` here would mean an invariant below silently checked nothing.
    expect(codes).not.toContain(undefined);
    // `no-sol` appears twice on purpose: it is one code with two entirely different remedies, one
    // for a stranger and one for a developer, and both are asserted above.
    expect(new Set(codes)).toEqual(
      new Set([
        "no-program",
        "not-installed",
        "wallet-unannounced",
        "connecting",
        "connect-failed",
        "not-connected",
        "no-sol",
      ]),
    );
  });

  it("answers all three of SPEC.md's questions in every state", () => {
    for (const input of EVERY) {
      const b = playBlock(input);
      // (1) what is true: one clause, lower-case start, no trailing full stop — it is rendered
      // inline after a dash.
      expect(b?.short, JSON.stringify(input)).toBeTruthy();
      expect(b?.short.endsWith(".")).toBe(false);
      // (2) what to do and (3) when it changes: real sentences, not a fragment.
      expect(b!.detail.length).toBeGreaterThan(60);
      expect(b!.detail.trim().endsWith(".")).toBe(true);
    }
  });

  it("leaves no dead ends — every state names an action, or says plainly there is none", () => {
    for (const input of EVERY) {
      const b = playBlock(input)!;
      // SPEC.md allows the honest third answer: "plainly that there is none right now". `no-program`
      // is exactly that — the page is fetching an IDL and there is genuinely nothing for a reader to
      // do but wait, so inventing a button for it would be worse than saying so.
      const hasControl = b.cta !== null;
      const tellsThemWhereToGo = /reload|terminal|approve|faucet|bun scripts/i.test(b.detail);
      const saysThereIsNothingToDo = /nothing is required from you|on their own/i.test(b.detail);
      expect(hasControl || tellsThemWhereToGo || saysThereIsNothingToDo, b.code).toBe(true);
    }
  });

  it("says when a no-action state will end, since that is all a waiting reader can act on", () => {
    const b = playBlock({ ...READY, programReady: false })!;
    expect(b.cta).toBeNull();
    expect(b.detail).toMatch(/second or two/i);
  });

  it("never blames the reader", () => {
    for (const input of EVERY) {
      const b = playBlock(input)!;
      expect(b.detail, b.code).not.toMatch(/you failed|invalid user|you must not/i);
    }
  });

  /**
   * THE CONTRACT THAT LETS A SURFACE DROP `aside`.
   *
   * The compact dock renders `short` + `detail` + the control and nothing else, so if an `aside`
   * ever carried a step somebody had to take, the dock would be silently withholding the answer —
   * the disabled-control bug again, one level down. `detail` must therefore be complete on its own,
   * and `aside` must only ever explain.
   *
   * Without this test `aside` becomes the place instructions get quietly parked when `detail` starts
   * feeling long, which is precisely how the ninety-word `no-sol` paragraph happened in the first
   * place.
   */
  it("keeps every instruction in `detail`, so a surface that drops `aside` still answers", () => {
    for (const input of EVERY) {
      const b = playBlock(input)!;
      if (b.aside === undefined) continue;
      // The remedy and the deadline live above; the aside is context for a subset of readers.
      expect(b.detail.length, b.code).toBeGreaterThan(60);
      expect(b.detail.trim().endsWith("."), b.code).toBe(true);
      const asideOnlyRoute =
        /reload|terminal|approve|faucet|bun scripts/i.test(b.aside) &&
        !/reload|terminal|approve|faucet|bun scripts/i.test(b.detail);
      expect(asideOnlyRoute, `${b.code}: the only route out is hidden in the aside`).toBe(false);
    }
  });

  it("splits no-sol so the funnel leads with the remedy, not with Phantom's settings", () => {
    const b = playBlock({ ...READY, solBalance: 0 })!;
    // What unblocks essentially everyone in this state.
    expect(b.detail).toMatch(/faucet\.solana\.com/i);
    // The four-step Phantom walk is for the confused subset and does not belong in the primary line:
    // the wallet's cluster changes nothing here, so it is an explanation, not an instruction.
    expect(b.detail).not.toMatch(/Testnet Mode/i);
    expect(b.aside).toMatch(/Testnet Mode/i);
    expect(b.aside).toMatch(/Mainnet balance/i);
    // And it must still never read as a claim that we detected the network.
    expect(b.aside).not.toMatch(/we detected|your wallet is on|you are on mainnet/i);
  });

  it("keeps the burner's no-sol free of an aside — a developer with a script needs no digression", () => {
    expect(playBlock({ ...READY, mode: "burner", solBalance: 0 })!.aside).toBeUndefined();
  });
});
