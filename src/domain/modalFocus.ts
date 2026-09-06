const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function visible(element: HTMLElement) {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
}

function focusableElements(modal: HTMLElement) {
  return [...modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(visible);
}

function visibleModals() {
  return [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter(visible);
}

function visibleMenus() {
  return [...document.querySelectorAll<HTMLElement>('[role="menu"]')].filter(visible);
}

function modalsInside(node: Node) {
  if (!(node instanceof HTMLElement)) return [];
  const result: HTMLElement[] = [];
  if (node.matches('[aria-modal="true"]')) result.push(node);
  result.push(...node.querySelectorAll<HTMLElement>('[aria-modal="true"]'));
  return result;
}

function menusInside(node: Node) {
  if (!(node instanceof HTMLElement)) return [];
  const result: HTMLElement[] = [];
  if (node.matches('[role="menu"]')) result.push(node);
  result.push(...node.querySelectorAll<HTMLElement>('[role="menu"]'));
  return result;
}

/**
 * Keeps every modal surface keyboard-local without requiring each dialog to
 * duplicate focus-trap code. Nested confirmation dialogs restore focus to the
 * control that opened them; closing the outer dialog returns to its launcher.
 */
export function installModalFocusManager() {
  const openers = new WeakMap<HTMLElement, HTMLElement | null>();
  const menuOpeners = new WeakMap<HTMLElement, HTMLElement | null>();
  let lastNonModalFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;

  const trackFocus = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement && !target.closest('[aria-modal="true"]')) lastNonModalFocus = target;
  };

  const focusInto = (modal: HTMLElement) => {
    const target = focusableElements(modal)[0] ?? modal;
    if (target === modal && modal.tabIndex < 0) modal.tabIndex = -1;
    target.focus({ preventScroll: true });
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        for (const modal of modalsInside(node)) {
          if (!openers.has(modal)) {
            // A newly added modal may be nested inside the current one. Keep
            // the actual focused launcher even when it belongs to the outer
            // modal so closing the inner confirmation restores one level at a
            // time instead of dropping focus behind both surfaces.
            const activeElement = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
              ? document.activeElement
              : null;
            // React's autoFocus runs during the commit, before MutationObserver
            // reports the new modal. If focus has already moved inside this
            // very modal, it is not the launcher; use the last focus outside
            // any modal. A control inside a different (parent) modal remains a
            // valid opener for nested confirmations.
            const active = activeElement && !modal.contains(activeElement)
              ? activeElement
              : lastNonModalFocus;
            openers.set(modal, active === document.body ? lastNonModalFocus : active);
          }
          window.requestAnimationFrame(() => {
            const topmost = visibleModals().at(-1);
            if (modal.isConnected && topmost === modal && !modal.contains(document.activeElement)) focusInto(modal);
          });
        }
        for (const menu of menusInside(node)) {
          if (!menuOpeners.has(menu)) menuOpeners.set(menu, document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : lastNonModalFocus);
          window.requestAnimationFrame(() => {
            const topmost = visibleMenus().at(-1);
            if (!menu.isConnected || topmost !== menu || menu.contains(document.activeElement)) return;
            menu.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
          });
        }
      }
      for (const node of record.removedNodes) {
        for (const modal of modalsInside(node)) {
          const opener = openers.get(modal);
          window.requestAnimationFrame(() => {
            if (!opener?.isConnected) return;
            const topmost = visibleModals().at(-1);
            if (!topmost || topmost.contains(opener)) opener.focus({ preventScroll: true });
          });
        }
        for (const menu of menusInside(node)) {
          const opener = menuOpeners.get(menu);
          window.requestAnimationFrame(() => {
            if (visibleModals().length || visibleMenus().length || !opener?.isConnected) return;
            opener.focus({ preventScroll: true });
          });
        }
      }
    }
  });

  const trapTab = (event: KeyboardEvent) => {
    const modal = visibleModals().at(-1);
    if (event.key === 'Escape' && modal) {
      const opener = openers.get(modal);
      const closeControl = modal.querySelector<HTMLElement>('[data-modal-close]:not([disabled])');
      if (closeControl) {
        event.preventDefault();
        event.stopPropagation();
        closeControl.click();
      }
      const restoreDeadline = performance.now() + 1000;
      const restoreWhenClosed = () => {
        if (!modal.isConnected) {
          if (opener?.isConnected) opener.focus({ preventScroll: true });
          return;
        }
        // ExitPresence retains the dialog for its exit motion. Count real
        // elapsed time rather than frames: twelve frames are only ~100ms on a
        // 120Hz display and can finish before a 170ms dismissal animation.
        if (performance.now() < restoreDeadline) window.requestAnimationFrame(restoreWhenClosed);
      };
      window.requestAnimationFrame(restoreWhenClosed);
      return;
    }
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    if (!modal) return;
    const items = focusableElements(modal);
    if (!items.length) {
      event.preventDefault();
      focusInto(modal);
      return;
    }
    const active = document.activeElement;
    const index = items.indexOf(active as HTMLElement);
    if (!modal.contains(active) || (!event.shiftKey && index === items.length - 1) || (event.shiftKey && index <= 0)) {
      event.preventDefault();
      (event.shiftKey ? items.at(-1) : items[0])?.focus({ preventScroll: true });
    }
  };

  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('focusin', trackFocus, true);
  window.addEventListener('keydown', trapTab, true);
  return () => {
    observer.disconnect();
    window.removeEventListener('focusin', trackFocus, true);
    window.removeEventListener('keydown', trapTab, true);
  };
}
