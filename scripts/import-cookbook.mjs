#!/usr/bin/env node
// Import a newly-purchased cookbook's recipes into your "Cookbook catalogue"
// sheet. Reads an itemized recipe list (e.g. copied from Eat Your Books — see
// scripts/examples/cookbook-import.example.txt for the format), uses Claude to
// assign each recipe a Category and Main ingredient from your controlled vocab,
// then appends clean rows to the sheet. Verdict/notes/link columns are left
// blank for you to fill (and for the find-urls script to populate later).
//
// It is DRY-RUN by default: it prints what it would add and writes a preview
// CSV. Pass --write to actually append. It never edits existing rows, skips
// recipes already in the sheet, and refuses to write if it can't find a clean,
// contiguous place to append (so legend/summary tables below the data are safe).
//
// Usage:
//   node scripts/import-cookbook.mjs <list-file> [--write] [--limit N]
//                                    [--no-classify] [--model NAME] [--out FILE]
//
// Required env for classification: ANTHROPIC_API_KEY (or CLAUDE_API_KEY).
// Required env for --write (and for dedupe): the Google service-account vars
// GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, SHEET_ID, SHEET_TAB_NAME.
// Optional: ANTHROPIC_MODEL (default claude-haiku-4-5).

import { readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

import { requireSheetEnv, readSheet, writeRange, readRange, columnLetter } from "./lib/sheets.mjs";
import { CATEGORIES, INGREDIENTS, VOCAB_GUIDE } from "./lib/vocab.mjs";
import {
  parseImportText,
  resolveColumns,
  existingKeys,
  dedupe,
  findInsertionRow,
  buildRow,
  validateCategory,
  validateIngredients,
  formatIngredients,
} from "./lib/import-cookbook.mjs";

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const BATCH = 60;

function parseArgs(argv) {
  const args = { file: null, write: false, limit: 0, classify: true, model: DEFAULT_MODEL, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") args.write = true;
    else if (a === "--no-classify") args.classify = false;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a.startsWith("--limit=")) args.limit = Number(a.split("=")[1]);
    else if (a === "--model") args.model = String(argv[++i] || "").trim();
    else if (a.startsWith("--model=")) args.model = a.split("=").slice(1).join("=").trim();
    else if (a === "--out") args.out = String(argv[++i] || "").trim();
    else if (a.startsWith("--out=")) args.out = a.split("=").slice(1).join("=").trim();
    else if (!a.startsWith("-") && !args.file) args.file = a;
  }
  if (!Number.isFinite(args.limit) || args.limit < 0) args.limit = 0;
  return args;
}

const apiKey =
  process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.claude_api_key;

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          category: { type: "string", enum: [...CATEGORIES] },
          ingredients: { type: "array", items: { type: "string", enum: [...INGREDIENTS] } },
        },
        required: ["i", "category", "ingredients"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const SYSTEM = `You categorize cookbook recipes for a personal catalogue, using ONLY the
controlled vocabulary below. For each recipe you are given an index, its name, its
chapter, and the cookbook. Return, per index: one "category" and a "ingredients"
array (one or more main ingredients — usually just the protein).

${VOCAB_GUIDE}

Return exactly one entry per provided index. Use only the listed values verbatim.`;

async function classify(records, model) {
  const client = new Anthropic({ apiKey });
  const results = new Array(records.length).fill(null);

  for (let start = 0; start < records.length; start += BATCH) {
    const batch = records.slice(start, start + BATCH);
    const list = batch
      .map((r, i) => `${i}: ${r.name} | ${r.chapter || "—"} | ${r.book}`)
      .join("\n");

    const resp = await client.messages.create({
      model,
      max_tokens: 8000,
      system: SYSTEM,
      tools: [{ name: "emit", description: "Record categories.", input_schema: CLASSIFY_SCHEMA }],
      tool_choice: { type: "tool", name: "emit" },
      messages: [{ role: "user", content: `Recipes:\n${list}` }],
    });

    const block = resp.content.find((b) => b.type === "tool_use");
    for (const item of block?.input?.items ?? []) {
      if (typeof item.i === "number" && item.i >= 0 && item.i < batch.length) {
        results[start + item.i] = {
          category: validateCategory(item.category),
          ingredient: formatIngredients(item.ingredients),
        };
      }
    }
    console.log(`  classified ${Math.min(start + BATCH, records.length)}/${records.length}…`);
  }

  // Anything the model skipped falls back to the explicit "unknown" markers.
  return results.map((r) => r ?? { category: "I don't know", ingredient: "I don't know" });
}

const csvCell = (s) => {
  const v = String(s ?? "");
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

function writePreview(path, header, rows) {
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  writeFileSync(path, lines.join("\n") + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("Usage: node scripts/import-cookbook.mjs <list-file> [--write] [--limit N] [--no-classify]");
    process.exit(1);
  }
  if (args.classify && !apiKey) {
    console.error("Classification needs ANTHROPIC_API_KEY (or CLAUDE_API_KEY). Use --no-classify to skip it.");
    process.exit(1);
  }

  const text = readFileSync(args.file, "utf8");
  const { records, warnings } = parseImportText(text);
  for (const w of warnings) console.warn(`! ${w}`);
  if (!records.length) {
    console.error("No recipes parsed from the input file.");
    process.exit(1);
  }
  const byBook = records.reduce((m, r) => m.set(r.book, (m.get(r.book) || 0) + 1), new Map());
  console.log(`Parsed ${records.length} recipes across ${byBook.size} book(s):`);
  for (const [b, n] of byBook) console.log(`  • ${b}: ${n}`);

  // Resolve the sheet's columns + skip recipes that are already catalogued.
  const haveSheetEnv = ["GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_PRIVATE_KEY", "SHEET_ID", "SHEET_TAB_NAME"]
    .every((k) => process.env[k]);
  let cols = null;
  let header = null;
  let insertion = null;
  let toAdd = records;

  if (haveSheetEnv) {
    console.log("Reading the sheet to resolve columns and skip duplicates…");
    const values = await readSheet();
    header = values[0] ?? [];
    cols = resolveColumns(header);
    if (cols.book === undefined || cols.name === undefined) {
      throw new Error("Could not find Book/Recipe-name columns in the sheet header.");
    }
    const existing = existingKeys(values, cols);
    const { fresh, duplicates } = dedupe(records, existing);
    toAdd = fresh;
    insertion = findInsertionRow(values, cols);
    console.log(
      `Already in sheet: ${duplicates.length} skipped. New to add: ${fresh.length}. ` +
        `Last recipe row: ${insertion.lastDataRow}; would append from row ${insertion.insertRow}.`,
    );
  } else {
    console.warn("! No Google service-account env — running offline (no dedupe, no write).");
    // Offline column order falls back to the known sheet layout.
    cols = { book: 0, author: 1, chapter: 2, name: 3, page: 4, category: 5, ingredient: 6,
      link: 7, tried: 8, notes: 9, rejected: 10 };
    header = ["Book title", "Author", "Chapter name", "Recipe name", "Page #", "Category",
      "Main ingredient", "Recipe link", "Tried tag", "Prep notes", "Rejected links"];
  }

  if (args.limit && toAdd.length > args.limit) {
    console.log(`Limiting to first ${args.limit} (of ${toAdd.length}) per --limit.`);
    toAdd = toAdd.slice(0, args.limit);
  }
  if (!toAdd.length) {
    console.log("Nothing new to add. Done.");
    return;
  }

  // Classify category + main ingredient for each new recipe.
  if (args.classify) {
    console.log(`Classifying ${toAdd.length} recipes with ${args.model}…`);
    const tags = await classify(toAdd, args.model);
    toAdd = toAdd.map((r, i) => ({ ...r, ...tags[i] }));
  } else {
    toAdd = toAdd.map((r) => ({ ...r, category: "", ingredient: "" }));
  }

  // Assemble the exact rows we'd write (only columns we understand, A..max).
  const maxCol = Math.max(...Object.values(cols));
  const width = maxCol + 1;
  const rows = toAdd.map((r) => buildRow(r, cols, width));
  const headerSlice = header.slice(0, width);

  // Preview to stdout + a CSV alongside the input file.
  console.log("\nPreview (first 12):");
  for (const r of toAdd.slice(0, 12)) {
    console.log(`  [${r.category}] {${r.ingredient}}  ${r.name}  p.${r.page || "?"}  — ${r.chapter || "—"}`);
  }
  const outPath = args.out || `${args.file}.preview.csv`;
  writePreview(outPath, headerSlice, rows);
  console.log(`\nFull preview written to ${outPath} (${rows.length} rows).`);

  if (!args.write) {
    console.log("\nDry run — nothing written. Re-run with --write to append these rows.");
    return;
  }

  // --- Actually append (guarded) ---
  requireSheetEnv();
  if (!insertion) throw new Error("Cannot write without the sheet (service-account env).");
  if (!insertion.contiguousOk) {
    throw new Error(
      "The recipe data isn't a single contiguous block — something that looks like a recipe " +
        `sits below row ${insertion.lastDataRow} (likely a legend/summary table). Refusing to ` +
        "auto-append. Append manually, or move summary tables to a separate area/tab.",
    );
  }
  const startRow = insertion.insertRow;
  const endRow = startRow + rows.length - 1;
  const lastColLetter = columnLetter(maxCol);
  const range = `A${startRow}:${lastColLetter}${endRow}`;

  // TOCTOU guard: confirm the target block is empty right before writing.
  const target = await readRange(range);
  const occupied = target.some((row) => (row ?? []).some((c) => String(c ?? "").trim() !== ""));
  if (occupied) {
    throw new Error(`Refusing to write: target range ${range} is not empty. Re-run to recompute.`);
  }

  await writeRange(range, rows);
  console.log(`\n✓ Appended ${rows.length} rows to ${range}.`);
  console.log("Next: re-run `npm run tag-cuisines` (cuisine filter) and `npm run find-urls` (recipe links).");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
