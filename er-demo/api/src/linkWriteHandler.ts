// `POST /api/x/link` and `DELETE /api/x/link` — the second leg, where the register actually changes.
//
// One handler for both methods, because they are one act with the sign flipped: redeem a challenge you
// were issued, prove the wallet, and write. Splitting them into two files would duplicate the redemption
// sequence — the part where every ordering decision below lives — and two copies of an ordering argument
// is one copy that will be edited.
//
// A PURE FUNCTION OF ITS DEPENDENCIES, like `linksHandler.ts` and `challengeHandler.ts`. Everything this
// file decides is reachable by `npx vitest run` with no database and no network.
//
// ================================================================================================
// THE ORDER OF THE CHECKS IS THE SECURITY DESIGN. Read this before changing any of it.
//
//   1. SHAPE FIRST — method, content type, body bound, wallet, nonce, signature encoding. Free, and it
//      keeps everything expensive behind a wall of `if`s.
//
//   2. RATE LIMIT SECOND, before the database is touched for anything but counting. §10 Stage 4 asks
//      for it per IP and per wallet, and the wallet is available here because the body names it —
//      which is the only thing the body's `wallet` field is used for until step 5.
//
//   3. CONSUME THE NONCE THIRD, and this is the one that looks wrong and is not. The challenge is
//      destroyed BEFORE the signature is checked, so a WRONG SIGNATURE BURNS THE CHALLENGE. That is
//      §4.1's "one shot", and the alternative — verify, then consume — is a nonce that can be attacked
//      an unlimited number of times, plus a read-check-write sequence with a race in the middle. The
//      cost is that a client bug (a mis-encoded signature) needs a fresh challenge per attempt, which
//      is exactly the feedback a client bug should get.
//
//   4. THE SIGNATURE FOURTH, against the STORED message and the STORED wallet. The request's own
//      `wallet` is compared for consistency and then never used again; nothing the caller sent is an
//      input to the verification. §4.2's rule was "compare the submitted message against the stored copy
//      byte for byte" — this is stronger, because there is no submitted copy to compare: `LinkRequest`
//      has no `message` field.
//
//   5. THE HOUSE CHECK FIFTH — AFTER the signature, and that ordering is what makes §6.3 enforceable
//      without becoming a membership oracle. To reach this line a caller must have produced a valid
//      ed25519 signature from the wallet in question, so the only party who can learn "this wallet is
//      one of the arena's" is a party holding that wallet's private key, who already knows. Move this
//      check any earlier and the endpoint becomes a way to read the arena's roster off the error text,
//      one candidate wallet at a time — which is precisely the thing declining to publish the list was
//      for. `xConsent.ts#FAILURE_COPY` carries the same rule from the client's side.
//
//   6. THE WRITE LAST, one statement, with both uniqueness directions enforced by the database
//      (`pgWriteStore.ts#link`).
// ================================================================================================

import { NONCE_RE } from "./challenge.js";
import { clientNetwork } from "./clientNetwork.js";
import type { HouseListSource } from "./houseWallets.js";
import { enforceRateLimit, type RateLimitDeps } from "./rateLimit.js";
import { isReservedHandle, isReservedXId, RESERVED_HANDLES, RESERVED_MOCK_X_IDS } from "./reserved.js";
import { parseWallet } from "./wallets.js";
import type { Challenge, ChallengeStore, LinkWriter } from "./writeStore.js";
import {
  methodNotAllowed,
  okJson,
  readJsonBody,
  refuse,
  signatureBytes,
  unavailable,
} from "./writeHttp.js";
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";

export interface LinkWriteDeps {
  readonly challenges: ChallengeStore;
  readonly links: LinkWriter;
  readonly rate: RateLimitDeps;
  readonly house: HouseListSource;
  readonly nowSec: () => number;
  /** Overridable only so the reserved rules can be tested against a non-empty set. */
  readonly reservedXIds?: ReadonlySet<string>;
  readonly reservedHandles?: ReadonlySet<string>;
}

/** What every method needs off the body, already validated. */
interface Redemption {
  readonly wallet: string;
  readonly nonce: string;
  readonly signature: Uint8Array;
}

function parseRedemption(value: Record<string, unknown>): Redemption | Response {
  const wallet = parseWallet(value.wallet);
  if (wallet.kind !== "ok") return refuse(400, "malformed", wallet.detail);

  const nonce = value.nonce;
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
    return refuse(400, "malformed", "nonce must be 64 lowercase hex characters");
  }

  const signature = signatureBytes(value.signature);
  if (signature === null) {
    return refuse(400, "malformed", "signature must be base64 of 64 bytes");
  }
  return { wallet: wallet.wallet, nonce, signature };
}

/**
 * Does this signature verify over the challenge's own stored bytes?
 *
 * `ed25519.verify` THROWS on a malformed point rather than returning false, which `xLink.ts` learned
 * the hard way ("a throw here would take out the whole poll"). Here a throw would become a 503 that
 * reads as our outage rather than as their bad signature, so it is caught and folded into `false`: a
 * signature that cannot be evaluated is a signature that did not verify.
 */
function signatureVerifies(challenge: Challenge, signature: Uint8Array): boolean {
  try {
    const key = new PublicKey(challenge.wallet).toBytes();
    if (key.length !== 32) return false;
    // The message is signed as UTF-8 of the exact string that was stored and returned. `TextEncoder`
    // on this side and `utf8` on the wallet's side are the same bytes for the same string, and the
    // string never went through a parser in either direction.
    return ed25519.verify(signature, new TextEncoder().encode(challenge.message), key);
  } catch {
    return false;
  }
}

export async function handleLinkWrite(request: Request, deps: LinkWriteDeps): Promise<Response> {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return methodNotAllowed("POST, DELETE");
  }
  // The method decides which ceremony is being redeemed, and the challenge remembers which one it was
  // issued for. Both have to agree — see the mismatch refusal below.
  const wanted: Challenge["purpose"] = request.method === "POST" ? "link" : "unlink";

  const body = await readJsonBody(request);
  if (body.kind !== "ok") return body.response;

  const parsed = parseRedemption(body.value);
  if (parsed instanceof Response) return parsed;

  const nowSec = deps.nowSec();

  const verdict = await enforceRateLimit(
    deps.rate,
    { wallet: parsed.wallet, network: clientNetwork(request.headers) },
    nowSec,
  );
  if (verdict.kind === "limited") {
    return refuse(429, "rate-limited", undefined, { "Retry-After": String(verdict.retryAfterSec) });
  }

  // ONE SHOT. Unknown, already-redeemed and expired are one answer, from one statement — see
  // `writeStore.ts#consume` for why they are not distinguished. `expired` is the machine key because it
  // is the one a client can act on: `FAILURE_COPY.expired` says "that took too long and the request
  // expired. Start again and it will work", which is true of all three.
  const challenge = await deps.challenges.consume(parsed.nonce, nowSec);
  if (challenge === null) return refuse(400, "expired");

  if (challenge.purpose !== wanted) {
    // An unlink challenge redeemed at the link endpoint, or the reverse. The nonce is already spent,
    // which is correct: it was issued for one act, the player consented to one act (the intent is in
    // the bytes they signed), and it may not be turned into the other one.
    return refuse(400, "malformed", "challenge was issued for a different operation");
  }

  if (challenge.wallet !== parsed.wallet) {
    // Belt and braces. The signature below is verified against `challenge.wallet` regardless, so a
    // mismatch could only ever fail — but failing HERE says which of the two mistakes was made, and a
    // client that sent the wrong wallet needs a different fix from one that signed wrong.
    return refuse(400, "malformed", "challenge belongs to another wallet");
  }

  if (!signatureVerifies(challenge, parsed.signature)) return refuse(401, "bad-signature");

  // ------------------------------------------------------------------------------------------------
  // FACT B IS NOW ESTABLISHED, BOUND TO FACT A BY THE MESSAGE CONTENT (§4.1 step 6).
  // Everything below is policy about what may be written.
  // ------------------------------------------------------------------------------------------------

  // §6.3, THE HARD RULE, AND IT FAILS CLOSED. `HouseListCache` reports `unknown: true` only when this
  // worker has never once read the keeper's list — a cold start during a keeper outage, or a
  // `KEEPER_HOUSE_TOKEN` that does not match. In that state we cannot tell an arena wallet from a
  // player's, so no link is created at all: the cost of failing closed is that a player retries in a
  // minute, and the cost of failing open is an automated process wearing a person's face, which is the
  // one outcome §6.3 calls unacceptable. Note that `requireHouseToken` throws at cold start, so the
  // "token not set" case never even reaches a request — this is the runtime half of the same rule.
  //
  // The refusal is `unavailable()`, byte-identical to the outage case and to an unexpected exception,
  // for the oracle reason in this file's header.
  const house = await deps.house.get();
  if (house.unknown) return unavailable();
  if (challenge.purpose === "link" && house.wallets.has(challenge.wallet)) return unavailable();

  if (challenge.purpose === "unlink") {
    // NO HOUSE CHECK ON THE UNLINK PATH, deliberately: removing a link is safe for any wallet, an
    // arena wallet should never have one to remove, and refusing would answer a membership question
    // for a caller who has just proved they hold the key. The `house.unknown` check above still
    // applies, because a worker that cannot read the list is a worker whose configuration is wrong,
    // and doing writes from that state is not something to normalise.
    const removed = await deps.links.unlink(challenge.wallet);
    // A 200 either way: the caller asked for this wallet to have no link and it has none. `unlinked`
    // reports whether a row was actually removed, which is a fact about their own wallet and therefore
    // theirs to know.
    return okJson({ unlinked: removed !== null });
  }

  const { identity } = challenge;

  // The reserved rules again — `challengeHandler.ts` already applied them to this identity when the
  // nonce was minted. Repeated here for the same reason the house rule is enforced on both the read and
  // the write path: this is the guard that still holds if a challenge row ever reaches the table by
  // another route, and it is the cheapest of the three chances to get it right.
  if (isReservedXId(identity.xId, deps.reservedXIds ?? RESERVED_MOCK_X_IDS)) return refuse(403, "refused");
  if (isReservedHandle(identity.handle, deps.reservedHandles ?? RESERVED_HANDLES)) {
    return refuse(403, "refused");
  }

  const outcome = await deps.links.link(challenge.wallet, identity, nowSec);
  if (outcome.kind === "wallet-taken") {
    // The one refusal on this path a player can fix themselves, and the only one that names a state of
    // the register — which is safe here and nowhere earlier, because it is a state of THEIR OWN wallet
    // and they have just proved they hold its key. `FAILURE_COPY.alreadyLinked` is the sentence for it.
    return refuse(409, "wallet-taken", "unlink this wallet's current X account first");
  }

  // ------------------------------------------------------------------------------------------------
  // THE RESPONSE CARRIES NOTHING RENDERABLE, AND THAT IS DELIBERATE.
  //
  // No handle, no display name, no avatar path, no attestation. The client's rule (`xLink.ts`) is that
  // only `verifyAttestation` may mint something a face can be drawn from, and the one way to keep that
  // true is to give this response nothing a hurried component could display: a `handle` field here
  // would be an unsigned, unverified identity arriving over the same connection as a signed one, which
  // is the exact shape of the defect this whole feature was built to delete.
  //
  // So the client's next move is to re-read `GET /api/links`, verify the attestation, and render that.
  // One rendering path, one trust anchor.
  // ------------------------------------------------------------------------------------------------
  return okJson({ linked: true });
}
