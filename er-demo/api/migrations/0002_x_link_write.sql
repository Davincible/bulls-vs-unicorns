-- ================================================================================================
-- 0002 — the WRITE path.  `TWITTER-CONNECT.md` §10 Stage 3, with Privy substituted for a raw X
-- developer app (§3.4's sanctioned contingency: "nothing else changes").
--
-- HOW TO RUN THIS.  Exactly as 0001, and for the same reason — nothing runs it automatically,
-- because a migration that runs itself on cold start is a migration that runs a thousand times
-- concurrently in the first minute after a deploy.
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f er-demo/api/migrations/0002_x_link_write.sql
--
-- Idempotent and transactional, like 0001.  `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT
-- EXISTS` throughout, one `BEGIN`/`COMMIT`, so a half-applied migration is not a state this can
-- reach.  0001 is NOT edited: it is already applied to the live database, and a migration that has
-- run is a historical record rather than a document.
--
-- ------------------------------------------------------------------------------------------------
-- WHAT THIS FILE ADDS, AND WHY EACH PIECE IS IN THE DATABASE RATHER THAN IN A PROCESS.
--
--   1. `x_link.avatar_url` becomes NULLABLE.  A verified X account with no profile picture is a real
--      state that could not previously be stored.  See the block below; it is the only change to an
--      existing object in this file.
--   2. `x_link_challenge` — the single-use, expiring wallet-ownership challenge.  In Postgres and
--      not in a KV store for the reason 0001 gives about the register itself: single-use has to be
--      ATOMIC, and `DELETE ... RETURNING` is one statement that either hands you the challenge or
--      hands you nothing.  Two processes cannot both win it.  A "read it, check a used flag, write
--      the flag" sequence in any store without transactions can only *try* not to.
--   3. `x_link_rate` — the fixed-window rate counters, per IP network and per wallet.  Also here
--      rather than in memory, and that one is not a preference either: the write path is a set of
--      serverless workers with no shared memory, created and destroyed per burst, so a per-process
--      counter bounds nothing.  A rate limit that resets when the attacker's next request lands on a
--      cold worker is a rate limit in name.
--
-- The volumes make this cheap: §2.5 budgets 1,000 link events a month.  Every statement below is a
-- primary-key lookup or a primary-key upsert.
-- ================================================================================================

BEGIN;

-- ------------------------------------------------------------------------------------------------
-- 1.  `avatar_url` BECOMES NULLABLE, AND THE CHECK CONSTRAINT IS DELIBERATELY LEFT ALONE.
--
-- THE CASE THAT FORCED THIS.  X accounts with no custom profile picture are served the default egg
-- from `https://abs.twimg.com/sticky/default_profile_images/...` — a DIFFERENT host from the
-- `pbs.twimg.com` that 0001's CHECK constrains this column to, and the correct host for a picture we
-- would not want to ingest even if we could: the arena's own flat side-coloured disc (§7.3's
-- ordinary rung) is better-looking and more honest than X's grey silhouette.  Under `NOT NULL` such
-- an account cannot be stored at all, so the ceremony would have to refuse a link that was
-- otherwise perfectly proven, with an error the player can neither understand nor fix.  That is the
-- same defect 0001 already fixed for `avatar_hash`, arriving one column to the left.
--
-- NULL now means exactly what the rest of the system already models: THERE IS NO UPSTREAM PICTURE.
-- `avatar_hash` NULL means "we have not fetched one yet"; the two compose, and `/api/links` emits
-- `avatarPath: ""` for either, which the client renders as the flat disc it draws for every unlinked
-- fighter anyway.  Nothing new appears on any screen.
--
-- THE CHECK IS NOT TOUCHED, AND THAT IS THE POINT RATHER THAN AN OVERSIGHT.  SQL check constraints
-- are satisfied when the expression is TRUE *or NULL*, so `avatar_url ~ '^https://pbs\.twimg\.com/'`
-- already admits NULL and already refuses every non-`pbs` string.  Dropping and recreating it to
-- spell `avatar_url IS NULL OR avatar_url ~ ...` would change nothing about which rows the database
-- accepts, and would briefly drop the one constraint standing between a compromised writer and an
-- SSRF (0001: "a compromised writer would have to pass a migration review to get an SSRF out of this
-- table").  The anti-SSRF guarantee is unchanged and unweakened: NULL points a fetcher nowhere.
--
-- REJECTED: widening the CHECK to allow `abs.twimg.com` as well.  It would let the default egg be
-- stored and then ingested, which spends a fetch, 6 KiB of `bytea` and a moderation surface to
-- replace the house style with a worse picture.  The value of that column is a picture worth
-- serving; "no picture" is not a URL.
--
-- REJECTED: writing a sentinel URL for accounts with no picture, which is what
-- `scripts/xlink-seed.ts` did (it defaulted to a `pbs.twimg.com/sticky/default_profile_images/...`
-- path — the right shape for the CHECK, the wrong host for that file, so it 404s at ingest, every
-- time, for ever).  A column that says "the picture is at this address" when there is no picture at
-- that address is a lie in the data, and the cost of the lie is a permanent failing fetch per
-- refresh.  That default is removed in the same change as this migration.
-- ------------------------------------------------------------------------------------------------
ALTER TABLE x_link ALTER COLUMN avatar_url DROP NOT NULL;

COMMENT ON COLUMN x_link.avatar_url IS
  'The upstream pbs.twimg.com picture. NEVER served to a browser — the CHECK is the anti-SSRF '
  'control, since the ingest fetches exactly this column. NULL means the X account has no profile '
  'picture (X serves the default egg from abs.twimg.com, a host this column may not name), which '
  'renders as the flat side-coloured disc — see 0002.';

-- ------------------------------------------------------------------------------------------------
-- 2.  THE CHALLENGE.  One row per ceremony in flight, deleted the instant it is used.
--
-- WHAT IT IS FOR.  `TWITTER-CONNECT.md` §4 needs two independent facts bound to each other:
--
--   (A) this browser controls the X account   — proved by a Privy identity token, verified against
--       Privy's JWKS before this row is written (`api/src/privyIdentity.ts`);
--   (B) this browser controls the wallet      — proved by an ed25519 signature over `message`.
--
-- THE BINDING IS THAT (A) IS INSIDE THE BYTES THAT PROVE (B).  `message` names the wallet, the
-- handle AND the numeric X id, so a signature collected for one ceremony cannot be pointed at a
-- different X account, and a signature harvested anywhere else cannot be replayed here.  That is why
-- the composed message is STORED rather than recomposed at verification time, and why the client
-- never sends it back: §4.2's "the server compares the submitted message against its stored copy
-- byte for byte, never re-parse a client-supplied string" is stronger still if there is no submitted
-- copy to compare.  `POST /api/x/link` carries `{ wallet, nonce, signature }` and nothing else.
--
-- SINGLE USE IS A DELETE, NOT A FLAG.  `api/src/pgWriteStore.ts` consumes a challenge with
-- `DELETE FROM x_link_challenge WHERE nonce = $1 AND expires_at > now() RETURNING ...` — one
-- statement, so expiry and single-use are the same predicate and neither can be checked by a caller
-- who forgot.  A `consumed_at` column would need a read, a decision and a write, and would leave a
-- window between them; there is no arrangement of three statements that beats one.
--
-- WHAT THIS TABLE IS NOT.  A row here is an UNPROVEN CLAIM: anybody who holds an X account can ask
-- for a challenge naming any wallet at all, because the whole point of the ceremony is that they
-- then cannot sign for it.  So a (wallet, x_id) pair in this table means nothing, it is never read
-- by any read path, it lives for five minutes, and it must never be mistaken for a link.  The
-- register is `x_link`; this is a waiting room.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS x_link_challenge (
  -- 32 bytes of CSPRNG, lowercase hex.  Hex rather than base64url (which is the spelling in
  -- `src/v2/SOCIAL.md` §2.2's sketch) so that one anchored regex can constrain it here, in
  -- `challengeMessage.ts` and in the handler's parser, with no alphabet to argue about and no
  -- padding.  32 bytes is 256 bits of unguessability, which is not the security boundary anyway —
  -- the signature is — but a guessable nonce would let a stranger burn a ceremony in flight.
  nonce         TEXT PRIMARY KEY
                CHECK (nonce ~ '^[0-9a-f]{64}$'),

  -- WHICH CEREMONY THIS IS, AND IT IS LOAD-BEARING RATHER THAN DESCRIPTIVE.  A challenge issued for
  -- an unlink must not be redeemable as a link and vice versa; the intent is written into the signed
  -- `message` as a sentence a human reads, and it is written here as an enum the server checks
  -- before it does anything.  Two places, because the first is what the player consents to and the
  -- second is what the code enforces.
  purpose       TEXT NOT NULL
                CHECK (purpose IN ('link', 'unlink')),

  -- The wallet this challenge is for, and the ONLY wallet whose signature can redeem it.  Same
  -- base58 floor as `x_link.wallet`; `isBase58Pubkey()` in `xLink.ts` is what actually decodes and
  -- confirms 32 bytes, and the API enforces that before writing here.
  wallet        TEXT NOT NULL
                CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),

  -- ----------------------------------------------------------------------------------------------
  -- THE VERIFIED X IDENTITY, SNAPSHOTTED AT CHALLENGE TIME — and NULL for an unlink.
  --
  -- An unlink deliberately requires NO X credential.  A player who has lost access to their X
  -- account, or deleted it, must still be able to take their face off this site; requiring a fresh
  -- Privy token to unlink would make revocation depend on the identity provider the player is
  -- trying to walk away from.  §6.2 asks only for "a fresh wallet signature over a fresh nonce",
  -- and that is exactly what an unlink challenge is.
  --
  -- The CHECK at the bottom of the table is what makes that a structure rather than a convention: an
  -- unlink challenge CANNOT carry an identity, so no code path can promote one into a link.
  -- ----------------------------------------------------------------------------------------------
  x_id          TEXT
                CHECK (x_id ~ '^[0-9]{1,20}$'),
  handle        TEXT
                CHECK (handle ~ '^[A-Za-z0-9_]{1,15}$'),
  display_name  TEXT
                CHECK (char_length(display_name) <= 100),
  avatar_url    TEXT
                CHECK (avatar_url ~ '^https://pbs\.twimg\.com/'),

  -- ----------------------------------------------------------------------------------------------
  -- THE BYTES THE WALLET IS ASKED TO SIGN, VERBATIM.
  --
  -- Composed by `api/src/challengeMessage.ts` and stored exactly as it was returned to the browser.
  -- Verification signs nothing and parses nothing: it hands these bytes, this wallet and the
  -- client's 64-byte signature to ed25519.verify.  Recomposing the message at verification time
  -- would work right up until the day the composer changed — a deploy in the middle of somebody's
  -- ceremony would then reject a signature that was perfectly valid over the words they actually
  -- saw.
  --
  -- Bounded, because it is a value this API generates and an unbounded TEXT column in a table
  -- strangers can insert into is a storage bill with a shape.  The real message is ~400 bytes.
  -- ----------------------------------------------------------------------------------------------
  message       TEXT NOT NULL
                CHECK (char_length(message) BETWEEN 1 AND 2000),

  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- FIVE MINUTES, set by the writer rather than defaulted here, so the TTL lives in one place in
  -- TypeScript (`CHALLENGE_TTL_SECONDS`) next to the sentence in `message` that states it to the
  -- player.  A default here would be a second copy of a number the player is shown.
  expires_at    TIMESTAMPTZ NOT NULL,

  -- An identity is present for a link and absent for an unlink.  Neither half of that is optional
  -- and neither is checked in a handler: a link challenge with no X id could not compose a binding
  -- message, and an unlink challenge WITH one would be a link that skipped the identity proof.
  CONSTRAINT x_link_challenge_identity_matches_purpose CHECK (
    (purpose = 'link'
       AND x_id IS NOT NULL
       AND handle IS NOT NULL
       AND display_name IS NOT NULL)
    OR
    (purpose = 'unlink'
       AND x_id IS NULL
       AND handle IS NULL
       AND display_name IS NULL
       AND avatar_url IS NULL)
  ),

  CONSTRAINT x_link_challenge_expires_after_issue CHECK (expires_at > issued_at)
);

-- The only index this table needs beyond its primary key.  Every read is `WHERE nonce = $1`; this
-- one serves the housekeeping sweep (`DELETE ... WHERE expires_at < now()`, folded into the write
-- path so there is no cron to forget) and keeps it from scanning the table.
CREATE INDEX IF NOT EXISTS x_link_challenge_expires_at_idx ON x_link_challenge (expires_at);

COMMENT ON TABLE x_link_challenge IS
  'Wallet-ownership challenges in flight (TWITTER-CONNECT.md §4.1). A row is an UNPROVEN claim: '
  'anyone can request one naming any wallet, because the ceremony is that they cannot then sign for '
  'it. Single-use by DELETE ... RETURNING, five-minute TTL, never read by any read path.';
COMMENT ON COLUMN x_link_challenge.message IS
  'The exact bytes returned to the browser and handed to ed25519.verify. Stored rather than '
  'recomposed so that a deploy mid-ceremony cannot reject a signature over the words the player saw.';

-- ------------------------------------------------------------------------------------------------
-- 3.  THE RATE COUNTERS.  Fixed window, one row per subject, reset in place.
--
-- WHY THE KEY IS AN OPAQUE DIGEST AND NOT AN IP OR A WALLET.  A table pairing IP addresses with
-- wallet addresses is a deanonymisation database — a worse one than the link register it is
-- protecting, because the register only holds identities people chose to publish.  So no address of
-- either kind is ever written here: `api/src/rateLimit.ts` stores
-- `HMAC(derived-secret, kind || subject)`, and for an IP the subject is the /24 (IPv4) or /48
-- (IPv6) NETWORK, never the address.  An individual IP is therefore not merely unreadable from this
-- table, it was never hashed into it.  See that file for the key-derivation argument.
--
-- FIXED WINDOW, NOT A SLIDING ONE.  A sliding window needs a row per event; a fixed window needs a
-- row per subject and a comparison.  The worst case of a fixed window is 2x the nominal rate across
-- a boundary, which for limits measured in "a handful of link ceremonies per ten minutes" is not a
-- distinction with a cost attached.
--
-- ONE ROW PER SUBJECT, REUSED.  `window_start` is rewritten when a window rolls over rather than
-- inserting a new row per window, so the table's size is the number of distinct subjects that have
-- ever hit the write path — thousands a year at §2.5's volumes — instead of that times the number of
-- windows.  Rows untouched for a day are swept by the same housekeeping statement as the expired
-- challenges.
-- ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS x_link_rate (
  -- Lowercase hex of an HMAC-SHA-256.  A fixed-width opaque token: this table cannot be read as
  -- addresses even by somebody holding it.
  bucket        TEXT PRIMARY KEY
                CHECK (bucket ~ '^[0-9a-f]{64}$'),
  -- The start of the window this count belongs to.  Compared, not trusted: a row whose window has
  -- rolled over is reset to 1 rather than incremented, in the same statement, so there is no read
  -- back to the caller and no window in which two workers both decide to reset.
  window_start  TIMESTAMPTZ NOT NULL,
  hits          INTEGER NOT NULL
                CHECK (hits > 0)
);

CREATE INDEX IF NOT EXISTS x_link_rate_window_start_idx ON x_link_rate (window_start);

COMMENT ON TABLE x_link_rate IS
  'Fixed-window rate counters for the write path. The key is an HMAC over a /24-or-/48 IP NETWORK '
  'or a wallet — never an IP address — so this table is not a deanonymisation surface. See '
  'er-demo/api/src/rateLimit.ts.';

COMMIT;
