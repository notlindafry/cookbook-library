#!/usr/bin/env node
// One-time (re-runnable) script: tags every recipe in your sheet with a cuisine
// using Claude, and writes data/cuisines.json. The app then offers an instant
// "cuisine" filter. Re-run whenever you've added a lot of recipes.
//
// Usage:
//   SHEET_CSV_URL=... ANTHROPIC_API_KEY=... node scripts/tag-cuisines.mjs
//
// Honors ANTHROPIC_API_KEY / CLAUDE_API_KEY / claude_api_key and ANTHROPIC_MODEL.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "data", "cuisines.json");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const BATCH = 100;

const apiKey =
  process.env.ANTHROPIC_API_KEY ||
  process.env.CLAUDE_API_KEY ||
  process.env.claude_api_key;
const sheetUrl = process.env.SHEET_CSV_URL;

if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY (or CLAUDE_API_KEY).");
  process.exit(1);
}
if (!sheetUrl) {
  console.error("Set SHEET_CSV_URL.");
  process.exit(1);
}

const key = (book, name) =>
  `${book}::${name}`.toLowerCase().replace(/\s+/g, " ").trim();

function mapHeader(raw) {
  const h = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (h.includes("book")) return "book";
  if (h.includes("recipe name") || h === "name" || h === "recipe") return "name";
  if (h.includes("chapter")) return "chapter";
  return null;
}

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          cuisine: { type: "string" },
        },
        required: ["i", "cuisine"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const SYSTEM = `You assign a single cuisine to each recipe based on its name, chapter, and cookbook.
Use widely-recognized cuisine names (e.g. Italian, French, Mexican, Thai, Japanese, Chinese, Indian, Middle Eastern, Mediterranean, American, Korean, Vietnamese, Spanish, Greek, Persian, Native American).
If a recipe has no clear cuisine, return an empty string for it. Return one entry per provided index.`;

async function main() {
  console.log("Fetching sheet…");
  const res = await fetch(sheetUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`Sheet fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: "greedy" });

  const fields = parsed.meta.fields ?? [];
  const hmap = {};
  for (const f of fields) {
    const m = mapHeader(f);
    if (m && !(m in hmap)) hmap[f] = m;
  }

  const recipes = [];
  for (const row of parsed.data) {
    const r = { book: "", name: "", chapter: "" };
    for (const [h, v] of Object.entries(row)) {
      const field = hmap[h];
      if (field) r[field] = (v ?? "").trim();
    }
    if (r.name || r.book) recipes.push(r);
  }
  console.log(`Parsed ${recipes.length} recipes.`);

  const client = new Anthropic({ apiKey });
  const out = {};

  for (let start = 0; start < recipes.length; start += BATCH) {
    const batch = recipes.slice(start, start + BATCH);
    const list = batch
      .map((r, i) => `${i}: ${r.name} | ${r.book} | ${r.chapter}`)
      .join("\n");

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      tools: [
        { name: "emit", description: "Record cuisines.", input_schema: SCHEMA },
      ],
      tool_choice: { type: "tool", name: "emit" },
      messages: [{ role: "user", content: `Recipes:\n${list}` }],
    });

    const block = resp.content.find((b) => b.type === "tool_use");
    const items = block?.input?.items ?? [];
    for (const { i, cuisine } of items) {
      const r = batch[i];
      if (r && cuisine && cuisine.trim()) {
        out[key(r.book, r.name)] = cuisine.trim();
      }
    }
    console.log(`Tagged ${Math.min(start + BATCH, recipes.length)}/${recipes.length}…`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 0) + "\n");
  console.log(`Wrote ${Object.keys(out).length} cuisine tags to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
