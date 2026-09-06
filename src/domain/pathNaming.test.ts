import { describe, expect, it } from 'vitest';
import { normalizeUserFolderPath, persistenceErrorMessage, sanitizeFileName, sanitizePathSegment, sanitizeRelativeFilePath } from './pathNaming';

describe('Windows-safe user paths', () => {
  it('keeps ordinary Chinese names and folder structure intact', () => {
    expect(normalizeUserFolderPath('客户项目\\研究资料/访谈')).toBe('客户项目/研究资料/访谈');
  });

  it('removes invalid characters and trailing dots or spaces', () => {
    expect(sanitizePathSegment('  计划:<第一版>?...  ')).toBe('计划--第一版--');
    expect(normalizeUserFolderPath('项目. /阶段二.../')).toBe('项目/阶段二');
  });

  it('escapes Windows device names including names with extensions', () => {
    for (const name of ['CON', 'prn', 'AUX.txt', 'nul.md', 'COM1', 'lpt9.log']) {
      expect(sanitizePathSegment(name).startsWith('_')).toBe(true);
    }
    expect(sanitizePathSegment('com10')).toBe('com10');
  });

  it('preserves the requested extension after truncation', () => {
    expect(sanitizeFileName(`${'很长'.repeat(100)}.md`, 'card', '.md')).toMatch(/\.md$/);
    expect(sanitizeFileName('CON.md', 'card', '.md')).toBe('_CON.md');
  });

  it('sanitizes imported paths without flattening their folders', () => {
    expect(sanitizeRelativeFilePath('项目./PRN/CON.md', 'card', '.md')).toBe('项目/_PRN/_CON.md');
  });
});

describe('persistence error messages', () => {
  it('turns native filesystem failures into actionable Chinese messages', () => {
    expect(persistenceErrorMessage(new Error('ENAMETOOLONG: name too long'))).toContain('路径过长');
    expect(persistenceErrorMessage(new Error('EACCES: permission denied'))).toContain('没有写入权限');
    expect(persistenceErrorMessage(new Error('EBUSY: resource busy or locked'))).toContain('占用');
    expect(persistenceErrorMessage(new Error('ENOSPC: no space left'))).toContain('空间不足');
  });

  it('keeps an unknown technical message for diagnosis', () => {
    expect(persistenceErrorMessage(new Error('custom failure'))).toBe('custom failure');
  });
});
