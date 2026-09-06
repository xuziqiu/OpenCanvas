import { describe, expect, it } from 'vitest';
import type { BoardPlacement } from '../types';
import { cardHeightForContent, fitPlacementsToContent, fitSectionsToContent } from './fitPlacementContent';
import { expandSectionsToMaintainPadding } from './sectionLayout';

const placement = (id: string, overrides: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id, kind: 'card', x: 100, y: 120, width: 100, height: 80, color: 'paper', ...overrides,
});

describe('fit Section to content', () => {
  it('fits a Section to related members with the standard 40px padding', () => {
    const values = [
      placement('section', { kind: 'text', text: '区块', isFrame: true, x: 0, y: 0, width: 800, height: 600 }),
      placement('left', { sectionId: 'section', sectionIds: ['section'] }),
      placement('right', { x: 400, y: 300, width: 120, height: 90, sectionId: 'section', sectionIds: ['section'] }),
    ];
    const result = fitSectionsToContent(values, new Set(['section']));
    expect(result.placements[0]).toMatchObject({ x: 60, y: 80, width: 500, height: 350, sectionBaseBounds: undefined });
    expect([...result.changedIds]).toEqual(['section']);
    expect(result.placements[1]).toBe(values[1]);
    expect(result.placements[2]).toBe(values[2]);
  });

  it('fits nested selected Sections from inner to outer', () => {
    const result = fitSectionsToContent([
      placement('outer', { kind: 'text', isFrame: true, x: 0, y: 0, width: 1000, height: 800 }),
      placement('inner', { kind: 'text', isFrame: true, x: 100, y: 100, width: 500, height: 400, sectionId: 'outer', sectionIds: ['outer'] }),
      placement('card', { x: 250, y: 220, sectionId: 'inner', sectionIds: ['inner', 'outer'] }),
    ], new Set(['outer', 'inner']));
    expect(result.placements.find((item) => item.id === 'inner')).toMatchObject({ x: 210, y: 180, width: 180, height: 160 });
    expect(result.placements.find((item) => item.id === 'outer')).toMatchObject({ x: 170, y: 140, width: 260, height: 240 });
    expect([...result.changedIds]).toEqual(['inner', 'outer']);
  });

  it('skips empty, locked and unselected Sections', () => {
    const values = [
      placement('empty', { kind: 'text', isFrame: true }),
      placement('locked', { kind: 'text', isFrame: true, locked: true }),
      placement('unselected', { kind: 'text', isFrame: true }),
      placement('member', { sectionId: 'locked', sectionIds: ['locked'] }),
    ];
    const result = fitSectionsToContent(values, new Set(['empty', 'locked']));
    expect(result.placements).toEqual(values);
    expect(result.changedIds.size).toBe(0);
  });

  it('fits expanded cards before growing their Section and enables automatic height', () => {
    expect(cardHeightForContent(211.2)).toBe(251);
    expect(cardHeightForContent(20)).toBe(145);
    const result = fitPlacementsToContent([
      placement('section', { kind: 'text', isFrame: true, x: 80, y: 80, width: 240, height: 180 }),
      placement('card', { entityId: 'card-entity', x: 100, y: 120, width: 260, height: 145, scrollTop: 70, sectionId: 'section', sectionIds: ['section'] }),
    ], new Set(['card']), { card: 360 });
    expect(result.placements.find((item) => item.id === 'card')).toMatchObject({ height: 360, autoHeight: true, scrollTop: 0 });
    expect(expandSectionsToMaintainPadding(result.placements).find((item) => item.id === 'section')).toMatchObject({ x: 60, y: 80, width: 340, height: 440, sectionBaseBounds: { x: 80, y: 80, width: 240, height: 180 } });
    expect([...result.changedIds]).toEqual(['card']);
  });

  it('fits a folded card to its natural title width without changing its saved expanded height', () => {
    const folded = placement('folded', { entityId: 'card', collapsed: true, width: 520, height: 62, expandedHeight: 360, autoHeight: true });
    const result = fitPlacementsToContent([folded], new Set(['folded']), {}, { folded: 344 });
    expect(result.placements[0]).toMatchObject({ width: 344, height: 62, expandedHeight: 360, collapsed: true, autoHeight: true });
    expect([...result.changedIds]).toEqual(['folded']);
  });

  it('skips card measurements that are absent, locked or already exact', () => {
    const exact = placement('exact', { entityId: 'card', height: 220, autoHeight: true, scrollTop: 0 });
    const values = [
      exact,
      placement('missing', { entityId: 'missing' }),
      placement('locked-card', { entityId: 'locked', locked: true }),
    ];
    const result = fitPlacementsToContent(values, new Set(values.map((item) => item.id)), { exact: 220, 'locked-card': 400 });
    expect(result.placements).toEqual(values);
    expect(result.changedIds.size).toBe(0);
  });
});
