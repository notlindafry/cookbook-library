# Recipe Finder

Search your personal cookbook catalogue (a Google Sheet of 5,000+ recipes across your
cookbooks) in plain English — _"a soup with chicken and pasta"_, _"italian eggplant
dishes"_, _"guest-worthy desserts I haven't tried"_ — and get back the exact book,
author, chapter, and page to turn to.

Built with **Next.js** and powered by **Claude**, which understands what you mean
(mapping "chicken" → `Poultry`, "soup" → `Soup or stew`, recognizing that "Caprese" is
Italian) instead of just matching keywords.

---

## How it works

1. **Live data.** The app reads your sheet through its _Publish to web_ CSV link, so
   every recipe you add shows up automatically (cached for a few minutes).
2. **Understand.** Claude turns your sentence into a structured filter over your sheet's
   real columns and controlled vocabularies (Category, Main ingredient, Tried tag).
3. **Narrow.** A fast local pass filters and scores candidates — so Claude never has to
   read all 5,000+ rows, and the app stays cheap and quick as your catalogue grows.
4. **Rank & explain.** Claude reranks the top candidates with real culinary knowledge
   and gives a one-line reason for each match.

If no API key is configured, the app gracefully falls back to keyword search.

---

## Features

- **Natural-language search** with a fast local pre-filter + Claude rerank.
- **Plan a menu** — Claude composes a balanced multi-course menu from your books.
- **Surprise me** — a random pick (respecting your filters) for "what's for dinner."
- **Want to make** — one tap to surface everything tagged "I really want to make this."
- **More like this** — on any result, find related recipes.
- **Filters** — category, main ingredient, verdict, book, author, exclude-ingredient,
  cuisine (when pre-tagged), "not tried yet," and "has a link." All multi-select.
- **Installable (PWA)** — add it to your phone's home screen.
- **Password-protected** with rate limiting, CSRF protection, and hardened headers.
- **Optional write-back** — set a verdict or prep note from the app (see below).
- **Find online recipe links** — click **🔗 Find link** on any result, or run
  `npm run find-urls` to batch-fill the whole catalogue. Both search the web for the
  recipe's online version, validate it, and write it to the **Recipe link** column,
  preferring reputable sources (see below).

---

## One-time setup

### 1. Publish your sheet as CSV

In your **Cookbook catalogue** sheet:

`File` → `Share` → `Publish to web` → choose the recipe sheet → **Comma-separated
values (.csv)** → **Publish**. Copy the URL (it looks like
`https://docs.google.com/spreadsheets/d/e/…/pub?gid=0&single=true&output=csv`).

> The published CSV is read-only, but anyone with the link can view it. If you'd prefer
> to keep the sheet fully private, switch to the Google Sheets API (service account) —
> the data layer in `lib/data.ts` is the only thing that would change.

The app expects your existing columns: **Book title, Author, Chapter name, Recipe name,
Page #, Category, Main ingredient, Recipe link, Tried tag, Prep notes.** Column order
doesn't matter — they're matched by name.

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Then fill in `.env.local`:

- `SHEET_CSV_URL` — the published CSV link from step 1 (**required**)
- `ANTHROPIC_API_KEY` — from <https://console.anthropic.com/> (**required** for
  natural-language search)
- `ANTHROPIC_MODEL` — optional, defaults to `claude-haiku-4-5` (fast + low cost). Use
  `claude-sonnet-4-6` or `claude-opus-4-8` for higher-quality understanding.
- `SHEET_CACHE_TTL_SECONDS` — optional, defaults to `300`.

### 3. Install & run

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

---

## Your API key, securely (set once — never per use)

The app reads your key from the `ANTHROPIC_API_KEY` **environment variable** — never
from the code or the UI. You set it **once** per place you run the app, and it stays
out of the repo (`.env*` is gitignored). There is no per-search key prompt.

| Where you run it | Where to put the key (its secret store) |
| --- | --- |
| **Production (Vercel)** | Project → **Settings → Environment Variables** → add `ANTHROPIC_API_KEY`. Encrypted at rest, injected at runtime. This is the permanent "set it once" home. |
| **Claude Code on the web** | Add it as a secret/env var in your environment's configuration so future sessions have it automatically — see <https://code.claude.com/docs/en/claude-code-on-the-web>. |
| **Local development** | `.env.local` (created in step 2). Gitignored, persists between runs. |

**Never** hardcode the key in source or commit a `.env` file. If a key is ever exposed,
rotate it at <https://console.anthropic.com/>.

---

## Deploy (Vercel)

1. Push this repo to GitHub.
2. Import it at <https://vercel.com/new>.
3. Add these environment variables in the Vercel project settings (Production scope):
   `APP_PASSWORD`, `SESSION_SECRET`, `SHEET_CSV_URL`, and your Anthropic key
   (`ANTHROPIC_API_KEY` / `CLAUDE_API_KEY`). **Without `APP_PASSWORD` and
   `SESSION_SECRET` the app fails closed and no one — including you — can log in.**
4. Deploy. You'll get a URL you can open on your phone and add to your home screen.

---

## Security

The app is private by design:

- **Password gate.** Every page and API route is blocked by middleware until you log in
  with `APP_PASSWORD`. Sessions are signed JWTs (HS256, signed with `SESSION_SECRET`)
  stored in an **httpOnly, Secure, SameSite=Lax** cookie that JavaScript can't read.
  Passwords are compared in constant time. Set `SESSION_SECRET` to a long random string
  (`openssl rand -base64 32`).
- **Abuse protection.** Per-IP rate limiting on login (brute force) and search
  (Claude-cost), a 300-character query cap, and filter-size caps. *(Rate limiting is
  in-memory/best-effort per serverless instance; for strict global limits, back it with
  Upstash Redis — see `lib/ratelimit.ts`.)*
- **CSRF.** State-changing POSTs (`/api/login`, `/api/search`) require a same-origin
  `Origin`/`Referer`, on top of the SameSite cookie.
- **Hardened headers.** Every response carries a nonce-based Content-Security-Policy,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, and HSTS.
- **Secrets stay server-side.** The Anthropic key is only ever read on the server; it is
  never sent to the browser.

If you ever think a credential leaked, rotate `APP_PASSWORD` / `SESSION_SECRET` (which
also invalidates all existing sessions) and your Anthropic key.

---

## Optional: write-back and cuisine tagging

**Write-back** (set a verdict / prep note from the app) is read-only until you configure
a Google service account:

1. In Google Cloud, create a service account and enable the **Google Sheets API**.
2. Share your sheet with the service account's email as an **Editor**.
3. Set `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `SHEET_ID`, and
   `SHEET_TAB_NAME` (see `.env.example`).

Writes are validated (verdict must be from your tag list; notes capped) and use a
safety check: before writing, the server re-reads the recipe-name cell on that row and
refuses if it no longer matches — so a row-mapping drift can never overwrite the wrong
recipe. Writes use `RAW` mode, so a note starting with `=` is stored as text, not a
formula. (Assumes the recipe tab has a single header row at row 1.)

**Cuisine filter:** run the tagger once to label every recipe's cuisine with Claude:

```bash
SHEET_CSV_URL=... ANTHROPIC_API_KEY=... node scripts/tag-cuisines.mjs
```

This writes `data/cuisines.json`; commit it, and the app shows a **Cuisine** filter.
Re-run after adding lots of recipes.

---

## Optional: find online recipe links

There are two ways to find the online version of a recipe and write the URL back to your
sheet — so you can jump straight from a search result to the full recipe:

- **In the app — `🔗 Find link`.** Every result that doesn't already have a link shows a
  **Find link** button (when write-back is enabled). Click it to scan for that one recipe
  on demand; the title turns into a link as soon as it's found.
- **In bulk — `npm run find-urls`.** Fills the whole catalogue in one pass. Built for the
  real-world workflow of buying a new cookbook, adding its recipes, and linking them all.

Both need the **same Google service account as write-back** (they read and write through
the Sheets API) plus `ANTHROPIC_API_KEY` (with **web search** enabled on the account), and
both write to your **Recipe link** column.

The bulk script:

```bash
# Preview without writing anything:
npm run find-urls -- --dry-run

# Fill in links (processes up to 100 un-linked recipes by default):
npm run find-urls

# Target a specific newly-bought book, and lift the per-run cap:
npm run find-urls -- --book "Soup Book" --limit 0
```

**How it finds a _direct_ match (not just any same-named recipe).** For each recipe it
asks Claude to search **the web** for a page that matches the **recipe name _and_ the book
title**, and/or the **recipe name _and_ the author** — e.g. the chicken noodle soup from
Joe Smith's _Soup Book_, not a random one. (Cookbook recipes get republished widely —
publishers, the author's own site, PBS/NPR, magazines, well-known blogs — so search isn't
limited to a fixed list.) A page only qualifies if it matches the name **and** the book
**or** the author; when several sites have it, the most reputable one with the strongest
matching signals wins.

**What it validates before writing.** Every candidate is independently checked in our own
code (nothing the model says is trusted): https-only and SSRF-safe, reachable, and **not a
404, a parked/placeholder page, or a paywall**. Paywalls are accepted **only** on the sites
you subscribe to — **Epicurious, America's Test Kitchen, and NYT Cooking**.

**Write policy (`RECIPE_LINK_ACCEPT`).** By default (`reputable`) a match is only written
when it's on a **recognized reputable site** _or_ it matches **name + book + author**
strongly — so unknown sites need high confidence. Set it to `any` to write **every** safe
direct match (maximum coverage). Either way, each result shows as a raw URL in the app with
a **Reject** button so you can prune anything off.

**Re-runnable & idempotent.** It **never re-queries a recipe that already has a link**, so
running it again after adding a new cookbook only does the new work. Configure the target
column with `RECIPE_URL_COLUMN` (defaults to your existing **Recipe link** column; set it
to use or auto-create a dedicated column). Found links flow straight into the app's
**"has a link"** filter and the link on each result.

**Security controls.** This feature handles untrusted web content, so it leans on
foundational controls — see the next section.

---

## Find-links security controls

The link finder treats the open web as hostile and keeps the decision to write inside our
own deterministic code:

- **Strict URL safety.** https only (no `javascript:`/`data:`/`file:`), no embedded
  credentials, no IP-literal hosts, no odd ports.
- **SSRF defense.** Loopback/private/link-local and cloud-metadata hosts are blocked, and
  **every redirect hop is re-validated** so a page can't bounce us to an internal address.
- **Real-page + direct-match validation.** A candidate is rejected unless it's reachable,
  not a 404/parked/placeholder page, not a disallowed paywall, and the page actually
  matches the recipe name + book/author.
- **Reputation write policy.** By default only matches on recognized reputable sites — or
  with a strong name+book+author match — are written (`RECIPE_LINK_ACCEPT`), so a low-signal
  match on an unknown domain isn't auto-saved. You also see every URL and can **Reject** it.
- **Bounded fetching.** Per-request timeout, capped redirects, and a response-size cap;
  page HTML is only ever scanned as text, never executed.
- **Prompt-injection resistance.** The model is told to treat page content as untrusted and
  never follow instructions in it; the model only _proposes_ URLs — our code makes the final
  validate/accept/write decision.
- **Safe write-back.** Before writing, it re-reads the sheet and only fills cells whose
  recipe name is unchanged and that are still empty, so it can never overwrite the wrong
  row. Writes use `RAW` mode and reject anything that isn't a clean https URL (guarding
  against spreadsheet formula injection).
- **Cost guardrails.** A per-run recipe cap and bounded web-search uses keep an accidental
  full-catalogue run from running away.

The pure logic behind these controls (reputation map, URL safety, match scoring) and the
validation gate are covered by tests: `npm test`.

---

## Project layout

```
app/
  page.tsx            # the search UI (client)
  api/search/route.ts # POST endpoint that runs the search pipeline
lib/
  data.ts             # fetch + parse + cache the published CSV
  search.ts           # parse query → filter/score → rerank (the Claude pipeline)
  vocab.ts            # the sheet's controlled vocabularies
  types.ts            # shared types
scripts/
  find-recipe-urls.mjs    # scan trusted sites for recipe links, write to the sheet
  tag-cuisines.mjs        # batch-tag cuisines
  lib/                    # reputation map, URL safety, validation gate, matching (+ tests)
```

## Cost

With the default `claude-haiku-4-5`, each search makes two small, prompt-cached Claude
calls (understand + rerank) over a few hundred candidate rows — typically a fraction of
a cent. The local pre-filter keeps token usage flat as your catalogue grows.
