import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { noticeAutoDismissMs } from '../domain/notificationTiming';
import { useWorkspaceStore } from '../store';
import type { AppNotice } from '../store/storeTypes';

type RenderedNotice = AppNotice & { exiting: boolean };

export default function AppNotifications() {
  const notices = useWorkspaceStore((state) => state.notices);
  const dismissNotice = useWorkspaceStore((state) => state.dismissNotice);
  const [renderedNotices, setRenderedNotices] = useState<RenderedNotice[]>(() => notices.map((notice) => ({ ...notice, exiting: false })));
  const removalTimers = useRef(new Map<string, number>());
  const dismissTimers = useRef(new Map<string, number>());

  useEffect(() => {
    const activeIds = new Set(notices.map((notice) => notice.id));
    for (const [noticeId, timer] of dismissTimers.current) {
      if (activeIds.has(noticeId)) continue;
      window.clearTimeout(timer);
      dismissTimers.current.delete(noticeId);
    }
    for (const notice of notices) {
      const duration = noticeAutoDismissMs(notice);
      if (duration === null || dismissTimers.current.has(notice.id)) continue;
      dismissTimers.current.set(notice.id, window.setTimeout(() => {
        dismissTimers.current.delete(notice.id);
        dismissNotice(notice.id);
      }, duration));
    }
  }, [dismissNotice, notices]);

  useEffect(() => {
    const activeById = new Map(notices.map((notice) => [notice.id, notice]));
    setRenderedNotices((current) => {
      const renderedIds = new Set(current.map((notice) => notice.id));
      const retained = current.map((notice) => {
        const active = activeById.get(notice.id);
        return active ? { ...active, exiting: false } : { ...notice, exiting: true };
      });
      return [...retained, ...notices.filter((notice) => !renderedIds.has(notice.id)).map((notice) => ({ ...notice, exiting: false }))];
    });
  }, [notices]);

  useEffect(() => {
    const exitingIds = new Set(renderedNotices.filter((notice) => notice.exiting).map((notice) => notice.id));
    for (const [noticeId, timer] of removalTimers.current) {
      if (exitingIds.has(noticeId)) continue;
      window.clearTimeout(timer);
      removalTimers.current.delete(noticeId);
    }
    for (const noticeId of exitingIds) {
      if (removalTimers.current.has(noticeId)) continue;
      removalTimers.current.set(noticeId, window.setTimeout(() => {
        removalTimers.current.delete(noticeId);
        setRenderedNotices((current) => current.filter((notice) => notice.id !== noticeId));
      }, 180));
    }
  }, [renderedNotices]);

  useEffect(() => () => {
    for (const timer of removalTimers.current.values()) window.clearTimeout(timer);
    for (const timer of dismissTimers.current.values()) window.clearTimeout(timer);
    removalTimers.current.clear();
    dismissTimers.current.clear();
  }, []);

  return <aside className="app-notification-stack" aria-live="polite" aria-label="应用通知">
    {renderedNotices.map((notice) => <section role={notice.tone === 'error' ? 'alert' : 'status'} className={`app-notification tone-${notice.tone}`} data-presence={notice.exiting ? 'exiting' : 'open'} aria-hidden={notice.exiting} key={notice.id}>
      <span className="app-notification-icon">{notice.tone === 'error' ? <AlertCircle size={17} /> : notice.tone === 'success' ? <CheckCircle2 size={17} /> : <Info size={17} />}</span>
      <div><strong>{notice.title}</strong><p>{notice.message}</p></div>
      <button aria-label="关闭通知" tabIndex={notice.exiting ? -1 : 0} onClick={() => dismissNotice(notice.id)}><X size={14} /></button>
    </section>)}
  </aside>;
}
