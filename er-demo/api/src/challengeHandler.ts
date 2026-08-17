// `POST /api/x/challenge` — the first leg of the ceremony, and the only one that talks to Privy.
//
// It answers one question: WHAT BYTES SHOULD THIS WALLET SIGN? Composing them requires knowing the X
// identity (the message binds it — `challenge.ts`), so this is where the Privy identity token is
// verified and where the ceremony's five-minute clock starts.
//
// A PURE FUNCTION OF ITS DEPENDENCIES, taking a web-standard `Request` and returning a web-standard
// `Response`, exactly as `linksHandler.ts` is and for exactly the same reason: every rule below is then
// reachable by `npx vitest run` with no database, no network, no container and no Vercel. The expensive
// defects on this leg are all policy — a nonce that is not stored verbatim, a token whose audience
// nobody checked, an unlink that quietly accepts a credential — and policy defects are the class nobody
// writes a test for when the test needs Postgres first.
//
// ================================================================================================
// TWO CHECKS THAT DELIBERATELY DO NOT HAPPEN HERE, AND WHY EACH ABSENCE IS THE DESIGN.
//
// Both would improve the player's experience by failing earlier, and both would turn this endpoint
// into a query anybody can run against the register. `xConsent.ts#FAILURE_COPY` already carries the
// rule from the client's side — a refusal that names its reason for the house-wallet case is "a
// MEMBERSHIP ORACLE: anyone could walk a candidate wallet up to the link endpoint and read the arena's
// roster straight off the error text, one key at a time".
//
//   1. NO HOUSE-WALLET CHECK. §6.3's hard rule is enforced on the LINK leg, after the wallet signature
//      has verified — so probing it requires the wallet's own private key, and somebody who holds that
//      key already knows whose wallet it is. Checked here instead, it would answer "is this wallet one
//      of the arena's?" for any wallet on the chain, to anybody with an X account, in one request.
//      That is the entire anonymity rule handed back through a different door.
//
//   2. NO "IS THIS WALLET ALREADY LINKED" CHECK. Same shape: it would tell a caller a fact about
//      SOMEBODY ELSE'S wallet. `wallet-taken` is answered on the link leg, after the signature, where
//      the only person who can hear it is the person holding the key.
//
// The cost of both absences is one wasted wallet prompt in cases that are close to nonexistent — an
// arena wallet cannot reach this code without its key, and a wallet already linked belongs to the
// person asking. That is a good trade for a rule that cannot be walked around.
// ================================================================================================

import { challengeMessage, CHALLENGE_TTL_SECONDS, newNonce, originFrom } from "./challenge.js";
import { clientNetwork } from "./clientNetwork.js";
import type { PrivyVerifier } from "./privyIdentity.js";
import { enforceRateLimit, type RateLimitDeps } from "./rateLimit.js";
import { isReservedHandle, isReservedXId, RESERVED_HANDLES, RESERVED_MOCK_X_IDS } from "./reserved.js";
import { parseWallet } from "./wallets.js";
import type { ChallengeStore, LinkChallenge, UnlinkChallenge, XIdentity } from "./writeStore.js";
import { methodNotAllowed, okJson, readJsonBody, refuse, unavailable } from "./writeHttp.js";

export interface ChallengeDeps {
  readonly challenges: ChallengeStore;
  readonly rate: RateLimitDeps;
  readonly privy: PrivyVerifier;
  readonly nowSec: () => number;
  /** `crypto.getRandomValues` in production. Injected so a test can assert that the nonce which is
   *  returned is the nonce that was stored — see `challenge.ts#newNonce`. */
  readonly randomBytes: (out: Uint8Array) => void;
  /** Overridable only so the reserved rules can be tested against a non-empty set; production passes
   *  nothing and gets the real lists. Same arrangement as `LinksDeps.reservedXIds`. */
  readonly reservedXIds?: ReadonlySet<string>;
  readonly reservedHandles?: ReadonlySet<string>;
}

/** The `ChallengeResponse` shape from `src/v2/data/xLink.ts`, restated as the value this handler
 *  returns. Not imported: that module is the BROWSER's contract and importing it here would put the
 *  whole verifier — `@noble/curves`, `@solana/web3.js` — into this function's graph for one interface
 *  with three fields. `attest.ts` imports across that fence because it genuinely needs the signer;
 *  this does not. */
interface ChallengeBody {
  readonly message: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

/**
 * Map a Privy refusal onto a response.
 *
 * THREE OUTCOMES ARE DISTINGUISHED AND THE REST ARE ONE, and the line between them is whether the
 * caller can act on the answer. `no-x-account` means "you have not authorised X yet", which is the
 * ordinary consequence of closing the popup and which the client answers by asking again.
 * `stale-proof` means "get a fresh token and retry", which the Privy SDK can do without the player
 * doing anything. `keys-unavailable` is OURS — Privy's public keys could not be read — so it is the
 * generic 503 and not the caller's problem to solve.
 *
 * Everything else — a bad signature, a wrong audience, a wrong issuer, an expired token, a malformed
 * one, an X account with no usable handle — collapses to one `bad-proof`. A caller who could tell
 * "wrong audience" from "bad signature" is a caller being helped to forge one, and none of the
 * distinctions is actionable by an honest client.
 */
function refuseProof(reason: string): Response {
  if (reason === "keys-unavailable") return unavailable();
  if (reason === "no-x-account") {
    return refuse(401, "no-x-account", "authorise X before linking");
  }
  if (reason === "stale") {
    return refuse(401, "stale-proof", "obtain a fresh identity token and retry");
  }
  return refuse(401, "bad-proof");
}

export async function handleChallenge(request: Request, deps: ChallengeDeps): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");

  const body = await readJsonBody(request);
  if (body.kind !== "ok") return body.response;

  const wallet = parseWallet(body.value.wallet);
  if (wallet.kind !== "ok") return refuse(400, "malformed", wallet.detail);

  const purpose = body.value.purpose;
  if (purpose !== "link" && purpose !== "unlink") {
    return refuse(400, "malformed", 'purpose must be "link" or "unlink"');
  }

  const nowSec = deps.nowSec();

  // ------------------------------------------------------------------------------------------------
  // THE RATE LIMIT COMES BEFORE THE TOKEN IS VERIFIED, AND BEFORE ANYTHING IS WRITTEN.
  //
  // Everything downstream of this line costs money or state: a JWKS fetch (once an hour, but a cold
  // worker pays it), a signature verification, and a row in `x_link_challenge`. Counting first is what
  // makes this endpoint safe to leave open, and it is why the counter's failure is a REFUSAL rather
  // than a shrug — if we cannot count, we do not serve. `rateLimit.ts` never catches, so a thrown
  // counter arrives at the entry point's error boundary as a 503, which is the fail-closed direction.
  // ------------------------------------------------------------------------------------------------
  const verdict = await enforceRateLimit(
    deps.rate,
    { wallet: wallet.wallet, network: clientNetwork(request.headers) },
    nowSec,
  );
  if (verdict.kind === "limited") {
    return refuse(429, "rate-limited", undefined, { "Retry-After": String(verdict.retryAfterSec) });
  }

  const proof = body.value.proof;
  let identity: XIdentity | null = null;

  if (purpose === "link") {
    if (typeof proof !== "string" || proof === "") {
      return refuse(400, "malformed", "proof is required to link");
    }
    const verified = await deps.privy.verify(proof, nowSec);
    if (verified.kind !== "ok") return refuseProof(verified.reason);
    identity = verified.identity;

    // THE RESERVED RULES, ON THE FIRST LEG, WHERE THEY COST THE PLAYER NOTHING AND LEAK NOTHING. Both
    // are facts about the caller's OWN X account — they have just proved they control it — so unlike
    // the two checks in this file's header, answering here is not a query about anybody else. Failing
    // now saves a wallet prompt that could only ever have ended in the same refusal.
    //
    // Checked again on the link leg. Two chances, because they fail differently: this one catches the
    // ordinary case, and that one still holds if a challenge row ever reaches the table by another
    // route.
    if (isReservedXId(identity.xId, deps.reservedXIds ?? RESERVED_MOCK_X_IDS)) {
      return refuse(403, "refused");
    }
    if (isReservedHandle(identity.handle, deps.reservedHandles ?? RESERVED_HANDLES)) {
      return refuse(403, "refused");
    }
  } else if (proof !== undefined) {
    // AN UNLINK CARRIES NO CREDENTIAL, and one that arrives anyway is refused rather than ignored.
    // Silently dropping it would hide a client bug whose shape is "we send the identity token
    // everywhere", and the whole reason an unlink needs no token is that a player who has lost their X
    // account must still be able to remove their face. A client that has learned to always attach one
    // has quietly made revocation depend on the thing being revoked.
    return refuse(400, "malformed", "unlink takes no proof");
  }

  const nonce = newNonce(deps.randomBytes);
  const expiresAtSec = nowSec + CHALLENGE_TTL_SECONDS;
  const message = challengeMessage({
    purpose,
    origin: originFrom(request.headers.get("host")),
    wallet: wallet.wallet,
    handle: identity === null ? undefined : identity.handle,
    xId: identity === null ? undefined : identity.xId,
    nonce,
    issuedAtSec: nowSec,
    expiresAtSec,
  });

  // The stored row and the returned body carry THE SAME `message` string. That is the whole point of
  // storing it (migration 0002's note on the column): verification later hands these bytes to
  // ed25519.verify without parsing anything and without recomposing anything, so a deploy in the middle
  // of somebody's ceremony cannot reject a signature over the words they actually read.
  const challenge: LinkChallenge | UnlinkChallenge =
    identity === null
      ? { purpose: "unlink", nonce, wallet: wallet.wallet, message, issuedAtSec: nowSec, expiresAtSec }
      : { purpose: "link", nonce, wallet: wallet.wallet, message, issuedAtSec: nowSec, expiresAtSec, identity };

  await deps.challenges.put(challenge);

  const response: ChallengeBody = { message, nonce, expiresAt: expiresAtSec };
  return okJson(response);
}
