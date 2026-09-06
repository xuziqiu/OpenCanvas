import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSaveScheduler } from './saveScheduler';

describe('WorkspaceSaveScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    let allowed = true;
    let markable = true;
    const events: string[] = [];
    const scheduler = new WorkspaceSaveScheduler({
      canSchedule: () => allowed,
      canMarkSaved: () => markable,
      onBlocked: () => events.push('blocked'),
      onSaving: () => events.push('saving'),
      onSaved: () => events.push('saved'),
      onError: () => events.push('error'),
    });
    return { scheduler, events, setAllowed: (value: boolean) => { allowed = value; }, setMarkable: (value: boolean) => { markable = value; } };
  }

  it('debounces repeated writes for the same entity', async () => {
    const { scheduler, events } = setup();
    const writes: string[] = [];
    scheduler.schedule('card:a', 200, async () => { writes.push('old'); });
    scheduler.schedule('card:a', 200, async () => { writes.push('new'); });
    expect(scheduler.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(writes).toEqual(['new']);
    expect(events).toEqual(['saving', 'saving', 'saved']);
  });

  it('waits for every in-flight write before reporting saved', async () => {
    const { scheduler, events } = setup();
    let finishA!: () => void;
    let finishB!: () => void;
    scheduler.schedule('card:a', 0, () => new Promise<void>((resolve) => { finishA = resolve; }));
    scheduler.schedule('board:b', 0, () => new Promise<void>((resolve) => { finishB = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.inFlightCount()).toBe(2);
    finishA();
    await Promise.resolve();
    expect(events).not.toContain('saved');
    finishB();
    await vi.runAllTimersAsync();
    expect(events.at(-1)).toBe('saved');
  });

  it('serializes writes for one entity so a slow old save cannot overwrite the latest content', async () => {
    const { scheduler } = setup();
    const writes: string[] = [];
    let finishOld!: () => void;
    scheduler.schedule('card:a', 0, () => new Promise<void>((resolve) => {
      writes.push('old:start');
      finishOld = () => { writes.push('old:end'); resolve(); };
    }));
    await vi.advanceTimersByTimeAsync(0);
    scheduler.schedule('card:a', 0, async () => { writes.push('new'); });
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['old:start']);
    finishOld();
    await vi.runAllTimersAsync();
    expect(writes).toEqual(['old:start', 'old:end', 'new']);
  });

  it('keeps unrelated entity writes parallel while serializing each key', async () => {
    const { scheduler } = setup();
    let finishCard!: () => void;
    let finishBoard!: () => void;
    scheduler.schedule('card:a', 0, () => new Promise<void>((resolve) => { finishCard = resolve; }));
    scheduler.schedule('board:b', 0, () => new Promise<void>((resolve) => { finishBoard = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.inFlightCount()).toBe(2);
    finishCard();
    finishBoard();
    await vi.runAllTimersAsync();
  });

  it('ignores a superseded save failure when the queued latest revision succeeds', async () => {
    const { scheduler, events } = setup();
    let failOld!: () => void;
    scheduler.schedule('card:a', 0, () => new Promise<void>((_resolve, reject) => { failOld = () => reject(new Error('old failed')); }));
    await vi.advanceTimersByTimeAsync(0);
    scheduler.schedule('card:a', 0, async () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    failOld();
    await vi.runAllTimersAsync();
    expect(events).not.toContain('error');
    expect(events.at(-1)).toBe('saved');
  });

  it('blocks new writes during an external conflict', () => {
    const { scheduler, events, setAllowed } = setup();
    setAllowed(false);
    expect(scheduler.schedule('card:a', 0, async () => undefined)).toBe(false);
    expect(events).toEqual(['blocked']);
    expect(scheduler.isDirty()).toBe(false);
  });

  it('reports failures without marking the workspace saved', async () => {
    const { scheduler, events, setMarkable } = setup();
    scheduler.schedule('card:a', 0, async () => { setMarkable(false); throw new Error('disk full'); });
    await vi.runAllTimersAsync();
    expect(events).toEqual(['saving', 'error']);
  });

  it('can cancel pending writes during reload or file transactions', async () => {
    const { scheduler } = setup();
    const task = vi.fn(async () => undefined);
    scheduler.schedule('card:a', 100, task);
    scheduler.clear();
    await vi.advanceTimersByTimeAsync(100);
    expect(task).not.toHaveBeenCalled();
    expect(scheduler.isDirty()).toBe(false);
  });

  it('does not let a superseded in-flight write publish stale save state', async () => {
    const { scheduler, events } = setup();
    let finish!: () => void;
    scheduler.schedule('card:a', 0, () => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    scheduler.clear();
    finish();
    await vi.runAllTimersAsync();
    expect(events).toEqual(['saving']);
  });

  it('flushes pending and in-flight writes before shutdown', async () => {
    const { scheduler, events } = setup();
    const writes: string[] = [];
    scheduler.schedule('card:a', 10_000, async () => { writes.push('card'); });
    scheduler.schedule('board:b', 10_000, async () => { writes.push('board'); });
    await scheduler.flush();
    expect(writes).toEqual(['card', 'board']);
    expect(scheduler.isDirty()).toBe(false);
    expect(events.at(-1)).toBe('saved');
  });

  it('keeps accepting writes after an ordinary mid-session flush', async () => {
    const { scheduler } = setup();
    const writes: string[] = [];
    scheduler.schedule('card:a', 10_000, async () => { writes.push('before'); });
    await scheduler.flush();
    expect(scheduler.schedule('card:a', 0, async () => { writes.push('after'); })).toBe(true);
    await vi.runAllTimersAsync();
    expect(writes).toEqual(['before', 'after']);
  });

  it('rejects late writes after shutdown starts', async () => {
    const { scheduler, events } = setup();
    const writes: string[] = [];
    scheduler.schedule('board:a', 10_000, async () => { writes.push('before'); });
    await scheduler.sealAndFlush();
    expect(scheduler.schedule('board:b', 0, async () => { writes.push('after'); })).toBe(false);
    await Promise.resolve();
    expect(writes).toEqual(['before']);
    expect(events.filter((event) => event === 'blocked')).toHaveLength(0);
  });
});
