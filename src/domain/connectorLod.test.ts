import { describe, expect, it } from 'vitest';
import { connectorLodThresholds, resolveConnectorLod } from './connectorLod';

describe('connector detail levels', () => {
  it('keeps separate enter and exit thresholds', () => {
    const thresholds = connectorLodThresholds(1);
    expect(thresholds.enter).toBe(450);
    expect(thresholds.exit).toBeLessThan(thresholds.enter);
  });

  it('does not flicker while the count stays in the hysteresis band', () => {
    expect(resolveConnectorLod('detailed', 430, 1)).toBe('detailed');
    expect(resolveConnectorLod('dense', 430, 1)).toBe('dense');
  });

  it('shows more individual routes at high zoom and simplifies sooner at low zoom', () => {
    expect(connectorLodThresholds(.2).enter).toBeLessThan(connectorLodThresholds(2.4).enter);
    expect(resolveConnectorLod('detailed', 400, .2)).toBe('dense');
    expect(resolveConnectorLod('detailed', 400, 2.4)).toBe('detailed');
  });
});
