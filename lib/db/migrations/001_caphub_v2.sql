CREATE SCHEMA IF NOT EXISTS caphub_v2;

CREATE TABLE caphub_v2.captures (
  id text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('web','telegram','import')),
  kind text NOT NULL CHECK (kind IN ('image','text','url')),
  object_key text CHECK (object_key ~ '^sha256/[a-f0-9]{2}/[a-f0-9]{64}$'),
  mime_type text,
  text text,
  url text,
  dedupe_key text NOT NULL UNIQUE CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  telegram_chat_id text,
  telegram_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'image') = (object_key IS NOT NULL)),
  CHECK ((kind = 'text') = (text IS NOT NULL)),
  CHECK ((kind = 'url') = (url IS NOT NULL))
);

CREATE TABLE caphub_v2.analysis_runs (
  id text PRIMARY KEY,
  capture_id text NOT NULL REFERENCES caphub_v2.captures(id) ON DELETE CASCADE,
  pipeline text NOT NULL CHECK (pipeline IN ('minimax','mixed')),
  state text NOT NULL CHECK (state IN ('queued','running','done','failed')),
  lease_until timestamptz,
  owner_token text,
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'running') = (owner_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX analysis_runs_claim ON caphub_v2.analysis_runs(state, lease_until, created_at);
CREATE INDEX analysis_runs_capture ON caphub_v2.analysis_runs(capture_id, created_at DESC);

CREATE TABLE caphub_v2.analysis_steps (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES caphub_v2.analysis_runs(id) ON DELETE CASCADE,
  step text NOT NULL CHECK (step IN ('vision','search','reason','review')),
  provider text NOT NULL,
  model text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer NOT NULL,
  ok boolean NOT NULL,
  error text,
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analysis_steps_run ON caphub_v2.analysis_steps(run_id, id);

CREATE TABLE caphub_v2.capabilities (
  id text PRIMARY KEY,
  capture_id text NOT NULL UNIQUE REFERENCES caphub_v2.captures(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES caphub_v2.analysis_runs(id) ON DELETE RESTRICT,
  title text NOT NULL,
  type text NOT NULL CHECK (type IN ('skill','experience','plugin','prompt','other')),
  summary text NOT NULL,
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_verdict text NOT NULL CHECK (suggested_verdict IN ('keep','discard')),
  suggested_reason text NOT NULL,
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  verdict text NOT NULL CHECK (verdict IN ('keep','discard','pending')),
  verdict_by text CHECK (verdict_by IN ('auto','human')),
  verdict_at timestamptz,
  usage text NOT NULL CHECK (usage IN ('integrate','reference')),
  playbook jsonb NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  source_url text,
  review_note jsonb,
  notified_at timestamptz,
  synced_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || array_to_string(tags,' ') || ' ' || coalesce(playbook::text,''))
  ) STORED
);
CREATE INDEX capabilities_verdict ON caphub_v2.capabilities(verdict, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX capabilities_search ON caphub_v2.capabilities USING gin(search);
CREATE INDEX capabilities_tags ON caphub_v2.capabilities USING gin(tags);

CREATE TABLE caphub_v2.tags (
  name text PRIMARY KEY,
  use_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE caphub_v2.retention (
  object_key text PRIMARY KEY,
  eligible_at timestamptz NOT NULL,
  purged_at timestamptz,
  error_code text
);
CREATE INDEX retention_due ON caphub_v2.retention(eligible_at) WHERE purged_at IS NULL;

CREATE TABLE IF NOT EXISTS caphub_v2.schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
