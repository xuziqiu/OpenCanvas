import { describe, expect, it } from 'vitest';
import { moveConnectorControlPoint } from './connectorKeypointMotion';

describe('moveConnectorControlPoint', () => {
  it('moves a horizontal segment only along the vertical axis', () => {
    expect(moveConnectorControlPoint({ id: 'h', x: 30, y: 40, direction: 'horizontal' }, { x: 300, y: 90 }))
      .toEqual({ id: 'h', x: 30, y: 90, direction: 'horizontal' });
  });

  it('moves a vertical segment only along the horizontal axis', () => {
    expect(moveConnectorControlPoint({ id: 'v', x: 30, y: 40, direction: 'vertical' }, { x: 300, y: 90 }))
      .toEqual({ id: 'v', x: 300, y: 40, direction: 'vertical' });
  });

  it('keeps curve points and label anchors freely movable', () => {
    expect(moveConnectorControlPoint({ id: 'free', x: 30, y: 40 }, { x: 300, y: 90 }))
      .toEqual({ id: 'free', x: 300, y: 90 });
  });
});
