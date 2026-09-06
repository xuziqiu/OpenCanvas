import type { Card } from '../types';

export type FileTreeVisibleRow =
  | { key: 'root'; kind: 'root'; depth: 0; parentKey: null; posInSet: 1; setSize: 1; expanded: boolean; hasChildren: boolean }
  | { key: `folder:${string}`; kind: 'folder'; depth: number; parentKey: string; posInSet: number; setSize: number; path: string; label: string; expanded: boolean; hasChildren: boolean; project: boolean }
  | { key: `card:${string}`; kind: 'card'; depth: number; parentKey: string; posInSet: number; setSize: number; card: Card }
  | { key: `new:${string}`; kind: 'new'; depth: number; parentKey: string; parentPath: string; itemKind: 'folder' | 'card' };

export interface FileTreeNewItem {
  kind: 'folder' | 'card';
  parentPath: string;
}

function parentPath(value: string) {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

function addFolderAndAncestors(target: Set<string>, path: string) {
  let current = path;
  while (current) {
    target.add(current);
    current = parentPath(current);
  }
}

function compareNatural(a: string, b: string) {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

/**
 * Flatten only the currently visible branch of the Notes hierarchy. The model
 * is DOM-independent, deterministic, and O(folders + cards), so the sidebar
 * can virtualize thousands of files without recursively rescanning arrays.
 */
export function buildVisibleFileTreeRows({
  folders,
  cards,
  expandedFolders,
  projectFolders = new Set<string>(),
  searchQuery = '',
  newItem = null,
}: {
  folders: string[];
  cards: Card[];
  expandedFolders: ReadonlySet<string>;
  projectFolders?: ReadonlySet<string>;
  searchQuery?: string;
  newItem?: FileTreeNewItem | null;
}): FileTreeVisibleRow[] {
  const query = searchQuery.trim().toLocaleLowerCase();
  const searchActive = Boolean(query);
  const folderSet = new Set(folders.map((folder) => folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean));
  // A portable Markdown path remains authoritative even if an imported vault
  // did not explicitly enumerate every directory. Materialize its ancestors
  // so nested files can never disappear into a visually flat tree.
  for (const card of cards) addFolderAndAncestors(folderSet, parentPath(card.relativePath));
  for (const folder of [...folderSet]) addFolderAndAncestors(folderSet, parentPath(folder));
  const normalizedFolders = [...folderSet];
  const includedFolders = new Set<string>();

  if (searchActive) {
    for (const card of cards) addFolderAndAncestors(includedFolders, parentPath(card.relativePath));
    for (const folder of normalizedFolders) {
      const label = folder.split('/').at(-1) ?? folder;
      if (label.toLocaleLowerCase().includes(query)) addFolderAndAncestors(includedFolders, folder);
    }
  } else {
    normalizedFolders.forEach((folder) => includedFolders.add(folder));
  }

  const foldersByParent = new Map<string, string[]>();
  for (const folder of normalizedFolders) {
    if (!includedFolders.has(folder)) continue;
    const parent = parentPath(folder);
    const siblings = foldersByParent.get(parent) ?? [];
    siblings.push(folder);
    foldersByParent.set(parent, siblings);
  }
  for (const siblings of foldersByParent.values()) siblings.sort((a, b) => compareNatural(a.split('/').at(-1) ?? a, b.split('/').at(-1) ?? b));

  const cardsByParent = new Map<string, Card[]>();
  for (const card of cards) {
    const parent = parentPath(card.relativePath);
    const siblings = cardsByParent.get(parent) ?? [];
    siblings.push(card);
    cardsByParent.set(parent, siblings);
  }
  for (const siblings of cardsByParent.values()) siblings.sort((a, b) => compareNatural(a.title || a.fileName, b.title || b.fileName));

  const rootExpanded = searchActive || expandedFolders.has('');
  const rows: FileTreeVisibleRow[] = [{
    key: 'root',
    kind: 'root',
    depth: 0,
    parentKey: null,
    posInSet: 1,
    setSize: 1,
    expanded: rootExpanded,
    hasChildren: Boolean((foldersByParent.get('')?.length ?? 0) + (cardsByParent.get('')?.length ?? 0) + (newItem?.parentPath === '' ? 1 : 0)),
  }];

  const appendNewItem = (folderPath: string, depth: number, parentKey: string) => {
    if (newItem?.parentPath !== folderPath || searchActive) return;
    rows.push({ key: `new:${newItem.kind}:${folderPath}`, kind: 'new', depth, parentKey, parentPath: folderPath, itemKind: newItem.kind });
  };

  const appendFolder = (folderPath: string, depth: number, parentKey: string, posInSet: number, setSize: number) => {
    const childFolders = foldersByParent.get(folderPath) ?? [];
    const childCards = cardsByParent.get(folderPath) ?? [];
    const expanded = searchActive || expandedFolders.has(folderPath);
    const hasChildren = Boolean(childFolders.length + childCards.length + (newItem?.parentPath === folderPath ? 1 : 0));
    const key = `folder:${folderPath}` as const;
    rows.push({
      key,
      kind: 'folder',
      depth,
      parentKey,
      posInSet,
      setSize,
      path: folderPath,
      label: folderPath.split('/').at(-1) ?? folderPath,
      expanded,
      hasChildren,
      project: projectFolders.has(folderPath),
    });
    if (!expanded) return;
    appendNewItem(folderPath, depth + 1, key);
    const childSetSize = childFolders.length + childCards.length;
    childFolders.forEach((child, index) => appendFolder(child, depth + 1, key, index + 1, childSetSize));
    childCards.forEach((card, index) => rows.push({ key: `card:${card.id}`, kind: 'card', depth: depth + 1, parentKey: key, posInSet: childFolders.length + index + 1, setSize: childSetSize, card }));
  };

  if (!rootExpanded) return rows;
  appendNewItem('', 0, 'root');
  const rootFolders = foldersByParent.get('') ?? [];
  const rootCards = cardsByParent.get('') ?? [];
  const rootSetSize = rootFolders.length + rootCards.length;
  rootFolders.forEach((folder, index) => appendFolder(folder, 0, 'root', index + 1, rootSetSize));
  rootCards.forEach((card, index) => rows.push({ key: `card:${card.id}`, kind: 'card', depth: 0, parentKey: 'root', posInSet: rootFolders.length + index + 1, setSize: rootSetSize, card }));
  return rows;
}
