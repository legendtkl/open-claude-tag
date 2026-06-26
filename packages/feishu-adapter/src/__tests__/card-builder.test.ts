import { describe, it, expect } from 'vitest';
import {
  buildAckCard,
  buildRunningCard,
  buildDoneCard,
  buildDoneCards,
  buildDoneCardsFromSegments,
  buildFailedCard,
  buildFailedCards,
  buildFailedCardsFromSegments,
  buildRichCompletionReplyCard,
  buildApprovalCard,
  buildWorkDirConfirmCard,
  splitTaskCardDetail,
} from '../card-builder.js';

function extractDetailBody(card: any): string | undefined {
  const elements = card.card.body.elements as Array<{ tag: string; content?: string }>;
  const detailElement = [...elements].reverse().find((element) => element.tag === 'markdown' && element.content?.includes('**'));
  if (!detailElement?.content) {
    return undefined;
  }

  return detailElement.content.replace(/^\*\*(Result|Error)\*\*\n/, '');
}

function buildOverflowTableDetail(rowCount: number): string {
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const rowId = index + 1;
    return `| ${rowId} | scenario ${rowId} ${'s'.repeat(60)} | given ${'g'.repeat(
      120,
    )} | when ${'w'.repeat(120)} | then ${'t'.repeat(120)} |`;
  });

  return [
    'Suggested verification cases:',
    '',
    '| # | Scenario | GIVEN | WHEN | THEN |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function buildOverflowTableMarkdown(rowCount: number): string {
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const rowId = index + 1;
    return `| ${rowId} | scenario ${rowId} ${'s'.repeat(60)} | given ${'g'.repeat(
      120,
    )} | when ${'w'.repeat(120)} | then ${'t'.repeat(120)} |`;
  });

  return [
    '| # | Scenario | GIVEN | WHEN | THEN |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function buildMixedOverflowDetail(rowCount: number): string {
  return [
    `Overview paragraph ${'o'.repeat(900)}`,
    '',
    buildOverflowTableMarkdown(rowCount),
    '',
    `Closing notes ${'c'.repeat(900)}`,
  ].join('\n');
}

function buildMalformedTableLikeDetail(blockCount: number): string {
  return Array.from({ length: blockCount }, (_, index) =>
    [
      `Broken table fragment ${index + 1}`,
      '| # | Scenario | GIVEN |',
      '| this is not a separator |',
      `| ${index + 1} | row | value |`,
      `Trailing explanation ${'x'.repeat(220)}`,
    ].join('\n'),
  ).join('\n\n');
}

function extractTableElements(
  card: any,
): Array<{ columns: Array<{ display_name: string }>; rows: Array<Record<string, string>> }> {
  return (card.card.body.elements as Array<Record<string, unknown>>).filter(
    (element) => element.tag === 'table',
  ) as unknown as Array<{
    columns: Array<{ display_name: string }>;
    rows: Array<Record<string, string>>;
  }>;
}

function extractRowIds(cards: any[]): string[] {
  return cards.flatMap((card) =>
    extractTableElements(card).flatMap((table) => table.rows.map((row) => row.col_1)),
  );
}

function extractBodyElements(card: any): Array<{ tag: string; content?: string }> {
  return (card.card.body.elements as Array<{ tag: string; content?: string }>);
}

describe('card-builder', () => {
  it('builds a generic rich completion reply card', () => {
    const card = buildRichCompletionReplyCard(
      '我看了这张图，主题是 AI Agent 工程化治理，核心是权限、执行和安全边界。',
    );

    expect(card).toBeDefined();
    expect(card!.msg_type).toBe('interactive');
    expect((card!.card as any).schema).toBe('2.0');
    expect((card!.card as any).header.title.content).toBe('Answer');
    expect((card!.card as any).header.template).toBe('green');
    expect((card!.card as any).header.text_tag_list[0].text.content).toBe('reply');
    const elements = (card!.card as any).body.elements;
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      tag: 'markdown',
      element_id: 'reply_markdown_1',
      content: '我看了这张图，主题是 AI Agent 工程化治理，核心是权限、执行和安全边界。',
    });
  });

  it('builds a findings rich completion reply card for markdown lists', () => {
    const reply = [
      '- 主线从模型能力转向 Agent 工程化治理。',
      '- 风险集中在权限审计、浏览器执行和本地模型供应链。',
      '- 开源关注点包括 SkillSpector、Kronos、LMCache。',
    ].join('\n');

    const card = buildRichCompletionReplyCard(reply);

    expect(card).toBeDefined();
    expect((card!.card as any).header.title.content).toBe('Findings');
    expect((card!.card as any).header.text_tag_list[0].text.content).toBe('findings');
    const markdown = (card!.card as any).body.elements[0];
    expect(markdown.content).toBe(reply);
  });

  it('builds a table rich completion reply card from markdown table content', () => {
    const reply = [
      '下面是我整理的要点：',
      '',
      '| # | Area | Signal |',
      '|---|---|---|',
      '| 1 | 权限 | 访问控制变得更重要 |',
      '| 2 | 执行 | 本地工具和浏览器执行成为重点 |',
      '',
      '整体看，这是从模型能力到工程治理的转向。',
    ].join('\n');

    const card = buildRichCompletionReplyCard(reply);

    expect(card).toBeDefined();
    expect((card!.card as any).header.title.content).toBe('Table');
    const elements = (card!.card as any).body.elements;
    expect(elements).toHaveLength(3);
    expect(elements[0]).toMatchObject({
      tag: 'markdown',
      content: '下面是我整理的要点：',
    });
    expect(elements[1]).toMatchObject({
      tag: 'table',
      page_size: 2,
    });
    expect(elements[1].columns.map((column: any) => column.display_name)).toEqual([
      '#',
      'Area',
      'Signal',
    ]);
    expect(elements[1].rows).toEqual([
      {
        col_1: '1',
        col_2: '权限',
        col_3: '访问控制变得更重要',
      },
      {
        col_1: '2',
        col_2: '执行',
        col_3: '本地工具和浏览器执行成为重点',
      },
    ]);
    expect(elements[2]).toMatchObject({
      tag: 'markdown',
      content: '整体看，这是从模型能力到工程治理的转向。',
    });
  });

  it('does not build a rich completion reply card when the reply is too large', () => {
    expect(buildRichCompletionReplyCard('x'.repeat(3001))).toBeUndefined();
  });

  it('builds ACK card with compact layout', () => {
    const card = buildAckCard('写一个排序函数');
    expect(card.msg_type).toBe('interactive');
    expect((card.card as any).schema).toBe('2.0');
    expect((card.card as any).header?.template).toBe('blue');
    expect((card.card as any).header?.title.content).toContain('Queued');
    const body = (card.card as any).body;
    expect(body.padding).toBe('8px 12px');
    expect(body.vertical_spacing).toBe('4px');
    expect(body.elements).toHaveLength(1);
    expect(body.elements[0].tag).toBe('markdown');
    expect(body.elements[0].content).toBe('写一个排序函数');
    expect(body.elements.some((element: any) => element.content?.includes('**State**'))).toBe(false);
  });

  it('builds RUNNING card with progress', () => {
    const card = buildRunningCard('分析代码', 50);
    expect((card.card as any).header?.title.content).toContain('50%');
    expect((card.card as any).header?.template).toBe('orange');
    expect((card.card as any).body.elements).toHaveLength(1);
  });

  it('builds RUNNING card with recent activity window', () => {
    const activity = Array.from({ length: 12 }, (_, index) => `step ${index + 1}`);
    const card = buildRunningCard('Running: pnpm test', 75, activity);
    const elements = (card.card as any).body.elements;
    expect(elements).toHaveLength(3);
    expect(elements[0].content).toBe('Running: pnpm test');
    expect(elements[1].tag).toBe('hr');
    expect(elements[2].tag).toBe('markdown');
    expect(elements[2].content).toContain('**Recent activity**');
    expect(elements[2].content).toContain('1. step 3');
    expect(elements[2].content).toContain('10. step 12');
    expect(elements[2].content).not.toContain('\n1. step 1\n');
  });

  it('renders reasoning summaries in the existing running-card activity timeline', () => {
    const card = buildRunningCard('Executing with codex...', 42, [
      '[reasoning] Reviewing worker event flow',
      '[stdout] pnpm test',
    ]);

    const elements = (card.card as any).body.elements;
    expect(elements).toHaveLength(3);
    expect(elements[2].content).toContain('**Recent activity**');
    expect(elements[2].content).toContain('1. [reasoning] Reviewing worker event flow');
    expect(elements[2].content).toContain('2. [stdout] pnpm test');
  });

  it('builds DONE card with short result inline', () => {
    const card = buildDoneCard('写排序函数', 'function sort() 已实现');
    expect((card.card as any).header?.template).toBe('green');
    const elements = (card.card as any).body.elements;
    expect(elements).toHaveLength(3);
    expect(elements[0].content).toBe('写排序函数');
    expect(elements[1].tag).toBe('hr');
    expect(elements[2].tag).toBe('markdown');
    expect(elements[2].content).toContain('**Result**');
    expect(elements[2].content).toContain('function sort() 已实现');
  });

  it('does not render recent activity on done cards', () => {
    const card = buildDoneCard('写排序函数', 'function sort() 已实现');
    const elements = (card.card as any).body.elements;
    expect(elements.some((element: any) => element.content?.includes('**Recent activity**'))).toBe(
      false,
    );
  });

  it('builds DONE card without result section when result is empty', () => {
    const card = buildDoneCard('编写一个快排代码', '');
    expect((card.card as any).header?.template).toBe('green');
    const elements = (card.card as any).body.elements;
    expect(elements).toHaveLength(1);
    expect(elements[0].content).toBe('编写一个快排代码');
  });

  it('builds DONE card without result section when result is omitted', () => {
    const card = buildDoneCard('编写一个快排代码');
    expect((card.card as any).body.elements).toHaveLength(1);
  });

  it('renders markdown test case tables as native Feishu tables with a compact index column', () => {
    const result = [
      '建议确认的测试用例如下：',
      '',
      '| # | Scenario | GIVEN | WHEN | THEN |',
      '|---|---|---|---|---|',
      '| 1 | Happy path | User is in a session | They send `/schedule 30m fix X` | Task is scheduled |',
      '| 2 | Default path | User is in a session | They send `fix X` | Task uses default runtime |',
    ].join('\n');

    const card = buildDoneCard('fix runtime codex routing regression', result);
    const elements = (card.card as any).body.elements;

    expect(elements).toHaveLength(5);
    expect(elements[0].content).toBe('fix runtime codex routing regression');
    expect(elements[1].tag).toBe('hr');
    expect(elements[2]).toMatchObject({
      tag: 'markdown',
      content: '**Result**',
    });
    expect(elements[3]).toMatchObject({
      tag: 'markdown',
      content: '建议确认的测试用例如下：',
    });
    expect(elements[4]).toMatchObject({
      tag: 'table',
      page_size: 2,
      row_height: 'auto',
    });
    expect(elements[4].columns[0]).toMatchObject({
      display_name: '#',
      width: '80px',
      horizontal_align: 'center',
      data_type: 'text',
    });
    expect(elements[4].columns[1]).toMatchObject({
      display_name: 'Scenario',
      data_type: 'markdown',
      horizontal_align: 'left',
    });
    expect(elements[4].rows).toEqual([
      {
        col_1: '1',
        col_2: 'Happy path',
        col_3: 'User is in a session',
        col_4: 'They send `/schedule 30m fix X`',
        col_5: 'Task is scheduled',
      },
      {
        col_1: '2',
        col_2: 'Default path',
        col_3: 'User is in a session',
        col_4: 'They send `fix X`',
        col_5: 'Task uses default runtime',
      },
    ]);
  });

  it('builds DONE card truncates result over 2000 chars for single-card callers', () => {
    const longResult = 'x'.repeat(5000);
    const card = buildDoneCard('编写一个快排代码', longResult);
    const elements = (card.card as any).body.elements;
    expect(elements).toHaveLength(3);
    expect(elements[2].tag).toBe('markdown');
    const detailContent = elements[2].content as string;
    expect(detailContent).toContain('**Result**');
    expect(detailContent).toHaveLength(2000 + '\n\n...(content truncated - too long)'.length + '**Result**\n'.length);
    expect(detailContent).toContain('content truncated');
  });

  it('builds DONE cards that split long result into ordered continuation cards without truncation', () => {
    const longResult = 'x'.repeat(4500);
    const cards = buildDoneCards('编写一个快排代码', longResult);

    expect(cards).toHaveLength(3);
    expect((cards[0].card as any).header?.title.content).toBe('Task complete');
    expect((cards[1].card as any).header?.title.content).toContain('continued');
    expect((cards[2].card as any).header?.title.content).toContain('continued');
    expect(cards.map((card) => extractDetailBody(card)).join('')).toBe(longResult);
    expect(cards.map((card) => extractDetailBody(card)).join('')).not.toContain('content truncated');
  });

  it('builds DONE cards from precomputed segments without changing card output', () => {
    const result = buildMixedOverflowDetail(12);
    const detailSegments = splitTaskCardDetail(result);

    expect(buildDoneCardsFromSegments('summarize verification matrix', detailSegments)).toEqual(
      buildDoneCards('summarize verification matrix', result),
    );
  });

  it('builds FAILED card truncates error over 2000 chars for single-card callers', () => {
    const longError = 'e'.repeat(5000);
    const card = buildFailedCard('编译项目', longError);
    const elements = (card.card as any).body.elements;
    expect(elements).toHaveLength(3);
    expect(elements[2].tag).toBe('markdown');
    const detailContent = elements[2].content as string;
    expect(detailContent).toContain('**Error**');
    expect(detailContent).toHaveLength(2000 + '\n\n...(content truncated - too long)'.length + '**Error**\n'.length);
    expect(detailContent).toContain('content truncated');
  });

  it('builds FAILED cards that split long error into ordered continuation cards without truncation', () => {
    const longError = 'e'.repeat(4500);
    const cards = buildFailedCards('编译项目', longError);

    expect(cards).toHaveLength(3);
    expect((cards[0].card as any).header?.title.content).toBe('Task failed');
    expect((cards[1].card as any).header?.title.content).toContain('continued');
    expect((cards[2].card as any).header?.title.content).toContain('continued');
    expect(cards.map((card) => extractDetailBody(card)).join('')).toBe(longError);
    expect(cards.map((card) => extractDetailBody(card)).join('')).not.toContain('content truncated');
  });

  it('builds FAILED cards from precomputed segments without changing card output', () => {
    const error = buildMixedOverflowDetail(12);
    const detailSegments = splitTaskCardDetail(error);

    expect(buildFailedCardsFromSegments('summarize verification matrix', detailSegments)).toEqual(
      buildFailedCards('summarize verification matrix', error),
    );
  });

  it('builds DONE overflow cards that preserve table headers and complete rows in every continuation card', () => {
    const result = buildOverflowTableDetail(12);
    const cards = buildDoneCards('summarize verification matrix', result);

    expect(cards.length).toBeGreaterThan(1);
    for (const card of cards) {
      const tables = extractTableElements(card);
      expect(tables).toHaveLength(1);
      expect(tables[0].columns.map((column) => column.display_name)).toEqual([
        '#',
        'Scenario',
        'GIVEN',
        'WHEN',
        'THEN',
      ]);
      for (const row of tables[0].rows) {
        expect(row.col_1).toMatch(/^\d+$/);
      }
    }

    expect(extractRowIds(cards)).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
  });

  it('builds FAILED overflow cards that preserve table headers and complete rows in every continuation card', () => {
    const error = buildOverflowTableDetail(12);
    const cards = buildFailedCards('summarize verification matrix', error);

    expect(cards.length).toBeGreaterThan(1);
    for (const card of cards) {
      const tables = extractTableElements(card);
      expect(tables).toHaveLength(1);
      expect(tables[0].columns.map((column) => column.display_name)).toEqual([
        '#',
        'Scenario',
        'GIVEN',
        'WHEN',
        'THEN',
      ]);
      for (const row of tables[0].rows) {
        expect(row.col_1).toMatch(/^\d+$/);
      }
    }

    expect(extractRowIds(cards)).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
  });

  it('builds DONE overflow cards that preserve prose blocks around paginated tables', () => {
    const result = buildMixedOverflowDetail(12);
    const cards = buildDoneCards('summarize verification matrix', result);

    expect(cards.length).toBeGreaterThan(1);
    expect(extractRowIds(cards)).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));

    const firstElements = extractBodyElements(cards[0]);
    const lastElements = extractBodyElements(cards.at(-1));

    const introIndex = firstElements.findIndex(
      (element) => element.tag === 'markdown' && element.content?.includes('Overview paragraph'),
    );
    const firstTableIndex = firstElements.findIndex((element) => element.tag === 'table');
    const lastTableIndex = lastElements.findIndex((element) => element.tag === 'table');
    const closingIndex = lastElements.findIndex(
      (element) => element.tag === 'markdown' && element.content?.includes('Closing notes'),
    );

    expect(introIndex).toBeGreaterThan(-1);
    expect(firstTableIndex).toBeGreaterThan(introIndex);
    expect(lastTableIndex).toBeGreaterThan(-1);
    expect(closingIndex).toBeGreaterThan(lastTableIndex);
  });

  it('treats malformed table-like markdown as plain markdown continuation content', () => {
    const result = buildMalformedTableLikeDetail(6);
    const cards = buildDoneCards('summarize verification matrix', result);

    expect(cards.length).toBeGreaterThan(1);
    expect(cards.every((card) => extractTableElements(card).length === 0)).toBe(true);

    const markdownContent = cards
      .flatMap((card) => extractBodyElements(card))
      .filter((element) => element.tag === 'markdown')
      .map((element) => element.content ?? '')
      .join('\n');

    expect(markdownContent).toContain('Broken table fragment 1');
    expect(markdownContent).toContain('| this is not a separator |');
    expect(markdownContent).toContain('| 1 | row | value |');
  });

  it('builds FAILED card with short error inline', () => {
    const card = buildFailedCard('编译项目', 'TypeScript error');
    expect((card.card as any).header?.template).toBe('red');
    const elements = (card.card as any).body.elements;
    expect(elements).toHaveLength(3);
    expect(elements[2].tag).toBe('markdown');
    expect(elements[2].content).toContain('**Error**');
    expect(elements[2].content).toContain('TypeScript error');
  });

  it('builds approval card with approve/reject buttons', () => {
    const card = buildApprovalCard('cr_001', '优化 prompt', '修改 system prompt', 'medium');
    expect((card.card as any).header?.template).toBe('orange');
    const actionElement = (card.card as any).elements.find((e: any) => e.tag === 'action') as {
      actions?: Array<{ value?: { action?: string } }>;
    };
    expect(actionElement).toBeDefined();
    expect(actionElement!.actions).toHaveLength(2);
    expect(actionElement!.actions![0].value?.action).toBe('approve');
    expect(actionElement!.actions![1].value?.action).toBe('reject');
  });

  it('builds high risk approval card with red template', () => {
    const card = buildApprovalCard('cr_002', 'Deploy', 'Deploy to prod', 'high');
    expect((card.card as any).header?.template).toBe('red');
  });

  it('builds a workdir confirmation card with extracted runtime defaults', () => {
    const card = buildWorkDirConfirmCard({
      workDir: '/tmp/project',
      goal: 'compare cards',
      defaultRuntime: 'codex',
      sessionId: 'session_1',
      chatId: 'chat_1',
      replyLanguage: 'en-US',
      taskId: 'task_1',
      replyToMessageId: 'msg_1',
    });

    const form = (card.card as any).elements[0];
    const runtimeSelect = form.elements.find((element: any) => element.name === 'runtime');
    const confirmButton = form.elements.find((element: any) => element.name === 'confirm');

    expect(runtimeSelect.initial_option).toBe('codex');
    expect(confirmButton.value).toMatchObject({
      action: 'workdir_form_submit',
      workDir: '/tmp/project',
      goal: 'compare cards',
      runtime: 'codex',
      replyToMessageId: 'msg_1',
    });
  });

  it('builds a runtime-only confirmation card with blank workdir input', () => {
    const card = buildWorkDirConfirmCard({
      goal: 'compare cards',
      defaultRuntime: 'codex',
      sessionId: 'session_1',
      chatId: 'chat_1',
      replyLanguage: 'en-US',
      taskId: 'task_1',
    });

    const form = (card.card as any).elements[0];
    const workDirInput = form.elements.find((element: any) => element.name === 'workDir');
    const runtimeSelect = form.elements.find((element: any) => element.name === 'runtime');

    expect(workDirInput.default_value).toBe('');
    expect(runtimeSelect.initial_option).toBe('codex');
  });

  it('builds RUNNING card with workDir element after task description', () => {
    const card = buildRunningCard('编写排序函数', 30, undefined, '/workspace/my-project');
    const elements = (card.card as any).body.elements as Array<{ tag: string; content?: string; element_id?: string }>;
    expect(elements).toHaveLength(2);
    expect(elements[0].content).toBe('编写排序函数');
    const workDirElement = elements.find((e) => e.element_id === 'workdir_markdown');
    expect(workDirElement).toBeDefined();
    expect(workDirElement!.content).toBe('📁 `/workspace/my-project`');
  });

  it('builds RUNNING card without workDir element when workDir is absent', () => {
    const card = buildRunningCard('编写排序函数', 30);
    const elements = (card.card as any).body.elements as Array<{ element_id?: string }>;
    expect(elements.some((e) => e.element_id === 'workdir_markdown')).toBe(false);
  });

  it('builds RUNNING card with both workDir and recent activity in correct order', () => {
    const card = buildRunningCard('运行测试', 50, ['step 1', 'step 2'], '/repo');
    const elements = (card.card as any).body.elements as Array<{ tag: string; element_id?: string }>;
    const ids = elements.map((e) => e.element_id);
    expect(ids).toEqual(['task_markdown', 'workdir_markdown', 'activity_divider', 'activity_markdown']);
  });

  it('DONE card does not include workDir element', () => {
    const card = buildDoneCard('任务完成', '结果输出');
    const elements = (card.card as any).body.elements as Array<{ element_id?: string }>;
    expect(elements.some((e) => e.element_id === 'workdir_markdown')).toBe(false);
  });

  it('FAILED card does not include workDir element', () => {
    const card = buildFailedCard('任务失败', '出错了');
    const elements = (card.card as any).body.elements as Array<{ element_id?: string }>;
    expect(elements.some((e) => e.element_id === 'workdir_markdown')).toBe(false);
  });
});
