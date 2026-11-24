// Signing in for the HTTP tests, the way the app does after an SMS code (server/login.js): the number becomes a
// customer and gets one of the server's own sessions. login() can run at the top of a test file; the sessions are
// made by signInAll() in before(), once the test database is ready.
const pending = [];

/** Headers for a phone number, filled in by signInAll(). */
export function login(phone) {
  const headers = {};
  pending.push([headers, phone]);
  return headers;
}

export const SESSION_ENV = { SESSION_SECRET: 'test-session-secret-at-least-32-characters', MSG91_TEST_PHONE: '+919999900000', MSG91_TEST_CODE: '123456' };

/** Signs in every number passed to login() so far (after the database is migrated). */
export async function signInAll() {
  const store = await import('../server/store.js');
  const sessions = await import('../server/sessions.js');
  for (const [headers, phone] of pending.splice(0)) {
    const user = await store.upsertUser({ firebaseUid: `phone:${phone}`, phone });
    if (user.created) await store.addEvent({ userId: user.id, name: 'user.created', properties: { via: 'otp' } });
    headers.authorization = `Bearer ${(await sessions.create(user.id, phone, 'android')).token}`;
  }
}
