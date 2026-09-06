import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import WelcomeTour from './WelcomeTour';

vi.mock('../store', () => ({
  useWorkspaceStore: (selector: (state: { chooseVault: () => Promise<void> }) => unknown) => selector({ chooseVault: async () => undefined }),
}));

describe('WelcomeTour', () => {
  it('starts with the local-first data ownership explanation', () => {
    const html = renderToStaticMarkup(<WelcomeTour onDismiss={() => undefined} />);
    expect(html).toContain('资料始终属于你');
    expect(html).toContain('卡片保存为 Markdown');
    expect(html).toContain('第 1 步，共 3 步');
    expect(html).toContain('稍后自己探索');
  });
});
