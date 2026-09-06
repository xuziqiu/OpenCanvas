import { describe, expect, it } from 'vitest';
import { framePointerIntent } from './frameInteraction';

describe('frame pointer intent', () => {
  it('treats an unselected frame as transparent marquee space', () => {
    expect(framePointerIntent(true, 'frame', [])).toBe('marquee-or-select-frame');
    expect(framePointerIntent(true, 'frame', ['card'])).toBe('marquee-or-select-frame');
  });

  it('moves the frame group whenever the frame participates in the current selection', () => {
    expect(framePointerIntent(true, 'frame', ['frame'])).toBe('move-frame-group');
    expect(framePointerIntent(true, 'frame', ['frame', 'card'])).toBe('move-frame-group');
  });

  it('does not alter ordinary node gestures', () => {
    expect(framePointerIntent(false, 'card', [])).toBe('ordinary-node');
  });
});
