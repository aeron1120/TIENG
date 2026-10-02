export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export const EDGE = 12;
export const GAP = 16;
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, Math.max(min, max)));

/** The card always fits; oversized targets expose the portion next to the card. */
export function tourLayout(target: Rect, viewport: Size, measuredCard: Size): { card: Rect; hole: Rect } {
  const width = Math.min(measuredCard.width, viewport.width - EDGE * 2);
  const height = Math.min(measuredCard.height, viewport.height - EDGE * 2);
  const left = clamp(target.x - 5, 4, viewport.width - 4);
  const top = clamp(target.y - 5, 4, viewport.height - 4);
  const right = clamp(target.x + target.width + 5, left, viewport.width - 4);
  const bottom = clamp(target.y + target.height + 5, top, viewport.height - 4);
  const hole = { x: left, y: top, width: right - left, height: bottom - top };
  let x = clamp(target.x, EDGE, viewport.width - width - EDGE);
  let y: number;
  if (right + GAP + width <= viewport.width - EDGE) {
    x = right + GAP;
    y = clamp(top, EDGE, viewport.height - height - EDGE);
  } else if (left - GAP - width >= EDGE) {
    x = left - GAP - width;
    y = clamp(top, EDGE, viewport.height - height - EDGE);
  } else if (bottom + GAP + height <= viewport.height - EDGE) {
    y = bottom + GAP;
  } else if (top - GAP - height >= EDGE) {
    y = top - GAP - height;
  } else {
    y = viewport.height - EDGE - height;
    hole.height = Math.max(0, Math.min(bottom, y - GAP) - top);
  }
  return { card: { x, y, width, height }, hole };
}

export function scrollDestination(targetY: number, currentY: number, desiredY: number, maxY: number) {
  return clamp(currentY + targetY - desiredY, 0, maxY);
}

export function nextAvailableStep(current: number, direction: 1 | -1, available: boolean[]): number {
  for (let i = current + direction; i >= 0 && i < available.length; i += direction) {
    if (available[i]) return i;
  }
  return -1;
}

export const interpolateRect = (from: Rect, to: Rect, t: number): Rect => ({
  x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t,
  width: from.width + (to.width - from.width) * t, height: from.height + (to.height - from.height) * t,
});
