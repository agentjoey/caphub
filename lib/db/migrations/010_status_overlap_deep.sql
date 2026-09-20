-- Adds a per-capability lifecycle status (active/deprecated/superseded, human-managed
-- elsewhere) plus library-overlap detection (whether this card duplicates, upgrades, is
-- superseded by, or complements another kept card -- written by the analysis reason step,
-- see lib/analysis/pipeline.ts and lib/analysis/capabilities.ts's upsertCapability), and
-- reserves columns for the upcoming M3.6 deep-analysis feature. No GRANT is needed for the
-- new capabilities/analysis_runs columns: caphub_v2_app already has table-level
-- SELECT/INSERT/UPDATE on both tables from migration 001, and Postgres column-level
-- privileges default to the table's existing grants for new columns (same note as 007/008/009).
ALTER TABLE caphub_v2.capabilities
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','deprecated','superseded')),
  ADD COLUMN superseded_by text REFERENCES caphub_v2.capabilities(id),
  ADD COLUMN status_at timestamptz,
  ADD COLUMN status_note text,
  ADD COLUMN overlap jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN deep_analysis jsonb,
  ADD COLUMN deep_analysis_at timestamptz,
  ADD COLUMN deep_analysis_of timestamptz;
CREATE INDEX capabilities_status_idx ON caphub_v2.capabilities (status)
  WHERE deleted_at IS NULL;

-- `kind` distinguishes a normal analysis run from the upcoming deep-analysis run; both share
-- the same run/step machinery.
ALTER TABLE caphub_v2.analysis_runs
  ADD COLUMN kind text NOT NULL DEFAULT 'analysis'
    CHECK (kind IN ('analysis','deep'));

-- 001's analysis_steps.step CHECK only allows the four steps the normal pipeline uses
-- (vision/search/reason/review). Deep analysis adds two more (plan, synthesize), widened here
-- rather than in a later migration. The constraint name follows 008/009's confirmed
-- convention for an unnamed single-column CHECK created in 001: analysis_steps_step_check.
ALTER TABLE caphub_v2.analysis_steps DROP CONSTRAINT analysis_steps_step_check;
ALTER TABLE caphub_v2.analysis_steps ADD CONSTRAINT analysis_steps_step_check
  CHECK (step IN ('vision','search','reason','review','plan','synthesize'));

-- 003's analysis_runs_one_active unique index constrains (capture_id, pipeline) with no
-- `kind` predicate. Once `kind` exists on the same table, that index would also block
-- queueing a deep run for a capture that already has an active normal run (same
-- capture_id + pipeline, different kind). Recreate it scoped to kind = 'analysis' so a deep
-- run's own uniqueness is governed solely by the new analysis_runs_one_active_deep index below.
DROP INDEX caphub_v2.analysis_runs_one_active;
CREATE UNIQUE INDEX analysis_runs_one_active
  ON caphub_v2.analysis_runs (capture_id, pipeline)
  WHERE state IN ('queued','running') AND kind = 'analysis';
CREATE UNIQUE INDEX analysis_runs_one_active_deep
  ON caphub_v2.analysis_runs (capture_id)
  WHERE kind = 'deep' AND state IN ('queued','running');
