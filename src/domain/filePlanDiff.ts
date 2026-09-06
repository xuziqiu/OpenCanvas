export function changedEntityIds<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
  forcedIds: Iterable<string> = [],
) {
  const previous = new Map(before.map((item) => [item.id, item]));
  const forced = new Set(forcedIds);
  return after.filter((item) => previous.get(item.id) !== item || forced.has(item.id)).map((item) => item.id);
}
