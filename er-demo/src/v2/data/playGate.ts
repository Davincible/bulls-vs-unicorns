// THE ONE VERDICT BEHIND EVERY DISABLED CONTROL ON THE PAGE.
//
// SPEC.md's copy rule is the whole reason this module exists rather than a handful of `disabled={}`
// expressions: "a button a player cannot press must say why, and what would make it pressable". A
// page that answers that question in six places answers it six different ways, and five of them go
// stale. So the question is asked ONCE, here, and every surface renders the same answer: the Deploy
// buttons, the Extract button and its dock, the session panel, and the copy in `roundPhaseCopy.ts`.
//
// EVERY BLOCK CARRIES THREE THINGS, in SPEC.md's order — what is true (`short`), what the player can
// do and when it changes (`detail`), and the control that would end it (`cta`). A block with no
// route out of it is a bug in this file, not a state of the world.
//
// WHAT THIS DOES NOT DO: it does not gate on a session key. A session is an ERGONOMIC upgrade — one
// approval instead of one per action — not a precondition. Without one, `enter`/`extract` still work
// and simply open a Phantom popup each time. Blocking play on a session would invent a requirement
// the chain does not have. (The FIGHT TICKER is different and IS gated on it — see
// `shouldDriveFight`, where the cost is 2.5 popups a second.)
//
// THE ORDER IS THE ORDER OF THE FUNNEL. A visitor with no extension is not also told they have no
// SOL; the first thing standing between them and playing is the only thing they are asked to fix.

import type { SignerMode } from "./flags.ts";
import { DEVNET_ONLY_NOTE, PHANTOM_DEVNET_STEPS, type WalletFault } from "./walletFault.ts";
import type { WalletStatus } from "./walletConnection.ts";

export type PlayBlockCode =
  | "no-program"
  | "not-installed"
  | "wallet-unannounced"
  | "connecting"
  | "connect-failed"
  | "not-connected"
  | "no-sol";

export interface PlayBlockCta {
  kind: "install" | "connect" | "retry" | "faucet";
  label: string;
  /** Present only for the two that leave the page. */
  href?: string;
}

export interface PlayBlock {
  code: PlayBlockCode;
  /** (1) WHAT IS TRUE NOW — one clause, lower-case, no trailing period. Rendered inline inside
   *  sentences the caller owns: `Unavailable — ${short}.` */
  short: string;
  /** (2) WHAT THE PLAYER CAN DO and (3) WHEN IT CHANGES. Full sentences, and NOTHING ELSE — see
   *  `aside`. */
  detail: string;
  /**
   * A SECONDARY EXPLANATION FOR A SUBSET OF READERS, and never a step anyone must take.
   *
   * THE INVARIANT: everything a player must DO is in `detail`. If a sentence here were load-bearing,
   * a surface that renders only `detail` would be withholding the answer — so `aside` is safe to
   * drop, and the compact dock drops it. `playGate.test.ts` asserts this directly.
   *
   * It exists because `no-sol` had grown to about ninety words: what is true, the remedy, then an
   * explanation of Phantom's Mainnet display, then four navigation steps for a setting that — as
   * `walletFault.ts` establishes at length — changes nothing in this app. All of it rendered inline
   * in a 320px dock AND a 420px rail, twice on one screen with the rail open, burying the one
   * sentence that actually unblocks the reader ("devnet SOL is free, here is the faucet"). The
   * hierarchy was wrong, so the fix is structural rather than shorter words.
   */
  aside?: string;
  cta: PlayBlockCta | null;
}

export interface PlayGateInput {
  mode: SignerMode;
  /** False while the IDL is still loading or failed — nothing can be built, let alone signed. */
  programReady: boolean;
  walletStatus: WalletStatus;
  /** A Phantom-shaped provider is in the page, whatever the adapter's readiness says. Wallet mode
   *  only; see `hasInjectedPhantom`. */
  providerPresent: boolean;
  /** The last thing the wallet said no with, if anything. */
  fault: WalletFault | null;
  /** SOL on devnet. `null` means the first balance poll has not landed, which is NOT zero. */
  solBalance: number | null;
  /** The address the copy should name when telling a developer how to fund the burner. Wallet mode
   *  never reads it. */
  pubkey: string;
}

/** Re-exported so a UI surface can render the always-on network statement without importing two
 *  modules to build one panel. The words live in `walletFault.ts`; this is a pointer, not a copy. */
export { DEVNET_ONLY_NOTE };

/**
 * WHY THE PLAYER CANNOT ACT, or `null` when they can.
 *
 * `solBalance === null` is deliberately not a block. The first balance poll can land after the first
 * round poll, and refusing in that window would dark every control on the page for a second on every
 * load — the same reasoning `shouldDriveFight` already applies to the same value. Not-read-yet is
 * not zero.
 */
export function playBlock(input: PlayGateInput): PlayBlock | null {
  const { mode, programReady, walletStatus, providerPresent, fault, solBalance, pubkey } = input;

  if (!programReady) {
    return {
      code: "no-program",
      short: "the arena program has not loaded yet",
      detail:
        "This page is still fetching the program's interface from devnet, so it cannot build a " +
        "transaction yet. Nothing is required from you — the controls come alive on their own, " +
        "usually within a second or two. If this persists, devnet is unreachable from here.",
      cta: null,
    };
  }

  if (mode === "wallet") {
    if (walletStatus === "unsupported") {
      // The two ways "no wallet" happens, and they need opposite instructions.
      return providerPresent
        ? {
            code: "wallet-unannounced",
            short: "Phantom is in this browser but did not announce itself to the page",
            detail:
              "A Phantom extension is present, but it has not signalled that it is ready, so the " +
              "connect button cannot open it. Reload the page — this usually clears it. If it does " +
              "not, the burner-key build (add ?signer=burner to this page's address) plays without " +
              "any extension at all.",
            cta: { kind: "retry", label: "Reload the page" },
          }
        : {
            code: "not-installed",
            short: "no Phantom wallet was detected in this browser",
            detail:
              "Playing needs a Solana wallet to sign with, and there is no Phantom extension here " +
              "for the page to talk to. Install Phantom, then reload this page — the connect button " +
              "goes live as soon as the extension is there. " +
              DEVNET_ONLY_NOTE,
            cta: { kind: "install", label: "Install Phantom", href: "https://phantom.app/download" },
          };
    }

    if (walletStatus === "connecting") {
      return {
        code: "connecting",
        short: "waiting for you to approve the connection in Phantom",
        detail:
          "Phantom has been asked to connect and is waiting on you. Approve it in the extension " +
          "popup — if you cannot see the popup, open Phantom from your browser's toolbar. This " +
          "clears the moment you approve or cancel.",
        cta: null,
      };
    }

    if (walletStatus === "disconnected") {
      // A fault carries better words than any generic message: "you cancelled", "Phantom
      // disconnected this site", "your session key is no longer valid" each name a different thing
      // to do next. Only fall back to the plain invitation when nothing has gone wrong yet.
      if (fault !== null) {
        return {
          code: "connect-failed",
          short: fault.short,
          detail: fault.detail,
          cta: { kind: "connect", label: "Connect Phantom" },
        };
      }
      return {
        code: "not-connected",
        short: "no wallet is connected",
        detail:
          "Connect your Phantom wallet to deploy into a round. It takes one approval, and you can " +
          "read the arena, the rosters and the history without connecting at all. " +
          DEVNET_ONLY_NOTE,
        cta: { kind: "connect", label: "Connect Phantom" },
      };
    }
  }

  if (solBalance === 0) {
    // BURNER: a developer, on their own machine, with a script that always works.
    if (mode === "burner") {
      return {
        code: "no-sol",
        short: "this burner key holds no devnet SOL",
        detail:
          `The burner cannot pay a transaction fee with a zero balance. Fund it from a terminal: ` +
          `bun scripts/fund-wallet.mjs ${pubkey} — the balance here refreshes within about fifteen ` +
          `seconds of it landing.`,
        cta: null,
      };
    }
    // WALLET: a stranger, whose wallet is real and whose devnet balance genuinely is zero.
    //
    // THIS IS NOT A NETWORK DIAGNOSIS. The balance is read from OUR devnet RPC (`BASE_RPC`), so
    // Phantom's own network setting cannot move this number — zero here means zero devnet SOL and
    // nothing else. The second sentence exists only because a visitor whose Phantom is on Mainnet is
    // looking at a healthy balance while this page says zero, and that contradiction is worth
    // pre-empting; it describes what PHANTOM is showing them, and claims nothing about what we
    // detected, because a dapp cannot read the wallet's cluster at all.
    return {
      code: "no-sol",
      short: "this wallet holds no devnet SOL",
      detail:
        "Entering a round costs a devnet transaction fee, and this wallet's devnet balance is zero. " +
        "Devnet SOL is free: get some at faucet.solana.com and the balance here updates within " +
        "about fifteen seconds.",
      // FOR THE READER LOOKING AT A HEALTHY BALANCE IN PHANTOM while this page says zero — a real
      // and confusing contradiction, and the only reason these words exist. It is an explanation,
      // not an instruction: nobody has to change a setting to play, because the cluster Phantom is
      // pointed at changes only what Phantom SHOWS (see `walletFault.ts`). Which is exactly why it
      // belongs out of the funnel's primary line.
      aside:
        "Seeing a balance in Phantom? That is your Mainnet balance — this arena is devnet only, and " +
        "your wallet's setting does not stop you playing here. To make Phantom show your devnet " +
        "balance instead: " +
        PHANTOM_DEVNET_STEPS,
      cta: { kind: "faucet", label: "Get devnet SOL", href: "https://faucet.solana.com" },
    };
  }

  return null;
}
