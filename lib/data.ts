import Papa from "papaparse";
import type { Recipe } from "./types";
import cuisineMap from "@/data/cuisines.json";

interface SheetMeta {
  /** 0-based column index of each writable/keyable field in the source sheet. */
  nameCol: number | null;
  triedTagCol: number | null;
  notesCol: number | null;
  /** Row number (1-based) of the first data row (header is assumed at row 1). */
  firstDataRow: number;
}

interface CacheEntry {
  recipes: Recipe[];
  meta: SheetMeta;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

const CUISINES = cuisineMap as Record<string, string>;
export const cuisineTaggingAvailable = Object.keys(CUISINES).length > 0;

/** Stable key linking a recipe to its pre-tagged cuisine. Must match the generator. */
export function cuisineKey(book: string, name: string): string {
  return `${book}::${name}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function ttlMs(): number {
  const seconds = Number(process.env.SHEET_CACHE_TTL_SECONDS ?? 300);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000;
}

function mapHeader(raw: string): keyof Recipe | null {
  const h = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (h.includes("book")) return "book";
  if (h.includes("author")) return "author";
  if (h.includes("chapter")) return "chapter";
  if (h.includes("recipe name") || h === "name" || h === "recipe") return "name";
  if (h.includes("page")) return "page";
  if (h.includes("category")) return "category";
  if (h.includes("main ingredient") || h === "ingredient" || h === "ingredients")
    return "ingredients";
  if (h.includes("link") || h.includes("url")) return "link";
  if (h.includes("tried")) return "triedTag";
  if (h.includes("note") || h.includes("prep")) return "notes";
  return null;
}

function rowToRecipe(
  row: Record<string, string>,
  headerMap: Map<string, keyof Recipe>,
  id: number,
  rowNumber: number,
): Recipe | null {
  const recipe: Recipe = {
    id,
    book: "",
    author: "",
    chapter: "",
    name: "",
    page: "",
    category: "",
    ingredients: [],
    link: "",
    triedTag: "",
    notes: "",
    row: rowNumber,
  };

  for (const [rawHeader, value] of Object.entries(row)) {
    const field = headerMap.get(rawHeader);
    if (!field) continue;
    const clean = (value ?? "").trim();
    if (field === "ingredients") {
      recipe.ingredients = clean
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (field !== "id" && field !== "row" && field !== "cuisine") {
      (recipe[field] as string) = clean;
    }
  }

  // Only trust http(s) links (guards against javascript:/data: URLs in a cell).
  if (recipe.link && !/^https?:\/\//i.test(recipe.link)) recipe.link = "";

  // Skip blank rows and non-data rows (legend/summary tables).
  if (!recipe.name && !recipe.book) return null;

  if (cuisineTaggingAvailable) {
    const c = CUISINES[cuisineKey(recipe.book, recipe.name)];
    if (c) recipe.cuisine = c;
  }
  return recipe;
}

async function fetchAndParse(
  url: string,
): Promise<{ recipes: Recipe[]; meta: SheetMeta }> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch sheet CSV (HTTP ${res.status}). Check that SHEET_CSV_URL is a valid published/exported CSV link.`,
    );
  }
  const text = await res.text();

  // Note: we do NOT skip empty lines, so row numbers stay aligned with the
  // source sheet (header assumed at row 1, data from row 2) for write-back.
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: false,
  });

  const fields = parsed.meta.fields ?? [];
  const headerMap = new Map<string, keyof Recipe>();
  const colIndex: Partial<Record<keyof Recipe, number>> = {};
  fields.forEach((f, i) => {
    const mapped = mapHeader(f);
    if (mapped && !headerMap.has(f) && colIndex[mapped] === undefined) {
      headerMap.set(f, mapped);
      colIndex[mapped] = i;
    }
  });

  if (!headerMap.size) {
    throw new Error(
      "Could not recognize any columns in the sheet. Expected headers like Book title, Author, Recipe name, Category, Main ingredient.",
    );
  }

  const recipes: Recipe[] = [];
  let id = 0;
  parsed.data.forEach((row, i) => {
    const recipe = rowToRecipe(row, headerMap, id, i + 2);
    if (recipe) {
      recipes.push(recipe);
      id += 1;
    }
  });

  const meta: SheetMeta = {
    nameCol: colIndex.name ?? null,
    triedTagCol: colIndex.triedTag ?? null,
    notesCol: colIndex.notes ?? null,
    firstDataRow: 2,
  };

  return { recipes, meta };
}

export async function getRecipes(forceRefresh = false): Promise<Recipe[]> {
  return (await getCatalogue(forceRefresh)).recipes;
}

export async function getSheetMeta(): Promise<SheetMeta> {
  return (await getCatalogue(false)).meta;
}

async function getCatalogue(
  forceRefresh: boolean,
): Promise<{ recipes: Recipe[]; meta: SheetMeta }> {
  const url = process.env.SHEET_CSV_URL;
  if (!url) {
    throw new Error(
      "SHEET_CSV_URL is not set. Add your published/exported Google Sheet CSV link to the environment.",
    );
  }

  const now = Date.now();
  if (!forceRefresh && cache && now - cache.fetchedAt < ttlMs()) {
    return { recipes: cache.recipes, meta: cache.meta };
  }

  try {
    const { recipes, meta } = await fetchAndParse(url);
    cache = { recipes, meta, fetchedAt: now };
    return { recipes, meta };
  } catch (err) {
    if (cache) return { recipes: cache.recipes, meta: cache.meta };
    throw err;
  }
}

/** Invalidate the in-memory cache (e.g. after a write-back). */
export function invalidateCache(): void {
  cache = null;
}
