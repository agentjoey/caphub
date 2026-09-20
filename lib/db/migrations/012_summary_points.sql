-- M3.8 Task 1: adds structured "标签。说明句" summary points alongside the existing prose
-- `summary`. Controller ruling: `summary` is KEPT (now tightened to the lead sentence(s) a
-- card's list row / search hit / un-enriched card still reads) and `summary_points` is ADDED
-- as a parallel column -- this is additive, not a replacement of `summary`.
ALTER TABLE caphub_v2.capabilities
  ADD COLUMN summary_points jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The full-text `search` generated column (001) is built from
-- `caphub_v2.capability_search_text(title, summary, tags, playbook)`. Postgres generated-column
-- expressions can't be altered in place, so the column has to be dropped and recreated to call
-- a version of that function that also folds in `summary_points` -- dropping it also drops its
-- dependent GIN index (`capabilities_search`), which is recreated below.
ALTER TABLE caphub_v2.capabilities DROP COLUMN search;

-- The old 4-argument overload is now unreferenced (nothing else calls it) and is dropped before
-- creating the 5-argument version below, so the function name doesn't end up overloaded with a
-- stale signature.
DROP FUNCTION caphub_v2.capability_search_text(text, text, text[], jsonb);

-- Same shape as before (001 had to wrap this in a dedicated IMMUTABLE SQL function because
-- Postgres rejects `array_to_string`/`jsonb::text` concatenation as immutable when written
-- inline in a GENERATED ALWAYS expression) -- this stays IMMUTABLE for the same reason: every
-- operand is a plain SQL-standard cast/concatenation over the function's own arguments only
-- (`jsonb::text`, `array_to_string`, `coalesce`, `||`), no catalog lookups, no session/locale-
-- dependent functions and no reference to anything outside the argument list, so the result is
-- guaranteed to be a pure function of its inputs -- exactly what IMMUTABLE requires and what let
-- 001's version qualify as IMMUTABLE PARALLEL SAFE for a STORED generated column in the first
-- place.
CREATE FUNCTION caphub_v2.capability_search_text(title text, summary text, tags text[], playbook jsonb, summary_points jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(array_to_string(tags,' '),'') || ' ' || coalesce(playbook::text,'') || ' ' || coalesce(summary_points::text,'') $$;

ALTER TABLE caphub_v2.capabilities ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig, caphub_v2.capability_search_text(title, summary, tags, playbook, summary_points))
) STORED;
CREATE INDEX capabilities_search ON caphub_v2.capabilities USING gin(search);

-- No GRANT is needed: caphub_v2_app already has table-level SELECT/INSERT/UPDATE on
-- capabilities from migration 001, and Postgres column-level privileges default to the
-- table's existing grants for new columns (same note as 007/008/009/010/011).
