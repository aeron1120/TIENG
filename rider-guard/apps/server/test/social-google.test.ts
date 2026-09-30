import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHttpSocialAuth, SocialAuthError } from '../src/services/social.ts';

const creds = { clientId: 'expected-client-id', clientSecret: 'server-secret' };
const input = { code: 'auth-code', state: 'opaque-state', redirectUri: 'https://api.test/auth/oauth/google/callback', verifier: 'v'.repeat(43), nonce: 'expected-nonce' };

test('Google profile comes from a verified ID token and uses its sub, never userinfo', async () => {
  const originalFetch = globalThis.fetch;
  let tokenRequest: URLSearchParams | null = null;
  const audiences: unknown[] = [];
  globalThis.fetch = async (request, init) => {
    assert.equal(request, 'https://oauth2.googleapis.com/token');
    tokenRequest = new URLSearchParams(init?.body as URLSearchParams);
    return new Response(JSON.stringify({ access_token: 'access', id_token: 'signed-id-token' }), { status: 200 });
  };
  const social = createHttpSocialAuth({
    verifyIdToken: async (options: { idToken: string; audience: string }) => {
      assert.equal(options.idToken, 'signed-id-token');
      audiences.push(options.audience);
      return { getPayload: () => ({ sub: 'stable-sub', nonce: 'expected-nonce', email: 'rider@example.com', email_verified: true, name: 'Rider' }) };
    },
  } as unknown as Parameters<typeof createHttpSocialAuth>[0]);
  try {
    const profile = await social.fetchProfile('google', creds, input);
    assert.deepEqual(profile, { provider: 'google', subject: 'stable-sub', email: 'rider@example.com', name: 'Rider', phone: null });
    assert.deepEqual(audiences, ['expected-client-id']);
    assert.equal(tokenRequest!.get('code_verifier'), input.verifier);
    assert.equal(tokenRequest!.get('client_secret'), creds.clientSecret);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Google rejects an ID token whose verified nonce differs from this login', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'access', id_token: 'signed-id-token' }), { status: 200 });
  const social = createHttpSocialAuth({
    verifyIdToken: async () => ({ getPayload: () => ({ sub: 'stable-sub', nonce: 'another-login' }) }),
  } as unknown as Parameters<typeof createHttpSocialAuth>[0]);
  try {
    await assert.rejects(social.fetchProfile('google', creds, input), SocialAuthError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Google rejects a missing ID token even when an access token exists', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'access' }), { status: 200 });
  const social = createHttpSocialAuth({
    verifyIdToken: async () => { throw new Error('must not verify'); },
  } as unknown as Parameters<typeof createHttpSocialAuth>[0]);
  try {
    await assert.rejects(social.fetchProfile('google', creds, input), SocialAuthError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
