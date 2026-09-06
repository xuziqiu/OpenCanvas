import { describe, expect, it } from 'vitest';
import { focusCardTransition, sidePanelTransition } from './uiSlice';

const base = {
  focusedCardId: null,
  focusTransitionSource: null,
  sidePanelCardId: 'card-side',
  sidePanelOpen: true,
} as const;

describe('card focus UI transitions', () => {
  it('moves a side-panel card into the full editor without losing its remembered identity', () => {
    expect(focusCardTransition(base, 'card-side', 'side-panel')).toEqual({
      focusedCardId: 'card-side',
      focusTransitionSource: 'side-panel',
      sidePanelOpen: false,
    });
  });

  it('restores the side panel after closing a card expanded from that panel', () => {
    const expanded = { ...base, focusedCardId: 'card-side', focusTransitionSource: 'side-panel' as const, sidePanelOpen: false };
    expect(focusCardTransition(expanded, null)).toEqual({ focusedCardId: null, focusTransitionSource: null, sidePanelOpen: true });
  });

  it('keeps the side panel closed after closing a canvas-expanded card', () => {
    const expanded = { ...base, focusedCardId: 'card-canvas', focusTransitionSource: 'canvas' as const, sidePanelOpen: false };
    expect(focusCardTransition(expanded, null)).toEqual({ focusedCardId: null, focusTransitionSource: null, sidePanelOpen: false });
  });

  it('collapses the panel without discarding the remembered card', () => {
    expect(sidePanelTransition(base, null)).toEqual({ sidePanelCardId: 'card-side', sidePanelOpen: false });
  });
});
