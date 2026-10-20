// Tests for src/security.js and src/words.js. Run with: npm test
// These use Node's built-in test runner, so there's nothing extra to install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  derivePassword,
  hmacHex,
  lettersOnly,
  safeEqual,
  utcDay,
  verifySession,
  verifyTurnstile,
  visitorId,
} from '../src/security.js';
import { WORDS } from '../src/words.js';

const SECRET = 'test-secret';

test('word list: big enough, letters only, 6 to 10 letters, no duplicates', () => {
  assert.ok(WORDS.length >= 100, `only ${WORDS.length} words`);
  for (const word of WORDS) assert.match(word, /^[A-Z]{6,10}$/, word);
  assert.equal(new Set(WORDS).size, WORDS.length, 'duplicate words');
});

test('hmacHex gives a 64-character hex string and depends on the secret', async () => {
  const a = await hmacHex(SECRET, 'hello');
  const b = await hmacHex('other-secret', 'hello');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', undefined), false);
});

test('utcDay uses UTC, not local time', () => {
  // 11:30 p.m. Pacific on Oct 20 is already Oct 21 in UTC.
  assert.equal(utcDay(new Date('2026-10-21T06:30:00Z')), '2026-10-21');
});

test('derivePassword: same inputs give same word; levels and days differ', async () => {
  const p1 = await derivePassword(SECRET, '2026-10-20', 1);
  assert.equal(p1, await derivePassword(SECRET, '2026-10-20', 1));
  assert.ok(WORDS.includes(p1));

  // Across 5 levels and 10 days we should see many different words.
  const seen = new Set();
  for (let day = 10; day < 20; day++) {
    for (let level = 1; level <= 5; level++) {
      seen.add(await derivePassword(SECRET, `2026-10-${day}`, level));
    }
  }
  assert.ok(seen.size > 25, `only ${seen.size} distinct words in 50 picks`);
});

test('lettersOnly strips spacing and punctuation', () => {
  assert.equal(lettersOnly('c-a-c t.u s!'), 'CACTUS');
});

test('visitorId changes by day and never contains the IP', async () => {
  const a = await visitorId(SECRET, '203.0.113.9', '2026-10-20');
  const b = await visitorId(SECRET, '203.0.113.9', '2026-10-21');
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.ok(!a.includes('203'));
});

test('sessions: valid token passes, tampered or expired tokens fail', async () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const { token } = await createSession(SECRET, 3600, now);

  assert.equal(await verifySession(SECRET, token, now), true);
  // Wrong secret.
  assert.equal(await verifySession('other', token, now), false);
  // Two hours later: expired.
  assert.equal(await verifySession(SECRET, token, now + 2 * 3600 * 1000), false);

  // Tamper with the expiry to try to extend the session.
  const [expiry, id, sig] = token.split('.');
  const extended = `${Number(expiry) + 99999}.${id}.${sig}`;
  assert.equal(await verifySession(SECRET, extended, now), false);

  // Junk input.
  for (const junk of ['', 'a.b.c', null, 'x'.repeat(500)]) {
    assert.equal(await verifySession(SECRET, junk, now), false);
  }
});

test('verifyTurnstile: success, failure, wrong hostname, unreachable', async () => {
  const fakeFetch = (reply) => async () => ({ json: async () => reply });
  const base = { secretKey: 's', token: 't', ip: '1.2.3.4', expectedHostnames: ['courtneyroot.dev'] };

  assert.deepEqual(
    await verifyTurnstile({ ...base, fetchImpl: fakeFetch({ success: true, hostname: 'courtneyroot.dev' }) }),
    { ok: true },
  );
  assert.equal(
    (await verifyTurnstile({ ...base, fetchImpl: fakeFetch({ success: false, 'error-codes': ['invalid-input-response'] }) })).ok,
    false,
  );
  assert.equal(
    (await verifyTurnstile({ ...base, fetchImpl: fakeFetch({ success: true, hostname: 'evil.example' }) })).reason,
    'wrong-hostname',
  );
  assert.equal(
    (await verifyTurnstile({ ...base, fetchImpl: async () => { throw new Error('down'); } })).reason,
    'verify-unreachable',
  );
  assert.equal((await verifyTurnstile({ ...base, token: '' })).reason, 'missing-token');
});
