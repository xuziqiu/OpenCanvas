export type FramePointerIntent = 'ordinary-node' | 'marquee-or-select-frame' | 'move-frame-group';

export function framePointerIntent(isFrame: boolean | undefined, placementId: string, selectedIds: readonly string[]): FramePointerIntent {
  if (!isFrame) return 'ordinary-node';
  return selectedIds.includes(placementId)
    ? 'move-frame-group'
    : 'marquee-or-select-frame';
}
