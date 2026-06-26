import { describe, it, expect } from 'vitest';
import { markdownToPost } from '../markdown-to-post.js';

describe('markdownToPost', () => {
  it('converts plain text to post segments', () => {
    const result = markdownToPost('Hello world');
    expect(result.zh_cn.content).toHaveLength(1);
    expect(result.zh_cn.content[0][0]).toEqual({ tag: 'text', text: 'Hello world' });
  });

  it('converts headers to bold text', () => {
    const result = markdownToPost('## OpenViking 调研总结\n\n### 子标题\n\n正文内容');
    expect(result.zh_cn.title).toBe('OpenViking 调研总结');
    // First header is deduplicated into title, body starts with sub-header
    expect(result.zh_cn.content[0][0]).toEqual({
      tag: 'text',
      text: '子标题',
      style: ['bold'],
    });
  });

  it('auto-detects title from first header and removes duplicate from body', () => {
    const result = markdownToPost('## My Title\n\nSome content');
    expect(result.zh_cn.title).toBe('My Title');
    // First content line should be "Some content", not "My Title" again
    expect(result.zh_cn.content[0][0].text).toBe('Some content');
  });

  it('uses provided title over auto-detected', () => {
    const result = markdownToPost('## Auto Title\n\nContent', 'Custom Title');
    expect(result.zh_cn.title).toBe('Custom Title');
  });

  it('converts **bold** inline', () => {
    const result = markdownToPost('This is **important** text');
    const line = result.zh_cn.content[0];
    expect(line).toHaveLength(3);
    expect(line[0]).toEqual({ tag: 'text', text: 'This is ' });
    expect(line[1]).toEqual({ tag: 'text', text: 'important', style: ['bold'] });
    expect(line[2]).toEqual({ tag: 'text', text: ' text' });
  });

  it('converts `code` inline', () => {
    const result = markdownToPost('Use `viking://` protocol');
    const line = result.zh_cn.content[0];
    expect(line[1]).toEqual({ tag: 'text', text: 'viking://', style: ['code_inline'] });
  });

  it('converts [links](url)', () => {
    const result = markdownToPost('Visit [GitHub](https://github.com)');
    const line = result.zh_cn.content[0];
    expect(line[1]).toEqual({ tag: 'a', text: 'GitHub', href: 'https://github.com' });
  });

  it('converts code blocks', () => {
    const md = '```python\ndef hello():\n    print("hi")\n```';
    const result = markdownToPost(md);
    expect(result.zh_cn.content[0][0]).toEqual({
      tag: 'text',
      text: 'def hello():\n    print("hi")',
      style: ['code_block'],
    });
  });

  it('converts table rows to formatted text', () => {
    const md = '| 目录 | 用途 |\n|------|------|\n| `resources/` | 项目文档 |';
    const result = markdownToPost(md);
    // Header row
    expect(result.zh_cn.content[0][0].text).toContain('目录');
    expect(result.zh_cn.content[0][0].text).toContain('用途');
    // Separator row should be skipped
    // Data row
    expect(result.zh_cn.content[1][0].text).toContain('resources/');
  });

  it('skips empty lines', () => {
    const result = markdownToPost('Line 1\n\n\nLine 2');
    expect(result.zh_cn.content).toHaveLength(2);
  });

  it('handles complex markdown with multiple features', () => {
    const md = `## OpenViking 调研总结

### 项目概述

OpenViking 是由字节跳动开源的 **AI Agent 上下文数据库**。

| 目录 | 用途 |
|------|------|
| \`resources/\` | 项目文档 |`;

    const result = markdownToPost(md);
    expect(result.zh_cn.title).toBe('OpenViking 调研总结');
    expect(result.zh_cn.content.length).toBeGreaterThanOrEqual(4);
  });
});
