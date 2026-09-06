import { describe, expect, it } from 'vitest';
import { shouldOpenConnectorMenu } from './connectorKeyboard';

describe('shouldOpenConnectorMenu', () => {
  it('supports activation and both standard context-menu gestures', () => {
    expect(shouldOpenConnectorMenu('Enter', false)).toBe(true);
    expect(shouldOpenConnectorMenu(' ', false)).toBe(true);
    expect(shouldOpenConnectorMenu('ContextMenu', false)).toBe(true);
    expect(shouldOpenConnectorMenu('F10', true)).toBe(true);
  });

  it('ignores unrelated keys and nested targets', () => {
    expect(shouldOpenConnectorMenu('F10', false)).toBe(false);
    expect(shouldOpenConnectorMenu('Enter', false, false)).toBe(false);
  });
});
