import { describe, expect, it } from 'vitest';
import { evaluateFileTreeDrop } from './fileTreeDrop';

describe('file tree drag validation', () => {
  const folders = ['项目', '项目/资料', '归档', '归档/资料'];

  it('treats a drop into the current parent as a quiet no-op', () => {
    expect(evaluateFileTreeDrop({ kind: 'card', path: '项目/说明.md' }, '项目', folders).state).toBe('noop');
    expect(evaluateFileTreeDrop({ kind: 'folder', path: '项目/资料' }, '项目', folders).state).toBe('noop');
  });

  it('rejects moving a folder into itself or a descendant', () => {
    expect(evaluateFileTreeDrop({ kind: 'folder', path: '项目' }, '项目', folders).state).toBe('invalid');
    expect(evaluateFileTreeDrop({ kind: 'folder', path: '项目' }, '项目/资料', folders).state).toBe('invalid');
  });

  it('detects target name collisions case-insensitively', () => {
    expect(evaluateFileTreeDrop({ kind: 'folder', path: '项目/资料' }, '归档', folders)).toEqual({ state: 'invalid', message: '目标位置已有同名文件夹' });
    expect(evaluateFileTreeDrop({ kind: 'folder', path: '项目/资料' }, 'ARCHIVE', ['Archive/资料'] ).state).toBe('invalid');
  });

  it('allows a valid cross-directory move', () => {
    expect(evaluateFileTreeDrop({ kind: 'folder', path: '项目/资料' }, '', folders).state).toBe('move');
  });
});
