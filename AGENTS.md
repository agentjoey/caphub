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

个人 agent 能力库（skill / 经验 / plugin / prompt）：投递 → 分析（`PIPELINE=mixed`：MiniMax 看图 + Tavily 搜索 + DeepSeek 分析）→ 分级裁决（置信度 ≥ 0.8 自动执行，其余进 Review）→ 建档与检索。

- 文档：规格 `docs/superpowers/specs/2026-09-19-caphub-v2-design.md`，计划 `docs/superpowers/plans/`，部署 `docs/deploy.md`，管线结论 `docs/spike-2026-09.md`。
- 部署：Railway `Caphub`（Singapore，`web` + `worker`），推送 `main` 自动部署；`caphub.agentjoey.ai` 在 Cloudflare Access 后，应用内再校验 Access JWT。
- 迁移：本地用 owner 连接串 `npm run migrate`，**先迁移再推送**（部署不跑迁移）。
- 密钥只在 Railway 变量，由 Human 粘贴；复制走 stdin，不打印、不入库。
- 测试不连真实数据库 / 模型；真实验证用临时 Neon branch，用完删除；本地浏览器验证用 `localhost`。


<!-- BEGIN SHARED-INTAKE v2 -->
## Requirement intake and work tracking

Owner decision 2026-10-15. Needs are discussed in Notion first; Linear holds only work the Owner has confirmed (approved on the Requests page, or confirmed directly in a session). The Intake page holds the stage table, the page templates and the databases: https://app.notion.com/p/3f98c5850c4380588d3fcfa22d8bc62e

- Project: `Caphub` (the value of `Project` in the Requests and Slices databases; always filter by it).
- Notion data sources: **Requests** `b20c9483-9aab-42fe-bea0-edafb0ee193d`, **Slices** `53cfefa3-69e8-4fcd-99c9-296946092dd2`. Query them directly by id with `Project = Caphub`. Do not find them by searching Notion.
- Linear: team `AJ`, project `Caphub` (P-AJ-22). Resolve the project by its id, because names change. A slice is a **Milestone** inside this project, named after the slice goal.

### Where to look

- Needs, requests, ideas, "pending", "inbox", "approved" → the Requests database (Notion). Issues, tickets, tasks, "todo", "in progress" → Linear. "How many pending requests" is a Requests question, so answer it from Notion and never from Linear counts.
- Read only rows where `Project = Caphub`. Do not open other projects' rows or pages, and do not search Notion by keyword (search returns other projects' pages). Notion pages that predate this flow (old backlogs, decision lists) are not the source for this flow; read them only when the Owner points at one.
- If Notion is not reachable in this tool, say so. Do not substitute a Linear count for a Requests count.

### Two kinds of session

- **Discussion session:** reads and writes Requests, analyses, records the discussion on the request page, and after the Owner confirms creates the Linear Milestone and issues. Writes no code.
- **Development session:** takes issues from Linear and implements them. It reads Requests when the Owner asks about requests (see above); otherwise it reads only Linear.

### Rules

1. A Linear issue is created only after the Owner has confirmed the need: the request's Stage is Approved in Notion, or the Owner confirmed it directly in any session, including a development session (small, clear items found outside Intake). Agents cannot delete Linear issues, so an unconfirmed need must not be created there; write it to Requests as Inbox instead.
2. A Linear issue is self-contained: put the analysis conclusion and the acceptance criteria in its description. Sub-agents and worktrees cannot rely on reading Notion. The first line of the description is its source: `Request: <Notion page URL>` or `Confirmed: <YYYY-MM-DD> <who> <one line of what was confirmed>`. An issue with neither line is a violation; list them by searching the project.
3. Ideas and defects found while developing that the Owner has not confirmed go to Requests as Inbox. If the Owner confirms one on the spot, create the issue directly with a `Confirmed:` line, in a Milestone if it belongs to a slice and otherwise loose in the Project.
4. When the last issue of a Milestone is Done, write one Slices record (Delivered, Evidence, Deviation, and an Issues list of every issue id with title and result) and set the Request to Done.
5. The Owner deletes finished Linear issues by hand and tells the agent first. Before any bulk delete, write the Slices record or an archive page so issue ids cited in the repo can still be resolved.
6. Never track progress in two places. If this repo also has its own record-keeping rules, follow them in addition.
7. Renaming the project: rename it in Linear (the id stays), rename the `Project` option in the Notion UI for both databases (the option id stays), update the `Project` and `Linear` lines above, and keep a `Formerly:` line for one version.
<!-- END SHARED-INTAKE -->
