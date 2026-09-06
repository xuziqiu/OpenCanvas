import { FOLDED_CARD_MIN_WIDTH } from '../domain/defaultPlacementSize';
import { cardHeightForContent } from '../domain/fitPlacementContent';

/** Measure the rendered content itself, not the scroll viewport's current size. */
export function measureCardContentHeight(editor: HTMLElement) {
  const children = Array.from(editor.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
  const contentBottom = children.reduce((bottom, child) => Math.max(
    bottom,
    child.offsetTop + Math.max(child.offsetHeight, child.scrollHeight),
  ), 0);
  const paddingBottom = Number.parseFloat(window.getComputedStyle(editor).paddingBottom) || 0;
  return cardHeightForContent(contentBottom + paddingBottom);
}

export function measureFoldedCardWidth(title: HTMLElement) {
  // The folded strip reserves balanced leading/trailing controls and measures
  // the title without inheriting the current width clamp.
  return Math.max(FOLDED_CARD_MIN_WIDTH, Math.ceil(title.scrollWidth + 96));
}
