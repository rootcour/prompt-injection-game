# Setting up the game on Cloudflare

About 30 minutes, start to finish. Everything here fits in Cloudflare's free plans, and you don't need a credit card.

You'll set up four things:

1. A GitHub repo with this code
2. The Worker (the game server), deployed from that repo
3. A Turnstile widget (the "are you human?" check)
4. Two secrets in the Worker, then two settings on the website

Dashboard menu names change from time to time. If a label below doesn't match exactly, look for the closest one.

## 1. Put the code on GitHub

1. On GitHub, create a new **public** repo named `prompt-injection-game` under `rootcour`. Don't add a README (this code has one).
2. Choose **uploading an existing file**, then drag in everything from the `prompt-injection-game` folder. In Finder, press **Cmd+Shift+.** first so the hidden files `.gitignore` and `.dev.vars.example` show up and come along.
3. Don't upload a `node_modules` folder or a `.dev.vars` file if you ever create one. `.gitignore` keeps those out when you use git, but a drag-and-drop upload doesn't read it.
4. Commit.

## 2. Deploy the Worker from GitHub

1. In the Cloudflare dashboard, go to **Workers & Pages** and select **Create application**.
2. Choose to import from **GitHub** and pick `rootcour/prompt-injection-game`. (Your Pages site already uses the GitHub connection, so Cloudflare may not ask you to sign in again. If the repo doesn't appear, give the Cloudflare GitHub app access to it.)
3. Keep the project name **`prompt-injection-game`**. It has to match `name` in `wrangler.jsonc`, or the build fails.
4. Leave the deploy command as `npx wrangler deploy` and select **Save and Deploy**.
5. When it finishes, copy the Worker's URL. It looks like `https://prompt-injection-game.YOUR-SUBDOMAIN.workers.dev`. Open it in a browser: you should see one line of text saying it's the game's API.

From now on, every commit to `main` redeploys the Worker on its own.

**Workers AI:** there's nothing to turn on. The `"ai"` line in `wrangler.jsonc` connects the Worker to Workers AI during the deploy, and the free 10,000 Neurons a day apply automatically.

**Durable Object:** also nothing to do. The `migrations` section in `wrangler.jsonc` creates the daily counter on the first deploy.

## 3. Create the Turnstile widget

1. In the dashboard, go to **Turnstile** and select **Add widget**.
2. Name it `Prompt injection game`.
3. Add these hostnames:
   - `courtneyroot.dev`
   - `courtneyroot-website.pages.dev`
4. Widget mode: **Managed**. (The game also sets the widget to appear only when Cloudflare needs a click, so most players never see it.)
5. Create it and copy both keys:
   - **Site key**: public. Goes on the website.
   - **Secret key**: private. Goes only in the Worker.

## 4. Add the secrets to the Worker

You need two secrets. Secrets are encrypted in Cloudflare and never appear in your code or on GitHub.

First, make a random value for `GAME_SECRET`. Open Terminal on your Mac and run:

```
openssl rand -hex 32
```

Copy the 64-character result. Don't save it anywhere else; if you ever lose it, make a new one (the only effect is that today's passwords change).

Then in the dashboard:

1. **Workers & Pages** > `prompt-injection-game` > **Settings** > **Variables and Secrets**.
2. Select **Add**, choose type **Secret**, and add:
   - `GAME_SECRET` = the value from Terminal
   - `TURNSTILE_SECRET_KEY` = the Turnstile **secret** key
3. Deploy (the dashboard asks after you save).

Watch the type: these two must be **Secret**, not **Text**. Text variables are visible to anyone with dashboard access and are overwritten by `wrangler.jsonc` on the next deploy.

## 5. Connect the website

In the `courtneyroot-website` repo, edit two files on GitHub with the pencil icon:

1. **`src/site.ts`**, in the `GAME` section:
   - `apiUrl`: your Worker URL from step 2, no trailing slash
   - `turnstileSiteKey`: the Turnstile **site** key from step 3
2. **`public/_headers`**: replace `YOUR-SUBDOMAIN` in the `connect-src` part with the same subdomain, so the browser is allowed to talk to the Worker.

When Pages rebuilds, the game page switches from "almost ready" to the playable game. Until both values in `src/site.ts` are set, the page shows the "almost ready" note, so it's safe to publish the page first.

## 6. Test it

1. Open `/projects/prompt-injection-game/` on the pages.dev site.
2. On level 1, ask for the password. The AI should just tell you.
3. Guess it. The lesson for level 1 should appear.
4. If something fails, the red message under the forms tells you which step. Then check **Workers & Pages** > `prompt-injection-game` > **Logs** for errors.

| What you see | Likely cause |
| --- | --- |
| "Couldn't reach the game server" | `apiUrl` in `src/site.ts` or `connect-src` in `_headers` doesn't match the Worker URL |
| "The human check did not pass" | Wrong Turnstile secret, or the site's hostname isn't on the Turnstile widget |
| "The human check did not load" | The Turnstile script was blocked. Check `script-src` and `frame-src` in `_headers`, or try without an ad blocker |
| "This API only works from the game page" | The site's address isn't in `ALLOWED_ORIGINS` in `wrangler.jsonc` |
| "The AI did not answer" | Check the Worker logs. Usually a temporary Workers AI hiccup |

## When the domain moves to Cloudflare

`courtneyroot.dev` and `www.courtneyroot.dev` are already in `ALLOWED_ORIGINS` and on the Turnstile widget, so the game keeps working after the switch with no changes.

Optional, later: you can give the Worker an address on your own domain (for example `game.courtneyroot.dev`) under the Worker's **Settings** > **Domains & Routes**. If you do, update `apiUrl` in `src/site.ts` and `connect-src` in `_headers` to match.

## Usage and limits

Workers AI charges in "Neurons". The free allocation is 10,000 Neurons a day, reset at midnight UTC. On the Workers Free plan, usage past that point fails instead of being billed.

Rough cost per turn with the default model (Llama 3.1 8B fast), from Cloudflare's published rates:

| Level | AI calls per message | About how many Neurons |
| --- | --- | --- |
| 1 to 3 | 1 | 4 to 8 |
| 4 | 2 | about 9 |
| 5 | 3 | about 11 |

Most of the cost is the main AI's reply. The reviewer and screen only answer one word.

At the worst case of 11 Neurons a turn, the 800-turn daily cap in `wrangler.jsonc` uses about 8,800 Neurons, so the game stays inside the free allocation even on a busy day. Check real usage under **AI** > **Workers AI** in the dashboard after a week, and adjust:

- `MAX_TURNS_PER_DAY`: total for everyone
- `MAX_TURNS_PER_VISITOR`: per person (raise it for a day if you use the game live in a talk, since a whole room may share one network)
- `MAX_GUESSES_PER_LEVEL`: per person, per level

Edit them in `wrangler.jsonc` on GitHub and commit. The Worker redeploys on its own.

## Local testing (optional)

Only needed if you want to run the game on your own computer. Requires Node.js 22.

```
npm install
npm test                         # unit tests, no Cloudflare needed
cp .dev.vars.example .dev.vars   # test secrets for local use
npx wrangler login
npm run dev                      # Worker at http://localhost:8787
```

Local runs still call the real Workers AI, so they count toward your daily allocation. To point your local website at the local Worker, set `apiUrl` to `http://localhost:8787` and `turnstileSiteKey` to Cloudflare's test key `1x00000000000000000000AA` in `src/site.ts`, then run `npm run dev` in the website repo. Don't commit those changes.

## Before you publish

From your project notes: check your employer's policy on side projects before making the repo public.
