// =============================================================================
// security.js: small security helpers used by the game server
// =============================================================================
//
// Everything in this file is "plain" code: no AI calls and no Cloudflare-only
// features beyond the standard Web Crypto API. That keeps it easy to read and
// easy to unit test (see test/security.test.js).
//
// One secret, many uses:
//   The Worker has ONE game secret (GAME_SECRET). Instead of creating a separate
//   secret for each job, we "label" each use. For example, the password for
//   level 2 today is computed from HMAC(secret, "password|2026-10-20|2"), and a
//   session token signature is HMAC(secret, "session|..."). Because the labels
//   differ, the outputs can never be confused with each other, and you only
//   have one secret to manage and rotate.
//
// What is HMAC?
//   HMAC is a keyed hash. Anyone can compute SHA-256 of some text, but only
//   someone holding the secret key can compute HMAC-SHA-256 of that text. So an
//   HMAC value works like a tamper-proof signature: the server can check that it
//   produced a value, and a player cannot forge one.

const encoder = new TextEncoder();

// -----------------------------------------------------------------------------
// hmacHex(secret, message)
// Returns HMAC-SHA-256(secret, message) as a lowercase hex string.
// -----------------------------------------------------------------------------
export async function hmacHex(secret, message) {
  // Turn the secret text into a CryptoKey the Web Crypto API can use.
  // "false" means the key cannot be exported back out of the crypto engine.
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  // Convert the raw bytes to hex so we can store and compare it as text.
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// -----------------------------------------------------------------------------
// safeEqual(a, b)
// Compares two strings in "constant time".
//
// A normal `a === b` stops at the first character that differs. In theory an
// attacker could time many requests to learn how many leading characters they
// got right. This version always looks at every character, so the time taken
// does not leak anything. It's a small thing for a game, but it's the habit we
// want for anything that compares secrets or signatures.
// -----------------------------------------------------------------------------
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Different lengths can't match. Length is not secret here (all our
  // signatures are 64 hex characters), so returning early is fine.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    // XOR is 0 only when the two character codes are identical.
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// -----------------------------------------------------------------------------
// utcDay(date)
// Returns the current day in UTC as "YYYY-MM-DD".
//
// Everything "daily" in this game uses UTC days: password rotation, the
// per-visitor limits, and the global limit. Workers AI also resets its free
// allocation at 00:00 UTC, so using the same clock keeps everything in step.
// 00:00 UTC is 5 p.m. Pacific during daylight time (4 p.m. in winter).
// -----------------------------------------------------------------------------
export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// derivePassword(secret, day, level, words)
// Picks today's password for one level from `words` (the list parsed from the
// WORD_LIST secret by words.js).
//
// The same inputs always give the same word, so the server never needs to store
// passwords anywhere: it recomputes them on every request. A new day gives new
// words, so answers posted online stop working by the next day.
// -----------------------------------------------------------------------------
export async function derivePassword(secret, day, level, words) {
  // Without words there's no password to pick. index.js checks the list when a
  // session starts, so this only fires if the secret is removed mid-session.
  if (!Array.isArray(words) || words.length === 0) throw new Error('WORD_LIST is empty');
  const hex = await hmacHex(secret, `password|${day}|${level}`);
  // Use the first 8 hex characters (32 bits) as a number, then map it onto the
  // word list with the remainder operator. The tiny bias this creates toward
  // some words is irrelevant for a game.
  const index = parseInt(hex.slice(0, 8), 16) % words.length;
  return words[index];
}

// -----------------------------------------------------------------------------
// lettersOnly(text)
// Uppercases text and removes everything that isn't A to Z.
// "c-a-c-t-u-s", "Cactus!" and "C A C T U S" all become "CACTUS".
//
// Used by the guess checker (so players don't lose on a typo in spacing) and by
// the level 3 output filter.
// -----------------------------------------------------------------------------
export function lettersOnly(text) {
  return String(text).toUpperCase().replace(/[^A-Z]/g, '');
}

// -----------------------------------------------------------------------------
// visitorId(secret, ip, day)
// Turns a visitor's IP address into an anonymous ID for rate limiting.
//
// Privacy: we never store raw IP addresses. The ID is an HMAC of the IP plus
// today's date, so:
//   - It can't be reversed into the IP without the secret.
//   - It changes every day, so visitors can't be tracked across days.
// We keep 32 hex characters (128 bits), which is plenty to avoid collisions.
// -----------------------------------------------------------------------------
export async function visitorId(secret, ip, day) {
  const hex = await hmacHex(secret, `visitor|${day}|${ip}`);
  return hex.slice(0, 32);
}

// -----------------------------------------------------------------------------
// Session tokens
//
// Cloudflare Turnstile tokens can only be checked once and expire after 5
// minutes. Asking a player to solve Turnstile before every single message would
// be annoying, so the flow is:
//   1. The player passes Turnstile once.
//   2. The server gives them a signed "session token" that lasts an hour
//      (SESSION_TTL_SECONDS).
//   3. Each chat message or guess sends that session token.
//
// Token format:  <expiry>.<random id>.<signature>
//   expiry     Unix time (seconds) when the token stops working.
//   random id  Random value so two tokens issued in the same second differ.
//   signature  HMAC(secret, "session|<expiry>|<random id>").
//
// The player can read the token but can't change the expiry, because they'd
// need the secret to produce a matching signature. Nothing about the session is
// stored on the server, which keeps the Worker simple.
// -----------------------------------------------------------------------------
export async function createSession(secret, ttlSeconds, nowMs = Date.now()) {
  const expiry = Math.floor(nowMs / 1000) + ttlSeconds;
  const id = crypto.randomUUID().replace(/-/g, '');
  const signature = await hmacHex(secret, `session|${expiry}|${id}`);
  return { token: `${expiry}.${id}.${signature}`, expiresAt: expiry };
}

export async function verifySession(secret, token, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length > 200) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expiryText, id, signature] = parts;

  // Strict format checks before doing any crypto, so junk input fails fast.
  if (!/^\d{10}$/.test(expiryText) || !/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{64}$/.test(signature)) {
    return false;
  }
  // Expired tokens fail even if the signature is valid.
  if (Number(expiryText) < Math.floor(nowMs / 1000)) return false;

  const expected = await hmacHex(secret, `session|${expiryText}|${id}`);
  return safeEqual(signature, expected);
}

// -----------------------------------------------------------------------------
// verifyTurnstile(...)
// Asks Cloudflare whether a Turnstile token from the browser is genuine.
//
// The browser widget proves "probably a human" by giving the page a token. The
// token means nothing until our server sends it to Cloudflare's siteverify API
// together with our SECRET key (which only the server has). Cloudflare answers
// with success true or false.
//
// expectedHostnames: list of hostnames the widget is allowed to run on (for
// example courtneyroot.dev). This stops someone from solving the widget on
// their own site and replaying the token here. Pass null to skip the check
// (used for local testing, where Cloudflare's test keys report a fake hostname).
// -----------------------------------------------------------------------------
export async function verifyTurnstile({ secretKey, token, ip, expectedHostnames, fetchImpl = fetch }) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
    return { ok: false, reason: 'missing-token' };
  }
  const body = new FormData();
  body.append('secret', secretKey);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);

  let result;
  try {
    const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    result = await response.json();
  } catch {
    // If Cloudflare can't be reached, fail closed (treat as not verified).
    return { ok: false, reason: 'verify-unreachable' };
  }

  if (!result.success) {
    return { ok: false, reason: (result['error-codes'] || []).join(',') || 'failed' };
  }
  if (expectedHostnames && !expectedHostnames.includes(result.hostname)) {
    return { ok: false, reason: 'wrong-hostname' };
  }
  return { ok: true };
}
