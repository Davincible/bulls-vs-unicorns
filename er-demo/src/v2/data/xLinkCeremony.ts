// THE CEREMONY, AS A PURE FUNCTION OF ITS DEPENDENCIES.
//
// Two exported calls — `runLink` and `runUnlink` — and neither of them knows what React is, what
// Privy is, or what a button looks like. Everything that touches the world arrives in `CeremonyDeps`:
// the fetch, the wallet's signer, and a function that produces a proof. That is what lets
// `xLinkCeremony.test.ts` run the whole ceremony, including every refusal the server can answer with,
// with no network, no wallet extension and no identity provider.
//
// It matters more here than in most places, because THIS FILE IS THE HALF OF THE FEATURE A PLAYER CAN
// FEEL. The server can be perfect and this can still hand somebody a wallet prompt for a message they
// did not read, or answer a refusal with a sentence that is not true, or — the one the whole feature
// exists to prevent — invent an identity when the ceremony fails.
//
// ================================================================================================
// THREE RULES, AND THE FIRST ONE IS THE REASON ANY OF THIS EXISTS.
//
// 1. THERE IS NO FALLBACK. Not a prompt, not a text field, not a "we could not reach X, tell us your
//    handle". `web/index.html:2900` answered every OAuth failure with `prompt("Your X handle")` and
//    wrote the answer through the same message as a proven one, so typing `blknoiz06` put Ansem's
//    name and photograph on your fighter. There is nowhere in this file to put such a thing:
//    `LinkRequest` has no handle field, the identity comes from a proof only the broker can mint, and
//    every failure path below returns a REASON — never a partial success.
//
// 2. THE BYTES ARE SIGNED VERBATIM. The server composes the message, stores it, and later verifies a
//    signature against its own copy; this file receives it, hands it to the wallet unmodified, and
//    sends back a signature. It does not parse it, does not rebuild it, does not check it, and does
//    not display a version of it — the wallet shows the player the exact string, which is the only
//    presentation of it that cannot drift from what is being signed.
//
// 3. NOTHING THE SERVER RETURNS IS RENDERED. `POST /api/x/link` answers `{"linked":true}` and that is
//    all this file looks at. The identity that appears on screen afterwards comes from re-reading
//    `GET /api/links` and verifying its signature (`xLink.ts`), because `verifyAttestation` is the only
//    thing allowed to mint something a face can be drawn from. A `handle` echoed by the write path
//    would be an unverified identity arriving over the same connection as a verified one, which is
//    precisely the shape of the defect rule 1 is about.
// ================================================================================================

import {
  X_CHALLENGE_ENDPOINT,
  X_LINK_ENDPOINT,
  type ChallengeResponse,
} from "./xLink.ts";

/**
 * Why a ceremony did not finish. Each maps to exactly one sentence in `xConsent.ts#FAILURE_COPY`,
 * and the mapping is total — a reason with no sentence is a blank panel, and a sentence with no
 * reason is copy nobody can reach.
 *
 * DELIBERATELY COARSER THAN THE SERVER'S VOCABULARY. `/api/x/*` distinguishes `bad-proof`,
 * `bad-signature`, `refused`, `disabled` and an internal fault; a player can act on none of them, and
 * the panel would be lying if it implied otherwise. They all arrive here as `unavailable`, which is
 * the honest sentence. The distinctions stay in the server's logs, where somebody can use them.
 */
export type CeremonyFailure =
  /** The player closed the X window, or authorised nothing. Nothing was sent. */
  | "cancelled"
  /** The wallet declined to sign. The likeliest failure, and the one most often misread as our bug. */
  | "walletRefused"
  /** The challenge expired or was already used. Starting again works. */
  | "expired"
  /** This wallet already wears a different X account. The one failure a player can fix themselves. */
  | "walletTaken"
  /** Too many attempts in the window. Carries the server's `Retry-After`. */
  | "tooMany"
  /** Everything else, and it is deliberately everything else. */
  | "unavailable";

export type CeremonyResult =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly reason: CeremonyFailure; readonly retryAfterSec?: number };

/** A proof, or `null` when the player walked away from the broker's window. `null` is not an error:
 *  it is the ordinary outcome of closing a popup, and it must not be reported as a failure of ours. */
export type ProofSource = () => Promise<string | null>;

export interface CeremonyDeps {
  readonly fetch: typeof globalThis.fetch;
  /**
   * THE WALLET CONNECTED IN THE BROWSER RIGHT NOW, base58. Never a value remembered from earlier in
   * the session: `TWITTER-CONNECT.md` §4.2 — "what the user sees is what they sign is what gets
   * linked". The caller reads it at the moment of the press.
   */
  readonly wallet: string;
  /** `ChainIdentity.signMessage`. Rejects when the player declines, which is `walletRefused`. */
  readonly signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}

export interface LinkDeps extends CeremonyDeps {
  /**
   * Runs the broker's OAuth and returns a FRESH proof.
   *
   * Called at most twice: once, and once more if the server says the first one was stale (see
   * `runLink`). Anything that makes this expensive or surprising to call twice belongs behind it, not
   * in it.
   */
  readonly getProof: ProofSource;
}

/** base64 of the 64-byte detached signature, which is the encoding `LinkRequest.signature` specifies
 *  and the only one the server accepts. Written out rather than reached for from a library because it
 *  is six lines and the alternative is a dependency in the browser bundle for six lines. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const failed = (reason: CeremonyFailure, retryAfterSec?: number): CeremonyResult =>
  retryAfterSec === undefined ? { kind: "failed", reason } : { kind: "failed", reason, retryAfterSec };

/** What the server said, as far as this file cares. `null` when the response was not JSON at all —
 *  a proxy error page, a 502 from the platform — which is `unavailable` like everything else. */
async function errorOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

function retryAfterOf(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

/**
 * Map a refusal onto the one sentence a player will read.
 *
 * `no-x-account` BECOMES `cancelled`, and that is the interesting one. The server means "your Privy
 * user has no X account linked", which for a person who has just been through the popup means they
 * closed it or declined at X. "You cancelled before X confirmed. Nothing was linked." is what
 * happened, from where they are standing.
 */
async function refusalOf(response: Response): Promise<CeremonyResult> {
  if (response.status === 429) return failed("tooMany", retryAfterOf(response));

  const error = await errorOf(response);
  if (error === "no-x-account") return failed("cancelled");
  if (error === "expired") return failed("expired");
  if (error === "wallet-taken") return failed("walletTaken");
  // `bad-proof`, `bad-signature`, `refused`, `disabled`, `malformed`, `unavailable`, and anything a
  // future server adds. None is actionable and several are ours; one sentence covers them.
  return failed("unavailable");
}

/** `Content-Type` is required by the server, and is also what forces a preflight on any cross-origin
 *  attempt — so this constant is a small part of why these routes are not reachable from a form. */
const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Ask for a challenge, sign it, redeem it. The half both ceremonies share.
 *
 * @param proof present for a link, absent for an unlink — an unlink deliberately carries no
 *   credential, so that a player who has lost their X account can still take their face off this site.
 */
async function challengeAndSign(
  deps: CeremonyDeps,
  purpose: "link" | "unlink",
  proof: string | undefined,
): Promise<CeremonyResult> {
  let challenge: Response;
  try {
    challenge = await deps.fetch(X_CHALLENGE_ENDPOINT, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ wallet: deps.wallet, purpose, ...(proof === undefined ? {} : { proof }) }),
    });
  } catch {
    // Offline, DNS, a dead origin. Nothing was sent that could have half-worked.
    return failed("unavailable");
  }
  if (!challenge.ok) return refusalOf(challenge);

  let issued: ChallengeResponse;
  try {
    issued = (await challenge.json()) as ChallengeResponse;
  } catch {
    return failed("unavailable");
  }
  // A 200 that does not carry a message and a nonce is a server we do not understand. Refusing here
  // rather than signing `undefined` keeps the wallet prompt from ever showing a player nonsense.
  if (typeof issued.message !== "string" || issued.message === "" || typeof issued.nonce !== "string") {
    return failed("unavailable");
  }

  let signature: Uint8Array;
  try {
    // VERBATIM. `TextEncoder` over the exact string the server stored — the wallet renders these same
    // bytes to the player, so what they read is what they sign is what gets verified.
    signature = await deps.signMessage(new TextEncoder().encode(issued.message));
  } catch {
    // Phantom rejects with an error when the player presses Cancel, and `identity.ts` rejects with
    // `NO_WALLET_MESSAGE` when nothing is connected. Both are "the wallet did not sign", which is the
    // sentence `FAILURE_COPY.walletRefused` exists for.
    return failed("walletRefused");
  }

  let redeemed: Response;
  try {
    redeemed = await deps.fetch(X_LINK_ENDPOINT, {
      // The METHOD is what tells the server which ceremony this is; the challenge remembers the same
      // thing independently and the two must agree, so a mismatch here fails rather than converting one
      // into the other.
      method: purpose === "link" ? "POST" : "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify({ wallet: deps.wallet, nonce: issued.nonce, signature: toBase64(signature) }),
    });
  } catch {
    // THE ONE GENUINELY AMBIGUOUS FAILURE IN THE CEREMONY. The request may have been received and
    // applied before the connection dropped, so this is not "nothing happened". It resolves itself:
    // the caller re-reads `GET /api/links` on every outcome, and the truth appears there. Reported as
    // `unavailable` because "try again in a minute" is correct advice either way — a repeat of a link
    // that already landed is idempotent, and a repeat of an unlink answers `{"unlinked":false}`.
    return failed("unavailable");
  }
  if (!redeemed.ok) return refusalOf(redeemed);
  return { kind: "ok" };
}

/**
 * Link this wallet to an X account.
 *
 * THE PROOF IS FETCHED FIRST, before any request of ours, so that a player who closes the X window
 * costs us nothing and is told the truth — "you cancelled", not "unavailable". It is also the only
 * order in which the wallet prompt comes second, which matters: a wallet prompt that appears before
 * the player has done the thing they think they are doing is how people learn to click through them.
 *
 * ONE RETRY, AND ONLY FOR `stale-proof`. Privy's identity token is a bearer proof of an X identity, so
 * the server refuses one older than an hour (`privyIdentity.ts`). A player who authorised X earlier in
 * the session and comes back to press this later would otherwise be stuck on a failure they cannot
 * understand or fix; asking the broker for a fresh token and trying once more resolves it invisibly.
 * Exactly once — a loop here would be a way to spend somebody's rate limit for them.
 */
export async function runLink(deps: LinkDeps): Promise<CeremonyResult> {
  let proof: string | null;
  try {
    proof = await deps.getProof();
  } catch (e) {
    // A CONFIGURATION FAULT MUST NOT BE REPORTED AS THE PLAYER'S CHOICE. `xProof.ts` throws
    // `ProofUnavailableError` when Privy issued no identity token at all — which is what happens
    // while the dashboard's "Return user data in an identity token" toggle is off, its default. That
    // is not a closed popup, and telling somebody "you cancelled" when the operator has not finished
    // configuring the app sends them to try again forever against something that cannot succeed.
    //
    // Matched BY NAME rather than `instanceof`, and that is load-bearing rather than fussy:
    // `xProof.ts` is reached through `await import()` precisely so the Privy SDK stays out of the
    // main bundle, and importing its error class here to use `instanceof` would drag the chunk back
    // in for every visitor, including the ones who never press Connect.
    if (e instanceof Error && e.name === "ProofUnavailableError") return failed("unavailable");
    // Otherwise the broker threw rather than returning null — a closed popup, a blocked redirect, a
    // network failure inside its own flow. From the player's side these are the same event.
    return failed("cancelled");
  }
  if (proof === null) return failed("cancelled");

  const first = await challengeAndSign(deps, "link", proof);
  if (first.kind === "ok" || first.reason !== "unavailable") return first;

  // `unavailable` is the bucket `stale-proof` also falls into, and the two are indistinguishable from
  // here — so the retry is attempted whenever a fresh proof could plausibly help. It costs one extra
  // broker call on a genuine outage, which is bounded by there being no second retry.
  let refreshed: string | null;
  try {
    refreshed = await deps.getProof();
  } catch {
    return first;
  }
  if (refreshed === null || refreshed === proof) return first;
  return challengeAndSign(deps, "link", refreshed);
}

/**
 * Remove this wallet's X link.
 *
 * NO PROOF, DELIBERATELY, and this is the load-bearing asymmetry of the whole feature: revocation must
 * not depend on the identity provider a player is walking away from. Someone who has deleted their X
 * account, lost access to it, or simply never wants to see Privy again can still take their face off
 * this site with nothing but the wallet that put it there. §6.2 asks for "a fresh wallet signature over
 * a fresh nonce", which is exactly and only what this does.
 */
export async function runUnlink(deps: CeremonyDeps): Promise<CeremonyResult> {
  return challengeAndSign(deps, "unlink", undefined);
}
