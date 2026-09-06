import { describe, expect, it } from 'vitest';
import { stripBrowserDerivedState } from './browserWorkspacePersistence';
import { normalizeWorkspaceSnapshot } from './schema';

describe('browser workspace persistence', () => {
  it('drops stale integrity findings and recalculates only live problems', () => {
    const stored = {
      cards: [],
      boards: [],
      loadIssues: [{ kind: 'invalid-file', sourcePath: 'old-file', message: 'stale' }],
      recovery: { recovered: ['old'], discarded: [] },
    };

    const snapshot = normalizeWorkspaceSnapshot(stripBrowserDerivedState(stored));
    expect(snapshot.loadIssues).toBeUndefined();
    expect(snapshot.recovery).toBeUndefined();
  });
});
