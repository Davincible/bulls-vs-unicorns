// EVERY WAY A WALLET CAN SAY NO, turned into two strings a player can act on.
//
// Three different libraries throw into this app's write path and none of them agree on a shape:
// `@solana/wallet-adapter-base` throws `WalletError` subclasses carrying the provider's own error
// under an untyped `.error`; Phantom's injected provider throws bare objects with a numeric EIP-1193
// -style `code` (4001 = the user clicked Cancel); `@coral-xyz/anchor` and the router throw
// `SendTransactionError`s whose useful half is buried in `transactionLogs`. A UI that renders any of
// them raw shows a stranger a stack trace, and a UI that flattens them all to "something went wrong"
// deletes the one sentence that would have unblocked them.
//
// NOTHING HERE PARAPHRASES A PROGRAM ERROR. `unknown` — the default — keeps the original message
// verbatim, because "custom program error: NothingToExtract" is a sentence a presenter can read
// aloud and no rewording of it is more useful. Classification only fires on the failures where the
// original text is genuinely NOT the answer: a rejected popup, a wallet that walked away, a lapsed
// session, an expired blockhash. Those name a symptom and hide the cause.
//
// BOTH FIELDS ARE ALWAYS STRINGS, defensively. `chain/session/useSessionKeyManager.ts`'s
// `normalizeGumError` exists because gum-react-sdk types a channel as `string | null` and puts a
// `SendTransactionError` OBJECT in it, which React refuses to render — that white-screened the whole
// app once. This module is the same boundary for the same class of value, so it makes the same
// promise: whatever comes in, two strings come out.
//
// ------------------------------------------------------------------------------------------------
// THE NETWORK QUESTION, SETTLED — because the obvious version of this file gets it wrong.
//
// THERE IS NO API BY WHICH A DAPP CAN READ PHANTOM'S SELECTED CLUSTER. No `network`/`cluster`
// property on the injected provider, no `networkChanged` event, no usable signal on the Wallet
// Standard `chains` array (that field is a static CAPABILITY list by spec, not a selection), and no
// dedicated Phantom error code. The Solana Foundation only opened a SIMD discussion about fixing
// this at the protocol level in Nov 2025. So this module detects nothing about the network, and its
// copy never implies otherwise.
//
// AND — the part that matters more — IT BARELY MATTERS HERE. Phantom's selected cluster affects
// exactly three things: what Phantom's own UI shows as balances, which RPC it SIMULATES against for
// the approval preview, and which RPC it submits to WHEN THE DAPP CALLS `signAndSendTransaction`.
// This app does none of the third: `chain/sendTx.ts` calls `signTransaction` and then sends the
// signed bytes itself over the router, and gum's `createSession` takes a sign-only `AnchorWallet`
// and sends over our own devnet `baseConnection`. We never call `adapter.sendTransaction`. A
// signature is valid on any cluster, so a visitor whose Phantom is on Mainnet CAN STILL PLAY — all
// they get is a scary, cosmetic "this transaction may be unsafe" warning in the approval popup,
// because Phantom simulated our devnet transaction against mainnet and could not.
//
// Hence `wrong-network` is an ADVISORY, not a blocker, and it is deliberately NOT the same thing as
// holding no devnet SOL (see `playGate.ts`'s `no-sol`, which is a real, blocking, locally-observed
// fact read from OUR devnet RPC and cannot be affected by Phantom's setting at all).
// ------------------------------------------------------------------------------------------------

/** @see classifyWalletError for what each one is inferred from. */
export type WalletFaultCode =
  | "not-installed"
  | "rejected"
  | "connect-failed"
  | "disconnected"
  | "wrong-network"
  | "session-expired"
  | "unknown";

export interface WalletFault {
  code: WalletFaultCode;
  /** ONE CLAUSE: what is true. Lower-case, no trailing period — it is rendered inline, after a dash,
   *  inside sentences the caller owns (`Unavailable — ${short}.`). */
  short: string;
  /** WHAT TO DO, AND WHEN IT CHANGES. Full sentences, per SPEC.md's copy rule. This is the string a
   *  toast shows and the string a thrown `Error` carries. */
  detail: string;
}

/**
 * HOW TO PUT PHANTOM ON DEVNET — one copy of these words for the whole app.
 *
 * Verb-based rather than screenshot-based on purpose: Phantom ships UI changes weekly, and a
 * sentence naming a pixel position rots in a fortnight while a sentence naming a menu path does not.
 *
 * PROVENANCE: the path through Settings → Developer Settings → Testnet Mode, and the confirmation
 * banner, are from Phantom's own developer docs and help centre. The exact label of the network
 * picker in the final step could only be confirmed from community write-ups — hence "choose", which
 * is true whatever the control is called.
 */
export const PHANTOM_DEVNET_STEPS =
  "Phantom → Settings → Developer Settings → turn on Testnet Mode → choose Solana Devnet " +
  "(not Solana Testnet). A banner at the top of Phantom confirms it.";

/**
 * THE ONE STATEMENT THAT IS CORRECT 100% OF THE TIME, and the reason it exists.
 *
 * Since no dapp can read the wallet's cluster, the only honest way to keep a visitor out of the
 * wrong-network confusion is to say unconditionally, up front, which network this page is on. That
 * is precisely the workaround the SIMD discussion on this gap recommends to dapps. Rendered
 * always-on and non-alarming, never as a warning — it is a fact about the page, not a finding about
 * the reader.
 */
export const DEVNET_ONLY_NOTE =
  "This arena runs on Solana devnet only. Nothing here touches mainnet or real funds.";

/** Phantom's cancel. The number is EIP-1193's `4001` (user rejected request), which Phantom reuses
 *  on its Solana provider — it arrives either on the thrown object itself or, through the adapter,
 *  nested under `WalletError.error`. */
const USER_REJECTED_CODE = 4001;

const REJECTED = /user rejected|user denied|request rejected|declined|cancell?ed/i;
/** SUBJECT-ANCHORED, and it has to be. This was `/not (detected|installed|found)/` and it swallowed
 *  "Blockhash not found" — an expired-blockhash failure classified as a missing extension, telling a
 *  visitor with Phantom open in front of them to go and install Phantom. Caught by the test that
 *  checks the network strings, which is exactly why those strings are enumerated there. Only a
 *  wallet/provider/extension can be "not found" here. */
const NOT_INSTALLED = /(wallet|phantom|provider|extension)\s+\w*\s*not\s+(detected|installed|found)|not (detected|installed)\b|no provider|walletnotready/i;
/** Phantom hanging up on us. The adapter emits `WalletDisconnectedError` alongside its `disconnect`
 *  event when the WALLET initiates it; a disconnect WE initiate detaches the listeners first and
 *  emits no error at all, which is what makes this a clean signal rather than a guess.
 *
 *  IT MATCHES THREE CLASS NAMES, NOT ONE, AND THE OTHER TWO ARE WHY THIS PATTERN WAS WRONG. The
 *  adapter also throws `WalletNotConnectedError` — from `signTransaction`, when the wallet went away
 *  MID-ACTION, which is precisely the "disconnected mid-round" case this copy exists for — and
 *  `WalletDisconnectionError` when a disconnect fails. Neither contains the substring "disconnected"
 *  ("notconnected", "disconnection"), so both used to fall through to `unknown` and, because these
 *  classes carry no message at all (see `readThrown`'s note), surfaced as an EMPTY red toast. */
const DISCONNECTED = /walletdisconnect|walletnotconnected|disconnected/i;
/** A `WalletError` subclass that arrived with nothing but its own class name.
 *
 *  EVERY subclass in `@solana/wallet-adapter-base` is `constructor() { super(...arguments) }` and the
 *  adapter throws them with NO ARGUMENTS, so `.message` is `""` and `.name` is the only information
 *  there is. `readThrown` therefore yields exactly `"WalletAccountError"` — non-empty, so it escapes
 *  the empty-text branch below, and useless, because a class name is not copy. This catches the ones
 *  the specific matchers above don't claim and turns them into a sentence that still names the class
 *  (a reader reporting a bug should be able to quote it) but leads with something to do. */
const BARE_WALLET_ERROR = /^wallet\w*error$/i;
/**
 * An expired or unfindable blockhash. These are the RPC's own strings — Phantom contributes no code
 * of its own here. It is the closest thing to a wrong-network signature that exists, and it is still
 * only a hint: the same strings appear when devnet is briefly unreachable or a transaction sat too
 * long. `simulation failed` is deliberately NOT in this list — a failed simulation is usually a real
 * program error, and swallowing those into a network advisory would hide the actual answer.
 */
const WRONG_NETWORK = /blockhash not found|could not find blockhash|unknown blockhash|block height exceeded|transaction (has )?expired/i;
const SESSION_GONE = /session.{0,40}(expired|invalid)|invalidtoken|sessiontokennotfound|constraintseeds.{0,40}session/i;

/** Everything readable off an unknown throw, flattened once so the matchers below read plainly.
 *
 *  It walks ONE level into `.error` on purpose: that is where `WalletError` puts the provider's own
 *  object, and the `code: 4001` that distinguishes "the user clicked Cancel" from "the connection
 *  broke" lives only there. Deeper walking would start matching text from unrelated causes. */
function readThrown(e: unknown): { text: string; code: number | null } {
  if (e === null || e === undefined) return { text: "", code: null };
  if (typeof e === "string") return { text: e, code: null };
  if (typeof e !== "object") return { text: String(e), code: null };

  const o = e as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    error?: unknown;
    transactionMessage?: unknown;
    transactionLogs?: unknown;
  };

  // BLANKS AND THE GENERIC NAME ARE NOT INFORMATION, and letting either through corrupted every
  // matcher downstream. A `WalletError` has `name: "WalletAccountError"` and `message: ""`, so
  // pushing the empty message produced the text `"WalletAccountError · "` — which no longer matched
  // an anchored pattern, so a class this module knows how to explain fell through to `unknown` and
  // rendered its own class name as copy. `new Error("")` produced `"Error · "` the same way. Both
  // were found by the tests for the empty-message class rather than by reading this.
  //
  // `"Error"` is dropped for the same reason a blank is: it is the default `name` on every plain
  // `Error`, it names nothing, and as the ONLY surviving part it would be shown to a player as the
  // explanation of what went wrong. A real class name (`WalletAccountError`, `SendTransactionError`)
  // is genuinely informative and is kept.
  const parts: string[] = [];
  for (const v of [o.name, o.message, o.transactionMessage]) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed === "" || trimmed === "Error") continue;
    parts.push(trimmed);
  }
  // The program's own `Error Code:` line is the most specific thing in a SendTransactionError, and
  // the session failures this module cares about only ever name themselves there.
  if (Array.isArray(o.transactionLogs)) {
    for (const l of o.transactionLogs) if (typeof l === "string" && l.includes("Error Code:")) parts.push(l);
  }

  let code = typeof o.code === "number" ? o.code : null;

  const nested = o.error;
  if (nested !== null && nested !== undefined && typeof nested === "object") {
    const n = nested as { message?: unknown; code?: unknown; name?: unknown };
    for (const v of [n.name, n.message]) if (typeof v === "string") parts.push(v);
    if (code === null && typeof n.code === "number") code = n.code;
  } else if (typeof nested === "string") {
    parts.push(nested);
  }

  // Last resort, but NOT `String(e)` unconditionally: a bare object stringifies to "[object Object]",
  // which is not text, is not an answer, and is precisely the string this codebase already
  // white-screened on once. An empty result is the honest one — it routes to the "failed without
  // saying why" copy, which at least tells the reader what to do next.
  const joined = parts.join(" · ").trim();
  if (joined !== "") return { text: joined, code };
  // AN `Error` HAS ALREADY GIVEN UP EVERYTHING IT HAS. `name` and `message` are the only places its
  // text can live, and both were empty or generic — so `String(e)` here would only ever re-derive
  // the word "Error" from them and hand it back as though it were a finding. Empty is the honest
  // answer and routes to the "failed without saying why" copy, which at least says what to do next.
  if (e instanceof Error) return { text: "", code };
  const stringified = String(e);
  return { text: stringified === "[object Object]" ? "" : stringified, code };
}

/**
 * Classify anything thrown by the wallet, the adapter, the session SDK or the chain.
 *
 * Order matters and is by SPECIFICITY, not by likelihood: a rejection whose message happens to
 * mention simulation must not fall through to the network advisory, and a lapsed session — which is
 * a finding — must outrank the expired-blockhash hint, which is only a symptom.
 */
export function classifyWalletError(e: unknown): WalletFault {
  const { text, code } = readThrown(e);

  if (code === USER_REJECTED_CODE || REJECTED.test(text)) {
    return {
      code: "rejected",
      short: "you cancelled the request in your wallet",
      detail:
        "Your wallet was asked to approve this and the request was cancelled. Nothing was sent and " +
        "nothing was spent. Press the button again and choose Approve in the Phantom popup.",
    };
  }

  if (NOT_INSTALLED.test(text)) {
    return {
      code: "not-installed",
      short: "no Phantom wallet was detected in this browser",
      detail:
        "This browser has no Phantom extension for the page to talk to. Install Phantom from " +
        "phantom.app/download, then reload this page — the connect button becomes live as soon as " +
        "the extension is there.",
    };
  }

  if (SESSION_GONE.test(text)) {
    return {
      code: "session-expired",
      short: "your session key is no longer valid",
      detail:
        "The session key that was signing for you has expired or been revoked, so the chain refused " +
        "the transaction. Start a new session in the Wallet panel — one Phantom approval — and the " +
        "action will go through without prompting again.",
    };
  }

  if (DISCONNECTED.test(text)) {
    return {
      code: "disconnected",
      short: "Phantom disconnected this site",
      detail:
        "Your wallet ended the connection, so this page can no longer sign for you. Press Connect " +
        "to reconnect. Anything you already deployed is on chain and is unaffected — your fighter " +
        "keeps fighting whether or not this browser is connected.",
    };
  }

  if (WRONG_NETWORK.test(text)) {
    return {
      code: "wrong-network",
      short: "the transaction's blockhash was rejected as too old or unknown",
      detail:
        "Press the button again — a blockhash expires in about a minute and the next attempt gets a " +
        "fresh one. This page signs with your wallet and then submits to devnet itself, so your " +
        "wallet's network setting does not decide whether a transaction lands. If Phantom warned you " +
        "the transaction looked unsafe, that is Phantom simulating a devnet transaction against " +
        "whichever network it is set to; to silence it, " +
        PHANTOM_DEVNET_STEPS,
    };
  }

  if (BARE_WALLET_ERROR.test(text.trim())) {
    const name = text.trim();
    return {
      code: "unknown",
      short: `your wallet refused the request (${name})`,
      detail:
        `Your wallet returned ${name} without a message. Open Phantom and check it is unlocked with ` +
        "an account selected, then try the action again. If it keeps happening, reload the page to " +
        "rebuild the connection.",
    };
  }

  return {
    code: "unknown",
    // VERBATIM. The chain's own words, unedited — see this file's header.
    short: text === "" ? "the wallet failed without saying why" : text,
    detail:
      text === ""
        ? "The wallet failed without reporting a reason. Try the action again; if it keeps failing, " +
          "reload the page to rebuild the connection."
        : text,
  };
}

/** A `connect()` that failed for a reason the wallet did not name. Kept as its own constructor rather
 *  than a `classifyWalletError` branch because there is no error text to match on — the adapter
 *  simply resolves without a public key, which is a distinct fact from any thrown value. */
export function connectFailedFault(): WalletFault {
  return {
    code: "connect-failed",
    short: "the wallet did not finish connecting",
    detail:
      "Phantom was asked to connect and did not come back with an account. Open the extension, make " +
      "sure it is unlocked and has at least one account, then press Connect again.",
  };
}
