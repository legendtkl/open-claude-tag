// Product-facing changelog for the admin console "Release Notes" page.
//
// This is the single source of truth for what users see on the "Release Notes"
// changelog surface. It is intentionally a static, hand-curated, version-controlled
// data file — NOT generated from commits and NOT backed by a database. When a
// release ships, prepend a new entry here (newest-first) summarising the
// product-facing changes; keep both `zh` and `en` copy in sync with the
// console's bilingual UI.

export interface LocalizedText {
  zh: string;
  en: string;
}

export interface ReleaseNote {
  /** Semantic version / release tag suffix, e.g. "1.0.2". */
  version: string;
  /** Release date in ISO `YYYY-MM-DD` form, used for display. */
  date: string;
  /** Core feature enhancements (核心功能增强). May be empty. */
  highlights: LocalizedText[];
  /** Bug fixes (Bug 修复). May be empty. */
  fixes: LocalizedText[];
}

// Newest release first. The first entry's `version` must match the release
// currently being shipped.
export const releaseNotes: ReleaseNote[] = [
  {
    version: '1.0.5',
    date: '2026-06-24',
    highlights: [
      {
        zh: '支持飞书云文档评论 @ 提及 bot 发起任务,会保留文档、评论与引用上下文并回到评论线程反馈',
        en: 'Feishu document comments can now @-mention a bot to start tasks, preserving document, comment, and quote context for threaded replies',
      },
      {
        zh: '新 bot 接入与权限检查覆盖云文档评论能力,并补充真实飞书验证流程,便于上线前确认事件和权限配置',
        en: 'New bot onboarding and permission checks now cover Feishu document comments, with real-Feishu verification guidance for event and permission setup',
      },
      {
        zh: '控制台升级为浅蓝色视觉主题,导航、卡片、表格和状态控件更适合长时间运维扫描',
        en: 'The admin console now uses a light blue console visual refresh across navigation, cards, tables, and status controls for easier operational scanning',
      },
    ],
    fixes: [
      {
        zh: 'macOS 桌面端下载发现更稳健,可自动识别标准 DMG 产物并继续支持显式 artifact 路径',
        en: 'macOS desktop downloads are more reliable, with automatic standard DMG discovery while still supporting explicit artifact paths',
      },
      {
        zh: '文档评论任务的 ACK、回复内容投递和运行时上下文补齐更完整,减少云文档场景下的丢上下文问题',
        en: 'Document-comment task acknowledgements, assistant response delivery, and runtime context are more complete, reducing lost context in document workflows',
      },
    ],
  },
  {
    version: '1.0.4',
    date: '2026-06-16',
    highlights: [
      {
        zh: '飞书任务完成通知升级为富文本回复卡片,完成状态、摘要与后续操作在会话内更清晰',
        en: 'Feishu completion notifications now use rich reply cards, making status, summaries, and follow-up actions clearer in the conversation',
      },
      {
        zh: '控制台支持 Feishu bot 显示名管理,可本地编辑并从 Feishu 元数据同步名称',
        en: 'Console now manages Feishu bot display names, including local edits and Feishu metadata sync',
      },
      {
        zh: 'Claude Code 支持可选认证模式,包括本地登录认证,便于不同 agent 使用合适的凭据策略',
        en: 'Claude Code authentication modes are now configurable, including local-login auth for agents that should use local credentials',
      },
      {
        zh: '共享上下文在跨 agent、机器绑定 agent 与话题会话中保留更完整,连续任务恢复更稳定',
        en: 'Shared context is preserved more reliably across agents, machine-bound agents, and topic sessions for steadier follow-up tasks',
      },
    ],
    fixes: [
      {
        zh: '飞书话题与引用消息识别更稳健,可从 app link、生成的话题链接和延迟话题启动中恢复正确上下文',
        en: 'Feishu topic and quoted-message recovery is more robust, including app links, generated topic links, and delayed topic starts',
      },
      {
        zh: '图片类话题根消息和引用图片附件会被保留到运行时上下文,减少图片追问丢失上下文的问题',
        en: 'Image topic roots and quoted image attachments are preserved into runtime context, reducing lost context in image follow-ups',
      },
      {
        zh: 'Claude 凭据校验按管理员作用域收紧,避免跨用户校验到不属于自己的配置',
        en: 'Claude credential validation is scoped to the owning operator, preventing checks against another user\'s configuration',
      },
      {
        zh: '控制台部署健康检查加固,本地部署脚本能更可靠地发现异常状态',
        en: 'Console deployment health checks are hardened so local deployment scripts detect unhealthy states more reliably',
      },
    ],
  },
  {
    version: '1.0.3',
    date: '2026-06-15',
    highlights: [
      {
        zh: '新增控制台「更新日志」页面,可直接在产品内查看折叠式版本变更',
        en: 'Added the in-console Release Notes page with collapsible per-version changes',
      },
      {
        zh: '新增 Feishu bot 一键接入流程,从控制台完成应用配置、权限检查与绑定引导',
        en: 'Added one-click Feishu bot onboarding from the console, covering app setup, permission checks, and binding guidance',
      },
      {
        zh: '新增 verified shared context:跨任务复用已验证上下文,并在 admission 校验后选择恢复或注入',
        en: 'Added verified shared context so tasks can reuse validated context across runs after admission checks',
      },
      {
        zh: '新增 shared context 写回:将已验证的任务摘要沉淀为后续任务可复用的上下文',
        en: 'Added shared-context write-back, saving verified task summaries for future task hydration',
      },
      {
        zh: '旧会话恢复更稳健:历史缺失 runtime 的会话按 Claude Code 归一化,Codex/coco 可正确走上下文注入路径',
        en: 'Legacy session recovery is more robust: sessions missing a stored runtime normalize to Claude Code while Codex/coco hydrate via context injection',
      },
      {
        zh: '控制台弹窗、语言偏好、错误恢复和窄屏表格体验全面加固',
        en: 'Improved console dialogs, language persistence, recoverable error handling, and narrow-screen table behavior',
      },
    ],
    fixes: [
      {
        zh: '管理 API 补齐 chat 默认 agent 与 agent profile 的归属校验,避免跨用户引用私有对象',
        en: 'Admin API now enforces ownership for chat default-agent and agent-profile updates to prevent cross-user private-object references',
      },
      {
        zh: 'daemon artifact 下载加固为基于 O_NOFOLLOW 打开的文件描述符流式返回,关闭 TOCTOU 窗口',
        en: 'Daemon artifact downloads now stream from an O_NOFOLLOW-opened file descriptor, closing the TOCTOU window',
      },
      {
        zh: '管理请求增加超时;高 offset 分页、重复 bot 绑定和 break-glass token 校验返回更明确',
        en: 'Admin requests now time out, and high-offset pagination, duplicate bot binding, and break-glass token checks return clearer results',
      },
      {
        zh: '控制台渲染异常时显示可恢复提示与重载按钮,不再整页白屏',
        en: 'Console render errors now show a recoverable message with a reload button instead of a blank page',
      },
    ],
  },
  {
    version: '1.0.2',
    date: '2026-06-14',
    highlights: [
      {
        zh: '新增 coco(TRAE CLI)运行时,与 Claude Code、Codex 并列可选',
        en: 'Added the coco (TRAE CLI) runtime, selectable alongside Claude Code and Codex',
      },
      {
        zh: '支持为每个 agent 单独配置 Claude Code 凭据(Base URL + API Key)',
        en: 'Per-agent Claude Code credentials (Base URL + API Key) can now be set in the agent form',
      },
      {
        zh: '支持为每个 agent 选择默认模型,并贯通到 coco / codex 运行时',
        en: 'Per-agent default model selection, wired through to the coco / codex runtimes',
      },
      {
        zh: '新增 agent 级长期记忆开关与工作区记忆,跨任务沉淀上下文',
        en: 'Per-agent long-term memory toggle and workspace memory that persists context across tasks',
      },
      {
        zh: '更智能的 @提及路由:基于 LLM 的提及分类与等待-唤醒流水线',
        en: 'Smarter @mention routing with an LLM-based classifier and a waiting/wake pipeline',
      },
      {
        zh: '控制台可一键申请 Feishu 应用权限,并按品牌名展示运行时(Claude Code / Codex)',
        en: 'Console can auto-apply Feishu app permissions and shows runtimes by brand name (Claude Code / Codex)',
      },
      {
        zh: '调度默认放开服务端准入,由 daemon 单机派发上限(提升至 10)兜底,避免多 agent 共享机器时过量派发',
        en: 'Scheduling now admits freely on the server with the per-machine daemon dispatch cap (raised to 10) as the real limit, avoiding over-dispatch when agents share a machine',
      },
    ],
    fixes: [
      {
        zh: '安全:debug 接口默认收敛、补全 owner 校验、收紧 forget 作用域',
        en: 'Security: debug surfaces are secure-by-default, owner checks added, and forget scope tightened',
      },
      {
        zh: '远程执行:机器绑定任务可被取消,不再丢失产物(artifact)',
        en: 'Remote execution: machine-bound tasks are now cancellable and no longer lose artifacts',
      },
      {
        zh: '队列:确定性解决 job id 冲突,加固入队冲突处理',
        en: 'Queue: deterministic job-id conflict resolution and hardened enqueue handling',
      },
      {
        zh: '事件去重原子化,避免重复处理同一条消息',
        en: 'Atomic event dedup so the same inbound message is not processed twice',
      },
      {
        zh: '修复 Codex 子进程生命周期并正确遵守 maxTurnCount',
        en: 'Fixed the Codex child-process lifecycle and honored maxTurnCount',
      },
      {
        zh: 'Worker 守护后台失败与运行时看门狗,提升长跑稳定性',
        en: 'Worker contains background failures with a runtime watchdog for long-running stability',
      },
      {
        zh: 'daemon 无条件广告 claude_code 能力(凭据在派发时注入),修复能力探测漏报',
        en: 'Daemon advertises the claude_code capability unconditionally (credentials injected at dispatch), fixing capability under-reporting',
      },
    ],
  },
  {
    version: '1.0.1',
    date: '2026-06-12',
    highlights: [
      {
        zh: '首个正式发布:Feishu 群内 @机器人 即可派发编码任务',
        en: 'Initial release: mention the bot in a Feishu group to dispatch coding tasks',
      },
      {
        zh: '内置 Claude Code 与 Codex 两套运行时,任务卡片实时展示进度',
        en: 'Built-in Claude Code and Codex runtimes, with live task-card progress',
      },
      {
        zh: '服务器集中模式 + 每用户执行 daemon,可在自己机器上远程执行任务',
        en: 'Server-centralized mode with per-user execution daemons to run tasks on your own machine',
      },
      {
        zh: '管理控制台:管理 Feishu 应用、agent、机器与权限',
        en: 'Admin console to manage Feishu apps, agents, machines, and permissions',
      },
    ],
    fixes: [],
  },
];
