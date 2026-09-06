import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearCardEditorViewState,
  recallCardEditorScroll,
  recallCardEditorSelection,
  rememberCardEditorScroll,
  rememberCardEditorSelection,
} from './editorViewState';

describe('editor view state', () => {
  beforeEach(clearCardEditorViewState);

  it('restores a surface-specific caret and falls back to the last active surface', () => {
    rememberCardEditorSelection('card-a', 'side-panel', { from: 18, to: 22 });
    expect(recallCardEditorSelection('card-a', 'page')).toEqual({ from: 18, to: 22 });
    rememberCardEditorSelection('card-a', 'page', { from: 31, to: 31 });
    expect(recallCardEditorSelection('card-a', 'side-panel')).toEqual({ from: 18, to: 22 });
    expect(recallCardEditorSelection('card-a', 'canvas')).toEqual({ from: 31, to: 31 });
  });

  it('preserves scroll position across panel/page transitions and clamps invalid values', () => {
    rememberCardEditorScroll('card-a', 'side-panel', 420);
    expect(recallCardEditorScroll('card-a', 'page')).toBe(420);
    rememberCardEditorScroll('card-a', 'page', Number.NaN);
    expect(recallCardEditorScroll('card-a', 'page')).toBe(0);
    expect(recallCardEditorScroll('missing', 'page')).toBe(0);
  });
});
