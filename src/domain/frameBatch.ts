export interface FrameScheduler {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
}

const browserFrameScheduler: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

/**
 * Coalesces high-frequency pointer samples to the display frame rate while
 * preserving an explicit flush for pointerup. This avoids doing expensive
 * spatial-index/store work multiple times for pixels the user never sees.
 */
export function createLatestFrameBatch<T>(apply: (value: T) => void, scheduler: FrameScheduler = browserFrameScheduler) {
  let frame: number | null = null;
  let latest: T | undefined;

  const run = () => {
    frame = null;
    if (latest === undefined) return;
    const value = latest;
    latest = undefined;
    apply(value);
  };

  return {
    push(value: T) {
      latest = value;
      if (frame === null) frame = scheduler.request(run);
    },
    flush() {
      if (frame !== null) scheduler.cancel(frame);
      run();
    },
    cancel() {
      if (frame !== null) scheduler.cancel(frame);
      frame = null;
      latest = undefined;
    },
    pending() {
      return frame !== null;
    },
  };
}

export interface PointerFrameSample {
  clientX: number;
  clientY: number;
  altKey: boolean;
  shiftKey: boolean;
}

export function pointerFrameSample(event: Pick<PointerEvent, 'clientX' | 'clientY' | 'altKey' | 'shiftKey'>): PointerFrameSample {
  return { clientX: event.clientX, clientY: event.clientY, altKey: event.altKey, shiftKey: event.shiftKey };
}
