-- M4 子项目 1（AJ-296）：agent 回写的自研实现笔记。追加式，每条 { at, by, text }；
-- `by` 是客户端自报的 agent 名，只用于显示，真正的身份是 Access service token。
ALTER TABLE caphub_v2.capabilities
  ADD COLUMN build_notes jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 笔记要能被搜到。生成列表达式不能就地修改，只能 drop 后重建（会连带 drop 掉
-- capabilities_search 这个 GIN 索引，下面重建）——与 012 的做法一致。
ALTER TABLE caphub_v2.capabilities DROP COLUMN search;
DROP FUNCTION caphub_v2.capability_search_text(text, text, text[], jsonb, jsonb);

-- 保持 IMMUTABLE：每个操作数都只是对本函数自身参数做标准 SQL 的强转与拼接
-- （jsonb::text / array_to_string / coalesce / ||），没有目录查询，也不依赖会话或 locale。
CREATE FUNCTION caphub_v2.capability_search_text(title text, summary text, tags text[], playbook jsonb, summary_points jsonb, build_notes jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(array_to_string(tags,' '),'') || ' ' || coalesce(playbook::text,'') || ' ' || coalesce(summary_points::text,'') || ' ' || coalesce(build_notes::text,'') $$;

ALTER TABLE caphub_v2.capabilities ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig, caphub_v2.capability_search_text(title, summary, tags, playbook, summary_points, build_notes))
) STORED;
CREATE INDEX capabilities_search ON caphub_v2.capabilities USING gin(search);

-- 不需要 GRANT：caphub_v2_app 在 001 就有表级 SELECT/INSERT/UPDATE，新列默认继承表级授权
-- （与 007/008/009/010/011/012 相同）。
