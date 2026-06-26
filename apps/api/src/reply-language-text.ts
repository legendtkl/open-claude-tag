import type { ReplyLanguage } from '@open-tag/core-types';

function localize<T>(replyLanguage: ReplyLanguage, values: { en: T; zh: T }): T {
  return replyLanguage === 'zh-CN' ? values.zh : values.en;
}

export function createApiReplyLocalizer(replyLanguage: ReplyLanguage) {
  return {
    permissionDenied(command: string): string {
      return localize(replyLanguage, {
        en: `Permission denied: ${command} is restricted to the project owner.`,
        zh: `权限不足：\`${command}\` 仅限项目 owner 使用。`,
      });
    },

    scheduleParseError(): string {
      return localize(replyLanguage, {
        en: [
          'Cannot parse time expression. Supported formats:',
          '  /schedule N分钟后 <goal>          — N minutes from now',
          '  /schedule N小时后 <goal>          — N hours from now',
          '  /schedule 今天/今晚 HH点 <goal>   — Today at HH:00',
          '  /schedule 明天 HH点 <goal>        — Tomorrow at HH:00',
          '  /schedule 2026-03-25T09:00:00 <goal>',
          '',
          'Examples:',
          '  /schedule 明天9点 implement multi-turn-conversation',
          '  /schedule 2小时后 add user authentication',
        ].join('\n'),
        zh: [
          '无法解析时间表达式，支持的格式有：',
          '  /schedule N分钟后 <goal>          — 从现在起 N 分钟后',
          '  /schedule N小时后 <goal>          — 从现在起 N 小时后',
          '  /schedule 今天/今晚 HH点 <goal>   — 今天 HH:00',
          '  /schedule 明天 HH点 <goal>        — 明天 HH:00',
          '  /schedule 2026-03-25T09:00:00 <goal>',
          '',
          '示例：',
          '  /schedule 明天9点 implement multi-turn-conversation',
          '  /schedule 2小时后 add user authentication',
        ].join('\n'),
      });
    },

    unknownCommand(command: string): string {
      return localize(replyLanguage, {
        en: `Unknown command: ${command}`,
        zh: `未知命令：${command}`,
      });
    },

    commandFailed(errorMessage: string): string {
      return localize(replyLanguage, {
        en: `Command failed: ${errorMessage}`,
        zh: `命令执行失败：${errorMessage}`,
      });
    },

    sessionNotFound(): string {
      return localize(replyLanguage, {
        en: 'Session not found.',
        zh: '未找到当前会话。',
      });
    },

    noSessionsInChat(): string {
      return localize(replyLanguage, {
        en: 'No sessions found for this chat.',
        zh: '当前聊天还没有会话。',
      });
    },

    sessionUseUsage(): string {
      return localize(replyLanguage, {
        en: 'Usage: /session use <session-id>',
        zh: '用法：/session use <session-id>',
      });
    },

    sessionUsage(): string {
      return localize(replyLanguage, {
        en: 'Usage: /session list | /session use <id> | /session worktrees | /session clean [--all | <id>]',
        zh: '用法：/session list | /session use <id> | /session worktrees | /session clean [--all | <id>]',
      });
    },

    forgetUsage(): string {
      return localize(replyLanguage, {
        en: 'Usage: /forget <keyword>',
        zh: '用法：/forget <keyword>',
      });
    },

    noPrForSession(): string {
      return localize(replyLanguage, {
        en: 'No PR/MR found for this session.',
        zh: '当前 session 还没有关联 PR/MR。',
      });
    },

    noProjectSet(): string {
      return localize(replyLanguage, {
        en: 'No project set for this session.\nUsage: /project use <name> | /project add <name> <path>',
        zh: '当前 session 还没有绑定项目。\n用法：/project use <name> | /project add <name> <path>',
      });
    },

    projectMissingUsage(action: 'add' | 'remove' | 'use'): string {
      return localize(replyLanguage, {
        en: `Usage: /project ${action} <name>${action === 'add' ? ' <path>' : ''}`,
        zh: `用法：/project ${action} <name>${action === 'add' ? ' <path>' : ''}`,
      });
    },

    currentProject(name: string, path: string): string {
      return localize(replyLanguage, {
        en: `Current project: ${name}\nPath: ${path}`,
        zh: `当前项目：${name}\nPath: ${path}`,
      });
    },

    projectMissingRecord(): string {
      return localize(replyLanguage, {
        en: 'Project not found (may have been removed).',
        zh: '未找到项目（可能已被删除）。',
      });
    },

    noProjectsRegistered(): string {
      return localize(replyLanguage, {
        en: 'No projects registered.\nUse /project add <name> <path> to register one.',
        zh: '当前还没有注册项目。\n可使用 /project add <name> <path> 注册。',
      });
    },

    registeredProjectsHeader(): string {
      return localize(replyLanguage, {
        en: 'Registered projects:\n',
        zh: '已注册项目：\n',
      });
    },

    invalidProjectPath(path: string): string {
      return localize(replyLanguage, {
        en: `Invalid path: "${path}" does not exist or is not a directory.`,
        zh: `无效路径："${path}" 不存在或不是目录。`,
      });
    },

    projectNameAlreadyRegistered(name: string): string {
      return localize(replyLanguage, {
        en: `Project name "${name}" is already registered. Use a different name or /project remove ${name} first.`,
        zh: `项目名 "${name}" 已注册。请换一个名字，或先执行 /project remove ${name}。`,
      });
    },

    projectRegistered(name: string, path: string): string {
      return localize(replyLanguage, {
        en: `Project "${name}" registered.\nPath: ${path}`,
        zh: `项目 "${name}" 已注册。\nPath: ${path}`,
      });
    },

    noProjectNamed(name: string): string {
      return localize(replyLanguage, {
        en: `No project named "${name}".`,
        zh: `未找到名为 "${name}" 的项目。`,
      });
    },

    noProjectNamedWithHint(name: string): string {
      return localize(replyLanguage, {
        en: `No project named "${name}".\nRun /project list to see available projects.`,
        zh: `未找到名为 "${name}" 的项目。\n可执行 /project list 查看可用项目。`,
      });
    },

    projectRemoved(name: string): string {
      return localize(replyLanguage, {
        en: `Project "${name}" removed.`,
        zh: `项目 "${name}" 已移除。`,
      });
    },

    sessionNowTargetingProject(name: string, path: string): string {
      return localize(replyLanguage, {
        en: `Session now targeting project "${name}".\nPath: ${path}\nSend a task prompt to start working.`,
        zh: `当前 session 已切换到项目 "${name}"。\nPath: ${path}\n直接发送任务描述即可开始工作。`,
      });
    },

    projectDetached(): string {
      return localize(replyLanguage, {
        en: 'Project detached. Session is back to self-dev mode.',
        zh: '项目绑定已解除，session 已回到 self-dev 模式。',
      });
    },

    projectSubcommandUsage(): string {
      return localize(replyLanguage, {
        en: 'Unknown /project sub-command.\nUsage: /project [add|remove|list|use|clear]',
        zh: '未知的 /project 子命令。\n用法：/project [add|remove|list|use|clear]',
      });
    },

    invalidPrUrl(prUrl: string): string {
      return localize(replyLanguage, {
        en: `Invalid PR/MR URL format stored in session: ${prUrl}`,
        zh: `session 中保存的 PR/MR URL 格式无效：${prUrl}`,
      });
    },

    mergeFailed(errorMessage: string): string {
      return localize(replyLanguage, {
        en: `Merge failed: ${errorMessage}`,
        zh: `合并失败：${errorMessage}`,
      });
    },

    prMerged(prUrl: string): string {
      return localize(replyLanguage, {
        en: `PR/MR merged: ${prUrl}`,
        zh: `PR/MR 已合并：${prUrl}`,
      });
    },

    cleanedWorktrees(total: number, names: string[]): string {
      return localize(replyLanguage, {
        en: `Cleaned ${total} worktree(s): ${names.join(', ')}`,
        zh: `已清理 ${total} 个 worktree：${names.join(', ')}`,
      });
    },

    noWorktreesFound(): string {
      return localize(replyLanguage, {
        en: 'No worktrees found.',
        zh: '未找到任何 worktree。',
      });
    },

    removedWorktree(names: string[]): string {
      return localize(replyLanguage, {
        en: `Removed worktree: ${names.join(', ')}`,
        zh: `已移除 worktree：${names.join(', ')}`,
      });
    },

    cleanupFailed(errors: string[]): string {
      return localize(replyLanguage, {
        en: `Cleanup failed: ${errors.join('; ')}`,
        zh: `清理失败：${errors.join('; ')}`,
      });
    },

    nothingToClean(): string {
      return localize(replyLanguage, {
        en: 'Nothing to clean.',
        zh: '没有可清理的内容。',
      });
    },
  };
}
