import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import UserGuide from './UserGuide';

describe('UserGuide', () => {
  it('ships the version-matched offline manual with navigation and safety guidance', () => {
    const html = renderToStaticMarkup(<UserGuide onClose={() => undefined} />);

    expect(html).toContain('OpenCanvas 用户手册');
    expect(html).toContain('aria-label="搜索用户手册"');
    expect(html).toContain('卡片：创建、选择、编辑和复制');
    expect(html).toContain('导入、导出与格式损失');
    expect(html).toContain('保存、历史、回收站与恢复');
    expect(html).toContain('升级、卸载与备份');
    expect(html).toContain('200 MB');
    expect(html).toContain('href="#13-');
    expect(html).toContain('id="13-导入-导出与格式损失"');
  });
});
