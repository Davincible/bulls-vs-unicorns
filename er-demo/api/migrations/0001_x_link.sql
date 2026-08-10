-- ================================================================================================
-- 0001 — the wallet <-> X identity register.  `TWITTER-CONNECT.md` §4.3.
--
-- HOW TO RUN THIS.  It is not run by any deploy, on purpose: a migration that runs itself on cold
-- start is a migration that runs a thousand times concurrently the first minute after a deploy.
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f er-demo/api/migrations/0001_x_link.sql
--
-- `DATABASE_URL` is the Neon connection string (the pooled `-pooler` host is fine here; the
-- statements below are all DDL and take no advantage of a session).  Idempotent — every object is
-- created `IF NOT EXISTS` and the whole file is one transaction, so a half-applied migration is not
-- a state this can reach.
--
-- ------------------------------------------------------------------------------------------------
-- WHY POSTGRES AND NOT REDIS, stated once, here, because it is the only reason the choice was made.
--
-- Relinking one X account from wallet W1 to wallet W2 has to delete W1's row and write W2's row **as
-- one indivisible act**.  Anything less leaves a window — however short — in which one X identity is
-- attached to two different fighters, and that window is not a theoretical concern: it is exactly
-- the state an attacker would race for, because both rows verify, both render, and the leaderboard
-- shows one person on two wallets.  A single `INSERT ... ON CONFLICT` against a table carrying BOTH
-- unique constraints cannot produce that state at all; the database refuses it.  A key-value store
-- with two independent keys can only *try* not to.
--
-- That is the whole argument.  Everything else about this table would be perfectly happy in Redis.
-- ================================================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS x_link (
  -- ----------------------------------------------------------------------------------------------
  -- THE PRIMARY KEY IS THE X ACCOUNT ID, AND IT IS NEVER THE HANDLE.
  --
  -- Handles are recyclable.  Someone deletes `@foo`; X releases the name; an attacker registers
  -- `@foo`; and a store keyed on the handle has just silently handed one person's identity to
  -- another, with no write, no event, and nothing to audit.  The numeric id is immutable for the
  -- life of the account and is never reissued, so the identity cannot transfer even when the label
  -- does.  The handle below is a snapshot of a label; THIS is the identity.
  -- ----------------------------------------------------------------------------------------------
  x_id          TEXT PRIMARY KEY
                CHECK (x_id ~ '^[0-9]{1,20}$'),

  -- ----------------------------------------------------------------------------------------------
  -- UNIQUE, AND THAT IS THE SECOND HALF OF THE INVARIANT.
  --
  -- `x_id` unique alone says "one wallet per X account".  `wallet` unique says "one X account per
  -- wallet".  Both together are what makes the relink above a single conflicting insert rather than
  -- a delete-then-insert with a gap in the middle: moving X account X from W1 to W2 collides on
  -- `x_id`, updates in place, and W1 simply stops existing as a row.  One statement, one lock, no
  -- window.  Drop either index and the register can represent one X account on two fighters.
  --
  -- The regex is the base58 alphabet (no 0, O, I, l) at ed25519 pubkey length.  It is a floor, not
  -- the check — `isBase58Pubkey()` in `xLink.ts` decodes and confirms 32 bytes, and that is what the
  -- API enforces.  This exists so a hand-seeded row cannot put something un-servable in the table.
  -- ----------------------------------------------------------------------------------------------
  wallet        TEXT NOT NULL UNIQUE
                CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),

  -- Snapshot of the label, no leading `@`.  May drift from X between refreshes; `identityText()` is
  -- the only thing that renders it and it always renders it.  Shape matches `HANDLE_RE` in
  -- `xLink.ts` exactly, so a row that would fail client-side verification cannot be written here.
  handle        TEXT NOT NULL
                CHECK (handle ~ '^[A-Za-z0-9_]{1,15}$'),

  -- Snapshot.  `''` means "no display name" — the wire has no null (see `LinkAttestation`), and one
  -- representation of absence is one fewer thing for the two ends to disagree about.  Bounded at
  -- 100 because it goes into a netstring in a signed payload: X's own limit is 50 characters, so
  -- this is 2x headroom and still a bound.  An unbounded field here is an unbounded response.
  display_name  TEXT NOT NULL DEFAULT ''
                CHECK (char_length(display_name) <= 100),

  -- ----------------------------------------------------------------------------------------------
  -- THE UPSTREAM PICTURE.  NEVER SERVED TO A BROWSER, and the CHECK is why that is a fact rather
  -- than a habit: the ingest fetches exactly this column, so constraining it to X's own image CDN
  -- makes "point the fetcher at an internal host" unrepresentable in storage.  A compromised writer
  -- would have to pass a migration review to get an SSRF out of this table.
  --
  -- The same allowlist is enforced again in `avatarIngest.ts`, where the fetch actually happens.
  -- Two checks, because this one is the durable one and that one is the testable one.
  -- ----------------------------------------------------------------------------------------------
  avatar_url    TEXT NOT NULL
                CHECK (avatar_url ~ '^https://pbs\.twimg\.com/'),

  -- ----------------------------------------------------------------------------------------------
  -- THE THREE AVATAR COLUMNS MOVE TOGETHER OR NOT AT ALL — see the CHECK at the bottom.
  --
  -- NULLABLE, WHICH IS A DELIBERATE DEPARTURE FROM §4.3.  The document writes `avatar_hash TEXT NOT
  -- NULL`, and that turns out to be unsatisfiable alongside two other things the same document
  -- says: §7.3's failure ladder lists "linked + avatar in flight" as an ordinary rung, and
  -- `LinkAttestation.avatarPath` in `xLink.ts` documents `""` as "no avatar yet".  NOT NULL forces
  -- the upstream fetch to succeed inside the link ceremony, which means a hiccup at X's CDN fails a
  -- link that was otherwise perfectly proven.  NULL is the state the rest of the system already
  -- models; the register should be able to say it.
  --
  -- `avatar_hash` is the sha256 of the RE-ENCODED bytes, not of the upstream file, which is why it
  -- cannot be known before ingest and why it is also the CDN cache key: identical bytes, identical
  -- URL, and any change to the picture changes the URL rather than the cached body.
  --
  -- `avatar_bytes` IS WHERE "THE LAST GOOD BYTES" LIVE (§7.2's final rule).  They are in the row
  -- because the row is the only place they can be atomic with the hash that names them, and because
  -- a failed ingest then costs nothing by construction: ingest only ever writes on success, so a
  -- transient upstream failure is a no-op and the previous picture is still there.  There is no
  -- eviction path, no second service, and no way for the bytes and their name to disagree.
  --
  -- Bounded at 64 KiB.  A 128x128 WebP is 3-8 KiB; anything an order of magnitude past that did not
  -- come from this ingest.
  -- ----------------------------------------------------------------------------------------------
  avatar_hash   TEXT
                CHECK (avatar_hash ~ '^[0-9a-f]{64}$'),
  avatar_bytes  BYTEA
                CHECK (octet_length(avatar_bytes) BETWEEN 1 AND 65536),
  avatar_at     TIMESTAMPTZ,

  -- Unix instants, as `TIMESTAMPTZ` because a database that stores an integer for a time is a
  -- database nobody can query by hand.  Everything on the wire is unix SECONDS; the conversion is
  -- `extract(epoch from ...)` and it happens in exactly one file (`pgStore.ts`).
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ----------------------------------------------------------------------------------------------
  -- THE KILL SWITCH (§7.4).  One boolean, honoured by BOTH read paths — `/api/links` will not emit
  -- the row and the avatar proxy will not serve the bytes.
  --
  -- A flag rather than a delete, because suppression is an operator judgement about a picture, not
  -- a player's request to be forgotten.  The two must not be the same operation: a delete is the
  -- player's (§6.2, and it is a real delete), and it must stay available to them afterwards.
  --
  -- "A moderation capability you have to build during the incident is not a capability."  The
  -- operator command is `er-demo/scripts/xlink-suppress.ts`.
  -- ----------------------------------------------------------------------------------------------
  suppressed    BOOLEAN NOT NULL DEFAULT FALSE,

  -- The three avatar columns are one fact in three columns.  A hash with no bytes is a URL the
  -- proxy would 404 on while `/api/links` advertised it — a hole on the leaderboard, produced by a
  -- half-written row.  Bytes with no hash are bytes nothing can ever address.  Neither is a state
  -- worth being able to reach, so the database refuses both.
  CONSTRAINT x_link_avatar_all_or_nothing CHECK (
    (avatar_hash IS NULL AND avatar_bytes IS NULL AND avatar_at IS NULL)
    OR
    (avatar_hash IS NOT NULL AND avatar_bytes IS NOT NULL AND avatar_at IS NOT NULL)
  )
);

-- `wallet` is already indexed by its UNIQUE constraint, and that index is what `/api/links` reads
-- through (`WHERE wallet = ANY($1)`).  There is deliberately no second index: this table is a few
-- thousand rows at the volumes in §2.5, both access paths are unique-key lookups, and an index that
-- earns nothing still has to be written on every link.

COMMENT ON TABLE  x_link IS
  'wallet <-> X identity register. Keyed on the immutable X account id, unique in both directions. '
  'See er-demo/api/migrations/0001_x_link.sql for why each uniqueness holds.';
COMMENT ON COLUMN x_link.x_id IS
  'X immutable numeric account id. PRIMARY KEY because handles are recyclable: delete @foo, an '
  'attacker registers @foo, and a handle-keyed store hands over the identity with no write to audit.';
COMMENT ON COLUMN x_link.wallet IS
  'base58 ed25519 pubkey. UNIQUE so that relinking an X account from wallet W1 to W2 removes W1 in '
  'the SAME transaction — otherwise one X account is on two fighters at once. That atomicity is why '
  'this is Postgres and not Redis.';
COMMENT ON COLUMN x_link.avatar_bytes IS
  'The last good bytes (TWITTER-CONNECT.md §7.2). Written only by a successful ingest, atomically '
  'with avatar_hash, so a transient upstream failure is a no-op rather than a lost picture.';
COMMENT ON COLUMN x_link.suppressed IS
  'Operator kill switch (§7.4). Honoured by /api/links AND the avatar proxy. Not a delete: a delete '
  'is the player''s own revocation (§6.2) and must remain available to them.';

COMMIT;
