-- Persists the Telegram getUpdates long-poll offset, so a Railway restart of the worker
-- neither reprocesses nor skips updates. `key` is currently only ever "getUpdates_offset" (see
-- lib/telegram/loop.ts), but the table is generic key/value in case another small piece of
-- Telegram poll state needs the same durability later.
CREATE TABLE caphub_v2.telegram_state (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A capture whose FIRST analysis run fails never gets a capabilities row, so without this
-- column that failure could never be marked pushed and would be re-sent to Telegram on every
-- notify tick forever. Mirrors capabilities.notified_at, but scoped to the run itself since
-- there may be no capability row to hang it off of (see lib/telegram/notify.ts's second
-- selection branch).
ALTER TABLE caphub_v2.analysis_runs ADD COLUMN notified_at timestamptz;

-- The app role is created out-of-band (see docs/deploy.md) and may not exist yet in every
-- environment this migration runs against, so the grants are guarded (same pattern as 004/005).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caphub_v2_app') THEN
    GRANT SELECT, INSERT, UPDATE ON caphub_v2.telegram_state TO caphub_v2_app;
  END IF;
END $$;
