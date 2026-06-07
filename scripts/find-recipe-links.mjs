#!/usr/bin/env node
// One-time (re-runnable) script: finds a web version of each recipe that
// doesn't already have a link, and writes the URL back to the sheet.
//
// For each recipe it searches by name + cookbook + author, then has Claude
// verify the result is genuinely THAT cookbook's recipe — not a generic
// version of the same dish. A correct link or none; never a stand-in.
//
// Re-runnable: skips any recipe that already has an https link.
//
// ── Setup (one-time) ──────────────────────────────────────────────────────────
//
//  Search provider — pick ONE:
//
//  A) Serper.dev (recommended — simplest, no Google Cloud project needed)
//     1. Sign up at https://serper.dev → copy your API key as SERPER_API_KEY.
//        Free signup includes 2,500 one-time credits (1 credit = 1 search).
//
//  B) Google Custom Search API (fallback, more setup)
//     1. console.cloud.google.com → enable "Custom Search API" → Credentials →
//        Create API key → copy it as GOOGLE_CSE_API_KEY
//     2. programmablesearchengine.google.com → New search engine → create →
//        copy the Search engine ID as GOOGLE_CSE_CX
//     Free quota 100/day; needs billing for more.
//
//  The script uses Serper if SERPER_API_KEY is set, else Google CSE.
//
//  Claude (cookbook verification) — ANTHROPIC_API_KEY (or CLAUDE_API_KEY).
//  Defaults to claude-haiku-4-5; override with ANTHROPIC_MODEL.
//
//  Google Sheets write-back (same service account used by the app's write-back)
//  - Share your sheet with the service account as an Editor.
//    Set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, SHEET_ID, SHEET_TAB_NAME.
//
// ── Usage ─────────────────────────────────────────────────────────────────────
//
//  SHEET_CSV_URL=...
//  SERPER_API_KEY=...                       (or GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX)
//  ANTHROPIC_API_KEY=...
//  GOOGLE_SERVICE_ACCOUNT_EMAIL=...  GOOGLE_PRIVATE_KEY=...
//  SHEET_ID=...  SHEET_TAB_NAME=...
//  node scripts/find-recipe-links.mjs [--dry-run] [--limit N] [--sample] [--strict | --any-domain]
//
//  --dry-run     Print what would be written without touching the sheet.
//  --limit N     Only process N un-linked recipes (handy for testing).
//  --sample      With --limit N, spread the N picks evenly across the whole
//                catalogue instead of taking the first N (representative test).
//
//  Every accepted link is Claude-verified to be that cookbook's recipe. The
//  domain flags only adjust the safety pre-filter applied before verification:
//  --strict      Only accept results from a curated list of major recipe sites.
//  (default)     Any reputable domain (junk sites like Pinterest/YouTube blocked).
//  --any-domain  Accept any domain at all (even the junk blocklist).

import Papa from "papaparse";
import { SignJWT, importPKCS8 } from "jose";
import Anthropic from "@anthropic-ai/sdk";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN    = args.includes("--dry-run");
const ANY_DOMAIN = args.includes("--any-domain");
const STRICT     = args.includes("--strict");
const SAMPLE     = args.includes("--sample");
const limitIdx  = args.indexOf("--limit");
const LIMIT     = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ── Env vars ──────────────────────────────────────────────────────────────────

const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const SERPER_KEY    = process.env.SERPER_API_KEY;
const CSE_KEY       = process.env.GOOGLE_CSE_API_KEY;
const CSE_CX        = process.env.GOOGLE_CSE_CX;
const SVC_EMAIL     = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const PRIVATE_KEY   = process.env.GOOGLE_PRIVATE_KEY;
const SHEET_ID      = process.env.SHEET_ID;
const TAB_NAME      = process.env.SHEET_TAB_NAME;
const ANTHROPIC_KEY =
  process.env.ANTHROPIC_API_KEY ||
  process.env.CLAUDE_API_KEY ||
  process.env.claude_api_key;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

function die(msg) { console.error("Error:", msg); process.exit(1); }

// Choose a search provider: Serper.dev (preferred — simplest) if its key is
// present, otherwise fall back to Google Custom Search if both its values exist.
const PROVIDER = SERPER_KEY ? "serper" : (CSE_KEY && CSE_CX ? "cse" : null);

if (!SHEET_CSV_URL) die("SHEET_CSV_URL is required.");
if (!ANTHROPIC_KEY) {
  die("ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is required — Claude verifies that each result is genuinely the cookbook's recipe.");
}
if (!PROVIDER) {
  die(
    "No search provider configured. Set SERPER_API_KEY (recommended — get one at " +
    "https://serper.dev), or set both GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX.",
  );
}
if (!DRY_RUN) {
  if (!SVC_EMAIL)   die("GOOGLE_SERVICE_ACCOUNT_EMAIL is required (or use --dry-run).");
  if (!PRIVATE_KEY) die("GOOGLE_PRIVATE_KEY is required (or use --dry-run).");
  if (!SHEET_ID)    die("SHEET_ID is required (or use --dry-run).");
  if (!TAB_NAME)    die("SHEET_TAB_NAME is required (or use --dry-run).");
}

// ── Trusted recipe domains ────────────────────────────────────────────────────
// Only used when --any-domain is NOT set. Add more as needed.

const TRUSTED = new Set([
  "allrecipes.com",
  "food52.com",
  "foodnetwork.com",
  "seriouseats.com",
  "cooking.nytimes.com",
  "epicurious.com",
  "bonappetit.com",
  "thekitchn.com",
  "simplyrecipes.com",
  "smittenkitchen.com",
  "tasteofhome.com",
  "delish.com",
  "yummly.com",
  "marthastewart.com",
  "myrecipes.com",
  "bbcgoodfood.com",
  "taste.com.au",
  "kingarthurbaking.com",
  "101cookbooks.com",
  "davidlebovitz.com",
  "loveandlemons.com",
  "minimalistbaker.com",
  "halfbakedharvest.com",
  "cookieandkate.com",
  "skinnytaste.com",
  "themediterraneandish.com",
  "budgetbytes.com",
  "sallysbakingaddiction.com",
  "joythebaker.com",
  "damndelicious.net",
  "gimmesomeoven.com",
  "cafedelites.com",
  "recipetineats.com",
  "wellplated.com",
  "onceuponachef.com",
  "foodandwine.com",
  "eatingwell.com",
  "countryliving.com",
  "food.com",
  // Publications & sources that frequently excerpt/attribute cookbook recipes —
  // the pages most likely to genuinely be "the book's recipe."
  "saveur.com",
  "splendidtable.org",
  "eater.com",
  "thespruceeats.com",
  "americastestkitchen.com",
  "177milkstreet.com",
  "washingtonpost.com",
  "latimes.com",
  "theguardian.com",
  "bbc.co.uk",
  "npr.org",
  "seriouseats.com",
  "food52.com",
  "penguinrandomhouse.com",
  "hachettebookgroup.com",
  "simonandschuster.com",
  "harpercollins.com",
  "abramsbooks.com",
  "chroniclebooks.com",
  "workman.com",
  "tenspeedpress.com",
  "goop.com",
  "splendidrecipes.com",
]);

// Domains that are never a recipe page — blocked even in the default
// (non-strict) mode. Social, video, shopping, and book-catalogue sites.
const BLOCKED = new Set([
  "pinterest.com",
  "youtube.com",
  "youtu.be",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "reddit.com",
  "amazon.com",
  "ebay.com",
  "books.google.com",
  "goodreads.com",
  "barnesandnoble.com",
  "wikipedia.org",
  "eatyourbooks.com", // a recipe index/catalogue, not the recipe itself
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function colLetter(index0) {
  let s = "", n = index0 + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function normalizeKey(raw) {
  let pem = raw.trim();
  if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) {
    pem = pem.slice(1, -1).trim();
  }
  return pem.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
}

function mapHeader(raw) {
  const h = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (h.includes("book"))                                          return "book";
  if (h.includes("author"))                                        return "author";
  if (h.includes("recipe name") || h === "name" || h === "recipe") return "name";
  if (h.includes("link") || h.includes("url"))                     return "link";
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Google OAuth2 (service account) ──────────────────────────────────────────

const TOKEN_URL = "https://oauth2.googleapis.com/token";
let cachedToken = null;

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const pem = normalizeKey(PRIVATE_KEY);
  if (!/-----BEGIN PRIVATE KEY-----/.test(pem)) {
    die("GOOGLE_PRIVATE_KEY is malformed — paste the entire private_key value from your service-account JSON.");
  }

  const key = await importPKCS8(pem, "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/spreadsheets" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(SVC_EMAIL)
    .setSubject(SVC_EMAIL)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) die(`Google auth failed: HTTP ${res.status}`);
  const json = await res.json();
  cachedToken = { token: json.access_token, exp: now + (json.expires_in ?? 3600) };
  return json.access_token;
}

// ── Search providers ──────────────────────────────────────────────────────────

// Each provider returns an ordered array of { title, link, snippet } results.

async function searchSerper(query) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 10 }),
  });
  if (res.status === 429) throw new Error("Serper rate/quota limit hit (429). Wait or top up credits.");
  if (res.status === 403) throw new Error("Serper rejected the key (403). Check SERPER_API_KEY.");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Serper search failed: HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json.organic ?? [])
    .map((o) => ({ title: o.title ?? "", link: o.link, snippet: o.snippet ?? "" }))
    .filter((r) => r.link);
}

async function searchCSE(query) {
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", CSE_KEY);
  url.searchParams.set("cx", CSE_CX);
  url.searchParams.set("q", query);
  url.searchParams.set("num", "10");

  const res = await fetch(url.toString());
  if (res.status === 429) throw new Error("Daily quota exhausted (429). Try again tomorrow or upgrade billing.");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CSE search failed: HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json.items ?? [])
    .map((i) => ({ title: i.title ?? "", link: i.link, snippet: i.snippet ?? "" }))
    .filter((r) => r.link);
}

function runSearch(query) {
  return PROVIDER === "serper" ? searchSerper(query) : searchCSE(query);
}

// ── Cookbook-attribution verification (Claude) ─────────────────────────────────

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

const VERIFY_SYSTEM = `You verify whether a web page is the actual recipe published in a SPECIFIC cookbook.

You are given a recipe name, its cookbook title and author, and a numbered list of Google results (title, url, snippet). Return the index of the single result that satisfies ALL of these:

1. It is a single, complete RECIPE PAGE for that same dish — a page that gives the ingredients and method. It is NOT a recipe roundup or collection, a category/index/landing page, a "cookbook club" or book-review/announcement page, a techniques/tips article, a news or blog post that merely mentions the book, or a store/product/book-sales page.
2. The dish matches the given recipe name (the same dish, allowing for minor wording differences).
3. It is tied to THIS source by EITHER the cookbook OR the author (either alone is sufficient): reproduced or excerpted from that book, the author's own posting of the recipe, or a page that attributes this dish to that book or to that author.
4. It is the ORIGINAL recipe as published, NOT a modified version. Reject any page that presents the recipe as adapted, changed, or derived — e.g. wording like "adapted from", "based on", "inspired by", "riff on", "my take/version on", "loosely based", "slightly adapted", or any note that ingredients or method were changed. Only the faithful original qualifies.

Treat accented characters, transliterations, and minor punctuation or spelling variations as equivalent (e.g. "crème" = "creme", "é" = "e", "Café" = "Cafe").

Be strict on points 1, 2 and 4: a generic recipe for the same dish with no connection to that book or author is NOT a match, a page that is merely about the book but is not itself the recipe is NOT a match, and an adaptation or modified version is NOT a match. When several qualify, prefer the most authoritative (the author or publisher over a third-party blog). If none clearly qualify, return -1.`;

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    index: {
      type: "integer",
      description: "0-based index of the result that is genuinely the cookbook's recipe, or -1 if none qualify.",
    },
  },
  required: ["index"],
  additionalProperties: false,
};

/** Ask Claude which candidate (if any) is genuinely the cookbook's recipe. */
async function verifyWithClaude(recipe, candidates) {
  const list = candidates
    .map(
      (c, i) =>
        `${i}: title: ${c.title}\n   url: ${c.link}\n   snippet: ${c.snippet}`,
    )
    .join("\n");
  const user =
    `Recipe: ${recipe.name}\n` +
    `Cookbook: ${recipe.book}\n` +
    (recipe.author ? `Author: ${recipe.author}\n` : "") +
    `\nResults:\n${list}`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 100,
    system: VERIFY_SYSTEM,
    tools: [{ name: "verify", description: "Record the matching result.", input_schema: VERIFY_SCHEMA }],
    tool_choice: { type: "tool", name: "verify" },
    messages: [{ role: "user", content: user }],
  });
  const block = resp.content.find((b) => b.type === "tool_use");
  const idx = block?.input?.index;
  return Number.isInteger(idx) ? idx : -1;
}

/**
 * Pick the best result URL for a recipe. A safety pre-filter (https + domain
 * policy) narrows the candidates, then Claude confirms the chosen result is
 * genuinely THIS cookbook's recipe — not a generic version of the dish.
 *  --strict      only the curated big-site allowlist
 *  (default)     any domain except the junk blocklist
 *  --any-domain  any domain at all
 */
async function pickUrl(results, recipe) {
  const candidates = [];
  for (const r of results) {
    if (!r.link || !/^https?:\/\//i.test(r.link)) continue;
    let host;
    try {
      host = new URL(r.link).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (STRICT) {
      if (!TRUSTED.has(host)) continue;
    } else if (!ANY_DOMAIN) {
      if (BLOCKED.has(host)) continue;
    }
    candidates.push(r);
    if (candidates.length >= 6) break; // bound the prompt + cost
  }
  if (candidates.length === 0) return null;

  const idx = await verifyWithClaude(recipe, candidates);
  if (idx < 0 || idx >= candidates.length) return null;
  return candidates[idx].link;
}

// ── Sheets batch write ────────────────────────────────────────────────────────

async function batchWrite(updates) {
  const token = await getAccessToken();
  const safeTab = TAB_NAME.replace(/'/g, "''");
  const data = updates.map(({ col, row, url }) => ({
    range: `'${safeTab}'!${col}${row}`,
    values: [[url]],
  }));

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "RAW", data }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sheet batch write failed: HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching sheet…");
  const csvRes = await fetch(SHEET_CSV_URL, { redirect: "follow" });
  if (!csvRes.ok) die(`Sheet fetch failed: HTTP ${csvRes.status}`);
  const text = await csvRes.text();

  const parsed = Papa.parse(text, { header: true, skipEmptyLines: false });
  const fields = parsed.meta.fields ?? [];

  // Build header→field map and field→column-index map
  const hmap  = new Map(); // raw header → field name
  const colIdx = {};       // field name → 0-based column index
  const fieldHeader = {};  // field name → raw header (for row lookup)
  for (const [i, f] of fields.entries()) {
    const m = mapHeader(f);
    if (m && !colIdx.hasOwnProperty(m)) {
      hmap.set(f, m);
      colIdx[m] = i;
      fieldHeader[m] = f;
    }
  }

  if (!colIdx.hasOwnProperty("name")) die("Could not find a 'Recipe name' column.");
  if (!colIdx.hasOwnProperty("link")) die("Could not find a 'Link' / 'URL' column.");

  const linkCol = colLetter(colIdx.link);
  console.log(`Link column: ${linkCol}  Tab: ${TAB_NAME || "(dry-run)"}`);
  console.log(`Search provider: ${PROVIDER === "serper" ? "Serper.dev" : "Google Custom Search"}`);
  console.log(DRY_RUN ? "Mode: DRY RUN (nothing will be written)" : "Mode: LIVE");
  const domainMode = STRICT ? "curated big-site allowlist (--strict)"
    : ANY_DOMAIN ? "any domain (--any-domain)"
    : "any reputable domain (junk sites blocked)";
  console.log(`Domain filter: ${domainMode}`);
  console.log(`Cookbook check: Claude (${MODEL}) — must be this book's recipe`);

  // Collect rows needing a link. A book title is required: without it we can't
  // verify the result is genuinely from that cookbook, so such rows are skipped.
  const eligible = [];
  let skippedNoBook = 0;
  for (const [i, row] of parsed.data.entries()) {
    const rowNum = i + 2; // sheet row (header at 1, data from 2)
    const name   = (row[fieldHeader.name]   ?? "").trim();
    const book   = (row[fieldHeader.book]   ?? "").trim();
    const author = (row[fieldHeader.author] ?? "").trim();
    const link   = (row[fieldHeader.link]   ?? "").trim();

    if (!name && !book) continue;           // blank / filler row
    if (!name) continue;                    // can't build a search query
    if (/^https?:\/\//i.test(link)) continue; // already has a valid link
    if (!book) { skippedNoBook++; continue; } // can't verify cookbook attribution

    eligible.push({ rowNum, name, book, author });
  }
  if (skippedNoBook > 0) {
    console.log(`(Skipping ${skippedNoBook} row${skippedNoBook === 1 ? "" : "s"} with no cookbook recorded — can't verify attribution.)`);
  }

  // Choose which eligible rows to process: an even spread across the whole
  // catalogue (--sample, good for representative testing) or the first N.
  let toSearch;
  if (SAMPLE && Number.isFinite(LIMIT) && LIMIT < eligible.length) {
    const step = eligible.length / LIMIT;
    toSearch = Array.from({ length: LIMIT }, (_, k) => eligible[Math.floor(k * step)]);
    console.log(`Sampling ${LIMIT} of ${eligible.length} eligible recipes, spread across the catalogue.`);
  } else {
    toSearch = Number.isFinite(LIMIT) ? eligible.slice(0, LIMIT) : eligible;
  }

  const total = toSearch.length;
  console.log(`\n${total} recipe${total === 1 ? "" : "s"} without links to search.\n`);
  if (total === 0) { console.log("Nothing to do."); return; }

  let found = 0, notFound = 0, errored = 0;
  const pending = []; // updates not yet flushed

  async function flush() {
    if (DRY_RUN || pending.length === 0) return;
    process.stdout.write(`  → Writing ${pending.length} link${pending.length === 1 ? "" : "s"} to sheet… `);
    await batchWrite([...pending]);
    pending.length = 0;
    console.log("done.");
  }

  for (let i = 0; i < total; i++) {
    const { rowNum, name, book, author } = toSearch[i];

    // Quote only the recipe name (keeps the dish exact); keep the book and
    // author UNQUOTED so Google doesn't require the full book-title string.
    const primary = [`"${name}"`, author, book, "recipe"]
      .filter(Boolean).join(" ");
    // Fallback: name + author only (drops the book entirely), to surface pages
    // the author posted or that attribute the dish to them without naming the book.
    const fallback = author ? [`"${name}"`, author, "recipe"].join(" ") : null;

    process.stdout.write(`[${i + 1}/${total}] ${name}… `);

    try {
      let results = await runSearch(primary);
      let url     = await pickUrl(results, { name, book, author });
      if (!url && fallback) {
        results = await runSearch(fallback);
        url     = await pickUrl(results, { name, book, author });
      }

      if (url) {
        const host = new URL(url).hostname.replace(/^www\./, "");
        console.log(`✓ ${host}`);
        found++;
        if (DRY_RUN) {
          console.log(`   would write: ${url}`);
        } else {
          pending.push({ col: linkCol, row: rowNum, url });
          // Flush every 50 so progress is saved incrementally
          if (pending.length >= 50) await flush();
        }
      } else {
        console.log("— no verified cookbook match");
        notFound++;
      }
    } catch (err) {
      console.log(`! ${err.message}`);
      errored++;
      // On quota errors, stop immediately
      if (err.message.includes("429")) break;
    }

    // Pace requests. Serper tolerates a faster cadence than CSE's free tier.
    if (i < total - 1) await sleep(PROVIDER === "serper" ? 400 : 1100);
  }

  await flush();

  console.log(`
─────────────────────────────────────
Found & written : ${found}
No result       : ${notFound}
Errors          : ${errored}
Total searched  : ${found + notFound + errored}
─────────────────────────────────────`);
  if (DRY_RUN) console.log("Dry run complete — no changes made to the sheet.");
}

main().catch((e) => { console.error(e); process.exit(1); });
