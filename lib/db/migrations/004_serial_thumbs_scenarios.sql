CREATE SEQUENCE caphub_v2.capability_serial;
ALTER TABLE caphub_v2.capabilities ADD COLUMN serial integer UNIQUE;
ALTER TABLE caphub_v2.capabilities ADD COLUMN scenarios text[] NOT NULL DEFAULT '{}';
ALTER TABLE caphub_v2.captures ADD COLUMN thumb_key text CHECK (thumb_key ~ '^thumb/sha256/[a-f0-9]{2}/[a-f0-9]{64}\.webp$');

CREATE TABLE caphub_v2.scenarios (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  label_zh text NOT NULL, label_en text NOT NULL, keywords text[] NOT NULL DEFAULT '{}', sort integer NOT NULL
);
INSERT INTO caphub_v2.scenarios VALUES
 ('video','视频','Video','{剪辑,配音,字幕,短视频,动画,video,editing,voiceover}',1),
 ('audio','音频','Audio','{语音,播客,音乐,tts,asr,podcast,music}',2),
 ('image','图像','Image','{图片,绘图,海报,风格,photo,illustration}',3),
 ('writing','写作','Writing','{文案,文章,翻译,copywriting,translation}',4),
 ('coding','编程','Coding','{开发,代码,调试,agent,code,debugging}',5),
 ('design','设计','Design','{界面,ui,ux,品牌,figma}',6),
 ('marketing','营销','Marketing','{增长,seo,投放,转化,growth,ads}',7),
 ('data','数据','Data','{分析,爬虫,可视化,scraping,analytics}',8),
 ('automation','自动化','Automation','{工作流,脚本,集成,workflow,integration}',9),
 ('research','研究','Research','{搜索,论文,调研,search,papers}',10),
 ('productivity','效率','Productivity','{笔记,会议,日程,notes,meeting}',11),
 ('learning','学习','Learning','{教程,课程,知识,tutorial,course}',12);

-- Assigns serials to already-kept rows in created_at order, so pre-existing capabilities
-- get low, time-ordered numbers before the app starts handing out new ones.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT id FROM caphub_v2.capabilities WHERE verdict = 'keep' ORDER BY created_at, id LOOP
    UPDATE caphub_v2.capabilities SET serial = nextval('caphub_v2.capability_serial') WHERE id = r.id;
  END LOOP;
END $$;

-- The app role is created out-of-band (see docs/deploy.md) and may not exist yet in every
-- environment this migration runs against, so the grants are guarded.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caphub_v2_app') THEN
    GRANT USAGE, SELECT ON caphub_v2.capability_serial TO caphub_v2_app;
    GRANT SELECT ON caphub_v2.scenarios TO caphub_v2_app;
  END IF;
END $$;
