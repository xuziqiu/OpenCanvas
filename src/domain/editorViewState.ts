export type CardEditorSurface = 'canvas' | 'side-panel' | 'page';

type TextSelection = { from: number; to: number };

interface CardEditorViewState {
  selections: Partial<Record<CardEditorSurface, TextSelection>>;
  scrollTops: Partial<Record<CardEditorSurface, number>>;
  lastSelection?: TextSelection;
  lastScrollTop?: number;
}

const states = new Map<string, CardEditorViewState>();
const MAX_CACHED_CARDS = 500;

function stateFor(cardId: string) {
  const current = states.get(cardId);
  if (current) {
    states.delete(cardId);
    states.set(cardId, current);
    return current;
  }
  if (states.size >= MAX_CACHED_CARDS) states.delete(states.keys().next().value!);
  const created: CardEditorViewState = { selections: {}, scrollTops: {} };
  states.set(cardId, created);
  return created;
}

export function rememberCardEditorSelection(cardId: string, surface: CardEditorSurface, selection: TextSelection) {
  const normalized = { from: Math.max(1, selection.from), to: Math.max(1, selection.to) };
  const state = stateFor(cardId);
  state.selections[surface] = normalized;
  state.lastSelection = normalized;
}

export function recallCardEditorSelection(cardId: string, surface: CardEditorSurface) {
  const state = states.get(cardId);
  return state?.selections[surface] ?? state?.lastSelection;
}

export function rememberCardEditorScroll(cardId: string, surface: CardEditorSurface, scrollTop: number) {
  const normalized = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const state = stateFor(cardId);
  state.scrollTops[surface] = normalized;
  state.lastScrollTop = normalized;
}

export function recallCardEditorScroll(cardId: string, surface: CardEditorSurface) {
  const state = states.get(cardId);
  return state?.scrollTops[surface] ?? state?.lastScrollTop ?? 0;
}

export function clearCardEditorViewState() {
  states.clear();
}
