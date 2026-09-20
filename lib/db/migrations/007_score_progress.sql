-- Adds AI value scoring (score/score_reason/source_facts) and self-build progress tracking
-- to capabilities. No new GRANT is needed: caphub_v2_app already has table-level
-- SELECT/INSERT/UPDATE on caphub_v2.capabilities from migration 001, and Postgres
-- column-level privileges default to the table's existing grants for new columns.
ALTER TABLE caphub_v2.capabilities
  ADD COLUMN score integer CHECK (score BETWEEN 1 AND 5),
  ADD COLUMN score_reason text,
  ADD COLUMN source_facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN progress text NOT NULL DEFAULT 'todo'
    CHECK (progress IN ('todo','planned','building','done','dropped')),
  ADD COLUMN progress_link text,
  ADD COLUMN progress_at timestamptz;
CREATE INDEX capabilities_progress_idx ON caphub_v2.capabilities (progress)
  WHERE usage = 'reference' AND deleted_at IS NULL;
