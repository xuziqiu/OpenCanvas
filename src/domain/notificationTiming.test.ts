import { describe, expect, it } from 'vitest';
import { noticeAutoDismissMs } from './notificationTiming';

describe('noticeAutoDismissMs', () => {
  it('keeps errors and recovery notices until the user dismisses them', () => {
    expect(noticeAutoDismissMs({ tone: 'error', title: '保存失败' })).toBeNull();
    expect(noticeAutoDismissMs({ tone: 'info', title: '已自动恢复知识库' })).toBeNull();
  });

  it('gives informational feedback longer than routine success feedback', () => {
    expect(noticeAutoDismissMs({ tone: 'success', title: '导出完成' })).toBe(5500);
    expect(noticeAutoDismissMs({ tone: 'info', title: '提示' })).toBe(7500);
  });
});
