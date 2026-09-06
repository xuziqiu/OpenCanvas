export type TidyAction =
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-top'
  | 'align-middle'
  | 'align-bottom'
  | 'distribute-horizontal'
  | 'distribute-vertical'
  | 'rack-horizontal'
  | 'stack-vertical'
  | 'grid';

export interface TidyPosition {
  x: number;
  y: number;
}

interface PackingBox extends TidyPosition {
  id: string;
  width: number;
  height: number;
  w: number;
  h: number;
}

export interface TidyBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const LAYOUT_GAP = 6;

function bounds(boxes: Array<Pick<TidyBox, 'x' | 'y' | 'width' | 'height'>>) {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function distribute<T extends TidyBox>(boxes: T[], axis: 'x' | 'y') {
  const ordered = [...boxes].sort((a, b) => a[axis] - b[axis]);
  if (ordered.length <= 1) return ordered.map((box) => ({ ...box }));
  const selectionBounds = bounds(ordered);
  const size = axis === 'x' ? 'width' : 'height';
  const span = axis === 'x' ? selectionBounds.width : selectionBounds.height;
  const occupied = ordered.reduce((total, box) => total + box[size], 0);
  const gap = (span - occupied) / (ordered.length - 1);
  const next = ordered.map((box) => ({ ...box }));
  for (let index = 1; index < next.length; index += 1) {
    const previous = next[index - 1];
    next[index][axis] = previous[axis] + previous[size] + gap;
  }
  return next;
}

/**
 * Arrange variable-size boxes into compact rows near a square target area.
 * Taller boxes are placed first so each row has a stable baseline.
 */
function packGridRows(boxes: PackingBox[]) {
  const ordered = [...boxes].sort((a, b) => b.h - a.h || b.w - a.w || a.id.localeCompare(b.id));
  const totalArea = ordered.reduce((sum, box) => sum + box.w * box.h, 0);
  const widest = ordered.reduce((width, box) => Math.max(width, box.w), 0);
  const targetWidth = Math.max(widest, Math.ceil(Math.sqrt(totalArea)));
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const box of ordered) {
    if (cursorX > 0 && cursorX + box.w > targetWidth) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    box.x = cursorX;
    box.y = cursorY;
    cursorX += box.w;
    rowHeight = Math.max(rowHeight, box.h);
  }
}

export function tidyPlacementPositions<T extends TidyBox>(placements: T[], action: TidyAction): Record<string, TidyPosition> {
  if (!placements.length) return {};
  const selectionBounds = bounds(placements);
  let next = placements.map((placement) => ({ ...placement }));

  switch (action) {
    case 'align-left':
      next = next.map((box) => ({ ...box, x: selectionBounds.x }));
      break;
    case 'align-center': {
      const center = selectionBounds.x + selectionBounds.width / 2;
      next = next.map((box) => ({ ...box, x: center - box.width / 2 }));
      break;
    }
    case 'align-right': {
      const right = selectionBounds.x + selectionBounds.width;
      next = next.map((box) => ({ ...box, x: right - box.width }));
      break;
    }
    case 'align-top':
      next = next.map((box) => ({ ...box, y: selectionBounds.y }));
      break;
    case 'align-middle': {
      const middle = selectionBounds.y + selectionBounds.height / 2;
      next = next.map((box) => ({ ...box, y: middle - box.height / 2 }));
      break;
    }
    case 'align-bottom': {
      const bottom = selectionBounds.y + selectionBounds.height;
      next = next.map((box) => ({ ...box, y: bottom - box.height }));
      break;
    }
    case 'distribute-horizontal':
      next = distribute(placements, 'x');
      break;
    case 'distribute-vertical':
      next = distribute(placements, 'y');
      break;
    case 'rack-horizontal': {
      next = [...placements].sort((a, b) => a.x - b.x).map((box) => ({ ...box, y: selectionBounds.y }));
      for (let index = 1; index < next.length; index += 1) {
        next[index].x = next[index - 1].x + next[index - 1].width + LAYOUT_GAP;
      }
      break;
    }
    case 'stack-vertical': {
      next = [...placements].sort((a, b) => a.y - b.y).map((box) => ({ ...box, x: selectionBounds.x }));
      for (let index = 1; index < next.length; index += 1) {
        next[index].y = next[index - 1].y + next[index - 1].height + LAYOUT_GAP;
      }
      break;
    }
    case 'grid': {
      const packed: PackingBox[] = placements.map((box) => ({
        id: box.id,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        w: box.width + LAYOUT_GAP,
        h: box.height + LAYOUT_GAP,
      }));
      packGridRows(packed);
      next = packed.map((box) => ({
        ...placements.find((placement) => placement.id === box.id)!,
        x: selectionBounds.x + box.x,
        y: selectionBounds.y + box.y,
      }));
      break;
    }
  }

  return Object.fromEntries(next.map((placement) => [placement.id, { x: placement.x, y: placement.y }]));
}
