import assert from 'node:assert/strict';
import { test } from 'node:test';

import { interpretSpeech } from '../src/lib/speech.ts';

test('괜찮다는 말은 ok, 도움 요청은 help — 둘 다면 도움이 먼저', () => {
  assert.equal(interpretSpeech('괜찮아요'), 'ok');
  assert.equal(interpretSpeech('네 괜찬아요'), 'ok');
  assert.equal(interpretSpeech('이상 없어요'), 'ok');
  assert.equal(interpretSpeech('도와주세요'), 'help');
  assert.equal(interpretSpeech('살려 줘'), 'help');
  assert.equal(interpretSpeech('다리가 아파요'), 'help');
  assert.equal(interpretSpeech('안 괜찮아요'), 'help');
  assert.equal(interpretSpeech('괜찮은데 좀 도와줘'), 'help');
});

test('못 알아들은 말·빈 말은 아무것도 보내지 않는다', () => {
  assert.equal(interpretSpeech(''), null);
  assert.equal(interpretSpeech('   '), null);
  assert.equal(interpretSpeech('음 잠깐만요'), null);
});
