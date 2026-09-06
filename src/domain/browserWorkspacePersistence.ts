import type { WorkspaceSnapshot } from '../types';

/** Browser storage contains source data only. Integrity findings and recovery
 * metadata are derived at load time and must not become immortal stored data. */
export function stripBrowserDerivedState(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.loadIssues;
  delete copy.recovery;
  return copy;
}

export function browserSnapshotForStorage(snapshot: WorkspaceSnapshot): unknown {
  return stripBrowserDerivedState(snapshot);
}
