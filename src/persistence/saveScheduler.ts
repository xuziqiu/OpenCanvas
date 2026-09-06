export interface SaveSchedulerOptions {
  canSchedule: () => boolean;
  canMarkSaved: () => boolean;
  onBlocked: () => void;
  onSaving: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}

/** Debounces writes by entity while tracking in-flight work independently. */
export class WorkspaceSaveScheduler {
  private readonly timers = new Map<string, { timer: ReturnType<typeof setTimeout>; task: () => Promise<void>; generation: number; revision: number }>();
  private readonly active = new Set<Promise<void>>();
  private readonly activeByKey = new Map<string, Promise<void>>();
  private readonly latestRevisionByKey = new Map<string, number>();
  private generation = 0;
  private revision = 0;
  private accepting = true;

  constructor(private readonly options: SaveSchedulerOptions) {}

  schedule(key: string, delay: number, task: () => Promise<void>) {
    if (!this.accepting) return false;
    if (!this.options.canSchedule()) {
      this.options.onBlocked();
      return false;
    }
    this.cancel(key);
    this.options.onSaving();
    const generation = this.generation;
    const revision = ++this.revision;
    this.latestRevisionByKey.set(key, revision);
    const entry = { timer: undefined as unknown as ReturnType<typeof setTimeout>, task, generation, revision };
    entry.timer = setTimeout(() => {
      if (this.timers.get(key) !== entry) return;
      this.timers.delete(key);
      void this.run(key, entry);
    }, delay);
    this.timers.set(key, entry);
    return true;
  }

  cancel(key: string) {
    const entry = this.timers.get(key);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    this.timers.delete(key);
    return true;
  }

  clear() {
    this.generation += 1;
    for (const entry of this.timers.values()) clearTimeout(entry.timer);
    this.timers.clear();
    this.latestRevisionByKey.clear();
  }

  async flush() {
    while (this.timers.size || this.active.size) {
      const pending = [...this.timers.entries()];
      for (const [key, entry] of pending) {
        clearTimeout(entry.timer);
        this.timers.delete(key);
        void this.run(key, entry);
      }
      if (this.active.size) await Promise.allSettled([...this.active]);
    }
  }

  /** Prevents late UI events from creating new writes while the window is closing. */
  async sealAndFlush() {
    this.accepting = false;
    await this.flush();
  }

  isDirty() {
    return this.timers.size > 0 || this.active.size > 0;
  }

  pendingCount() {
    return this.timers.size;
  }

  inFlightCount() {
    return this.active.size;
  }

  private markSavedWhenIdle() {
    if (!this.isDirty() && this.options.canMarkSaved()) this.options.onSaved();
  }

  private run(key: string, entry: { task: () => Promise<void>; generation: number; revision: number }) {
    // Writes for different entities remain parallel, but the same card/board
    // is strictly ordered. This prevents an older slow atomic write from
    // completing after a newer one and restoring stale content on disk.
    const previous = this.activeByKey.get(key) ?? Promise.resolve();
    const promise = previous
      .catch(() => undefined)
      .then(entry.task)
      .catch((error) => {
        if (entry.generation === this.generation && this.latestRevisionByKey.get(key) === entry.revision) this.options.onError(error);
      })
      .finally(() => {
        this.active.delete(promise);
        if (this.activeByKey.get(key) === promise) this.activeByKey.delete(key);
        if (entry.generation === this.generation) this.markSavedWhenIdle();
      });
    this.activeByKey.set(key, promise);
    this.active.add(promise);
    return promise;
  }
}
