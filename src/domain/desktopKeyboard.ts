export type DesktopBoardKeyboardAction = 'open' | 'select' | 'menu' | null;

export function desktopBoardKeyboardAction(
  key: string,
  shiftKey: boolean,
  eventTargetsBoard: boolean,
): DesktopBoardKeyboardAction {
  if (!eventTargetsBoard) return null;
  if (key === 'Enter') return 'open';
  if (key === ' ') return 'select';
  if (key === 'ContextMenu' || (shiftKey && key === 'F10')) return 'menu';
  return null;
}
