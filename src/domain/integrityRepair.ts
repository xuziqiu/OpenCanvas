import type { VaultIntegrityIssue, WorkspaceSnapshot } from '../types';

/** Apply the same safe structural repairs in browser storage as the desktop
 * vault offers. The caller still decides when to persist the returned data. */
export function repairWorkspaceIntegrityIssue(
  snapshot: WorkspaceSnapshot,
  issue: VaultIntegrityIssue,
  updatedAt = new Date().toISOString(),
): WorkspaceSnapshot | null {
  if (!issue.boardId) return null;
  const board = snapshot.boards.find((candidate) => candidate.id === issue.boardId);
  if (!board) return null;

  if (issue.repairAction === 'remove-reference' && issue.placementId) {
    if (!board.placements.some((placement) => placement.id === issue.placementId)) return null;
    const placementId = issue.placementId;
    const repairedBoard = {
      ...board,
      placements: board.placements.filter((placement) => placement.id !== placementId),
      connectors: board.connectors.filter((connector) => connector.from !== placementId && connector.to !== placementId),
      attachments: board.attachments.filter((attachment) => attachment.objectId !== placementId && attachment.attachedObjectId !== placementId),
      updatedAt,
    };
    return { ...snapshot, boards: snapshot.boards.map((candidate) => candidate.id === board.id ? repairedBoard : candidate) };
  }

  if (issue.repairAction === 'remove-connector' && issue.connectorId) {
    if (!board.connectors.some((connector) => connector.id === issue.connectorId)) return null;
    const repairedBoard = {
      ...board,
      connectors: board.connectors.filter((connector) => connector.id !== issue.connectorId),
      updatedAt,
    };
    return { ...snapshot, boards: snapshot.boards.map((candidate) => candidate.id === board.id ? repairedBoard : candidate) };
  }

  return null;
}
