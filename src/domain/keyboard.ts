/**
 * Enter and Escape belong to the IME while a composition is active. Browsers
 * do not report this identically: modern engines expose `isComposing`, while
 * some Windows IMEs still surface the legacy keyCode 229 sentinel.
 */
export function isComposingKeyboardEvent(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>) {
  return event.isComposing || event.keyCode === 229;
}

export function isCreateSectionShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>) {
  return (event.ctrlKey || event.metaKey)
    && !event.altKey
    && !event.shiftKey
    && event.key.toLowerCase() === 'g';
}

const TEXT_EDITING_SELECTOR = 'input, textarea, select, [contenteditable="true"]';
const COMMAND_SURFACE_SELECTOR = 'button, a[href], input, textarea, select, [contenteditable="true"], [role="menuitem"], [role="option"], [role="combobox"]';

/**
 * Canvas shortcuts are global only while the spatial workspace owns the
 * keyboard. A focused control keeps its native keyboard behavior instead of
 * unexpectedly moving, duplicating or deleting the current canvas selection.
 */
export function isTextEditingTarget(target: EventTarget | null) {
  return typeof Element !== 'undefined' && target instanceof Element && Boolean(target.closest(TEXT_EDITING_SELECTOR));
}

export function isCommandSurfaceTarget(target: EventTarget | null) {
  return typeof Element !== 'undefined' && target instanceof Element && Boolean(target.closest(COMMAND_SURFACE_SELECTOR));
}

export function hasVisibleModalOrMenu(root: ParentNode = document) {
  if (typeof HTMLElement === 'undefined') return false;
  return [...root.querySelectorAll<HTMLElement>('[aria-modal="true"], [role="menu"]')].some((element) => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  });
}
