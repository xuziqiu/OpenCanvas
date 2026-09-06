import { describe, expect, it } from 'vitest';
import { idleInteraction } from './interaction';
import { movingRelationshipFocusIds, transitionCanvasInteraction } from './canvasInteractionMachine';

describe('canvas interaction state machine', () => {
  it('runs a pointer gesture from idle to completion', () => {
    const marquee = transitionCanvasInteraction(idleInteraction, { type: 'start-marquee', pointerId: 7 });
    expect(marquee).toEqual({ mode: 'marquee', pointerId: 7 });
    expect(transitionCanvasInteraction(marquee, { type: 'finish-pointer', pointerId: 7 })).toEqual(idleInteraction);

    const section = transitionCanvasInteraction(idleInteraction, { type: 'start-section', pointerId: 8 });
    expect(section).toEqual({ mode: 'drawing-section', pointerId: 8 });
    expect(transitionCanvasInteraction(section, { type: 'finish-pointer', pointerId: 8 })).toEqual(idleInteraction);
  });

  it('ignores completion from a stale pointer', () => {
    const moving = transitionCanvasInteraction(idleInteraction, { type: 'start-move', pointerId: 9, placementIds: ['a'] });
    expect(transitionCanvasInteraction(moving, { type: 'finish-pointer', pointerId: 8 })).toBe(moving);
  });

  it('can move directly from editing into a drag', () => {
    const editing = transitionCanvasInteraction(idleInteraction, { type: 'start-edit', placementId: 'card-a' });
    expect(transitionCanvasInteraction(editing, { type: 'start-move', pointerId: 4, placementIds: ['card-a'] })).toEqual({
      mode: 'moving',
      pointerId: 4,
      placementIds: ['card-a'],
    });
  });

  it('cancels a connector gesture', () => {
    const connecting = transitionCanvasInteraction(idleInteraction, { type: 'start-connect', fromId: 'card-a' });
    expect(connecting).toEqual({ mode: 'connecting', fromId: 'card-a' });
    expect(transitionCanvasInteraction(connecting, { type: 'cancel' })).toEqual(idleInteraction);
  });

  it('copies the moving selection into state', () => {
    const ids = ['a', 'b'];
    const moving = transitionCanvasInteraction(idleInteraction, { type: 'start-move', pointerId: 3, placementIds: ids });
    ids.push('c');
    expect(moving).toEqual({ mode: 'moving', pointerId: 3, placementIds: ['a', 'b'] });
  });

  it('dims connector relationships only during an active move', () => {
    expect(movingRelationshipFocusIds(idleInteraction)).toEqual([]);
    expect(movingRelationshipFocusIds({ mode: 'editing', placementId: 'a' })).toEqual([]);
    expect(movingRelationshipFocusIds({ mode: 'moving', pointerId: 1, placementIds: ['a', 'b'] })).toEqual(['a', 'b']);
  });
});
