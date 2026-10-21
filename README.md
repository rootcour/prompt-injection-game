# Prompt injection game

A five-level game where players try to talk an AI into revealing a password. Each level adds one defense, and when a player wins, the game explains the defense they just got past.

Play it at [courtneyroot.dev/projects/prompt-injection-game](https://courtneyroot.dev/projects/prompt-injection-game/). This repo is the game server. The page players see lives in the [website repo](https://github.com/rootcour/courtneyroot-website).

Setup steps are in [SETUP.md](SETUP.md).

## The levels

The levels are cumulative. Each one keeps every earlier defense and adds one more.

| Level | New defense | What it teaches |
| --- | --- | --- |
| 1 | None. The AI is just told the password. | Anything in a model's prompt can come back out. |
| 2 | An instruction not to reveal the password | An instruction is a request, not a rule. |
| 3 | An output filter that blocks replies containing the password | A word filter only knows one way the secret can look. |
| 4 | A second AI that reviews each reply | The reviewer reads text the attacker helped write, so the reviewer can be steered too. |
| 5 | An input screen that checks the player's message first | Judging intent from one message misses creative attacks and blocks innocent questions. |

## How a message moves through the game

```
Browser (courtneyroot.dev)
  |  1. Turnstile check, once an hour  ->  POST /api/session  ->  session token
  |  2. Each message                    ->  POST /api/chat
  v
Worker (this repo)
  origin check -> size check -> session check -> daily limits
    -> [input screen]   level 5     AI call: "is this an attack?"
    -> main AI          all levels  system prompt holds the password
    -> [output filter]  level 3+    plain code: is the word in the reply?
    -> [AI reviewer]    level 4+    AI call: "does this reply leak it?"
  <- { reply, blockedBy }
```

Guesses go to `POST /api/guess`, which checks the word without calling the AI.

## What each file does

| File | What's in it |
| --- | --- |
| `src/index.js` | The front door. Checks where requests come from, checks sizes and sessions, applies daily limits, and sends each request to the right handler. |
| `src/levels.js` | The five levels: the system prompts, the output filter, the AI reviewer and the input screen. Start here if you want to change how a level behaves. |
| `src/security.js` | Small helpers: daily passwords, session tokens, anonymous visitor IDs, and the Turnstile check. No AI code. |
| `src/limiter.js` | A Durable Object that counts turns and guesses per day. |
| `src/words.js` | Reads the list of possible passwords from the `WORD_LIST` secret. The words themselves are not in this repo. |
| `wrangler.jsonc` | Cloudflare settings: the AI model, the limits, which websites may call the API. |
| `test/` | Tests for the security helpers and the level logic. They use a fake AI, so running them costs nothing. Run with `npm test`. |

Every file has comments explaining what each part does and why.

## Design decisions

**The password never leaves the server.** The website is static, so anything in its JavaScript is public. The passwords, the system prompts and the AI calls all live in the Worker.

**Passwords are computed, not stored.** Each day, each level's password is picked from a word list using an HMAC of the date and level number with a secret key (`GAME_SECRET`). The server recomputes the password on every request, so there's no database of passwords to protect. Passwords change at midnight UTC, so answers shared online stop working the next day.

**The word list is private too.** The possible passwords live in a Worker secret (`WORD_LIST`), not in this repo. If the list were public, players could skip the game: learn the letter count and first letter, then look the word up. Guesses are also limited to 10 per level per day.

**One secret, labeled by use.** `GAME_SECRET` is used for passwords, session tokens and visitor IDs. Each use adds a different label before hashing (`password|...`, `session|...`, `visitor|...`), so the outputs can't be swapped for each other.

**Turnstile once, then a session.** Turnstile tokens can only be checked once and expire after five minutes. Asking for a check before every message would be annoying, so passing Turnstile earns a signed session token that lasts an hour. The server checks the token's signature and expiry on each request and stores nothing.

**Every request is counted before the AI runs.** Limits are checked and counted first, so a burst of requests can't all start before any of them are counted. There are three limits, all resetting at midnight UTC:

- 800 AI turns a day for the whole game, to stay inside the free Workers AI allocation
- 40 turns a day per visitor, so one person can't use everyone's share
- 10 guesses per level per day per visitor, so nobody can script the whole word list

**Counters use a Durable Object, not Workers KV.** A Durable Object handles one request at a time, so counts stay exact. KV can take up to a minute to show updates everywhere, and the free plan allows only 1,000 KV writes a day.

**Visitors are anonymous.** Raw IP addresses are never stored. Each visitor is counted by an HMAC of their IP and the date, which changes daily and can't be reversed without the secret. All counters are deleted when the day changes. The Worker doesn't log what players type.

**Checks fail closed.** If the AI reviewer or input screen gives anything other than a clear SAFE or ALLOW, the reply is blocked. If Cloudflare's Turnstile service can't be reached, the session is refused.

**One message per turn.** The AI sees only the current message, not the conversation so far. That keeps each request small (cheaper) and stops players from slowly wearing the AI down over a long chat. Gandalf works the same way.

**Show which defense fired.** When a reply is blocked, the player sees which defense blocked it. Hiding that would make the game harder, but the point is to learn how each defense behaves.

**The free plan is the final safety net.** On the Workers Free plan, Cloudflare stops AI calls once the free daily allocation is used rather than billing for more. Even if every other limit failed, the worst case is the game pausing until midnight UTC.

## Known limits

- **Level skipping.** Progress is saved in the player's browser, so someone could edit it to open level 5 early. Skipping only spoils the fun for the person doing it, so the server doesn't enforce order.
- **Shared IP addresses.** People behind the same office or school network share one visitor ID, so they share the 40-turn daily limit. If a whole class plays during a talk, raise `MAX_TURNS_PER_VISITOR` in `wrangler.jsonc` for the day.
- **Midnight UTC.** Passwords change at midnight UTC (5 p.m. Pacific in summer, 4 p.m. in winter). A player who is mid-level at that moment needs to start that level over.
- **AI behavior varies.** Small models are inconsistent. The same trick can work once and fail the next time.

## Running the tests

```
npm install
npm test
```
