import { describe, expect, it } from 'vitest';
import { placementLayerTokens } from './placementLayers';

describe('placementLayerTokens', () => {
  it('never raises a selected Section above its contents', () => {
    expect(placementLayerTokens(999, true, 0, 999)).toEqual({
      resting: 1,
      hover: 1,
      marquee: 1,
      selected: 1,
    });
  });

  it('still raises ordinary nodes for hover and selection feedback', () => {
    const layers = placementLayerTokens(2, false, 0, 6);
    expect(layers.resting).toBe(7);
    expect(layers.hover).toBeGreaterThan(layers.resting);
    expect(layers.selected).toBeGreaterThan(layers.hover);
  });
});
