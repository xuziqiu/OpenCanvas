import { describe, expect, it } from 'vitest';
import { formatDiagnosticSummary } from './diagnostics';

describe('formatDiagnosticSummary', () => {
  it('reports support metadata without workspace content', () => {
    const output = formatDiagnosticSummary({
      appVersion: '1.0.10', electronVersion: '43.2.0', chromiumVersion: '144', nodeVersion: '24',
      platform: 'win32', arch: 'x64', packaged: true, automatedTest: false, vaultPath: 'D:/Notes',
    }, { cards: 3, boards: 2, folders: 1, projects: 1, saveState: '已保存', integrityIssues: 0 });

    expect(output).toContain('应用版本: 1.0.10');
    expect(output).toContain('3 张卡片 / 2 块白板');
    expect(output).toContain('不包含笔记正文');
  });
});
