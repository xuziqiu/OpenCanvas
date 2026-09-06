import { describe, expect, it } from 'vitest';
import { isAdditivePlacementClick, isAdditiveSelectionModifier, marqueeHitsPlacement, togglePlacementId } from './placementSelectionGesture';

describe('placement selection gestures', () => {
  it('uses Ctrl, Command, or Shift as additive modifiers outside editable card bodies', () => {
    expect(isAdditiveSelectionModifier({ shiftKey: true, ctrlKey: false, metaKey: false })).toBe(true);
    expect(isAdditiveSelectionModifier({ shiftKey: false, ctrlKey: true, metaKey: false })).toBe(true);
    expect(isAdditiveSelectionModifier({ shiftKey: false, ctrlKey: false, metaKey: true })).toBe(true);
    expect(isAdditiveSelectionModifier({ shiftKey: false, ctrlKey: false, metaKey: false })).toBe(false);
  });

  it('uses Ctrl/Cmd on a card toolbar for additive selection', () => {
    expect(isAdditivePlacementClick({ kind: 'card', targetIsCardToolbar: true, shiftKey: false, ctrlKey: true, metaKey: false })).toBe(true);
    expect(isAdditivePlacementClick({ kind: 'card', targetIsCardToolbar: true, shiftKey: false, ctrlKey: false, metaKey: true })).toBe(true);
  });

  it('preserves the one-click edit meaning of the card body', () => {
    expect(isAdditivePlacementClick({ kind: 'card', targetIsCardToolbar: false, shiftKey: false, ctrlKey: true, metaKey: false })).toBe(false);
  });

  it('adds and removes an id without disturbing selection order', () => {
    expect(togglePlacementId(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(togglePlacementId(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('selects ordinary cards on contact but sections only when fully enclosed', () => {
    const area = { x: 0, y: 0, width: 100, height: 100 };
    const base = { id: 'p', kind: 'card' as const, x: 90, y: 90, width: 20, height: 20, color: 'paper' };
    expect(marqueeHitsPlacement(area, base)).toBe(true);
    expect(marqueeHitsPlacement(area, { ...base, kind: 'text', isFrame: true })).toBe(false);
    expect(marqueeHitsPlacement(area, { ...base, kind: 'text', x: 10, y: 10, width: 80, height: 80, isFrame: true })).toBe(true);
  });
});
