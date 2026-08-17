// THE WORDS A PLAYER IS ASKED TO SIGN, AND THE NONCE THEY ARE ASKED TO SIGN THEM WITH.
//
// A pure module: no clock, no randomness of its own, no network, no store. Everything it needs
// arrives as an argument, which is what lets `challenge.test.ts` assert the exact bytes rather than a
// shape. That matters more here than anywhere else on this path, because THESE BYTES ARE THE
// CONSENT. A wallet signature is worth exactly what the message said, and if the message is vague
// then a proven signature proves something vague.
//
// ================================================================================================
// THE BINDING, WHICH IS THE ONLY REASON THIS MESSAGE HAS A FORMAT AT ALL.
//
// `TWITTER-CONNECT.md` §4 needs two facts held together:
//
//   (A) this browser controls the X account   — the Privy identity token, verified in `privyIdentity.ts`
//   (B) this browser controls the wallet      — an ed25519 signature over the bytes below
//
// Either alone is a forgery vector. A alone is "I authorise as my own handle and claim YOUR wallet",
// which puts my name on a whale's P&L. B alone is `web/index.html:2900`'s `prompt("Your X handle")`,
// which is nothing at all.
//
// THE BINDING IS THAT (A) IS INSIDE THE BYTES THAT PROVE (B): the message names the wallet, the
// handle AND the immutable numeric X id. So a signature collected for one ceremony cannot be pointed
// at a different X account, and a signature harvested somewhere else cannot be replayed here. The
// nonce and the expiry are what stop this ceremony's own signature being replayed later.
// ================================================================================================
//
// WHY THE MESSAGE EXPLAINS ITSELF AT LENGTH. §4.2: "the message says 'not a transaction, moves no
// funds' because a wallet prompt with no explanation is how players get trained to sign anything".
// A player who has learned that every wallet prompt is unreadable is a player who will sign a real
// drainer next month. The extra four lines are cheap and they are the only part of this feature that
// might make somebody safer somewhere else.

/**
 * FIVE MINUTES.
 *
 * The number is bounded on both sides and there is not much room in between. Below it: a real person
 * reads the consent screen (`xConsent.ts`), authorises with X in a popup, then finds and unlocks a
 * wallet extension — two minutes is an ordinary run of that with no hesitation in it, and an expiry a
 * careful player trips is a expiry that trains them to hurry. Above it: every second is a second in
 * which a challenge naming somebody's wallet sits in a table waiting for a signature, and §4.1
 * writes 5 min for the ticket and 5 min for the nonce.
 *
 * `challengeMessage()` PRINTS THIS to the player as an absolute time. If it changes, the words change
 * with it, which is why the number is here rather than in SQL (migration 0002 deliberately has no
 * default for `expires_at`).
 */
export const CHALLENGE_TTL_SECONDS = 300;

/** 32 bytes, lowercase hex — the shape migration 0002's CHECK constrains and the only shape the
 *  handlers will parse. Anchored: a longer string with a valid prefix is a rejection, not a prefix. */
export const NONCE_RE = /^[0-9a-f]{64}$/;

/** The number of random bytes behind `NONCE_RE`. 256 bits, which is not where the security of this
 *  ceremony lives — the signature is — but a guessable nonce would let a stranger burn somebody's
 *  ceremony in flight, and there is no reason to be economical about this. */
export const NONCE_BYTES = 32;

/**
 * The origin printed in the message when the request carries no usable `Host`.
 *
 * NOT A SECURITY FALLBACK, and it is important that nobody later "hardens" it into one: nothing about
 * verification depends on this string. The server composed the message, stored it verbatim and
 * verifies a signature over its own copy, so the domain is there for the PLAYER to read and for no
 * other reason.
 */
export const DEFAULT_ORIGIN = "bullsvsunicorns.fun";

/**
 * The `Host` a request arrived at, if it is safe to print, else `DEFAULT_ORIGIN`.
 *
 * WHY THE REQUEST'S HOST AND NOT A CONSTANT. The domain in this message is the one part a player can
 * check against their address bar before approving. On a preview deployment a hardcoded
 * `bullsvsunicorns.fun` would be a lie, and — the case that actually matters — if somebody ever
 * proxies this API from a domain of their own, the message should say so out loud rather than lend
 * them our name. Deriving it means the message is always true about where the request went.
 *
 * The header is attacker-controlled in the sense that any HTTP client can set it, and that buys an
 * attacker nothing: they could put arbitrary words on their own screen anyway, and the signature they
 * would obtain is bound to a wallet, a nonce and an X id that we chose. What the filter below is for
 * is narrower and worth having on its own — keeping newlines, control characters and unbounded junk
 * out of a string we are about to lay out on labelled lines in front of a person.
 */
export function originFrom(host: string | null | undefined): string {
  if (typeof host !== "string") return DEFAULT_ORIGIN;
  const trimmed = host.trim();
  // Letters, digits, dots, hyphens and one optional port. No userinfo, no path, no spaces, no colons
  // except the port's — i.e. exactly the shape of a hostname somebody could have typed.
  if (!/^[A-Za-z0-9.-]{1,80}(:[0-9]{1,5})?$/.test(trimmed)) return DEFAULT_ORIGIN;
  return trimmed;
}

/** Unix seconds -> `2026-08-17T14:02:11Z`. Seconds precision, `Z`, no milliseconds: the message is
 *  read by a person, and `.000Z` is three characters of noise in the middle of the one line they are
 *  most likely to check. */
export function isoSecond(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface ChallengeMessageInput {
  readonly purpose: "link" | "unlink";
  readonly origin: string;
  /** FULL base58, never truncated — see the note in `challengeMessage`. */
  readonly wallet: string;
  /** Present for `link`, absent for `unlink`. An unlink names no X account because it needs no X
   *  credential (see `writeStore.ts`'s `UnlinkChallenge`). */
  readonly handle?: string;
  readonly xId?: string;
  readonly nonce: string;
  readonly issuedAtSec: number;
  readonly expiresAtSec: number;
}

/**
 * Compose the message. One `\n`-joined block, no trailing newline, and byte-for-byte stable for a
 * given input.
 *
 * THE WALLET IS PRINTED IN FULL, which is a departure from the sketch in `SOCIAL.md` §2.2 (`7xKX...9fA2`)
 * and follows `TWITTER-CONNECT.md` §4.2 ("full base58") instead. An abbreviated address is unusable
 * for the one purpose it is there for: a player comparing it against the account their wallet has
 * selected. Middle-truncation is also exactly what an address-substitution attack survives — the
 * first and last four characters of a base58 key are cheap to grind.
 *
 * THE HANDLE AND THE NUMERIC ID ARE PRINTED TOGETHER. The handle is what the player recognises; the
 * id is what the register is keyed on (0001) and what the signature is actually binding. Printing
 * only the handle would let a rename between challenge and redemption change the meaning of a signed
 * message; printing only the id would be a number nobody can check.
 */
export function challengeMessage(input: ChallengeMessageInput): string {
  const head =
    input.purpose === "link"
      ? `${input.origin} wants to link your X account.`
      : `${input.origin} wants to unlink your X account.`;

  const lines: string[] = [head, "", `Wallet:  ${input.wallet}`];

  if (input.purpose === "link") {
    lines.push(`X:       @${input.handle}  (id ${input.xId})`);
  }

  lines.push(
    `Nonce:   ${input.nonce}`,
    `Issued:  ${isoSecond(input.issuedAtSec)}`,
    `Expires: ${isoSecond(input.expiresAtSec)}`,
    "",
  );

  if (input.purpose === "link") {
    lines.push(
      "Signing this proves you control this wallet. It is not a",
      "transaction, it moves no funds, and it costs nothing.",
      "",
      "Anyone will then be able to see that this wallet belongs to",
      "your X account, including its entire on-chain history.",
    );
  } else {
    lines.push(
      "Signing this removes your X account from this wallet. It is",
      "not a transaction, it moves no funds, and it costs nothing.",
      "",
      "It cannot undo what anyone has already seen or copied.",
    );
  }

  return lines.join("\n");
}

/**
 * 32 CSPRNG bytes as lowercase hex.
 *
 * @param randomBytes injected — `crypto.getRandomValues` in production, a counter in tests. A module
 *   that reaches for global randomness on its own cannot be tested for the one property that matters
 *   here, which is that the nonce it produces is the nonce it stores.
 *
 * There is no `Math.random()` path and no fallback. A nonce from a weak source is worse than a
 * failure, because it looks identical.
 */
export function newNonce(randomBytes: (out: Uint8Array) => void): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  randomBytes(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
