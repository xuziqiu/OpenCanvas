import { describe, expect, it } from 'vitest';
import { clampPanelWidth, nextPanelWidth, resolvePanelResize } from './panelSizing';

describe('panel sizing', () => {
  it('clamps pointer-derived widths to a usable range', () => {
    expect(clampPanelWidth(80, 208, 420)).toBe(208);
    expect(clampPanelWidth(319.6, 208, 420)).toBe(320);
    expect(clampPanelWidth(900, 208, 420)).toBe(420);
  });

  it('applies keyboard deltas using the correct panel range', () => {
    expect(nextPanelWidth(248, 16, 'left')).toBe(264);
    expect(nextPanelWidth(360, -16, 'right')).toBe(344);
    expect(nextPanelWidth(710, 32, 'right')).toBe(720);
  });

  it('commits pointer release but rolls cancellation back to the starting width', () => {
    expect(resolvePanelResize(280, 336, false)).toBe(336);
    expect(resolvePanelResize(280, 336, true)).toBe(280);
  });
});
