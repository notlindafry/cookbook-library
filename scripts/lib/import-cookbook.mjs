// Pure, testable logic for the cookbook importer (no network/Anthropic here so
// it can be unit-tested). The CLI in scripts/import-cookbook.mjs wires this to
// Claude (classification) and the Sheets API (append).

import { CATEGORIES, INGREDIENTS } from "./vocab.mjs";

export const norm = (s) =>
  String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Stable key linking a recipe to a sheet row. Matches lib/data.ts cuisineKey. */
export const recipeKey = (book, name) => `${norm(book)}::${norm(name)}`;

// --- Input parsing --------------------------------------------------------
//
// Forgiving plain-text format (see scripts/examples/cookbook-import.example.txt):
//
//   Book: Ottolenghi Simple
//   Author: Yotam Ottolenghi
//   Chapter: Brunch
//   Braised eggs with leek and za'atar | 28
//   Cumin-spiced fritters | 30
//   // lines starting with // are comments
//
// `Book:` / `Author:` / `Chapter:` are directives (case-insensitive) that set
// the running context. Any other non-blank line is a recipe: "Name | Page", or
// just a name with a trailing page number ("Braised eggs 28"), or a bare name.

const DIRECTIVE = /^\s*(book|author|chapter)\s*:\s*(.*)$/i;

/** Pull a trailing page number off a recipe line that lacks an explicit `|`. */
export function extractPage(line) {
  // e.g. "Soup .... 124", "Soup, p. 124", "Soup 124-126", "Soup p124".
  // The optional p/pg/page marker must be its own token (preceded by a
  // separator) so we don't mistake the trailing "p" of "Soup" for it.
  const m = line.match(
    /^(.*?)(?:[\s.,]+(?:p|pg|page)\.?)?[\s.,]*(\d{1,4})(?:\s*[-–]\s*\d{1,4})?\s*$/i,
  );
  if (m && m[1].trim()) return { name: m[1].trim(), page: m[2] };
  return { name: line, page: "" };
}

/** Tidy a recipe name: drop dot leaders, collapse whitespace, trim punctuation. */
export function cleanName(s) {
  return String(s ?? "")
    .replace(/\.{2,}/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s,;:]+$/, "")
    .trim();
}

export function parseImportText(text) {
  const records = [];
  const warnings = [];
  let book = "";
  let author = "";
  let chapter = "";

  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) return;

    const d = line.match(DIRECTIVE);
    if (d) {
      const which = d[1].toLowerCase();
      const value = d[2].trim();
      if (which === "book") {
        book = value;
        chapter = ""; // a new book resets the running chapter
      } else if (which === "author") {
        author = value;
      } else {
        chapter = value;
      }
      return;
    }

    let name = "";
    let page = "";
    if (line.includes("|")) {
      const parts = line.split("|");
      name = parts[0];
      page = (parts[1] ?? "").trim();
    } else {
      ({ name, page } = extractPage(line));
    }
    name = cleanName(name);
    page = String(page).trim();
    if (!name) return;

    if (!book) {
      warnings.push(`Line ${idx + 1}: "${name}" has no Book: set above it — skipped.`);
      return;
    }
    records.push({ book, author, chapter, name, page });
  });

  return { records, warnings };
}

// --- Vocabulary validation ------------------------------------------------

const CAT_BY_NORM = new Map(CATEGORIES.map((c) => [norm(c), c]));
const ING_BY_NORM = new Map(INGREDIENTS.map((i) => [norm(i), i]));

/** Coerce a model-proposed category to an exact vocab value (fallback: unknown). */
export function validateCategory(value) {
  return CAT_BY_NORM.get(norm(value)) ?? "I don't know";
}

/** Coerce model-proposed ingredients to exact vocab values, de-duplicated. */
export function validateIngredients(value) {
  const arr = Array.isArray(value) ? value : String(value ?? "").split(",");
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const canonical = ING_BY_NORM.get(norm(raw));
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out.length ? out : ["I don't know"];
}

/** Sheet stores multiple ingredients as a comma-separated string. */
export const formatIngredients = (arr) => validateIngredients(arr).join(", ");

// --- Column resolution (match headers, don't assume positions) ------------

export function classifyHeader(raw) {
  const h = norm(raw);
  if (h.includes("book")) return "book";
  if (h.includes("author")) return "author";
  if (h.includes("chapter")) return "chapter";
  if (h.includes("recipe name") || h === "name" || h === "recipe") return "name";
  if (h.includes("page")) return "page";
  if (h.includes("category")) return "category";
  if (h.includes("main ingredient") || h === "ingredient" || h === "ingredients")
    return "ingredient";
  if (h.includes("rejected")) return "rejected"; // before the generic "link" check
  if (h.includes("link") || h.includes("url")) return "link";
  if (h.includes("tried")) return "tried";
  if (h.includes("note") || h.includes("prep")) return "notes";
  return null;
}

/** Map each known field to its 0-based column index from the header row. */
export function resolveColumns(header) {
  const cols = {};
  (header ?? []).forEach((raw, i) => {
    const f = classifyHeader(raw);
    if (f && cols[f] === undefined) cols[f] = i;
  });
  return cols;
}

/**
 * Build a row array of `width` cells, placing each value at its resolved column
 * index. Verdict/notes/link columns are intentionally left blank on import.
 */
export function buildRow(rec, cols, width) {
  const w = Math.max(width, 0);
  const row = new Array(w).fill("");
  const put = (field, value) => {
    const i = cols[field];
    if (i !== undefined && i < w) row[i] = value ?? "";
  };
  put("book", rec.book);
  put("author", rec.author);
  put("chapter", rec.chapter);
  put("name", rec.name);
  put("page", rec.page);
  put("category", rec.category);
  put("ingredient", rec.ingredient);
  return row;
}

// --- Dedupe + safe insertion point ---------------------------------------

/** Split records into ones not already in the sheet vs. duplicates. */
export function dedupe(records, existingKeySet) {
  const fresh = [];
  const duplicates = [];
  const within = new Set();
  for (const r of records) {
    const k = recipeKey(r.book, r.name);
    if (existingKeySet.has(k) || within.has(k)) duplicates.push(r);
    else {
      within.add(k);
      fresh.push(r);
    }
  }
  return { fresh, duplicates };
}

/** Build the set of existing book::name keys from the sheet's value grid. */
export function existingKeys(values, cols) {
  const set = new Set();
  const b = cols.book;
  const n = cols.name;
  if (b === undefined || n === undefined) return set;
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const book = row[b];
    const name = row[n];
    if (book && name) set.add(recipeKey(book, name));
  }
  return set;
}

/**
 * Find where to append. Returns the 1-based sheet row to write the first new
 * row, the last detected recipe row, and whether the recipe block is contiguous
 * (i.e. nothing that looks like a recipe sits below the insertion point — which
 * would mean a legend/summary table is in the way and we must NOT auto-append).
 */
export function findInsertionRow(values, cols) {
  const b = cols.book;
  const n = cols.name;
  // A row "looks like a recipe" when both the book and recipe-name cells are
  // filled. Legend/summary tables (single column, or label+number) never fill
  // both, so they don't count — and we append safely below the real recipes.
  const hasKey = (i) => {
    const row = values[i] ?? [];
    return Boolean(row[b]) && Boolean(row[n]);
  };
  let maxData = 0; // 0-based index of the last recipe row (header at index 0)
  for (let i = 1; i < values.length; i++) if (hasKey(i)) maxData = i;
  // End of the first contiguous run of recipe rows from the top. If it stops
  // short of the last recipe row, there's a gap followed by more recipe-shaped
  // rows — a separate table — and we must not blindly append.
  let runEnd = 0;
  for (let i = 1; i < values.length && hasKey(i); i++) runEnd = i;
  return {
    lastDataRow: maxData + 1, // 1-based sheet row of the last recipe
    insertRow: maxData + 2, // 1-based sheet row to start writing
    contiguousOk: runEnd === maxData,
  };
}
