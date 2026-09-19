-- Widens analysis_runs.pipeline to accept the third pipeline 'minimax_tavily'
-- (vision = MiniMax, search = Tavily, reason = MiniMax). The constraint was created
-- unnamed inline in 001, so Postgres gave it the default name for a single-column
-- CHECK: analysis_runs_pipeline_check.
ALTER TABLE caphub_v2.analysis_runs DROP CONSTRAINT analysis_runs_pipeline_check;
ALTER TABLE caphub_v2.analysis_runs ADD CONSTRAINT analysis_runs_pipeline_check
  CHECK (pipeline IN ('minimax', 'mixed', 'minimax_tavily'));
