import { describe, expect, it } from 'vitest';
import type { BoardConnector } from '../types';
import { controlPointsForConnectorStyleChange } from './connectorControlPoints';

const connector = (extra: Partial<BoardConnector> = {}): BoardConnector => ({
  id: 'edge',
  from: 'left',
  to: 'right',
  controlPoints: [
    { id: 'label-anchor', x: 120, y: 80 },
    { id: 'route-point', x: 240, y: 160 },
  ],
  ...extra,
});

describe('connector control-point transitions', () => {
  it('preserves only the manual label anchor when changing line style', () => {
    expect(controlPointsForConnectorStyleChange(connector({ label: '关系' }))).toEqual([
      { id: 'label-anchor', x: 120, y: 80 },
    ]);
  });

  it('drops style-specific route points when there is no label to anchor', () => {
    expect(controlPointsForConnectorStyleChange(connector())).toEqual([]);
    expect(controlPointsForConnectorStyleChange(connector({ label: '   ' }))).toEqual([]);
  });
});
