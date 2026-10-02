import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tourLayout, nextAvailableStep, scrollDestination } from '../src/components/tour/geometry.ts';

test('desktop card sits beside the target without covering it', () => {
  const { card, hole } = tourLayout({ x: 40, y: 100, width: 300, height: 400 }, { width: 1280, height: 800 }, { width: 350, height: 260 });
  assert.ok(card.x >= hole.x + hole.width + 12);
  assert.ok(card.y >= 12 && card.y + card.height <= 788);
});

test('small phones and landscape keep every card edge on screen', () => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 667, height: 320 }]) {
    const { card, hole } = tourLayout({ x: 16, y: 20, width: viewport.width - 32, height: 600 }, viewport, { width: 350, height: 270 });
    assert.ok(card.x >= 12 && card.y >= 12);
    assert.ok(card.x + card.width <= viewport.width - 12);
    assert.ok(card.y + card.height <= viewport.height - 12);
    assert.ok(hole.height >= 0);
    assert.ok(hole.y + hole.height <= card.y - 12);
  }
});

test('bottom navigation has its card above it', () => {
  const { card, hole } = tourLayout({ x: 0, y: 761, width: 390, height: 83 }, { width: 390, height: 844 }, { width: 350, height: 250 });
  assert.ok(card.y + card.height <= hole.y - 12);
});

test('offscreen targets scroll into a reserved space, with scroll limits respected', () => {
  assert.equal(scrollDestination(900, 0, 12, 1500), 888);
  assert.equal(scrollDestination(-200, 100, 12, 1500), 0);
  assert.equal(scrollDestination(900, 0, 12, 400), 400);
});

test('missing targets are skipped forwards and backwards, and boundaries terminate', () => {
  const available = [true, false, false, true];
  assert.equal(nextAvailableStep(0, 1, available), 3);
  assert.equal(nextAvailableStep(3, -1, available), 0);
  assert.equal(nextAvailableStep(3, 1, available), -1);
  assert.equal(nextAvailableStep(-1, 1, [false, false]), -1);
});
