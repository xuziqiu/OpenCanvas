export interface PlacementLayerTokens {
  resting: number;
  hover: number;
  marquee: number;
  selected: number;
}

/**
 * A Section is a container background, not an ordinary elevated node. Its
 * children remain independent siblings and must always win pointer hit tests,
 * even while the Section is selected.
 */
export function placementLayerTokens(
  zIndex: number | undefined,
  isFrame: boolean | undefined,
  layerMin: number,
  layerMax: number,
): PlacementLayerTokens {
  if (isFrame) return { resting: 1, hover: 1, marquee: 1, selected: 1 };
  const resting = (zIndex ?? 0) - layerMin + 5;
  const activeOffset = layerMax - layerMin + 10;
  return {
    resting,
    hover: resting + activeOffset + 6,
    marquee: resting + activeOffset + 7,
    selected: resting + activeOffset + 8,
  };
}
