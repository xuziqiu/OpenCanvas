export interface TimedNotice {
  tone: 'info' | 'success' | 'error';
  title: string;
}

export function noticeAutoDismissMs(notice: TimedNotice) {
  if (notice.tone === 'error' || notice.title === '已自动恢复知识库') return null;
  return notice.tone === 'success' ? 5500 : 7500;
}
