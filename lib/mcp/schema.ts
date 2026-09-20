/**
 * JSON Schemas for the seven MCP tools, published verbatim to clients via `tools/list`.
 * Descriptions are written for the calling agent, not for humans: they say when to reach
 * for the tool. Property shapes must match what `tools.ts`'s functions actually accept.
 */
export const TOOL_DEFS = [
  {
    name: "search_capabilities",
    description:
      "用自然语言在 Joey 的能力库里找相关能力（技能 / 工具 / 模型 / 提示词 / 经验）。开始做一个新功能、选型、或者怀疑'这事是不是已经有现成方案'时先查这里。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "自然语言描述，例如'网页滚动动效'" },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
        type: { type: "string", enum: ["skill", "experience", "plugin", "prompt", "tool", "model", "other"] },
        tags: { type: "array", items: { type: "string" } },
        usage: { type: "string", enum: ["integrate", "reference"] }
      },
      required: ["query"]
    }
  },
  {
    name: "get_capability",
    description:
      "按编号（如 SKL-0031 或 #31）取一张卡片的完整详情，包括 playbook、来源事实、开放问题和已有的自建笔记。已经从搜索里拿到编号、要看具体怎么用之前调用这个。",
    inputSchema: {
      type: "object",
      properties: {
        serial: { type: "string", description: "卡片编号，例如 SKL-0031 或 #31" }
      },
      required: ["serial"]
    }
  },
  {
    name: "list_to_build",
    description: "列出已保留、仅供参考、还在等待或正在自建的卡片（/todo 集合）。想知道'接下来该做什么'时用这个。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 }
      }
    }
  },
  {
    name: "list_recent",
    description: "列出最近新增的、已保留且生效中的卡片。想看看库里最近多了什么时用这个。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 }
      }
    }
  },
  {
    name: "get_stats",
    description: "取库的整体统计（按类型计数、标签数、待处理数、待自建数）。想要一个总览数字而不是列表时用这个。",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "set_build_progress",
    description:
      "把一张卡片的自建进度改为 building / done / dropped（todo / planned 是人来排期，agent 不能设置）。可选地同时附一条笔记。开始/完成/放弃自建一个能力时调用。",
    inputSchema: {
      type: "object",
      properties: {
        serial: { type: "string", description: "卡片编号，例如 SKL-0031" },
        progress: { type: "string", enum: ["building", "done", "dropped"] },
        link: { type: "string", description: "关联链接（PR、commit 等），可选" },
        note: { type: "string", description: "同时附加的一条自建笔记，可选，最多 2000 字" },
        by: { type: "string", description: "记笔记的身份，可选" }
      },
      required: ["serial", "progress"]
    }
  },
  {
    name: "append_build_note",
    description: "给一张卡片追加一条自建笔记，不改变进度。记录调研发现、遇到的坑等，用这个而不是 set_build_progress。",
    inputSchema: {
      type: "object",
      properties: {
        serial: { type: "string", description: "卡片编号，例如 SKL-0031" },
        note: { type: "string", description: "笔记正文，最多 2000 字" },
        by: { type: "string", description: "记笔记的身份，可选" }
      },
      required: ["serial", "note"]
    }
  }
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]["name"];
