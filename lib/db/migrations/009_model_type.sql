-- Adds a seventh fixed capability type, 'model', for model weights / foundation models and
-- their inference code (e.g. a financial time-series foundation model repo) — previously such
-- a card had no accurate type: it is neither a runnable app/framework (tool) nor a callable
-- skill. The CHECK on `type` was widened once already by 008 to the same unnamed-constraint
-- name Postgres assigned back in 001 (confirmed in production as capabilities_type_check), so
-- this migration follows the same style.
ALTER TABLE caphub_v2.capabilities DROP CONSTRAINT capabilities_type_check;
ALTER TABLE caphub_v2.capabilities ADD CONSTRAINT capabilities_type_check
  CHECK (type IN ('skill', 'experience', 'plugin', 'prompt', 'tool', 'model', 'other'));

-- No GRANT is needed: the CHECK widening touches no privileges (same note as 008).
