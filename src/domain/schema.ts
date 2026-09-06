import type { AttachmentDirection, Board, BoardAttachment, BoardConnector, BoardPlacement, Card, DesktopLayout, ProjectDirectory, VaultIntegrityIssue, WorkspaceSnapshot } from '../types';
import { FOLDED_CARD_HEIGHT, FOLDED_CARD_MIN_WIDTH } from './defaultPlacementSize';
import { findRootBoards } from './workspaceIndex';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const number = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const safePathPart = (value: string) => value.replace(/[<>:"|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '');
const normalizeRelativePath = (value: string) => value
  .replace(/\\/g, '/')
  .replace(/^\/+|\/+$/g, '')
  .split('/')
  .filter((part) => part && part !== '.' && part !== '..')
  .map(safePathPart)
  .filter(Boolean)
  .join('/');
const relativePath = (value: unknown, fallback = '') => normalizeRelativePath(text(value)) || normalizeRelativePath(fallback);

function uniqueById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function migrateIntegrityIssue(value: unknown): VaultIntegrityIssue | null {
  if (!isRecord(value)) return null;
  const kind = text(value.kind);
  const sourcePath = text(value.sourcePath);
  const message = text(value.message);
  if (!sourcePath || !message || !['missing-card', 'missing-board', 'broken-connector', 'missing-attachment', 'duplicate-id', 'invalid-file'].includes(kind)) return null;
  const repairAction = text(value.repairAction);
  return {
    kind: kind as VaultIntegrityIssue['kind'],
    sourcePath,
    message,
    boardId: text(value.boardId) || undefined,
    placementId: text(value.placementId) || undefined,
    connectorId: text(value.connectorId) || undefined,
    attachmentName: text(value.attachmentName) || undefined,
    repairAction: ['remove-reference', 'remove-connector', 'restore-attachment'].includes(repairAction)
      ? repairAction as VaultIntegrityIssue['repairAction']
      : undefined,
  };
}

function referenceIssues(cards: Card[], boards: Board[]): VaultIntegrityIssue[] {
  const issues: VaultIntegrityIssue[] = [];
  const cardIds = new Set(cards.map((card) => card.id));
  const boardIds = new Set(boards.map((board) => board.id));
  for (const board of boards) {
    const sourcePath = `boards/${board.fileName}`;
    const placementIds = new Set(board.placements.map((placement) => placement.id));
    for (const placement of board.placements) {
      if (placement.kind === 'card' && placement.entityId && !cardIds.has(placement.entityId)) {
        issues.push({ kind: 'missing-card', sourcePath, message: `放置项 ${placement.id} 引用了不存在的卡片 ${placement.entityId}`, boardId: board.id, placementId: placement.id, repairAction: 'remove-reference' });
      }
      if (placement.kind === 'board' && placement.entityId && !boardIds.has(placement.entityId)) {
        issues.push({ kind: 'missing-board', sourcePath, message: `放置项 ${placement.id} 引用了不存在的白板 ${placement.entityId}`, boardId: board.id, placementId: placement.id, repairAction: 'remove-reference' });
      }
    }
    for (const connector of board.connectors) {
      if (!placementIds.has(connector.from) || !placementIds.has(connector.to)) {
        issues.push({ kind: 'broken-connector', sourcePath, message: `连线 ${connector.id} 的端点已经不存在`, boardId: board.id, connectorId: connector.id, repairAction: 'remove-connector' });
      }
    }
  }
  return issues;
}

function migratePlacement(value: unknown): BoardPlacement | null {
  if (!isRecord(value)) return null;
  const legacyKind = text(value.kind, 'text');
  const kind = legacyKind === 'note' ? 'card' : legacyKind;
  if (kind !== 'card' && kind !== 'board' && kind !== 'text') return null;
  const defaultWidth = kind === 'card' ? 520 : 300;
  const defaultHeight = kind === 'card' ? 185 : 90;
  const collapsed = kind === 'card' && value.collapsed === true ? true : undefined;
  const rawHeight = number(value.height, defaultHeight);
  const storedExpandedHeightValue = number(value.expandedHeight, Number.NaN);
  const hasStoredExpandedHeight = Number.isFinite(storedExpandedHeightValue);
  const storedExpandedHeight = collapsed
    ? hasStoredExpandedHeight
      ? Math.max(145, storedExpandedHeightValue)
      : rawHeight > FOLDED_CARD_HEIGHT ? Math.max(145, rawHeight) : defaultHeight
    : undefined;
  const sectionId = text(value.sectionId) || undefined;
  const sectionIds = Array.isArray(value.sectionIds)
    ? [...new Set(value.sectionIds.map((item) => text(item)).filter(Boolean))]
    : [];
  if (sectionId) sectionIds.splice(0, sectionIds.length, sectionId, ...sectionIds.filter((item) => item !== sectionId));
  const sectionBaseBounds = isRecord(value.sectionBaseBounds)
    ? {
        x: number(value.sectionBaseBounds.x, Number.NaN),
        y: number(value.sectionBaseBounds.y, Number.NaN),
        width: number(value.sectionBaseBounds.width, Number.NaN),
        height: number(value.sectionBaseBounds.height, Number.NaN),
      }
    : undefined;
  const validSectionBaseBounds = sectionBaseBounds
    && Object.values(sectionBaseBounds).every((item) => Number.isFinite(item))
    && sectionBaseBounds.width > 0
    && sectionBaseBounds.height > 0
    ? sectionBaseBounds
    : undefined;
  return {
    id: text(value.id, crypto.randomUUID()),
    kind,
    entityId: text(value.entityId ?? value.refId) || undefined,
    text: text(value.text) || undefined,
    x: number(value.x, 0),
    y: number(value.y, 0),
    width: Math.max(collapsed ? FOLDED_CARD_MIN_WIDTH : 300, number(value.width, defaultWidth)),
    height: collapsed
      ? hasStoredExpandedHeight ? Math.max(FOLDED_CARD_HEIGHT, rawHeight) : FOLDED_CARD_HEIGHT
      : Math.max(kind === 'text' ? 60 : 145, rawHeight),
    color: text(value.color, kind === 'text' ? 'transparent' : 'paper'),
    collapsed,
    expandedHeight: storedExpandedHeight,
    autoHeight: typeof value.autoHeight === 'boolean' ? value.autoHeight : undefined,
    scrollTop: typeof value.scrollTop === 'number' && Number.isFinite(value.scrollTop) ? Math.max(0, value.scrollTop) : undefined,
    zIndex: typeof value.zIndex === 'number' ? value.zIndex : undefined,
    groupId: text(value.groupId) || undefined,
    sectionId: sectionIds[0],
    sectionIds: sectionIds.length ? sectionIds : undefined,
    sectionBaseBounds: validSectionBaseBounds,
    locked: typeof value.locked === 'boolean' ? value.locked : undefined,
    hidden: typeof value.hidden === 'boolean' ? value.hidden : undefined,
    isFrame: typeof value.isFrame === 'boolean' ? value.isFrame : undefined,
  };
}

function migrateConnector(value: unknown): BoardConnector | null {
  if (!isRecord(value)) return null;
  const from = text(value.from);
  const to = text(value.to);
  if (!from || !to) return null;
  const lineStyle = text(value.lineStyle, 'curve');
  const arrow = text(value.arrow, 'end');
  const fromAnchor = text(value.fromAnchor ?? value.beginPos);
  const toAnchor = text(value.toAnchor ?? value.endPos);
  const validAnchor = (anchor: string) => anchor === 'top' || anchor === 'right' || anchor === 'bottom' || anchor === 'left';
  const controlPoints = Array.isArray(value.controlPoints) ? value.controlPoints.flatMap((point) => {
    if (!isRecord(point)) return [];
    const x = number(point.x, Number.NaN);
    const y = number(point.y, Number.NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    const direction = text(point.direction);
    const normalizedDirection: 'vertical' | 'horizontal' | undefined = direction === 'vertical' || direction === 'horizontal' ? direction : undefined;
    return [{
      id: text(point.id, crypto.randomUUID()),
      x,
      y,
      direction: normalizedDirection,
    }];
  }) : [];
  return {
    id: text(value.id, crypto.randomUUID()),
    from,
    to,
    label: text(value.label) || undefined,
    color: text(value.color, 'neutral'),
    lineStyle: lineStyle === 'orthogonal' || lineStyle === 'straight' ? lineStyle : 'curve',
    arrow: arrow === 'none' || arrow === 'start' || arrow === 'both' ? arrow : 'end',
    width: Math.min(7, Math.max(1, number(value.width, 2))),
    dashed: typeof value.dashed === 'boolean' ? value.dashed : undefined,
    fromAnchor: validAnchor(fromAnchor) ? fromAnchor as BoardConnector['fromAnchor'] : undefined,
    toAnchor: validAnchor(toAnchor) ? toAnchor as BoardConnector['toAnchor'] : undefined,
    controlPoints,
  };
}

function migrateAttachment(value: unknown): BoardAttachment | null {
  if (!isRecord(value)) return null;
  const objectId = text(value.objectId);
  const attachedObjectId = text(value.attachedObjectId);
  const direction = text(value.direction ?? value.pushingDirection) as AttachmentDirection;
  if (!objectId || !attachedObjectId || objectId === attachedObjectId || !['top', 'right', 'bottom', 'left'].includes(direction)) return null;
  return { objectId, attachedObjectId, direction, gap: Math.max(0, number(value.gap, 40)) };
}

function migrateBoard(value: unknown, fileNameFallback = ''): Board | null {
  if (!isRecord(value)) return null;
  const now = new Date().toISOString();
  const placementsRaw = Array.isArray(value.placements) ? value.placements : Array.isArray(value.nodes) ? value.nodes : [];
  const connectorsRaw = Array.isArray(value.connectors) ? value.connectors : Array.isArray(value.edges) ? value.edges : [];
  const attachmentsRaw = Array.isArray(value.attachments) ? value.attachments : [];
  const viewport = isRecord(value.viewport) ? value.viewport : {};
  const placements = uniqueById(placementsRaw.map(migratePlacement).filter((item): item is BoardPlacement => Boolean(item)));
  const placementIds = new Set(placements.map((item) => item.id));
  return {
    version: 4,
    id: text(value.id, crypto.randomUUID()),
    fileName: text(value.fileName, fileNameFallback),
    title: text(value.title, '未命名白板'),
    projectId: text(value.projectId) || undefined,
    placements,
    connectors: uniqueById(connectorsRaw.map(migrateConnector).filter((item): item is BoardConnector => Boolean(item))),
    attachments: attachmentsRaw.map(migrateAttachment).filter((item): item is BoardAttachment => Boolean(item)).filter((item) => placementIds.has(item.objectId) && placementIds.has(item.attachedObjectId)),
    viewport: {
      x: number(viewport.x, 120),
      y: number(viewport.y, 80),
      zoom: Math.min(2.4, Math.max(.2, number(viewport.zoom, 0.8))),
    },
    createdAt: text(value.createdAt, now),
    updatedAt: text(value.updatedAt, now),
  };
}

function migrateCard(value: unknown): Card | null {
  if (!isRecord(value)) return null;
  const now = new Date().toISOString();
  const id = text(value.id);
  if (!id) return null;
  return {
    id,
    fileName: text(value.fileName, `${id}.md`),
    relativePath: relativePath(value.relativePath, text(value.fileName, `${id}.md`)),
    title: text(value.title, '未命名卡片'),
    body: text(value.body),
    createdAt: text(value.createdAt, now),
    updatedAt: text(value.updatedAt, now),
  };
}

function migrateProject(value: unknown): ProjectDirectory | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const path = relativePath(value.relativePath);
  if (!id || !path) return null;
  return {
    id,
    name: text(value.name, path.split('/').at(-1) || '未命名项目'),
    relativePath: path,
    createdAt: text(value.createdAt, new Date().toISOString()),
  };
}

function migrateDesktop(value: unknown, boards: Board[]): DesktopLayout {
  const raw = isRecord(value) ? value : {};
  const viewportRaw = isRecord(raw.viewport) ? raw.viewport : {};
  const rootBoards = findRootBoards(boards);
  const boardIds = new Set(rootBoards.map((board) => board.id));
  const placements = (Array.isArray(raw.placements) ? raw.placements : []).flatMap((placement) => {
    if (!isRecord(placement)) return [];
    const boardId = text(placement.boardId);
    if (!boardIds.has(boardId)) return [];
    return [{
      boardId,
      x: number(placement.x, 0),
      y: number(placement.y, 0),
      width: Math.max(300, number(placement.width, 430) <= 310 ? 430 : number(placement.width, 430)),
      height: Math.max(190, number(placement.height, 270) <= 200 ? 270 : number(placement.height, 270)),
    }];
  }).filter((placement, index, all) => all.findIndex((candidate) => candidate.boardId === placement.boardId) === index);
  const placedIds = new Set(placements.map((placement) => placement.boardId));
  for (const [index, board] of rootBoards.entries()) {
    if (placedIds.has(board.id)) continue;
    placements.push({ boardId: board.id, x: 120 + (index % 3) * 470, y: 110 + Math.floor(index / 3) * 310, width: 430, height: 270 });
  }
  return {
    placements,
    viewport: {
      x: number(viewportRaw.x, 70),
      y: number(viewportRaw.y, 70),
      zoom: Math.min(2.4, Math.max(.2, number(viewportRaw.zoom, .9))),
    },
  };
}

export function normalizeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  const raw = isRecord(value) ? value : {};
  const cardsRaw = Array.isArray(raw.cards) ? raw.cards : Array.isArray(raw.notes) ? raw.notes : [];
  const boardsRaw = Array.isArray(raw.boards) ? raw.boards : [];
  const projectsRaw = Array.isArray(raw.projects) ? raw.projects : [];
  const foldersRaw = Array.isArray(raw.folders) ? raw.folders : [];
  const migratedCards = cardsRaw.map(migrateCard).filter((item): item is Card => Boolean(item));
  const migratedBoards = boardsRaw.map((board) => migrateBoard(board)).filter((item): item is Board => Boolean(item));
  const migratedProjects = projectsRaw.map(migrateProject).filter((item): item is ProjectDirectory => Boolean(item));
  const loadIssues: VaultIntegrityIssue[] = Array.isArray(raw.loadIssues)
    ? raw.loadIssues.map(migrateIntegrityIssue).filter((issue): issue is VaultIntegrityIssue => Boolean(issue))
    : [];
  const duplicateIssues = (items: Array<{ id: string; sourcePath: string; label: string }>) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) loadIssues.push({ kind: 'duplicate-id', sourcePath: item.sourcePath, message: `${item.label} ID 重复：${item.id}；已暂不载入后出现的副本。` });
      seen.add(item.id);
    }
  };
  duplicateIssues(migratedCards.map((card) => ({ id: card.id, sourcePath: `notes/${card.relativePath}`, label: '卡片' })));
  duplicateIssues(migratedBoards.map((board) => ({ id: board.id, sourcePath: `boards/${board.fileName}`, label: '白板' })));
  duplicateIssues(migratedProjects.map((project) => ({ id: project.id, sourcePath: `notes/${project.relativePath}/.opencanvas-project.json`, label: '项目' })));
  const cards = uniqueById(migratedCards);
  const boards = uniqueById(migratedBoards);
  const projects = uniqueById(migratedProjects);
  loadIssues.push(...referenceIssues(cards, boards));
  const uniqueLoadIssues = loadIssues.filter((issue, index, all) => all.findIndex((candidate) =>
    candidate.kind === issue.kind
    && candidate.sourcePath === issue.sourcePath
    && candidate.message === issue.message
  ) === index);
  return {
    schemaVersion: 4,
    vaultPath: text(raw.vaultPath, '浏览器本地存储'),
    cards,
    boards,
    projects,
    folders: [...new Set(foldersRaw.map((folder) => relativePath(folder)).filter(Boolean))],
    desktop: migrateDesktop(raw.desktop, boards),
    loadIssues: uniqueLoadIssues.length ? uniqueLoadIssues : undefined,
  };
}
