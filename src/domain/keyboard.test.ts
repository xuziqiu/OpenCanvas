import { describe, expect, it } from 'vitest';
import { isComposingKeyboardEvent, isCreateSectionShortcut } from './keyboard';

describe('keyboard composition guard', () => {
  it('recognizes modern composition events and the Windows IME sentinel', () => {
    expect(isComposingKeyboardEvent({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isComposingKeyboardEvent({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isComposingKeyboardEvent({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe('canvas section shortcut', () => {
  it('matches Ctrl/Cmd+G without consuming modified variants', () => {
    expect(isCreateSectionShortcut({ key: 'g', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(true);
    expect(isCreateSectionShortcut({ key: 'G', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBe(true);
    expect(isCreateSectionShortcut({ key: 'g', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(false);
    expect(isCreateSectionShortcut({ key: 'g', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe(false);
  });
});
