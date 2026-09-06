import type { KeyboardEvent } from 'react';
import { isComposingKeyboardEvent } from '../domain/keyboard';

function enabledMenuItems(menu: HTMLElement) {
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')]
    .filter((item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true');
}

export function handleMenuKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (isComposingKeyboardEvent(event.nativeEvent)) return;
  const horizontal = event.currentTarget.getAttribute('aria-orientation') === 'horizontal';
  const forwardKeys = horizontal ? ['ArrowDown', 'ArrowRight'] : ['ArrowDown'];
  const backwardKeys = horizontal ? ['ArrowUp', 'ArrowLeft'] : ['ArrowUp'];
  if (![...forwardKeys, ...backwardKeys, 'Home', 'End'].includes(event.key)) return;
  const items = enabledMenuItems(event.currentTarget);
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? items.length - 1
      : forwardKeys.includes(event.key) ? (current < 0 ? 0 : (current + 1) % items.length)
        : (current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length);
  items[next]?.focus();
}
