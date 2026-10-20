// =============================================================================
// limiter.js: daily usage counters (a Cloudflare Durable Object)
// =============================================================================
//
// The game needs to count things per day:
//   - total AI turns today, across everyone (protects the free allocation)
//   - AI turns today per visitor (so one person can't use up everyone's share)
//   - password guesses today per visitor per level (stops brute-force guessing)
//
// Why a Durable Object and not Workers KV?
//   - A Durable Object is a single small server with its own storage. Every
//     request to the same object is handled one at a time, so two requests
//     can't both read "39" and both write "40". Counters stay exact.
//   - Workers KV is "eventually consistent" (updates can take up to a minute to
//     show up everywhere), and the free plan allows only 1,000 KV writes a day,
//     which a busy day of the game could use up.
//   - Durable Objects that use SQLite storage are included in the Workers Free
//     plan.
//
// We use ONE limiter object for the whole game (named "global" in index.js).
// For a personal-site game that's plenty of capacity. If the game ever got very
// popular, you could split visitors across several objects.
//
// Storage layout (simple key/value pairs inside the object):
//   "day"                     -> "2026-10-20" (which day the counts belong to)
//   "global:turns"            -> 412
//   "turns:<visitorId>"       -> 17
//   "guesses:<visitorId>:3"   -> 4
//
// When the first request of a new UTC day arrives, everything is wiped and the
// counts start from zero. That also deletes yesterday's visitor IDs, so nothing
// about visitors is kept longer than a day.

import { DurableObject } from 'cloudflare:workers';

export class DailyLimiter extends DurableObject {
  // ---------------------------------------------------------------------------
  // consume(day, checks)
  //
  // checks is a list like:
  //   [ { key: 'global:turns', limit: 800, name: 'global' },
  //     { key: 'turns:abc123', limit: 40,  name: 'visitor' } ]
  //
  // All checks pass, or nothing is counted. If every counter is under its
  // limit, each one goes up by 1 and we return { allowed: true }. If any
  // counter is already at its limit, nothing changes and we return
  // { allowed: false, limitHit: <name> } so the game can show the right message.
  //
  // index.js calls this method directly (Durable Object "RPC"), the same way
  // you'd call a function, even though it runs in a different place.
  // ---------------------------------------------------------------------------
  async consume(day, checks) {
    const storage = this.ctx.storage;

    // New day? Start fresh.
    const storedDay = await storage.get('day');
    if (storedDay !== day) {
      await storage.deleteAll();
      await storage.put('day', day);
    }

    // Read all the counters we need in one call. Missing keys mean 0.
    const current = await storage.get(checks.map((check) => check.key));

    // First pass: check every limit before changing anything.
    for (const check of checks) {
      const count = current.get(check.key) ?? 0;
      if (count >= check.limit) {
        return { allowed: false, limitHit: check.name };
      }
    }

    // Second pass: everything is under its limit, so add 1 to each counter.
    const updates = {};
    for (const check of checks) {
      updates[check.key] = (current.get(check.key) ?? 0) + 1;
    }
    await storage.put(updates);

    return { allowed: true };
  }
}
