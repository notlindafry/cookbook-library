import Papa from "papaparse";
import type { Recipe } from "./types";

interface CacheEntry {
  recipes: Recipe[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

function ttlMs(): number {
  const seconds = Number(process.env.SHEET_CACHE_TTL_SECONDS ?? 300);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000;
}

/**
 * Maps a (possibly messy, newline-containing) CSV header to our internal field
 * name. Order matters: more specific rules first.
 */
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
    } else {
      (recipe[field] as string) = clean;
    }
  }

  // Skip blank rows and obvious non-data rows (legend/summary tables sometimes
  // tacked onto the same export).
  if (!recipe.name && !recipe.book) return null;
  return recipe;
}

async function fetchAndParse(url: string): Promise<Recipe[]> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch sheet CSV (HTTP ${res.status}). Check that SHEET_CSV_URL is a valid "Publish to web" CSV link.`,
    );
  }
  const text = await res.text();

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
  });

  const fields = parsed.meta.fields ?? [];
  const headerMap = new Map<string, keyof Recipe>();
  for (const f of fields) {
    const mapped = mapHeader(f);
    if (mapped) headerMap.set(f, mapped);
  }

  if (!headerMap.size) {
    throw new Error(
      "Could not recognize any columns in the sheet. Expected headers like Book title, Author, Recipe name, Category, Main ingredient.",
    );
  }

  const recipes: Recipe[] = [];
  let id = 0;
  for (const row of parsed.data) {
    const recipe = rowToRecipe(row, headerMap, id);
    if (recipe) {
      recipes.push(recipe);
      id += 1;
    }
  }
  return recipes;
}

/** Returns the catalogue, using a short-lived in-memory cache. */
export async function getRecipes(forceRefresh = false): Promise<Recipe[]> {
  const url = process.env.SHEET_CSV_URL;
  if (!url) {
    throw new Error(
      "SHEET_CSV_URL is not set. Publish your Google Sheet to the web as CSV and add the link to your environment (.env.local).",
    );
  }

  const now = Date.now();
  if (!forceRefresh && cache && now - cache.fetchedAt < ttlMs()) {
    return cache.recipes;
  }

  try {
    const recipes = await fetchAndParse(url);
    cache = { recipes, fetchedAt: now };
    return recipes;
  } catch (err) {
    // If a refresh fails but we have stale data, serve it rather than erroring.
    if (cache) return cache.recipes;
    throw err;
  }
}
