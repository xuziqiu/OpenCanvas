import { describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '../types';
import { repairWorkspaceIntegrityIssue } from './integrityRepair';

const snapshot: WorkspaceSnapshot = {
  schemaVersion: 4,
  vaultPath: 'browser',
  cards: [],
  projects: [],
  folders: [],
  desktop: { placements: [], viewport: { x: 0, y: 0, zoom: 1 } },
  boards: [{
    version: 4,
    id: 'board',
    fileName: 'board.json',
    title: 'Board',
    placements: [
      { id: 'missing', kind: 'card', entityId: 'gone', x: 0, y: 0, width: 200, height: 100, color: 'white' },
      { id: 'live', kind: 'text', text: '', x: 250, y: 0, width: 200, height: 100, color: 'white' },
    ],
    connectors: [{ id: 'edge', from: 'missing', to: 'live' }],
    attachments: [{ objectId: 'missing', attachedObjectId: 'live', direction: 'right', gap: 3 }],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: 'before',
    updatedAt: 'before',
  }],
};

describe('repairWorkspaceIntegrityIssue', () => {
  it('removes a bad placement and every relationship attached to it', () => {
    const repaired = repairWorkspaceIntegrityIssue(snapshot, {
      kind: 'missing-card', sourcePath: 'boards/board.json', message: 'missing',
      boardId: 'board', placementId: 'missing', repairAction: 'remove-reference',
    }, 'after');
    expect(repaired?.boards[0].placements.map((item) => item.id)).toEqual(['live']);
    expect(repaired?.boards[0].connectors).toEqual([]);
    expect(repaired?.boards[0].attachments).toEqual([]);
    expect(repaired?.boards[0].updatedAt).toBe('after');
  });
});
