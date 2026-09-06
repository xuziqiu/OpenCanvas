export interface ExclusiveAsyncGate {
  current: string | null;
}

export type ExclusiveAsyncResult<T> =
  | { started: false }
  | { started: true; value: T };

/** Prevents a second click from entering while the first asynchronous action is pending. */
export async function runExclusiveAsyncAction<T>(
  gate: ExclusiveAsyncGate,
  key: string,
  onChange: (key: string | null) => void,
  action: () => Promise<T>,
): Promise<ExclusiveAsyncResult<T>> {
  if (gate.current) return { started: false };
  gate.current = key;
  onChange(key);
  try {
    return { started: true, value: await action() };
  } finally {
    gate.current = null;
    onChange(null);
  }
}
