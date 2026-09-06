import type { StateCreator } from 'zustand';
import type { WorkspaceDataState, WorkspaceStore } from './storeTypes';

export const createDataSlice: StateCreator<WorkspaceStore, [], [], WorkspaceDataState> = () => ({
  ready: false,
  vaultPath: '',
  cards: [],
  boards: [],
  projects: [],
  folders: [],
  desktop: { placements: [], viewport: { x: 70, y: 70, zoom: .9 } },
});
