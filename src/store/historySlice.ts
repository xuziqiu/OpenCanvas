import type { StateCreator } from 'zustand';
import { emptyHistory } from '../domain/history';
import type { HistoryState, WorkspaceStore } from './storeTypes';

export const createHistorySlice: StateCreator<WorkspaceStore, [], [], HistoryState> = () => ({
  commandHistory: emptyHistory(),
});
