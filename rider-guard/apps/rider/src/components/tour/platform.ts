import { Platform, type View } from 'react-native';
import type { Rect } from './geometry';

export function measureTarget(node: Pick<View, 'measureInWindow'> | null): Promise<Rect | null> {
  if (!node) return Promise.resolve(null);
  if (Platform.OS === 'web') {
    const el = node as unknown as HTMLElement;
    if (!el.isConnected || !el.getClientRects().length) return Promise.resolve(null);
    for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent);
      if (parent.hidden || css.display === 'none' || css.visibility === 'hidden' || css.opacity === '0') return Promise.resolve(null);
    }
    const { x, y, width, height } = el.getBoundingClientRect();
    return Promise.resolve(width > 0 && height > 0 ? { x, y, width, height } : null);
  }
  return new Promise((resolve) => {
    // An unmounted native view may never call back; navigation must still finish.
    const timeout = setTimeout(() => resolve(null), 120);
    node.measureInWindow((x, y, width, height) => {
      clearTimeout(timeout);
      resolve(width > 0 && height > 0 ? { x, y, width, height } : null);
    });
  });
}

/** Input locking is separate from scrolling: the guide can still scroll programmatically. */
export function lockWebInput(card: View, actions: { close: () => void; next: () => void; previous: () => void }) {
  if (Platform.OS !== 'web') return () => {};
  const element = card as unknown as HTMLElement;
  const overflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  let portal: HTMLElement = element;
  while (portal.parentElement && portal.parentElement !== document.body) portal = portal.parentElement;
  const siblings = Array.from(document.body.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node !== portal);
  const inert = siblings.map((node) => node.inert);
  siblings.forEach((node) => { node.inert = true; });
  const controls = () => Array.from(element.querySelectorAll<HTMLElement>('[role="button"], button, [tabindex="0"]'))
    .filter((node) => node.getAttribute('aria-disabled') !== 'true' && !node.hasAttribute('disabled') && node.getClientRects().length);
  const focusNext = () => controls().at(-1)?.focus({ preventScroll: true });
  focusNext();
  const keydown = (event: KeyboardEvent) => {
    if ((event.key === 'Enter' || event.key === ' ') && !element.contains(event.target as Node)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); actions.close(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); if (!event.repeat) actions.next(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); if (!event.repeat) actions.previous(); }
    else if (event.key === 'Tab') {
      event.preventDefault();
      const buttons = controls();
      const index = buttons.indexOf(document.activeElement as HTMLElement);
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus({ preventScroll: true });
    } else if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      if (event.key !== ' ' || !element.contains(event.target as Node)) event.preventDefault();
    } else if (!element.contains(event.target as Node)) event.preventDefault();
    // Do not let app-level keyboard shortcuts activate the covered screen.
    if (event.key !== 'Enter' && event.key !== ' ') event.stopPropagation();
  };
  const preventScroll = (event: Event) => {
    const body = element.querySelector('#tour-card-body');
    if (body?.contains(event.target as Node) && body.scrollHeight > body.clientHeight) return;
    event.preventDefault();
  };
  const focusin = (event: FocusEvent) => { if (!element.contains(event.target as Node)) focusNext(); };
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('wheel', preventScroll, { passive: false, capture: true });
  document.addEventListener('touchmove', preventScroll, { passive: false, capture: true });
  document.addEventListener('focusin', focusin, true);
  return () => {
    document.body.style.overflow = overflow;
    siblings.forEach((node, i) => { node.inert = inert[i]; });
    document.removeEventListener('keydown', keydown, { capture: true });
    document.removeEventListener('wheel', preventScroll, { capture: true });
    document.removeEventListener('touchmove', preventScroll, { capture: true });
    document.removeEventListener('focusin', focusin, { capture: true });
  };
}
