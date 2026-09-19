ALTER TABLE caphub_v2.capabilities ADD COLUMN review_requested_at timestamptz;
ALTER TABLE caphub_v2.capabilities ADD COLUMN review_error text;
CREATE INDEX capabilities_review_requested ON caphub_v2.capabilities(review_requested_at) WHERE review_requested_at IS NOT NULL;
CREATE UNIQUE INDEX analysis_runs_one_active ON caphub_v2.analysis_runs(capture_id, pipeline) WHERE state IN ('queued','running');
