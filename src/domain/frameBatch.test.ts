import { describe, expect, it, vi } from 'vitest';
import { createLatestFrameBatch, type FrameScheduler } from './frameBatch';

function fakeFrames() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const scheduler: FrameScheduler = {
    request: (callback) => { const id = nextId++; callbacks.set(id, callback); return id; },
    cancel: (id) => { callbacks.delete(id); },
  };
  return { scheduler, callbacks };
}

describe('latest-frame batching', () => {
  it('applies only the newest sample in a display frame', () => {
    const frames = fakeFrames();
    const apply = vi.fn();
    const batch = createLatestFrameBatch(apply, frames.scheduler);
    batch.push(1);
    batch.push(2);
    batch.push(3);
    expect(frames.callbacks.size).toBe(1);
    frames.callbacks.values().next().value?.();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(3);
    expect(batch.pending()).toBe(false);
  });

  it('flushes the final pointer sample synchronously on release', () => {
    const frames = fakeFrames();
    const apply = vi.fn();
    const batch = createLatestFrameBatch(apply, frames.scheduler);
    batch.push({ x: 42 });
    batch.flush();
    expect(apply).toHaveBeenCalledWith({ x: 42 });
    expect(frames.callbacks.size).toBe(0);
  });

  it('drops pending work when a gesture is cancelled', () => {
    const frames = fakeFrames();
    const apply = vi.fn();
    const batch = createLatestFrameBatch(apply, frames.scheduler);
    batch.push('stale');
    batch.cancel();
    expect(frames.callbacks.size).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });
});
