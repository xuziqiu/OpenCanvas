import { MarkdownManager } from '@tiptap/markdown';
import { describe, expect, it } from 'vitest';
import { createCardEditorExtensions } from './cardEditorExtensions';
import { joinMarkdownDocument, localAttachmentPath, splitMarkdownDocument, toEditorMarkdown, toSourceMarkdown } from './markdownDocument';

const markdownCorpus = [
  '# 一级标题\n\n## 二级标题\n\n###### 六级标题\n',
  '**粗体** *斜体* ~~删除线~~ ++下划线++ ==高亮== `行内代码`\n',
  '- 第一项\n  - 嵌套项\n\n1. 编号\n2. 列表\n',
  '- [x] 已完成\n- [ ] 待处理\n',
  '> 引用内容\n\n---\n\n```ts\nconst answer = 42\n```\n',
  '| 名称 | 数值 |\n| --- | ---: |\n| 示例 | 42 |\n',
  '[普通链接](https://example.com) ![图片](attachments/example.png)\n',
  '带标题的链接 [说明](https://example.com "标题") 与锚点 [章节](#本地章节)\n',
  'Wiki 引用 [[项目/卡片#章节|显示名]] 与嵌入 ![[attachments/example.png]]\n',
  '<audio data-opencanvas-media="true" data-name="录音" src="attachments/demo.mp3" controls></audio>\n\n<video data-opencanvas-media="true" data-name="演示" src="attachments/demo.mp4" controls></video>\n',
  '行内公式 $x^2$\n\n$$\ny = ax + b\n$$\n',
];

describe('Markdown document boundaries', () => {
  it('preserves unknown frontmatter byte-for-byte', () => {
    const source = '---\r\ntitle: 示例\r\nunknown-field: keep-me\r\ntags:\r\n  - 测试\r\n---\r\n# 正文\r\n';
    const parts = splitMarkdownDocument(source);
    expect(parts.frontmatter).toBe('---\r\ntitle: 示例\r\nunknown-field: keep-me\r\ntags:\r\n  - 测试\r\n---\r\n');
    expect(joinMarkdownDocument(parts)).toBe(source);
  });

  it('does not mistake an unclosed divider for frontmatter', () => {
    const source = '---\n正文';
    expect(splitMarkdownDocument(source)).toEqual({ frontmatter: '', body: source });
  });

  it('round-trips local attachment URLs between source and editor forms', () => {
    const source = '![截图](attachments/中文 图片.png)\n<video src="attachments/demo.mp4"></video>';
    expect(toSourceMarkdown(toEditorMarkdown(source))).toBe(source);
    expect(toSourceMarkdown('![截图](opencanvas-asset://vault/attachments/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png)'))
      .toBe('![截图](attachments/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png)');
    expect(localAttachmentPath('opencanvas-asset://vault/attachments/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png')).toBe('attachments/中文 图片.png');
    expect(localAttachmentPath('../outside.txt')).toBeNull();
  });
});

describe('card editor Markdown corpus', () => {
  const manager = new MarkdownManager({ extensions: createCardEditorExtensions() });

  for (const [index, source] of markdownCorpus.entries()) {
    it(`keeps corpus sample ${index + 1} semantically stable`, () => {
      const document = manager.parse(source);
      const serialized = manager.serialize(document);
      expect(manager.parse(serialized)).toEqual(document);
    });
  }

  it('keeps portable Wiki link syntax usable outside OpenCanvas', () => {
    const source = '链接到 [[项目/卡片#章节|显示名]] 与 ![[attachments/example.png]]\n';
    const serialized = manager.serialize(manager.parse(source));
    expect(serialized).toContain('[[项目/卡片#章节|显示名]]');
    expect(serialized).toContain('![[attachments/example.png]]');
  });

  it('saves audio and video as standard readable HTML instead of private block syntax', () => {
    const source = '<audio data-opencanvas-media="true" data-name="录音" src="attachments/demo.mp3" controls></audio>\n';
    const serialized = manager.serialize(manager.parse(source));
    expect(serialized).toContain('<audio controls data-opencanvas-media="true"');
    expect(serialized).toContain('src="attachments/demo.mp3"');
    expect(serialized).not.toContain(':::media');
    expect(manager.parse(serialized)).toEqual(manager.parse(source));
  });

  it('round-trips resized images through portable HTML dimensions', () => {
    const source = '<img src="attachments/diagram.png" alt="结构图" width="480">\n';
    const serialized = manager.serialize(manager.parse(source));
    expect(serialized).toContain('<img src="attachments/diagram.png" alt="结构图" width="480">');
    expect(manager.parse(serialized)).toEqual(manager.parse(source));
  });

  it('round-trips ordinary file attachments with portable metadata', () => {
    const source = '<a href="attachments/report.pdf" data-opencanvas-attachment="true" data-name="报告.pdf" data-mime-type="application/pdf" data-size="2048">报告.pdf</a>\n';
    const serialized = manager.serialize(manager.parse(source));
    expect(serialized).toContain('href="attachments/report.pdf"');
    expect(serialized).toContain('data-size="2048"');
    expect(manager.parse(serialized)).toEqual(manager.parse(source));
  });

  it('keeps a dense mixed document stable as one tree', () => {
    const source = [
      '# 混合内容压力文档',
      '',
      '正文包含 **粗体**、*斜体*、==高亮==、$x^2$ 和 [[项目/卡片|Wiki 引用]]。',
      '',
      '- [x] 已完成',
      '- [ ] 待处理',
      '',
      '> 引用里的 [外部链接](https://example.com/path?q=1)。',
      '',
      '| 名称 | 数值 |',
      '| --- | ---: |',
      '| 示例 | 42 |',
      '',
      '```typescript',
      'const answer: number = 42',
      '```',
      '',
      '![结构图](attachments/%E7%BB%93%E6%9E%84%20%E5%9B%BE.png)',
      '',
      '<audio controls data-opencanvas-media="true" data-name="访谈录音" src="attachments/interview.mp3"></audio>',
      '',
      '<a href="attachments/report.pdf" data-opencanvas-attachment="true" data-name="报告.pdf" data-mime-type="application/pdf" data-size="2048">报告.pdf</a>',
      '',
      '$$',
      'y = ax + b',
      '$$',
      '',
    ].join('\n');
    const document = manager.parse(source);
    const serialized = manager.serialize(document);
    expect(manager.parse(serialized)).toEqual(document);
    expect(serialized).toContain('attachments/%E7%BB%93%E6%9E%84%20%E5%9B%BE.png');
    expect(serialized).toContain('data-opencanvas-media="true"');
    expect(serialized).toContain('data-opencanvas-attachment="true"');
  });
});
