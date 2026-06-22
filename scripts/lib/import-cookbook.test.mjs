import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseImportText,
  extractPage,
  cleanName,
  recipeKey,
  validateCategory,
  validateIngredients,
  formatIngredients,
  classifyHeader,
  resolveColumns,
  buildRow,
  existingKeys,
  dedupe,
  findInsertionRow,
} from "./import-cookbook.mjs";

// --- parsing --------------------------------------------------------------

test("parseImportText: directives set running context; pipe gives name+page", () => {
  const { records, warnings } = parseImportText(
    [
      "Book: Ottolenghi Simple",
      "Author: Yotam Ottolenghi",
      "Chapter: Brunch",
      "Braised eggs with leek and za'atar | 28",
      "Cumin-spiced fritters | 30",
    ].join("\n"),
  );
  assert.equal(warnings.length, 0);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    book: "Ottolenghi Simple",
    author: "Yotam Ottolenghi",
    chapter: "Brunch",
    name: "Braised eggs with leek and za'atar",
    page: "28",
  });
  assert.equal(records[1].page, "30");
});

test("parseImportText: comments and blank lines ignored; trailing page inferred", () => {
  const { records } = parseImportText(
    ["// my notes", "Book: B", "", "Tomato soup 124", "Chana masala"].join("\n"),
  );
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], { book: "B", author: "", chapter: "", name: "Tomato soup", page: "124" });
  assert.equal(records[1].name, "Chana masala");
  assert.equal(records[1].page, "");
});

test("parseImportText: a new Book resets the running chapter", () => {
  const { records } = parseImportText(
    ["Book: A", "Chapter: Soups", "Minestrone | 10", "Book: B", "Focaccia | 20"].join("\n"),
  );
  assert.equal(records[0].chapter, "Soups");
  assert.equal(records[1].book, "B");
  assert.equal(records[1].chapter, ""); // not carried over from book A
});

test("parseImportText: recipe before any Book is warned and skipped", () => {
  const { records, warnings } = parseImportText(["Orphan recipe | 5", "Book: B", "Real | 6"].join("\n"));
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "Real");
  assert.equal(warnings.length, 1);
});

test("extractPage handles ranges, 'p.' prefixes, and no page", () => {
  assert.deepEqual(extractPage("Soup 124"), { name: "Soup", page: "124" });
  assert.deepEqual(extractPage("Soup 124-126"), { name: "Soup", page: "124" });
  assert.deepEqual(extractPage("Soup, p. 28"), { name: "Soup", page: "28" });
  assert.deepEqual(extractPage("Plain name"), { name: "Plain name", page: "" });
});

test("cleanName strips dot leaders and trailing punctuation", () => {
  assert.equal(cleanName("Tomato soup ......."), "Tomato soup");
  assert.equal(cleanName("Salad,  "), "Salad");
  assert.equal(cleanName("  Spaced   out  "), "Spaced out");
});

// --- vocabulary validation ------------------------------------------------

test("validateCategory coerces to vocab (case-insensitive) or 'I don't know'", () => {
  assert.equal(validateCategory("main or entree"), "Main or entree");
  assert.equal(validateCategory("Dessert"), "Dessert");
  assert.equal(validateCategory("Entree"), "I don't know"); // not a vocab value
  assert.equal(validateCategory(""), "I don't know");
});

test("validateIngredients filters invalid, de-dupes, falls back to unknown", () => {
  assert.deepEqual(validateIngredients(["poultry", "Poultry", "wizardry"]), ["Poultry"]);
  assert.deepEqual(validateIngredients(["Fish", "Fruit or vegetable"]), ["Fish", "Fruit or vegetable"]);
  assert.deepEqual(validateIngredients([]), ["I don't know"]);
  assert.equal(formatIngredients(["Pork", "pork", "Fish"]), "Pork, Fish");
});

// --- column resolution ----------------------------------------------------

test("classifyHeader / resolveColumns match the real sheet header", () => {
  const header = [
    "Book title",
    "Author",
    "Chapter name",
    "Recipe name",
    "Page #",
    "Category",
    "Main ingredient (usually the protein)",
    "Recipe link",
    "Tried tag\n(Linda completes)",
    "Prep notes \n(Linda completes)",
    "Rejected links",
  ];
  // "Rejected links" must map to rejected, not link.
  assert.equal(classifyHeader("Rejected links"), "rejected");
  assert.equal(classifyHeader("Recipe link"), "link");
  assert.deepEqual(resolveColumns(header), {
    book: 0, author: 1, chapter: 2, name: 3, page: 4, category: 5,
    ingredient: 6, link: 7, tried: 8, notes: 9, rejected: 10,
  });
});

test("buildRow places known fields and leaves verdict/notes/link blank", () => {
  const cols = { book: 0, author: 1, chapter: 2, name: 3, page: 4, category: 5,
    ingredient: 6, link: 7, tried: 8, notes: 9, rejected: 10 };
  const rec = { book: "B", author: "A", chapter: "C", name: "N", page: "12",
    category: "Salad", ingredient: "Fish, Fruit or vegetable" };
  const row = buildRow(rec, cols, 11);
  assert.equal(row.length, 11);
  assert.deepEqual(row, ["B", "A", "C", "N", "12", "Salad", "Fish, Fruit or vegetable", "", "", "", ""]);
});

// --- dedupe + insertion ---------------------------------------------------

test("existingKeys + dedupe skip catalogued and within-batch duplicates", () => {
  const cols = { book: 0, name: 1 };
  const values = [["Book", "Name"], ["Plenty", "Soup"], ["Plenty", "Salad"]];
  const keys = existingKeys(values, cols);
  assert.ok(keys.has(recipeKey("Plenty", "Soup")));

  const records = [
    { book: "Plenty", name: "Soup" }, // already in sheet
    { book: "Plenty", name: "Bread" }, // new
    { book: "Plenty", name: "bread" }, // dup of previous (normalized)
  ];
  const { fresh, duplicates } = dedupe(records, keys);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].name, "Bread");
  assert.equal(duplicates.length, 2);
});

test("findInsertionRow: contiguous block appends right after the last recipe", () => {
  const cols = { book: 0, name: 1 };
  const values = [["Book", "Name"], ["A", "r1"], ["A", "r2"]];
  const r = findInsertionRow(values, cols);
  assert.equal(r.lastDataRow, 3);
  assert.equal(r.insertRow, 4);
  assert.equal(r.contiguousOk, true);
});

test("findInsertionRow: legend rows (name column empty) don't count as recipes", () => {
  // Real layout: book = col A (0), recipe name = col D (3). The legend tables
  // below the data fill cols A/B only, never the name column — so they're
  // ignored and we still append right after the last real recipe.
  const cols = { book: 0, name: 3 };
  const values = [
    ["Book", "", "", "Name"],
    ["A", "", "", "r1"],
    ["A", "", "", "r2"],
    ["Almost healthy", "", "", ""], // tried-tag legend: only col A
    ["Category", "example", "", ""], // category legend: cols A+B, name col empty
  ];
  const r = findInsertionRow(values, cols);
  assert.equal(r.insertRow, 4); // still right after r2
  assert.equal(r.contiguousOk, true);
});

test("findInsertionRow: a gap then more recipe-shaped rows is flagged", () => {
  const cols = { book: 0, name: 1 };
  const values = [["Book", "Name"], ["A", "r1"], ["", ""], ["B", "r3"]];
  const r = findInsertionRow(values, cols);
  assert.equal(r.contiguousOk, false);
});
