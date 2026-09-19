CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE caphub_v2.capabilities ADD COLUMN embedding vector(768), ADD COLUMN embedded_at timestamptz;

CREATE INDEX capabilities_embedding_hnsw ON caphub_v2.capabilities USING hnsw (embedding vector_cosine_ops);

-- The vector extension installs into the migrator's default search_path schema (public), not
-- caphub_v2. The app role (caphub_v2_app) already has USAGE on public in a fresh Postgres 15+
-- database, since that grant to PUBLIC is not revoked by default here — see docs/deploy.md's
-- role setup, which never revokes it. This grant is defensive only, in case a prior environment
-- did revoke it, and is guarded the same way 004's grants are for environments where the role
-- doesn't exist yet.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caphub_v2_app') THEN
    GRANT USAGE ON SCHEMA public TO caphub_v2_app;
  END IF;
END $$;
