// THE `?links=mock` SOURCE — Stage 0's whole point: the entire identity feature, end to end, with no
// backend, no secrets, no X account and no money.
//
// WHAT IT ACTUALLY DEMONSTRATES, so nobody has to take the flag on faith. Under `?links=mock` the
// page fetches a file, parses it, SIGNS each record with a real ed25519 key, and then puts every one
// of them through `verifyAttestation` — the same function, with the same canonical bytes, the same
// expiry check, the same same-origin path check and the same branded return type that production
// will use. Nothing is stubbed past the fetch. A record that fails verification here fails for the
// same reason it would fail there, and `LinkRecord` is minted by the same single line of code.
//
// So the things this catches on day one, before any server exists: a canonical-encoding mistake, a
// display name that shifts a field boundary, an avatar path that is not same-origin, a branded type
// that turns out to be constructible from outside, and every layout question the DOM has about a
// board that is part faces and part pseudonyms.
//
// WHY IT SIGNS AT LOAD RATHER THAN SHIPPING SIGNATURES. Attestations expire after seven days
// (`ATTESTATION_TTL_SECONDS`). A committed signature would rot, and the failure would be silent and
// perfectly plausible: everybody renders unlinked, which is also what a correctly-working unlinked
// board looks like. Signing at load with a seed-derived key means the fixture is a JSON file a human
// can edit and cannot expire. `linkSource.ts#MOCK_ATTESTATION_SEED` carries the argument for why
// publishing that seed costs nothing.
//
// THIS MODULE IS THE ONLY PLACE IN THE APP THAT IMPORTS `xLinkSign.ts`. Signing belongs on a server;
// it is here because a fixture has to be honest about being signed. If a second import of that module
// ever appears under `src/`, something has gone wrong.

import { sha256 } from "@noble/hashes/sha256";
import { avatarPathFor, type LinkAttestation } from "./xLink.ts";
import { attestationKeyFrom, signAttestation, type AttestationKey } from "./xLinkSign.ts";
import { MOCK_ATTESTATION_SEED } from "./linkSource.ts";

/** One row of `public/links.mock.json`. No wallet — see `assignMockIdentities`. */
export interface MockIdentity {
  readonly xId: string;
  readonly handle: string;
  /** `""` for "this account has no display name", which is a real X state and one the renderer has
   *  to survive. `mock_vole` is that case. */
  readonly displayName: string;
  /** `""` for "linked, but we do not have the picture" — a real rung on §7.3's failure ladder, and
   *  the one that renders as the ordinary flat disc. `mock_tern` is that case. */
  readonly avatarHash: string;
}

/** The fixture, off the network, so nothing is assumed about it. A malformed row is dropped rather
 *  than throwing: the file is hand-editable by design, and a typo in it should cost one face, not
 *  the page. */
export function parseMockFixture(raw: unknown): readonly MockIdentity[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as { identities?: unknown }).identities;
  if (!Array.isArray(list)) return [];
  const out: MockIdentity[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const { xId, handle, displayName, avatarHash } = entry as Record<string, unknown>;
    if (typeof xId !== "string" || typeof handle !== "string") continue;
    if (typeof displayName !== "string" || typeof avatarHash !== "string") continue;
    out.push({ xId, handle, displayName, avatarHash });
  }
  return out;
}

/** EVERY OTHER ELIGIBLE WALLET gets a face — by position in the list it is handed, not by hashing
 *  the wallet.
 *
 *  A MIXED board is the layout that actually needs reviewing (`TWITTER-CONNECT.md` §8.3: "the mix is
 *  where a row layout that silently assumed an avatar column falls apart"), and it is the honest
 *  picture of a real board, because most players never link.
 *
 *  IT USED TO BE `hash32(wallet) % 3 === 0`, AND THAT FAILED IN THE ONE PLACE IT MATTERED. A hash
 *  filter only approximates its rate over a large pool. The fixture's eligible pool was small at the
 *  time — most of the lineup was being filtered out before this question was even asked — so at nine
 *  fighters there were three eligible wallets and the hash happened to select none of them. The
 *  fixture rendered
 *  exactly one face, the player's own, and looked like a broken feature while every guard beneath it
 *  worked perfectly. Position is exact at every size: 3 eligible gives 2, 48 gives 24, and it can
 *  never round down to nothing. */
const MOCK_LINK_STRIDE = 2;

/**
 * Decide who wears which identity.
 *
 * THE CAST MUST LAND ON THE ROUND ON SCREEN, because reviewing the linked state of the arena is the
 * entire reason this fixture exists. Six identities against fifty-two wallets is not a rate question,
 * it is a priority question, and the answer is stated here rather than left to fall out of whatever
 * happens to be filtering the list upstream this month.
 *
 * SO `wallets` ARRIVES IN THE CALLER'S PRIORITY ORDER AND IS WALKED IN IT — the round on screen
 * first, then the connected player, then the leaderboard's rows (`ArenaProvider` composes it, both
 * providers, and `rosterCast` preserves that composition through the dedupe and the cap).
 *
 * IT USED TO SORT THE LIST ITSELF, AND THAT SORT EMPTIED THE ONE SCREEN THE FLAG IS FOR. `rosterKey`
 * sorts because a canonical key is what stops a re-fetch when a view re-orders the roster; that is
 * the right shape for a cache key and a meaningless one for casting. Handed the sorted form, this
 * function walked fifty-two wallets that are mostly leaderboard aggregate rows and spent five of its
 * six identities off the arena — the round on screen kept exactly one, `you`, whose picture the wallet
 * panel renders as an ordinary `<img>` anyway. Every layer beneath was correct: the records verified,
 * the map was built, the canvas was ready to draw faces nobody had been given. It is the same failure
 * `useLinks.ts` recorded from the other side when a house filter made a working feature invisible,
 * and it survived that filter's removal because nothing had ever said the requirement out loud.
 *
 * `you` is ALWAYS linked when present, because the single most useful thing this flag does for a
 * developer is show them the linked state of their own wallet panel and their own disc.
 *
 * ONE IDENTITY IS NEVER USED TWICE. An X account belongs to exactly one wallet — that invariant is a
 * unique index in the schema and half the reason the store is keyed on `x_id` — so a fixture that
 * put `@mock_otter` on two fighters would be showing a state the real system cannot produce, and
 * somebody would eventually debug it as if it were real.
 *
 * DETERMINISTIC — the same wallets in the same order produce the same assignment on every reload,
 * which is what makes two screenshots comparable. That guarantee has not been dropped, it has changed
 * hands: it used to be bought by the internal sort and is now owed by the caller, and under
 * `?fixture=1` — the path `?links=mock` is actually reviewed on — the caller pays it trivially,
 * because the round, `you` and the standings are all derived from module constants and the list is
 * fixed for the life of the page.
 *
 * WHAT THE SORT DID PROTECT AGAINST, AND WHAT IS LEFT OF THAT. Several views re-sort the roster, and
 * the sort meant none of them could shuffle the faces. The provider does not hand this a view's copy
 * — it hands it the composition above — but on the CHAIN path the tail of that composition is
 * genuinely dynamic: `deriveStandings` ranks by pnl, so a settling round can re-rank the leaderboard
 * without changing the wallet SET, and the next poll would then cast the leftover identities onto
 * different rows. What that cannot reach is the arena. The fighters occupy the FRONT of the list,
 * identities are spent from index zero, and a prefix's assignment is decided entirely by that prefix
 * — so faces on the round on screen are stable for as long as the round is, which is the stability
 * that was actually being asked for. Re-sorting the tail to buy back the rest was considered and
 * rejected: it would hand the leftover identities to whoever sorts lowest in base58, which is the
 * meaningless criterion this whole change exists to stop applying.
 *
 * @param wallets in priority order, already deduped and capped. See `useLinks.ts#rosterCast`.
 */
export function assignMockIdentities(
  identities: readonly MockIdentity[],
  wallets: readonly string[],
  you: string | null,
): ReadonlyMap<string, MockIdentity> {
  const out = new Map<string, MockIdentity>();
  if (identities.length === 0) return out;

  const remaining = [...identities];
  if (you !== null && wallets.includes(you)) out.set(you, remaining.shift() as MockIdentity);

  // `filter` copies, so the caller's array is untouched — which matters because the list it derives
  // from is `live.fighters`, where positional ids name the parties in every hit event.
  const others = wallets.filter((w) => w !== you);
  for (let i = 0; i < others.length; i += MOCK_LINK_STRIDE) {
    if (remaining.length === 0) break;
    out.set(others[i], remaining.shift() as MockIdentity);
  }
  return out;
}

let cachedKey: AttestationKey | null = null;

/** Derived once. `sha256` of the seed phrase is the 32-byte secret — the same derivation
 *  `scripts/make-mock-links.mjs` documents, so the committed public key in `linkSource.ts` and this
 *  signer cannot drift apart. */
function mockKey(): AttestationKey {
  cachedKey ??= attestationKeyFrom(sha256(new TextEncoder().encode(MOCK_ATTESTATION_SEED)));
  return cachedKey;
}

/**
 * Turn the fixture into exactly what `/api/links` would have returned.
 *
 * The output goes through `linkMapFrom` untouched, so from that point on the mock and the real
 * source are indistinguishable to every line of code downstream — which is the property that makes
 * Stage 0 worth building rather than a detour.
 *
 * @param wallets in the caller's priority order — handed straight to `assignMockIdentities`, which
 *   walks it as given and documents why the order is the decision.
 * @param nowSec unix SECONDS, threaded through rather than read here so a test can sign something
 *   already expired and watch it be rejected.
 */
export function mockAttestations(
  identities: readonly MockIdentity[],
  wallets: readonly string[],
  you: string | null,
  nowSec: number,
): readonly LinkAttestation[] {
  const key = mockKey();
  const assigned = assignMockIdentities(identities, wallets, you);
  const out: LinkAttestation[] = [];
  for (const [wallet, id] of assigned) {
    out.push(
      signAttestation(
        {
          wallet,
          xId: id.xId,
          handle: id.handle,
          displayName: id.displayName,
          avatarPath: id.avatarHash === "" ? "" : avatarPathFor(id.xId, id.avatarHash),
          // A fixed, plausible past date rather than `now`. "linked 8 Aug" is rendered in the wallet
          // panel, and a fixture whose link date is always today never shows what an older one looks
          // like — nor whether the column is wide enough for a two-digit day.
          linkedAt: nowSec - 6 * 24 * 60 * 60,
        },
        key,
        nowSec,
      ),
    );
  }
  return out;
}
