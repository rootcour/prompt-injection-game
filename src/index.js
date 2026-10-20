// =============================================================================
// index.js: the game server's front door (a Cloudflare Worker)
// =============================================================================
//
// A Cloudflare Worker is a small program that runs on Cloudflare's network and
// answers web requests. This one is the "back end" for the prompt injection
// game on courtneyroot.dev. The website (front end) sends it requests; it talks
// to the AI and sends answers back.
//
// Why a separate server at all? The website is static: every file is public.
// If the passwords or the AI calls lived in the website's JavaScript, anyone
// could open their browser's developer tools and read the passwords. Keeping
// them in the Worker means the secret never leaves the server.
//
// Endpoints (all POST, all JSON):
//
//   /api/session  { turnstileToken }        -> { session, expiresAt }
//       Checks the Cloudflare Turnstile token (the "are you human?" check) and
//       returns a session token that's good for an hour.
//
//   /api/chat     { level, message }        -> { reply, blockedBy }
//       Header: Authorization: Bearer <session>
//       Sends the player's message through that level's defenses and the AI.
//
//   /api/guess    { level, guess }          -> { correct }
//       Header: Authorization: Bearer <session>
//       Checks a password guess. No AI involved.
//
// Protections, in the order a request meets them:
//   1. Origin check     only pages on the allowed sites can call the API
//   2. Size limits      request bodies and messages have a maximum length
//   3. Session check    the player passed Turnstile within the last hour
//   4. Daily limits     global and per-visitor caps (see limiter.js)
//   5. Workers AI cap   on the Free plan, Cloudflare stops AI calls after the
//                       free daily allocation instead of billing
//
// Settings come from wrangler.jsonc ("vars") and from secrets you set with
// `npx wrangler secret put`. See SETUP.md.

import { LEVEL_COUNT, playTurn } from './levels.js';
import {
  createSession,
  derivePassword,
  lettersOnly,
  safeEqual,
  utcDay,
  verifySession,
  verifyTurnstile,
  visitorId,
} from './security.js';

// Wrangler needs the Durable Object class exported from the main file so it can
// find it. See "durable_objects" in wrangler.jsonc.
export { DailyLimiter } from './limiter.js';

// Biggest request body we'll read, in characters. Messages are capped lower
// than this (MAX_MESSAGE_CHARS); this is just a backstop against huge uploads.
const MAX_BODY_CHARS = 4000;

export default {
  // ---------------------------------------------------------------------------
  // fetch(request, env)
  // Cloudflare calls this for every request. `env` holds the settings, secrets
  // and bindings (AI, LIMITER) from wrangler.jsonc.
  // ---------------------------------------------------------------------------
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
    const originAllowed = origin !== null && allowedOrigins.includes(origin);

    // A friendly response for anyone who opens the Worker URL in a browser.
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(
        'This is the API for the prompt injection game. Play it at https://courtneyroot.dev/projects/prompt-injection-game/\n',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...baseHeaders() } },
      );
    }

    // -------------------------------------------------------------------------
    // CORS preflight
    // -------------------------------------------------------------------------
    // The website and the Worker live on different domains. Before a browser
    // sends a cross-site JSON request, it first sends an OPTIONS request asking
    // "is this site allowed to call you?". We only say yes to our own sites.
    if (request.method === 'OPTIONS') {
      if (!originAllowed) return new Response(null, { status: 403, headers: baseHeaders() });
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin),
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // -------------------------------------------------------------------------
    // 1. Origin check
    // -------------------------------------------------------------------------
    // Browsers always send an Origin header on these requests, and they can't
    // fake it. Scripts outside a browser (curl, Python) CAN fake it, so this
    // check alone doesn't stop a determined person. That's why Turnstile and
    // the daily limits exist too. Layers, not one perfect lock.
    if (!originAllowed) {
      return json({ error: 'forbidden-origin', message: 'This API only works from the game page.' }, 403, null);
    }

    if (request.method !== 'POST') {
      return json({ error: 'method-not-allowed', message: 'Use POST.' }, 405, origin);
    }

    // -------------------------------------------------------------------------
    // 2. Read and size-check the body
    // -------------------------------------------------------------------------
    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_CHARS) {
        return json({ error: 'too-large', message: 'That request is too large.' }, 413, origin);
      }
      body = JSON.parse(text);
    } catch {
      return json({ error: 'bad-json', message: 'The request body must be JSON.' }, 400, origin);
    }
    if (typeof body !== 'object' || body === null) {
      return json({ error: 'bad-json', message: 'The request body must be a JSON object.' }, 400, origin);
    }

    // Route to the right handler. Any error we didn't plan for becomes a plain
    // 500 with no internal details, so we don't leak stack traces to players.
    try {
      switch (url.pathname) {
        case '/api/session':
          return await handleSession(request, env, body, origin, allowedOrigins);
        case '/api/chat':
          return await handleChat(request, env, body, origin);
        case '/api/guess':
          return await handleGuess(request, env, body, origin);
        default:
          return json({ error: 'not-found', message: 'Unknown endpoint.' }, 404, origin);
      }
    } catch (error) {
      // console.error shows up in the Worker's logs in the Cloudflare dashboard.
      // We log the error only, never the player's message, to keep logs free of
      // whatever people type.
      console.error('Unhandled error', error);
      return json({ error: 'server-error', message: 'Something went wrong. Try again in a minute.' }, 500, origin);
    }
  },
};

// =============================================================================
// /api/session: trade a Turnstile token for a session token
// =============================================================================
async function handleSession(request, env, body, origin, allowedOrigins) {
  // CHECK_TURNSTILE_HOSTNAME is "true" in production. For local testing with
  // Cloudflare's test keys, set it to "false" in .dev.vars, because the test
  // keys report a placeholder hostname.
  const expectedHostnames =
    env.CHECK_TURNSTILE_HOSTNAME === 'false' ? null : allowedOrigins.map((o) => new URL(o).hostname);

  const check = await verifyTurnstile({
    secretKey: env.TURNSTILE_SECRET_KEY,
    token: body.turnstileToken,
    ip: clientIp(request),
    expectedHostnames,
  });
  if (!check.ok) {
    // Log the reason so it shows up in the Worker's logs in the Cloudflare
    // dashboard, and include it in the message so setup problems are easy to
    // spot. The reasons are Cloudflare's generic error codes, for example
    // "invalid-input-secret" (the TURNSTILE_SECRET_KEY secret is missing or
    // wrong) or "wrong-hostname" (the page isn't on ALLOWED_ORIGINS). They
    // reveal nothing secret.
    console.warn('Turnstile check failed:', check.reason);
    return json(
      {
        error: 'turnstile-failed',
        message: `The human check did not pass (${check.reason}). Refresh the page and try again.`,
      },
      403,
      origin,
    );
  }

  const session = await createSession(env.GAME_SECRET, setting(env.SESSION_TTL_SECONDS, 3600));
  return json({ session: session.token, expiresAt: session.expiresAt }, 200, origin);
}

// =============================================================================
// /api/chat: one player message, one AI turn
// =============================================================================
async function handleChat(request, env, body, origin) {
  // --- Validate input ---------------------------------------------------------
  const level = parseLevel(body.level);
  if (level === null) {
    return json({ error: 'bad-level', message: `Level must be 1 to ${LEVEL_COUNT}.` }, 400, origin);
  }
  const maxChars = setting(env.MAX_MESSAGE_CHARS, 400);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message.length === 0) {
    return json({ error: 'empty-message', message: 'Type a message first.' }, 400, origin);
  }
  if (message.length > maxChars) {
    return json({ error: 'too-long', message: `Messages can be up to ${maxChars} characters.` }, 400, origin);
  }

  // --- 3. Session check -------------------------------------------------------
  if (!(await hasValidSession(request, env))) {
    return json({ error: 'no-session', message: 'Your session expired. Send the message again.' }, 401, origin);
  }

  // --- 4. Daily limits --------------------------------------------------------
  // Count the turn BEFORE calling the AI. If we counted after, a burst of
  // requests could all start before any of them were counted.
  const day = utcDay();
  const visitor = await visitorId(env.GAME_SECRET, clientIp(request), day);
  const limit = await limiter(env).consume(day, [
    { key: 'global:turns', limit: setting(env.MAX_TURNS_PER_DAY, 800), name: 'global' },
    { key: `turns:${visitor}`, limit: setting(env.MAX_TURNS_PER_VISITOR, 40), name: 'visitor' },
  ]);
  if (!limit.allowed) {
    const text =
      limit.limitHit === 'global'
        ? 'The game has hit its daily limit. It resets at midnight UTC (late afternoon Pacific time).'
        : "You've used today's messages. They reset at midnight UTC (late afternoon Pacific time).";
    return json({ error: `limit-${limit.limitHit}`, message: text }, 429, origin);
  }

  // --- Play the turn ----------------------------------------------------------
  const password = await derivePassword(env.GAME_SECRET, day, level);
  try {
    const result = await playTurn(env, level, message, password);
    return json(result, 200, origin);
  } catch (error) {
    // Workers AI throws when the free daily allocation runs out (Free plan) or
    // when the model is temporarily unavailable.
    console.error('Workers AI error', error);
    if (/neuron|allocation|4006/i.test(String(error?.message ?? error))) {
      return json(
        { error: 'ai-daily-limit', message: 'The AI is resting for today. It resets at midnight UTC (late afternoon Pacific time).' },
        503,
        origin,
      );
    }
    return json({ error: 'ai-error', message: 'The AI did not answer. Try again in a minute.' }, 502, origin);
  }
}

// =============================================================================
// /api/guess: check a password guess
// =============================================================================
async function handleGuess(request, env, body, origin) {
  const level = parseLevel(body.level);
  if (level === null) {
    return json({ error: 'bad-level', message: `Level must be 1 to ${LEVEL_COUNT}.` }, 400, origin);
  }
  const guess = typeof body.guess === 'string' ? lettersOnly(body.guess) : '';
  if (guess.length === 0 || guess.length > 40) {
    return json({ error: 'bad-guess', message: 'Enter one word, letters only.' }, 400, origin);
  }

  if (!(await hasValidSession(request, env))) {
    return json({ error: 'no-session', message: 'Your session expired. Try the guess again.' }, 401, origin);
  }

  // Guess limit per visitor, per level, per day. Without it, someone could
  // script all 120 words in the list in a few seconds.
  const day = utcDay();
  const visitor = await visitorId(env.GAME_SECRET, clientIp(request), day);
  const limit = await limiter(env).consume(day, [
    { key: `guesses:${visitor}:${level}`, limit: setting(env.MAX_GUESSES_PER_LEVEL, 10), name: 'guesses' },
  ]);
  if (!limit.allowed) {
    return json(
      { error: 'limit-guesses', message: "You've used today's guesses for this level. They reset at midnight UTC." },
      429,
      origin,
    );
  }

  const password = await derivePassword(env.GAME_SECRET, day, level);
  return json({ correct: safeEqual(guess, password) }, 200, origin);
}

// =============================================================================
// Small helpers
// =============================================================================

// Gets the one shared limiter object. idFromName('global') always returns the
// same object, so every request counts against the same counters.
function limiter(env) {
  return env.LIMITER.get(env.LIMITER.idFromName('global'));
}

// Reads "Authorization: Bearer <token>" and checks the token's signature and
// expiry.
async function hasValidSession(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return verifySession(env.GAME_SECRET, token);
}

// Cloudflare puts the visitor's real IP address in this header.
function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

// Accepts 1..LEVEL_COUNT as a number or numeric string. Returns null otherwise.
function parseLevel(value) {
  const level = Number(value);
  return Number.isInteger(level) && level >= 1 && level <= LEVEL_COUNT ? level : null;
}

// Reads a numeric setting from wrangler.jsonc, with a fallback if it's missing
// or not a positive number.
function setting(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// "https://a.com, https://b.com" -> ["https://a.com", "https://b.com"]
function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// Headers sent on every response.
function baseHeaders() {
  return {
    // Never cache API responses anywhere (browser or network).
    'Cache-Control': 'no-store',
    // Tell the browser not to guess content types.
    'X-Content-Type-Options': 'nosniff',
  };
}

// CORS headers that let the allowed site read our response.
function corsHeaders(origin) {
  return {
    ...baseHeaders(),
    'Access-Control-Allow-Origin': origin,
    // The response depends on the Origin header, so caches must key on it.
    Vary: 'Origin',
  };
}

// Builds a JSON response. Pass origin = null for responses to sites that aren't
// allowed, so they get no CORS headers (the browser then hides the response).
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(origin ? corsHeaders(origin) : baseHeaders()),
    },
  });
}
