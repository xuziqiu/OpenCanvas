import { useCallback, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { runExclusiveAsyncAction, type ExclusiveAsyncGate } from '../domain/exclusiveAsyncAction';

export type RunAsyncAction = <T>(key: string, action: () => Promise<T>) => Promise<T | undefined>;

export function useAsyncActionGate() {
  const gateRef = useRef<ExclusiveAsyncGate>({ current: null });
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const runAction = useCallback<RunAsyncAction>(async (key, action) => {
    const result = await runExclusiveAsyncAction(gateRef.current, key, setPendingAction, action);
    return result.started ? result.value : undefined;
  }, []);
  return { pendingAction, runAction };
}

interface AsyncActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  actionKey: string;
  pendingAction: string | null;
  runAction: RunAsyncAction;
  action: () => Promise<unknown>;
  busyLabel: ReactNode;
}

export default function AsyncActionButton({ actionKey, pendingAction, runAction, action, busyLabel, children, disabled, className, ...props }: AsyncActionButtonProps) {
  const busy = pendingAction === actionKey;
  return <button
    {...props}
    className={`async-action-button${className ? ` ${className}` : ''}`}
    type="button"
    disabled={disabled || Boolean(pendingAction)}
    aria-busy={busy}
    onClick={() => void runAction(actionKey, action)}
  ><span className="async-action-idle" aria-hidden={busy}>{children}</span><span className="async-action-busy" aria-hidden={!busy}><RefreshCw className="async-action-spinner" size={13} />{busyLabel}</span></button>;
}
