import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setup } from './helpers.ts';

const consents = { locationSensor: true, shareOnIncident: true, insuranceRecords: false };

test('인증번호로 가입하고 토큰으로 내 정보를 본다', async () => {
  const t = setup();
  const otp = await t.call('POST', '/auth/otp', { body: { phone: '010-1234-5678' } });
  assert.equal(otp.status, 200);
  assert.match(otp.json.devCode, /^\d{6}$/);
  assert.equal(t.sms[0]?.to, '01012345678');

  const verify = await t.call('POST', '/auth/verify', { body: { phone: '01012345678', code: otp.json.devCode, consents } });
  assert.equal(verify.status, 201);
  assert.equal(verify.json.isNew, true);

  const me = await t.call('GET', '/me', { token: verify.json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.rider.phone, '01012345678');
  assert.deepEqual(me.json.consents, { locationSensor: true, shareOnIncident: true, insuranceRecords: false, medicalInfo: false });
  assert.equal(me.json.session, null);
});

test('필수 동의가 빠지면 가입할 수 없다', async () => {
  const t = setup();
  const otp = await t.call('POST', '/auth/otp', { body: { phone: '01012345678' } });
  const res = await t.call('POST', '/auth/verify', {
    body: { phone: '01012345678', code: otp.json.devCode, consents: { ...consents, shareOnIncident: false } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'consent_required');
});

test('인증번호를 5번 틀리면 잠기고, 틀린 횟수는 롤백되지 않는다', async () => {
  const t = setup();
  const otp = await t.call('POST', '/auth/otp', { body: { phone: '01012345678' } });
  const wrong = otp.json.devCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const res = await t.call('POST', '/auth/verify', { body: { phone: '01012345678', code: wrong, consents } });
    assert.equal(res.json.error.code, 'otp_mismatch');
  }
  const locked = await t.call('POST', '/auth/verify', { body: { phone: '01012345678', code: otp.json.devCode, consents } });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.code, 'otp_locked');
});

test('인증번호 재요청은 30초 뒤에 가능하고, 휴대폰 번호가 아니면 거절한다', async () => {
  const t = setup();
  await t.call('POST', '/auth/otp', { body: { phone: '01012345678' } });
  const tooSoon = await t.call('POST', '/auth/otp', { body: { phone: '01012345678' } });
  assert.equal(tooSoon.status, 429);
  await t.advance(30);
  assert.equal((await t.call('POST', '/auth/otp', { body: { phone: '01012345678' } })).status, 200);

  const landline = await t.call('POST', '/auth/otp', { body: { phone: '02-123-4567' } });
  assert.equal(landline.status, 400);
});

test('토큰 없이 /me 에 접근하면 401', async () => {
  const t = setup();
  assert.equal((await t.call('GET', '/me')).status, 401);
  assert.equal((await t.call('GET', '/me', { token: 'nope' })).status, 401);
});

test('의료정보는 별도 동의가 있어야 저장된다 (민감정보, 9.3)', async () => {
  const t = setup();
  const token = await t.login();
  const denied = await t.call('PATCH', '/me', { token, body: { medical: { bloodType: 'A+' } } });
  assert.equal(denied.status, 403);

  await t.call('PUT', '/me/consents/medicalInfo', { token, body: { granted: true } });
  const saved = await t.call('PATCH', '/me', { token, body: { name: '김라이더', medical: { bloodType: 'A+' } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.medical.bloodType, 'A+');

  // 동의를 철회하면 저장된 의료정보도 지운다.
  await t.call('PUT', '/me/consents/medicalInfo', { token, body: { granted: false } });
  const me = await t.call('GET', '/me', { token });
  assert.equal(me.json.rider.medical, null);

  const required = await t.call('PUT', '/me/consents/locationSensor', { token, body: { granted: false } });
  assert.equal(required.status, 400);
});
