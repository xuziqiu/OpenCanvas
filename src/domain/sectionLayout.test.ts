import { describe, expect, it } from 'vitest';
import type { BoardPlacement } from '../types';
import {
  SECTION_PADDING,
  applyPlacementLayoutChange,
  expandSectionsToMaintainPadding,
  reconcileSectionMembershipChanges,
  sectionBoundsForPlacements,
  sectionDescendants,
  sectionDragPlacementIds,
  sectionForPlacement,
  containingSectionIdsForPlacement,
  prospectiveSectionIdsForPlacements,
  sectionMembershipRoots,
  sectionMembershipSettlementIds,
  sectionMembers,
  snapBoxToSectionPadding,
} from './sectionLayout';

const placement = (id: string, x: number, y: number, width = 100, height = 80, extra: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id, kind: 'card', x, y, width, height, color: 'paper', ...extra,
});

describe('section geometry', () => {
  it('creates an exact uniform padded bound around selected objects', () => {
    expect(sectionBoundsForPlacements([placement('a', 100, 120), placement('b', 360, 260, 140, 90)])).toEqual({
      x: 60, y: 80, width: 480, height: 310,
    });
  });

  it('snaps member edges to the section inner padding', () => {
    const section = placement('section', 0, 0, 500, 400, { kind: 'text', isFrame: true });
    expect(snapBoxToSectionPadding(placement('a', 44, 282, 100, 80), section)).toMatchObject({ x: SECTION_PADDING, y: 280 });
  });

  it('expands only the necessary section edges when a member violates padding', () => {
    const section = placement('section', 0, 0, 500, 400, { kind: 'text', isFrame: true });
    const member = placement('a', -10, 350, 100, 80, { sectionId: section.id });
    const [nextSection] = expandSectionsToMaintainPadding([section, member]);
    expect(nextSection).toMatchObject({ x: -50, y: 0, width: 550, height: 470 });
    expect(nextSection.sectionBaseBounds).toEqual({ x: 0, y: 0, width: 500, height: 400 });
  });

  it('restores manual section bounds after temporary edge pressure disappears', () => {
    const section = placement('section', 0, 0, 500, 400, { kind: 'text', isFrame: true });
    const pressed = placement('a', -10, 100, 100, 80, { sectionId: section.id, sectionIds: [section.id] });
    const expanded = expandSectionsToMaintainPadding([section, pressed]);
    const relaxed = expandSectionsToMaintainPadding([
      expanded[0],
      { ...pressed, x: 80 },
    ]);
    expect(relaxed[0]).toMatchObject({ x: 0, y: 0, width: 500, height: 400 });
    expect(relaxed[0].sectionBaseBounds).toBeUndefined();
  });

  it('does not let an already expanded Section chase a departing member across the canvas', () => {
    const expandedSection = placement('section', -400, 0, 900, 900, {
      kind: 'text',
      isFrame: true,
      sectionBaseBounds: { x: 0, y: 0, width: 500, height: 400 },
    });
    const departed = placement('card', -360, 700, 100, 80, { sectionId: expandedSection.id, sectionIds: [expandedSection.id] });
    const [restored] = expandSectionsToMaintainPadding([expandedSection, departed]);
    expect(restored).toMatchObject({ x: 0, y: 0, width: 500, height: 400 });
    expect(restored.sectionBaseBounds).toBeUndefined();
  });

  it('translates a Section auto-grow base during moves but resets it for manual resizes', () => {
    const section = placement('section', -40, 0, 540, 400, {
      kind: 'text',
      isFrame: true,
      sectionBaseBounds: { x: 0, y: 0, width: 500, height: 400 },
    });
    expect(applyPlacementLayoutChange(section, { x: 60, y: 80 }).sectionBaseBounds).toEqual({ x: 100, y: 80, width: 500, height: 400 });
    expect(applyPlacementLayoutChange(section, { width: 600 }).sectionBaseBounds).toBeUndefined();
  });

  it('accepts an explicit gesture base instead of accumulating an elastic edge offset', () => {
    const section = placement('section', -40, 0, 540, 400, {
      kind: 'text',
      isFrame: true,
      sectionBaseBounds: { x: 0, y: 0, width: 500, height: 400 },
    });
    const nextBase = { x: 240, y: 60, width: 500, height: 400 };
    expect(applyPlacementLayoutChange(section, {
      x: 200,
      y: 60,
      sectionBaseBounds: nextBase,
    }).sectionBaseBounds).toEqual(nextBase);
  });

  it('recognizes both sectionId members and legacy frame groups', () => {
    const section = placement('section', 0, 0, 500, 400, { kind: 'text', isFrame: true, groupId: 'legacy' });
    expect(sectionForPlacement(placement('modern', 0, 0, 100, 80, { sectionId: section.id }), [section])).toBe(section);
    expect(sectionForPlacement(placement('old', 0, 0, 100, 80, { groupId: 'legacy' }), [section])).toBe(section);
  });

  it('uses full containment to enter and overlap to retain ordinary Section membership', () => {
    const left = placement('left-section', 0, 0, 300, 300, { kind: 'text', isFrame: true });
    const right = placement('right-section', 200, 0, 300, 300, { kind: 'text', isFrame: true });
    const card = placement('card', 240, 80, 100, 80, { sectionId: left.id, sectionIds: [left.id] });
    expect(reconcileSectionMembershipChanges([left, right, card], [card.id])).toEqual({
      card: { sectionId: left.id, sectionIds: [left.id, right.id] },
    });
  });

  it('does not claim a new Section from edge contact alone', () => {
    const section = placement('section', 0, 0, 300, 300, { kind: 'text', isFrame: true });
    const entering = placement('entering', 260, 80, 100, 80);
    expect(containingSectionIdsForPlacement(entering, [section, entering])).toEqual([]);
    expect(reconcileSectionMembershipChanges([section, entering], [entering.id])).toEqual({});
  });

  it('reports retained and newly contained Sections during an ordinary-object drag', () => {
    const left = placement('left-section', 0, 0, 300, 300, { kind: 'text', isFrame: true });
    const right = placement('right-section', 200, 0, 300, 300, { kind: 'text', isFrame: true });
    const boardInstance = placement('board-instance', 240, 80, 100, 80, { kind: 'board', sectionId: left.id, sectionIds: [left.id] });
    expect(containingSectionIdsForPlacement(boardInstance, [left, right, boardInstance])).toEqual([left.id, right.id]);
    expect(prospectiveSectionIdsForPlacements([left, right, boardInstance], [boardInstance.id])).toEqual([left.id, right.id]);
  });

  it('reports only the moved Section root parent and never its own descendants', () => {
    const parent = placement('parent', 0, 0, 900, 700, { kind: 'text', isFrame: true });
    const moved = placement('moved', 80, 80, 500, 400, { kind: 'text', isFrame: true, sectionId: parent.id, sectionIds: [parent.id] });
    const child = placement('child', 140, 140, 120, 90, { sectionId: moved.id, sectionIds: [moved.id, parent.id] });
    expect(prospectiveSectionIdsForPlacements([parent, moved, child], [moved.id, child.id])).toEqual([parent.id]);
  });

  it('removes membership after a card fully leaves a section', () => {
    const section = placement('section', 0, 0, 300, 300, { kind: 'text', isFrame: true });
    const card = placement('card', 420, 80, 100, 80, { sectionId: section.id, sectionIds: [section.id] });
    expect(reconcileSectionMembershipChanges([section, card], [card.id])).toEqual({
      card: { sectionId: undefined, sectionIds: undefined },
    });
  });

  it('requires complete containment for nested sections and returns recursive descendants', () => {
    const outer = placement('outer', 0, 0, 800, 600, { kind: 'text', isFrame: true });
    const inner = placement('inner', 80, 80, 400, 300, { kind: 'text', isFrame: true });
    const card = placement('card', 120, 120, 100, 80, { sectionIds: [outer.id, inner.id], sectionId: outer.id });
    const nested = { ...inner, ...reconcileSectionMembershipChanges([outer, inner, card], [inner.id]).inner };
    expect(nested.sectionIds).toEqual([outer.id]);
    expect(sectionMembers(outer, [outer, nested, card]).map((item) => item.id)).toEqual(['inner', 'card']);
    expect(sectionDescendants(outer, [outer, nested, card]).map((item) => item.id)).toEqual(['inner', 'card']);

    const clipped = { ...nested, x: -20 };
    expect(reconcileSectionMembershipChanges([outer, clipped, card], [clipped.id])).toEqual({
      inner: { sectionId: undefined, sectionIds: undefined },
    });
  });

  it('settles only the outer roots when a Section carries nested content', () => {
    const outer = placement('outer', 0, 0, 800, 600, { kind: 'text', isFrame: true });
    const inner = placement('inner', 80, 80, 400, 300, { kind: 'text', isFrame: true, sectionId: outer.id, sectionIds: [outer.id] });
    const card = placement('card', 120, 120, 100, 80, { sectionId: inner.id, sectionIds: [inner.id, outer.id] });
    expect(sectionMembershipRoots([outer.id, inner.id, card.id], [outer, inner, card])).toEqual([outer.id]);
  });

  it('expands a parent/child Section multi-selection without translating descendants twice', () => {
    const outer = placement('outer', 0, 0, 800, 600, { kind: 'text', isFrame: true });
    const inner = placement('inner', 80, 80, 400, 300, { kind: 'text', isFrame: true, sectionId: outer.id, sectionIds: [outer.id] });
    const card = placement('card', 120, 120, 100, 80, { sectionId: inner.id, sectionIds: [inner.id, outer.id] });
    const outside = placement('outside', 900, 100);
    expect(sectionDragPlacementIds([outer.id, inner.id, outside.id], [outer, inner, card, outside])).toEqual([
      outer.id, inner.id, card.id, outside.id,
    ]);
  });

  it('leaves locked Section descendants stationary during an ancestor drag', () => {
    const outer = placement('outer', 0, 0, 800, 600, { kind: 'text', isFrame: true });
    const locked = placement('locked', 80, 80, 120, 100, { locked: true, sectionId: outer.id, sectionIds: [outer.id] });
    const movable = placement('movable', 260, 80, 120, 100, { sectionId: outer.id, sectionIds: [outer.id] });
    expect(sectionDragPlacementIds([outer.id], [outer, locked, movable])).toEqual([outer.id, movable.id]);
  });

  it('also settles stationary descendants when their Section moves away', () => {
    const original = placement('section', 0, 0, 500, 400, { kind: 'text', isFrame: true });
    const locked = placement('locked', 80, 90, 100, 80, { locked: true, sectionId: original.id, sectionIds: [original.id] });
    const moved = { ...original, x: 700 };
    const settlementIds = sectionMembershipSettlementIds([moved.id], [moved, locked]);
    expect(settlementIds).toEqual([moved.id, locked.id]);
    expect(reconcileSectionMembershipChanges([moved, locked], settlementIds)).toEqual({
      locked: { sectionId: undefined, sectionIds: undefined },
    });
  });

  it('keeps and pads a locked member while the moved Section still overlaps it', () => {
    const original = placement('section', 0, 0, 500, 400, { kind: 'text', isFrame: true });
    const locked = placement('locked', 80, 90, 100, 80, { locked: true, sectionId: original.id, sectionIds: [original.id] });
    const moved = { ...original, x: 100 };
    const settlementIds = sectionMembershipSettlementIds([moved.id], [moved, locked]);
    expect(reconcileSectionMembershipChanges([moved, locked], settlementIds)).toEqual({});
    expect(expandSectionsToMaintainPadding([moved, locked])[0]).toMatchObject({ x: 40, width: 560 });
  });

  it('keeps the padding snap threshold constant in screen space at extreme zoom', () => {
    const section = placement('section', 0, 0, 500, 400, { kind: 'text', isFrame: true });
    for (const zoom of [.2, 1, 2.4]) {
      const insideThreshold = placement('inside', SECTION_PADDING + 8 / zoom, 120);
      expect(snapBoxToSectionPadding(insideThreshold, section, { zoom }).x).toBe(SECTION_PADDING);
      const outsideThreshold = placement('outside', SECTION_PADDING + 10 / zoom, 120);
      expect(snapBoxToSectionPadding(outsideThreshold, section, { zoom }).x).toBe(outsideThreshold.x);
    }
  });

  it('propagates nested edge pressure through multiple Sections and restores every manual base', () => {
    const outer = placement('outer', 0, 0, 1000, 800, { kind: 'text', isFrame: true });
    const middle = placement('middle', 80, 80, 700, 520, { kind: 'text', isFrame: true, sectionId: outer.id, sectionIds: [outer.id] });
    const inner = placement('inner', 140, 140, 420, 300, { kind: 'text', isFrame: true, sectionId: middle.id, sectionIds: [middle.id, outer.id] });
    const card = placement('card', 100, 180, 180, 120, { sectionId: inner.id, sectionIds: [inner.id, middle.id, outer.id] });
    const expanded = expandSectionsToMaintainPadding([outer, middle, inner, card]);
    expect(expanded.find((item) => item.id === 'inner')).toMatchObject({ x: 60, width: 500 });
    expect(expanded.find((item) => item.id === 'middle')).toMatchObject({ x: 20, width: 760 });
    expect(expanded.find((item) => item.id === 'outer')).toMatchObject({ x: -20, width: 1020 });

    const relaxed = expandSectionsToMaintainPadding(expanded.map((item) => item.id === 'card' ? { ...item, x: 220 } : item));
    expect(relaxed.find((item) => item.id === 'inner')).toMatchObject({ x: 140, width: 420, sectionBaseBounds: undefined });
    expect(relaxed.find((item) => item.id === 'middle')).toMatchObject({ x: 80, width: 700, sectionBaseBounds: undefined });
    expect(relaxed.find((item) => item.id === 'outer')).toMatchObject({ x: 0, width: 1000, sectionBaseBounds: undefined });
  });
});
