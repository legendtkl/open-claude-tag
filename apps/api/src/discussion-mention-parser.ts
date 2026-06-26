import type { NormalizedEvent } from '@open-tag/core-types';
import {
  agentBotBindings,
  agents,
  feishuApps,
  resolveActiveAgentByBotBinding,
} from '@open-tag/storage';
import type { AgentAccessContext, Database } from '@open-tag/storage';
import { and, eq, or } from 'drizzle-orm';

export interface DiscussionMentionedAgent {
  agentId: string;
  feishuAppId: string;
  handle: string;
  displayName: string;
  mentionName: string;
  mentionOpenId: string;
  mentionKey: string;
  mentionIndex: number;
  role: string | null;
}

export function normalizeMentionName(name: string): string {
  return name.trim().replace(/^@+/, '');
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractRawText(event: NormalizedEvent): string {
  const raw = event.content.raw as
    | {
        message?: { content?: string };
        event?: { message?: { content?: string } };
      }
    | undefined;
  const content = raw?.message?.content ?? raw?.event?.message?.content;
  if (!content) return event.content.text ?? event.content.args ?? '';

  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? event.content.text ?? event.content.args ?? '';
  } catch {
    return event.content.text ?? event.content.args ?? '';
  }
}

export function renderRawMentionText(event: NormalizedEvent): string {
  let text = extractRawText(event);
  for (const mention of event.content.mentions ?? []) {
    if (!mention.key) continue;
    const label = normalizeMentionName(mention.name);
    text = text.split(mention.key).join(label ? `@${label}` : '');
  }
  return text;
}

export function extractTextWithoutMentions(event: NormalizedEvent): string {
  let text = extractRawText(event);
  for (const mention of event.content.mentions ?? []) {
    if (!mention.key) continue;
    text = text.split(mention.key).join(' ');
  }
  return text
    .replace(/(^|\s)@[^，,。；;\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseRoleForMention(renderedText: string, mentionName: string): string | null {
  const label = normalizeMentionName(mentionName);
  if (!label) return null;

  const mentionPattern = `@${escapeRegExp(label)}`;
  const directPattern = new RegExp(
    `${mentionPattern}\\s*(?:你是|作为|担任|负责)?\\s*([^，,。；;\\n\\s]{1,24})`,
  );
  const direct = directPattern.exec(renderedText)?.[1]?.trim();
  if (direct && direct !== '/discuss') {
    return direct;
  }

  const reversePattern = new RegExp(
    `([^，,。；;\\n\\s]{1,24})\\s*(?:由|给)\\s*${mentionPattern}`,
  );
  return reversePattern.exec(renderedText)?.[1]?.trim() ?? null;
}

export async function resolveDiscussionMentionedAgents(
  db: Database,
  event: NormalizedEvent,
  access: AgentAccessContext,
): Promise<DiscussionMentionedAgent[]> {
  const renderedText = renderRawMentionText(event);
  const seenAgents = new Set<string>();
  const result: DiscussionMentionedAgent[] = [];
  const mentions = [...(event.content.mentions ?? [])].sort(
    (left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER),
  );

  for (const mention of mentions) {
    const openId = mention.id.trim();
    if (!openId) continue;

    const [binding] = await db
      .select({
        feishuAppId: agentBotBindings.feishuAppId,
        botOpenId: agentBotBindings.botOpenId,
        appBotOpenId: feishuApps.botOpenId,
        appId: feishuApps.appId,
      })
      .from(agentBotBindings)
      .innerJoin(feishuApps, eq(agentBotBindings.feishuAppId, feishuApps.id))
      .where(
        and(
          eq(agentBotBindings.status, 'active'),
          eq(feishuApps.status, 'enabled'),
          or(
            eq(agentBotBindings.botOpenId, openId),
            eq(feishuApps.botOpenId, openId),
            eq(feishuApps.appId, openId),
          ),
          or(eq(feishuApps.tenantKey, event.tenantKey), eq(feishuApps.tenantKey, 'default')),
        ),
      )
      .limit(1);

    if (!binding) continue;
    const agent = await resolveActiveAgentByBotBinding(
      db,
      { feishuAppId: binding.feishuAppId, tenantKey: event.tenantKey },
      access,
    );
    if (!agent || seenAgents.has(agent.id)) continue;

    const renderedMention = normalizeMentionName(mention.name);
    const renderedMentionIndex = renderedMention
      ? renderedText.indexOf(`@${renderedMention}`)
      : -1;
    seenAgents.add(agent.id);
    result.push({
      agentId: agent.id,
      feishuAppId: binding.feishuAppId,
      handle: agent.handle,
      displayName: agent.displayName,
      mentionName: mention.name,
      mentionOpenId: binding.botOpenId ?? binding.appBotOpenId ?? binding.appId ?? openId,
      mentionKey: mention.key ?? '',
      mentionIndex:
        renderedMentionIndex >= 0
          ? renderedMentionIndex
          : (mention.index ?? Number.MAX_SAFE_INTEGER),
      role: parseRoleForMention(renderedText, mention.name),
    });
  }

  const bindingRows = await db
    .select({
      feishuAppId: agentBotBindings.feishuAppId,
      botOpenId: agentBotBindings.botOpenId,
      appBotOpenId: feishuApps.botOpenId,
      appId: feishuApps.appId,
      appBotName: feishuApps.botName,
      handle: agents.handle,
      displayName: agents.displayName,
    })
    .from(agentBotBindings)
    .innerJoin(feishuApps, eq(agentBotBindings.feishuAppId, feishuApps.id))
    .innerJoin(agents, eq(agentBotBindings.agentId, agents.id))
    .where(
      and(
        eq(agentBotBindings.status, 'active'),
        eq(feishuApps.status, 'enabled'),
        eq(agents.status, 'active'),
        or(eq(feishuApps.tenantKey, event.tenantKey), eq(feishuApps.tenantKey, 'default')),
      ),
    );

  for (const row of bindingRows) {
    const aliases = [row.handle, row.displayName, row.appBotName]
      .map((alias) => normalizeMentionName(alias ?? ''))
      .filter((alias): alias is string => Boolean(alias));
    const matchedAlias = aliases.find((alias) => renderedText.includes(`@${alias}`));
    if (!matchedAlias) continue;

    const agent = await resolveActiveAgentByBotBinding(
      db,
      { feishuAppId: row.feishuAppId, tenantKey: event.tenantKey },
      access,
    );
    if (!agent || seenAgents.has(agent.id)) continue;

    const mentionName = row.displayName || row.handle;
    seenAgents.add(agent.id);
    result.push({
      agentId: agent.id,
      feishuAppId: row.feishuAppId,
      handle: agent.handle,
      displayName: agent.displayName,
      mentionName,
      mentionOpenId: row.botOpenId ?? row.appBotOpenId ?? row.appId ?? '',
      mentionKey: `@${matchedAlias}`,
      mentionIndex: renderedText.indexOf(`@${matchedAlias}`),
      role: parseRoleForMention(renderedText, mentionName),
    });
  }

  return result.sort((left, right) => left.mentionIndex - right.mentionIndex);
}
