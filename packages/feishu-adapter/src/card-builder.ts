import { truncateText, type RuntimeName } from '@open-tag/core-types';

export interface CardElement {
  tag: string;
  [key: string]: unknown;
}

export interface InteractiveCard {
  msg_type: 'interactive';
  card: Record<string, unknown>;
}

export const TASK_CARD_ACTION_RETRY = 'task_retry';
export const TASK_CARD_ACTION_RETRY_RUNTIME = 'task_retry_runtime';
export const WORKDIR_FORM_SUBMIT = 'workdir_form_submit';
export const WORKDIR_FORM_CANCEL = 'workdir_form_cancel';

export interface TaskCardActionValue {
  action: typeof TASK_CARD_ACTION_RETRY | typeof TASK_CARD_ACTION_RETRY_RUNTIME;
  task_id: string;
  runtime?: 'codex';
}

interface JsonV2HeaderTag {
  tag: 'text_tag';
  text: { tag: 'plain_text'; content: string };
  color: string;
}

interface JsonV2TaskCardOptions {
  title: string;
  template: string;
  taskDescription: string;
  detail?: string;
  detailLabel?: string;
  recentActivity?: string[];
  workDir?: string;
}

// Keep terminal cards conservative because richer PATCH payloads can be
// rejected by Feishu, leaving users stuck on the 90% running card.
const DETAIL_MAX_LENGTH = 2000;
const DETAIL_TRUNCATED_SUFFIX = '\n\n...(content truncated - too long)';
const RUNNING_ACTIVITY_MAX_ITEMS = 10;
const TABLE_INDEX_COLUMN_WIDTH = '80px';
const TABLE_MAX_PAGE_SIZE = 10;
const RICH_COMPLETION_REPLY_MAX_LENGTH = 3000;

interface DetailMarkdownBlock {
  kind: 'markdown';
  content: string;
}

interface DetailTableBlock {
  kind: 'table';
  headers: string[];
  rows: string[][];
}

type DetailBlock = DetailMarkdownBlock | DetailTableBlock;

type RichCompletionReplyKind = 'answer' | 'findings' | 'table';

function normalizeDetail(detail?: string): string | undefined {
  if (!detail?.trim()) {
    return undefined;
  }

  return detail;
}

function truncateDetail(detail?: string): string | undefined {
  const normalizedDetail = normalizeDetail(detail);
  if (!normalizedDetail) {
    return undefined;
  }

  return truncateText(normalizedDetail, DETAIL_MAX_LENGTH, { suffix: DETAIL_TRUNCATED_SUFFIX });
}

function buildLabeledDetail(label: string, content: string): string {
  return `**${label}**\n${content}`;
}

function trimBlockLines(lines: string[]): string | undefined {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start].trim() === '') {
    start += 1;
  }

  while (end > start && lines[end - 1].trim() === '') {
    end -= 1;
  }

  if (start === end) {
    return undefined;
  }

  return lines.slice(start, end).join('\n');
}

function isMarkdownTableRow(line: string): boolean {
  const trimmedLine = line.trim();
  return trimmedLine.startsWith('|') && trimmedLine.endsWith('|');
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
}

function parseMarkdownTableCells(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function parseDetailBlocks(detail: string): DetailBlock[] {
  const lines = detail.split('\n');
  const blocks: DetailBlock[] = [];
  let markdownBuffer: string[] = [];
  let index = 0;

  const flushMarkdownBuffer = () => {
    const content = trimBlockLines(markdownBuffer);
    if (content) {
      blocks.push({ kind: 'markdown', content });
    }
    markdownBuffer = [];
  };

  while (index < lines.length) {
    const currentLine = lines[index];
    const nextLine = lines[index + 1];

    if (
      isMarkdownTableRow(currentLine) &&
      nextLine !== undefined &&
      isMarkdownTableSeparator(nextLine)
    ) {
      const headers = parseMarkdownTableCells(currentLine);
      const rows: string[][] = [];
      index += 2;

      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        rows.push(parseMarkdownTableCells(lines[index]));
        index += 1;
      }

      if (rows.length === 0) {
        markdownBuffer.push(currentLine, nextLine);
        continue;
      }

      flushMarkdownBuffer();
      blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    markdownBuffer.push(currentLine);
    index += 1;
  }

  flushMarkdownBuffer();
  return blocks;
}

function renderMarkdownTableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function renderMarkdownTableSeparator(columnCount: number): string {
  return `|${Array.from({ length: columnCount }, () => '---').join('|')}|`;
}

function renderTableBlock(headers: string[], rows: string[][]): string {
  return [
    renderMarkdownTableRow(headers),
    renderMarkdownTableSeparator(headers.length),
    ...rows.map((row) => renderMarkdownTableRow(row)),
  ].join('\n');
}

function appendToSegment(segment: string, content: string): string {
  return segment ? `${segment}\n\n${content}` : content;
}

function splitPlainDetail(detail: string): string[] {
  const segments: string[] = [];
  for (let index = 0; index < detail.length; index += DETAIL_MAX_LENGTH) {
    segments.push(detail.slice(index, index + DETAIL_MAX_LENGTH));
  }
  return segments;
}

function splitMarkdownBlockContent(content: string, currentSegment: string): string[] {
  const segments: string[] = [];
  let remaining = content;
  let segment = currentSegment;

  while (remaining.length > 0) {
    const availableLength = segment
      ? DETAIL_MAX_LENGTH - (segment.length + 2)
      : DETAIL_MAX_LENGTH;

    if (availableLength <= 0) {
      if (segment) {
        segments.push(segment);
        segment = '';
        continue;
      }
      segments.push(remaining);
      break;
    }

    if (remaining.length <= availableLength) {
      segment = appendToSegment(segment, remaining);
      remaining = '';
      continue;
    }

    const nextChunk = remaining.slice(0, availableLength);
    segment = appendToSegment(segment, nextChunk);
    segments.push(segment);
    segment = '';
    remaining = remaining.slice(nextChunk.length);
  }

  if (segment) {
    segments.push(segment);
  }

  return segments;
}

function splitTableBlockContent(block: DetailTableBlock, currentSegment: string): string[] {
  const segments: string[] = [];
  let segment = currentSegment;
  let rowIndex = 0;

  while (rowIndex < block.rows.length) {
    const singleRowTable = renderTableBlock(block.headers, [block.rows[rowIndex]]);
    const singleRowCandidate = appendToSegment(segment, singleRowTable);

    if (segment && singleRowCandidate.length > DETAIL_MAX_LENGTH) {
      segments.push(segment);
      segment = '';
      continue;
    }

    let tableChunk = singleRowTable;
    let rowCount = 1;

    while (rowIndex + rowCount < block.rows.length) {
      const nextTableChunk = renderTableBlock(
        block.headers,
        block.rows.slice(rowIndex, rowIndex + rowCount + 1),
      );
      const nextCandidate = appendToSegment(segment, nextTableChunk);
      if (nextCandidate.length > DETAIL_MAX_LENGTH) {
        break;
      }
      tableChunk = nextTableChunk;
      rowCount += 1;
    }

    segment = appendToSegment(segment, tableChunk);
    rowIndex += rowCount;

    if (rowIndex < block.rows.length) {
      segments.push(segment);
      segment = '';
    }
  }

  if (segment) {
    segments.push(segment);
  }

  return segments;
}

export function splitTaskCardDetail(detail?: string): string[] {
  const normalizedDetail = normalizeDetail(detail);
  if (!normalizedDetail) {
    return [];
  }

  const blocks = parseDetailBlocks(normalizedDetail);
  if (!blocks.some((block) => block.kind === 'table')) {
    return splitPlainDetail(normalizedDetail);
  }

  const segments: string[] = [];
  let currentSegment = '';

  for (const block of blocks) {
    const nextSegments =
      block.kind === 'table'
        ? splitTableBlockContent(block, currentSegment)
        : splitMarkdownBlockContent(block.content, currentSegment);

    const completedSegments = nextSegments.slice(0, -1);
    segments.push(...completedSegments);
    currentSegment = nextSegments.at(-1) ?? '';
  }

  if (currentSegment) {
    segments.push(currentSegment);
  }

  return segments;
}

function buildTableColumns(headers: string[]) {
  return headers.map((header, index) => {
    const isIndexColumn = header.trim() === '#';
    return {
      name: `col_${index + 1}`,
      display_name: header,
      data_type: isIndexColumn ? 'text' : 'markdown',
      width: isIndexColumn ? TABLE_INDEX_COLUMN_WIDTH : 'auto',
      horizontal_align: isIndexColumn ? 'center' : 'left',
      vertical_align: 'top',
    };
  });
}

function buildTableRows(rows: string[][]): Array<Record<string, string>> {
  return rows.map((row) =>
    row.reduce<Record<string, string>>((result, cell, index) => {
      result[`col_${index + 1}`] = cell;
      return result;
    }, {}),
  );
}

function buildStructuredDetailElements(label: string, detail: string): CardElement[] {
  const blocks = parseDetailBlocks(detail);

  if (!blocks.some((block) => block.kind === 'table')) {
    return [
      {
        tag: 'markdown',
        content: buildLabeledDetail(label, detail),
        element_id: 'detail_markdown',
      },
    ];
  }

  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content: `**${label}**`,
      element_id: 'detail_label_markdown',
    },
  ];

  blocks.forEach((block, blockIndex) => {
    if (block.kind === 'markdown') {
      elements.push({
        tag: 'markdown',
        content: block.content,
        element_id: `detail_markdown_${blockIndex + 1}`,
      });
      return;
    }

    elements.push({
      tag: 'table',
      element_id: `detail_table_${blockIndex + 1}`,
      margin: '4px 0 0 0',
      page_size: Math.min(Math.max(block.rows.length, 1), TABLE_MAX_PAGE_SIZE),
      row_height: 'auto',
      header_style: {
        text_align: 'left',
        text_size: 'normal',
        background_style: 'grey',
        text_color: 'grey',
        bold: true,
        lines: 1,
      },
      columns: buildTableColumns(block.headers),
      rows: buildTableRows(block.rows),
    });
  });

  return elements;
}

function buildRichReplyElements(blocks: DetailBlock[]): CardElement[] {
  return blocks.map((block, blockIndex): CardElement => {
    if (block.kind === 'markdown') {
      return {
        tag: 'markdown',
        content: block.content,
        element_id: `reply_markdown_${blockIndex + 1}`,
      };
    }

    return {
      tag: 'table',
      element_id: `reply_table_${blockIndex + 1}`,
      margin: '4px 0 0 0',
      page_size: Math.min(Math.max(block.rows.length, 1), TABLE_MAX_PAGE_SIZE),
      row_height: 'auto',
      header_style: {
        text_align: 'left',
        text_size: 'normal',
        background_style: 'grey',
        text_color: 'grey',
        bold: true,
        lines: 1,
      },
      columns: buildTableColumns(block.headers),
      rows: buildTableRows(block.rows),
    };
  });
}

function isMarkdownListLine(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
}

function classifyRichCompletionReply(detail: string, blocks: DetailBlock[]): RichCompletionReplyKind {
  if (blocks.some((block) => block.kind === 'table')) {
    return 'table';
  }

  const nonEmptyLines = detail.split('\n').filter((line) => line.trim() !== '');
  const listLineCount = nonEmptyLines.filter(isMarkdownListLine).length;
  if (listLineCount >= 2 && listLineCount >= Math.ceil(nonEmptyLines.length / 2)) {
    return 'findings';
  }

  return 'answer';
}

function richCompletionReplyTitle(kind: RichCompletionReplyKind): string {
  switch (kind) {
    case 'findings':
      return 'Findings';
    case 'table':
      return 'Table';
    case 'answer':
      return 'Answer';
  }
}

function richCompletionReplyTag(kind: RichCompletionReplyKind): string {
  switch (kind) {
    case 'findings':
      return 'findings';
    case 'table':
      return 'table';
    case 'answer':
      return 'reply';
  }
}

export function buildRichCompletionReplyCard(replyText?: string): InteractiveCard | undefined {
  const normalizedDetail = normalizeDetail(replyText);
  if (!normalizedDetail || normalizedDetail.length > RICH_COMPLETION_REPLY_MAX_LENGTH) {
    return undefined;
  }

  const blocks = parseDetailBlocks(normalizedDetail);
  const kind = classifyRichCompletionReply(normalizedDetail, blocks);
  const title = richCompletionReplyTitle(kind);
  const textTagList: JsonV2HeaderTag[] = [
    {
      tag: 'text_tag',
      text: { tag: 'plain_text', content: richCompletionReplyTag(kind) },
      color: 'green',
    },
  ];

  return {
    msg_type: 'interactive',
    card: {
      schema: '2.0',
      config: {
        update_multi: true,
        width_mode: 'fill',
        enable_forward: true,
        summary: { content: title },
      },
      header: {
        title: { tag: 'plain_text', content: title },
        template: 'green',
        text_tag_list: textTagList,
      },
      body: {
        direction: 'vertical',
        padding: '8px 12px',
        vertical_spacing: '4px',
        elements: buildRichReplyElements(blocks),
      },
    },
  };
}

function buildRecentActivityContent(activity: string[]): string {
  const latestActivity = activity
    .slice(-RUNNING_ACTIVITY_MAX_ITEMS)
    .map((line, index) => `${index + 1}. ${line}`)
    .join('\n');

  return buildLabeledDetail('Recent activity', latestActivity);
}

function buildJsonV2TaskCard(options: JsonV2TaskCardOptions): InteractiveCard {
  const { title, template, taskDescription, detail, detailLabel, recentActivity, workDir } = options;
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content: taskDescription,
      element_id: 'task_markdown',
    },
  ];

  if (workDir) {
    elements.push({
      tag: 'markdown',
      content: `📁 \`${workDir}\``,
      element_id: 'workdir_markdown',
    });
  }

  if (recentActivity && recentActivity.length > 0) {
    elements.push({
      tag: 'hr',
      element_id: 'activity_divider',
    });
    elements.push({
      tag: 'markdown',
      content: buildRecentActivityContent(recentActivity),
      element_id: 'activity_markdown',
    });
  }

  if (detail?.trim()) {
    elements.push({
      tag: 'hr',
      element_id: 'detail_divider',
    });
    elements.push(...buildStructuredDetailElements(detailLabel ?? 'Details', detail));
  }

  const textTagList: JsonV2HeaderTag[] = [
    {
      tag: 'text_tag',
      text: { tag: 'plain_text', content: 'task' },
      color: 'blue',
    },
  ];

  return {
    msg_type: 'interactive',
    card: {
      schema: '2.0',
      config: {
        update_multi: true,
        width_mode: 'fill',
        enable_forward: true,
        summary: { content: title },
      },
      header: {
        title: { tag: 'plain_text', content: title },
        template,
        text_tag_list: textTagList,
      },
      body: {
        direction: 'vertical',
        padding: '8px 12px',
        vertical_spacing: '4px',
        elements,
      },
    },
  };
}

function buildTerminalCardsFromSegments(
  title: string,
  template: string,
  taskDescription: string,
  detailSegments: string[],
  detailLabel: string,
): InteractiveCard[] {
  if (detailSegments.length === 0) {
    return [
      buildJsonV2TaskCard({
        title,
        template,
        taskDescription,
      }),
    ];
  }

  return detailSegments.map((segment, index) =>
    buildJsonV2TaskCard({
      title:
        index === 0
          ? title
          : `${title} (continued ${index}/${detailSegments.length - 1})`,
      template,
      taskDescription,
      detail: segment,
      detailLabel,
    }),
  );
}

function buildTerminalCards(
  title: string,
  template: string,
  taskDescription: string,
  detail: string | undefined,
  detailLabel: string,
): InteractiveCard[] {
  return buildTerminalCardsFromSegments(
    title,
    template,
    taskDescription,
    splitTaskCardDetail(detail),
    detailLabel,
  );
}

export function buildAckCard(taskDescription: string): InteractiveCard {
  return buildJsonV2TaskCard({
    title: 'Queued',
    template: 'blue',
    taskDescription,
  });
}

export function buildRunningCard(
  taskDescription: string,
  progress?: number,
  recentActivity?: string[],
  workDir?: string,
): InteractiveCard {
  const progressText = progress !== undefined ? ` (${progress}%)` : '';
  return buildJsonV2TaskCard({
    title: `Running${progressText}`,
    template: 'orange',
    taskDescription,
    recentActivity,
    workDir,
  });
}

export function buildDoneCard(
  taskDescription: string,
  result?: string,
): InteractiveCard {
  return buildJsonV2TaskCard({
    title: 'Task complete',
    template: 'green',
    taskDescription,
    detail: truncateDetail(result),
    detailLabel: 'Result',
  });
}

export function buildFailedCard(
  taskDescription: string,
  error: string,
): InteractiveCard {
  return buildJsonV2TaskCard({
    title: 'Task failed',
    template: 'red',
    taskDescription,
    detail: truncateDetail(error),
    detailLabel: 'Error',
  });
}

export function buildDoneCards(
  taskDescription: string,
  result?: string,
): InteractiveCard[] {
  return buildTerminalCards('Task complete', 'green', taskDescription, result, 'Result');
}

export function buildDoneCardsFromSegments(
  taskDescription: string,
  detailSegments: string[],
): InteractiveCard[] {
  return buildTerminalCardsFromSegments(
    'Task complete',
    'green',
    taskDescription,
    detailSegments,
    'Result',
  );
}

export function buildFailedCards(
  taskDescription: string,
  error: string,
): InteractiveCard[] {
  return buildTerminalCards('Task failed', 'red', taskDescription, error, 'Error');
}

export function buildFailedCardsFromSegments(
  taskDescription: string,
  detailSegments: string[],
): InteractiveCard[] {
  return buildTerminalCardsFromSegments(
    'Task failed',
    'red',
    taskDescription,
    detailSegments,
    'Error',
  );
}

export interface WorkDirConfirmCardParams {
  workDir?: string;
  goal: string;
  defaultRuntime: RuntimeName;
  sessionId: string;
  chatId: string;
  replyLanguage: string;
  taskId: string;
  replyToMessageId?: string;
}

export interface WorkDirFormActionValue {
  action: typeof WORKDIR_FORM_SUBMIT | typeof WORKDIR_FORM_CANCEL;
  sessionId: string;
  chatId: string;
  taskId: string;
  replyLanguage: string;
  replyToMessageId?: string;
  /** Carried on submit button — the resolved workDir */
  workDir?: string;
  /** Carried on submit button — the extracted goal */
  goal?: string;
  /** Carried on submit button — selected runtime */
  runtime?: string;
}

export function buildWorkDirConfirmCard(params: WorkDirConfirmCardParams): InteractiveCard {
  const { workDir, goal, defaultRuntime, sessionId, chatId, replyLanguage, taskId, replyToMessageId } = params;

  const submitPayload: WorkDirFormActionValue = {
    action: WORKDIR_FORM_SUBMIT,
    sessionId,
    chatId,
    taskId,
    replyLanguage,
    ...(workDir ? { workDir } : {}),
    goal,
    runtime: defaultRuntime,
    ...(replyToMessageId ? { replyToMessageId } : {}),
  };

  const cancelPayload: WorkDirFormActionValue = {
    action: WORKDIR_FORM_CANCEL,
    sessionId,
    chatId,
    taskId,
    replyLanguage,
  };

  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Task Confirmation' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'form',
          name: 'workdir_form',
          elements: [
            {
              tag: 'input',
              name: 'workDir',
              label: { tag: 'plain_text', content: 'Working Directory' },
              default_value: workDir ?? '',
              placeholder: { tag: 'plain_text', content: 'Enter working directory path' },
            },
            {
              tag: 'input',
              name: 'goal',
              label: { tag: 'plain_text', content: 'Task Description' },
              default_value: goal,
              placeholder: { tag: 'plain_text', content: 'Enter task description' },
            },
            {
              tag: 'select_static',
              name: 'runtime',
              placeholder: { tag: 'plain_text', content: 'Select runtime' },
              initial_option: defaultRuntime,
              options: [
                {
                  text: { tag: 'plain_text', content: 'Claude Code' },
                  value: 'claude_code',
                },
                {
                  text: { tag: 'plain_text', content: 'Codex' },
                  value: 'codex',
                },
              ],
            },
            {
              tag: 'button',
              name: 'confirm',
              text: { tag: 'plain_text', content: 'Confirm' },
              type: 'primary',
              action_type: 'form_submit',
              value: submitPayload,
            },
          ],
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Cancel' },
              type: 'default',
              value: cancelPayload,
            },
          ],
        },
      ],
    },
  };
}

export function buildApprovalCard(
  changeRequestId: string,
  title: string,
  description: string,
  riskLevel: string,
): InteractiveCard {
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `🔒 Approval Request [${riskLevel.toUpperCase()}]` },
        template: riskLevel === 'high' ? 'red' : riskLevel === 'medium' ? 'orange' : 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**${title}**\n\n${description}`,
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ Approve' },
              type: 'primary',
              value: { action: 'approve', change_request_id: changeRequestId },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '❌ Reject' },
              type: 'danger',
              value: { action: 'reject', change_request_id: changeRequestId },
            },
          ],
        },
      ],
    },
  };
}
