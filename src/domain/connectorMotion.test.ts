import { describe, expect, it } from 'vitest';
import type { BoardConnector, BoardPlacement } from '../types';
import { connectorsAfterPlacementMotion } from './connectorMotion';

const placement = (id: string, x: number): BoardPlacement => ({
  id, kind: 'card', x, y: 100, width: 240, height: 160, color: 'paper',
});
const internal: BoardConnector = {
  id: 'internal', from: 'first', to: 'second', label: '关系',
  controlPoints: [{ id: 'label-anchor', x: 390, y: 150 }, { id: 'bend', x: 420, y: 240 }],
};

describe('connectorsAfterPlacementMotion', () => {
  it('translates every keypoint when both endpoints share the same movement', () => {
    const result = connectorsAfterPlacementMotion(
      [internal],
      [placement('first', 100), placement('second', 500)],
      { first: { x: 140, y: 70 }, second: { x: 540, y: 70 } },
      { translateInternalControlPoints: true },
    );
    expect(result[0].controlPoints).toEqual([
      { id: 'label-anchor', x: 430, y: 120 },
      { id: 'bend', x: 460, y: 210 },
    ]);
  });

  it('keeps world keypoints fixed when only one endpoint moves', () => {
    const connectors = [internal];
    const result = connectorsAfterPlacementMotion(
      connectors,
      [placement('first', 100), placement('second', 500)],
      { first: { x: 140, y: 70 } },
      { translateInternalControlPoints: true },
    );
    expect(result).toBe(connectors);
    expect(result[0]).toBe(internal);
    expect(result[0].controlPoints).toEqual(internal.controlPoints);
  });

  it('does not translate control points for resize or layout updates that did not opt in', () => {
    const connectors = [internal];
    const result = connectorsAfterPlacementMotion(
      connectors,
      [placement('first', 100), placement('second', 500)],
      { first: { x: 140 }, second: { x: 540 } },
    );
    expect(result).toBe(connectors);
  });

  it('does not translate a route when endpoint deltas differ', () => {
    const result = connectorsAfterPlacementMotion(
      [internal],
      [placement('first', 100), placement('second', 500)],
      { first: { x: 140 }, second: { x: 560 } },
      { translateInternalControlPoints: true },
    );
    expect(result[0]).toBe(internal);
  });
});
