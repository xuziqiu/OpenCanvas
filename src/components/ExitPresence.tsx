import { cloneElement, useEffect, useRef, useState, type ReactElement } from 'react';

interface ExitPresenceProps {
  show: boolean;
  children: ReactElement | null;
  duration?: number;
}

/** Keeps a dismissed surface mounted just long enough for its exit motion. */
export default function ExitPresence({ show, children, duration = 170 }: ExitPresenceProps) {
  const lastChild = useRef<ReactElement | null>(children);
  const timer = useRef<number | null>(null);
  const [present, setPresent] = useState(show);
  const [phase, setPhase] = useState<'open' | 'exiting'>('open');

  if (show && children) lastChild.current = children;

  useEffect(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (show) {
      setPresent(true);
      setPhase('open');
      return;
    }
    if (!present) return;
    setPhase('exiting');
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    timer.current = window.setTimeout(() => {
      setPresent(false);
      setPhase('open');
      timer.current = null;
    }, reducedMotion ? 0 : duration);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [duration, present, show]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  // Opening must be synchronous: callers commonly focus a descendant from a
  // layout effect in the same commit. Only dismissal needs retained presence.
  if ((!show && !present) || !lastChild.current) return null;
  return cloneElement(lastChild.current as ReactElement<Record<string, unknown>>, {
    'data-presence': show ? 'open' : phase,
  });
}
