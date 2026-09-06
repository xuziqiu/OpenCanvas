import type { CanvasInteraction } from './interaction';

/**
 * Placements that must bypass the frozen spatial-index snapshot while an
 * interaction is in progress. This keeps every member of a moving Section in
 * the same rendered frame as the Section itself.
 */
export function interactionPinnedPlacementIds(interaction: CanvasInteraction): string[] {
  if (interaction.mode === 'moving') return interaction.placementIds;
  if (interaction.mode === 'resizing') return [interaction.placementId];
  return [];
}
