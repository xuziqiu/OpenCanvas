import { describe, expect, it } from 'vitest';
import { buildSearchRecords, fuzzyScore, IncrementalSearchIndex, replaceMarkdownTag, searchWorkspace } from './searchIndex';
import type { Board, Card } from '../types';

const card = (id: string, title: string, body: string, relativePath = `${id}.md`): Card => ({ id, title, body, relativePath, fileName: relativePath.split('/').pop()!, createdAt: 'now', updatedAt: 'now' });
const board = (id: string, title: string): Board => ({ version: 4, id, title, fileName: `${id}.board.json`, placements: [], connectors: [], attachments: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 'now', updatedAt: 'now' });

describe('persistent search index', () => {
  it('ranks fuzzy title matches above body-only matches', () => {
    const records = buildSearchRecords([card('1', '摄影项目', '器材记录'), card('2', '普通卡片', '这里提到摄影项目')], [board('b', '摄影白板')]);
    const hits = searchWorkspace(records, '摄影项目');
    expect(hits[0].record.id).toBe('1');
    expect(hits[0].snippet).toBeTruthy();
    expect(fuzzyScore('摄影项目', '摄项')).toBeGreaterThan(0);
  });

  it('supports combined type, tag and path filters', () => {
    const records = buildSearchRecords([card('1', 'A', '#研究 内容', '项目/研究/A.md'), card('2', 'B', '#研究', '收件箱/B.md')], [board('b', '研究')]);
    expect(searchWorkspace(records, 'type:card tag:研究 path:项目')).toHaveLength(1);
    expect(searchWorkspace(records, 'type:白板')).toHaveLength(1);
  });

  it('renames or removes exact Markdown tags without damaging longer tags', () => {
    expect(replaceMarkdownTag('#研究 #研究法', '研究', '资料')).toBe('#资料 #研究法');
    expect(replaceMarkdownTag('正文 #研究。', '研究')).toBe('正文 。');
  });

  it('reuses unchanged records and only rebuilds the changed card', () => {
    const cards = Array.from({ length: 10000 }, (_, index) => card(String(index), `卡片 ${index}`, `正文 ${index}`));
    const index = new IncrementalSearchIndex();
    const first = index.update(cards, []);
    const changedCards = cards.map((item, itemIndex) => itemIndex === 2500 ? { ...item, body: '唯一变化 #更新' } : item);
    const second = index.update(changedCards, []);
    expect(second[0]).toBe(first[0]);
    expect(second[2499]).toBe(first[2499]);
    expect(second[2500]).not.toBe(first[2500]);
    expect(second[2501]).toBe(first[2501]);
    expect(searchWorkspace(second, '唯一变化')[0].record.id).toBe('2500');
  });

  it('keeps common 10000-card queries below the 100ms P95 budget', () => {
    const cards = Array.from({ length: 10000 }, (_, index) => card(String(index), `项目卡片 ${index}`, `正文 ${index} #项目`, `资料/${index}.md`));
    const records = new IncrementalSearchIndex().update(cards, []);
    const durations = Array.from({ length: 20 }, (_, index) => {
      const start = performance.now();
      searchWorkspace(records, index % 2 ? `项目卡片 ${9000 + index}` : 'type:card tag:项目 path:资料', 40);
      return performance.now() - start;
    }).sort((left, right) => left - right);
    expect(durations[Math.floor(durations.length * .95) - 1]).toBeLessThan(100);
  });
});
