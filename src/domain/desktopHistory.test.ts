import { describe, expect, it } from 'vitest';
import type { DesktopBoardPlacement } from '../types';
import { emptyDesktopHistory, recordDesktopHistory, redoDesktopHistory, undoDesktopHistory } from './desktopHistory';

const placement = (index: number): DesktopBoardPlacement => ({ boardId: `b-${index}`, x: index * 20, y: 0, width: 430, height: 270 });

describe('desktop delta history', () => {
  it('undoes and redoes one desktop gesture', () => {
    const before = [placement(0), placement(1)];
    const after = [before[0], { ...before[1], x: 120 }];
    const history = recordDesktopHistory(emptyDesktopHistory(), '移动白板', before, after);
    expect(history.past[0].changes).toHaveLength(1);
    const undone = undoDesktopHistory(history, after)!;
    expect(undone.placements[1].x).toBe(20);
    expect(redoDesktopHistory(undone.history, undone.placements)!.placements[1].x).toBe(120);
  });

  it('stores only changed placements on a large desktop', () => {
    const before = Array.from({ length: 5000 }, (_, index) => placement(index));
    const after = before.map((item, index) => index === 2500 ? { ...item, width: 640 } : item);
    const history = recordDesktopHistory(emptyDesktopHistory(), '调整大小', before, after);
    expect(history.past[0].changes).toHaveLength(1);
    expect(JSON.stringify(history.past[0]).length).toBeLessThan(JSON.stringify(before).length / 100);
  });
});
