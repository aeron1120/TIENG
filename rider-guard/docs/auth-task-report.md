# Authentication task report — 2026-09-30

## Changed files

- Server: `apps/server/src/services/social.ts`, `oauth.ts`, `db.ts` (auth migration v6), `package.json`, `package-lock.json`, `test/oauth.test.ts`, `test/social-google.test.ts`, `test/helpers.ts`.
- Rider: `src/auth/AuthProvider.tsx`, `AfterSignIn.tsx`, `src/api/client.ts`, `hooks.ts`, `src/app/index.tsx`, `signup.tsx`, `auth/callback.tsx`, `_layout.tsx`, `src/features/socialLogin.ts`, `src/lib/storage.ts`.

## Behavior

- The server exchanges Google's authorization code with S256 PKCE, then checks its ID token through Google's maintained `google-auth-library`. The library verifies the signature against rotating Google keys, audience, issuer, and expiry; Rider Guard also checks the stored nonce and uses only the verified `sub` for identity. No Google userinfo response or email alone creates an identity. Kakao/Naver still use their existing profile flows.
- OAuth state is consumed with one conditional `DELETE ... RETURNING` tied to provider and expiry; login-code exchange already uses atomic `DELETE ... RETURNING`. Concurrent calls cannot both obtain a Rider Guard token. Production web return URLs are exactly `https://rider-guard.expo.app/auth/callback` and `https://tieng.pages.dev/auth/callback`; Google provider callback remains `${PUBLIC_BASE_URL}/auth/oauth/google/callback` (production value `https://rider-guard-api.onrender.com/auth/oauth/google/callback`).
- Web social login uses a full-page redirect. The one-time exchange key is durably stored before navigation and survives reload; callback errors can be retried. There is no web popup, so popup blocking is not applicable. Provider configuration absence is shown as a disabled Google button with an explanation; network failures and cancellations have separate paths.
- Stored Rider Guard tokens are checked with `/me` before private queries run. Restore has an eight-second request timeout and a recoverable error state; an outage retains the stored token. Sign-in awaits durable storage. Cross-tab storage changes revalidate and clear cached user data. Stale 401 responses cannot sign out a newer token. Private routes and incident queries require verified signed-in state.

## Verification

- `node --test test/oauth.test.ts test/social-google.test.ts test/auth.test.ts`: **31 passed, 0 failed**. Includes concurrent callback/code exchanges, PKCE/nonce binding, missing/mismatched Google ID token, provider return URLs, account isolation, logout, and existing email auth.
- `npm.cmd run typecheck` and `npm.cmd run lint` in `apps/server`: **passed**.
- Direct ESLint on all changed Rider auth files: **passed**. The Expo lint command itself could not create `C:\Users\aeron\.expo` under this sandbox; direct ESLint used the same local configuration.
- Rider `npm.cmd run typecheck`: **one unrelated shared-contract error** at `src/lib/format.ts:141`, where newly added `EmergencyDelivery: 'simulated'` is not handled. Parent assigned this to the follow-on UI work. No auth-file TypeScript errors were reported.

## External limits

- Live Google consent, callback, and account creation cannot be exercised without the configured Google OAuth client ID and server-only secret. The application reports missing provider configuration without pretending the login works. No credentials were added to code or client bundles.
- No deployment, external-service changes, commit, or push was performed.

Official references: [Google ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [Expo SDK 57 WebBrowser](https://docs.expo.dev/versions/v57.0.0/sdk/webbrowser/).
