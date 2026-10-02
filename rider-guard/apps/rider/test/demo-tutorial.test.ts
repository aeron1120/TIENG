import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoTutorialSteps, tutorialClockActions } from '../src/features/demo/tutorial.ts';
import { canAdvanceTourStep } from '../src/components/tour/steps.ts';
import { initialState, reduce, type DemoAction, type EventClip } from '../src/features/demo/engine.ts';

const clip: EventClip = { caseId: 'A1', from: 0.581, to: 2.081, candidateAt: 1.551 };

test('tutorial waits for real actions and sensor detection, then completes every response and handoff', () => {
  let state = initialState('full', 0);
  const apply = (action: DemoAction) => { state = reduce(state, action); };
  const step = (target: string) => demoTutorialSteps(state).find((item) => item.target === target)!;
  assert.equal(canAdvanceTourStep(step('demo-start')), false);
  assert.equal(canAdvanceTourStep(step('demo-sensor')), false);
  apply({ type: 'play', driver: 'test' });
  assert.equal(canAdvanceTourStep(step('demo-start')), true);
  for (let n = 0; n < 200 && !state.incident; n++) apply({ type: 'tick', dt: 0.1, clip });
  tutorialClockActions(state).forEach(apply);
  assert.equal(state.incident?.status, 'confirming');
  assert.equal(state.playing, false);
  assert.equal(canAdvanceTourStep(step('demo-sensor')), true);
  assert.equal(canAdvanceTourStep(step('demo-response-help')), false);
  apply({ type: 'respond', response: 'help' });
  assert.equal(canAdvanceTourStep(step('demo-response-help')), true);
  assert.equal(canAdvanceTourStep(step('demo-ack')), false);
  apply({ type: 'ack' });
  assert.equal(canAdvanceTourStep(step('demo-ack')), true);
  apply({ type: 'call' });
  assert.equal(canAdvanceTourStep(step('demo-call')), true);
  assert.equal(canAdvanceTourStep(step('demo-reassign-BT-2041-r2')), false);
  apply({ type: 'reassign', orderId: 'BT-2041', riderId: 'r2' });
  assert.equal(canAdvanceTourStep(step('demo-reassign-BT-2041-r2')), true);
  assert.equal(canAdvanceTourStep(step('demo-reassign-BT-2043-r4')), false);
  apply({ type: 'reassign', orderId: 'BT-2043', riderId: 'r4' });
  assert.equal(canAdvanceTourStep(step('demo-reassign-BT-2043-r4')), true);
  apply({ type: 'resolve' });
  assert.ok(demoTutorialSteps(state).every(canAdvanceTourStep));
  assert.equal(state.orders.filter((order) => order.status === 'held').length, 0);
});

test('clock stays stopped during explanations; restarting clears action completion', () => {
  const ready = initialState('full', 0);
  assert.deepEqual(tutorialClockActions(ready), []);
  assert.deepEqual(tutorialClockActions(reduce(ready, { type: 'play', driver: 'test' })), []);
  assert.ok(demoTutorialSteps(ready).filter((step) => step.interaction).every((step) => !canAdvanceTourStep(step)));
  assert.ok(demoTutorialSteps(ready).filter((step) => !step.interaction).every(canAdvanceTourStep));
});
