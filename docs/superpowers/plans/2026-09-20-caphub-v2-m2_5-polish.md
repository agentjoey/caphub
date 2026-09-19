# Caphub v2 — M2.5（编号 / 缩略图 / 场景与语义检索 / 中英切换 / 排版美化）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 让能力库更好找、更好看、更耐用：人可读编号、永久缩略图、按应用场景与语义检索、界面中英切换、统一排版。

**Spec:** `docs/superpowers/specs/2026-09-19-caphub-v2-design.md`（本文件的「设计决定」一节是对 §4 / §6 的增补，已由 Human 在 2026-09-20 选定）。

## 设计决定（Human 已选定）

1. **编号 = 类型前缀 + 全局序号**：卡片**首次进入 keep** 时从全局序列取号（永不复用），显示为 `SKL-0012`（skill）/ `EXP-`（experience）/ `PLG-`（plugin）/ `PRM-`（prompt）/ `OTH-`（other）；改类型时前缀跟着变、数字不变；未入库（pending / discard）的卡没有编号。能力库搜索框输入 `SKL-12`、`skl0012`、`#12` 直接定位。
2. **缩略图永久保留，原图 30 天清除**：投递图片时同步生成缩略图（最长边 480px，webp，质量 72），存到 `thumb/sha256/<2>/<digest>.webp`，不进 retention；列表与卡片一律用缩略图；详情页大图用原图，原图已清除时自动退回缩略图并提示“原图已于 {日期} 清除，仅保留缩略图”。
3. **应用场景 + 语义检索**：
   - 场景清单（可维护的表，初始 12 个）：视频 video、音频 audio、图像 image、写作 writing、编程 coding、设计 design、营销 marketing、数据 data、自动化 automation、研究 research、效率 productivity、学习 learning；每个场景带中英文名与关键词（如 视频：剪辑、配音、字幕、短视频、动画）。
   - AI 建卡时为每张卡选 1–3 个场景（schema 用当前清单校验）；已有卡用一次性脚本补分类。
   - 语义检索：每张卡生成一个向量（Neon pgvector），文本 = 标题 + 摘要 + 标签 + 场景名；搜索框输入时对查询也生成向量，按“语义相似度 + 全文命中 + 场景命中”综合排序。这样搜“视频”能找到配音、剪辑、风格提示词，也解决中文不分词搜不到的问题。
   - Embedding 模型：MiniMax embeddings（与现有 MiniMax key 同一账号）。**web 服务需要新增 `MINIMAX_API_KEY`（仅用于查询向量）**。
4. **中文 / EN 只切界面文字**：导航、按钮、标签名、提示、状态、错误文案走字典；卡片正文保持生成时的语言；语言存 cookie，header 右侧切换；`<html lang>` 跟随。
5. **统计块即筛选**：能力库 5 个类型统计块可点击筛选（选中高亮），移除下方重复的类型 chips。
6. **排版美化**：加载字体（英文 General Sans、等宽 IBM Plex Mono、中文走系统苹方/思源黑体栈），统一字号层级与行高（正文 1.7）、控制行长、间距 token；提示词正文改正文字体（命令仍等宽）；“详情”折叠区的步骤表与来源列表重排。

## 需要 Human 授权（执行前逐项确认）

- 生产 Neon：启用 `vector` 扩展，执行迁移 004、005。
- 真实调用：MiniMax embeddings（已有卡回填一次；之后每张新卡 1 次、每次搜索 1 次）；DeepSeek 为已有卡补场景（一次性，约 20 次）。
- Railway web 服务新增变量 `MINIMAX_API_KEY`（我可以从 worker 服务复制，走 stdin 不打印）。
- 临时 Neon branch 验证（建 / 删）。

## Global Constraints

沿用 M2 计划的 Global Constraints（中文 UI、不显示内部 id、测试不连真实库、Next 16 先读文档、提交尾注、先迁移再推送），另加：
- 编号前缀映射固定：`skill→SKL, experience→EXP, plugin→PLG, prompt→PRM, other→OTH`；数字至少 4 位补零。
- 缩略图 key：`thumb/sha256/<2hex>/<64hex>.webp`；`/api/objects` 同时服务原图与缩略图，只服务 captures 表引用的 key。
- 场景 slug 为英文小写（与标签同规则），中英文名在表里维护。
- embedding 维度以 MiniMax 实际返回为准（Task 4 先做一次真实探测并写进迁移）。

---

### Task 1: 迁移 004 — 编号、缩略图、场景

**Files:** `lib/db/migrations/004_serial_thumbs_scenarios.sql`、`lib/library/serial.ts`(+test)

- [ ] 迁移：
```sql
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
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT id FROM caphub_v2.capabilities WHERE verdict = 'keep' ORDER BY created_at, id LOOP
    UPDATE caphub_v2.capabilities SET serial = nextval('caphub_v2.capability_serial') WHERE id = r.id;
  END LOOP;
END $$;
```
（逐行循环保证编号按入库时间递增；Task 8 在临时 branch 上核对顺序。）同时授予 `caphub_v2_app` 对新序列 `USAGE, SELECT` 与 `scenarios` 表 `SELECT`（迁移里写 `DO $$ … IF EXISTS role … GRANT … $$`）。
- [ ] `serial.ts`：`formatSerial(type, serial | null): string | null`、`parseSerialQuery(q): number | null`（接受 `SKL-12`、`skl0012`、`#12`；纯数字 `12` 不算编号，按普通搜索处理；前缀与卡片当前类型不符时仍按数字定位）。单测覆盖五种前缀、补零、大小写、非法输入。
- [ ] 取号：`upsertCapability`（自动 keep）、`decide` / `editSuggestion`（人工 keep）里 `serial = coalesce(serial, nextval('caphub_v2.capability_serial'))` 仅在结果 verdict 为 keep 时；测试断言 SQL。

### Task 2: 缩略图生成、服务与回填

**Files:** `lib/storage/thumbs.ts`(+test)、`lib/captures/captures.ts`、`lib/objects/serve.ts`、`components/capability/capture-preview.tsx`、`scripts/backfill-thumbs.ts`

- [ ] `makeThumbnail(bytes): Promise<Uint8Array>`（sharp：rotate、inside 480、webp q72）；`thumbKeyFor(digest)`。
- [ ] `submitCapture`：图片投递时生成并 `putIfAbsent` 缩略图（放 thumb key），写 `captures.thumb_key`；失败不阻塞投递（记日志，thumb_key 为空）。
- [ ] `/api/objects` 接受缩略图 key：须被 `captures.thumb_key` 引用；content-type `image/webp`。原图 key 逻辑不变。
- [ ] `CapturePreview`：`thumb` 尺寸优先用 `thumbKey`；`full` 尺寸用原图，`onError` 时换成缩略图并显示“原图已于 {eligible_at 日期} 清除，仅保留缩略图”（日期由服务端传入：retention.eligible_at）。
- [ ] `scripts/backfill-thumbs.ts`（dry-run 默认，`--apply` 执行）：为 `thumb_key IS NULL` 且原图仍在的图片补缩略图。
- [ ] 保留期清扫不得删除 `thumb/` 前缀（`deleteExact` 已限定 sha256 原图 key，写测试确认）。

### Task 3: 场景进入分析管线

**Files:** `lib/analysis/card.ts`、`lib/analysis/prompts.ts`、`lib/analysis/pipeline.ts`、`lib/analysis/scenarios.ts`(+test)、`scripts/backfill-scenarios.ts`

- [ ] `loadScenarios(pool)`；`cardSchemaFor(slugs)`：在 cardSchema 上加 `scenarios: z.array(z.enum(slugs)).min(1).max(3)`（保持 `z.toJSONSchema` 可用，已有回归测试）。
- [ ] reason prompt 加场景清单（slug + 中文名 + 关键词），要求选 1–3 个最贴切的应用场景。
- [ ] `upsertCapability` 写 `scenarios`。
- [ ] `scripts/backfill-scenarios.ts`：对 `scenarios = '{}'` 的卡用 DeepSeek 小调用（输入标题/摘要/标签/场景清单，输出 scenarios）补分类；dry-run 默认。

### Task 4: 迁移 005 — pgvector 与 embedding

**Files:** `lib/db/migrations/005_embeddings.sql`、`lib/providers/minimax-embed.ts`(+test)、`lib/analysis/embedding.ts`(+test)、`lib/analysis/pipeline.ts`、`scripts/backfill-embeddings.ts`

- [ ] 先做一次真实探测（授权后由 controller 执行）：调用 MiniMax embeddings，记录模型名、维度、单价口径，写入本文件。
- [ ] 迁移：`CREATE EXTENSION IF NOT EXISTS vector; ALTER TABLE caphub_v2.capabilities ADD COLUMN embedding vector(<dim>); CREATE INDEX … USING hnsw (embedding vector_cosine_ops);`
- [ ] `createMiniMaxEmbed({ apiKey, fetch? })`：`embed(texts, kind: "db" | "query")`，超时 15 s，缺 usage → INVALID_OUTPUT。注入 fetch 测试。
- [ ] `embeddingText(card, scenarioLabels)`；worker 在建卡后计算并写入（失败不影响建卡，记 step `embed`——需把 analysis_steps.step 的 CHECK 加入 'embed'，放进 005）。
- [ ] `scripts/backfill-embeddings.ts`（dry-run 默认）。

### Task 5: 检索改造 + 统计块筛选

**Files:** `lib/library/queries.ts`、`lib/library/search-params.ts`、`app/library/page.tsx`、`app/library/library-filters.tsx`、`lib/runtime.ts`、`lib/config.ts`

- [ ] web 配置：`MINIMAX_API_KEY` 对 web 变为可选；有则启用语义检索，无则退回全文 + 场景 + 模糊匹配。
- [ ] `listLibrary` 增加：`scenarios?: string[]` 筛选；`serial` 精确定位（`parseSerialQuery`）；有 q 时：语义相似度（cosine）+ 全文命中 + 场景关键词命中（q 命中场景中文名 / 关键词 → 该场景卡加权）+ `title/summary ILIKE %q%` 兜底；综合得分排序，语义相似度低于阈值（初始 0.35，常量）且无其他命中的不返回。
- [ ] 统计块改为链接筛选（选中 `aria-current`），删除类型 chips；场景 chips 新增一行（中文名 + 数量）。
- [ ] 列表与详情显示编号（`SKL-0012`），未入库的卡不显示。

### Task 6: 中英文界面切换

**Files:** `lib/i18n/{dict-zh,dict-en,index}.ts`(+test)、`components/shell/lang-switch.tsx`、所有页面与组件的界面文字、`lib/library/labels.ts`

- [ ] 字典键覆盖全部界面文字（导航、按钮、占位、提示、状态、错误、类型/用法/结论/场景名）；`getLocale()` 读 cookie `lang`（默认 zh）；`t(key)` 服务端取字典并传给客户端组件。
- [ ] header 右侧 `中文 / EN` 切换（写 cookie 后 `router.refresh()`）；`<html lang>` 跟随。
- [ ] 测试：两份字典键集合一致；切换后导航与按钮文字变化；卡片正文不变。

### Task 7: 排版与视觉美化

**Files:** `app/layout.tsx`、`app/globals.css`、`public/fonts/*`（General Sans woff2，Fontshare 免费商用许可，附 LICENSE）、相关组件

- [ ] 字体：`next/font/local` 加载 General Sans（400/500/600/700）；`next/font/google` 加载 IBM Plex Mono（400/500）；中文栈 `"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei"`。
- [ ] Token：字号层级（12/13/14/15/17/20/26/34）、行高（正文 1.7，标题 1.2）、段落间距、正文最大行长 72ch、卡片内边距统一。
- [ ] 怎么用：提示词正文用正文字体 + 浅底块 + 左侧琥珀细线；安装命令用等宽代码块；复制按钮放在块右上角。
- [ ] 详情折叠区：步骤表对齐（数字列右对齐、等宽数字 `font-variant-numeric: tabular-nums`）、来源列表显示“标题 · 域名”并单行省略。
- [ ] 1440 / 390 截图前后对照，写入 `docs/m2_5-verification.md`。

### Task 8: 验证与上线

- [ ] 临时 Neon branch：迁移 004/005、回填编号（顺序正确）、缩略图回填、场景回填、embedding 回填；浏览器走查：编号显示与 `SKL-12` 搜索、搜“视频”能命中配音/剪辑/风格提示词类卡、原图过期回退（手工把某条 retention 标记为已清除模拟）、统计块筛选、中英切换、截图无溢出。
- [ ] 生产：启用 vector、迁移 004/005 → 推送 → 回填脚本（缩略图、场景、embedding）→ 冒烟。

## Self-review

- 覆盖 Human 七项：①已完成（commit 7511165）；②Task 6；③Task 2；④Task 1 + 5；⑤Task 5；⑥Task 3–5；⑦Task 7。
- 风险：pgvector 维度需真实探测后定；web 新增模型 key 属于密钥范围扩大，已列入授权清单。
