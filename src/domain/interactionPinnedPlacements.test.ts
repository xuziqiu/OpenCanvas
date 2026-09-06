import { describe, expect, it } from 'vitest';
import { interactionPinnedPlacementIds } from './interactionPinnedPlacements';

describe('interactionPinnedPlacementIds', () => {
  it('keeps every member of a moving section live during spatial-index freezing', () => {
    expect(interactionPinnedPlacementIds({ mode: 'moving', pointerId: 7, placementIds: ['section', 'card-a', 'card-b'] }))
      .toEqual(['section', 'card-a', 'card-b']);
  });

  it('keeps the active resize placement live', () => {
    expect(interactionPinnedPlacementIds({ mode: 'resizing', pointerId: 3, placementId: 'card-a' }))
      .toEqual(['card-a']);
  });

  it('does not pin placements for non-spatial interactions', () => {
    expect(interactionPinnedPlacementIds({ mode: 'idle' })).toEqual([]);
    expect(interactionPinnedPlacementIds({ mode: 'editing', placementId: 'card-a' })).toEqual([]);
  });
});
