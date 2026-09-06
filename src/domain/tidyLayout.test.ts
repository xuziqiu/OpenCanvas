import { describe, expect, it } from 'vitest';
import type { BoardPlacement } from '../types';
import { tidyPlacementPositions } from './tidyLayout';

const placement = (id: string, x: number, y: number, width: number, height: number): BoardPlacement => ({
  id,
  kind: 'card',
  x,
  y,
  width,
  height,
  color: 'paper',
});

const boxes = [
  placement('a', 20, 30, 100, 80),
  placement('b', 180, 90, 60, 120),
  placement('c', 300, 180, 140, 60),
];

describe('tidy layout', () => {
  it('aligns all six box edges and centers against the selection bounds', () => {
    expect(tidyPlacementPositions(boxes, 'align-left')).toMatchObject({ a: { x: 20 }, b: { x: 20 }, c: { x: 20 } });
    expect(tidyPlacementPositions(boxes, 'align-center')).toMatchObject({ a: { x: 180 }, b: { x: 200 }, c: { x: 160 } });
    expect(tidyPlacementPositions(boxes, 'align-right')).toMatchObject({ a: { x: 340 }, b: { x: 380 }, c: { x: 300 } });
    expect(tidyPlacementPositions(boxes, 'align-top')).toMatchObject({ a: { y: 30 }, b: { y: 30 }, c: { y: 30 } });
    expect(tidyPlacementPositions(boxes, 'align-middle')).toMatchObject({ a: { y: 95 }, b: { y: 75 }, c: { y: 105 } });
    expect(tidyPlacementPositions(boxes, 'align-bottom')).toMatchObject({ a: { y: 160 }, b: { y: 120 }, c: { y: 180 } });
  });

  it('distributes variable-size cards by equal edge-to-edge gaps', () => {
    expect(tidyPlacementPositions(boxes, 'distribute-horizontal')).toEqual({
      a: { x: 20, y: 30 },
      b: { x: 180, y: 90 },
      c: { x: 300, y: 180 },
    });
    expect(tidyPlacementPositions(boxes, 'distribute-vertical')).toEqual({
      a: { x: 20, y: 30 },
      b: { x: 180, y: 85 },
      c: { x: 300, y: 180 },
    });
  });

  it('racks and stacks in spatial order with the visible six-unit card gutter', () => {
    expect(tidyPlacementPositions(boxes, 'rack-horizontal')).toEqual({
      a: { x: 20, y: 30 },
      b: { x: 126, y: 30 },
      c: { x: 192, y: 30 },
    });
    expect(tidyPlacementPositions(boxes, 'stack-vertical')).toEqual({
      a: { x: 20, y: 30 },
      b: { x: 20, y: 116 },
      c: { x: 20, y: 242 },
    });
  });

  it('packs mixed-size cards into a compact grid from the original top-left anchor', () => {
    expect(tidyPlacementPositions(boxes, 'grid')).toEqual({
      b: { x: 20, y: 30 },
      a: { x: 20, y: 156 },
      c: { x: 20, y: 242 },
    });
  });
});
