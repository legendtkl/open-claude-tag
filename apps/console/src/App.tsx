import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  Compass,
  Copy,
  ExternalLink,
  Home,
  Languages,
  Laptop,
  Link2,
  Loader2,
  LogIn,
  LogOut,
  MessageSquare,
  Pencil,
  Plus,
  QrCode,
  RefreshCcw,
  Rocket,
  Rows3,
  Save,
  Settings2,
  Shield,
  TerminalSquare,
  Trash2,
  Unlink,
  UserRound,
  X,
} from 'lucide-react';
import { Modal } from './Modal';
import {
  applyFeishuAppPermissions,
  bindBot,
  cancelFeishuAppRegistration,
  checkFeishuAppPermissions,
  createAgent,
  deleteAgent,
  deleteFeishuApp,
  createFeishuApp,
  devLogin,
  getFeishuAppRegistration,
  getAdminToken,
  getAuthConfig,
  getDesktopConfig,
  getHealth,
  getMeResult,
  hasBreakGlassToken,
  isDesktopApp,
  disconnectMachine,
  issuePairingToken,
  listComputerAccessUsers,
  loadConsoleData,
  logout as logoutRequest,
  resetDesktopApiUrl,
  saveDesktopApiUrl,
  setAdminToken,
  startFeishuAppRegistration,
  syncFeishuAppMetadata,
  unbindBot,
  updateAgent,
  updateChat,
  updateFeishuApp,
  updateComputerAccessUser,
  type Agent,
  type AuthConfig,
  type Chat,
  type ComputerAccessUser,
  type ConsoleData,
  type DesktopConfig,
  type FeishuApp,
  type FeishuAppRegistration,
  type HealthSummary,
  type FeishuPermissionApplyResult,
  type FeishuPermissionCapabilityResult,
  type FeishuPermissionCheckResult,
  type Machine,
  type Me,
} from './api';
import { createQrCodeSvgDataUrl } from './qr-code';
import './styles.css';

type View =
  | 'onboarding'
  | 'overview'
  | 'agents'
  | 'bots'
  | 'chats'
  | 'machines'
  | 'settings';
type Locale = 'en' | 'zh';
type RefreshConsole = (options?: { showLoading?: boolean }) => Promise<void>;

const SYSTEM_PROMPT_PLACEHOLDER = 'You are a strict code reviewer, be concise and focus on bugs.';
const HIDDEN_CONSOLE_RUNTIMES = new Set<string>([]);
const AGENT_RUNTIME_OPTIONS = ['', 'codex', 'claude_code'];
const CLAUDE_BASE_URL_ENV_KEY = 'ANTHROPIC_BASE_URL';
const CLAUDE_API_KEY_ENV_KEY = 'ANTHROPIC_API_KEY';
type ClaudeAuthMode = 'subscription' | 'custom';
const AGENT_STATUS_OPTIONS = ['active', 'inactive', 'archived'];
const DEV_AUTH_SUB_MAX_LENGTH = 128;
const DEV_AUTH_SUB_PATTERN = /^[A-Za-z0-9._@-]+$/;
const PRODUCT_NAME = 'OpenClaudeTag';
const PRODUCT_FULL_NAME = `${PRODUCT_NAME} Console`;
const PRODUCT_ICON_SRC = '/open-claude-tag-favicon.png?v=20260616';

const navItems = [
  { id: 'overview', icon: Home },
  { id: 'agents', icon: UserRound },
  { id: 'bots', icon: Bot },
  { id: 'chats', icon: MessageSquare },
  { id: 'machines', icon: Laptop },
  { id: 'settings', icon: Settings2 },
] satisfies Array<{ id: View; icon: typeof Home }>;

const viewLabels: Record<Locale, Record<View, string>> = {
  en: {
    onboarding: 'Get Started',
    overview: 'Overview',
    agents: 'Agents',
    bots: 'Bots',
    chats: 'Chats',
    machines: 'Machines',
    settings: 'Settings',
  },
  zh: {
    onboarding: '快速开始',
    overview: '总览',
    agents: '智能体',
    bots: '机器人',
    chats: '会话',
    machines: '执行机器',
    settings: '设置',
  },
};

const uiText = {
  en: {
    brandSubtitle: 'local operator board',
    consoleSections: 'Console sections',
    loading: 'Loading console data',
    localhost: 'localhost',
    language: 'Language',
    summary: (activeAgents: number, botBindings: number) =>
      `${activeAgents} active agents · ${botBindings} bindings`,
    actions: {
      openFeishu: 'Open Feishu',
      board: 'Board',
      task: 'Task',
      topic: 'Topic',
      cancel: 'Cancel',
      register: 'Register',
      bind: 'Bind',
      unbind: 'Unbind',
      edit: 'Edit',
      save: 'Save',
      sync: 'Sync',
      delete: 'Delete',
      checkPermissions: 'Check permissions',
    },
    notices: {
      agentCreated: 'Agent created',
      agentUpdated: 'Agent updated',
      agentDeleted: 'Agent deleted',
      appRegistered: 'Feishu app registered',
      appUpdated: 'Feishu app updated',
      appSynced: 'Feishu app synced',
      appDeleted: 'Feishu app deleted',
      botBound: 'Bot bound',
      botUnbound: 'Bot unbound',
      chatMachineUpdated: 'Chat machine binding updated',
    },
    common: {
      none: 'none',
      auto: 'auto',
      never: 'never',
      unknown: 'unknown',
      unnamed: 'Unnamed',
      unbound: 'unbound',
      stored: 'stored',
      last: 'last',
      tasks: 'tasks',
      tenant: 'tenant',
      taskList: 'Task list',
      empty: 'empty',
      botOpenIdPending: 'auto-discovered',
      noDescription: 'No description',
      permissionCheckPassed: 'Permission check passed',
      permissionCheckFailed: 'Permission check failed',
      permissionMissing: 'Missing permissions',
      permissionCheckPending: 'Checking permissions',
      permissionApplySubmitted: 'Approval request submitted',
      permissionApplyPending: 'Requesting approval',
      permissionApplyFailed: 'Approval request failed',
      permissionApplyNoPendingHint:
        'Add the required scopes in Feishu Open Platform, publish or approve the app version, then check again.',
      permissionApprovalLink: 'Open Platform permissions',
      permissionApprovalQr: 'Open Platform permissions QR',
      permissionRequiredScopes: 'Required scopes',
      missingPermissions: 'Missing permissions',
      optionalGaps: 'Optional gaps',
    },
    daemonGuide: {
      title: 'Connect a machine',
      subtitle:
        'Run the OpenClaudeTag daemon on your machine so tasks can execute there. Pick your OS, get a pairing token, then run the one-command installer.',
      copy: 'Copy',
      copied: 'Copied',
      serverPlaceholderNote:
        'The server has no SERVER_PUBLIC_URL configured yet. Replace <SERVER_PUBLIC_URL> with the daemon gateway URL (ask your deployer).',
      step1Title: '1. Install Node.js 20+',
      step1Linux: 'Linux: use nvm or your distro package manager.',
      step1Mac: 'macOS: install via Homebrew or nvm.',
      step2Title: '2. Generate a pairing token',
      step2Body:
        'Generate a one-time pairing token here (valid 10 minutes, single use). It is filled into the install command below; copy the command and run it on your machine.',
      step2Generate: 'Generate pairing token',
      step2Generating: 'Generating…',
      step2TokenNote: 'One-time token — valid 10 minutes, single use. Copy it now; it is shown only once.',
      step2TokenError: 'Could not generate a token.',
      tokenAdminTitle: 'User sign-in required',
      tokenAdminBody:
        'Pairing tokens must be issued by a user account so the machine has an owner.',
      tokenAdminDevBody:
        'This local server has dev-auth enabled. Switch to a test user, then generate the token again.',
      tokenAdminNoDevBody:
        'This session is using the break-glass admin identity. Start the local API with OPEN_TAG_DEV_AUTH=enabled and sign in as a user to mint pairing tokens.',
      devSubLabel: 'Identity ID',
      devNameLabel: 'Display name',
      devSignIn: 'Sign in as user',
      devSignInFailed: 'Could not sign in as the test user. Retry or check OPEN_TAG_DEV_AUTH.',
      step3Title: '3. Install and start',
      methodBNpx: 'Recommended — one command from the internal registry',
      methodBNpxBody: 'npx fetches the daemon, pairs this machine, and starts it in the background:',
      step4Title: '4. Manage the daemon',
      step4Body:
        'After installation, use these commands to inspect, stop, or restart the background daemon.',
    },
  },
  zh: {
    brandSubtitle: '运维控制台',
    consoleSections: '控制台分区',
    loading: '正在加载控制台数据',
    localhost: '本地服务',
    language: '语言',
    summary: (activeAgents: number, botBindings: number) =>
      `${activeAgents} 个活跃智能体 · ${botBindings} 个绑定`,
    actions: {
      openFeishu: '打开飞书',
      board: '看板',
      task: '任务',
      topic: '话题',
      cancel: '取消',
      register: '注册',
      bind: '绑定',
      unbind: '解绑',
      edit: '编辑',
      save: '保存',
      sync: '同步',
      delete: '删除',
      checkPermissions: '检测权限',
    },
    notices: {
      agentCreated: '已创建智能体',
      agentUpdated: '已更新智能体',
      agentDeleted: '已删除智能体',
      appRegistered: '已注册飞书应用',
      appUpdated: '已更新飞书应用',
      appSynced: '已同步飞书应用',
      appDeleted: '已删除飞书应用',
      botBound: '已绑定机器人',
      botUnbound: '已解绑机器人',
      chatMachineUpdated: '已更新会话执行机器绑定',
    },
    common: {
      none: '无',
      auto: '自动',
      never: '从未',
      unknown: '未知',
      unnamed: '未命名',
      unbound: '未绑定',
      stored: '已存储',
      last: '最近',
      tasks: '个任务',
      tenant: '租户',
      taskList: '任务清单',
      empty: '空',
      botOpenIdPending: '自动获取',
      noDescription: '暂无描述',
      permissionCheckPassed: '权限检测通过',
      permissionCheckFailed: '权限检测失败',
      permissionMissing: '缺少权限',
      permissionCheckPending: '正在检测权限',
      permissionApplySubmitted: '已提交审批申请',
      permissionApplyPending: '正在申请审批',
      permissionApplyFailed: '审批申请失败',
      permissionApplyNoPendingHint:
        '请在飞书开放平台添加下列权限，发布或审批应用版本后再重新检测。',
      permissionApprovalLink: '打开权限配置',
      permissionApprovalQr: '权限配置二维码',
      permissionRequiredScopes: '需开通 scope',
      missingPermissions: '缺少权限',
      optionalGaps: '可选缺口',
    },
    daemonGuide: {
      title: '接入一台机器',
      subtitle:
        '在你的机器上运行 OpenClaudeTag daemon，任务即可在该机器执行。选择操作系统、获取配对令牌，然后执行一条命令完成安装启动。',
      copy: '复制',
      copied: '已复制',
      serverPlaceholderNote:
        '服务端尚未配置 SERVER_PUBLIC_URL。请将 <SERVER_PUBLIC_URL> 替换为 daemon 网关地址（向部署者获取）。',
      step1Title: '1. 安装 Node.js 20+',
      step1Linux: 'Linux：使用 nvm 或发行版包管理器。',
      step1Mac: 'macOS：通过 Homebrew 或 nvm 安装。',
      step2Title: '2. 生成配对令牌',
      step2Body:
        '在此生成一次性配对令牌（10 分钟、单次有效）。令牌会自动填入下方安装命令；复制该命令并在你的机器上运行。',
      step2Generate: '生成配对令牌',
      step2Generating: '正在生成…',
      step2TokenNote: '一次性令牌 — 10 分钟内、单次有效。请立即复制，仅显示一次。',
      step2TokenError: '生成令牌失败。',
      tokenAdminTitle: '需要用户身份',
      tokenAdminBody: '配对令牌必须由用户账号签发，这样配对后的机器才有明确归属。',
      tokenAdminDevBody:
        '当前本地服务已开启 dev-auth。请切换为测试用户，然后再次生成令牌。',
      tokenAdminNoDevBody:
        '当前会话使用的是 break-glass 管理员身份。请在本地 API 启动时设置 OPEN_TAG_DEV_AUTH=enabled，并以用户身份登录后再生成配对令牌。',
      devSubLabel: '身份 ID',
      devNameLabel: '显示名',
      devSignIn: '以用户身份登录',
      devSignInFailed: '测试用户登录失败。请重试或检查 OPEN_TAG_DEV_AUTH。',
      step3Title: '3. 安装并启动',
      methodBNpx: '推荐 — 从内部源一条命令安装',
      methodBNpxBody: 'npx 会拉取 daemon、完成配对，并在后台启动：',
      step4Title: '4. 管理 daemon',
      step4Body: '安装后可用这些命令查看、停止或重启后台 daemon。',
    },
  },
} as const;

const initialData: ConsoleData = {
  summary: {
    profiles: 0,
    agents: 0,
    activeAgents: 0,
    feishuApps: 0,
    enabledFeishuApps: 0,
    botBindings: 0,
    chats: 0,
    taskBoards: 0,
    machines: 0,
    onlineMachines: 0,
  },
  profiles: [],
  agents: [],
  apps: [],
  chats: [],
  machines: [],
};

function visibleRuntimeValue(runtime: string | null | undefined): string {
  // Normalize an empty, hidden, or no-longer-selectable runtime (e.g. a legacy
  // `coco` default after that runtime was removed) to '' so the select can render
  // it and editing a legacy agent isn't blocked by an option that no longer exists.
  if (!runtime || HIDDEN_CONSOLE_RUNTIMES.has(runtime) || !AGENT_RUNTIME_OPTIONS.includes(runtime)) {
    return '';
  }
  return runtime;
}

function visibleRuntimeValues(runtimes: string[]): string[] {
  return runtimes.filter((runtime) => !HIDDEN_CONSOLE_RUNTIMES.has(runtime));
}

// Proper-noun display names for runtimes. The internal values stay
// `claude_code` / `codex`; the UI always surfaces the brand names.
const RUNTIME_DISPLAY_NAMES: Record<string, string> = {
  codex: 'Codex',
  claude_code: 'Claude Code',
};

function runtimeDisplayName(runtime: string): string {
  return RUNTIME_DISPLAY_NAMES[runtime] ?? runtime;
}

function runtimeLabel(runtime: string | null, locale: Locale): string {
  const visibleRuntime = visibleRuntimeValue(runtime);
  return visibleRuntime ? runtimeDisplayName(visibleRuntime) : uiText[locale].common.auto;
}

function secretLabel(
  app: { appSecretRef: string; hasStoredSecret: boolean },
  locale: Locale,
): string {
  if (!app.hasStoredSecret) return app.appSecretRef;
  if (!app.appSecretRef || app.appSecretRef === 'stored') return uiText[locale].common.stored;
  return `${uiText[locale].common.stored} + ${app.appSecretRef}`;
}

const FEISHU_OPEN_PLATFORM_ORIGIN = 'https://open.feishu.cn';

function missingRequiredCapabilityResults(
  result: FeishuPermissionCheckResult,
): FeishuPermissionCapabilityResult[] {
  const missingIds = new Set(result.missingRequiredCapabilities);
  return result.capabilities.filter((capability) => missingIds.has(capability.id));
}

function missingRequiredCapabilityLabels(result: FeishuPermissionCheckResult): string[] {
  const labelsById = new Map(
    result.capabilities.map((capability) => [capability.id, capability.label || capability.id]),
  );
  return result.missingRequiredCapabilities.map((id) => labelsById.get(id) ?? id);
}

function missingRequiredScopeNames(result: FeishuPermissionCheckResult): string[] {
  const selectedScopes = new Set<string>();
  for (const capability of missingRequiredCapabilityResults(result)) {
    for (const group of capability.groups) {
      if (group.satisfiedBy) continue;
      let alreadySelected = false;
      for (const scope of selectedScopes) {
        if (group.anyOf.includes(scope)) {
          alreadySelected = true;
          break;
        }
      }
      if (alreadySelected) continue;
      const preferredScope = group.anyOf[0];
      if (preferredScope) selectedScopes.add(preferredScope);
    }
  }
  return [...selectedScopes];
}

function buildFeishuPermissionApprovalUrl(result: FeishuPermissionCheckResult): string {
  const requiredScopes = missingRequiredScopeNames(result);
  if (requiredScopes.length > 0) {
    const url = new URL('/page/scope-apply', FEISHU_OPEN_PLATFORM_ORIGIN);
    url.searchParams.set('clientID', result.appId);
    url.searchParams.set('scopes', requiredScopes.join(','));
    return url.toString();
  }
  const url = new URL(`/app/${encodeURIComponent(result.appId)}/auth`, FEISHU_OPEN_PLATFORM_ORIGIN);
  url.searchParams.set('op_from', 'openapi');
  url.searchParams.set('token_type', 'tenant');
  return url.toString();
}

function buildFeishuPermissionApprovalQrUrl(approvalUrl: string): string | null {
  try {
    return createQrCodeSvgDataUrl(approvalUrl);
  } catch {
    return null;
  }
}

function permissionAutoApplyKey(result: FeishuPermissionCheckResult): string {
  const requiredScopes = missingRequiredScopeNames(result);
  const missing = requiredScopes.length > 0 ? requiredScopes : result.missingRequiredCapabilities;
  return [result.appId, ...missing].join('|');
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseRuntimeEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const delimiter = line.indexOf('=');
    if (delimiter <= 0) {
      throw new Error(`Invalid env line "${line}". Use KEY=value.`);
    }
    const key = line.slice(0, delimiter).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid env key "${key}". Use letters, numbers, and underscores.`);
    }
    env[key] = line.slice(delimiter + 1);
  }
  return env;
}

type FieldErrors<T extends string> = Partial<Record<T, string>>;

const validationText = {
  en: {
    required: (label: string) => `${label} is required.`,
    chooseValid: (label: string) => `Choose a valid ${label}.`,
    devSubLength: `Identity ID must be ${DEV_AUTH_SUB_MAX_LENGTH} characters or fewer.`,
    devSubPattern: 'Use letters, numbers, dot, underscore, hyphen, or @ only.',
    apiUrl: 'Enter a valid HTTP(S) URL.',
    breakGlassRequired: 'Enter an admin token.',
  },
  zh: {
    required: (label: string) => `请填写${label}。`,
    chooseValid: (label: string) => `请选择有效的${label}。`,
    devSubLength: `身份 ID 不能超过 ${DEV_AUTH_SUB_MAX_LENGTH} 个字符。`,
    devSubPattern: '身份 ID 仅支持字母、数字、点、下划线、连字符或 @。',
    apiUrl: '请输入有效的 HTTP(S) URL。',
    breakGlassRequired: '请填写管理令牌。',
  },
} as const;

function requiredError(value: string, label: string, locale: Locale): string | undefined {
  return value.trim() ? undefined : validationText[locale].required(label);
}

function optionError(
  value: string,
  options: string[],
  label: string,
  locale: Locale,
): string | undefined {
  return options.includes(value) ? undefined : validationText[locale].chooseValid(label);
}

function httpUrlError(value: string, label: string, locale: Locale): string | undefined {
  const missing = requiredError(value, label, locale);
  if (missing) return missing;
  const trimmed = value.trim();
  if (/\s/.test(trimmed)) return validationText[locale].apiUrl;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? undefined
      : validationText[locale].apiUrl;
  } catch {
    return validationText[locale].apiUrl;
  }
}

function devSubError(value: string, label: string, locale: Locale): string | undefined {
  const missing = requiredError(value, label, locale);
  if (missing) return missing;
  const trimmed = value.trim();
  if (trimmed.length > DEV_AUTH_SUB_MAX_LENGTH) return validationText[locale].devSubLength;
  return DEV_AUTH_SUB_PATTERN.test(trimmed) ? undefined : validationText[locale].devSubPattern;
}

function hasValidationErrors<T extends string>(errors: FieldErrors<T>): boolean {
  return Object.values(errors).some(Boolean);
}

function visibleError<T extends string>(
  errors: FieldErrors<T>,
  field: T,
  show: boolean,
): string | undefined {
  return show ? errors[field] : undefined;
}

function unifiedProfileSystemPrompt(
  profile?: {
    systemPrompt?: string | null;
    stylePrompt?: string | null;
  } | null,
): string {
  return [profile?.systemPrompt, profile?.stylePrompt]
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section))
    .join('\n\n');
}

function shortId(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function formatDate(value: string | null, locale: Locale): string {
  if (!value) return uiText[locale].common.never;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return uiText[locale].common.unknown;
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function statusLabel(value: string, locale: Locale): string {
  if (locale === 'en') return value;
  const labels: Record<string, string> = {
    active: '启用',
    enabled: '启用',
    inactive: '停用',
    disabled: '停用',
    archived: '已归档',
    running: '运行中',
    queued: '排队中',
    failed: '失败',
    completed: '已完成',
    todo: '待办',
    'in-progress': '进行中',
    'to-clarify': '待澄清',
    review: '待评审',
    cleaned: '已清理',
    unknown: '未知',
    online: '在线',
    offline: '离线',
    revoked: '已吊销',
  };
  return labels[value] ?? value;
}

function formatRelativeTime(value: string | null, locale: Locale): string {
  if (!value) return uiText[locale].common.never;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return uiText[locale].common.unknown;
  const diffMs = date.getTime() - Date.now();
  const formatter = new Intl.RelativeTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    numeric: 'auto',
  });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(diffMs) >= ms) {
      return formatter.format(Math.round(diffMs / ms), unit);
    }
  }
  return formatter.format(Math.round(diffMs / 1000), 'second');
}

type AgentFormField = 'displayName' | 'defaultRuntime' | 'machineId' | 'status';

function validateAgentForm(
  input: {
    displayName: string;
    defaultRuntime: string;
    machineId: string;
    status?: string;
  },
  options: {
    locale: Locale;
    machineOptions: string[];
    displayNameLabel: string;
    machineLabel: string;
    statusLabel?: string;
  },
): FieldErrors<AgentFormField> {
  const errors: FieldErrors<AgentFormField> = {};
  errors.displayName = requiredError(input.displayName, options.displayNameLabel, options.locale);
  errors.defaultRuntime = optionError(input.defaultRuntime, AGENT_RUNTIME_OPTIONS, 'Runtime', options.locale);
  errors.machineId = optionError(input.machineId, options.machineOptions, options.machineLabel, options.locale);
  if (input.status !== undefined) {
    errors.status = optionError(
      input.status,
      AGENT_STATUS_OPTIONS,
      options.statusLabel ?? 'Status',
      options.locale,
    );
  }
  return errors;
}

function hasClaudeCredentialKeys(keys: string[]): boolean {
  return keys.includes(CLAUDE_BASE_URL_ENV_KEY) || keys.includes(CLAUDE_API_KEY_ENV_KEY);
}

function withoutClaudeCredentialKeys(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  delete next[CLAUDE_BASE_URL_ENV_KEY];
  delete next[CLAUDE_API_KEY_ENV_KEY];
  return next;
}

function claudeAuthModeLabel(mode: ClaudeAuthMode, locale: Locale): string {
  if (mode === 'subscription') return locale === 'zh' ? '订阅登录' : 'Subscription login';
  return locale === 'zh' ? '自定义凭证' : 'Custom credentials';
}

// Per-agent Claude credential field validation. Subscription/local-login mode
// requires no fields. Custom mode requires Base URL and API Key together; on edit
// blank means "keep existing" only when stored write-only keys are present and
// runtimeEnv is not otherwise being replaced.
function claudeCredentialFieldErrors(
  runtime: string,
  authMode: ClaudeAuthMode,
  baseUrl: string,
  apiKey: string,
  mode: 'create' | 'edit',
  locale: Locale,
  // Edit-only: the agent already has ANTHROPIC_* keys AND this submit replaces
  // runtimeEnv wholesale (Env textarea edited / cleared). Leaving the Claude
  // fields blank would then drop the existing write-only secrets the API never
  // echoes back, so force re-entry of both.
  editContext?: { hasExistingClaudeKeys: boolean; replacesRuntimeEnv: boolean },
): { baseUrl?: string; apiKey?: string } {
  if (runtime !== 'claude_code') return {};
  if (authMode === 'subscription') return {};
  const hasBaseUrl = baseUrl.trim().length > 0;
  const hasApiKey = apiKey.trim().length > 0;
  const wouldDropExistingSecrets =
    mode === 'edit' &&
    Boolean(editContext?.hasExistingClaudeKeys) &&
    Boolean(editContext?.replacesRuntimeEnv);
  if (mode === 'edit' && !hasBaseUrl && !hasApiKey && !wouldDropExistingSecrets) return {};
  if (mode === 'edit' && hasBaseUrl && hasApiKey) return {};
  const baseUrlMsg = locale === 'zh' ? '请填写 API 接入地址 (Base URL)' : 'API Base URL is required';
  const apiKeyMsg = locale === 'zh' ? '请填写 API 密钥 (API Key)' : 'API Key is required';
  const pairMsg =
    locale === 'zh'
      ? '更新凭证需同时填写 Base URL 和 API Key（会整体替换 Env）'
      : 'Provide both Base URL and API Key to update credentials (they replace runtimeEnv together)';
  if (mode === 'edit') {
    return {
      baseUrl: hasBaseUrl ? undefined : pairMsg,
      apiKey: hasApiKey ? undefined : pairMsg,
    };
  }
  return {
    baseUrl: hasBaseUrl ? undefined : baseUrlMsg,
    apiKey: hasApiKey ? undefined : apiKeyMsg,
  };
}

function hasFieldErrors(errors: { baseUrl?: string; apiKey?: string }): boolean {
  return Boolean(errors.baseUrl || errors.apiKey);
}

type FeishuAppFormField = 'appId' | 'appSecret';

function validateFeishuAppForm(
  input: { appId: string; appSecret: string },
  locale: Locale,
): FieldErrors<FeishuAppFormField> {
  return {
    appId: requiredError(input.appId, 'App ID', locale),
    appSecret: requiredError(input.appSecret, 'App Secret', locale),
  };
}

const LOCALE_STORAGE_KEY = 'open-claude-tag.console.locale';

function readStoredLocale(): Locale | null {
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return value === 'en' || value === 'zh' ? value : null;
  } catch {
    return null;
  }
}

/** Seed the initial locale from a persisted choice, falling back to the browser language. */
function detectInitialLocale(): Locale {
  const stored = readStoredLocale();
  if (stored) return stored;
  try {
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

export function App() {
  const [view, setView] = useState<View>('overview');
  const [locale, setLocale] = useState<Locale>(detectInitialLocale);
  const [data, setData] = useState<ConsoleData>(initialData);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ view: View; message: string } | null>(null);
  // Personal-mode first-run wizard auto-route runs at most once per page load.
  const didAutoRouteRef = useRef(false);
  // null = identity not resolved yet (initial loading); when an unauthenticated
  // (401/403) result comes back AND no break-glass token is configured, the
  // login gate renders instead of the console shell.
  const [needsLogin, setNeedsLogin] = useState(false);

  // Keep <html lang> in sync with the UI language (screen readers / browser
  // translation) and persist the choice so it survives reloads.
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // localStorage unavailable (private mode / disabled) — non-fatal.
    }
  }, [locale]);

  async function refresh(options: { showLoading?: boolean } = {}) {
    const showLoading = options.showLoading !== false;
    if (showLoading) setLoading(true);
    setError(null);
    try {
      // Resolve identity first so the header chip and owner-gated columns render
      // even if a later list call fails (graceful 403/empty handling, D-A4).
      const meResult = await getMeResult();
      if (!meResult.authenticated) {
        // 401/403 with no break-glass token → show the login gate. With a
        // break-glass token configured we keep the console mounted (the token
        // path is the operator's deliberate bypass).
        if (
          (meResult.status === 401 || meResult.status === 403) &&
          !hasBreakGlassToken()
        ) {
          setMe(null);
          setNeedsLogin(true);
          return;
        }
        setMe(null);
      } else {
        setMe(meResult.me);
      }
      setNeedsLogin(false);
      // Machines are owner-scoped, not permission-gated: every signed-in user can
      // list and manage their own machines. computerAccessEnabled only gates the
      // server-local execution option in the agent forms.
      const includeMachines = meResult.authenticated || hasBreakGlassToken();
      // Load console data and the daemon-install config in parallel; the config
      // is best-effort (getAuthConfig swallows errors and returns defaults) so a
      // missing config never blocks the console from rendering.
      const [consoleData, config] = await Promise.all([
        loadConsoleData({ includeMachines }),
        getAuthConfig(),
      ]);
      setData(consoleData);
      setAuthConfig(config);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  async function logout() {
    await logoutRequest();
    setMe(null);
    setNeedsLogin(true);
  }

  async function runAction(label: string, action: () => Promise<unknown>) {
    const noticeView = view;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice({ view: noticeView, message: label });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const labels = viewLabels[locale];
  const text = uiText[locale];
  const canUseComputer = me?.computerAccessEnabled === true;
  const personalMode = authConfig?.personalMode === true;

  // Empty-state auto-launch (personal mode): on first load, route to the wizard
  // when setup is not complete and the user has not skipped it. Runs once per
  // page load (ref-guarded) and only after the initial data + auth config have
  // resolved (loading=false, authConfig set) so personalMode is never "unknown".
  // When setup is structurally complete it still confirms the bound app is live on
  // /health before treating onboarding as done.
  useEffect(() => {
    if (didAutoRouteRef.current) return;
    if (loading || needsLogin || !authConfig) return;
    didAutoRouteRef.current = true;
    if (!authConfig.personalMode || readOnboardingDismissed()) return;
    if (!isOnboardingComplete(data)) {
      setView('onboarding');
      return;
    }
    // Structurally complete — confirm the bound app is actually live before
    // treating onboarding as done (else a disabled/unhealthy bot hides the wizard).
    const bound = activeBoundFeishuApp(data);
    if (bound) {
      void getHealth().then((health) => {
        if (!isFeishuAppLive(health, bound.appId)) setView('onboarding');
      });
    }
  }, [loading, needsLogin, authConfig, data]);

  // The onboarding wizard is reachable from the nav only in personal mode, so the
  // full multi-tenant console is unchanged when the flag is off.
  const visibleNavItems = personalMode
    ? [{ id: 'onboarding' as const, icon: Compass }, ...navItems]
    : navItems;
  const navStyle = { '--nav-item-count': visibleNavItems.length } as React.CSSProperties;

  function exitOnboardingToConsole() {
    writeOnboardingDismissed(true);
    setNotice(null);
    setView('overview');
  }

  if (needsLogin) {
    return <LoginGate locale={locale} setLocale={setLocale} onAuthenticated={refresh} />;
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img aria-hidden="true" className="brand-icon" src={PRODUCT_ICON_SRC} alt="" />
          </div>
          <div>
            <div className="brand-title">{PRODUCT_NAME}</div>
            <div className="brand-subtitle">{text.brandSubtitle}</div>
          </div>
        </div>
        <nav className="nav-list" style={navStyle} aria-label={text.consoleSections}>
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            const label = labels[item.id];
            return (
              <button
                aria-label={label}
                className={`nav-item ${view === item.id ? 'active' : ''}`}
                key={item.id}
                onClick={() => {
                  setView(item.id);
                  setNotice(null);
                }}
                title={label}
                type="button"
              >
                <Icon size={18} />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>{labels[view]}</h1>
            <p>{text.summary(data.summary.activeAgents, data.summary.botBindings)}</p>
          </div>
          <div className="topbar-actions">
            <div className="segmented-control" aria-label={text.language}>
              <button
                aria-pressed={locale === 'en'}
                className={locale === 'en' ? 'active' : ''}
                onClick={() => setLocale('en')}
                type="button"
              >
                <LanguageDoodleIcon /> EN
              </button>
              <button
                aria-pressed={locale === 'zh'}
                className={locale === 'zh' ? 'active' : ''}
                onClick={() => setLocale('zh')}
                type="button"
              >
                中文
              </button>
            </div>
            {me ? <IdentityChip me={me} locale={locale} onLogout={logout} /> : null}
          </div>
        </header>

        {error ? <div className="alert error">{error}</div> : null}
        {notice?.view === view ? (
          <div className="alert success">
            <Check size={16} />
            {notice.message}
          </div>
        ) : null}

        {loading ? (
          <div className="loading">
            <Loader2 className="spin" />
            {text.loading}
          </div>
        ) : null}

        {!loading && view === 'onboarding' ? (
          <OnboardingWizard
            data={data}
            locale={locale}
            personalMode={personalMode}
            canUseComputer={canUseComputer}
            refreshConsole={refresh}
            onExitToConsole={exitOnboardingToConsole}
          />
        ) : null}
        {!loading && view === 'overview' ? (
          <Overview
            data={data}
            locale={locale}
            onOpenBots={() => setView('bots')}
            refreshConsole={refresh}
          />
        ) : null}
        {!loading && view === 'agents' ? (
          <AgentsView
            data={data}
            busy={busy}
            locale={locale}
            runAction={runAction}
            isSuperadmin={me?.role === 'superadmin'}
            canUseComputer={canUseComputer}
          />
        ) : null}
        {!loading && view === 'bots' ? (
          <BotsView
            data={data}
            busy={busy}
            locale={locale}
            runAction={runAction}
            isSuperadmin={me?.role === 'superadmin'}
            refreshConsole={refresh}
          />
        ) : null}
        {!loading && view === 'chats' ? (
          <ChatsView data={data} busy={busy} locale={locale} runAction={runAction} />
        ) : null}
        {!loading && view === 'machines' ? (
          <MachinesView
            data={data}
            locale={locale}
            authConfig={authConfig}
            me={me}
            onAuthenticated={refresh}
          />
        ) : null}
        {view === 'settings' ? (
          <SettingsView data={data} locale={locale} me={me} refreshConsole={refresh} />
        ) : null}
      </section>
    </main>
  );
}

function IdentityChip({
  me,
  locale,
  onLogout,
}: {
  me: Me;
  locale: Locale;
  onLogout: () => void | Promise<void>;
}) {
  const roleLabel =
    me.role === 'superadmin'
      ? locale === 'zh'
        ? '超级管理员'
        : 'Superadmin'
      : locale === 'zh'
        ? '用户'
        : 'User';
  const tokenLabel = locale === 'zh' ? '令牌管理员' : 'token admin';
  const name =
    me.displayName ??
    me.email ??
    (me.tokenAdmin ? tokenLabel : locale === 'zh' ? '未知' : 'unknown');
  const logoutLabel = locale === 'zh' ? '退出登录' : 'Log out';
  const avatarSeed = me.id ?? me.email ?? me.displayName ?? name;
  return (
    <div className="status-pill identity-chip" title={me.email ?? roleLabel}>
      <DoodleAvatar label={name} seed={avatarSeed} />
      <span className="identity-name">{name}</span>
      <button
        aria-label={logoutLabel}
        className="identity-logout"
        onClick={() => void onLogout()}
        title={logoutLabel}
        type="button"
      >
        <LogOut size={17} />
      </button>
    </div>
  );
}

function LanguageDoodleIcon() {
  return (
    <span className="doodle-icon language-doodle-icon" aria-hidden="true">
      <Languages size={17} strokeWidth={2.4} />
    </span>
  );
}

function DoodleAvatar({ label, seed }: { label: string; seed: string }) {
  const variant = stableIndex(seed || label, 8);
  const faceProps = { cx: 16, cy: 17, r: 8.5 } as const;
  return (
    <span className={`doodle-icon doodle-avatar doodle-avatar-${variant}`} aria-hidden="true" title={label}>
      <svg viewBox="0 0 32 32" focusable="false">
        <circle className="doodle-avatar-bg" cx="16" cy="16" r="14" />
        {variant === 0 ? (
          <>
            <path d="M9.5 15.5c.5-5 4.5-8 9.2-6.7 2.5.7 4 2.4 4.5 5" />
            <circle {...faceProps} />
            <path d="M11.5 17.2h3.8m1.4 0h3.8M15.3 17.2c.2 1 1.2 1 1.4 0" />
            <path d="M12.8 22c1.5 1.2 4.8 1.2 6.4 0" />
            <path d="M16 7.6l.5-2.4" />
          </>
        ) : null}
        {variant === 1 ? (
          <>
            <path d="M8.8 15.6c1.3-5 5.2-7.2 9.4-6.1 3.4.9 5.2 3.8 4.8 7.8" />
            <circle {...faceProps} />
            <path d="M12.2 17.2h.1M19.8 17.2h.1M14 21.8c1.3.8 2.8.9 4.2 0" />
            <path d="M8.6 15.5c2.2.1 4.2-.8 5.7-2.7 2.1 2.3 4.9 3.4 8.7 3.1" />
            <path d="M11.6 20.2h.1M20.4 20.2h.1" />
          </>
        ) : null}
        {variant === 2 ? (
          <>
            <path d="M8.4 14.2c1.1-3.7 4.1-5.7 7.9-5.7 4.1 0 7 2.1 7.6 5.9" />
            <path d="M9.3 12.5c3.8-1.3 8.8-1.3 13.3.1l2.2 1.8" />
            <circle {...faceProps} />
            <path d="M12.4 17.3h.1M19.6 17.3h.1M13.6 22c1.4 1 3.5 1 4.9 0" />
            <path d="M11.2 12.2c1.3-1.5 3-2.2 5.1-2.1" />
          </>
        ) : null}
        {variant === 3 ? (
          <>
            <circle {...faceProps} />
            <path d="M9.1 16c.3-4.7 3.1-7.5 7-7.5s6.7 2.8 7 7.5" />
            <path d="M7.7 17.1v3.3c0 .9.6 1.5 1.4 1.5h1.1v-6.2H9.1c-.8 0-1.4.6-1.4 1.4ZM24.3 17.1v3.3c0 .9-.6 1.5-1.4 1.5h-1.1v-6.2h1.1c.8 0 1.4.6 1.4 1.4Z" />
            <path d="M12.7 17.4h.1M19.3 17.4h.1M14 22c1.4.8 2.7.8 4 0" />
            <path d="M22.8 21.8c-.7 2-2.4 3-5.2 3" />
          </>
        ) : null}
        {variant === 4 ? (
          <>
            <path d="M9.8 13.6c-.8-2.3.5-4.1 2.8-3.9.7-2.2 4.4-2.5 5.5-.3 2.2-.2 3.8 1.5 3.3 3.6 1.9.9 2.2 3.4.5 4.7" />
            <circle {...faceProps} />
            <path d="M12.7 17.6h.1M19.3 17.6h.1M13.5 22c1.6 1 3.3 1 5 0" />
            <path d="M10.2 14c1.5-.3 2.7-1.2 3.5-2.6 1.4 1.6 3.9 2.5 7.5 2.7" />
          </>
        ) : null}
        {variant === 5 ? (
          <>
            <path d="M8.9 15.8c.7-4.7 4.2-7.3 8.4-6.8 3.1.4 5.4 2.8 5.7 6.1" />
            <circle {...faceProps} />
            <path d="M10.2 15.4c3.7-.4 6.5-1.8 8.5-4.4.6 1.8 1.9 3.2 4 4.3" />
            <path d="M12.6 17.4h.1M19.4 17.4h.1M14.4 22.1c1.2.7 2.4.7 3.7 0" />
            <path d="M8.6 23.8c2.5 2.1 12.6 2.1 14.9 0" />
          </>
        ) : null}
        {variant === 6 ? (
          <>
            <circle {...faceProps} />
            <path d="M9.4 15c.5-4.5 3.5-6.9 7.4-6.7 3.4.2 5.8 2.3 6 6.8" />
            <path d="M11.3 16.8l2.4-1.1 2.2 1.1-2.2 1.2-2.4-1.2ZM16.1 16.8l2.3-1.1 2.4 1.1-2.4 1.2-2.3-1.2Z" />
            <path d="M14.2 22.2c1.3.7 2.7.7 4 0" />
            <path d="M8.8 12.5c1.5-.9 3.3-1.5 5.3-1.5" />
          </>
        ) : null}
        {variant === 7 ? (
          <>
            <path d="M9.2 14.9c.3-3.6 3-6.1 6.8-6.1s6.5 2.5 6.8 6.1" />
            <path d="M8.6 25c.9-3.4 3.4-5 7.4-5s6.5 1.6 7.4 5" />
            <circle {...faceProps} />
            <path d="M12.5 17.4h.1M19.5 17.4h.1M14 22c1.4.9 2.8.9 4.2 0" />
            <path d="M11.8 10.4c1.6-1.1 3.6-1.6 5.9-1.2" />
          </>
        ) : null}
      </svg>
    </span>
  );
}

function stableIndex(seed: string, size: number): number {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) % size;
}

const loginCopy = {
  en: {
    title: PRODUCT_FULL_NAME,
    subtitle: 'Sign in to manage agents, bots, and execution machines.',
    tokenTitle: 'Admin token',
    tokenHint:
      'Paste the break-glass admin token (OPEN_TAG_ADMIN_TOKEN). Stored locally in this browser. Loopback hosts are admitted without one.',
    adminToken: 'Admin token',
    continue: 'Continue',
    language: 'Language',
    devTitle: 'Dev sign-in',
    devWarning: 'Local only. No external auth — signs in as the identity you type.',
    devSubLabel: 'Identity ID (sub)',
    devNameLabel: 'Display name (optional)',
    devSubmit: 'Sign in as',
    devFailed: 'Dev sign-in failed. Please try again.',
  },
  zh: {
    title: `${PRODUCT_NAME} 控制台`,
    subtitle: '登录后管理智能体、机器人和执行机器。',
    tokenTitle: '管理令牌',
    tokenHint:
      '粘贴应急管理令牌（OPEN_TAG_ADMIN_TOKEN）。仅保存在当前浏览器本地。回环主机无需令牌即可进入。',
    adminToken: '管理令牌',
    continue: '继续',
    language: '语言',
    devTitle: '本地登录 (Dev)',
    devWarning: '仅用于本地。无任何外部认证 —— 以输入的身份直接登录。',
    devSubLabel: '身份 ID (sub)',
    devNameLabel: '显示名（可选）',
    devSubmit: '以此身份登录',
    devFailed: '本地登录失败，请重试。',
  },
} as const;

function LoginGate({
  locale,
  setLocale,
  onAuthenticated,
}: {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  onAuthenticated: () => Promise<void>;
}) {
  const copy = loginCopy[locale];
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminTokenInput, setAdminTokenInput] = useState(() => getAdminToken());
  const [devSubInput, setDevSubInput] = useState('');
  const [devNameInput, setDevNameInput] = useState('');
  const [breakGlassSubmitted, setBreakGlassSubmitted] = useState(false);
  const [devLoginSubmitted, setDevLoginSubmitted] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getAuthConfig().then((next) => {
      if (mounted) setConfig(next);
    });
    return () => {
      mounted = false;
    };
  }, []);

  async function applyBreakGlass() {
    setBreakGlassSubmitted(true);
    if (!adminTokenInput.trim()) return;
    setAdminToken(adminTokenInput.trim());
    await onAuthenticated();
  }

  async function applyDevLogin() {
    setDevLoginSubmitted(true);
    if (devSubError(devSubInput, copy.devSubLabel, locale)) return;
    setError(null);
    setBusy(true);
    // dev-login sets an httpOnly cc_dev_user cookie; onAuthenticated re-fetches
    // /admin/me which then resolves the cookie to the dev identity.
    const ok = await devLogin(devSubInput.trim(), devNameInput.trim() || undefined);
    if (!ok) {
      setError(copy.devFailed);
      setBusy(false);
      return;
    }
    await onAuthenticated();
  }

  const devAuthEnabled = config?.devAuthEnabled === true;
  const breakGlassError = !adminTokenInput.trim()
    ? validationText[locale].breakGlassRequired
    : undefined;
  const showBreakGlassError = breakGlassSubmitted && Boolean(breakGlassError);
  const devLoginErrors: FieldErrors<'sub'> = {
    sub: devSubError(devSubInput, copy.devSubLabel, locale),
  };

  return (
    <main className="login-gate">
      <div className="login-lang segmented-control" aria-label={copy.language}>
        <button
          aria-pressed={locale === 'en'}
          className={locale === 'en' ? 'active' : ''}
          onClick={() => setLocale('en')}
          type="button"
        >
          <LanguageDoodleIcon /> EN
        </button>
        <button
          aria-pressed={locale === 'zh'}
          className={locale === 'zh' ? 'active' : ''}
          onClick={() => setLocale('zh')}
          type="button"
        >
          中文
        </button>
      </div>
      <section className="login-card panel">
        <div className="login-brand">
          <div className="brand-mark">CC</div>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>

        {error ? <div className="alert error">{error}</div> : null}

        <FormGrid>
          <div className="login-dev-title">{copy.tokenTitle}</div>
          <small className="field-hint">{copy.tokenHint}</small>
          <Input
            label={copy.adminToken}
            type="password"
            value={adminTokenInput}
            placeholder="x-open-claude-tag-admin-token"
            onChange={setAdminTokenInput}
            error={showBreakGlassError ? breakGlassError : undefined}
          />
          <button
            className="primary"
            disabled={Boolean(breakGlassError)}
            onClick={() => void applyBreakGlass()}
            type="button"
          >
            <LogIn size={16} /> {copy.continue}
          </button>
        </FormGrid>

        {devAuthEnabled ? (
          <section className="login-dev-section">
            <div className="login-dev-title">
              <TerminalSquare size={15} /> {copy.devTitle}
            </div>
            <div className="alert error login-dev-warning">{copy.devWarning}</div>
            <FormGrid>
              <Input
                label={copy.devSubLabel}
                value={devSubInput}
                placeholder="alice"
                onChange={setDevSubInput}
                required
                error={visibleError(
                  devLoginErrors,
                  'sub',
                  devLoginSubmitted || Boolean(devSubInput),
                )}
              />
              <Input
                label={copy.devNameLabel}
                value={devNameInput}
                placeholder="Alice"
                onChange={setDevNameInput}
              />
              <button
                className="secondary"
                disabled={busy || hasValidationErrors(devLoginErrors)}
                onClick={() => void applyDevLogin()}
                type="button"
              >
                {busy ? <Loader2 size={16} className="spin" /> : <LogIn size={16} />}{' '}
                {copy.devSubmit}
              </button>
            </FormGrid>
          </section>
        ) : null}
      </section>
    </main>
  );
}

/** Bounded go-live poll status for the final wizard step. */
type GoLiveState = 'idle' | 'polling' | 'live' | 'disabled' | 'timeout';

const GO_LIVE_MAX_ATTEMPTS = 30;
const GO_LIVE_POLL_INTERVAL_MS = 2000;

/**
 * The linear first-run onboarding wizard (personal mode). It SEQUENCES existing
 * console capabilities into a guided flow — reusing FeishuBotOnboardingPanel, the
 * extracted AgentCreateForm, the api client, and the permission-approval helpers —
 * rather than duplicating their logic. Steps: welcome/runtime-check → connect
 * Feishu → create an agent → bind + go live.
 */
function OnboardingWizard({
  data,
  locale,
  personalMode,
  canUseComputer,
  refreshConsole,
  onExitToConsole,
}: {
  data: ConsoleData;
  locale: Locale;
  personalMode: boolean;
  canUseComputer: boolean;
  refreshConsole: RefreshConsole;
  /** Dismiss the wizard and show the normal console. */
  onExitToConsole: () => void;
}) {
  const [step, setStep] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [bindingAgentId, setBindingAgentId] = useState('');
  const [permission, setPermission] = useState<{
    loading: boolean;
    result?: FeishuPermissionCheckResult;
    applying?: boolean;
    applied?: FeishuPermissionApplyResult;
    error?: string;
  } | null>(null);
  const [goLive, setGoLive] = useState<GoLiveState>('idle');
  const [retryNonce, setRetryNonce] = useState(0);
  const [manualApp, setManualApp] = useState({ appId: '', appSecret: '', botName: '' });
  const [manualSubmitted, setManualSubmitted] = useState(false);

  const activeAgents = useMemo(
    () => data.agents.filter((agent) => agent.status === 'active'),
    [data.agents],
  );
  const hasApp = data.apps.length > 0;
  const boundApp = activeBoundFeishuApp(data);
  // The app the go-live step binds to: prefer an enabled, still-unbound app.
  const targetApp =
    data.apps.find((app) => app.status === 'enabled' && !app.binding) ??
    data.apps.find((app) => app.status === 'enabled') ??
    data.apps[0] ??
    null;
  // The most relevant app for the permission self-approve control on the Feishu step.
  const permissionApp = data.apps.find((app) => app.status === 'enabled') ?? data.apps[0] ?? null;
  const satisfied = [true, hasApp, activeAgents.length > 0, boundApp !== null];

  const copy = {
    en: {
      title: `Get started with ${PRODUCT_NAME}`,
      subtitle: 'Four guided steps connect Feishu, an agent, and your first live bot.',
      steps: ['Welcome', 'Connect Feishu', 'Create an agent', 'Go live'],
      back: 'Back',
      next: 'Next',
      skip: 'Skip to console',
      openConsole: 'Open console',
      welcomeLead:
        'OpenClaudeTag turns a Feishu group into an AI engineering workspace. This wizard walks you through connecting a Feishu bot, creating an agent, and going live — all on this machine.',
      runtimeCheck: 'Runtime check',
      apiReachable: 'Local API reachable',
      apiUnreachable: 'Local API not reachable yet',
      feishuAccess: (state: string) => `Feishu access: ${state}`,
      runtimeNote:
        'Runtime credentials (e.g. an Anthropic token) are configured per agent in step 3, so nothing else is required here.',
      feishuLead:
        'Apply for a Feishu bot app and its agent permissions with one click, then scan to confirm. A solo tenant can self-approve the requested scopes.',
      manualToggle: 'Enter an existing app manually',
      manualHint: 'Already have a Feishu app? Register it with its App ID and secret.',
      register: 'Register app',
      permissionTitle: 'Permissions',
      checkPermissions: 'Check & self-approve permissions',
      permissionPass: 'All required permissions granted',
      permissionMissing: 'Missing required scopes',
      requestApproval: 'Request approval',
      approvalSubmitted: 'Approval request submitted',
      selfApprove: 'Open self-approve page',
      feishuDone: (count: number) => `${count} Feishu app${count === 1 ? '' : 's'} connected.`,
      agentLead:
        'Create your first agent. It runs server-local on this machine by default; pick a runtime and (for Claude Code) its credentials.',
      agentExisting: (count: number) =>
        `${count} active agent${count === 1 ? '' : 's'} ready. Create another or continue.`,
      createAgent: 'Create agent',
      goLiveLead: 'Bind an agent to your Feishu bot, then confirm it goes live.',
      bindAgent: 'Agent',
      bind: 'Bind and go live',
      needApp: 'Connect a Feishu app first (step 2).',
      needAgent: 'Create an active agent first (step 3).',
      appNotEnabled: 'Waiting for the Feishu app to finish registering (secret pending).',
      boundTo: (agent: string) => `Bound to ${agent}.`,
      polling: 'Waiting for the bot to come online…',
      live: 'Your bot is live!',
      liveHint: '@mention it in your Feishu group to start a task.',
      goLiveDisabled:
        'Feishu access is disabled on this server. Enable OPEN_TAG_FEISHU_ACCESS and restart, then retry.',
      goLiveTimeout:
        'The bot has not come online yet. Re-check permissions and the binding, then retry.',
      retry: 'Retry',
    },
    zh: {
      title: `快速开始使用 ${PRODUCT_NAME}`,
      subtitle: '四步引导：连接飞书、创建智能体、让第一个机器人上线。',
      steps: ['欢迎', '连接飞书', '创建智能体', '上线'],
      back: '上一步',
      next: '下一步',
      skip: '跳过，进入控制台',
      openConsole: '进入控制台',
      welcomeLead:
        'OpenClaudeTag 把飞书群变成 AI 工程协作工作台。本向导将带你完成接入飞书机器人、创建智能体并上线——全部在本机完成。',
      runtimeCheck: '运行环境检测',
      apiReachable: '本地 API 可达',
      apiUnreachable: '本地 API 暂不可达',
      feishuAccess: (state: string) => `飞书接入：${state}`,
      runtimeNote: '运行时凭证（如 Anthropic token）会在第 3 步按智能体单独配置，这里无需额外设置。',
      feishuLead:
        '一键申请飞书机器人应用及智能体常用权限，然后扫码确认。单租户可自助审批所需 scope。',
      manualToggle: '手动录入已有应用',
      manualHint: '已经有飞书应用？用 App ID 和密钥注册它。',
      register: '注册应用',
      permissionTitle: '权限',
      checkPermissions: '检测并自助审批权限',
      permissionPass: '所需权限已全部开通',
      permissionMissing: '缺少必需 scope',
      requestApproval: '申请审批',
      approvalSubmitted: '已提交审批申请',
      selfApprove: '打开自助审批页',
      feishuDone: (count: number) => `已连接 ${count} 个飞书应用。`,
      agentLead:
        '创建你的第一个智能体。默认在本机以 server-local 方式运行；选择 runtime，并（对 Claude Code）填写凭证。',
      agentExisting: (count: number) => `已有 ${count} 个启用的智能体。可再创建一个或继续。`,
      createAgent: '创建智能体',
      goLiveLead: '把智能体绑定到飞书机器人，然后确认其上线。',
      bindAgent: '智能体',
      bind: '绑定并上线',
      needApp: '请先在第 2 步连接飞书应用。',
      needAgent: '请先在第 3 步创建一个启用的智能体。',
      appNotEnabled: '正在等待飞书应用完成注册（密钥处理中）。',
      boundTo: (agent: string) => `已绑定到 ${agent}。`,
      polling: '正在等待机器人上线…',
      live: '机器人已上线！',
      liveHint: '在飞书群里 @ 它即可发起任务。',
      goLiveDisabled:
        '服务端飞书接入已禁用。请设置 OPEN_TAG_FEISHU_ACCESS 并重启后重试。',
      goLiveTimeout: '机器人尚未上线。请重新检查权限与绑定后重试。',
      retry: '重试',
    },
  }[locale];

  // Welcome step: a best-effort /health snapshot for the runtime check.
  useEffect(() => {
    if (step !== 0) return;
    let cancelled = false;
    void getHealth().then((snapshot) => {
      if (!cancelled) setHealth(snapshot);
    });
    return () => {
      cancelled = true;
    };
  }, [step]);

  // Default the bind agent to the first active agent.
  useEffect(() => {
    if (step === 3 && !bindingAgentId && activeAgents[0]) {
      setBindingAgentId(activeAgents[0].id);
    }
  }, [step, bindingAgentId, activeAgents]);

  // Go-live step: bounded /health poll until the bound app is live, with explicit
  // disabled/timeout terminal states so a first run never hangs forever.
  useEffect(() => {
    if (step !== 3 || !boundApp) {
      setGoLive('idle');
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;
    setGoLive('polling');
    const tick = async () => {
      if (cancelled) return;
      const snapshot = await getHealth();
      if (cancelled) return;
      if (snapshot) setHealth(snapshot);
      const entry = snapshot?.feishu.apps.find((app) => app.appId === boundApp.appId);
      if (entry && entry.wsStatus === 'live' && entry.hasActiveBotBinding) {
        setGoLive('live');
        return;
      }
      const feishuDisabled =
        snapshot?.feishu.websocket === 'disabled' && (!entry || entry.wsStatus === 'disabled');
      if (feishuDisabled) {
        setGoLive('disabled');
        return;
      }
      attempts += 1;
      if (attempts >= GO_LIVE_MAX_ATTEMPTS) {
        setGoLive('timeout');
        return;
      }
      timer = window.setTimeout(() => void tick(), GO_LIVE_POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(() => void tick(), 0);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [step, boundApp?.id, boundApp?.appId, retryNonce]);

  async function runManagedAction(action: () => Promise<void>) {
    setWorking(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  const manualErrors = validateFeishuAppForm(manualApp, locale);

  function registerManualApp() {
    setManualSubmitted(true);
    if (hasValidationErrors(manualErrors)) return;
    void runManagedAction(async () => {
      await createFeishuApp(manualApp);
      await refreshConsole({ showLoading: false });
      setManualApp({ appId: '', appSecret: '', botName: '' });
      setManualSubmitted(false);
    });
  }

  function runPermissionCheck(app: FeishuApp) {
    setPermission({ loading: true });
    void runManagedAction(async () => {
      const result = await checkFeishuAppPermissions(app.id);
      setPermission({ loading: false, result });
    }).catch(() => setPermission({ loading: false }));
  }

  function requestApproval(app: FeishuApp) {
    setPermission((prev) => (prev ? { ...prev, applying: true } : prev));
    void runManagedAction(async () => {
      const applied = await applyFeishuAppPermissions(app.id);
      setPermission((prev) => (prev ? { ...prev, applying: false, applied } : prev));
    });
  }

  function bindAndGoLive() {
    if (!targetApp || !bindingAgentId) return;
    void runManagedAction(async () => {
      await bindBot({ agentId: bindingAgentId, feishuAppId: targetApp.id });
      await refreshConsole({ showLoading: false });
    });
  }

  const progress = (
    <ol className="wizard-progress" aria-label={copy.title}>
      {copy.steps.map((label, index) => {
        const state = index === step ? 'current' : satisfied[index] && index < step ? 'done' : index < step ? 'done' : 'upcoming';
        return (
          <li className={`wizard-progress-step ${state}`} key={label}>
            <span className="wizard-progress-dot">
              {state === 'done' ? <Check size={14} /> : index + 1}
            </span>
            <span className="wizard-progress-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );

  let body: React.ReactNode;
  if (step === 0) {
    const apiReachable = health !== null;
    body = (
      <div className="wizard-step-body">
        <p>{copy.welcomeLead}</p>
        <div className="panel wizard-runtime-card">
          <div className="panel-title">
            <Activity size={18} /> {copy.runtimeCheck}
          </div>
          <div className="wizard-runtime-row">
            <Badge
              value={apiReachable ? 'pass' : 'warning'}
              label={apiReachable ? copy.apiReachable : copy.apiUnreachable}
            />
            {health ? (
              <Badge
                value={health.feishu.websocket === 'live' ? 'pass' : 'default'}
                label={copy.feishuAccess(health.feishu.websocket)}
              />
            ) : null}
          </div>
          <p className="form-note">{copy.runtimeNote}</p>
        </div>
      </div>
    );
  } else if (step === 1) {
    body = (
      <div className="wizard-step-body">
        <p>{copy.feishuLead}</p>
        <FeishuBotOnboardingPanel compact data={data} locale={locale} refreshConsole={refreshConsole} />
        {permissionApp ? (
          <div className="panel wizard-permission-card">
            <div className="panel-title">
              <Shield size={18} /> {copy.permissionTitle}
            </div>
            <div className="inline-actions">
              <button
                className="secondary"
                disabled={working || permission?.loading}
                onClick={() => runPermissionCheck(permissionApp)}
                type="button"
              >
                {permission?.loading ? <Loader2 className="spin" size={16} /> : <Shield size={16} />}
                {copy.checkPermissions}
              </button>
            </div>
            {permission?.result?.status === 'pass' ? (
              <Badge value="pass" label={copy.permissionPass} />
            ) : null}
            {permission?.result?.status === 'fail'
              ? (() => {
                  const scopes = missingRequiredScopeNames(permission.result!);
                  const approvalUrl = buildFeishuPermissionApprovalUrl(permission.result!);
                  return (
                    <div className="wizard-permission-fail">
                      <Badge value="warning" label={copy.permissionMissing} />
                      {scopes.length > 0 ? (
                        <div className="permission-scope-list" aria-label={copy.permissionMissing}>
                          {scopes.map((scope) => (
                            <code className="permission-scope-chip" key={scope}>
                              {scope}
                            </code>
                          ))}
                        </div>
                      ) : null}
                      <div className="inline-actions">
                        <a className="secondary tiny" href={approvalUrl} target="_blank" rel="noreferrer">
                          <ExternalLink size={14} /> {copy.selfApprove}
                        </a>
                        <button
                          className="primary tiny"
                          disabled={working || permission.applying}
                          onClick={() => requestApproval(permissionApp)}
                          type="button"
                        >
                          {permission.applying ? (
                            <Loader2 className="spin" size={14} />
                          ) : (
                            <Shield size={14} />
                          )}
                          {copy.requestApproval}
                        </button>
                      </div>
                      {permission.applied?.submitted ? (
                        <small className="permission-guidance">{copy.approvalSubmitted}</small>
                      ) : null}
                    </div>
                  );
                })()
              : null}
          </div>
        ) : null}
        <details className="wizard-manual">
          <summary>{copy.manualToggle}</summary>
          <p className="form-note">{copy.manualHint}</p>
          <FormGrid>
            <Input
              label="App ID"
              value={manualApp.appId}
              onChange={(appId) => setManualApp({ ...manualApp, appId })}
              required
              error={visibleError(manualErrors, 'appId', manualSubmitted || Boolean(manualApp.appId))}
            />
            <Input
              label={locale === 'zh' ? 'App 密钥' : 'App Secret'}
              type="password"
              value={manualApp.appSecret}
              onChange={(appSecret) => setManualApp({ ...manualApp, appSecret })}
              required
              error={visibleError(manualErrors, 'appSecret', manualSubmitted || Boolean(manualApp.appSecret))}
            />
            <Input
              label={locale === 'zh' ? '机器人名称' : 'Bot Name'}
              value={manualApp.botName}
              onChange={(botName) => setManualApp({ ...manualApp, botName })}
            />
            <div className="inline-actions">
              <button
                className="primary"
                disabled={working || hasValidationErrors(manualErrors)}
                onClick={registerManualApp}
                type="button"
              >
                <Plus size={16} /> {copy.register}
              </button>
            </div>
          </FormGrid>
        </details>
        {hasApp ? <p className="form-note">{copy.feishuDone(data.apps.length)}</p> : null}
      </div>
    );
  } else if (step === 2) {
    body = (
      <div className="wizard-step-body">
        <p>{copy.agentLead}</p>
        {activeAgents.length > 0 ? (
          <p className="form-note">{copy.agentExisting(activeAgents.length)}</p>
        ) : null}
        <AgentCreateForm
          data={data}
          locale={locale}
          canUseComputer={canUseComputer}
          busy={working}
          hideMachineSelect={personalMode}
          submitLabel={copy.createAgent}
          onSubmit={(payload) =>
            void runManagedAction(async () => {
              await createAgent(payload);
              await refreshConsole({ showLoading: false });
              setStep(3);
            })
          }
        />
      </div>
    );
  } else {
    const liveBadge =
      goLive === 'live'
        ? null
        : goLive === 'disabled'
          ? <div className="alert error">{copy.goLiveDisabled}</div>
          : goLive === 'timeout'
            ? <div className="alert error">{copy.goLiveTimeout}</div>
            : boundApp
              ? (
                <div className="wizard-live-pending">
                  <Loader2 className="spin" size={16} /> {copy.polling}
                </div>
              )
              : null;
    body = (
      <div className="wizard-step-body">
        <p>{copy.goLiveLead}</p>
        {!hasApp ? (
          <p className="form-note">{copy.needApp}</p>
        ) : activeAgents.length === 0 ? (
          <p className="form-note">{copy.needAgent}</p>
        ) : boundApp ? (
          <div className="panel wizard-live-card">
            <div className="panel-title">
              <Link2 size={18} /> {boundApp.botName ?? boundApp.appId}
            </div>
            <p className="form-note">{copy.boundTo(boundApp.binding?.agentDisplayName ?? '')}</p>
            {goLive === 'live' ? (
              <div className="wizard-live-success">
                <div className="panel-title">
                  <Rocket size={18} /> {copy.live}
                </div>
                <p>{copy.liveHint}</p>
              </div>
            ) : null}
            {liveBadge}
            {goLive === 'timeout' || goLive === 'disabled' ? (
              <div className="inline-actions">
                <button
                  className="secondary"
                  onClick={() => setRetryNonce((nonce) => nonce + 1)}
                  type="button"
                >
                  <RefreshCcw size={16} /> {copy.retry}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <FormGrid>
            <Input
              label={locale === 'zh' ? '机器人' : 'Bot'}
              value={targetApp ? `${targetApp.botName ?? targetApp.appId} (${targetApp.appId})` : ''}
              disabled
            />
            <Select
              label={copy.bindAgent}
              value={bindingAgentId}
              onChange={setBindingAgentId}
              options={activeAgents.map((agent) => agent.id)}
              labels={Object.fromEntries(activeAgents.map((agent) => [agent.id, agent.displayName]))}
              required
            />
            {targetApp && targetApp.status !== 'enabled' ? (
              <p className="form-note">{copy.appNotEnabled}</p>
            ) : null}
            <div className="inline-actions">
              <button
                className="primary"
                disabled={
                  working || !targetApp || targetApp.status !== 'enabled' || !bindingAgentId
                }
                onClick={bindAndGoLive}
                type="button"
              >
                <Link2 size={16} /> {copy.bind}
              </button>
            </div>
          </FormGrid>
        )}
      </div>
    );
  }

  const isLastStep = step === 3;
  const canAdvance = satisfied[step];

  return (
    <div className="onboarding-stack">
      <section className="panel onboarding-hero">
        <div className="overview-hero-icon">
          <img aria-hidden="true" src={PRODUCT_ICON_SRC} alt="" />
        </div>
        <div>
          <div className="panel-title">
            <Compass size={18} /> {copy.title}
          </div>
          <p className="panel-subtitle">{copy.subtitle}</p>
        </div>
      </section>

      {progress}

      <section className="panel onboarding-panel">
        {error ? <div className="alert error">{error}</div> : null}
        {body}
      </section>

      <div className="onboarding-footer">
        <button
          className="secondary"
          disabled={step === 0}
          onClick={() => setStep((current) => Math.max(0, current - 1))}
          type="button"
        >
          <ArrowLeft size={16} /> {copy.back}
        </button>
        <button className="ghost wizard-skip" onClick={onExitToConsole} type="button">
          {copy.skip}
        </button>
        {isLastStep ? (
          <button
            className="primary"
            disabled={goLive !== 'live'}
            onClick={onExitToConsole}
            type="button"
          >
            {copy.openConsole} <ArrowRight size={16} />
          </button>
        ) : (
          <button
            className="primary"
            disabled={!canAdvance}
            onClick={() => setStep((current) => Math.min(3, current + 1))}
            type="button"
          >
            {copy.next} <ArrowRight size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function Overview({
  data,
  locale,
  onOpenBots,
  refreshConsole,
}: {
  data: ConsoleData;
  locale: Locale;
  onOpenBots: () => void;
  refreshConsole: RefreshConsole;
}) {
  const copy = {
    en: {
      eyebrow: PRODUCT_FULL_NAME,
      title: 'A Feishu-native workspace for AI engineering collaboration.',
      intro:
        'OpenClaudeTag connects machines, agent profiles, Feishu bot identities, and group chats. Operators prepare the runtime here, then teammates collaborate directly in Feishu while OpenClaudeTag routes work to the right agent and keeps task status visible.',
      statusTitle: 'Current Status',
    },
    zh: {
      eyebrow: `${PRODUCT_NAME} 控制台`,
      title: '面向飞书群协作的 AI 工程工作台。',
      intro:
        'OpenClaudeTag 串联执行机器、智能体配置、飞书机器人身份和群聊。运维人员在这里完成运行环境和身份绑定，团队成员则直接在飞书群里协作，系统会把工作路由到合适的 agent，并持续回传任务状态。',
      statusTitle: '当前状态',
    },
  }[locale];
  const machineStatusPercent =
    data.summary.machines > 0
      ? Math.round((data.summary.onlineMachines / data.summary.machines) * 100)
      : 0;

  return (
    <div className="overview-stack">
      <section className="panel overview-hero">
        <div className="overview-hero-copy">
          <div className="overview-hero-icon">
            <img aria-hidden="true" src={PRODUCT_ICON_SRC} alt="" />
          </div>
          <div>
            <div className="panel-title">
              <Home size={18} /> {copy.eyebrow}
            </div>
            <h2>{copy.title}</h2>
            <p>{copy.intro}</p>
          </div>
        </div>
        <div className="overview-hero-stats" aria-label={copy.statusTitle}>
          <span>{copy.statusTitle}</span>
          <strong>{uiText[locale].summary(data.summary.activeAgents, data.summary.botBindings)}</strong>
          <small>
            {locale === 'zh'
              ? `${data.summary.onlineMachines}/${data.summary.machines} 台机器在线`
              : `${data.summary.onlineMachines}/${data.summary.machines} machines online`}
          </small>
          <div
            className="overview-status-meter"
            aria-label={
              locale === 'zh'
                ? `机器在线进度 ${machineStatusPercent}%`
                : `Machine online progress ${machineStatusPercent}%`
            }
          >
            <span style={{ width: `${machineStatusPercent}%` }} />
          </div>
        </div>
      </section>

      <FeishuBotOnboardingPanel
        data={data}
        locale={locale}
        onOpenBots={onOpenBots}
        refreshConsole={refreshConsole}
      />
    </div>
  );
}

function FeishuBotOnboardingPanel({
  data,
  locale,
  refreshConsole,
  onOpenBots,
  compact = false,
}: {
  data: ConsoleData;
  locale: Locale;
  refreshConsole: RefreshConsole;
  onOpenBots?: () => void;
  compact?: boolean;
}) {
  const [registration, setRegistration] = useState<FeishuAppRegistration | null>(null);
  const [registrationBusy, setRegistrationBusy] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [botName, setBotName] = useState('');
  const registrationInFlightRef = useRef(false);
  const copy = {
    en: {
      title: 'Feishu Bot Setup',
      subtitle: 'Create a bot app with the required agent permissions, then bind it to an agent.',
      namePlaceholder: 'OpenClaudeTag Bot',
      start: 'Apply Bot And Scopes',
      starting: 'Preparing Link',
      open: 'Open Feishu',
      cancel: 'Cancel',
      retry: 'Retry',
      goBots: 'Open Bots',
      pending: 'Waiting for scan confirmation',
      completed: 'Bot app registered',
      failed: 'Registration failed',
      cancelled: 'Registration cancelled',
      expired: 'Registration expired',
      manual: compact
        ? 'Use the + button below for manual registration.'
        : 'Manual registration remains available in Bots.',
      expires: (time: string) => `Expires ${time}`,
      appLine: (appId: string) => `Registered app: ${appId}`,
    },
    zh: {
      title: '飞书机器人接入',
      subtitle: '一键申请机器人应用和智能体常用权限，然后绑定到 agent。',
      namePlaceholder: 'OpenClaudeTag 机器人',
      start: '一键申请机器人和权限',
      starting: '正在生成链接',
      open: '打开飞书',
      cancel: '取消',
      retry: '重试',
      goBots: '打开机器人页',
      pending: '等待扫码确认',
      completed: '机器人应用已注册',
      failed: '注册失败',
      cancelled: '注册已取消',
      expired: '注册已过期',
      manual: compact ? '下方 + 按钮仍可手动注册。' : '机器人页仍可手动注册。',
      expires: (time: string) => `${time} 过期`,
      appLine: (appId: string) => `已注册应用：${appId}`,
    },
  }[locale];
  const registrationTerminal =
    registration?.status === 'completed' ||
    registration?.status === 'failed' ||
    registration?.status === 'expired' ||
    registration?.status === 'cancelled';
  const registrationStatusLabel = registration
    ? registration.status === 'pending'
      ? copy.pending
      : registration.status === 'completed'
        ? copy.completed
        : registration.status === 'expired'
          ? copy.expired
          : registration.status === 'cancelled'
            ? copy.cancelled
            : copy.failed
    : null;

  useEffect(() => {
    if (!registration || registration.status !== 'pending') return;
    let cancelled = false;
    let pollTimer: number | undefined;
    const schedulePoll = () => {
      pollTimer = window.setTimeout(() => void poll(), 1500);
    };
    const poll = async () => {
      try {
        const next = await getFeishuAppRegistration(registration.id);
        if (cancelled) return;
        setRegistration(next);
        if (next.status === 'completed') {
          void refreshConsole({ showLoading: false }).catch((err) => {
            if (!cancelled) setRegistrationError((err as Error).message);
          });
        }
        if (next.status === 'pending') {
          schedulePoll();
        }
      } catch (err) {
        if (cancelled) return;
        const message = (err as Error).message;
        setRegistration((current) =>
          current
            ? {
                ...current,
                status: 'failed',
                error: message,
                updatedAt: new Date().toISOString(),
              }
            : current,
        );
        setRegistrationError(null);
      }
    };
    schedulePoll();
    return () => {
      cancelled = true;
      if (pollTimer) window.clearTimeout(pollTimer);
    };
  }, [refreshConsole, registration]);

  async function startRegistration() {
    if (registrationInFlightRef.current) return;
    registrationInFlightRef.current = true;
    setRegistrationBusy(true);
    setRegistrationError(null);
    try {
      const selectedBotName = botName.trim() || copy.namePlaceholder;
      const next = await startFeishuAppRegistration({
        botName: selectedBotName,
        description:
          locale === 'zh'
            ? 'OpenClaudeTag 飞书群协作 AI 工程助手'
            : 'OpenClaudeTag AI engineering assistant for Feishu collaboration',
      });
      setRegistration(next);
    } catch (err) {
      setRegistrationError((err as Error).message);
    } finally {
      registrationInFlightRef.current = false;
      setRegistrationBusy(false);
    }
  }

  async function cancelRegistration() {
    if (!registration) return;
    if (registrationInFlightRef.current) return;
    registrationInFlightRef.current = true;
    setRegistrationBusy(true);
    setRegistrationError(null);
    try {
      setRegistration(await cancelFeishuAppRegistration(registration.id));
    } catch (err) {
      setRegistrationError((err as Error).message);
    } finally {
      registrationInFlightRef.current = false;
      setRegistrationBusy(false);
    }
  }

  return (
    <section className={`panel bot-onboarding-panel${compact ? ' compact' : ''}`}>
      <div className="panel-heading">
        <div>
          <div className="panel-title">
            <QrCode size={18} /> {copy.title}
          </div>
          <p className="panel-subtitle">{copy.subtitle}</p>
        </div>
        <div className="bot-onboarding-actions">
          <Input
            label={locale === 'zh' ? '机器人名称' : 'Bot Name'}
            value={botName}
            onChange={setBotName}
            placeholder={copy.namePlaceholder}
            disabled={registrationBusy || registration?.status === 'pending'}
          />
        <button
          className="primary"
          disabled={registrationBusy || registration?.status === 'pending'}
          onClick={() => void startRegistration()}
          type="button"
        >
          {registrationBusy && !registration ? (
            <Loader2 className="spin" size={16} />
          ) : (
            <QrCode size={16} />
          )}
          {registrationBusy && !registration ? copy.starting : copy.start}
        </button>
        </div>
      </div>

      {compact ? null : (
        <div className="bot-onboarding-status-grid">
          <div className="counter">
            <span>{locale === 'zh' ? '飞书应用' : 'Feishu Apps'}</span>
            <strong>{data.summary.feishuApps}</strong>
          </div>
          <div className="counter">
            <span>{locale === 'zh' ? '已启用' : 'Enabled'}</span>
            <strong>{data.summary.enabledFeishuApps}</strong>
          </div>
          <div className="counter">
            <span>{locale === 'zh' ? '已绑定' : 'Bound'}</span>
            <strong>{data.summary.botBindings}</strong>
          </div>
        </div>
      )}

      {registration ? (
        <div className="bot-registration-card">
          <div>
            <Badge
              value={registration.status === 'completed' ? 'pass' : registration.status}
              label={registrationStatusLabel ?? registration.status}
            />
            <small>{copy.expires(new Date(registration.expiresAt).toLocaleTimeString())}</small>
            {registration.app ? <p>{copy.appLine(registration.app.appId)}</p> : null}
            {registration.error ? <p className="form-error">{registration.error}</p> : null}
          </div>
          <div className="inline-actions">
            {registration.status === 'pending' ? (
              <>
                <a
                  className="primary"
                  href={registration.verificationUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink size={16} /> {copy.open}
                </a>
                <button
                  className="secondary"
                  disabled={registrationBusy}
                  onClick={() => void cancelRegistration()}
                  type="button"
                >
                  {registrationBusy ? <Loader2 className="spin" size={16} /> : <X size={16} />}
                  {copy.cancel}
                </button>
              </>
            ) : null}
            {registrationTerminal ? (
              <>
                <button
                  className="secondary"
                  disabled={registrationBusy}
                  onClick={() => void startRegistration()}
                  type="button"
                >
                  {registrationBusy ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <RefreshCcw size={16} />
                  )}
                  {copy.retry}
                </button>
                {onOpenBots ? (
                  <button className="primary" onClick={onOpenBots} type="button">
                    <Bot size={16} /> {copy.goBots}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="form-note">{copy.manual}</p>
      )}
      {registrationError ? <p className="form-error">{registrationError}</p> : null}
    </section>
  );
}

function ownerLabel(
  owner: { email: string | null; displayName: string | null } | null,
  locale: Locale,
): string {
  if (!owner) return locale === 'zh' ? 'ops/旧数据' : 'ops/legacy';
  return owner.displayName ?? owner.email ?? (locale === 'zh' ? '未知' : 'unknown');
}

/**
 * Machine select options for the agent forms (design D-A8), shared by
 * {@link AgentCreateForm} and the {@link AgentsView} edit path so the
 * "Server-local + owned machines" list has a single source of truth. Server-local
 * is the only permission-gated choice (it needs computer access); binding to an
 * owned machine is open to every user.
 */
function buildAgentMachineOptions(
  machines: Machine[],
  canUseComputer: boolean,
  locale: Locale,
): { options: string[]; labels: Record<string, string>; defaultValue: string } {
  const serverLocalLabel = locale === 'zh' ? '本机(服务器)' : 'Server-local';
  const bindable = machines.filter((machine) => machine.status !== 'revoked');
  const options = [
    ...(canUseComputer ? [SERVER_LOCAL_MACHINE_VALUE] : []),
    ...bindable.map((machine) => machine.id),
  ];
  const labels: Record<string, string> = {
    ...(canUseComputer ? { [SERVER_LOCAL_MACHINE_VALUE]: serverLocalLabel } : {}),
    ...Object.fromEntries(
      bindable.map((machine) => [machine.id, `${machine.name} · ${statusLabel(machine.status, locale)}`]),
    ),
  };
  const defaultValue = canUseComputer ? SERVER_LOCAL_MACHINE_VALUE : bindable[0]?.id ?? '';
  return { options, labels, defaultValue };
}

// ── Onboarding wizard state ────────────────────────────────────────────────────
// Personal mode auto-launches the first-run wizard. Completion is derived from
// console data (an enabled Feishu app with an active binding) and confirmed live
// against /health; a localStorage flag records an explicit "skip to console" so a
// user who dismissed it is not re-routed on every load.
const ONBOARDING_DISMISSED_KEY = 'open-claude-tag.console.onboardingDismissed';

function readOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOnboardingDismissed(value: boolean): void {
  try {
    if (value) localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
    else localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
  } catch {
    // Best-effort persistence; non-fatal when localStorage is unavailable.
  }
}

/** The first enabled Feishu app that already carries an active bot binding. */
function activeBoundFeishuApp(data: ConsoleData): FeishuApp | null {
  return (
    data.apps.find((app) => app.status === 'enabled' && app.binding?.status === 'active') ?? null
  );
}

/**
 * Structural onboarding completion: at least one enabled Feishu app with an active
 * binding exists. Stronger than "any binding" so a disabled/half-bound app does
 * not count as done. The wizard's go-live step additionally confirms the bound app
 * is live on /health before declaring success.
 */
function isOnboardingComplete(data: ConsoleData): boolean {
  return activeBoundFeishuApp(data) !== null;
}

/** True when a specific Feishu app's /health entry is live with an active binding. */
function isFeishuAppLive(health: HealthSummary | null, appId: string): boolean {
  if (!health) return false;
  const entry = health.feishu.apps.find((app) => app.appId === appId);
  return Boolean(entry && entry.wsStatus === 'live' && entry.hasActiveBotBinding);
}

/**
 * The create-agent form body, extracted from {@link AgentsView} so the onboarding
 * wizard reuses the exact same fields, validation, and Claude-credential
 * assembly without duplicating that logic. It OWNS its own form state and emits a
 * ready {@link createAgent} payload through `onSubmit`; the host performs the side
 * effects (AgentsView wraps it in `runAction` + refresh; the wizard creates then
 * advances). `hideMachineSelect` forces server-local for the personal wizard.
 */
function AgentCreateForm({
  data,
  locale,
  canUseComputer,
  busy,
  hideMachineSelect = false,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  data: ConsoleData;
  locale: Locale;
  canUseComputer: boolean;
  busy: boolean;
  hideMachineSelect?: boolean;
  submitLabel?: string;
  onCancel?: () => void;
  onSubmit: (payload: Parameters<typeof createAgent>[0]) => void;
}) {
  const t = uiText[locale];
  const {
    options: machineOptions,
    labels: machineLabels,
    defaultValue: defaultMachineValue,
  } = buildAgentMachineOptions(data.machines, canUseComputer, locale);
  const [form, setForm] = useState({
    displayName: '',
    description: '',
    systemPrompt: '',
    defaultRuntime: '',
    defaultModel: '',
    runtimeEnv: '',
    claudeAuthMode: 'subscription' as ClaudeAuthMode,
    claudeBaseUrl: '',
    claudeApiKey: '',
    machineId: defaultMachineValue,
  });
  const [submitted, setSubmitted] = useState(false);
  const displayNameLabel = locale === 'zh' ? '名称' : 'Name';
  const machineFieldLabel = locale === 'zh' ? '执行机器' : 'Machine';
  const effectiveMachineId = hideMachineSelect ? defaultMachineValue : form.machineId;
  const errors = validateAgentForm(
    {
      displayName: form.displayName,
      defaultRuntime: form.defaultRuntime,
      machineId: effectiveMachineId,
    },
    {
      locale,
      machineOptions: hideMachineSelect ? [defaultMachineValue] : machineOptions,
      displayNameLabel,
      machineLabel: machineFieldLabel,
    },
  );
  const claudeErrors = claudeCredentialFieldErrors(
    form.defaultRuntime,
    form.claudeAuthMode,
    form.claudeBaseUrl,
    form.claudeApiKey,
    'create',
    locale,
  );
  const blocked = hasValidationErrors(errors) || hasFieldErrors(claudeErrors);

  function submit() {
    setSubmitted(true);
    if (blocked) return;
    const defaultRuntime = form.defaultRuntime || null;
    const displayName = form.displayName.trim();
    let runtimeEnv = parseRuntimeEnv(form.runtimeEnv);
    if (defaultRuntime === 'claude_code') {
      if (form.claudeAuthMode === 'subscription') {
        runtimeEnv = withoutClaudeCredentialKeys(runtimeEnv);
      } else {
        if (form.claudeBaseUrl.trim())
          runtimeEnv[CLAUDE_BASE_URL_ENV_KEY] = form.claudeBaseUrl.trim();
        if (form.claudeApiKey.trim())
          runtimeEnv[CLAUDE_API_KEY_ENV_KEY] = form.claudeApiKey.trim();
      }
    }
    onSubmit({
      displayName,
      description: nullableText(form.description),
      defaultRuntime,
      runtimeEnv,
      // null = server-local (design D-A8).
      machineId: effectiveMachineId || null,
      profile: {
        displayName,
        description: nullableText(form.description),
        systemPrompt: nullableText(form.systemPrompt),
        stylePrompt: null,
        defaultRuntime,
        defaultModel: nullableText(form.defaultModel),
      },
    });
  }

  return (
    <FormGrid>
      <Input
        label={displayNameLabel}
        value={form.displayName}
        onChange={(displayName) => setForm({ ...form, displayName })}
        required
        error={visibleError(errors, 'displayName', submitted || Boolean(form.displayName))}
      />
      <Input
        label={locale === 'zh' ? '描述' : 'Description'}
        value={form.description}
        onChange={(description) => setForm({ ...form, description })}
      />
      <TextArea
        label={locale === 'zh' ? '系统提示词' : 'System Prompt'}
        value={form.systemPrompt}
        placeholder={SYSTEM_PROMPT_PLACEHOLDER}
        onChange={(systemPrompt) => setForm({ ...form, systemPrompt })}
      />
      <Select
        label="Runtime"
        value={form.defaultRuntime}
        onChange={(defaultRuntime) => setForm({ ...form, defaultRuntime })}
        options={AGENT_RUNTIME_OPTIONS}
        labels={{ '': t.common.none, ...RUNTIME_DISPLAY_NAMES }}
        error={visibleError(errors, 'defaultRuntime', submitted)}
      />
      <Input
        label={locale === 'zh' ? '模型' : 'Model'}
        value={form.defaultModel}
        onChange={(defaultModel) => setForm({ ...form, defaultModel })}
        placeholder={
          locale === 'zh'
            ? '可选，如 kimi-k2 / gpt-5.2 / gemini-3-pro'
            : 'optional, e.g. kimi-k2 / gpt-5.2 / gemini-3-pro'
        }
      />
      {form.defaultRuntime === 'claude_code' ? (
        <>
          <div className="field">
            <span>{locale === 'zh' ? 'Claude 登录方式' : 'Claude auth'}</span>
            <div
              className="segmented-control claude-auth-toggle"
              aria-label={locale === 'zh' ? 'Claude 登录方式' : 'Claude auth mode'}
            >
              {(['subscription', 'custom'] as ClaudeAuthMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={form.claudeAuthMode === mode}
                  className={form.claudeAuthMode === mode ? 'active' : ''}
                  onClick={() =>
                    setForm({
                      ...form,
                      claudeAuthMode: mode,
                      ...(mode === 'subscription' ? { claudeBaseUrl: '', claudeApiKey: '' } : {}),
                    })
                  }
                >
                  {claudeAuthModeLabel(mode, locale)}
                </button>
              ))}
            </div>
          </div>
          {form.claudeAuthMode === 'custom' ? (
            <>
              <Input
                label={locale === 'zh' ? 'API 接入地址 (Base URL)' : 'API Base URL'}
                value={form.claudeBaseUrl}
                onChange={(claudeBaseUrl) => setForm({ ...form, claudeBaseUrl })}
                placeholder="https://api.anthropic.com"
                required
                error={submitted ? claudeErrors.baseUrl : undefined}
              />
              <Input
                label={locale === 'zh' ? 'API 密钥 (API Key)' : 'API Key'}
                value={form.claudeApiKey}
                onChange={(claudeApiKey) => setForm({ ...form, claudeApiKey })}
                type="password"
                required
                error={submitted ? claudeErrors.apiKey : undefined}
              />
            </>
          ) : null}
        </>
      ) : null}
      <TextArea
        label="Env"
        value={form.runtimeEnv}
        placeholder="KEY=value"
        onChange={(runtimeEnv) => setForm({ ...form, runtimeEnv })}
      />
      {hideMachineSelect ? null : (
        <Select
          label={machineFieldLabel}
          value={form.machineId}
          onChange={(machineId) => setForm({ ...form, machineId })}
          options={machineOptions}
          labels={machineLabels}
          error={visibleError(errors, 'machineId', submitted)}
        />
      )}
      <div className="inline-actions">
        {onCancel ? (
          <button className="secondary" disabled={busy} onClick={onCancel} type="button">
            {t.actions.cancel}
          </button>
        ) : null}
        <button className="primary" disabled={busy || blocked} onClick={submit} type="button">
          <Plus size={16} /> {submitLabel ?? (locale === 'zh' ? '创建智能体' : 'Create Agent')}
        </button>
      </div>
    </FormGrid>
  );
}

function AgentsView({
  data,
  busy,
  locale,
  runAction,
  isSuperadmin,
  canUseComputer,
}: {
  data: ConsoleData;
  busy: boolean;
  locale: Locale;
  runAction: (label: string, action: () => Promise<unknown>) => Promise<void>;
  isSuperadmin: boolean;
  canUseComputer: boolean;
}) {
  const t = uiText[locale];
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const [agentEdit, setAgentEdit] = useState({
    displayName: '',
    description: '',
    systemPrompt: '',
    defaultRuntime: '',
    defaultModel: '',
    runtimeEnv: '',
    claudeAuthMode: 'subscription' as ClaudeAuthMode,
    claudeBaseUrl: '',
    claudeApiKey: '',
    clearRuntimeEnv: false,
    memoryEnabled: true,
    status: 'active',
    machineId: SERVER_LOCAL_MACHINE_VALUE,
  });
  const [agentEditSubmitted, setAgentEditSubmitted] = useState(false);
  const profileById = useMemo(
    () => new Map(data.profiles.map((profile) => [profile.id, profile])),
    [data.profiles],
  );

  // Machine selector (design D-A8): "server-local" + the owner's non-revoked
  // machines. data.machines is already platform-owner scoped by the admin API.
  const serverLocalLabel = locale === 'zh' ? '本机(服务器)' : 'Server-local';
  const bindableMachines = useMemo(
    () => data.machines.filter((machine) => machine.status !== 'revoked'),
    [data.machines],
  );
  const machineById = useMemo(
    () => new Map(data.machines.map((machine) => [machine.id, machine])),
    [data.machines],
  );
  // The server-local option is the only permission-gated choice: binding to an
  // owned machine is open to every user; running on the server requires the
  // admin-managed computer-access allowlist. Shared with the create form via
  // buildAgentMachineOptions so both surfaces stay in lock-step.
  const { options: agentMachineOptions, labels: agentMachineLabels } = buildAgentMachineOptions(
    data.machines,
    canUseComputer,
    locale,
  );
  // When editing an agent bound to a now-revoked machine, keep that value selectable
  // (read-only style) so the operator sees why and can revert it to server-local.
  function machineSelectFor(currentMachineId: string): {
    options: string[];
    labels: Record<string, string>;
  } {
    if (currentMachineId && !bindableMachines.some((machine) => machine.id === currentMachineId)) {
      const stale = machineById.get(currentMachineId);
      const staleLabel = stale
        ? `${stale.name} (${statusLabel('revoked', locale)})`
        : currentMachineId;
      return {
        options: [...agentMachineOptions, currentMachineId],
        labels: { ...agentMachineLabels, [currentMachineId]: staleLabel },
      };
    }
    return { options: agentMachineOptions, labels: agentMachineLabels };
  }
  const machineFieldLabel = locale === 'zh' ? '执行机器' : 'Machine';
  // Single user-facing name (maps to displayName). The internal handle is now
  // derived server-side and never shown or entered.
  const agentDisplayNameLabel = locale === 'zh' ? '名称' : 'Name';

  // Group agents by their machine binding for the registry (design D-A8). Each
  // bound machine becomes a section; unbound agents fall under "Server-local".
  // Stable order: server-local first, then machines by name.
  const agentGroups = useMemo(() => {
    const byMachine = new Map<string, Agent[]>();
    for (const agent of data.agents) {
      const key = agent.machineId ?? SERVER_LOCAL_MACHINE_VALUE;
      const bucket = byMachine.get(key);
      if (bucket) bucket.push(agent);
      else byMachine.set(key, [agent]);
    }
    const groups: Array<{ key: string; title: string; status: string | null; agents: Agent[] }> = [];
    if (byMachine.has(SERVER_LOCAL_MACHINE_VALUE)) {
      groups.push({
        key: SERVER_LOCAL_MACHINE_VALUE,
        title: serverLocalLabel,
        status: null,
        agents: byMachine.get(SERVER_LOCAL_MACHINE_VALUE)!,
      });
    }
    const machineKeys = [...byMachine.keys()].filter((key) => key !== SERVER_LOCAL_MACHINE_VALUE);
    machineKeys.sort((a, b) => {
      const an = machineById.get(a)?.name ?? a;
      const bn = machineById.get(b)?.name ?? b;
      return an.localeCompare(bn);
    });
    for (const key of machineKeys) {
      const agentsForMachine = byMachine.get(key)!;
      const machine = machineById.get(key) ?? agentsForMachine[0]?.machine ?? null;
      groups.push({
        key,
        title: machine?.name ?? key,
        status: machine?.status ?? null,
        agents: agentsForMachine,
      });
    }
    return groups;
  }, [data.agents, machineById, serverLocalLabel]);
  const editingAgent = useMemo(
    () => data.agents.find((agent) => agent.id === editingAgentId) ?? null,
    [data.agents, editingAgentId],
  );
  const deletingAgent = useMemo(
    () => data.agents.find((agent) => agent.id === deletingAgentId) ?? null,
    [data.agents, deletingAgentId],
  );

  function openAgentEditor(agent: Agent) {
    const profile = profileById.get(agent.profileId) ?? null;
    const existingClaudeAuthMode = hasClaudeCredentialKeys(agent.runtimeEnvKeys)
      ? 'custom'
      : 'subscription';
    setEditingAgentId(agent.id);
    setAgentEditSubmitted(false);
    setAgentEdit({
      displayName: agent.displayName,
      description: agent.description ?? '',
      systemPrompt: unifiedProfileSystemPrompt(profile),
      defaultRuntime: visibleRuntimeValue(agent.defaultRuntime ?? profile?.defaultRuntime),
      defaultModel: profile?.defaultModel ?? '',
      runtimeEnv: '',
      claudeAuthMode: existingClaudeAuthMode,
      // Secrets are write-only over the API (only key names are returned), so the
      // credential fields start blank — leave them blank to keep existing values.
      claudeBaseUrl: '',
      claudeApiKey: '',
      clearRuntimeEnv: false,
      memoryEnabled: agent.memoryEnabled,
      status: agent.status,
      machineId: agent.machineId ?? SERVER_LOCAL_MACHINE_VALUE,
    });
  }

  function closeAgentEditor() {
    setEditingAgentId(null);
    setAgentEditSubmitted(false);
  }

  function closeAgentCreator() {
    // AgentCreateForm owns its own state and is unmounted on close, so a fresh
    // form is created on the next open — no explicit reset needed here.
    setIsCreatingAgent(false);
  }

  const editMachineSelect = editingAgent
    ? machineSelectFor(agentEdit.machineId)
    : { options: agentMachineOptions, labels: agentMachineLabels };
  const agentEditErrors = validateAgentForm(
    {
      displayName: agentEdit.displayName,
      defaultRuntime: agentEdit.defaultRuntime,
      machineId: agentEdit.machineId,
      status: agentEdit.status,
    },
    {
      locale,
      machineOptions: editMachineSelect.options,
      displayNameLabel: agentDisplayNameLabel,
      machineLabel: machineFieldLabel,
      statusLabel: locale === 'zh' ? '状态' : 'Status',
    },
  );
  const agentEditHasExistingClaudeKeys = editingAgent
    ? hasClaudeCredentialKeys(editingAgent.runtimeEnvKeys)
    : false;
  const agentEditReplacesRuntimeEnv =
    agentEdit.clearRuntimeEnv ||
    agentEdit.runtimeEnv.trim().length > 0 ||
    (agentEdit.defaultRuntime === 'claude_code' &&
      agentEdit.claudeAuthMode === 'subscription' &&
      agentEditHasExistingClaudeKeys) ||
    // Claude credential fields only contribute when the (effective) runtime is
    // claude_code; otherwise switching an agent away from claude_code while the
    // now-hidden fields hold stale text would wrongly demand re-entry on save.
    (agentEdit.defaultRuntime === 'claude_code' &&
      agentEdit.claudeAuthMode === 'custom' &&
      (agentEdit.claudeBaseUrl.trim().length > 0 || agentEdit.claudeApiKey.trim().length > 0));
  const agentEditClaudeErrors = claudeCredentialFieldErrors(
    agentEdit.defaultRuntime,
    agentEdit.claudeAuthMode,
    agentEdit.claudeBaseUrl,
    agentEdit.claudeApiKey,
    'edit',
    locale,
    {
      hasExistingClaudeKeys: agentEditHasExistingClaudeKeys,
      replacesRuntimeEnv: agentEditReplacesRuntimeEnv,
    },
  );

  return (
    <>
    <section className="panel">
        <div className="panel-heading">
          <div className="panel-title"><UserRound size={18} /> {locale === 'zh' ? '智能体注册表' : 'Agent Registry'}</div>
          <button
            aria-label={locale === 'zh' ? '创建智能体' : 'Create Agent'}
            className="icon-button"
            disabled={busy}
            onClick={() => setIsCreatingAgent(true)}
            title={locale === 'zh' ? '创建智能体' : 'Create Agent'}
            type="button"
          >
            <Plus size={16} />
          </button>
        </div>
        {agentGroups.length === 0 ? (
          <p className="form-note">{locale === 'zh' ? '未找到智能体' : 'No agents found'}</p>
        ) : (
          // Group agents by their execution machine (design D-A8): a section per
          // machine + a "Server-local" section for unbound agents.
          agentGroups.map((group) => (
            <div className="agent-machine-group" key={group.key || 'server-local'}>
              <div className="agent-machine-group-header">
                <Laptop size={14} />
                <span>{group.title}</span>
                {group.status ? (
                  <Badge value={group.status} label={statusLabel(group.status, locale)} />
                ) : null}
                <small>
                  {locale === 'zh'
                    ? `${group.agents.length} 个智能体`
                    : `${group.agents.length} agent${group.agents.length === 1 ? '' : 's'}`}
                </small>
              </div>
              <DataTable
                columns={[
                  locale === 'zh' ? '智能体' : 'Agent',
                  'Runtime',
                  ...(isSuperadmin ? [locale === 'zh' ? '所有者' : 'Owner'] : []),
                  locale === 'zh' ? '状态' : 'Status',
                  '',
                ]}
                rowKeys={group.agents.map((agent) => agent.id)}
                rows={group.agents.map((agent) => {
                  const profile = profileById.get(agent.profileId);
                  return [
                    <strong key="agent">{agent.displayName}<small>{agent.description ?? t.common.noDescription}</small></strong>,
                    runtimeLabel(agent.defaultRuntime ?? profile?.defaultRuntime ?? null, locale),
                    ...(isSuperadmin
                      ? [<span key="owner">{ownerLabel(agent.platformOwner, locale)}</span>]
                      : []),
                    <Badge key="status" value={agent.status} label={statusLabel(agent.status, locale)} />,
                    <div className="inline-actions row-actions" key="actions">
                      <button
                        aria-label={`${locale === 'zh' ? '编辑' : 'Edit'} ${agent.displayName}`}
                        className="icon-button"
                        disabled={busy}
                        onClick={() => openAgentEditor(agent)}
                        title={locale === 'zh' ? '编辑智能体' : 'Edit agent'}
                        type="button"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        aria-label={`${locale === 'zh' ? '删除' : 'Delete'} ${agent.displayName}`}
                        className="icon-button danger"
                        disabled={busy}
                        onClick={() => setDeletingAgentId(agent.id)}
                        title={locale === 'zh' ? '删除智能体' : 'Delete agent'}
                        type="button"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>,
                  ];
                })}
                empty={locale === 'zh' ? '未找到智能体' : 'No agents found'}
              />
            </div>
          ))
        )}
      </section>
    {isCreatingAgent ? (
      <Modal open onClose={closeAgentCreator} labelledBy="agent-create-title">
          <div className="modal-header">
            <div className="panel-title" id="agent-create-title"><Plus size={18} /> {locale === 'zh' ? '创建智能体' : 'Create Agent'}</div>
            <button
              aria-label={locale === 'zh' ? '关闭创建器' : 'Close creator'}
              className="icon-button"
              onClick={closeAgentCreator}
              title={locale === 'zh' ? '关闭' : 'Close'}
              type="button"
            >
              <X size={16} />
            </button>
          </div>
        <AgentCreateForm
          data={data}
          locale={locale}
          canUseComputer={canUseComputer}
          busy={busy}
          onCancel={closeAgentCreator}
          onSubmit={(payload) =>
            void runAction(t.notices.agentCreated, async () => {
              await createAgent(payload);
              closeAgentCreator();
            })
          }
        />
      </Modal>
    ) : null}
    {deletingAgent ? (
      <DeleteDialog
        title={locale === 'zh' ? '删除智能体' : 'Delete Agent'}
        subject={deletingAgent.displayName}
        body={
          deletingAgent.binding
            ? locale === 'zh'
              ? '这个智能体绑定的飞书机器人也会解除绑定。历史任务和会话会保留；进行中的任务可能失去这个智能体作为执行身份。该智能体会被归档并从管理列表隐藏。'
              : 'The bound Feishu bot will be unbound. Historical tasks and sessions stay available. Active tasks may lose this agent as their execution identity. This agent will be archived and hidden from management lists.'
            : locale === 'zh'
              ? '历史任务和会话会保留；进行中的任务可能失去这个智能体作为执行身份。该智能体会被归档并从管理列表隐藏。'
              : 'Historical tasks and sessions stay available. Active tasks may lose this agent as their execution identity. This agent will be archived and hidden from management lists.'
        }
        confirmLabel={t.actions.delete}
        cancelLabel={t.actions.cancel}
        busy={busy}
        onCancel={() => setDeletingAgentId(null)}
        onConfirm={() =>
          runAction(t.notices.agentDeleted, async () => {
            await deleteAgent(deletingAgent.id);
            if (editingAgentId === deletingAgent.id) closeAgentEditor();
            setDeletingAgentId(null);
          })
        }
      />
    ) : null}
    {editingAgent ? (
      <Modal open onClose={closeAgentEditor} labelledBy="agent-edit-title">
          <div className="modal-header">
            <div className="panel-title" id="agent-edit-title"><Save size={18} /> {locale === 'zh' ? '编辑智能体' : 'Edit Agent'}</div>
            <button
              aria-label={locale === 'zh' ? '关闭编辑器' : 'Close editor'}
              className="icon-button"
              onClick={closeAgentEditor}
              title={locale === 'zh' ? '关闭' : 'Close'}
              type="button"
            >
              <X size={16} />
            </button>
          </div>
          <FormGrid>
            <Input
              label={agentDisplayNameLabel}
              value={agentEdit.displayName}
              onChange={(displayName) => setAgentEdit({ ...agentEdit, displayName })}
              required
              error={visibleError(
                agentEditErrors,
                'displayName',
                agentEditSubmitted || Boolean(agentEdit.displayName),
              )}
            />
            <Input label={locale === 'zh' ? '描述' : 'Description'} value={agentEdit.description} onChange={(description) => setAgentEdit({ ...agentEdit, description })} />
            <TextArea label={locale === 'zh' ? '系统提示词' : 'System Prompt'} value={agentEdit.systemPrompt} placeholder={SYSTEM_PROMPT_PLACEHOLDER} onChange={(systemPrompt) => setAgentEdit({ ...agentEdit, systemPrompt })} />
            <Select
              label="Runtime"
              value={agentEdit.defaultRuntime}
              onChange={(defaultRuntime) => setAgentEdit({ ...agentEdit, defaultRuntime })}
              options={AGENT_RUNTIME_OPTIONS}
              labels={{ '': t.common.none, ...RUNTIME_DISPLAY_NAMES }}
              error={visibleError(agentEditErrors, 'defaultRuntime', agentEditSubmitted)}
            />
            <Input
              label={locale === 'zh' ? '模型' : 'Model'}
              value={agentEdit.defaultModel}
              onChange={(defaultModel) => setAgentEdit({ ...agentEdit, defaultModel })}
              placeholder={locale === 'zh' ? '可选，如 kimi-k2 / gpt-5.2 / gemini-3-pro' : 'optional, e.g. kimi-k2 / gpt-5.2 / gemini-3-pro'}
            />
            {agentEdit.defaultRuntime === 'claude_code' ? (
              <>
                <div className="field">
                  <span>{locale === 'zh' ? 'Claude 登录方式' : 'Claude auth'}</span>
                  <div
                    className="segmented-control claude-auth-toggle"
                    aria-label={locale === 'zh' ? 'Claude 登录方式' : 'Claude auth mode'}
                  >
                    {(['subscription', 'custom'] as ClaudeAuthMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={agentEdit.claudeAuthMode === mode}
                        className={agentEdit.claudeAuthMode === mode ? 'active' : ''}
                        onClick={() =>
                          setAgentEdit({
                            ...agentEdit,
                            claudeAuthMode: mode,
                            clearRuntimeEnv: false,
                            ...(mode === 'subscription'
                              ? { claudeBaseUrl: '', claudeApiKey: '' }
                              : {}),
                          })
                        }
                      >
                        {claudeAuthModeLabel(mode, locale)}
                      </button>
                    ))}
                  </div>
                </div>
                {agentEdit.claudeAuthMode === 'custom' ? (
                  <>
                    <Input
                      label={locale === 'zh' ? 'API 接入地址 (Base URL)' : 'API Base URL'}
                      value={agentEdit.claudeBaseUrl}
                      onChange={(claudeBaseUrl) => setAgentEdit({ ...agentEdit, claudeBaseUrl })}
                      placeholder={
                        editingAgent.runtimeEnvKeys.includes(CLAUDE_BASE_URL_ENV_KEY)
                          ? locale === 'zh'
                            ? '留空保留现有值'
                            : 'leave blank to keep existing'
                          : 'https://api.anthropic.com'
                      }
                      error={agentEditSubmitted ? agentEditClaudeErrors.baseUrl : undefined}
                    />
                    <Input
                      label={locale === 'zh' ? 'API 密钥 (API Key)' : 'API Key'}
                      value={agentEdit.claudeApiKey}
                      onChange={(claudeApiKey) => setAgentEdit({ ...agentEdit, claudeApiKey })}
                      type="password"
                      placeholder={
                        editingAgent.runtimeEnvKeys.includes(CLAUDE_API_KEY_ENV_KEY)
                          ? locale === 'zh'
                            ? '留空保留现有值'
                            : 'leave blank to keep existing'
                          : ''
                      }
                      error={agentEditSubmitted ? agentEditClaudeErrors.apiKey : undefined}
                    />
                  </>
                ) : null}
              </>
            ) : null}
            <TextArea
              label="Env"
              value={agentEdit.runtimeEnv}
              placeholder={
                editingAgent.runtimeEnvKeys.length > 0
                  ? 'KEY=value (leave blank to keep existing env)'
                  : 'KEY=value'
              }
              onChange={(runtimeEnv) =>
                setAgentEdit({ ...agentEdit, runtimeEnv, clearRuntimeEnv: false })
              }
            />
            {editingAgent.runtimeEnvKeys.length > 0 ? (
              <p className="form-note">
                Configured env: {editingAgent.runtimeEnvKeys.join(', ')}. Leave Env blank to keep
                existing values.
              </p>
            ) : null}
            {editingAgent.runtimeEnvKeys.length > 0 ? (
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={agentEdit.clearRuntimeEnv}
                  onChange={(event) =>
                    setAgentEdit({
                      ...agentEdit,
                      clearRuntimeEnv: event.currentTarget.checked,
                      runtimeEnv: event.currentTarget.checked ? '' : agentEdit.runtimeEnv,
                    })
                  }
                />
                <span>{locale === 'zh' ? '清空已配置的 Env' : 'Clear configured env'}</span>
              </label>
            ) : null}
            {(() => {
              const { options, labels } = machineSelectFor(agentEdit.machineId);
              return (
                <Select
                  label={machineFieldLabel}
                  value={agentEdit.machineId}
                  onChange={(machineId) => setAgentEdit({ ...agentEdit, machineId })}
                  options={options}
                  labels={labels}
                  error={visibleError(agentEditErrors, 'machineId', agentEditSubmitted)}
                />
              );
            })()}
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={agentEdit.memoryEnabled}
                onChange={(event) =>
                  setAgentEdit({ ...agentEdit, memoryEnabled: event.currentTarget.checked })
                }
              />
              <span>
                {locale === 'zh'
                  ? '开启长期记忆 — 智能体跨任务沉淀并复用角色、领域知识与工作日志'
                  : 'Enable long-term memory — the agent accumulates and reuses its role, domain knowledge, and work log across tasks'}
              </span>
            </label>
            <p className="form-note">
              {locale === 'zh'
                ? '该开关仅作用于当前智能体；其他智能体的长期记忆设置不受影响。关闭只是暂停记忆，已沉淀的内容会保留。'
                : 'Applies to this agent only; other agents are unaffected. Turning it off pauses memory — existing memory is kept, not deleted.'}
            </p>
            <Select
              label={locale === 'zh' ? '状态' : 'Status'}
              value={agentEdit.status}
              onChange={(status) => setAgentEdit({ ...agentEdit, status })}
              options={AGENT_STATUS_OPTIONS}
              labels={Object.fromEntries(AGENT_STATUS_OPTIONS.map((status) => [status, statusLabel(status, locale)]))}
              error={visibleError(agentEditErrors, 'status', agentEditSubmitted)}
            />
            <div className="inline-actions">
              <button className="secondary" onClick={closeAgentEditor} type="button">
                {t.actions.cancel}
              </button>
              <button
                className="primary"
                disabled={
                  busy ||
                  hasValidationErrors(agentEditErrors) ||
                  hasFieldErrors(agentEditClaudeErrors)
                }
                onClick={() => {
                  setAgentEditSubmitted(true);
                  if (
                    hasValidationErrors(agentEditErrors) ||
                    hasFieldErrors(agentEditClaudeErrors)
                  )
                    return;
                  void runAction(t.notices.agentUpdated, async () => {
                    const defaultRuntime = agentEdit.defaultRuntime || null;
                    const displayName = agentEdit.displayName.trim();
                    const runtimeEnvText = agentEdit.runtimeEnv.trim();
                    const claudeEnv: Record<string, string> = {};
                    if (
                      defaultRuntime === 'claude_code' &&
                      agentEdit.claudeAuthMode === 'custom'
                    ) {
                      if (agentEdit.claudeBaseUrl.trim())
                        claudeEnv[CLAUDE_BASE_URL_ENV_KEY] = agentEdit.claudeBaseUrl.trim();
                      if (agentEdit.claudeApiKey.trim())
                        claudeEnv[CLAUDE_API_KEY_ENV_KEY] = agentEdit.claudeApiKey.trim();
                    }
                    const hasClaudeEnv = Object.keys(claudeEnv).length > 0;
                    const subscriptionEnv =
                      runtimeEnvText.length > 0
                        ? withoutClaudeCredentialKeys(parseRuntimeEnv(agentEdit.runtimeEnv))
                        : {};
                    const usesClaudeSubscription =
                      defaultRuntime === 'claude_code' && agentEdit.claudeAuthMode === 'subscription';
                    // Claude credentials merge on top of the Env textarea in
                    // custom mode. Subscription mode strips Claude credential
                    // keys so local-login execution stays explicit.
                    const runtimeEnvPatch = agentEdit.clearRuntimeEnv
                      ? { runtimeEnv: { ...claudeEnv } }
                      : usesClaudeSubscription && (runtimeEnvText.length > 0 || agentEditHasExistingClaudeKeys)
                        ? { runtimeEnv: subscriptionEnv }
                      : runtimeEnvText || hasClaudeEnv
                        ? { runtimeEnv: { ...parseRuntimeEnv(agentEdit.runtimeEnv), ...claudeEnv } }
                        : {};
                    // Only send machineId when the binding actually changed: an
                    // unchanged server-local agent must not re-trigger the
                    // server-side execution permission check on unrelated edits.
                    const nextMachineId = agentEdit.machineId || null;
                    const machineChanged = nextMachineId !== (editingAgent.machineId ?? null);
                    await updateAgent(editingAgent.id, {
                      displayName,
                      description: nullableText(agentEdit.description),
                      defaultRuntime,
                      ...runtimeEnvPatch,
                      memoryEnabled: agentEdit.memoryEnabled,
                      status: agentEdit.status,
                      ...(machineChanged ? { machineId: nextMachineId } : {}),
                      profile: {
                        displayName,
                        description: nullableText(agentEdit.description),
                        systemPrompt: nullableText(agentEdit.systemPrompt),
                        stylePrompt: null,
                        defaultRuntime,
                        defaultModel: nullableText(agentEdit.defaultModel),
                        status: agentEdit.status,
                      },
                    });
                    closeAgentEditor();
                  });
                }}
                type="button"
              >
                <Save size={16} /> {locale === 'zh' ? '保存智能体' : 'Save Agent'}
              </button>
            </div>
          </FormGrid>
      </Modal>
    ) : null}
    </>
  );
}

type PermissionCheckEntry = {
  loading: boolean;
  result?: FeishuPermissionCheckResult;
  error?: string;
};

type PermissionApplyEntry = {
  loading: boolean;
  result?: FeishuPermissionApplyResult;
  error?: string;
  autoApplyKey?: string;
};

type MetadataSyncEntry = {
  loading: boolean;
  error?: string;
};

function BotsView({
  data,
  busy,
  locale,
  runAction,
  isSuperadmin,
  refreshConsole,
}: {
  data: ConsoleData;
  busy: boolean;
  locale: Locale;
  runAction: (label: string, action: () => Promise<unknown>) => Promise<void>;
  isSuperadmin: boolean;
  refreshConsole: RefreshConsole;
}) {
  const t = uiText[locale];
  const [appForm, setAppForm] = useState({
    appId: '',
    appSecret: '',
    botName: '',
  });
  const [isRegisteringApp, setIsRegisteringApp] = useState(false);
  const [appCreateSubmitted, setAppCreateSubmitted] = useState(false);
  const [deletingAppId, setDeletingAppId] = useState<string | null>(null);
  const [editingAppId, setEditingAppId] = useState<string | null>(null);
  const [botNameEdit, setBotNameEdit] = useState('');
  const [botNameEditSubmitted, setBotNameEditSubmitted] = useState(false);
  const [bindingAppId, setBindingAppId] = useState<string | null>(null);
  const [bindingAgentId, setBindingAgentId] = useState('');
  const [bindingSubmitted, setBindingSubmitted] = useState(false);
  const [permissionChecks, setPermissionChecks] = useState<Record<string, PermissionCheckEntry>>(
    {},
  );
  const [permissionApplies, setPermissionApplies] = useState<Record<string, PermissionApplyEntry>>(
    {},
  );
  const [metadataSyncs, setMetadataSyncs] = useState<Record<string, MetadataSyncEntry>>({});
  const activeAgents = useMemo(
    () => data.agents.filter((agent) => agent.status === 'active'),
    [data.agents],
  );
  const bindTargetApp = useMemo(
    () => data.apps.find((app) => app.id === bindingAppId) ?? null,
    [bindingAppId, data.apps],
  );
  const deletingApp = useMemo(
    () => data.apps.find((app) => app.id === deletingAppId) ?? null,
    [data.apps, deletingAppId],
  );
  const editingApp = useMemo(
    () => data.apps.find((app) => app.id === editingAppId) ?? null,
    [data.apps, editingAppId],
  );
  const appCreateErrors = validateFeishuAppForm(appForm, locale);
  const canRegisterApp = !hasValidationErrors(appCreateErrors);
  const botNameEditError = requiredError(
    botNameEdit,
    locale === 'zh' ? '机器人名称' : 'Bot Name',
    locale,
  );
  const bindingErrors: FieldErrors<'agentId'> = {
    agentId:
      requiredError(bindingAgentId, locale === 'zh' ? '智能体' : 'Agent', locale) ??
      optionError(
        bindingAgentId,
        activeAgents.map((agent) => agent.id),
        locale === 'zh' ? '智能体' : 'Agent',
        locale,
      ),
  };

  useEffect(() => {
    if (bindingAppId && !bindingAgentId && activeAgents[0]) {
      setBindingAgentId(activeAgents[0].id);
    }
  }, [activeAgents, bindingAgentId, bindingAppId]);

  function resetAppForm() {
    setAppForm({
      appId: '',
      appSecret: '',
      botName: '',
    });
    setAppCreateSubmitted(false);
  }

  function closeAppCreator() {
    setIsRegisteringApp(false);
    resetAppForm();
  }

  function openBinding(appId: string) {
    setBindingAppId(appId);
    setBindingAgentId(activeAgents[0]?.id ?? '');
    setBindingSubmitted(false);
  }

  function closeBinding() {
    setBindingAppId(null);
    setBindingAgentId('');
    setBindingSubmitted(false);
  }

  function openBotNameEditor(app: FeishuApp) {
    setEditingAppId(app.id);
    setBotNameEdit(app.botName ?? '');
    setBotNameEditSubmitted(false);
  }

  function closeBotNameEditor() {
    setEditingAppId(null);
    setBotNameEdit('');
    setBotNameEditSubmitted(false);
  }

  async function runMetadataSync(app: FeishuApp) {
    setMetadataSyncs((previous) => ({
      ...previous,
      [app.id]: { loading: true },
    }));
    try {
      await syncFeishuAppMetadata(app.id);
      setMetadataSyncs((previous) => ({
        ...previous,
        [app.id]: { loading: false },
      }));
      await refreshConsole({ showLoading: false });
    } catch (err) {
      setMetadataSyncs((previous) => ({
        ...previous,
        [app.id]: { loading: false, error: (err as Error).message },
      }));
    }
  }

  async function runPermissionCheck(app: FeishuApp) {
    setPermissionChecks((previous) => ({
      ...previous,
      [app.id]: { loading: true },
    }));
    try {
      const result = await checkFeishuAppPermissions(app.id);
      setPermissionChecks((previous) => ({
        ...previous,
        [app.id]: { loading: false, result },
      }));
      if (result.status === 'pass') {
        setPermissionApplies((previous) => {
          const next = { ...previous };
          delete next[app.id];
          return next;
        });
        return;
      }
      const autoApplyKey = permissionAutoApplyKey(result);
      const previousApply = permissionApplies[app.id];
      if (
        previousApply?.autoApplyKey !== autoApplyKey ||
        previousApply.error ||
        previousApply.result?.status === 'no_pending_scopes' ||
        previousApply.result?.submitted === false
      ) {
        await runPermissionApply(app, autoApplyKey);
      }
    } catch (err) {
      setPermissionChecks((previous) => ({
        ...previous,
        [app.id]: { loading: false, error: (err as Error).message },
      }));
    }
  }

  async function runPermissionApply(app: FeishuApp, autoApplyKey?: string) {
    setPermissionApplies((previous) => ({
      ...previous,
      [app.id]: { loading: true, autoApplyKey },
    }));
    try {
      const result = await applyFeishuAppPermissions(app.id);
      setPermissionApplies((previous) => ({
        ...previous,
        [app.id]: { loading: false, result, autoApplyKey },
      }));
    } catch (err) {
      setPermissionApplies((previous) => ({
        ...previous,
        [app.id]: { loading: false, error: (err as Error).message, autoApplyKey },
      }));
    }
  }

  return (
    <>
      <div className="bots-stack">
        <FeishuBotOnboardingPanel
          compact
          data={data}
          locale={locale}
          refreshConsole={refreshConsole}
        />
        <section className="panel">
        <div className="panel-heading">
          <div className="panel-title">
            <Bot size={18} /> Feishu Apps
          </div>
          <button
            aria-label={locale === 'zh' ? '注册飞书应用' : 'Register Feishu App'}
            className="icon-button"
            disabled={busy}
            onClick={() => setIsRegisteringApp(true)}
            title={locale === 'zh' ? '注册飞书应用' : 'Register Feishu App'}
            type="button"
          >
            <Plus size={16} />
          </button>
        </div>
        <DataTable
          columns={[
            locale === 'zh' ? '机器人' : 'Bot',
            'App ID',
            locale === 'zh' ? '密钥' : 'Secret',
            locale === 'zh' ? '智能体' : 'Agent',
            ...(isSuperadmin ? [locale === 'zh' ? '所有者' : 'Owner'] : []),
            locale === 'zh' ? '状态' : 'Status',
            locale === 'zh' ? '权限' : 'Permissions',
            '',
          ]}
          rowKeys={data.apps.map((app) => app.id)}
          rows={data.apps.map((app) => {
            const permissionCheck = permissionChecks[app.id];
            const permissionApply = permissionApplies[app.id];
            const metadataSync = metadataSyncs[app.id];
            const botLabel = app.botName ?? app.appId;
            const permissionValue = permissionCheck?.loading
              ? 'pending'
              : permissionCheck?.error
                ? 'fail'
                : permissionCheck?.result?.status === 'fail'
                  ? 'warning'
                  : permissionCheck?.result?.optionalMissingCapabilities.length
                    ? 'warning'
                    : permissionCheck?.result?.status === 'pass'
                      ? 'pass'
                      : 'default';
            const permissionLabel = permissionCheck?.loading
              ? t.common.permissionCheckPending
              : permissionCheck?.error
                ? t.common.permissionCheckFailed
                : permissionCheck?.result?.status === 'fail'
                  ? t.common.permissionMissing
                  : permissionCheck?.result?.status === 'pass'
                    ? t.common.permissionCheckPassed
                    : undefined;
            const permissionError = permissionCheck?.loading ? null : permissionCheck?.error;
            const permissionApplyNoPending =
              permissionApply?.result?.status === 'no_pending_scopes' ||
              permissionApply?.result?.submitted === false;
            const permissionApplyValue = permissionApply?.loading
              ? 'pending'
              : permissionApply?.error
                ? 'fail'
                : permissionApply?.result?.submitted
                  ? 'pass'
                  : permissionApplyNoPending
                    ? 'default'
                  : 'default';
            const permissionApplyLabel = permissionApply?.loading
              ? t.common.permissionApplyPending
              : permissionApply?.error
                ? t.common.permissionApplyFailed
                : permissionApply?.result?.submitted
                  ? t.common.permissionApplySubmitted
                  : undefined;
            const permissionApplyError = permissionApply?.loading ? null : permissionApply?.error;
            const permissionApplyMessage =
              !permissionApply?.loading && permissionApplyNoPending
                ? t.common.permissionApplyNoPendingHint
                : null;
            const missingRequired = permissionCheck?.result?.missingRequiredCapabilities ?? [];
            const optionalMissing = permissionCheck?.result?.optionalMissingCapabilities ?? [];
            const missingLabels = permissionCheck?.result
              ? missingRequiredCapabilityLabels(permissionCheck.result)
              : missingRequired;
            const requiredScopes = permissionCheck?.result
              ? missingRequiredScopeNames(permissionCheck.result)
              : [];
            const approvalUrl =
              permissionCheck?.result?.status === 'fail'
                ? buildFeishuPermissionApprovalUrl(permissionCheck.result)
                : null;
            const approvalQrUrl = approvalUrl
              ? buildFeishuPermissionApprovalQrUrl(approvalUrl)
              : null;

            return [
              <strong key="bot">
                {app.botName ?? t.common.unnamed}
                <small>{app.botOpenId ?? t.common.botOpenIdPending}</small>
                {metadataSync?.error ? (
                  <small className="permission-error">{metadataSync.error}</small>
                ) : null}
              </strong>,
              app.appId,
              secretLabel(app, locale),
              app.binding?.agentDisplayName ?? t.common.unbound,
              ...(isSuperadmin
                ? [<span key="owner">{ownerLabel(app.platformOwner, locale)}</span>]
                : []),
              <Badge key="status" value={app.status} label={statusLabel(app.status, locale)} />,
              <div className="permission-check" key="permissions">
                {permissionLabel ? <Badge value={permissionValue} label={permissionLabel} /> : null}
                {permissionApplyLabel ? (
                  <Badge value={permissionApplyValue} label={permissionApplyLabel} />
                ) : null}
                {permissionError ? (
                  <small className="permission-error">{permissionError}</small>
                ) : null}
                {permissionApplyError ? (
                  <small className="permission-error">{permissionApplyError}</small>
                ) : null}
                {permissionApplyMessage ? (
                  <small className="permission-guidance">{permissionApplyMessage}</small>
                ) : null}
                {missingRequired.length > 0 ? (
                  <small className="permission-guidance">
                    {t.common.missingPermissions}: {missingLabels.join(', ')}
                  </small>
                ) : null}
                {requiredScopes.length > 0 ? (
                  <div
                    aria-label={t.common.permissionRequiredScopes}
                    className="permission-scope-list"
                  >
                    {requiredScopes.map((scope) => (
                      <code className="permission-scope-chip" key={scope}>
                        {scope}
                      </code>
                    ))}
                  </div>
                ) : null}
                {optionalMissing.length > 0 ? (
                  <small>
                    {t.common.optionalGaps}: {optionalMissing.join(', ')}
                  </small>
                ) : null}
                {approvalUrl ? (
                  <div className="permission-approval">
                    <a
                      className="secondary tiny"
                      href={approvalUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink size={14} /> {t.common.permissionApprovalLink}
                    </a>
                    <CopyButton value={approvalUrl} locale={locale} />
                    {approvalQrUrl ? (
                      <img
                        alt={t.common.permissionApprovalQr}
                        className="permission-approval-qr"
                        height={112}
                        src={approvalQrUrl}
                        width={112}
                      />
                    ) : null}
                  </div>
                ) : null}
                <button
                  aria-label={`${t.actions.checkPermissions} for ${botLabel}`}
                  className="secondary tiny"
                  disabled={busy || permissionCheck?.loading || permissionApply?.loading}
                  onClick={() => void runPermissionCheck(app)}
                  title={`${t.actions.checkPermissions} for ${botLabel}`}
                  type="button"
                >
                  {permissionCheck?.loading ? <Loader2 size={14} /> : <Shield size={14} />}
                  {t.actions.checkPermissions}
                </button>
              </div>,
              <div className="inline-actions row-actions" key="actions">
                <button
                  aria-label={`${locale === 'zh' ? '编辑' : 'Edit'} ${botLabel}`}
                  className="secondary tiny"
                  disabled={busy}
                  onClick={() => openBotNameEditor(app)}
                  title={locale === 'zh' ? '编辑机器人名称' : 'Edit bot name'}
                  type="button"
                >
                  <Pencil size={14} /> {t.actions.edit}
                </button>
                <button
                  aria-label={`${locale === 'zh' ? '同步' : 'Sync'} ${botLabel}`}
                  className="secondary tiny"
                  disabled={busy || metadataSync?.loading}
                  onClick={() => void runMetadataSync(app)}
                  title={
                    locale === 'zh'
                      ? '从飞书开发者平台同步名称'
                      : 'Sync name from Feishu Open Platform'
                  }
                  type="button"
                >
                  {metadataSync?.loading ? (
                    <Loader2 className="spin" size={14} />
                  ) : (
                    <RefreshCcw size={14} />
                  )}
                  {t.actions.sync}
                </button>
                {app.binding ? (
                  <button
                    className="secondary tiny"
                    disabled={busy}
                    title={locale === 'zh' ? '解绑机器人' : 'Unbind bot'}
                    type="button"
                    onClick={() => runAction(t.notices.botUnbound, () => unbindBot(app.binding!.id))}
                  >
                    <Unlink size={14} /> {t.actions.unbind}
                  </button>
                ) : (
                  <button
                    className="primary tiny"
                    disabled={busy || app.status !== 'enabled' || activeAgents.length === 0}
                    onClick={() => openBinding(app.id)}
                    title={locale === 'zh' ? '绑定机器人' : 'Bind bot'}
                    type="button"
                  >
                    <Link2 size={14} /> {t.actions.bind}
                  </button>
                )}
                <button
                  aria-label={`${locale === 'zh' ? '删除' : 'Delete'} ${botLabel}`}
                  className="secondary tiny danger"
                  disabled={busy}
                  onClick={() => setDeletingAppId(app.id)}
                  title={locale === 'zh' ? '删除飞书应用' : 'Delete Feishu app'}
                  type="button"
                >
                  <Trash2 size={14} /> {t.actions.delete}
                </button>
              </div>,
            ];
          })}
          empty={locale === 'zh' ? '暂无已注册飞书应用' : 'No Feishu apps registered'}
          tableClassName="bots-table"
        />
        </section>
      </div>

      {editingApp ? (
        <Modal open onClose={closeBotNameEditor} labelledBy="bot-name-edit-title">
          <div className="modal-header">
            <div className="panel-title" id="bot-name-edit-title">
              <Pencil size={18} /> {locale === 'zh' ? '编辑机器人名称' : 'Edit Bot Name'}
            </div>
            <button
              aria-label={locale === 'zh' ? '关闭编辑器' : 'Close editor'}
              className="icon-button"
              onClick={closeBotNameEditor}
              title={locale === 'zh' ? '关闭' : 'Close'}
              type="button"
            >
              <X size={16} />
            </button>
          </div>
          <FormGrid>
            <Input
              label={locale === 'zh' ? '机器人名称' : 'Bot Name'}
              value={botNameEdit}
              onChange={setBotNameEdit}
              required
              error={botNameEditSubmitted ? botNameEditError ?? undefined : undefined}
            />
            <p className="form-note">
              {locale === 'zh'
                ? '此处只更新 OpenClaudeTag 本地展示名。使用同步按钮可从飞书开发者平台拉取当前应用名。'
                : 'This updates the local OpenClaudeTag display name. Use Sync to pull the current app name from Feishu Open Platform.'}
            </p>
            <div className="inline-actions">
              <button className="secondary" onClick={closeBotNameEditor} type="button">
                {t.actions.cancel}
              </button>
              <button
                className="primary"
                disabled={busy || Boolean(botNameEditError)}
                onClick={() => {
                  setBotNameEditSubmitted(true);
                  if (botNameEditError) return;
                  void runAction(t.notices.appUpdated, async () => {
                    await updateFeishuApp(editingApp.id, { botName: botNameEdit.trim() });
                    closeBotNameEditor();
                  });
                }}
                type="button"
              >
                <Save size={16} /> {t.actions.save}
              </button>
            </div>
          </FormGrid>
        </Modal>
      ) : null}

      {deletingApp ? (
        <DeleteDialog
          title={locale === 'zh' ? '删除飞书应用' : 'Delete Feishu App'}
          subject={deletingApp.botName ?? deletingApp.appId}
          body={
            deletingApp.binding
              ? locale === 'zh'
                ? '这个飞书应用当前绑定的智能体会解除绑定，相关运行时会刷新。历史任务会保留；进行中的任务可能失去这个应用作为机器人投递身份。该应用会被停用并从管理列表隐藏。'
                : 'The currently bound agent will be unbound and the runtime will reload. Historical tasks stay available. Active tasks may lose this app as their bot delivery identity. This app will be disabled and hidden from management lists.'
              : locale === 'zh'
                ? '历史任务会保留；进行中的任务可能失去这个应用作为机器人投递身份。该应用会被停用并从管理列表隐藏。'
                : 'Historical tasks stay available. Active tasks may lose this app as their bot delivery identity. This app will be disabled and hidden from management lists.'
          }
          confirmLabel={t.actions.delete}
          cancelLabel={t.actions.cancel}
          busy={busy}
          onCancel={() => setDeletingAppId(null)}
          onConfirm={() =>
            runAction(t.notices.appDeleted, async () => {
              await deleteFeishuApp(deletingApp.id);
              if (bindingAppId === deletingApp.id) closeBinding();
              setPermissionChecks((previous) => {
                const next = { ...previous };
                delete next[deletingApp.id];
                return next;
              });
              setDeletingAppId(null);
            })
          }
        />
      ) : null}

      {isRegisteringApp ? (
        <Modal open onClose={closeAppCreator} labelledBy="app-create-title">
            <div className="modal-header">
              <div className="panel-title" id="app-create-title">
                <Plus size={18} /> {locale === 'zh' ? '注册飞书应用' : 'Register Feishu App'}
              </div>
              <button
                aria-label={locale === 'zh' ? '关闭注册器' : 'Close register dialog'}
                className="icon-button"
                onClick={closeAppCreator}
                title={locale === 'zh' ? '关闭' : 'Close'}
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            <FormGrid>
              <Input
                label="App ID"
                value={appForm.appId}
                onChange={(appId) => setAppForm({ ...appForm, appId })}
                required
                error={visibleError(
                  appCreateErrors,
                  'appId',
                  appCreateSubmitted || Boolean(appForm.appId),
                )}
              />
              <Input
                label={locale === 'zh' ? 'App 密钥' : 'App Secret'}
                type="password"
                value={appForm.appSecret}
                onChange={(appSecret) => setAppForm({ ...appForm, appSecret })}
                required
                error={visibleError(
                  appCreateErrors,
                  'appSecret',
                  appCreateSubmitted || Boolean(appForm.appSecret) || Boolean(appForm.appId),
                )}
              />
              <Input
                label={locale === 'zh' ? '机器人名称' : 'Bot Name'}
                value={appForm.botName}
                onChange={(botName) => setAppForm({ ...appForm, botName })}
              />
              <p className="form-note">
                {locale === 'zh'
                  ? 'Bot Open ID 会在密钥可用后自动获取。'
                  : 'Bot Open ID is discovered automatically once the secret is available.'}
              </p>
              <div className="inline-actions">
                <button className="secondary" onClick={closeAppCreator} type="button">
                  {t.actions.cancel}
                </button>
                <button
                  className="primary"
                  disabled={busy || !canRegisterApp}
                  onClick={() => {
                    setAppCreateSubmitted(true);
                    if (!canRegisterApp) return;
                    void runAction(t.notices.appRegistered, async () => {
                      await createFeishuApp(appForm);
                      closeAppCreator();
                    });
                  }}
                  type="button"
                >
                  <Plus size={16} /> {t.actions.register}
                </button>
              </div>
            </FormGrid>
        </Modal>
      ) : null}

      {bindTargetApp ? (
        <Modal open onClose={closeBinding} labelledBy="bot-bind-title">
            <div className="modal-header">
              <div className="panel-title" id="bot-bind-title">
                <Link2 size={18} /> {locale === 'zh' ? '绑定机器人' : 'Bind Bot'}
              </div>
              <button
                aria-label={locale === 'zh' ? '关闭绑定器' : 'Close bind dialog'}
                className="icon-button"
                onClick={closeBinding}
                title={locale === 'zh' ? '关闭' : 'Close'}
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            <FormGrid>
              <Input
                label={locale === 'zh' ? '机器人' : 'Bot'}
                value={`${bindTargetApp.botName ?? bindTargetApp.appId} (${bindTargetApp.appId})`}
                disabled
              />
              <Select
                label={locale === 'zh' ? '智能体' : 'Agent'}
                value={bindingAgentId}
                onChange={(agentId) => {
                  setBindingAgentId(agentId);
                  setBindingSubmitted(true);
                }}
                options={activeAgents.map((agent) => agent.id)}
                labels={Object.fromEntries(
                  activeAgents.map((agent) => [agent.id, agent.displayName]),
                )}
                required
                error={visibleError(bindingErrors, 'agentId', bindingSubmitted)}
              />
              {activeAgents.length === 0 ? (
                <p className="form-note">
                  {locale === 'zh'
                    ? '需要先创建一个启用状态的智能体。'
                    : 'Create an active agent before binding a bot.'}
                </p>
              ) : null}
              <div className="inline-actions">
                <button className="secondary" onClick={closeBinding} type="button">
                  {t.actions.cancel}
                </button>
                <button
                  className="primary"
                  disabled={busy || hasValidationErrors(bindingErrors)}
                  onClick={() => {
                    setBindingSubmitted(true);
                    if (hasValidationErrors(bindingErrors)) return;
                    void runAction(t.notices.botBound, async () => {
                      await bindBot({ agentId: bindingAgentId, feishuAppId: bindTargetApp.id });
                      closeBinding();
                    });
                  }}
                  type="button"
                >
                  <Link2 size={16} /> {t.actions.bind}
                </button>
              </div>
            </FormGrid>
        </Modal>
      ) : null}
    </>
  );
}

function DeleteDialog({
  title,
  subject,
  body,
  confirmLabel,
  cancelLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  subject: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open onClose={onCancel} labelledBy="delete-dialog-title" className="delete-modal">
        <div className="modal-header">
          <div className="panel-title" id="delete-dialog-title">
            <Trash2 size={18} /> {title}
          </div>
          <button
            aria-label={cancelLabel}
            className="icon-button"
            disabled={busy}
            onClick={onCancel}
            title={cancelLabel}
            type="button"
          >
            <X size={16} />
          </button>
        </div>
        <div className="delete-copy">
          <strong>{subject}</strong>
          <p>{body}</p>
        </div>
        <div className="inline-actions">
          <button className="secondary" disabled={busy} onClick={onCancel} type="button">
            {cancelLabel}
          </button>
          <button className="primary danger" disabled={busy} onClick={onConfirm} type="button">
            <Trash2 size={16} /> {confirmLabel}
          </button>
        </div>
      </Modal>
  );
}

const SERVER_LOCAL_MACHINE_VALUE = '';

function ChatsView({
  data,
  busy,
  locale,
  runAction,
}: {
  data: ConsoleData;
  busy: boolean;
  locale: Locale;
  runAction: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const t = uiText[locale];
  // server-local + only non-revoked machines are bindable as a chat default.
  const bindableMachines = useMemo(
    () => data.machines.filter((machine) => machine.status !== 'revoked'),
    [data.machines],
  );
  const machineOptions = [SERVER_LOCAL_MACHINE_VALUE, ...bindableMachines.map((machine) => machine.id)];
  const serverLocalLabel = locale === 'zh' ? '本机(服务器)' : 'Server-local';
  const machineLabels: Record<string, string> = {
    [SERVER_LOCAL_MACHINE_VALUE]: serverLocalLabel,
    ...Object.fromEntries(bindableMachines.map((machine) => [machine.id, machine.name])),
  };
  // A revoked machine still bound to a chat should remain visible (read-only) so
  // the operator understands why and can clear it back to server-local.
  function machineOptionsForChat(chat: Chat): { options: string[]; labels: Record<string, string> } {
    if (
      chat.defaultMachineId &&
      !bindableMachines.some((machine) => machine.id === chat.defaultMachineId)
    ) {
      const staleLabel = `${chat.defaultMachineName ?? chat.defaultMachineId} (${statusLabel('revoked', locale)})`;
      return {
        options: [...machineOptions, chat.defaultMachineId],
        labels: { ...machineLabels, [chat.defaultMachineId]: staleLabel },
      };
    }
    return { options: machineOptions, labels: machineLabels };
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <MessageSquare size={18} /> {viewLabels[locale].chats}
      </div>
      <div className="chat-list">
        {data.chats.length === 0 ? (
          <EmptyState
            label={locale === 'zh' ? '暂无会话配置' : 'No chat configs found'}
          />
        ) : null}
        {data.chats.map((chat) => {
          const key = `${chat.tenantKey}:${chat.chatId}`;
          const machineSelect = machineOptionsForChat(chat);
          return (
            <article className="row-card" key={key}>
              <div className="resource-title">
                <strong>{chat.displayName}</strong>
                <small>
                  {shortId(chat.chatId)} · {t.common.tenant} {chat.tenantKey}
                </small>
                <div className="chips compact">
                  <span>
                    {locale === 'zh' ? `${chat.taskCount} 个任务` : `${chat.taskCount} tasks`}
                  </span>
                  <span>{runtimeLabel(chat.defaultRuntime, locale)}</span>
                  <span>
                    {t.common.last} {formatDate(chat.lastTaskAt, locale)}
                  </span>
                </div>
                {chat.taskBoard ? (
                  <small>
                    {t.common.taskList}: {chat.taskBoard.name} ·{' '}
                    {locale === 'zh'
                      ? `${chat.taskBoard.taskCount} 个已关联任务`
                      : `${chat.taskBoard.taskCount} linked tasks`}
                  </small>
                ) : null}
              </div>
              <div
                className="chat-agents"
                aria-label={`${chat.displayName} ${viewLabels[locale].agents}`}
              >
                {chat.agents.length === 0 ? (
                  <span className="empty-chip">
                    {locale === 'zh' ? '暂无观察到的智能体' : 'No agents observed'}
                  </span>
                ) : null}
                {chat.agents.map((agent) => (
                  <div className="agent-pill" key={agent.id}>
                    <strong>{agent.displayName}</strong>
                    <small>{statusLabel(agent.status, locale)}</small>
                    <span>
                      {locale === 'zh' ? `${agent.taskCount} 个任务` : `${agent.taskCount} tasks`} ·{' '}
                      {t.common.last} {formatDate(agent.lastTaskAt, locale)}
                    </span>
                  </div>
                ))}
              </div>
              {machineSelect ? (
                <div className="chat-machine-control">
                  <Select
                    label={viewLabels[locale].machines}
                    value={chat.defaultMachineId ?? SERVER_LOCAL_MACHINE_VALUE}
                    options={machineSelect.options}
                    labels={machineSelect.labels}
                    disabled={busy}
                    onChange={(machineId) =>
                      runAction(t.notices.chatMachineUpdated, async () => {
                        await updateChat(chat.tenantKey, chat.chatId, {
                          defaultMachineId: machineId || null,
                        });
                      })
                    }
                  />
                </div>
              ) : null}
              <div className="row-actions">
                <a className="secondary" href={chat.openFeishuUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={16} /> {t.actions.openFeishu}
                </a>
                {chat.taskBoard ? (
                  <a
                    className="secondary"
                    href={chat.taskBoard.openTasklistUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Rows3 size={16} /> {t.actions.board}
                  </a>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * A copy-to-clipboard button for a single command/value. Uses the async
 * Clipboard API with a textarea fallback so it still works on non-secure
 * (http-internal) origins where `navigator.clipboard` may be unavailable.
 */
function CopyButton({ value, locale }: { value: string; locale: Locale }) {
  const t = uiText[locale].daemonGuide;
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Best-effort; leave the button label unchanged on failure.
    }
  }

  return (
    <button
      type="button"
      className="copy-button"
      onClick={() => void copy()}
      aria-label={copied ? t.copied : t.copy}
      title={copied ? t.copied : t.copy}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span>{copied ? t.copied : t.copy}</span>
    </button>
  );
}

/** A monospace command line with an attached copy button. */
function CommandBlock({ command, locale }: { command: string; locale: Locale }) {
  return (
    <div className="command-block">
      <code>{command}</code>
      <CopyButton value={command} locale={locale} />
    </div>
  );
}

/**
 * The "Connect a machine" install guide on the Machines view. Shows an OS toggle
 * (Linux | macOS) and renders prereqs, a "Generate pairing token" step (design
 * D-A7 — pairing is console-only, no Feishu command), the npx install command,
 * and background daemon management commands. The daemon gateway URL (`--server-url`) is
 * substituted from `authConfig.serverPublicUrl`; when the server has not set it, a
 * `<SERVER_PUBLIC_URL>` placeholder is shown with a note. Once a token is
 * generated it is substituted into the connect commands in place of `<TOKEN>`.
 */
function DaemonInstallGuide({
  locale,
  authConfig,
  me,
  onAuthenticated,
}: {
  locale: Locale;
  authConfig: AuthConfig | null;
  me: Me | null;
  onAuthenticated: () => Promise<void>;
}) {
  const t = uiText[locale].daemonGuide;
  const [os, setOs] = useState<'linux' | 'mac'>('linux');
  const [token, setToken] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [devSubInput, setDevSubInput] = useState('');
  const [devNameInput, setDevNameInput] = useState('');
  const [devBusy, setDevBusy] = useState(false);
  const [devError, setDevError] = useState<string | null>(null);

  const serverUrl = authConfig?.serverPublicUrl ?? '<SERVER_PUBLIC_URL>';
  const serverIsPlaceholder = !authConfig?.serverPublicUrl;
  // Always install the latest published daemon: pinning to the server
  // checkout's version would break whenever a publish and a server deploy
  // drift apart, and `@latest` re-resolves on every npx run.
  const npxSpec = '@open-tag/daemon@latest';

  // Substitute the generated token into the connect commands; before generation
  // the `<TOKEN>` placeholder is shown so the shape of the command is clear.
  const tokenArg = token ?? '<TOKEN>';
  const npxInstallCmd =
    `npx ${npxSpec} --server-url ${serverUrl} --token ${tokenArg} --background`;
  const statusCmd = `npx ${npxSpec} status`;
  const stopCmd = `npx ${npxSpec} stop`;
  const restartCmd =
    `npx ${npxSpec} start --background`;
  const tokenAdminNeedsUser = me?.tokenAdmin === true;
  const devAuthEnabled = authConfig?.devAuthEnabled === true;

  async function generateToken() {
    setGenerating(true);
    setTokenError(null);
    try {
      const issued = await issuePairingToken();
      setToken(issued.token);
    } catch (err) {
      setTokenError((err as Error).message || t.step2TokenError);
    } finally {
      setGenerating(false);
    }
  }

  async function switchToDevUser() {
    setDevError(null);
    setTokenError(null);
    setDevBusy(true);
    try {
      const ok = await devLogin(devSubInput.trim(), devNameInput.trim() || undefined);
      if (!ok) {
        setDevError(t.devSignInFailed);
        return;
      }
      await onAuthenticated();
    } catch {
      setDevError(t.devSignInFailed);
    } finally {
      setDevBusy(false);
    }
  }

  return (
    <section className="panel daemon-guide">
      <div className="panel-title"><Laptop size={18} /> {t.title}</div>
      <p className="daemon-guide-subtitle">{t.subtitle}</p>

      <div className="segmented-control daemon-os-toggle" aria-label="OS">
        <button
          type="button"
          aria-pressed={os === 'linux'}
          className={os === 'linux' ? 'active' : ''}
          onClick={() => setOs('linux')}
        >
          Linux
        </button>
        <button
          type="button"
          aria-pressed={os === 'mac'}
          className={os === 'mac' ? 'active' : ''}
          onClick={() => setOs('mac')}
        >
          macOS
        </button>
      </div>

      <ol className="daemon-steps">
        <li>
          <strong>{t.step1Title}</strong>
          <p>{os === 'linux' ? t.step1Linux : t.step1Mac}</p>
        </li>
        <li>
          <strong>{t.step2Title}</strong>
          <p>{t.step2Body}</p>
          <button
            type="button"
            className="primary daemon-generate-token"
            onClick={() => void generateToken()}
            disabled={generating}
          >
            {generating ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}{' '}
            {generating ? t.step2Generating : t.step2Generate}
          </button>
          {token ? (
            <>
              <CommandBlock command={token} locale={locale} />
              <p className="daemon-guide-note">{t.step2TokenNote}</p>
            </>
          ) : null}
          {tokenError ? (
            <div className="daemon-guide-note error">
              <strong>{t.step2TokenError}</strong>
              <span>{tokenError}</span>
            </div>
          ) : null}
          {tokenAdminNeedsUser ? (
            <div className="daemon-user-signin">
              <div className="daemon-method-title">{t.tokenAdminTitle}</div>
              <p>{t.tokenAdminBody}</p>
              <p>{devAuthEnabled ? t.tokenAdminDevBody : t.tokenAdminNoDevBody}</p>
              {devAuthEnabled ? (
                <FormGrid>
                  <Input
                    label={t.devSubLabel}
                    value={devSubInput}
                    placeholder="alice"
                    onChange={setDevSubInput}
                  />
                  <Input
                    label={t.devNameLabel}
                    value={devNameInput}
                    placeholder="Alice"
                    onChange={setDevNameInput}
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={devBusy || !devSubInput.trim()}
                    onClick={() => void switchToDevUser()}
                  >
                    {devBusy ? <Loader2 size={16} className="spin" /> : <LogIn size={16} />}
                    {t.devSignIn}
                  </button>
                  {devError ? <div className="alert error">{devError}</div> : null}
                </FormGrid>
              ) : null}
            </div>
          ) : null}
        </li>
        <li>
          <strong>{t.step3Title}</strong>
          <div className="daemon-method">
            <div className="daemon-method-title">{t.methodBNpx}</div>
            <p>{t.methodBNpxBody}</p>
            <CommandBlock command={npxInstallCmd} locale={locale} />
          </div>
          {serverIsPlaceholder ? (
            <p className="daemon-guide-note">{t.serverPlaceholderNote}</p>
          ) : null}
        </li>
        <li>
          <strong>{t.step4Title}</strong>
          <p>{t.step4Body}</p>
          <CommandBlock command={statusCmd} locale={locale} />
          <CommandBlock command={stopCmd} locale={locale} />
          <CommandBlock command={restartCmd} locale={locale} />
        </li>
      </ol>
    </section>
  );
}

function MachinesView({
  data,
  locale,
  authConfig,
  me,
  onAuthenticated,
}: {
  data: ConsoleData;
  locale: Locale;
  authConfig: AuthConfig | null;
  me: Me | null;
  onAuthenticated: () => Promise<void>;
}) {
  const t = uiText[locale];
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  async function handleDisconnect(machineId: string) {
    setDisconnectingId(machineId);
    setDisconnectError(null);
    try {
      await disconnectMachine(machineId);
      await onAuthenticated();
    } catch (error) {
      setDisconnectError(error instanceof Error ? error.message : String(error));
    } finally {
      setDisconnectingId(null);
    }
  }
  const runtimeListLabel = (runtimes: string[]): string => {
    const visibleRuntimes = visibleRuntimeValues(runtimes);
    return visibleRuntimes.length > 0
      ? visibleRuntimes.map(runtimeDisplayName).join(', ')
      : t.common.none;
  };
  return (
    <div className="machines-stack">
      <section className="panel">
        <div className="panel-title"><Laptop size={18} /> {viewLabels[locale].machines}</div>
        {disconnectError ? <div className="alert error">{disconnectError}</div> : null}
        <DataTable
          columns={[
            locale === 'zh' ? '机器' : 'Machine',
            locale === 'zh' ? '状态' : 'Status',
            locale === 'zh' ? '运行时' : 'Runtimes',
            locale === 'zh' ? '所有者' : 'Owner',
            locale === 'zh' ? '最近在线' : 'Last seen',
            '',
          ]}
          rowKeys={data.machines.map((machine: Machine) => machine.id)}
          rows={data.machines.map((machine: Machine) => [
            <strong key="name">{machine.name}</strong>,
            <Badge
              key="status"
              value={machine.status}
              label={statusLabel(machine.status, locale)}
            />,
            runtimeListLabel(machine.runtimes),
            <code key="owner">{shortId(machine.ownerOpenId)}</code>,
            formatRelativeTime(machine.lastSeenAt, locale),
            machine.status === 'revoked' ? (
              <span key="actions" />
            ) : (
              <div className="inline-actions row-actions" key="actions">
                <button
                  className="secondary tiny danger"
                  disabled={disconnectingId === machine.id}
                  onClick={() => void handleDisconnect(machine.id)}
                  title={locale === 'zh' ? '断开机器连接' : 'Disconnect machine'}
                  type="button"
                >
                  {disconnectingId === machine.id ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Unlink size={14} />
                  )}
                  {locale === 'zh' ? '断开' : 'Disconnect'}
                </button>
              </div>
            ),
          ])}
          empty={locale === 'zh' ? '暂无已配对的执行机器' : 'No paired machines found'}
        />
      </section>
      <DaemonInstallGuide
        locale={locale}
        authConfig={authConfig}
        me={me}
        onAuthenticated={onAuthenticated}
      />
    </div>
  );
}

function SettingsView({
  data,
  locale,
  me,
  refreshConsole,
}: {
  data: ConsoleData;
  locale: Locale;
  me: Me | null;
  refreshConsole: () => Promise<void>;
}) {
  const desktop = isDesktopApp();
  const isSuperadmin = me?.role === 'superadmin';
  const [config, setConfig] = useState<DesktopConfig | null>(null);
  const [apiUrl, setApiUrl] = useState('');
  const [settingsLoading, setSettingsLoading] = useState(desktop);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [adminTokenInput, setAdminTokenInput] = useState(() => getAdminToken());
  const [apiUrlSubmitted, setApiUrlSubmitted] = useState(false);
  const [computerUsers, setComputerUsers] = useState<ComputerAccessUser[]>([]);
  const [computerUsersLoading, setComputerUsersLoading] = useState(false);
  const [savingComputerUserId, setSavingComputerUserId] = useState<string | null>(null);
  const [savingChatMemoryKey, setSavingChatMemoryKey] = useState<string | null>(null);
  const copy = {
    en: {
      desktop: 'Desktop',
      loading: 'Loading settings',
      apiServer: 'API Server',
      saved: 'API URL saved',
      reset: 'API URL reset',
      save: 'Save',
      resetButton: 'Reset',
      access: 'Access',
      adminToken: 'Admin token',
      adminTokenHint:
        'Required when the console is not served from the API host. Sent as the x-open-claude-tag-admin-token header. Stored locally in this browser.',
      adminTokenSaved: 'Admin token saved',
      adminTokenCleared: 'Admin token cleared',
      saveToken: 'Save token',
      clearToken: 'Clear token',
      computerAccess: 'Computer access',
      computerAccessHint:
        'Enabled users can run agents on the server (server-local execution). Pairing machines and binding agents to their own machines is open to everyone.',
      user: 'User',
      role: 'Role',
      serverSide: 'Server-side',
      enabled: 'Enabled',
      disabled: 'Disabled',
      computerAccessSaved: 'Computer access updated',
      loadingUsers: 'Loading users',
      noUsers: 'No platform users found',
      chatMemory: 'Chat memory',
      chatMemoryHint: 'Daily summaries use an existing agent from each chat.',
      chat: 'Chat',
      summary: 'Summary',
      defaultAgent: 'Summary agent',
      chatAgent: 'existing chat agent',
      nextSummary: 'Next summary',
      lastError: 'Last error',
      chatMemorySaved: 'Chat memory updated',
      noChats: 'No chats found',
    },
    zh: {
      desktop: '桌面端',
      loading: '正在加载设置',
      apiServer: 'API 服务',
      saved: 'API URL 已保存',
      reset: 'API URL 已重置',
      save: '保存',
      resetButton: '重置',
      access: '访问',
      adminToken: '管理令牌',
      adminTokenHint:
        '当控制台不与 API 部署在同一主机时需要填写。会作为 x-open-claude-tag-admin-token 请求头发送，并仅保存在当前浏览器本地。',
      adminTokenSaved: '管理令牌已保存',
      adminTokenCleared: '管理令牌已清除',
      saveToken: '保存令牌',
      clearToken: '清除令牌',
      computerAccess: 'Computer 权限',
      computerAccessHint:
        '开启后用户可以让智能体在服务器上运行（server-local 执行）。配对机器、绑定自己的机器对所有用户开放。',
      user: '用户',
      role: '角色',
      serverSide: 'Server-side',
      enabled: '已开启',
      disabled: '已关闭',
      computerAccessSaved: 'Computer 权限已更新',
      loadingUsers: '正在加载用户',
      noUsers: '暂无平台用户',
      chatMemory: '群聊记忆',
      chatMemoryHint: '每日总结使用各群聊中已有的 agent。',
      chat: '群聊',
      summary: '总结',
      defaultAgent: '总结 agent',
      chatAgent: '已有群聊 agent',
      nextSummary: '下一次总结',
      lastError: '最近错误',
      chatMemorySaved: '群聊记忆已更新',
      noChats: '暂无群聊',
    },
  }[locale];

  useEffect(() => {
    if (!desktop) return;

    let mounted = true;
    setSettingsLoading(true);
    setSettingsError(null);
    void getDesktopConfig()
      .then((nextConfig) => {
        if (!mounted || !nextConfig) return;
        setConfig(nextConfig);
        setApiUrl(nextConfig.apiUrl);
        setApiUrlSubmitted(false);
      })
      .catch((err) => {
        if (mounted) setSettingsError((err as Error).message);
      })
      .finally(() => {
        if (mounted) setSettingsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [desktop]);

  useEffect(() => {
    if (!isSuperadmin) {
      setComputerUsers([]);
      return;
    }

    let mounted = true;
    setComputerUsersLoading(true);
    setSettingsError(null);
    void listComputerAccessUsers()
      .then((users) => {
        if (mounted) setComputerUsers(users);
      })
      .catch((err) => {
        if (mounted) setSettingsError((err as Error).message);
      })
      .finally(() => {
        if (mounted) setComputerUsersLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [isSuperadmin]);

  async function saveApiUrl() {
    setApiUrlSubmitted(true);
    const apiUrlValidation = httpUrlError(apiUrl, copy.apiServer, locale);
    if (apiUrlValidation) return;
    setSaving(true);
    setSettingsError(null);
    setSettingsNotice(null);
    try {
      const nextConfig = await saveDesktopApiUrl(apiUrl.trim());
      setConfig(nextConfig);
      setApiUrl(nextConfig.apiUrl);
      setSettingsNotice(copy.saved);
      await refreshConsole();
    } catch (err) {
      setSettingsError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function resetApiUrl() {
    setSaving(true);
    setSettingsError(null);
    setSettingsNotice(null);
    setApiUrlSubmitted(false);
    try {
      const nextConfig = await resetDesktopApiUrl();
      setConfig(nextConfig);
      setApiUrl(nextConfig.apiUrl);
      setSettingsNotice(copy.reset);
      await refreshConsole();
    } catch (err) {
      setSettingsError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function saveAdminTokenSetting(nextToken: string = adminTokenInput) {
    setSettingsError(null);
    setSettingsNotice(null);
    const trimmed = nextToken.trim();
    setAdminToken(trimmed);
    setAdminTokenInput(trimmed);
    setSettingsNotice(trimmed ? copy.adminTokenSaved : copy.adminTokenCleared);
    await refreshConsole();
  }

  async function setComputerAccess(user: ComputerAccessUser, computerAccessEnabled: boolean) {
    setSavingComputerUserId(user.id);
    setSettingsError(null);
    setSettingsNotice(null);
    try {
      const updated = await updateComputerAccessUser(user.id, { computerAccessEnabled });
      setComputerUsers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSettingsNotice(copy.computerAccessSaved);
      await refreshConsole();
    } catch (err) {
      setSettingsError((err as Error).message);
    } finally {
      setSavingComputerUserId(null);
    }
  }

  async function setChatMemory(chat: Chat, memoryEnabled: boolean) {
    const key = `${chat.tenantKey}:${chat.chatId}`;
    setSavingChatMemoryKey(key);
    setSettingsError(null);
    setSettingsNotice(null);
    try {
      await updateChat(chat.tenantKey, chat.chatId, { memoryEnabled });
      setSettingsNotice(copy.chatMemorySaved);
      await refreshConsole();
    } catch (err) {
      setSettingsError((err as Error).message);
    } finally {
      setSavingChatMemoryKey(null);
    }
  }

  const chatMemoryPanel = (
    <section className="panel settings-panel">
      <div className="panel-title">
        <BookOpen size={18} /> {copy.chatMemory}
      </div>
      <small className="field-hint">{copy.chatMemoryHint}</small>
      <DataTable
        columns={[copy.chat, copy.summary]}
        rowKeys={data.chats.map((chat) => `${chat.tenantKey}:${chat.chatId}`)}
        rows={data.chats.map((chat) => {
          const key = `${chat.tenantKey}:${chat.chatId}`;
          const isSaving = savingChatMemoryKey === key;
          const agentName = chat.defaultAgent?.displayName ?? copy.chatAgent;
          return [
            <strong className="settings-user-label" key="chat">
              {chat.displayName}
              <small>
                {copy.defaultAgent}: {agentName}
              </small>
            </strong>,
            <div className="settings-toggle-stack" key="summary">
              <label className="toggle-row">
                <input
                  aria-label={`${copy.chatMemory} ${chat.displayName}`}
                  checked={chat.memoryEnabled}
                  disabled={isSaving}
                  onChange={(event) => {
                    void setChatMemory(chat, event.currentTarget.checked);
                  }}
                  type="checkbox"
                />
                <span>{chat.memoryEnabled ? copy.enabled : copy.disabled}</span>
              </label>
              {chat.memoryEnabled ? (
                <small className="field-hint">
                  {copy.nextSummary}: {formatDate(chat.memorySummaryNextRunAt, locale)}
                </small>
              ) : null}
              {chat.memorySummaryLastError ? (
                <small className="danger-text">
                  {copy.lastError}: {chat.memorySummaryLastError}
                </small>
              ) : null}
            </div>,
          ];
        })}
        empty={copy.noChats}
      />
    </section>
  );

  const computerAccessPanel = isSuperadmin ? (
    <section className="panel settings-panel">
      <div className="panel-title">
        <Laptop size={18} /> {copy.computerAccess}
      </div>
      <small className="field-hint">{copy.computerAccessHint}</small>
      {computerUsersLoading ? (
        <div className="loading compact-loading">
          <Loader2 className="spin" />
          {copy.loadingUsers}
        </div>
      ) : (
        <DataTable
          columns={[copy.user, copy.role, copy.serverSide]}
          rowKeys={computerUsers.map((user) => user.id)}
          rows={computerUsers.map((user) => {
            const displayName = user.displayName ?? user.email ?? shortId(user.id);
            const isRoleSuperadmin = user.role === 'superadmin';
            const isSaving = savingComputerUserId === user.id;
            return [
              <strong className="settings-user-label" key="user">
                {displayName}
                <small>{user.email ?? shortId(user.id)}</small>
              </strong>,
              <Badge
                key="role"
                value={user.role}
                label={user.role === 'superadmin' ? 'Superadmin' : 'User'}
              />,
              <label className="toggle-row" key="toggle">
                <input
                  checked={user.computerAccessEnabled}
                  disabled={isRoleSuperadmin || isSaving}
                  onChange={(event) => {
                    void setComputerAccess(user, event.currentTarget.checked);
                  }}
                  type="checkbox"
                />
                <span>{user.computerAccessEnabled ? copy.enabled : copy.disabled}</span>
              </label>,
            ];
          })}
          empty={copy.noUsers}
        />
      )}
    </section>
  ) : null;

  const adminTokenPanel = (
    <section className="panel settings-panel">
      <div className="panel-title"><Shield size={18} /> {copy.access}</div>
      <FormGrid>
        <Input
          label={copy.adminToken}
          type="password"
          value={adminTokenInput}
          placeholder="x-open-claude-tag-admin-token"
          onChange={setAdminTokenInput}
        />
        <small className="field-hint">{copy.adminTokenHint}</small>
        <div className="inline-actions">
          <button
            className="primary"
            onClick={() => void saveAdminTokenSetting()}
            type="button"
          >
            <Save size={16} />
            {copy.saveToken}
          </button>
          <button
            className="secondary"
            disabled={!adminTokenInput.trim() && !getAdminToken()}
            onClick={() => {
              void saveAdminTokenSetting('');
            }}
            type="button"
          >
            <X size={16} />
            {copy.clearToken}
          </button>
        </div>
      </FormGrid>
    </section>
  );
  const apiUrlValidation = httpUrlError(apiUrl, copy.apiServer, locale);

  if (!desktop) {
    return (
      <div className="settings-stack">
        {settingsError ? <div className="alert error">{settingsError}</div> : null}
        {settingsNotice ? (
          <div className="alert success">
            <Check size={16} />
            {settingsNotice}
          </div>
        ) : null}
        {chatMemoryPanel}
        {adminTokenPanel}
        {computerAccessPanel}
      </div>
    );
  }

  return (
    <div className="settings-stack">
      {settingsError ? <div className="alert error">{settingsError}</div> : null}
      {settingsNotice ? (
        <div className="alert success">
          <Check size={16} />
          {settingsNotice}
        </div>
      ) : null}
      {chatMemoryPanel}
      {adminTokenPanel}
      {computerAccessPanel}
      <section className="panel settings-panel">
        <div className="panel-title">
          <Settings2 size={18} /> {copy.desktop}
        </div>
        {settingsLoading ? (
          <div className="loading">
            <Loader2 className="spin" />
            {copy.loading}
          </div>
        ) : (
          <FormGrid>
            <Input
              label={copy.apiServer}
              value={apiUrl}
              placeholder={config?.defaultApiUrl ?? 'http://127.0.0.1:3000'}
              onChange={setApiUrl}
              required
              error={apiUrlSubmitted || Boolean(apiUrl) ? apiUrlValidation : undefined}
            />
            <div className="settings-summary">
              <span className={`badge ${config?.source ?? 'default'}`}>
                {config?.source ?? 'default'}
              </span>
              <code>{config?.configPath ?? ''}</code>
            </div>
            <div className="inline-actions">
              <button
                className="primary"
                disabled={saving || Boolean(apiUrlValidation)}
                onClick={saveApiUrl}
                type="button"
              >
                {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                {copy.save}
              </button>
              <button className="secondary" disabled={saving} onClick={resetApiUrl} type="button">
                <RefreshCcw size={16} />
                {copy.resetButton}
              </button>
            </div>
          </FormGrid>
        )}
      </section>
    </div>
  );
}

function DataTable({
  columns,
  rows,
  empty,
  tableClassName,
  rowKeys,
}: {
  columns: string[];
  rows: Array<Array<React.ReactNode>>;
  empty: string;
  tableClassName?: string;
  /** Stable per-row keys (entity ids). Falls back to the row index when omitted. */
  rowKeys?: Array<string | number>;
}) {
  if (rows.length === 0) return <EmptyState label={empty} />;
  return (
    <div className="table-wrap">
      <table className={tableClassName}>
        <thead>
          <tr>
            {columns.map((column, columnIndex) => (
              <th key={`${columnIndex}-${column}`}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowKeys?.[rowIndex] ?? rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`badge ${value}`}>{label ?? value}</span>;
}

function EmptyState({ label }: { label: string }) {
  return <div className="empty">{label}</div>;
}

function FormGrid({ children }: { children: React.ReactNode }) {
  return <div className="form-grid">{children}</div>;
}

function Input({
  label,
  value,
  onChange,
  disabled = false,
  placeholder,
  type = 'text',
  required = false,
  error,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  type?: string;
  required?: boolean;
  error?: string;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <label className={`field ${error ? 'has-error' : ''}`}>
      <span className={required ? 'required' : undefined}>{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        required={required}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange?.(event.currentTarget.value)}
      />
      {error ? (
        <small className="field-error" id={errorId}>
          {error}
        </small>
      ) : null}
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  placeholder,
  required = false,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  error?: string;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <label className={`field ${error ? 'has-error' : ''}`}>
      <span className={required ? 'required' : undefined}>{label}</span>
      <textarea
        id={id}
        value={value}
        placeholder={placeholder}
        rows={4}
        required={required}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {error ? (
        <small className="field-error" id={errorId}>
          {error}
        </small>
      ) : null}
    </label>
  );
}

function Select({
  label,
  value,
  options,
  labels = {},
  onChange,
  disabled = false,
  required = false,
  error,
}: {
  label: string;
  value: string;
  options: string[];
  labels?: Record<string, string>;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  error?: string;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <label className={`field ${error ? 'has-error' : ''}`}>
      <span className={required ? 'required' : undefined}>{label}</span>
      <select
        id={id}
        value={value}
        disabled={disabled}
        required={required}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option value={option} key={option || 'empty'}>
            {labels[option] ?? (option || 'none')}
          </option>
        ))}
      </select>
      {error ? (
        <small className="field-error" id={errorId}>
          {error}
        </small>
      ) : null}
    </label>
  );
}
