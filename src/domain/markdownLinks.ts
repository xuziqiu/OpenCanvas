import type { Card } from '../types';

const normalized = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase();
const withoutExtension = (value: string) => value.replace(/\.md$/i, '');

function directory(path: string) {
  const parts = path.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts;
}

function resolveRelative(sourcePath: string, target: string) {
  const parts = target.startsWith('/') ? [] : directory(sourcePath);
  for (const part of target.replace(/\\/g, '/').replace(/^\//, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return parts.join('/');
}

function relativePath(sourcePath: string, targetPath: string) {
  const from = directory(sourcePath);
  const to = targetPath.replace(/\\/g, '/').split('/');
  let common = 0;
  while (common < from.length && common < to.length && from[common].toLocaleLowerCase() === to[common].toLocaleLowerCase()) common += 1;
  const path = [...Array(from.length - common).fill('..'), ...to.slice(common)].join('/');
  return path || to.at(-1) || targetPath;
}

/** Preserve portable links when cards or their parent directories move. */
export function rewriteMarkdownLinksAfterMoves(before: Card[], after: Card[], updatedAt: string) {
  const beforeById = new Map(before.map((card) => [card.id, card]));
  const afterById = new Map(after.map((card) => [card.id, card]));
  const targets = new Map<string, string>();
  for (const card of before) {
    targets.set(normalized(card.relativePath), card.id);
    targets.set(normalized(withoutExtension(card.relativePath)), card.id);
    targets.set(normalized(card.fileName), card.id);
    targets.set(normalized(withoutExtension(card.fileName)), card.id);
    targets.set(normalized(card.title), card.id);
  }

  return after.map((nextSource) => {
    const oldSource = beforeById.get(nextSource.id) ?? nextSource;
    let body = nextSource.body;
    body = body.replace(/(!?\[[^\]]*\]\()(<)?([^)>#?]+\.md)(>)?((?:#[^)]*)?\))/gi, (match, prefix: string, open: string | undefined, rawTarget: string, close: string | undefined, suffix: string) => {
      let decoded = rawTarget;
      try { decoded = decodeURIComponent(rawTarget); } catch { /* Keep the literal path. */ }
      const targetId = targets.get(normalized(resolveRelative(oldSource.relativePath, decoded)));
      const nextTarget = targetId ? afterById.get(targetId) : undefined;
      if (!nextTarget) return match;
      const rewritten = relativePath(nextSource.relativePath, nextTarget.relativePath).replace(/ /g, '%20');
      return `${prefix}${open ?? ''}${rewritten}${close ?? ''}${suffix}`;
    });
    body = body.replace(/(!?\[\[)([^\]|#]+)((?:#[^\]|]+)?(?:\|[^\]]+)?)\]\]/g, (match, prefix: string, rawTarget: string, suffix: string) => {
      const targetKey = normalized(rawTarget.trim());
      const resolvedPath = normalized(withoutExtension(resolveRelative(oldSource.relativePath, rawTarget.trim())));
      const targetId = targets.get(targetKey) ?? targets.get(resolvedPath);
      const oldTarget = targetId ? beforeById.get(targetId) : undefined;
      const nextTarget = targetId ? afterById.get(targetId) : undefined;
      if (!oldTarget || !nextTarget) return match;
      const pathLike = rawTarget.includes('/') || rawTarget.includes('\\') || /\.md$/i.test(rawTarget);
      const replacement = pathLike
        ? withoutExtension(relativePath(nextSource.relativePath, nextTarget.relativePath))
        : nextTarget.title;
      return `${prefix}${replacement}${suffix}]]`;
    });
    return body === nextSource.body ? nextSource : { ...nextSource, body, updatedAt };
  });
}
