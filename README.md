# Caphub

Caphub 是 Joey 的个人 agent 能力库：接收图片 / 文字 / URL，经搜索、评估、分析后建档或丢弃，按类型与标签分类，供日后查找与复用。

## Local development

```bash
cp .env.example .env
npm install
npm run migrate
npm run dev
npm run worker
```

## Spec

完整设计规格见 [`docs/superpowers/specs/2026-09-19-caphub-v2-design.md`](./docs/superpowers/specs/2026-09-19-caphub-v2-design.md)。

基础实现计划见 [`docs/superpowers/plans/2026-09-19-caphub-v2-foundation.md`](./docs/superpowers/plans/2026-09-19-caphub-v2-foundation.md)。
