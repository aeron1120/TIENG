import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

// Exercise production input isolation against a small DOM boundary, without a browser dependency.
const source = stripTypeScriptTypes(readFileSync(new URL('../src/components/tour/platform.ts', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')) + '\nglobalThis.tour = { measureTarget, lockWebInput };';

function fixture() {
  let document: EventTarget & { body: Element; activeElement: Element | null };
  class Element {
    children: Element[] = [];
    parentElement: Element | null = null;
    style = { overflow: '', display: 'flex', visibility: 'visible', opacity: '1' };
    inert = false;
    hidden = false;
    isConnected = true;
    disabled = false;
    scrollHeight = 0;
    clientHeight = 0;
    x = 0; y = 0; width = 100; height = 44;
    append(child: Element) { child.parentElement = this; this.children.push(child); return child; }
    contains(child: Element): boolean { return child === this || this.children.some((el) => el.contains(child)); }
    querySelectorAll() { return this.children; }
    querySelector() { return null; }
    getAttribute(key: string) { return key === 'aria-disabled' && this.disabled ? 'true' : null; }
    hasAttribute() { return false; }
    getClientRects() { return this.style.display === 'none' ? [] : [this.getBoundingClientRect()]; }
    getBoundingClientRect() { return { x: this.x, y: this.y, width: this.width, height: this.height }; }
    focus() { document.activeElement = this; }
  }
  document = Object.assign(new EventTarget(), { body: new Element(), activeElement: null as Element | null });
  document.body.style.overflow = 'clip';
  const background = document.body.append(new Element());
  const alreadyInert = document.body.append(new Element());
  alreadyInert.inert = true;
  const portal = document.body.append(new Element());
  const card = portal.append(new Element());
  const skip = card.append(new Element());
  const previous = card.append(new Element()); previous.disabled = true;
  const next = card.append(new Element());
  const actions = { closed: 0, next: 0, previous: 0 };
  const realm = createContext({ document, HTMLElement: Element, Platform: { OS: 'web' }, getComputedStyle: (el: Element) => el.style, setTimeout, clearTimeout });
  runInContext(source, realm);
  const unlock = () => realm.tour.lockWebInput(card, { close: () => actions.closed++, next: () => actions.next++, previous: () => actions.previous++ });
  const key = (key: string, repeat = false, shiftKey = false) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key, repeat, shiftKey });
    document.dispatchEvent(event);
    return event;
  };
  return { document, background, alreadyInert, card, skip, next, actions, unlock, key, measure: realm.tour.measureTarget as (el: Element) => Promise<unknown> };
}

test('tour locks background input, traps focus, and restores previous state on repeated exits', () => {
  const f = fixture();
  for (let attempt = 0; attempt < 2; attempt++) {
    const release = f.unlock();
    assert.equal(f.background.inert, true);
    assert.equal(f.document.body.style.overflow, 'hidden');
    assert.equal(f.document.activeElement, f.next);
    assert.equal(f.key('Tab').defaultPrevented, true);
    assert.equal(f.document.activeElement, f.skip);
    f.key('Tab', false, true);
    assert.equal(f.document.activeElement, f.next);
    const wheel = new Event('wheel', { cancelable: true });
    f.document.dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, true);
    assert.equal(f.key('PageDown').defaultPrevented, true);
    release();
    assert.equal(f.background.inert, false);
    assert.equal(f.alreadyInert.inert, true);
    assert.equal(f.document.body.style.overflow, 'clip');
    const after = new Event('wheel', { cancelable: true });
    f.document.dispatchEvent(after);
    assert.equal(after.defaultPrevented, false);
    assert.equal(f.key('PageDown').defaultPrevented, false);
  }
});

test('arrow keys navigate once per press and Escape closes; cleanup removes shortcuts', () => {
  const f = fixture();
  const release = f.unlock();
  f.key('ArrowRight'); f.key('ArrowRight', true); f.key('ArrowLeft'); f.key('Escape');
  assert.deepEqual(f.actions, { closed: 1, next: 1, previous: 1 });
  release(); f.key('ArrowRight'); f.key('Escape');
  assert.deepEqual(f.actions, { closed: 1, next: 1, previous: 1 });
});

test('hidden ancestors are skipped but below-fold targets remain available for auto-scroll', async () => {
  const f = fixture();
  f.next.y = 1600;
  assert.deepEqual(JSON.parse(JSON.stringify(await f.measure(f.next))), { x: 0, y: 1600, width: 100, height: 44 });
  f.card.style.visibility = 'hidden';
  assert.equal(await f.measure(f.next), null);
  f.card.style.visibility = 'visible'; f.card.style.opacity = '0';
  assert.equal(await f.measure(f.next), null);
  f.card.style.opacity = '1'; f.next.isConnected = false;
  assert.equal(await f.measure(f.next), null);
});
