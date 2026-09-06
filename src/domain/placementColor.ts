const PLACEMENT_COLOR_KEYS = ['paper', 'sand', 'yellow', 'blue', 'green', 'rose', 'purple', 'ink'] as const;

export type PlacementColorKey = typeof PLACEMENT_COLOR_KEYS[number];

const semanticColors = new Set<string>(PLACEMENT_COLOR_KEYS);
const obsidianColors: Record<string, PlacementColorKey> = {
  '1': 'rose',
  '2': 'sand',
  '3': 'yellow',
  '4': 'green',
  '5': 'blue',
  '6': 'purple',
};

const palette: Array<[PlacementColorKey, [number, number, number]]> = [
  ['paper', [255, 254, 250]],
  ['sand', [248, 238, 220]],
  ['yellow', [255, 244, 200]],
  ['blue', [230, 241, 246]],
  ['green', [231, 241, 229]],
  ['rose', [247, 232, 231]],
  ['purple', [239, 232, 244]],
  ['ink', [48, 50, 54]],
];

function parseHexColor(value: string): [number, number, number] | null {
  const match = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const expanded = match[1].length === 3
    ? [...match[1]].map((character) => character + character).join('')
    : match[1];
  return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16)) as [number, number, number];
}

/**
 * Convert legacy, Obsidian Canvas and custom hex colors into the local
 * semantic palette used by both themes. The original serialized value remains
 * untouched until the user deliberately chooses another color.
 */
export function placementColorKey(value: string | null | undefined): PlacementColorKey | 'transparent' {
  const normalized = value?.trim().toLowerCase() || 'paper';
  if (normalized === 'transparent') return 'transparent';
  if (semanticColors.has(normalized)) return normalized as PlacementColorKey;
  if (obsidianColors[normalized]) return obsidianColors[normalized];
  const rgb = parseHexColor(normalized);
  if (!rgb) return 'paper';
  let nearest = palette[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of palette) {
    const distance = candidate[1].reduce((sum, channel, index) => sum + (channel - rgb[index]) ** 2, 0);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest[0];
}
