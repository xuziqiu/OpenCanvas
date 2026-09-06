import { describe, expect, it } from 'vitest';
import { desktopBoardKeyboardAction } from './desktopKeyboard';

describe('desktopBoardKeyboardAction', () => {
  it('opens a focused board with Enter', () => {
    expect(desktopBoardKeyboardAction('Enter', false, true)).toBe('open');
  });

  it('selects a focused board with Space', () => {
    expect(desktopBoardKeyboardAction(' ', false, true)).toBe('select');
  });

  it('opens the board menu with both standard keyboard gestures', () => {
    expect(desktopBoardKeyboardAction('ContextMenu', false, true)).toBe('menu');
    expect(desktopBoardKeyboardAction('F10', true, true)).toBe('menu');
    expect(desktopBoardKeyboardAction('F10', false, true)).toBeNull();
  });

  it('does not steal keys from controls nested inside a board preview', () => {
    expect(desktopBoardKeyboardAction('Enter', false, false)).toBeNull();
    expect(desktopBoardKeyboardAction(' ', false, false)).toBeNull();
  });
});
