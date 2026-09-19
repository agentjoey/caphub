<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN SHARED-ENGINEERING v2 -->
## Shared engineering conventions

Optimize delivery time and total token use while preserving correctness, security, and maintainability.

### Scope and collaboration
Follow the task's goal and acceptance criteria. Confirm the checkout and existing changes before editing; preserve unrelated work and isolate concurrent writes. Read applicable instructions and relevant code, expanding context as needed.

### Implementation
Prefer the simplest complete solution, not the smallest diff. Follow sound project patterns. Use refactoring or abstraction when it directly improves the current solution. Avoid unrelated cleanup and speculative features; remove code made unused by your changes.

### Verification
Check changed behavior with focused tests or reproducible checks; ensure regression coverage for bug fixes. Run broader checks when impact or project requirements justify them; inexpensive full checks are fine.
Reuse results only while relevant code, dependencies, configuration, environment, and coverage remain valid. After fixes, rerun affected checks. Do not weaken tests to hide failures; distinguish regressions, existing failures, and environment blockers.

### Review
Review coherent changesets, not each internal task. Self-review low-risk changes; use independent review for high-risk changes such as authorization, destructive data operations, or concurrency. Independent review may use another agent; it is not a human approval gate unless explicitly required.
Focus follow-up reviews on findings, fixes, and affected behavior; expand for new risks. Separate blockers from optional improvements.

### Workflows
Use skills as needed, not as a fixed sequence. Do not restart approved design unless material assumptions change. Check actual rendering for visual changes and real user paths for interaction, authorization, or persistence changes. Use screenshots, e2e, and mutation testing where useful.

### Safety and delivery
Execute approved work end to end. Reuse approvals within their scope, conditions, and validity; phase transitions and routine fixes do not reset them.
Check existing authorization before asking. Batch foreseeable gaps into one request naming targets, operations, and material side effects. General development permission does not authorize unspecified production writes, destructive actions, or external data transfers.
Ask only for a missing consequential decision or permission, a material change beyond agreed scope or risk, or a required human checkpoint. Explain the specific gap or rule and why prior approval is insufficient. Pause affected work only; continue independent authorized tasks.
Mitigate avoidable risks within scope, protect secrets, and respect enforced permissions; never bypass denials. Preserve approval references and limits in existing handoff notes. Finish when acceptance criteria and required checks are met and blockers resolved; report changes, checks, and gaps accurately. Skipped, unrun, or failed checks are not passes.
<!-- END SHARED-ENGINEERING -->

# Caphub — Project Context

Joey 的个人 agent 能力库（skill / 经验 / plugin / prompt）：投递图片、文字或链接 → 分析（MiniMax 看图 + Tavily 搜索 + DeepSeek 推理，`PIPELINE=mixed`）→ 分级裁决 → 建档；web 端 Review / 能力库 / 详情。

- 规格与计划：`docs/superpowers/specs/2026-09-19-caphub-v2-design.md`、`docs/superpowers/plans/`；部署：`docs/deploy.md`；A/B 结论：`docs/spike-2026-09.md`、`docs/spike-web.md`。
- 部署：Railway project `Caphub`（Singapore，`web` + `worker`），推送 `main` 即自动部署；`https://caphub.agentjoey.ai` 在 Cloudflare Access 后，应用内再校验 Access JWT（`proxy.ts` → `lib/auth/guard.ts`）。
- 数据：Neon project `caphub`，schema `caphub_v2`；迁移只在本地用 owner 连接串执行 `npm run migrate`，且**必须先于推送**（部署不跑迁移）。Railway 上不放 owner 串。
- 密钥只在 Railway 变量里，由 Human 粘贴；需要复制时走 stdin，不打印、不写入仓库。
- 测试不连真实数据库或模型（fake pool / 注入 fetch）；真实验证用临时 Neon branch，用完删除。
- 本地用浏览器验证时访问 `http://localhost:<port>`（`next dev` 会拦截 `127.0.0.1` 的开发资源）。
