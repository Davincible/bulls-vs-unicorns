// THE WIRE CONTRACT for wallet <-> X identity. Types, canonical bytes, and verification.
//
// This file is the seam. Everything behind it — Privy, X's own API, a database, a serverless
// function, one day possibly a PDA — is an implementation detail that this file is written to
// outlive. Nothing in here names an OAuth provider, and nothing in here should ever need to.
// `TWITTER-CONNECT.md` §5 is the design; this is that design as types.
//
// ================================================================================================
// THE ONE THING THIS FILE EXISTS TO PREVENT.
//
// `web/index.html:2900` had a `prompt("Your X handle (without @):")` on the OAuth failure path, and
// it wrote its answer through the SAME message as the OAuth-proven one. Typing `blknoiz06` put
// Ansem's real name and real photograph on your fighter, in front of everyone. The proof existed and
// an escape hatch beside it silently destroyed it.
//
// So the job here is NOT to add a proof. It is to make the ABSENCE of a proof unrepresentable:
//
//   * `LinkAttestation` is what came off the network. It is a claim. Its name says so.
//   * `LinkRecord` is a VERIFIED identity, protected two ways — and it is worth being exact about
//     what each way does and does not cover, because a safety claim nobody has checked is how the
//     next person ends up trusting a hole.
//
//     1. A COMPILE-TIME BRAND, keyed by a symbol this module does not export. This blocks the
//        accidental route: an object literal cannot name the branded key, so no other file can write
//        one down. It does NOT block everything. `any` is assignable to any type, so
//        `const r: LinkRecord = JSON.parse(s)` compiles; and TypeScript's spread type keeps
//        unique-symbol properties, so `{ ...verified, handle: "blknoiz06" }` also compiles. Both are
//        exactly the §1.3 defect, in one line, with no cast to grep for.
//
//     2. A RUNTIME MINT REGISTER — the `minted` WeakSet below. `verifyAttestation` adds a record to
//        it only after the signature has checked out, and `isVerifiedRecord()` is what the consumer
//        boundary (`linkFighters.ts`) asks before putting a face on anything. A spread copy is a
//        different object and is not in the set. A `JSON.parse` result is not in the set. This is the
//        half that actually holds, and it costs one O(1) lookup per row.
//
// So: the brand makes the mistake hard to make, and the register makes it ineffective. Neither alone
// was enough, and the first was documented here as if it were — found in review, corrected.
//
// The only sanctioned mint is `verifyAttestation()`, which will not return a record without a
// signature that checks out against a trusted key. Doing it anywhere else means writing
// `as unknown as LinkRecord` AND getting it into the register, and the register is not exported.
// ================================================================================================
//
// SAME-ORIGIN IS ENFORCED HERE, NOT TRUSTED. `arena/faces.ts` carries a standing rule — "SAME-ORIGIN
// ONLY... Nothing here may reach a third party" — and an avatar is the first third-party raster to
// come anywhere near it. `avatarPath` is therefore validated against an exact shape during
// verification and REJECTED if it is anything else. Even a correctly-signed record cannot point an
// `<img>` at another host, because a signing key that leaked would otherwise become a way to make
// every player's browser beacon to an attacker. Signatures prove origin; they do not confer trust.

import { PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";

// ------------------------------------------------------------------------------------------------
// The verified record
// ------------------------------------------------------------------------------------------------

/** The compile-time brand. NOT exported — see this file's header for what it does and does not
 *  cover. */
declare const VERIFIED_BY_XLINK: unique symbol;

/**
 * THE RUNTIME MINT REGISTER — the half of the guarantee that actually holds.
 *
 * NOT exported, and never will be: a module that could add to this could mint a record, which is the
 * whole thing being prevented. A `WeakSet` rather than a flag on the object because a flag is just
 * another property a spread would copy; set membership is per-object identity and a copy is a
 * different object.
 *
 * Weak, so a record dropped from the map when a player leaves the round is collectable. This holds
 * one entry per linked wallet on screen — tens, not thousands — and never keeps anything alive.
 */
const minted = new WeakSet<object>();

/**
 * Was this record minted by `verifyAttestation`, on this page, from a signature that verified?
 *
 * ASK THIS BEFORE PUTTING A FACE ON ANYTHING. `linkFighters.ts` is the one consumer boundary and it
 * asks; anything else that starts rendering identities should ask too. A `false` here means the
 * record was forged or copied rather than verified, and the correct response is to treat the player
 * as unlinked — which is the ordinary state and costs nothing.
 */
export function isVerifiedRecord(record: LinkRecord): boolean {
  return minted.has(record);
}

/**
 * THE X DISPLAY NAME, DELIBERATELY NOT A `string`.
 *
 * `TWITTER-CONNECT.md` §4.4 names display-name impersonation as the top residual risk and answers it
 * with one rule: **always render the `@handle`**. A handle is unique and unforgeable; a display name
 * is free text, so `Ansem` costs nothing to type and `@blknoiz06` cannot be taken. X's own display
 * policy requires the handle for the same reason.
 *
 * A rule like that survives exactly as long as the person who wrote it stays on the team, so it is a
 * type instead. `{link.displayName}` does not compile into a string — it is an object, and React
 * throws on it — so the accidental `<td>{link.displayName}</td>` cannot ship. The sanctioned path is
 * `identityText()`, which cannot return a display name without the handle beside it.
 *
 * The field name is the warning label. If you are reaching for `.unsafeText`, the question to answer
 * first is "is the `@handle` rendered within a glance of this?"
 */
export interface DisplayName {
  readonly unsafeText: string;
}

/**
 * A wallet's X identity, VERIFIED — the signature checked out against a key we trust, the record has
 * not expired, and every field is the shape it claims to be.
 *
 * Obtainable only from `verifyAttestation()`. See this file's header for why that is enforced by the
 * type system rather than by convention.
 */
export interface LinkRecord {
  /** Uninhabitable outside this module. Not data — see the header. */
  readonly [VERIFIED_BY_XLINK]: true;

  /** base58 ed25519 public key. The wallet this identity belongs to. */
  readonly wallet: string;
  /** X's immutable numeric account id, as a decimal string.
   *
   *  THE DURABLE KEY, and the reason the store is not keyed on the handle: handles are renameable
   *  and, once released, re-registrable by anyone. A handle-keyed identity silently transfers to
   *  whoever picks up the discarded name. This id never transfers. */
  readonly xId: string;
  /** Current handle, NO leading `@`. A snapshot that may drift from X; `identityText()` is how it
   *  reaches a screen, and it reaches every screen where this identity appears. */
  readonly handle: string;
  /** See `DisplayName`. `null` when the X account has no display name set. */
  readonly displayName: DisplayName | null;
  /** Same-origin path to the re-encoded avatar, or `null` when we do not have the bytes yet.
   *
   *  NULL IS A REAL STATE and the common one on a first link — the failure ladder in
   *  `TWITTER-CONNECT.md` §7.3 has "linked, avatar in flight" rendering as the ordinary flat disc,
   *  which is what `faces.ts` already draws for every fighter today. Validated to
   *  `/api/avatar/<xId>/<64 hex>.webp` and nothing else; see the header. */
  readonly avatarPath: string | null;
  /** Unix SECONDS — the whole file's unit, never milliseconds. When this wallet proved this
   *  identity. What "linked 8 Aug" in the wallet panel is derived from. */
  readonly linkedAt: number;
  /** Unix SECONDS. When the API signed this attestation. */
  readonly issuedAt: number;
  /** Unix SECONDS. After this instant the record is treated exactly like "not linked". Seven days by
   *  policy, so a revocation the API can no longer serve still stops being rendered eventually even
   *  if a client caches forever. */
  readonly expiresAt: number;
}

/** wallet(base58) -> verified identity. ABSENT MEANS UNLINKED, which is the ordinary state for most
 *  players and is never an error — `TWITTER-CONNECT.md` §8. */
export type LinkMap = ReadonlyMap<string, LinkRecord>;

/** The empty map, shared. Identity is load-bearing for the same reason it is in `identity.ts`: React
 *  consumers memoise against this value, and a fresh `new Map()` per poll invalidates every one of
 *  them four times a second for a fact that did not move. */
export const NO_LINKS: LinkMap = new Map<string, LinkRecord>();

// ------------------------------------------------------------------------------------------------
// The unverified wire shape
// ------------------------------------------------------------------------------------------------

/**
 * ONE ROW AS IT ARRIVES OFF THE NETWORK — a claim, not a fact. Named for what it is so that a
 * variable of this type reads as untrusted at every call site.
 *
 * Field names match `TWITTER-CONNECT.md` §5 verbatim, so a server written from the document and a
 * client written from this file agree without anybody diffing them.
 */
export interface LinkAttestation {
  readonly wallet: string;
  readonly xId: string;
  readonly handle: string;
  /** Empty string means "no display name". There is no `null` on the wire: the canonical encoding
   *  below has to be total, and one representation of absence is one fewer thing to disagree about. */
  readonly displayName: string;
  /** Empty string means "no avatar yet" — same rule as `displayName`. */
  readonly avatarPath: string;
  readonly linkedAt: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** base64 of the 64-byte detached ed25519 signature over `canonicalBytes()`. */
  readonly sig: string;
  /** base58 public key of the signer, so a client holding several trusted keys knows which one to
   *  check against instead of trying all of them.
   *
   *  IT IS A HINT AND NOTHING ELSE. The verifier confirms the named key is in the trusted set before
   *  it is used; an attestation naming a key we do not trust is rejected without a curve operation.
   *  A field like this is the classic JWT `alg`/`kid` confusion bug when it is allowed to SELECT the
   *  trust anchor rather than merely index into one. It indexes. */
  readonly keyId: string;
}

/** The body of `GET /api/links`. */
export interface LinksResponse {
  /** Only linked wallets appear. A wallet that was asked about and is missing from this array is
   *  unlinked — the API does not emit "no" rows, because there is nothing to sign about an absence
   *  and a signed absence would be a promise we cannot keep between polls. */
  readonly links: readonly LinkAttestation[];
}

/** `GET /api/links?wallets=<comma-separated base58>`. There is no enumeration route, deliberately
 *  (`TWITTER-CONNECT.md` §6.4): a caller must already know which wallets it is asking about. */
export const LINKS_ENDPOINT = "/api/links";

/** Ceiling on one query, matching `MAX_FIGHTERS` room to spare. A round holds 48 fighters, so 64
 *  covers a full lobby plus the asker plus slack, in one request. */
export const MAX_WALLETS_PER_QUERY = 64;

/** How long an attestation is good for. Seven days, per `TWITTER-CONNECT.md` §5.
 *
 *  IT IS THE CEILING ON A STALE UNLINK, which is what makes it a privacy number rather than a cache
 *  number: revocation is immediate at the API, but a client that has an attestation in hand keeps
 *  honouring it until this passes. Shorter means more requests; longer means a player who unlinked
 *  keeps a face on somebody's stale tab. */
export const ATTESTATION_TTL_SECONDS = 7 * 24 * 60 * 60;

// ------------------------------------------------------------------------------------------------
// Field shapes — the validation is the schema
// ------------------------------------------------------------------------------------------------

/** X handles: 1-15 of `[A-Za-z0-9_]`. Anchored, so nothing with a newline, a slash or a leading `@`
 *  can pass — the leading `@` matters because a handle stored WITH one and rendered through a
 *  template that adds another produces `@@name`, and a handle stored with one but compared without
 *  is two different identities for one account. */
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/** X account ids are u64 decimals. Bounded at 20 digits so an unbounded string cannot be smuggled
 *  through a field that every downstream consumer treats as short and safe (it is a path segment in
 *  `avatarPath`, among other things). */
const X_ID_RE = /^[0-9]{1,20}$/;

/**
 * THE SAME-ORIGIN RULE, AS A REGEX.
 *
 * Anchored, absolute-path-only, no scheme, no authority, no `..`, no query, no fragment. The two
 * variable parts are the numeric X id and a 64-character lowercase hex content hash, which are
 * exactly the two things `TWITTER-CONNECT.md` §7.2 keys the proxy on — never a URL and never a
 * handle, because a proxy that accepts a URL is an open image proxy and an SSRF vector.
 *
 * Note what this forbids that "starts with `/api/avatar/`" would not: `//evil.example/x` is a
 * protocol-relative URL that an `<img src>` resolves to another ORIGIN while still starting with a
 * slash. It is the single easiest way to turn a path field into an off-origin fetch, and the anchored
 * shape below is what stops it.
 */
const AVATAR_PATH_RE = /^\/api\/avatar\/[0-9]{1,20}\/[0-9a-f]{64}\.webp$/;

/** Base64 of 64 bytes is 88 characters with one `=` of padding. Checked before decoding so a
 *  megabyte of "signature" is refused by length rather than by allocation. */
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/;

/** Builds `avatarPath` — the ONE place its shape is written, so the proxy route, the server and this
 *  validator cannot drift into three spellings of one path. */
export function avatarPathFor(xId: string, avatarHash: string): string {
  return `/api/avatar/${xId}/${avatarHash}.webp`;
}

/** Base58 as Bitcoin defined it — no `0`, no `O`, no `I`, no `l`, because those are the four pairs a
 *  human transcribing a key gets wrong. Solana uses the same alphabet. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * IS THIS THE SHAPE OF A WALLET STRING?
 *
 * Alphabet and length, deliberately NOT a decode-to-exactly-32-bytes check, and the reason is worth
 * recording because the stricter version looks obviously better.
 *
 * A wallet here is a MAP KEY. It is compared against `FighterView.wallet` and never used as a public
 * key — nothing in this file or downstream of it verifies a signature against it. The property that
 * makes the record trustworthy is that the wallet string is INSIDE the bytes the attestation signs,
 * and that holds whatever the string decodes to. A wallet that is not a real key simply matches no
 * fighter, which is the same outcome as a wallet for a player who is not in this round.
 *
 * The stricter check also breaks something real: `data/fixtureLineup.ts#fakeWallet` draws 44 random
 * base58 characters and says so out loud — "Not a real key and not checked as one" — so a fixture
 * wallet decodes to 32 or 33 bytes depending on the draw. Validating the decode would make
 * `?fixture=1&links=mock` work for some fighters and not others, for reasons no reader could see.
 * Right-sizing the check here is the honest fix; weakening the fixture to satisfy a check that buys
 * nothing would be the other one.
 *
 * `keyId` is held to the strict standard instead, because that one really is used as a public key.
 */
function isWalletString(v: string): boolean {
  return BASE58_RE.test(v);
}

/** The signing key, by contrast, must decode to exactly 32 bytes — it is about to be handed to
 *  ed25519 as a public key, and a wrong length there is a thrown exception inside a render rather
 *  than a rejected record. */
function attestationKeyBytes(v: string): Uint8Array | null {
  try {
    const bytes = new PublicKey(v).toBytes();
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Canonical bytes — the format both ends must agree on, forever
// ------------------------------------------------------------------------------------------------

/**
 * THE DOMAIN SEPARATOR. Signed as the first field, so a `bvu.link.v2` payload can never be
 * reinterpreted as a v1 one no matter how its fields line up, and so this signing key's output can
 * never be mistaken for anything else this project might one day sign.
 *
 * The key that signs these signs NOTHING ELSE, ever. That is a policy, and this tag is the part of
 * it a verifier can enforce.
 */
const CANONICAL_TAG = "bvu.link.v1";

const UTF8 = new TextEncoder();

/**
 * NETSTRINGS, and the reason is the display name.
 *
 * The obvious canonical encodings are both wrong here. `JSON.stringify` depends on key order,
 * unicode escaping and number formatting — three things a refactor can change without touching a
 * line of this file, at which point every previously-issued signature stops verifying. Joining the
 * fields with a separator is worse: `displayName` is arbitrary user-controlled unicode, so a name
 * containing the separator lets its owner shift the field boundaries and sign one payload that reads
 * as another. That is a forgery, produced with a legitimate signature, by typing into a text box.
 *
 * A netstring — `<byte length>:<bytes>,` — has no such reading. The length is decided before the
 * content is looked at, so no content can be structure. Nothing needs escaping and nothing can be
 * ambiguous.
 *
 * PRECISELY: this commits to the UTF-8 BYTES, not to the JavaScript string. `TextEncoder` maps every
 * unpaired surrogate to U+FFFD, so `"\uD800"` and `"\uFFFD"` produce identical bytes and one
 * signature covers both. That is the only collision class, it can only be reached through
 * `displayName` (every other field is regex-constrained to an ASCII subset before it gets here), and
 * it buys an attacker nothing: both render as the same replacement glyph. Recorded rather than fixed,
 * because changing the encoding to close a collision with no consequence would be the more dangerous
 * edit.
 *
 * BUILT IN BYTES, NOT IN A STRING, and that is not fussiness. If the length prefix were computed
 * from `s.length` it would count UTF-16 code units while the payload counts UTF-8 bytes, and the two
 * disagree for every emoji and every accented character — which is to say, for a large fraction of
 * real X display names. Encoding each field first and measuring what comes out removes the question.
 */
function netstring(value: string): Uint8Array {
  const body = UTF8.encode(value);
  const prefix = UTF8.encode(`${body.length}:`);
  const out = new Uint8Array(prefix.length + body.length + 1);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  out[out.length - 1] = 0x2c; // ","
  return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The exact bytes the signature covers.
 *
 * THE FIELD ORDER IS PART OF THE FORMAT. Adding a field, removing one, or reordering two is a new
 * version with a new `CANONICAL_TAG` — never an edit to this list. Every signature ever issued is a
 * commitment to this order.
 *
 * Timestamps go in as decimal integers. They are already integers by the time they get here
 * (`assertWireShape` rejects anything else), so there is no formatting choice left to make and no
 * locale or float representation to disagree about.
 */
export function canonicalBytes(a: LinkAttestation): Uint8Array {
  return concatBytes([
    netstring(CANONICAL_TAG),
    netstring(a.wallet),
    netstring(a.xId),
    netstring(a.handle),
    netstring(a.displayName),
    netstring(a.avatarPath),
    netstring(String(a.linkedAt)),
    netstring(String(a.issuedAt)),
    netstring(String(a.expiresAt)),
  ]);
}

// ------------------------------------------------------------------------------------------------
// Verification
// ------------------------------------------------------------------------------------------------

/**
 * WHY A VERIFICATION FAILED. For a log line and for tests — never for a screen.
 *
 * Every one of these collapses to the same rendering: the player is unlinked, exactly as if they had
 * never connected X, with the flat side-coloured disc and a `nameFor()` pseudonym. That is
 * `TWITTER-CONNECT.md` §5's rule and §8's, and it is the right one: a player cannot act on "the
 * attestation signature did not verify", and a page that says so has invented an error state for
 * something that is the ordinary condition of ninety-odd percent of the board.
 */
export type LinkRejection =
  | "malformed"
  | "untrusted-key"
  | "bad-signature"
  | "expired"
  | "not-yet-valid"
  | "bad-wallet"
  | "bad-handle"
  | "bad-x-id"
  | "bad-avatar-path"
  | "house-wallet";

/**
 * A STRING DISCRIMINANT, NOT A BOOLEAN `ok`, and the reason is a property of this project's compiler
 * settings rather than of taste.
 *
 * `er-demo` builds without `strictNullChecks` (see `keeperStatus.ts`, which hit the same wall from
 * the other direction). Under that setting TypeScript **will not narrow a union by a boolean-literal
 * discriminant on the false branch**: `if (v.ok) { … } else { v.reason }` compiles the else branch as
 * the whole union and fails to find `reason`. String-literal discriminants narrow correctly in both
 * configurations, which is why every other union in this codebase — `KeeperCountdown`, `PlayBlock`,
 * `AbandonReason` — is shaped this way. Measured, not assumed: the boolean form was written first and
 * did not compile.
 */
export type Verification =
  | { readonly kind: "ok"; readonly record: LinkRecord }
  | { readonly kind: "rejected"; readonly reason: LinkRejection };

const reject = (reason: LinkRejection): Verification => ({ kind: "rejected", reason });

/** Tolerance on `issuedAt` being in the future. Browser clocks are wrong, routinely by minutes and
 *  occasionally by hours, and a client that refused a fresh attestation because its own clock ran
 *  slow would turn a wrong wall clock into "X connect is broken". Applied ONLY to the not-yet-valid
 *  side; expiry gets no grace, because erring towards showing a revoked face is the direction with a
 *  person on the other end of it. */
const CLOCK_SKEW_GRACE_SECONDS = 5 * 60;

function isFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * Is this unknown thing shaped like an attestation at all? Off the network, so nothing is assumed.
 *
 * Returns the value NARROWED rather than a boolean, so the caller cannot forget to use the narrowing
 * and cannot read a field this function did not check.
 */
function asWireShape(raw: unknown): LinkAttestation | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const { wallet, xId, handle, displayName, avatarPath, linkedAt, issuedAt, expiresAt, sig, keyId } = r;
  if (typeof wallet !== "string" || typeof xId !== "string" || typeof handle !== "string") return null;
  if (typeof displayName !== "string" || typeof avatarPath !== "string") return null;
  if (typeof sig !== "string" || typeof keyId !== "string") return null;
  if (!isFiniteInt(linkedAt) || !isFiniteInt(issuedAt) || !isFiniteInt(expiresAt)) return null;
  return { wallet, xId, handle, displayName, avatarPath, linkedAt, issuedAt, expiresAt, sig, keyId };
}

function decodeBase64(v: string): Uint8Array | null {
  try {
    // `atob` in the browser, and Vitest's Node runtime provides it too (it has been global since
    // Node 16). Nothing here needs a Buffer, which keeps this module free of a Node-only import that
    // would otherwise have to be polyfilled into the bundle.
    const bin = atob(v);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * TURN A CLAIM INTO A FACT, OR INTO NOTHING. The only mint for a `LinkRecord`.
 *
 * The checks run cheapest-first and shape-before-crypto, which is not premature optimisation: a
 * curve operation on a 48-fighter round is 48 of them per poll, and every one of them is avoidable
 * for a payload that was never going to be accepted. It also means a malformed field can never reach
 * the signature check as a surprise length.
 *
 * @param trustedKeys base58 public keys this caller is willing to believe. A SET rather than a single
 *   key from the first commit, because key rotation with one key is a flag day: there is no window in
 *   which both the old and the new signature verify, so every cached bundle in every open tab breaks
 *   at once. Two keys make rotation a deploy instead of an incident. The caller chooses this set, and
 *   that is what keeps the mock fixture's test key out of production — see `linkSource.ts`.
 * @param nowSec unix SECONDS. Passed in rather than read from `Date.now()` so expiry is testable and
 *   so one poll's worth of records is judged against one instant.
 */
export function verifyAttestation(
  raw: unknown,
  trustedKeys: readonly string[],
  nowSec: number,
): Verification {
  const a = asWireShape(raw);
  if (a === null) return reject("malformed");

  if (!isWalletString(a.wallet)) return reject("bad-wallet");
  if (!HANDLE_RE.test(a.handle)) return reject("bad-handle");
  if (!X_ID_RE.test(a.xId)) return reject("bad-x-id");
  // Empty is the wire's "no avatar" (see `LinkAttestation`). Anything non-empty must be exactly the
  // proxy path and nothing else — the header explains why a signature does not buy an exemption here.
  if (a.avatarPath !== "" && !AVATAR_PATH_RE.test(a.avatarPath)) return reject("bad-avatar-path");
  // The path names the account it belongs to. Without this, a signing key that leaked could serve one
  // person's picture under another person's handle, which is the impersonation this feature exists to
  // prevent arriving through the one field nobody reads.
  if (a.avatarPath !== "" && !a.avatarPath.startsWith(`/api/avatar/${a.xId}/`)) {
    return reject("bad-avatar-path");
  }

  if (a.expiresAt <= nowSec) return reject("expired");
  if (a.issuedAt > nowSec + CLOCK_SKEW_GRACE_SECONDS) return reject("not-yet-valid");

  // Trust is decided by the caller's set, and the attestation only gets to say WHICH member — never
  // to add one. See `LinkAttestation.keyId`.
  if (!trustedKeys.includes(a.keyId)) return reject("untrusted-key");
  const keyBytes = attestationKeyBytes(a.keyId);
  if (keyBytes === null) return reject("untrusted-key");
  if (!SIG_RE.test(a.sig)) return reject("bad-signature");
  const sig = decodeBase64(a.sig);
  if (sig === null || sig.length !== 64) return reject("bad-signature");

  let verified = false;
  try {
    verified = ed25519.verify(sig, canonicalBytes(a), keyBytes);
  } catch {
    // Noble throws on a malformed point rather than returning false, and a throw here would take out
    // the whole poll — 47 good records lost to one bad one. A signature that cannot be evaluated is
    // a signature that did not verify.
    verified = false;
  }
  if (!verified) return reject("bad-signature");

  const record = {
      wallet: a.wallet,
      xId: a.xId,
      handle: a.handle,
      displayName: a.displayName === "" ? null : { unsafeText: a.displayName },
      avatarPath: a.avatarPath === "" ? null : a.avatarPath,
      linkedAt: a.linkedAt,
      issuedAt: a.issuedAt,
      expiresAt: a.expiresAt,
    } as unknown as LinkRecord;
    // ^ THE ONE CAST IN THIS FILE, AND IT IS THE MINT — the single sanctioned crossing from claim to
    //   fact, four lines below the signature check that earns it.
    //
    //   THE BRAND IS TYPE-ONLY AND COSTS NOTHING AT RUNTIME. `VERIFIED_BY_XLINK` is a `declare
    //   const`: it tells the compiler a symbol exists without emitting one, so the literal above must
    //   NOT try to write that key. An earlier version did, and every verification threw
    //   `ReferenceError: VERIFIED_BY_XLINK is not defined` — caught by `xLink.test.ts` on its first
    //   run, which is the whole argument for having exercised this path from the first commit rather
    //   than when a server finally existed to talk to.
    //
    //   Hence `as unknown as`: the object genuinely lacks the branded key, so a direct `as LinkRecord`
    //   is rejected for missing a required property. That is the mechanism working as intended — it
    //   is exactly what stops any other module writing this line. A `LinkRecord` is unforgeable
    //   outside this function without the same double cast, which is one grep away from a reviewer.
  //
  // AND INTO THE REGISTER, which is the half a cast cannot fake — see `isVerifiedRecord`. This is the
  // only `minted.add` in the program.
  minted.add(record);
  return { kind: "ok", record };
}

/**
 * A batch of claims into a map of facts. Everything that fails is dropped, silently to the player.
 *
 * @param houseWallets wallets the keeper has published as its own. THE CLIENT HALF of the rule that a
 *   house wallet can never wear a face (`TWITTER-CONNECT.md` §6.3, `SOCIAL.md` §2.7). The durable
 *   guard is the server refusing to create the link at all, and the read path refusing to serve it;
 *   this is the third, here in one function rather than rediscovered at each of the five surfaces
 *   that render a face. An empty list filters nobody, which is `isHouseWallet`'s own rule — a browser
 *   that cannot read the disclosure list has no basis to accuse anyone of being a bot.
 */
export function linkMapFrom(
  raw: unknown,
  trustedKeys: readonly string[],
  nowSec: number,
  houseWallets: readonly string[] = [],
): { readonly links: LinkMap; readonly rejected: readonly LinkRejection[] } {
  const rejected: LinkRejection[] = [];
  if (typeof raw !== "object" || raw === null) return { links: NO_LINKS, rejected: ["malformed"] };
  const listRaw = (raw as { links?: unknown }).links;
  if (!Array.isArray(listRaw)) return { links: NO_LINKS, rejected: ["malformed"] };
  // BOUNDED BY WHAT WE ASKED FOR. The request is capped at `MAX_WALLETS_PER_QUERY`, so a response
  // longer than that is a server bug or a hostile one; iterating it would mean an unbounded number of
  // regex passes and, for anything that verified, an unbounded Map that every consumer then holds.
  // Trusting a response's length because we trust its signatures is the wrong order of operations.
  const list = listRaw.slice(0, MAX_WALLETS_PER_QUERY);

  const links = new Map<string, LinkRecord>();
  for (const entry of list) {
    const v = verifyAttestation(entry, trustedKeys, nowSec);
    if (v.kind === "ok") {
      const record = v.record;
      if (houseWallets.includes(record.wallet)) {
        rejected.push("house-wallet");
        continue;
      }
      // FIRST WRITER WINS. Two attestations for one wallet is a server bug or a replay, and there is
      // no honest way to choose between them — so keep the first and count the second as malformed
      // rather than letting a later row overwrite an earlier one.
      if (links.has(record.wallet)) {
        rejected.push("malformed");
        continue;
      }
      links.set(record.wallet, record);
    } else {
      rejected.push(v.reason);
    }
  }
  return { links: links.size === 0 ? NO_LINKS : links, rejected };
}

// ------------------------------------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------------------------------------

/**
 * THE ONLY WAY TO PRINT A LINKED IDENTITY, and the reason `DisplayName` is not a string.
 *
 * `handle` comes back with its `@` already on it and is never optional, so there is no arrangement of
 * this return value that puts a display name on screen without the one part of an X identity that
 * cannot be forged. See `DisplayName` for the full argument.
 */
export function identityText(record: LinkRecord): { handle: string; displayName: string | null } {
  return {
    handle: `@${record.handle}`,
    displayName: record.displayName === null ? null : record.displayName.unsafeText,
  };
}

/** `https://x.com/<handle>` — for the `open on X ↗` affordance in the fighter inspector. Built here
 *  rather than at the call site so the handle is never interpolated into a URL by hand; `handle` has
 *  already been through `HANDLE_RE`, so there is nothing in it that needs escaping. */
export function profileUrl(record: LinkRecord): string {
  return `https://x.com/${record.handle}`;
}

// ------------------------------------------------------------------------------------------------
// Stage 3 — the ceremony. Types only; nothing implements these yet.
// ------------------------------------------------------------------------------------------------

/**
 * THE SHAPES OF THE LINK CEREMONY, defined now and deliberately unimplemented.
 *
 * They live here so that the contract is complete — a reader can see the whole feature from one file
 * — and so that the identity provider stays an implementation detail. Nothing below names Privy or
 * X: the browser posts a `proof` it does not interpret, the server hands it to whichever broker is
 * configured, and swapping brokers changes neither this file nor anything that imports it. That
 * substitutability is what `TWITTER-CONNECT.md` §5's signed-attestation design was bought for.
 *
 * THERE IS NO SHAPE HERE THAT CAN CARRY A TYPED HANDLE. `LinkRequest` has no `handle` field and never
 * will. The identity comes from `proof`, which only the broker can produce — so the old `prompt()`
 * fallback has nowhere to put its answer, and "OAuth failed" has exactly one representable outcome,
 * which is no link. That is the header's rule, expressed one layer up.
 */
export interface ChallengeRequest {
  /** The wallet CONNECTED IN THE BROWSER AT CLAIM TIME. Never a hint carried from the start of the
   *  ceremony: what the user sees is what they sign is what gets linked. */
  readonly wallet: string;
  /** Single-use, issued by `/api/x/callback`, five minute TTL. Proves fact A (this browser controls
   *  the X account) without the browser ever holding an X credential. */
  readonly ticket: string;
}

export interface ChallengeResponse {
  /** The canonical message, composed BY THE SERVER — `TWITTER-CONNECT.md` §4.2. The client displays
   *  it and signs it verbatim; it never composes one, and the server never re-parses the copy that
   *  comes back. It compares against its own stored bytes. */
  readonly message: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export interface LinkRequest {
  readonly wallet: string;
  readonly ticket: string;
  readonly nonce: string;
  /** base64 of the 64-byte detached ed25519 signature over utf8(`ChallengeResponse.message`). Fact B.
   *  Bound to fact A because the X id is INSIDE the bytes that were signed. */
  readonly signature: string;
}

/** `DELETE /api/x/link` — authenticated by a FRESH wallet signature over a FRESH nonce, so a stolen
 *  ticket or a stale session cannot unlink somebody. Same shape as a link minus the ticket: there is
 *  no X account to prove, only a wallet. */
export interface UnlinkRequest {
  readonly wallet: string;
  readonly nonce: string;
  readonly signature: string;
}

export const X_START_ENDPOINT = "/api/x/start";
export const X_CALLBACK_ENDPOINT = "/api/x/callback";
export const X_CHALLENGE_ENDPOINT = "/api/x/challenge";
export const X_LINK_ENDPOINT = "/api/x/link";
