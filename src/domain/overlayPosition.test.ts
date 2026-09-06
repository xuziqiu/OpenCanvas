import { describe, expect, it } from 'vitest';
import { caretMenuPosition, clampOverlayPosition } from './overlayPosition';

describe('floating overlay positioning', () => {
  it('never produces negative coordinates in a viewport smaller than the menu', () => {
    expect(clampOverlayPosition({ x: 200, y: 200, width: 320, height: 520, viewportWidth: 240, viewportHeight: 180 })).toEqual({
      x: 8, y: 8, maxWidth: 224, maxHeight: 164,
    });
  });

  it('keeps a normal menu inside the lower-right viewport edge', () => {
    expect(clampOverlayPosition({ x: 780, y: 560, width: 236, height: 320, viewportWidth: 900, viewportHeight: 640 })).toMatchObject({ x: 656, y: 312 });
  });

  it('opens a caret menu above when there is no room below', () => {
    expect(caretMenuPosition(
      { left: 500, top: 580, bottom: 600 },
      { left: 248, top: 58, width: 652 },
      { width: 900, height: 640 },
      { width: 250, height: 290 },
    )).toEqual({ left: 252, top: 225 });
  });
});
