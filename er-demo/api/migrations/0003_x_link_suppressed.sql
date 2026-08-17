-- ================================================================================================
-- 0003 — SUPPRESSION HAS TO OUTLIVE THE ROW IT SUPPRESSES.
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f er-demo/api/migrations/0003_x_link_suppressed.sql
--
-- Idempotent and transactional, like 0001 and 0002. Run it in order; it backfills from `x_link`.
--
-- ------------------------------------------------------------------------------------------------
-- THE DEFECT THIS CLOSES, FOUND IN REVIEW OF THE STAGE 3 WRITE PATH.
--
-- §7.4's kill switch was a BOOLEAN COLUMN ON `x_link` (0001), and §6.2's revocation is a real DELETE of
-- that row — deliberately available to a player even while they are suppressed, because the two
-- operations answer to different people and neither may block the other. Those two correct decisions
-- compose into a bypass that is three self-service, correctly-signed steps long:
--
--   1. an operator suppresses an identity        -> `suppressed = true`, invisible on both read paths
--   2. the player calls DELETE /api/x/link       -> the row goes, AND THE FLAG GOES WITH IT
--   3. the player links again                    -> a fresh INSERT, `suppressed` takes its DEFAULT FALSE
--                                                   and the identity is back on the leaderboard
--
-- Step 3 does not even reach the `ON CONFLICT (x_id) DO UPDATE` branch that `pgWriteStore.ts` was
-- careful to keep away from `suppressed`: there is no conflicting row left to update. The comments
-- asserting that a relink cannot clear the flag were true of the branch they were written about and
-- false of the one nobody looked at. "A moderation capability you have to build during the incident is
-- not a capability" — and neither is one a player can switch off.
--
-- ------------------------------------------------------------------------------------------------
-- WHY A SEPARATE TABLE AND NOT A CLEVERER COLUMN.
--
-- The flag models the wrong subject. Suppression is an operator's judgement about AN IDENTITY — an X
-- account whose picture or handle should not appear here — and an identity outlives any particular row
-- about it. `x_link` rows are the player's to create and destroy, by design; this decision is not.
--
-- So the durable record is keyed on `x_id` in a table the ceremony can only READ, and `x_link.suppressed`
-- becomes a denormalised copy of it — kept because both read paths already filter on it in SQL
-- (`pgStore.ts`), which is what makes §7.4 impossible for a handler to forget. `setSuppressed` writes
-- both in one statement; `link` seeds the column from this table on insert; `unlink` touches neither.
--
-- REJECTED: refusing to unlink a suppressed row. It makes the kill switch override a player's
-- revocation, which inverts §6.2 — the person asking to be removed is the one party with an
-- unconditional right to be.
--
-- REJECTED: having the read paths join this table instead of keeping the column. The join would be
-- correct and it would put §7.4's rule back into a query somebody can write without it. One boolean in
-- the WHERE clause of every read is worth more than the normalisation.
-- ================================================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS x_link_suppressed (
  -- X's immutable numeric account id. Same shape as `x_link.x_id`, and deliberately NOT a foreign key:
  -- the whole point is that this row survives the deletion of the `x_link` row, so a reference to it
  -- would be a constraint against the feature.
  x_id  TEXT PRIMARY KEY
        CHECK (x_id ~ '^[0-9]{1,20}$'),

  -- When an operator took it down. For the incident write-up; nothing reads it.
  at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill, so an identity suppressed before this migration is not quietly un-suppressed by the first
-- unlink-relink after it. Expected to be a no-op today — the register is empty — and it is written
-- anyway, because "the table happened to be empty" is not a migration strategy.
INSERT INTO x_link_suppressed (x_id)
SELECT x_id FROM x_link WHERE suppressed
ON CONFLICT (x_id) DO NOTHING;

COMMENT ON TABLE x_link_suppressed IS
  'The durable half of the §7.4 kill switch. Keyed on x_id and NOT a foreign key, because it must '
  'survive the deletion of the x_link row: a player may unlink while suppressed (§6.2), and without '
  'this the next link would come back un-suppressed. x_link.suppressed is a denormalised copy that the '
  'read paths filter on; this is the record. See 0003 for the bypass it closes.';

COMMIT;
