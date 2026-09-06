import { describe, expect, it } from 'vitest';
import { placementColorKey } from './placementColor';

describe('placementColorKey', () => {
  it('keeps native semantic and transparent colors', () => {
    expect(placementColorKey('blue')).toBe('blue');
    expect(placementColorKey('transparent')).toBe('transparent');
  });

  it('maps Obsidian Canvas numbered colors into the local palette', () => {
    expect(placementColorKey('1')).toBe('rose');
    expect(placementColorKey('4')).toBe('green');
    expect(placementColorKey('6')).toBe('purple');
  });

  it('normalizes legacy and custom hex values without mutating source data', () => {
    expect(placementColorKey('#fff')).toBe('paper');
    expect(placementColorKey('#ffffff')).toBe('paper');
    expect(placementColorKey('#121318')).toBe('ink');
    expect(placementColorKey('#e7f2e4')).toBe('green');
  });

  it('falls back safely for malformed values', () => {
    expect(placementColorKey('not-a-color')).toBe('paper');
    expect(placementColorKey(undefined)).toBe('paper');
  });
});
