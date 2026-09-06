import { describe, expect, it, vi } from 'vitest';
import { runExclusiveAsyncAction, type ExclusiveAsyncGate } from './exclusiveAsyncAction';

describe('runExclusiveAsyncAction', () => {
  it('blocks re-entry until the active action settles', async () => {
    const gate: ExclusiveAsyncGate = { current: null };
    const changes: Array<string | null> = [];
    let release!: () => void;
    const first = runExclusiveAsyncAction(gate, 'delete', (key) => changes.push(key), () => new Promise<void>((resolve) => { release = resolve; }));
    const duplicate = await runExclusiveAsyncAction(gate, 'delete', vi.fn(), async () => 'duplicate');
    expect(duplicate).toEqual({ started: false });
    release();
    expect(await first).toEqual({ started: true, value: undefined });
    expect(changes).toEqual(['delete', null]);
  });

  it('always releases the gate after an error', async () => {
    const gate: ExclusiveAsyncGate = { current: null };
    await expect(runExclusiveAsyncAction(gate, 'export', vi.fn(), async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(gate.current).toBeNull();
  });
});
