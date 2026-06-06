#!/usr/bin/env node
// One-time (re-runnable) script: searches Google for a web version of each
// recipe that doesn't already have a link, and writes the URL back to the sheet.
//
// Re-runnable: skips any recipe that already has an https link.
//
// ── Setup (one-time) ──────────────────────────────────────────────────────────
//
//  Google Custom Search API
//  1. console.cloud.google.com → enable "Custom Search API" → Credentials →
//     Create API key → copy it as GOOGLE_CSE_API_KEY
//  2. programmablesearchengine.google.com → New search engine →
//     "Search the entire web" → Create → copy the Search engine ID as GOOGLE_CSE_CX
//
//  Free quota: 100 queries/day. Enable billing + pay $5/1,000 to go higher.
//  At $5/1,000 a batch of 2,500 missing links costs ~$12.50.
//
//  Google Sheets write-back (same service account used by the app's write-back)
//  3. Share your sheet with the service account as an Editor.
//     Set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, SHEET_ID, SHEET_TAB_NAME.
//
// ── Usage ─────────────────────────────────────────────────────────────────────
//
//  SHEET_CSV_URL=...
//  GOOGLE_CSE_API_KEY=...  GOOGLE_CSE_CX=...
//  GOOGLE_SERVICE_ACCOUNT_EMAIL=...  GOOGLE_PRIVATE_KEY=...
//  SHEET_ID=...  SHEET_TAB_NAME=...
//  node scripts/find-recipe-links.mjs [--dry-run] [--limit N] [--any-domain]
//
//  --dry-run     Print what would be written without touching the sheet.
//  --limit N     Only process the first N un-linked recipes (handy for testing).
//  --any-domain  Accept the top Google result regardless of domain.
//                Default: only accept results from known recipe sites.

import Papa from "papaparse";
import { SignJWT, importPKCS8 } from "jose";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN   = args.includes("--dry-run");
const ANY_DOMAIN = args.includes("--any-domain");
const limitIdx  = args.indexOf("--limit");
const LIMIT     = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ── Env vars ──────────────────────────────────────────────────────────────────

const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const CSE_KEY       = process.env.GOOGLE_CSE_API_KEY;
const CSE_CX        = process.env.GOOGLE_CSE_CX;
const SVC_EMAIL     = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const PRIVATE_KEY   = process.env.GOOGLE_PRIVATE_KEY;
const SHEET_ID      = process.env.SHEET_ID;
const TAB_NAME      = process.env.SHEET_TAB_NAME;

function die(msg) { console.error("Error:", msg); process.exit(1); }

if (!SHEET_CSV_URL) die("SHEET_CSV_URL is required.");
if (!CSE_KEY)       die("GOOGLE_CSE_API_KEY is required.");
if (!CSE_CX)        die("GOOGLE_CSE_CX is required.");
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

// ── Google Custom Search ──────────────────────────────────────────────────────

async function searchGoogle(query) {
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", CSE_KEY);
  url.searchParams.set("cx", CSE_CX);
  url.searchParams.set("q", query);
  url.searchParams.set("num", "5");

  const res = await fetch(url.toString());
  if (res.status === 429) throw new Error("Daily quota exhausted (429). Try again tomorrow or upgrade billing.");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CSE search failed: HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.items ?? [];
}

function pickUrl(items) {
  for (const item of items) {
    try {
      const link = item.link;
      if (!link || !/^https?:\/\//i.test(link)) continue;
      if (ANY_DOMAIN) return link;
      const host = new URL(link).hostname.replace(/^www\./, "");
      if (TRUSTED.has(host)) return link;
    } catch { /* skip malformed */ }
  }
  return null;
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
  console.log(DRY_RUN ? "Mode: DRY RUN (nothing will be written)" : "Mode: LIVE");
  if (ANY_DOMAIN) console.log("Domain filter: OFF (--any-domain)");

  // Collect rows needing a link
  const toSearch = [];
  for (const [i, row] of parsed.data.entries()) {
    const rowNum = i + 2; // sheet row (header at 1, data from 2)
    const name   = (row[fieldHeader.name]   ?? "").trim();
    const book   = (row[fieldHeader.book]   ?? "").trim();
    const author = (row[fieldHeader.author] ?? "").trim();
    const link   = (row[fieldHeader.link]   ?? "").trim();

    if (!name && !book) continue;           // blank / filler row
    if (!name) continue;                    // can't build a search query
    if (/^https?:\/\//i.test(link)) continue; // already has a valid link

    toSearch.push({ rowNum, name, book, author });
    if (toSearch.length >= LIMIT) break;
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

    // Build query: "Recipe Name book title recipe" works well for cookbook recipes
    const queryParts = [`"${name}"`];
    if (book) queryParts.push(`"${book}"`);
    const query = queryParts.join(" ") + " recipe";

    process.stdout.write(`[${i + 1}/${total}] ${name}… `);

    try {
      const items = await searchGoogle(query);
      const url   = pickUrl(items);

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
        console.log("— no trusted result");
        notFound++;
      }
    } catch (err) {
      console.log(`! ${err.message}`);
      errored++;
      // On quota errors, stop immediately
      if (err.message.includes("429")) break;
    }

    // Stay under the free-tier rate limit (~1 req/sec)
    if (i < total - 1) await sleep(1100);
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
