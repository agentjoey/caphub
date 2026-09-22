-- Prompt 原文独立保存（spec 2026-09-22-verbatim-prompts-design.md）。
-- prompts：[{ "text": string }]，只由代码从输入源摘取后写入，模型不写；
-- prompt_unresolved：本次分析里未能在原文中定位的条目数，供 Review 提示。
ALTER TABLE caphub_v2.capabilities
  ADD COLUMN prompts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN prompt_unresolved smallint NOT NULL DEFAULT 0;

-- 原文从 playbook 挪出来后仍要能被全文检索搜到。生成列表达式不能就地修改，
-- 只能 drop 后重建（连带重建 GIN 索引）——与 012、013 的做法一致。
ALTER TABLE caphub_v2.capabilities DROP COLUMN search;
DROP FUNCTION caphub_v2.capability_search_text(text, text, text[], jsonb, jsonb, jsonb);

-- 保持 IMMUTABLE：只对本函数自身参数做标准 SQL 强转与拼接，无目录查询，不依赖会话或 locale。
CREATE FUNCTION caphub_v2.capability_search_text(title text, summary text, tags text[], playbook jsonb, summary_points jsonb, build_notes jsonb, prompts jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(array_to_string(tags,' '),'') || ' ' || coalesce(playbook::text,'') || ' ' || coalesce(summary_points::text,'') || ' ' || coalesce(build_notes::text,'') || ' ' || coalesce(prompts::text,'') $$;

ALTER TABLE caphub_v2.capabilities ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig, caphub_v2.capability_search_text(title, summary, tags, playbook, summary_points, build_notes, prompts))
) STORED;
CREATE INDEX capabilities_search ON caphub_v2.capabilities USING gin(search);

-- 不需要 GRANT：caphub_v2_app 在 001 就有表级 SELECT/INSERT/UPDATE，新列继承表级授权。
