-- M3.7: adds the second-pass "补充调研" run kind plus its supporting columns. See
-- docs/superpowers/plans/2026-09-20-caphub-v2-m3_7-enrichment.md -- a kept card's summary was
-- narrating the analysis process ("经联网核实...未直接证实") instead of describing the
-- capability, because the pipeline never opened the card's own authoritative URL. The second
-- pass (`kind = 'enrich'`) fetches that source directly and rewrites the card once, on top of
-- the fast first pass this table already supports.

-- `enrich` joins the existing 'analysis'/'deep' kinds (010). Unlike 'deep' (manually
-- triggered), 'enrich' is queued automatically whenever a card becomes `keep` -- see
-- lib/analysis/capabilities.ts's upsertCapability and lib/library/actions.ts's decide/
-- editSuggestion, wired in a later task.
ALTER TABLE caphub_v2.analysis_runs DROP CONSTRAINT analysis_runs_kind_check;
ALTER TABLE caphub_v2.analysis_runs ADD CONSTRAINT analysis_runs_kind_check
  CHECK (kind IN ('analysis', 'deep', 'enrich'));

-- One active enrich run per capture, mirroring 010's analysis_runs_one_active_deep (scoped by
-- capture_id alone, not capture_id+pipeline: an enrich run's providers are fixed, same
-- reasoning as requestDeepAnalysis's comment on 'pipeline' carrying no meaning for a deep run).
CREATE UNIQUE INDEX analysis_runs_one_active_enrich
  ON caphub_v2.analysis_runs (capture_id)
  WHERE kind = 'enrich' AND state IN ('queued', 'running');

-- 010 widened analysis_steps.step to vision/search/reason/review/plan/synthesize. 'fetch'
-- records the second pass's canonical-source fetch (lib/analysis/canonical.ts, a later task) as
-- its own step, alongside the 'search' and 'reason' steps the same run also logs.
ALTER TABLE caphub_v2.analysis_steps DROP CONSTRAINT analysis_steps_step_check;
ALTER TABLE caphub_v2.analysis_steps ADD CONSTRAINT analysis_steps_step_check
  CHECK (step IN ('vision', 'search', 'reason', 'review', 'plan', 'synthesize', 'fetch'));

-- `enriched_at`: when the second pass last rewrote this card (null until it has run once).
-- `open_questions`: the first pass's ≤3 "couldn't tell from the input, needs checking" items
-- (lib/analysis/card.ts's cardSchema), which the second pass uses as its search targets and
-- which stay on the card as a "待核实" list for whatever it still couldn't resolve.
ALTER TABLE caphub_v2.capabilities
  ADD COLUMN enriched_at timestamptz,
  ADD COLUMN open_questions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- `suggestion_by`: a second, distinct human-edit marker from the existing `type_by` (M3.5).
-- `type_by` pins only the `type` column and is checked by name (loadPinnedType in
-- pipeline.ts) so a rerun's model output can't silently revert a human-chosen type.
-- `suggestion_by` instead marks a whole 改建议 edit -- type + usage + tags together -- and is
-- what the second pass (a later task) checks before it decides whether to also refresh
-- usage/tags, or leave them exactly as the human set them. The two are not redundant: a
-- human could edit type/usage/tags together (setting both markers via editSuggestion) or a
-- script could reclassify only `type` (setting just type_by, e.g. scripts/reclassify-types.ts,
-- which is deliberately meant to be skipped for a human-typed card but has no reason to touch
-- suggestion_by at all).
ALTER TABLE caphub_v2.capabilities
  ADD COLUMN suggestion_by text NOT NULL DEFAULT 'auto'
    CHECK (suggestion_by IN ('auto', 'human'));

-- No GRANT is needed for any of the above: caphub_v2_app already has table-level
-- SELECT/INSERT/UPDATE on both tables from migration 001, and Postgres column-level
-- privileges default to the table's existing grants for new columns (same note as 007/008/
-- 009/010); the CHECK widenings and the new index touch no privileges at all.
