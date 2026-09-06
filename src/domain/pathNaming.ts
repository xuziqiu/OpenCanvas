const INVALID_WINDOWS_PATH_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function sanitizePathSegment(value: string, fallback = '', maxLength = 60) {
  const cleaned = value
    .trim()
    .replace(INVALID_WINDOWS_PATH_CHARACTERS, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, Math.max(1, maxLength))
    .replace(/[. ]+$/g, '');
  const safe = cleaned === '.' || cleaned === '..' ? '' : cleaned;
  if (!safe) return fallback;
  return WINDOWS_DEVICE_NAME.test(safe) ? `_${safe}` : safe;
}

export function normalizeUserFolderPath(value: string) {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => sanitizePathSegment(part))
    .filter(Boolean)
    .join('/');
}

export function sanitizeFileName(value: string, fallbackStem: string, extension: string) {
  const withoutExtension = value.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase())
    ? value.slice(0, -extension.length)
    : value;
  return `${sanitizePathSegment(withoutExtension, fallbackStem, 120)}${extension}`;
}

export function sanitizeRelativeFilePath(value: string, fallbackStem: string, extension: string) {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const requestedFileName = parts.pop() || '';
  const folders = parts.map((part) => sanitizePathSegment(part)).filter(Boolean);
  return [...folders, sanitizeFileName(requestedFileName, fallbackStem, extension)].join('/');
}

export function persistenceErrorMessage(error: unknown) {
  const technical = error instanceof Error ? error.message : String(error || '保存失败');
  if (/ENAMETOOLONG|path.{0,12}too long|路径.{0,8}过长/i.test(technical)) {
    return '路径过长，Windows 无法保存该文件。请缩短文件夹层级或文件名。';
  }
  if (/EACCES|EPERM|access.{0,12}denied|permission|拒绝访问|无写入权限/i.test(technical)) {
    return '目录为只读或没有写入权限。请检查文件夹权限，以及文件是否被其他程序锁定。';
  }
  if (/EBUSY|resource busy|file.{0,12}(?:busy|locked)|正在使用|被占用/i.test(technical)) {
    return '文件正被其他程序占用，暂时无法保存。关闭占用程序后可以重试。';
  }
  if (/ENOSPC|no space|磁盘空间不足/i.test(technical)) {
    return '磁盘空间不足，无法完成保存。释放空间后可以重试。';
  }
  return technical;
}
