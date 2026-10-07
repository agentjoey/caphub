# 前端刷新验证（2026-10-08）

范围：`docs/superpowers/plans/2026-10-08-frontend-refresh.md` 的 Task 1–5，以及评审后的修复。提案见 `docs/superpowers/specs/2026-10-08-frontend-refresh-proposal.md`。

环境：临时 Neon branch `ui-refresh-2026-10-08`，从生产库复制（数据库 `caphub`，151 张卡）。在 `localhost:3100` 跑 `next dev`，`ACCESS_BYPASS=1`。本地没有对象存储，所以所有截图都走“无图 / 类型”占位，真实缩略图没有在本地验证。本计划不涉及迁移。

## 检查

| 检查 | 结果 |
|---|---|
| `npm test` | 127 个文件、1541 条测试，全部通过（基线 1493，新增 48） |
| `npm run typecheck`、`npm run lint` | 无报错 |
| `scripts/shot.mjs`：`/`、`/review`、`/library`、`/library?q=设计&tag=agent-skill`、详情页、`/mini/review`，各截 1440 和 390 两种宽度 | 无横向溢出，无内部 id 泄漏；截图在 `.agent/screens/ui-refresh/` |
| 管线进度：在 branch 上插入一条 running 的 run，外加一条 ok 的 `vision` 步骤 | 首页显示“看图:done · 搜索:current · 分析 · 裁决”，aria 为“分析中：第 2 步，共 4 步，搜索” |
| 把这条 run 改成 done | 5.3 秒内自动刷新，该行高亮一次，1.6 秒后消失；之后 9 秒内没有任何刷新请求 |
| Review 键盘处理 | J/K 能切换焦点。在“改建议”的输入框里按 Y/X 不会触发保留或丢弃。按 Y 保留后：卡片折叠到 0 高度，显示“已保留 · 标题”，剩余数从 7 变为 6，焦点移到下一张；数据库里该卡为 `keep / human` |
| 列表进详情的标题过渡 | `startViewTransition` 被调用，且带 `cap-title-<id>` 命名 |
| 导航指示条 | 在 1440 和 390 宽度下，与当前项文字的位置、宽度都逐像素对齐 |
| 设计检测器 `detect.mjs` | 剩 2 条，均不处理：`.prompt-block` 的左侧琥珀线属于引用块惯例，按提案保留；`capture-preview.tsx` 的 broken-image 是误报，那里已有 `onError` 回退 |

## 验证中修掉的问题

| 问题 | 修复 |
|---|---|
| 图片如果在 hydration 之前就加载失败，`onError` 不会再触发，结果仍显示坏图（Mini Review 截图里出现过） | `TileImage` 和 `FullImage` 在挂载时额外检查一次 `complete && naturalWidth === 0` |
| 窄屏上仍显示快捷键提示 | `.kbd` 和快捷键提示行在 `(pointer: coarse), (max-width: 600px)` 下隐藏 |
| 检测器报回弹曲线和 width 过渡 | 删掉 `--ease-pop`；导航指示条只用 `translateX + scaleX` 做动画 |

## 独立评审（`feature-dev:code-reviewer`）的结论与处理

| 发现 | 处理 |
|---|---|
| 按住 Y，或卡片保存中再按 Y，会落到其他卡上 | 忽略 `event.repeat` 和 `isComposing`；焦点所在卡片不是待处理状态时，什么都不做 |
| 服务端重渲染后，剩余数可能被重复扣减 | `total` 变化时把本地已处理计数清零 |
| 详情页轮询期间，正在编辑的面板锁令牌会被悄悄换掉 | 有输入框获得焦点或存在 `[data-editing]`（改建议编辑器）时跳过刷新；轮询最多持续 15 分钟 |
| 吸顶页头遮挡锚点 | `html { scroll-padding-top: 72px }` |

## 遗留

- 真实缩略图和 YouTube 帧在卡片里的观感，要等上线后看。
- 临时 branch 删除前需要 Joey 确认；推送 `main`（即部署）也需要 Joey 确认。
