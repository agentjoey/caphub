-- Adds a sixth fixed capability type, 'tool', for things that run on their own (CLI apps,
-- desktop/web apps, local services, agent runtime frameworks) — previously such a card had to
-- be mis-typed as 'skill' or 'other'. The CHECK on `type` was created unnamed inline in 001, so
-- Postgres gave it the default name for a single-column CHECK: capabilities_type_check (same
-- convention already confirmed by 002's analysis_runs_pipeline_check widening).
ALTER TABLE caphub_v2.capabilities DROP CONSTRAINT capabilities_type_check;
ALTER TABLE caphub_v2.capabilities ADD CONSTRAINT capabilities_type_check
  CHECK (type IN ('skill', 'experience', 'plugin', 'prompt', 'tool', 'other'));

-- Records whether `type` was last set by a human (改建议) or by the analysis pipeline (auto).
-- A rerun of an already-human-typed capability must honor the pinned type instead of letting
-- the model re-derive (and possibly revert) it — see lib/analysis/pipeline.ts and
-- lib/library/actions.ts's editSuggestion. Defaults to 'auto' so every existing row (and every
-- brand-new capability inserted by the pipeline) starts unpinned.
ALTER TABLE caphub_v2.capabilities ADD COLUMN type_by text NOT NULL DEFAULT 'auto'
  CHECK (type_by IN ('auto', 'human'));

-- No GRANT is needed for either change: caphub_v2_app already has table-level
-- SELECT/INSERT/UPDATE on caphub_v2.capabilities from migration 001, and Postgres
-- column-level privileges default to the table's existing grants for new columns
-- (same note as 007); the CHECK widening touches no privileges at all.
