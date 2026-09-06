import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeWorkspaceSnapshot } from './schema';

const legacyFixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('workspace schema migration', () => {
  it('loads the complete v1 fixture without reviving nested desktop entries or unsafe geometry', () => {
    const snapshot = normalizeWorkspaceSnapshot(legacyFixture('legacy-workspace-v1.json'));
    expect(snapshot.cards[0]).toMatchObject({ id: 'legacy-card', relativePath: '旧卡片.md' });
    expect(snapshot.boards.map((board) => board.version)).toEqual([4, 4]);
    expect(snapshot.boards[0].placements[0]).toMatchObject({ id: 'legacy-card-node', kind: 'card', entityId: 'legacy-card', width: 300, height: 145 });
    expect(snapshot.boards[0].connectors[0]).toMatchObject({ fromAnchor: 'right', toAnchor: 'left' });
    expect(snapshot.boards[0].viewport.zoom).toBe(2.4);
    expect(snapshot.desktop.viewport.zoom).toBe(.2);
    expect(snapshot.desktop.placements.map((item) => item.boardId)).toEqual(['legacy-root']);
  });

  it('loads the v3 project and Section fixture while normalizing paths and instance state', () => {
    const snapshot = normalizeWorkspaceSnapshot(legacyFixture('legacy-workspace-v3.json'));
    expect(snapshot.cards[0].relativePath).toBe('项目/资料/v3.md');
    expect(snapshot.projects[0]).toMatchObject({ id: 'v3-project', relativePath: '项目' });
    expect(snapshot.folders).toEqual(['项目/资料']);
    expect(snapshot.boards[0].projectId).toBe('v3-project');
    expect(snapshot.boards[0].viewport.zoom).toBe(.2);
    expect(snapshot.boards[0].placements[1]).toMatchObject({ sectionId: 'outer-section', sectionIds: ['outer-section'], scrollTop: 0 });
  });

  it('migrates v1 notes, nodes and edges without losing identity or geometry', () => {
    const snapshot = normalizeWorkspaceSnapshot({
      vaultPath: 'C:/vault',
      notes: [{ id: 'card-1', fileName: 'one.md', title: 'One', body: '# Body', createdAt: 'a', updatedAt: 'b' }],
      boards: [{
        version: 1,
        id: 'board-1',
        fileName: 'one.board.json',
        title: 'Board',
        nodes: [{ id: 'node-1', kind: 'note', refId: 'card-1', x: 14, y: 22, width: 500, height: 180, color: 'paper' }],
        edges: [{
          id: 'edge-1',
          from: 'node-1',
          to: 'node-2',
          beginPos: 'right',
          endPos: 'left',
          controlPoints: [{ id: 'control-1', x: 240, y: 90, direction: 'horizontal' }],
        }],
        viewport: { x: 5, y: 8, zoom: .8 },
      }],
    });
    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.cards[0].id).toBe('card-1');
    expect(snapshot.cards[0].relativePath).toBe('one.md');
    expect(snapshot.boards[0].version).toBe(4);
    expect(snapshot.boards[0].placements[0]).toMatchObject({ id: 'node-1', kind: 'card', entityId: 'card-1', x: 14, y: 22 });
    expect(snapshot.boards[0].connectors[0]).toMatchObject({
      id: 'edge-1',
      from: 'node-1',
      to: 'node-2',
      lineStyle: 'curve',
      arrow: 'end',
      width: 2,
      fromAnchor: 'right',
      toAnchor: 'left',
      controlPoints: [{ id: 'control-1', x: 240, y: 90, direction: 'horizontal' }],
    });
  });

  it('keeps project directories parallel to board references and normalizes paths', () => {
    const snapshot = normalizeWorkspaceSnapshot({
      cards: [{ id: 'card-1', fileName: 'one.md', relativePath: '项目甲\\调研\\one.md', title: 'One' }],
      projects: [{ id: 'project-1', name: '项目甲', relativePath: '/项目甲/' }],
      folders: ['项目甲\\调研', '../unsafe'],
      boards: [{ id: 'board-1', fileName: 'one.board.json', title: 'Board', projectId: 'project-1' }],
    });
    expect(snapshot.cards[0].relativePath).toBe('项目甲/调研/one.md');
    expect(snapshot.projects[0]).toMatchObject({ id: 'project-1', relativePath: '项目甲' });
    expect(snapshot.boards[0].projectId).toBe('project-1');
    expect(snapshot.folders).toEqual(['项目甲/调研', 'unsafe']);
    expect(snapshot.desktop.placements[0]).toMatchObject({ boardId: 'board-1', width: 430, height: 270 });
  });

  it('keeps desktop positions and supplies positions for newly discovered boards', () => {
    const snapshot = normalizeWorkspaceSnapshot({
      boards: [
        { id: 'board-1', fileName: 'one.board.json', title: 'One' },
        { id: 'board-2', fileName: 'two.board.json', title: 'Two' },
      ],
      desktop: {
        viewport: { x: 44, y: 55, zoom: 1.2 },
        placements: [{ boardId: 'board-1', x: 820, y: 310, width: 360, height: 220 }],
      },
    });
    expect(snapshot.desktop.viewport).toEqual({ x: 44, y: 55, zoom: 1.2 });
    expect(snapshot.desktop.placements.find((item) => item.boardId === 'board-1')).toMatchObject({ x: 820, y: 310, width: 360, height: 220 });
    expect(snapshot.desktop.placements.find((item) => item.boardId === 'board-2')).toBeTruthy();
  });

  it('removes nested boards from legacy desktop layouts while preserving root positions', () => {
    const snapshot = normalizeWorkspaceSnapshot({
      boards: [
        { id: 'root', placements: [{ id: 'child-reference', kind: 'board', entityId: 'child' }] },
        { id: 'child' },
        { id: 'other-root' },
      ],
      desktop: { placements: [
        { boardId: 'root', x: 12, y: 34, width: 460, height: 290 },
        { boardId: 'child', x: 900, y: 800, width: 430, height: 270 },
      ] },
    });
    expect(snapshot.desktop.placements).toEqual([
      expect.objectContaining({ boardId: 'root', x: 12, y: 34, width: 460, height: 290 }),
      expect.objectContaining({ boardId: 'other-root' }),
    ]);
  });

  it('keeps one recoverable desktop entry for an imported board cycle', () => {
    const snapshot = normalizeWorkspaceSnapshot({ boards: [
      { id: 'cycle-a', placements: [{ id: 'to-b', kind: 'board', entityId: 'cycle-b' }] },
      { id: 'cycle-b', placements: [{ id: 'to-a', kind: 'board', entityId: 'cycle-a' }] },
    ] });
    expect(snapshot.desktop.placements.map((item) => item.boardId)).toEqual(['cycle-a']);
  });

  it('keeps the first entity when IDs collide and reports later copies', () => {
    const snapshot = normalizeWorkspaceSnapshot({
      cards: [
        { id: 'same', relativePath: 'first.md', title: 'First' },
        { id: 'same', relativePath: 'second.md', title: 'Second' },
      ],
      boards: [
        { id: 'board', fileName: 'first.board.json', title: 'First' },
        { id: 'board', fileName: 'second.board.json', title: 'Second' },
      ],
    });
    expect(snapshot.cards.map((card) => card.title)).toEqual(['First']);
    expect(snapshot.boards.map((board) => board.title)).toEqual(['First']);
    expect(snapshot.loadIssues).toHaveLength(2);
    expect(snapshot.loadIssues?.every((issue) => issue.kind === 'duplicate-id')).toBe(true);
  });

  it('sanitizes unsafe relative path segments without escaping the vault', () => {
    const snapshot = normalizeWorkspaceSnapshot({
      cards: [{ id: 'card', fileName: 'note.md', relativePath: '../../C:\\unsafe<>:*.md' }],
      projects: [{ id: 'project', relativePath: '../项目:甲' }],
    });
    expect(snapshot.cards[0].relativePath).toBe('C-/unsafe----.md');
    expect(snapshot.projects[0].relativePath).toBe('项目-甲');
  });

  it('deduplicates placement and connector IDs inside a board', () => {
    const snapshot = normalizeWorkspaceSnapshot({
      boards: [{
        id: 'board',
        placements: [
          { id: 'node', kind: 'text', text: 'first' },
          { id: 'node', kind: 'text', text: 'second' },
        ],
        connectors: [
          { id: 'edge', from: 'node', to: 'other' },
          { id: 'edge', from: 'node', to: 'other' },
        ],
      }],
    });
    expect(snapshot.boards[0].placements).toHaveLength(1);
    expect(snapshot.boards[0].placements[0].text).toBe('first');
    expect(snapshot.boards[0].connectors).toHaveLength(1);
  });

  it('retains broken references for recovery and reports deterministic repair actions', () => {
    const snapshot = normalizeWorkspaceSnapshot({
      cards: [{ id: 'present-card', fileName: 'present.md', title: 'Present' }],
      boards: [{
        id: 'board',
        fileName: 'board.board.json',
        placements: [
          { id: 'missing-card-node', kind: 'card', entityId: 'missing-card' },
          { id: 'missing-board-node', kind: 'board', entityId: 'missing-board' },
        ],
        connectors: [{ id: 'broken-edge', from: 'missing-card-node', to: 'gone-node' }],
      }],
    });
    expect(snapshot.boards[0].placements).toHaveLength(2);
    expect(snapshot.boards[0].connectors).toHaveLength(1);
    expect(snapshot.loadIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'missing-card', placementId: 'missing-card-node', repairAction: 'remove-reference' }),
      expect.objectContaining({ kind: 'missing-board', placementId: 'missing-board-node', repairAction: 'remove-reference' }),
      expect.objectContaining({ kind: 'broken-connector', connectorId: 'broken-edge', repairAction: 'remove-connector' }),
    ]));
  });

  it('preserves repair metadata from a native vault load', () => {
    const snapshot = normalizeWorkspaceSnapshot({
      loadIssues: [{
        kind: 'missing-card',
        sourcePath: 'boards/one.board.json',
        message: 'missing',
        boardId: 'board',
        placementId: 'node',
        repairAction: 'remove-reference',
      }],
    });
    expect(snapshot.loadIssues?.[0]).toMatchObject({ boardId: 'board', placementId: 'node', repairAction: 'remove-reference' });
  });

  it('keeps only one desktop placement for each board', () => {
    const snapshot = normalizeWorkspaceSnapshot({
      boards: [{ id: 'board', fileName: 'board.board.json' }],
      desktop: { placements: [
        { boardId: 'board', x: 10, y: 20, width: 430, height: 270 },
        { boardId: 'board', x: 90, y: 100, width: 430, height: 270 },
      ] },
    });
    expect(snapshot.desktop.placements).toEqual([expect.objectContaining({ boardId: 'board', x: 10, y: 20 })]);
  });

  it('keeps independent placement scroll positions and clamps invalid values', () => {
    const snapshot = normalizeWorkspaceSnapshot({ boards: [{
      id: 'board',
      placements: [
        { id: 'one', kind: 'card', entityId: 'card', scrollTop: 128 },
        { id: 'two', kind: 'card', entityId: 'card', scrollTop: -20 },
      ],
    }] });
    expect(snapshot.boards[0].placements[0].scrollTop).toBe(128);
    expect(snapshot.boards[0].placements[1].scrollTop).toBe(0);
  });

  it('normalizes folded cards while preserving their expanded height', () => {
    const snapshot = normalizeWorkspaceSnapshot({ boards: [{
      id: 'board',
      placements: [
        { id: 'legacy-folded', kind: 'card', collapsed: true, width: 180, height: 312 },
        { id: 'native-folded', kind: 'card', collapsed: true, width: 360, height: 62, expandedHeight: 244 },
        { id: 'scaled-folded', kind: 'card', collapsed: true, width: 400, height: 88, expandedHeight: 244 },
      ],
    }] });
    expect(snapshot.boards[0].placements[0]).toMatchObject({
      collapsed: true,
      width: 280,
      height: 62,
      expandedHeight: 312,
    });
    expect(snapshot.boards[0].placements[1]).toMatchObject({
      collapsed: true,
      width: 360,
      height: 62,
      expandedHeight: 244,
    });
    expect(snapshot.boards[0].placements[2]).toMatchObject({
      collapsed: true,
      width: 400,
      height: 88,
      expandedHeight: 244,
    });
  });

  it('migrates legacy and multi-Section relations without losing the primary Section', () => {
    const snapshot = normalizeWorkspaceSnapshot({ boards: [{
      id: 'board',
      placements: [
        { id: 'legacy', kind: 'card', sectionId: 'outer' },
        { id: 'multi', kind: 'card', sectionId: 'outer', sectionIds: ['inner', 'outer', 'inner'] },
      ],
    }] });
    expect(snapshot.boards[0].placements[0]).toMatchObject({ sectionId: 'outer', sectionIds: ['outer'] });
    expect(snapshot.boards[0].placements[1]).toMatchObject({ sectionId: 'outer', sectionIds: ['outer', 'inner'] });
  });
});
