import { describe, expect, it } from 'vitest';
import { changedEntityIds } from './filePlanDiff';

describe('selective file-plan writes', () => {
  it('writes only new, changed, or explicitly moved entities', () => {
    const stable = { id: 'stable', value: 1 };
    const changed = { id: 'changed', value: 1 };
    const before = [stable, changed, { id: 'moved', value: 1 }];
    const after = [stable, { ...changed, value: 2 }, before[2], { id: 'new', value: 1 }];
    expect(changedEntityIds(before, after, ['moved'])).toEqual(['changed', 'moved', 'new']);
  });

  it('keeps an intentional empty write set empty', () => {
    const entity = { id: 'same' };
    expect(changedEntityIds([entity], [entity])).toEqual([]);
  });
});
