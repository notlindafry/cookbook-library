#!/usr/bin/env node
// Find online versions of the recipes in your catalogue and write the URLs back
// to a dedicated column in your Google Sheet. Run it occasionally — e.g. after
// you add a newly-purchased cookbook's recipes.
//
// What it does, per un-linked recipe:
//   1. Asks Claude to search ONLY a curated allowlist of reputable recipe sites
//      for the SAME recipe (matching recipe name + book title, and/or recipe
//      name + author name) — not just any dish with the same name.
//   2. Independently validates each candidate URL in our own code: it must be a
//      trusted https host, reachable, not a 404 / placeholder / disallowed
//      paywall, and the page must actually be that recipe.
//   3. Picks the most reputable site with the strongest matching signals and
//      writes its URL into the target column.
//
// It never re-queries a recipe that already has a URL in the target column, so
// re-runs are cheap and idempotent.
//
// Usage:
//   node scripts/find-recipe-urls.mjs [--dry-run] [--limit N] [--book "Soup Book"]
//
// Required env: ANTHROPIC_API_KEY and the Google service-account write-back vars
// (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, SHEET_ID, SHEET_TAB_NAME).
// Optional env: RECIPE_URL_COLUMN (target column header; default: the sheet's
// existing recipe-link column), ANTHROPIC_MODEL.

import {
  requireSheetEnv,
  readSheet,
  writeHeaderCell,
  batchWriteColumn,
  columnLetter,
} from "./lib/sheets.mjs";
import { findBestLink } from "./lib/find-link.mjs";
import { finderModel } from "./lib/find-candidates.mjs";

const DEFAULT_LIMIT = 100; // cost guardrail; raise with --limit (0 = no cap)
const CONCURRENCY = 3;

// Published per-MTok token prices and the web-search rate, for cost estimation.
const PRICES = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const WEB_SEARCH_PER_1K = 10; // USD per 1,000 web searches
const CHUNK = 25; // flush matches to the sheet every N recipes (durable progress)

function parseArgs(argv) {
  const args = { dryRun: false, limit: DEFAULT_LIMIT, book: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--book") args.book = String(argv[++i] || "").trim();
    else if (a.startsWith("--limit=")) args.limit = Number(a.split("=")[1]);
    else if (a.startsWith("--book=")) args.book = a.split("=").slice(1).join("=").trim();
  }
  if (!Number.isFinite(args.limit) || args.limit < 0) args.limit = DEFAULT_LIMIT;
  return args;
}

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

function classifyHeader(raw) {
  const h = norm(raw);
  if (h.includes("book")) return "book";
  if (h.includes("author")) return "author";
  if (h.includes("recipe name") || h === "name" || h === "recipe") return "name";
  if (h.includes("link") || h.includes("url")) return "link";
  return null;
}

/** Locate book/author/name/link columns and the write target column. */
function resolveColumns(header) {
  const cols = { book: -1, author: -1, name: -1, link: -1 };
  header.forEach((raw, i) => {
    const f = classifyHeader(raw);
    if (f && cols[f] === -1) cols[f] = i;
  });

  const envCol = (process.env.RECIPE_URL_COLUMN || "").trim();
  let targetCol = -1;
  let createHeaderAs = null;
  if (envCol) {
    targetCol = header.findIndex((h) => norm(h) === norm(envCol));
    if (targetCol === -1) {
      targetCol = header.length; // append a new dedicated column on the right
      createHeaderAs = envCol;
    }
  } else {
    targetCol = cols.link;
  }
  return { cols, targetCol, createHeaderAs };
}

async function runPool(items, worker, concurrency) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

// A misconfigured key or missing web-search entitlement would fail on every
// recipe — surface it immediately rather than churning through the whole list.
function isFatalApiError(err) {
  return err?.status === 401 || err?.status === 403;
}

async function processRecipe(recipe) {
  try {
    return await findBestLink(recipe);
  } catch (err) {
    if (isFatalApiError(err)) throw err; // abort the run
    return { status: "error", reason: err?.message || "search failed" };
  }
}

// Re-read the sheet and write only rows whose recipe name is unchanged and whose
// target cell is still empty, so we never overwrite the wrong cell or clobber a
// link added since we read. Returns how many were written vs. skipped.
async function flushUpdates(targetCol, nameCol, updates) {
  const fresh = await readSheet();
  const safe = updates.filter(({ row, name }) => {
    const live = fresh[row - 1];
    if (!live) return false;
    const liveName = norm(live[nameCol] || "");
    const liveTarget = (live[targetCol] || "").trim();
    return liveName === norm(name) && !liveTarget;
  });
  await batchWriteColumn(
    targetCol,
    safe.map(({ row, value }) => ({ row, value })),
  );
  return { written: safe.length, skipped: updates.length - safe.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireSheetEnv();
  if (
    !(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.claude_api_key)
  ) {
    throw new Error("Set ANTHROPIC_API_KEY (or CLAUDE_API_KEY).");
  }

  console.log("Reading sheet…");
  const rows = await readSheet();
  if (rows.length < 2) throw new Error("Sheet appears empty (no data rows).");
  const header = rows[0];

  const { cols, targetCol, createHeaderAs } = resolveColumns(header);
  if (cols.name === -1) throw new Error("Could not find a 'Recipe name' column.");
  if (cols.book === -1 && cols.author === -1) {
    throw new Error("Could not find a 'Book' or 'Author' column to match against.");
  }
  if (targetCol === -1) {
    throw new Error(
      "No recipe-link column found. Set RECIPE_URL_COLUMN to the exact header of the column to write URLs into.",
    );
  }
  console.log(
    `Target column: ${columnLetter(targetCol)}` +
      (createHeaderAs ? ` (will create header "${createHeaderAs}")` : ` ("${header[targetCol]}")`),
  );

  // Build the worklist: rows with a name, a book or author, and an EMPTY target
  // cell (we never re-query entries that already have a linked recipe).
  const work = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const recipe = {
      name: (row[cols.name] || "").trim(),
      book: cols.book >= 0 ? (row[cols.book] || "").trim() : "",
      author: cols.author >= 0 ? (row[cols.author] || "").trim() : "",
    };
    if (!recipe.name) continue;
    if (!recipe.book && !recipe.author) continue;
    if ((row[targetCol] || "").trim()) continue; // already linked → skip
    if (args.book && !norm(recipe.book).includes(norm(args.book))) continue;
    work.push({ rowNumber: r + 1, recipe }); // 1-based sheet row
  }

  const eligible = work.length;
  const limited = args.limit > 0 ? work.slice(0, args.limit) : work;
  console.log(
    `${eligible} un-linked recipe(s) eligible; processing ${limited.length}` +
      `${args.dryRun ? " (dry run, no writes)" : ""}.`,
  );
  if (limited.length === 0) return;

  // Create the dedicated column header up front if we're appending a new one.
  if (!args.dryRun && createHeaderAs) await writeHeaderCell(targetCol, createHeaderAs);

  const summary = { matched: 0, no_match: 0, no_candidates: 0, error: 0 };
  const usage = { input: 0, output: 0, searches: 0, counted: 0 };
  let written = 0;
  let skipped = 0;

  // Process in chunks and flush each chunk's matches as we go, so a long run is
  // durable: if it's cancelled or times out, everything found so far is already
  // saved (and a re-run resumes, since linked rows are skipped).
  for (let start = 0; start < limited.length; start += CHUNK) {
    const chunk = limited.slice(start, start + CHUNK);
    const chunkUpdates = [];

    await runPool(
      chunk,
      async ({ rowNumber, recipe }) => {
        const res = await processRecipe(recipe);
        summary[res.status] = (summary[res.status] || 0) + 1;
        if (res.usage) {
          usage.input += res.usage.input;
          usage.output += res.usage.output;
          usage.searches += res.usage.searches;
          usage.counted += 1;
        }
        if (res.status === "matched") {
          chunkUpdates.push({ row: rowNumber, value: res.url, name: recipe.name });
          console.log(`✓ row ${rowNumber}  ${recipe.name} → ${res.url}`);
        } else {
          const why = res.reason ? ` (${res.reason})` : "";
          console.log(`· row ${rowNumber}  ${recipe.name} — ${res.status}${why}`);
        }
      },
      CONCURRENCY,
    );

    if (!args.dryRun && chunkUpdates.length) {
      const r = await flushUpdates(targetCol, cols.name, chunkUpdates);
      written += r.written;
      skipped += r.skipped;
    }
    console.log(
      `  …${Math.min(start + CHUNK, limited.length)}/${limited.length} processed` +
        (args.dryRun ? "" : ` · ${written} written so far`),
    );
  }

  console.log(
    `\nResults: ${summary.matched} matched, ${summary.no_match} no-match, ` +
      `${summary.no_candidates} no-candidates, ${summary.error} error.`,
  );
  reportCost(usage, eligible, finderModel());
  if (args.dryRun) {
    console.log(`Dry run — no changes written (${summary.matched} would have been).`);
    return;
  }
  console.log(
    `Wrote ${written} URL(s) to column ${columnLetter(targetCol)}.` +
      (skipped ? ` Skipped ${skipped} (changed since read).` : ""),
  );
}

/** Print a measured cost breakdown for this run and project it to all eligible rows. */
function reportCost(usage, eligible, model) {
  if (usage.counted === 0) return;
  const price = PRICES[model] || PRICES["claude-sonnet-4-6"];
  const inCost = (usage.input / 1e6) * price.in;
  const outCost = (usage.output / 1e6) * price.out;
  const searchCost = (usage.searches / 1000) * WEB_SEARCH_PER_1K;
  const runCost = inCost + outCost + searchCost;
  const perRecipe = runCost / usage.counted;

  console.log(`\nCost (measured over ${usage.counted} recipe(s), model ${model}):`);
  console.log(`  web searches: ${usage.searches}  ($${searchCost.toFixed(2)})`);
  console.log(`  input tokens:  ${usage.input.toLocaleString()}  ($${inCost.toFixed(2)})`);
  console.log(`  output tokens: ${usage.output.toLocaleString()}  ($${outCost.toFixed(2)})`);
  console.log(`  this run: $${runCost.toFixed(2)}  ·  ~$${perRecipe.toFixed(3)}/recipe`);
  console.log(
    `  → projected for all ${eligible} un-linked recipe(s): ~$${(perRecipe * eligible).toFixed(2)}`,
  );
  if (!PRICES[model]) {
    console.log(`  (unrecognized model — priced as claude-sonnet-4-6; adjust if needed)`);
  }
  console.log(
    `  basis: web search $${WEB_SEARCH_PER_1K}/1k searches; tokens $${price.in}/$${price.out} per MTok in/out.`,
  );
}

main().catch((err) => {
  console.error(`\nError: ${err?.message || err}`);
  process.exit(1);
});
