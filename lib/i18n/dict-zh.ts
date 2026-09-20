/**
 * Source of truth for UI chrome copy. Nested by feature area; every leaf is a plain string,
 * optionally with `{name}`-style placeholders consumed via `format()` (see `./index`).
 *
 * Scope: navigation, headings, buttons, placeholders, empty states, notices, status and error
 * text. NOT in scope: AI-generated card content (title/summary/signals/playbook/tags/review
 * notes) and user input — those come from the database, never from this dictionary.
 */
export const dictZh = {
  shell: {
    skipLink: "跳到正文",
    homeAria: "Caphub 首页",
    brandSub: "能力库",
    navAria: "主导航",
    navCapture: "投递",
    navReview: "Review",
    navLibrary: "能力库",
    langSwitchAria: "切换界面语言"
  },
  labels: {
    type: { skill: "技能", experience: "经验", plugin: "插件", prompt: "提示词", tool: "工具", model: "模型", other: "其他" },
    usage: { integrate: "直接整合", reference: "参考自研" },
    verdict: { keep: "保留", discard: "丢弃", pending: "待决" },
    verdictBy: { auto: "自动", human: "人工" },
    runState: { queued: "排队中", running: "分析中", done: "已建卡", failed: "失败" },
    progress: { todo: "未处理", planned: "已排期", building: "自研中", done: "已完成", dropped: "放弃" },
    status: { active: "有效", deprecated: "失效", superseded: "被替代" },
    errors: {
      OBJECT_UNAVAILABLE: "原图已过期，无法重跑",
      BUDGET: "超出单次分析预算",
      TIMEOUT: "模型响应超时",
      INVALID_OUTPUT: "模型输出不合规（已重试）",
      AUTHENTICATION: "模型 key 无效",
      BILLING: "模型额度不足或被限流",
      UNAVAILABLE: "模型服务不可用",
      LEASE_EXPIRED: "分析进程中断次数过多",
      PIPELINE_UNAVAILABLE: "分析管线未配置",
      CAPTURE_NOT_FOUND: "投递记录不存在",
      INVALID_IMAGE: "图片无法解析",
      INTERNAL: "内部错误",
      fallback: "分析失败（{code}）"
    }
  },
  home: {
    title: "投递一个能力。",
    subtitle: "上传截图、文字或链接，跟进分析并决定是否建档。",
    goReview: "去 Review（{count}）",
    recentTitle: "最近投递",
    recentSub: "最近 20 条",
    empty: "还没有投递。"
  },
  captureForm: {
    formAria: "投递一个能力",
    fileTypeError: "仅支持 PNG、JPEG 或 WebP 图片。",
    evidenceTitle: "截图",
    evidenceHint: "一张图片 · 最大 10 MB",
    fileInputAria: "截图文件",
    dropZoneAria: "截图拖放区",
    clearFile: "清除图片",
    promise: "投递 → 分析 → 建档",
    dropHeading: "把截图拖到这里",
    dropHint: "支持 PNG、JPEG、WebP，也可以直接粘贴。同一张图不会重复分析。",
    chooseFile: "选择图片",
    contextTitle: "文字或链接",
    contextHintWithFile: "本次投递图片",
    contextHintNoFile: "不传图时使用",
    linkLabel: "链接",
    linkHint: "仅 HTTPS",
    linkPlaceholder: "https://github.com/…",
    linkInvalid: "链接需以 https:// 开头",
    linkDescription: "一个能力的网页、仓库或文章地址。",
    textLabel: "文字",
    textLimit: "/ 4,000",
    textPlaceholder: "粘贴一段 prompt、经验或说明……",
    submitting: "投递中…",
    bothFilledWarning: "链接和文字请只填一项",
    submit: "投递",
    submitPlaceholder: "选择图片或填写内容后投递",
    submitFailed: "投递失败。",
    duplicateNotice: "这条内容之前投递过，已指向原记录",
    duplicateLink: "查看已有卡片",
    custodyAria: "投递说明",
    custodyTitle: "投递一次，在这里跟进分析。",
    custodyBody: "原图在 30 天后清除，分析结果与卡片保留。把握大的结论会自动执行。",
    custodyState: "拿不准的进 Review"
  },
  recentRow: {
    fallbackTitle: "截图",
    rerun: "重跑",
    rerunning: "重跑中…",
    rerunFailed: "重跑失败，请稍后再试。",
    deletedBadge: "已删除",
    view: "查看"
  },
  review: {
    title: "Review",
    subtitle: "{count} 张待决卡片",
    empty: "没有待决的卡片。新投递的内容分析完成后，拿不准的会出现在这里。",
    doneKeep: "已保留",
    doneDiscard: "已丢弃"
  },
  library: {
    title: "能力库",
    subtitle: "共 {count} 个能力",
    tagsStat: "标签",
    pendingStat: "待 Review",
    toBuildStat: "待自研",
    searchPlaceholder: "搜索能力…",
    searchAria: "搜索能力",
    searchButton: "搜索",
    discarded: "已丢弃",
    includeRetired: "显示失效/被替代",
    emptyWithFilters: "没有符合条件的能力。",
    clearFilters: "清除筛选",
    emptyNoFilters: "库里还没有保留的能力。",
    prevPage: "上一页",
    nextPage: "下一页"
  },
  detail: {
    back: "← 能力库",
    createdAt: "创建于 {date}",
    summary: "一句话总结",
    signals: "价值信号",
    howToUse: "怎么用",
    sourceFacts: "来源事实",
    repoUrl: "仓库地址",
    stars: "star 数",
    lastUpdate: "最近更新",
    license: "许可证",
    homepage: "主页",
    factsAsOf: "事实采集于 {date}",
    reviewingNotice: "DeepSeek 复核中，稍后刷新查看",
    reviewFailedPrefix: "复核失败：",
    reviewNoteAgree: "复核意见：同意",
    reviewNoteDisagree: "复核意见：不同意",
    syncedAt: "最后同步到 Obsidian：{date}",
    notSynced: "尚未同步"
  },
  scoreBadge: {
    label: "★ {score}/5",
    aria: "价值评分 {score} / 5"
  },
  statusBadge: {
    deprecated: "失效",
    supersededBy: "被 {target} 替代",
    supersededGeneric: "被替代"
  },
  statusControl: {
    title: "有效性状态",
    markDeprecated: "置为失效",
    restoreActive: "恢复有效",
    markSupersededLabel: "标记被替代",
    serialPlaceholder: "替代它的卡片编号，如 TOL-0009",
    noteLabel: "备注",
    notePlaceholder: "可选",
    markSuperseded: "标记被替代",
    saving: "保存中…",
    genericError: "操作失败，请重试"
  },
  overlapNotice: {
    notice: "疑似与 {target} 重复 · {reason}",
    markOtherSuperseded: "把 {target} 标为被本卡替代",
    ignore: "忽略",
    genericError: "操作失败，请重试"
  },
  progressControl: {
    title: "自研进度",
    stateLegend: "进度",
    linkLabel: "关联链接",
    linkPlaceholder: "https://…",
    linkHint: "自研仓库、issue 或笔记地址，可留空",
    save: "保存进度",
    saving: "保存中…",
    genericError: "操作失败，请重试"
  },
  detailActions: {
    keep: "保留",
    discard: "丢弃",
    editSuggestion: "改建议",
    review: "复核",
    reviewing: "复核中",
    rerun: "重跑分析",
    confirmDelete: "确认删除",
    cancel: "取消",
    delete: "删除",
    rerunQueued: "已加入分析队列，完成后刷新查看",
    genericError: "操作失败，请重试"
  },
  suggestionEditor: {
    typeLabel: "类型",
    usageLegend: "用法",
    tagsLabel: "标签",
    tagsHint: "英文小写，可用连字符，1–6 个",
    save: "保存并保留"
  },
  analysisDetails: {
    summary: "详情",
    stepHeader: "步骤",
    serviceHeader: "服务",
    durationHeader: "耗时 s",
    tokenHeader: "token",
    resultHeader: "结果",
    success: "成功",
    failed: "失败",
    stepVision: "看图",
    stepSearch: "搜索",
    stepReason: "分析",
    stepReview: "复核",
    captureLabel: "投递",
    capabilityLabel: "能力卡",
    runLabel: "分析运行"
  },
  capturePreview: {
    thumbAlt: "投递的截图（缩略图）",
    purgeNote: "原图已于 {date} 清除，仅保留缩略图",
    noImage: "无图",
    fullAlt: "投递的截图",
    linkThumb: "链接",
    noLink: "无链接",
    textThumb: "文字"
  },
  cardSummary: {
    suggestion: "建议{verdict} · 置信度 {confidence} — {reason}"
  },
  playbookView: {
    copyAll: "复制全文",
    whenToUse: "适用场景：{value}"
  },
  copyButton: {
    copy: "复制",
    copied: "已复制",
    failed: "复制失败"
  },
  notFound: {
    title: "能力不存在",
    subtitle: "这个能力可能已被删除，或链接有误。",
    back: "← 返回能力库"
  },
  actions: {
    conflict: "已在别处处理",
    invalid: "请求参数不合法",
    cardNotFound: "卡片不存在或已删除",
    typeOrUsageInvalid: "类型或用法不合法",
    tagsInvalidPrefix: "标签不合法：",
    tagsInvalidSuffix: "（需英文小写，可用连字符）",
    tagsJoinSeparator: "、",
    tagsCountInvalid: "标签需 1–6 个",
    captureNotFound: "投递记录不存在",
    objectExpired: "原图已过期，无法重跑",
    alreadyQueued: "已在排队或分析中",
    reviewInProgress: "复核已在进行中",
    progressInvalid: "进度状态不合法",
    progressLinkInvalid: "链接需以 http:// 或 https:// 开头",
    progressNotReference: "只有参考自研的卡片可以记录进度",
    progressNotKept: "只有已保留的卡片可以记录进度",
    statusNoteInvalid: "备注过长",
    statusSupersededByRequired: "标记被替代需要填写对方卡片编号",
    statusSupersededByNotAllowed: "只有标记被替代时才能填写对方卡片编号",
    statusSupersededByNotFound: "找不到对应编号的卡片",
    statusSupersededBySelf: "不能设置为被自己替代",
    overlapNoTarget: "没有可处理的比对结果",
    overlapTargetInvalid: "比对结果中的卡片编号不合法"
  }
} as const;
