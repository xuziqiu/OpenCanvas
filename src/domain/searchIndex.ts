import type { Board, Card } from '../types';

export interface SearchRecord {
  kind: 'card' | 'board';
  id: string;
  title: string;
  body: string;
  path: string;
  tags: string[];
  normalizedTitle: string;
  normalizedBody: string;
  normalizedPath: string;
  plainBody: string;
}

export interface SearchHit {
  record: SearchRecord;
  score: number;
  snippet: string;
}

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
const stripMarkdown = (value: string) => value.replace(/```[\s\S]*?```/g, ' ').replace(/!?(\[([^\]]*)\])\([^)]*\)/g, '$2').replace(/[#>*_`~-]/g, ' ').replace(/\s+/g, ' ').trim();

function fuzzyScoreNormalized(haystack: string, needle: string): number {
  if (!needle) return 1;
  if (haystack === needle) return 120;
  if (haystack.startsWith(needle)) return 95 - Math.min(20, haystack.length - needle.length);
  const exactIndex = haystack.indexOf(needle);
  if (exactIndex >= 0) return 75 - Math.min(30, exactIndex * 2);
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const character of needle) {
    const index = haystack.indexOf(character, cursor);
    if (index < 0) return 0;
    if (first < 0) first = index;
    last = index;
    cursor = index + 1;
  }
  const span = Math.max(1, last - first + 1);
  return Math.max(5, 50 - (span - needle.length) * 3 - first);
}

export function fuzzyScore(value: string, query: string): number {
  const haystack = normalize(value);
  const needle = normalize(query.trim());
  return fuzzyScoreNormalized(haystack, needle);
}

function cardSearchRecord(card: Card): SearchRecord {
  const title = card.title || '未命名卡片';
  const plainBody = stripMarkdown(card.body);
  return { kind: 'card', id: card.id, title, body: card.body, path: card.relativePath, tags: [...new Set([...card.body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((match) => normalize(match[1])))], normalizedTitle: normalize(title), normalizedBody: normalize(card.body), normalizedPath: normalize(card.relativePath), plainBody };
}

function boardSearchRecord(board: Board): SearchRecord {
  const title = board.title || '未命名白板';
  return { kind: 'board', id: board.id, title, body: '', path: board.fileName, tags: [], normalizedTitle: normalize(title), normalizedBody: '', normalizedPath: normalize(board.fileName), plainBody: '' };
}

export function buildSearchRecords(cards: Card[], boards: Board[]): SearchRecord[] {
  const cardRecords = cards.map(cardSearchRecord);
  const boardRecords = boards.map(boardSearchRecord);
  return [...cardRecords, ...boardRecords];
}

/** Reuses parsed/normalized records for entities whose object identity did not change. */
export class IncrementalSearchIndex {
  private entries = new Map<string, { source: Card | Board; record: SearchRecord }>();

  update(cards: Card[], boards: Board[]): SearchRecord[] {
    const seen = new Set<string>();
    const records: SearchRecord[] = [];
    for (const card of cards) {
      const key = `card:${card.id}`;
      seen.add(key);
      const cached = this.entries.get(key);
      const record = cached?.source === card ? cached.record : cardSearchRecord(card);
      if (record !== cached?.record) this.entries.set(key, { source: card, record });
      records.push(record);
    }
    for (const board of boards) {
      const key = `board:${board.id}`;
      seen.add(key);
      const cached = this.entries.get(key);
      const record = cached?.source === board ? cached.record : boardSearchRecord(board);
      if (record !== cached?.record) this.entries.set(key, { source: board, record });
      records.push(record);
    }
    for (const key of this.entries.keys()) if (!seen.has(key)) this.entries.delete(key);
    return records;
  }
}

function tokenizeQuery(query: string) {
  const filters: Record<string, string[]> = {};
  const words: string[] = [];
  for (const token of query.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
    const filter = token.match(/^(type|tag|path):(.+)$/i);
    if (!filter) { words.push(token.replace(/^"|"$/g, '')); continue; }
    const key = filter[1].toLocaleLowerCase();
    (filters[key] ||= []).push(normalize(filter[2].replace(/^"|"$/g, '').replace(/^#/, '')));
  }
  return { filters, words: words.filter(Boolean) };
}

function makeSnippet(record: SearchRecord, words: string[]) {
  if (record.kind === 'board') return '白板';
  const plain = record.plainBody;
  if (!plain) return record.path;
  const lowered = normalize(plain);
  const index = words.map((word) => lowered.indexOf(normalize(word))).filter((value) => value >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, index - 36);
  const end = Math.min(plain.length, index + 90);
  return `${start ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`;
}

export function searchWorkspace(records: SearchRecord[], query: string, limit = 50): SearchHit[] {
  const { filters, words } = tokenizeQuery(query);
  return records.flatMap((record): SearchHit[] => {
    if (filters.type?.length && !filters.type.some((value) => value === record.kind || value === (record.kind === 'card' ? '卡片' : '白板'))) return [];
    if (filters.tag?.length && !filters.tag.every((tag) => record.tags.some((value) => value.includes(tag)))) return [];
    if (filters.path?.length && !filters.path.every((part) => record.normalizedPath.includes(part))) return [];
    let score = 0;
    for (const word of words) {
      const normalizedWord = normalize(word);
      const titleScore = fuzzyScoreNormalized(record.normalizedTitle, normalizedWord) * 2;
      const pathScore = fuzzyScoreNormalized(record.normalizedPath, normalizedWord);
      const bodyScore = fuzzyScoreNormalized(record.normalizedBody, normalizedWord) * .45;
      const tagScore = Math.max(0, ...record.tags.map((tag) => fuzzyScoreNormalized(tag, normalizedWord))) * 1.3;
      const best = Math.max(titleScore, pathScore, bodyScore, tagScore);
      if (!best) return [];
      score += best;
    }
    if (!words.length) score = 1;
    return [{ record, score, snippet: makeSnippet(record, words) }];
  }).sort((a, b) => b.score - a.score || a.record.title.localeCompare(b.record.title, 'zh-CN')).slice(0, limit);
}

export function replaceMarkdownTag(markdown: string, oldTag: string, nextTag?: string) {
  const escaped = oldTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const replacement = nextTag?.trim().replace(/^#/, '');
  return markdown.replace(new RegExp(`(^|\\s)#${escaped}(?=$|\\s|[.,;:!?，。；：！？、])`, 'giu'), (_match, prefix: string) => replacement ? `${prefix}#${replacement}` : prefix);
}
