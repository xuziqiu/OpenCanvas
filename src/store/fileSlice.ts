import type { StateCreator } from 'zustand';
import type { FileState, WorkspaceStore } from './storeTypes';

export const createFileSlice: StateCreator<WorkspaceStore, [], [], FileState> = () => ({
  saveState: 'saved',
  saveError: null,
  externalChangePaths: [],
  lastSavedAt: null,
  pendingImport: null,
});
