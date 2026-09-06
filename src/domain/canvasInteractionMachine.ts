import { idleInteraction, type CanvasInteraction } from './interaction';

export type CanvasInteractionEvent =
  | { type: 'start-pan'; pointerId: number }
  | { type: 'start-marquee'; pointerId: number }
  | { type: 'start-section'; pointerId: number }
  | { type: 'start-move'; pointerId: number; placementIds: string[] }
  | { type: 'start-resize'; pointerId: number; placementId: string }
  | { type: 'start-connect'; fromId: string }
  | { type: 'start-edit'; placementId: string }
  | { type: 'finish-pointer'; pointerId: number }
  | { type: 'finish' }
  | { type: 'cancel' };

function isPointerInteraction(
  interaction: CanvasInteraction,
): interaction is Extract<CanvasInteraction, { pointerId: number }> {
  return 'pointerId' in interaction;
}

/** Connector dimming is a transient drag aid, never a persistent selection style. */
export function movingRelationshipFocusIds(interaction: CanvasInteraction) {
  return interaction.mode === 'moving' ? interaction.placementIds : [];
}

/**
 * The canvas has exactly one active gesture. Pointer completion is guarded by
 * pointerId so a stale pointerup cannot terminate a newer drag.
 */
export function transitionCanvasInteraction(
  interaction: CanvasInteraction,
  event: CanvasInteractionEvent,
): CanvasInteraction {
  switch (event.type) {
    case 'start-pan':
      return { mode: 'panning', pointerId: event.pointerId };
    case 'start-marquee':
      return { mode: 'marquee', pointerId: event.pointerId };
    case 'start-section':
      return { mode: 'drawing-section', pointerId: event.pointerId };
    case 'start-move':
      return { mode: 'moving', pointerId: event.pointerId, placementIds: [...event.placementIds] };
    case 'start-resize':
      return { mode: 'resizing', pointerId: event.pointerId, placementId: event.placementId };
    case 'start-connect':
      return { mode: 'connecting', fromId: event.fromId };
    case 'start-edit':
      return { mode: 'editing', placementId: event.placementId };
    case 'finish-pointer':
      return isPointerInteraction(interaction) && interaction.pointerId === event.pointerId
        ? idleInteraction
        : interaction;
    case 'finish':
    case 'cancel':
      return idleInteraction;
  }
}
