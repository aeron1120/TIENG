import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canAdvanceTourStep } from '../src/components/tour/steps.ts';
import { hasAgencyActivity, controlExperienceReducer, controlTutorialSteps } from '../src/features/demo/control-experience.ts';
import { initialState, type DemoAction, type EventClip } from '../src/features/demo/engine.ts';

const clip: EventClip = { caseId: 'A1', from: 0.581, to: 2.081, candidateAt: 1.551 };

test('only an empty agency uses the populated fallback; existing operational records stay visible', () => {
  assert.equal(hasAgencyActivity({ riders: [], orders: [], incidents: [] }), false);
  for (const key of ['riders', 'orders', 'incidents']) {
    assert.equal(hasAgencyActivity({ riders: [], orders: [], incidents: [], [key]: [{}] }), true);
  }
});

test('dispatcher tutorial requires rider selection and walks through detection, response and both handoffs', () => {
  let s = initialState('full', 0);
  const untouched = s;
  const original = JSON.stringify(s);
  const apply = (action: DemoAction) => { s = controlExperienceReducer(s, action); };
  const step = (target: string, picked: string | null = 'r1') => controlTutorialSteps(s, picked).find((item) => item.target === target)!;
  assert.equal(canAdvanceTourStep(step('control-select-r1', null)), false);
  assert.equal(canAdvanceTourStep(step('control-select-r1')), true);
  assert.equal(canAdvanceTourStep(step('control-start')), false);
  apply({ type: 'play', driver: 'control-experience' });
  for (let n = 0; n < 300 && !s.incident; n++) apply({ type: 'tick', dt: 0.1, clip });
  assert.equal(s.incident?.status, 'confirming');
  assert.equal(s.playing, false);
  assert.equal(canAdvanceTourStep(step('control-detection')), true);
  const stoppedAt = s.t;
  apply({ type: 'tick', dt: 50, clip });
  assert.equal(s.t, stoppedAt);
  assert.equal(canAdvanceTourStep(step('control-wait')), false);
  apply({ type: 'skipWait' });
  assert.equal(canAdvanceTourStep(step('control-wait')), true);
  assert.equal(s.orders.filter((order) => order.status === 'held').length, 2);
  apply({ type: 'ack' });
  apply({ type: 'call' });
  apply({ type: 'reassign', orderId: 'BT-2041', riderId: 'r2' });
  assert.equal(canAdvanceTourStep(step('demo-reassign-BT-2043-r4')), false);
  apply({ type: 'reassign', orderId: 'BT-2043', riderId: 'r4' });
  apply({ type: 'resolve' });
  assert.ok(controlTutorialSteps(s, 'r1').every(canAdvanceTourStep));
  assert.equal(s.orders.filter((order) => order.status === 'held').length, 0);
  assert.equal(JSON.stringify(untouched), original);
  apply({ type: 'reset', scenario: 'full', baseWall: 0 });
  assert.equal(canAdvanceTourStep(step('control-start')), false);
  assert.equal(s.incident, null);
});
