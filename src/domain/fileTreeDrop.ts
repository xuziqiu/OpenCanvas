export type FileTreeDragItem =
  | { kind: 'card'; path: string }
  | { kind: 'folder'; path: string };

export type FileTreeDropEvaluation =
  | { state: 'move' }
  | { state: 'noop'; message: string }
  | { state: 'invalid'; message: string };

function comparable(path: string) {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
}

function parentPath(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

function baseName(path: string) {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/').at(-1) ?? '';
}

/** Mirrors Windows path rules so drag feedback matches the eventual disk operation. */
export function evaluateFileTreeDrop(item: FileTreeDragItem, targetFolder: string, folders: string[]): FileTreeDropEvaluation {
  const source = comparable(item.path);
  const target = comparable(targetFolder);
  const currentParent = comparable(parentPath(item.path));
  if (currentParent === target) return { state: 'noop', message: '已经在这个目录中' };
  if (item.kind === 'card') return { state: 'move' };
  if (target === source || target.startsWith(`${source}/`)) {
    return { state: 'invalid', message: '不能把文件夹移入自身或它的子目录' };
  }
  const destination = comparable(targetFolder ? `${targetFolder}/${baseName(item.path)}` : baseName(item.path));
  if (folders.some((folder) => comparable(folder) === destination && comparable(folder) !== source)) {
    return { state: 'invalid', message: '目标位置已有同名文件夹' };
  }
  return { state: 'move' };
}
