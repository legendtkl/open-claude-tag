/**
 * Convert markdown text to Feishu post (rich text) message format.
 *
 * Feishu post format: { "zh_cn": { "title": "...", "content": [[...segments...], ...] } }
 * Each inner array is a "line" (paragraph), segments are inline elements.
 *
 * Supported conversions:
 * - # / ## / ### headers → bold text lines
 * - **bold** → bold tag
 * - `code` → inline code (text tag)
 * - ```code blocks``` → code block lines
 * - | table | → formatted text lines
 * - Plain text → text tags
 * - Blank lines → paragraph breaks
 */

interface PostSegment {
  tag: 'text' | 'a';
  text?: string;
  href?: string;
  style?: string[];
}

type PostLine = PostSegment[];

export interface PostContent {
  zh_cn: {
    title: string;
    content: PostLine[];
  };
}

export function markdownToPost(markdown: string, title?: string): PostContent {
  const lines = markdown.split('\n');
  const content: PostLine[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      content.push([{ tag: 'text', text: codeLines.join('\n'), style: ['code_block'] }]);
      continue;
    }

    // Empty line → skip (paragraph separation is implicit)
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Header lines → bold
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      content.push([{ tag: 'text', text: headerMatch[2], style: ['bold'] }]);
      i++;
      continue;
    }

    // Table rows → formatted as text with fixed width feel
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      // Skip separator rows like |---|---|
      if (/^\|[\s\-:|]+\|$/.test(line.trim())) {
        i++;
        continue;
      }
      const cells = line.split('|').filter(c => c.trim() !== '');
      content.push([{ tag: 'text', text: cells.map(c => c.trim()).join('  │  ') }]);
      i++;
      continue;
    }

    // Regular line → parse inline formatting
    content.push(parseInline(line));
    i++;
  }

  // Auto-detect title from first header if not provided
  let postTitle = title ?? '';
  if (!postTitle) {
    const firstHeader = markdown.match(/^#{1,3}\s+(.+)/m);
    if (firstHeader) {
      postTitle = firstHeader[1];
    }
  }

  // Remove first content line if it duplicates the title (avoid "Title" header + "Title" body)
  if (postTitle && content.length > 0) {
    const firstLine = content[0];
    if (firstLine.length === 1 && firstLine[0].text === postTitle) {
      content.shift();
    }
  }

  return {
    zh_cn: {
      title: postTitle,
      content,
    },
  };
}

function parseInline(text: string): PostLine {
  const segments: PostSegment[] = [];
  // Simple regex-based inline parser for **bold**, `code`, [link](url), and plain text
  const regex = /(\*\*(.+?)\*\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Add plain text before this match
    if (match.index > lastIndex) {
      segments.push({ tag: 'text', text: text.slice(lastIndex, match.index) });
    }

    if (match[1]) {
      // **bold**
      segments.push({ tag: 'text', text: match[2], style: ['bold'] });
    } else if (match[3]) {
      // `code`
      segments.push({ tag: 'text', text: match[4], style: ['code_inline'] });
    } else if (match[5]) {
      // [link](url)
      segments.push({ tag: 'a', text: match[6], href: match[7] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    segments.push({ tag: 'text', text: text.slice(lastIndex) });
  }

  if (segments.length === 0) {
    segments.push({ tag: 'text', text });
  }

  return segments;
}
