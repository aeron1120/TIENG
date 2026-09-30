import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers.ts';
import { setConsents } from '../src/services/riders.ts';

const c3 = { reportId: 'mock-C3-1', mode: 'simulated', sensorMetadata: { dataSource: 'mock', provenance: 'handwritten contract fixture, no measured validation' }, samples: [
  { t: 0.2, seq: 200, accG: 10, gyroDps: 400, dv150: null, dvValid: false, dvInvalidReason: 'packet_gap', rawAcc: [32760, 0, 0] },
  { t: 0.3, seq: 300, accG: 1, gyroDps: 0, dv150: null, dvValid: false, dvInvalidReason: 'packet_gap' },
] };

test('mock C3 evidence survives persistence/export; ownership, consent and repeat responses are enforced', async () => {
  const t = await setup();
  const token = await t.login();
  const other = await t.login('01099999999');
  await t.call('POST', '/me/session', { token });
  const results = await Promise.all([1, 2].map(() => t.call('POST', '/me/indicators', { token, body: c3 })));
  assert.equal(results[0].json.incidentId, results[1].json.incidentId);
  const id = results[0].json.incidentId;
  const path = `/me/incidents/${id}`;
  const detail = (await t.call('GET', path, { token })).json;
  assert.equal(detail.analysis.decision, 'candidate');
  assert.equal(detail.analysis.quality.dvValid, false);
  assert.equal(detail.dataSource, 'mock');
  assert.equal(detail.feedback.groundTruth, 'unknown');
  assert.equal((await t.call('GET', path)).status, 401);
  assert.equal((await t.call('GET', path, { token: other })).status, 404);
  assert.equal((await t.call('GET', `${path}/export`, { token: other })).status, 404);
  assert.equal((await t.call('GET', `${path}/export`, { token })).status, 403);
  await t.call('PUT', '/me/consents/insuranceRecords', { token, body: { granted: true } });
  const exported = await t.call('GET', `${path}/export`, { token });
  assert.equal(exported.status, 200);
  assert.deepEqual(exported.json.sensorLog, c3.samples);
  const responses = await Promise.all([1, 2].map(() => t.call('POST', `${path}/respond`, { token, body: { response: 'ok' } })));
  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  assert.equal(responses[0].json.resolution, 'rider_cancelled');
  assert.equal(responses[1].json.timeline.filter((e: { type: string }) => e.type === 'rider_ok').length, 1);
  assert.equal((await t.call('POST', '/me/indicators', { token, body: c3 })).json.action, 'incident_existing');
  assert.equal((await t.call('POST', '/me/indicators', { token, body: { ...c3, reportId: 'mock-C3-rearmed' } })).json.action, 'incident_created');
  await t.advance(40);
  assert.deepEqual(t.reports, []);
  assert.deepEqual(t.sms, []);
});

test('heartbeat is not sensor reception, fresh measured reception expires and consent withdrawal stops collection', async () => {
  const t = await setup({ SENSOR_STALE_SECONDS: '60' });
  const token = await t.login();
  const reg = (await t.call('POST', '/device-api/register', { body: { name: 'contract fixture device', kind: 'tag' } })).json;
  await t.call('POST', '/me/device', { token, body: { pairingCode: reg.pairingCode } });
  await t.call('POST', '/me/session', { token });
  const headers = { authorization: `Device ${reg.deviceToken}` };
  await t.call('POST', '/device-api/heartbeat', { headers, body: { battery: 80 } });
  assert.equal((await t.call('GET', '/me', { token })).json.device.sensorState, 'waiting');
  await t.call('POST', '/device-api/indicators', { headers, body: { mode: 'live', sensorMetadata: { dataSource: 'measured', provenance: 'contract test only' }, samples: [{ t: 1, accG: 1, gyroDps: 0, bankDeg: 0, dv150: 0, dvValid: true }] } });
  assert.equal((await t.call('GET', '/me', { token })).json.device.sensorState, 'fresh');
  await t.advance(61);
  await t.call('POST', '/device-api/heartbeat', { headers, body: {} });
  const device = (await t.call('GET', '/me', { token })).json.device;
  assert.equal(device.connected, true);
  assert.equal(device.sensorState, 'stale');
  const riderId = (await t.call('GET', '/me', { token })).json.rider.id;
  await setConsents(t.ctx, riderId, { locationSensor: false });
  assert.equal((await t.call('GET', '/me', { token })).json.session, null);
  assert.equal((await t.call('POST', '/me/indicators', { token, body: c3 })).status, 403);
});

test('recipient reports a manual 119 action once; capture transport never creates a real delivery', async () => {
  const t = await setup();
  const token = await t.login();
  await t.call('POST', '/me/contacts', { token, body: { name: 'test contact', relation: 'family', phone: '01000000002' } });
  await t.call('POST', '/me/session', { token });
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;
  await t.advance(30);
  const link = t.sms[0]!.body.match(/https:\/\/rg\.test(\/s\/[\w-]+)/)![1]!;
  const responses = await Promise.all([1, 2].map(() => t.call('POST', `${link}/respond/reported_119`)));
  assert.deepEqual(responses.map((r) => r.status), [303, 303]);
  const detail = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  assert.equal(detail.timeline.filter((e: { type: string }) => e.type === 'contact_reported_119').length, 1);
  assert.equal(detail.steps.find((s: { key: string }) => s.key === 'emergency').detail.delivery, 'simulated');
  assert.equal((await t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE status = 'sent'"))?.n, 0);
  const riderId = (await t.call('GET', '/me', { token })).json.rider.id;
  await setConsents(t.ctx, riderId, { shareOnIncident: false });
  assert.equal((await t.call('GET', link)).status, 404);
});
