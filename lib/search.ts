import Anthropic from "@anthropic-ai/sdk";
import type {
  Recipe,
  QuerySpec,
  UiFilters,
  SearchResult,
  SearchResponse,
} from "./types";
import { CATEGORIES, INGREDIENTS, TRIED_TAGS, VOCAB_GUIDE } from "./vocab";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

// How many candidates the local pre-filter forwards to Claude for reranking.
// Keeps token usage bounded as the catalogue grows.
const MAX_CANDIDATES = 220;
// How many final results to return.
const MAX_RESULTS = 48;

/**
 * Resolve the API key from any of the commonly-used variable names, so it works
 * whether you named the secret ANTHROPIC_API_KEY (the standard) or something
 * like CLAUDE_API_KEY / claude_api_key.
 */
function resolveApiKey(): string | undefined {
  return (
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    process.env.claude_api_key ||
    undefined
  );
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const apiKey = resolveApiKey();
  if (!apiKey) return null;
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

const EMPTY_SPEC: QuerySpec = {
  categories: [],
  ingredients: [],
  excludeIngredients: [],
  triedTags: [],
  books: [],
  authors: [],
  keywords: [],
  cuisines: [],
  untriedOnly: false,
  triedOnly: false,
  hasLink: false,
};

// ---------------------------------------------------------------------------
// Stage 1 — interpret the natural-language query into a structured spec.
// ---------------------------------------------------------------------------

const PARSE_SYSTEM = `You translate a home cook's natural-language request into a structured filter for searching their personal cookbook catalogue.

${VOCAB_GUIDE}

Rules:
- Only use values from the controlled vocabularies above for "categories", "ingredients", "excludeIngredients", and "triedTags". If something doesn't map, leave those arrays empty and use "keywords"/"cuisines" instead.
- "keywords": concrete food words to look for in the recipe's NAME (e.g. eggplant, pasta, chocolate, lemon). Include the singular form. Do not put cuisines here.
- "cuisines": regional/national styles implied by the query (e.g. Italian, Thai, Mexican). Empty if none implied.
- Map proteins to "ingredients" (chicken -> Poultry, shrimp -> Fish, etc.). Map non-protein foods to "keywords" since the ingredient column usually only tracks the protein.
- "untriedOnly" if they want things they haven't made yet ("haven't tried", "new"). "triedOnly" if they want previously made dishes. "hasLink" only if they explicitly want recipes with a link.
- Be generous: prefer fewer hard constraints (categories) and more keywords/cuisines so good matches aren't excluded. When in doubt, leave a field empty.
- Return ONLY the structured object.`;

const PARSE_SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    categories: { type: "array", items: { type: "string", enum: [...CATEGORIES] } },
    ingredients: { type: "array", items: { type: "string", enum: [...INGREDIENTS] } },
    excludeIngredients: {
      type: "array",
      items: { type: "string", enum: [...INGREDIENTS] },
    },
    triedTags: { type: "array", items: { type: "string", enum: [...TRIED_TAGS] } },
    books: { type: "array", items: { type: "string" } },
    authors: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
    cuisines: { type: "array", items: { type: "string" } },
    untriedOnly: { type: "boolean" },
    triedOnly: { type: "boolean" },
    hasLink: { type: "boolean" },
  },
  required: [
    "categories",
    "ingredients",
    "excludeIngredients",
    "triedTags",
    "books",
    "authors",
    "keywords",
    "cuisines",
    "untriedOnly",
    "triedOnly",
    "hasLink",
  ],
  additionalProperties: false,
};

function toolInput<T>(res: Anthropic.Message, name: string): T | null {
  for (const block of res.content) {
    if (block.type === "tool_use" && block.name === name) {
      return block.input as T;
    }
  }
  return null;
}

async function parseQuery(api: Anthropic, query: string): Promise<QuerySpec> {
  const res = await api.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: [
      { type: "text", text: PARSE_SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    tools: [
      {
        name: "emit_filter",
        description: "Record the structured search filter for the request.",
        input_schema: PARSE_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: "emit_filter" },
    messages: [{ role: "user", content: `Request: ${query}` }],
  });

  const parsed = toolInput<Partial<QuerySpec>>(res, "emit_filter");
  return parsed ? { ...EMPTY_SPEC, ...parsed } : { ...EMPTY_SPEC };
}

// ---------------------------------------------------------------------------
// Stage 2 — local filtering + scoring (scales without touching the model).
// ---------------------------------------------------------------------------

function searchableText(r: Recipe): string {
  return [r.name, r.chapter, r.book, r.author, r.notes].join(" ").toLowerCase();
}

function eq(a: string, b: string): boolean {
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}

function mergeUiFilters(spec: QuerySpec, ui?: UiFilters): QuerySpec {
  if (!ui) return spec;
  return {
    ...spec,
    categories: ui.categories?.length ? ui.categories : spec.categories,
    // UI ingredient/tag picks are additive hard constraints handled below.
    ingredients: spec.ingredients,
    triedTags: ui.triedTags?.length ? ui.triedTags : spec.triedTags,
  };
}

interface Scored {
  recipe: Recipe;
  score: number;
}

function filterAndScore(
  recipes: Recipe[],
  spec: QuerySpec,
  ui?: UiFilters,
): Scored[] {
  const uiIngredients = ui?.ingredients ?? [];
  const keywords = spec.keywords.map((k) => k.toLowerCase()).filter(Boolean);
  const cuisines = spec.cuisines.map((c) => c.toLowerCase()).filter(Boolean);
  const hasSoftSignal =
    keywords.length > 0 || cuisines.length > 0 || spec.ingredients.length > 0;

  const out: Scored[] = [];

  for (const r of recipes) {
    // ---- Hard filters (AND) ----
    if (spec.categories.length && !spec.categories.some((c) => eq(c, r.category)))
      continue;
    if (spec.triedTags.length && !spec.triedTags.some((t) => eq(t, r.triedTag)))
      continue;
    if (spec.untriedOnly && r.triedTag) continue;
    if (spec.triedOnly && !r.triedTag) continue;
    if (spec.hasLink && !r.link) continue;
    if (
      spec.books.length &&
      !spec.books.some((b) => r.book.toLowerCase().includes(b.toLowerCase()))
    )
      continue;
    if (
      spec.authors.length &&
      !spec.authors.some((a) => r.author.toLowerCase().includes(a.toLowerCase()))
    )
      continue;
    if (
      spec.excludeIngredients.length &&
      spec.excludeIngredients.some((x) => r.ingredients.some((i) => eq(i, x)))
    )
      continue;
    // UI ingredient picks are required (every selected one must be present).
    if (
      uiIngredients.length &&
      !uiIngredients.every((x) => r.ingredients.some((i) => eq(i, x)))
    )
      continue;

    // ---- Soft scoring ----
    const name = r.name.toLowerCase();
    const text = searchableText(r);
    let score = 0;

    for (const ing of spec.ingredients) {
      if (r.ingredients.some((i) => eq(i, ing))) score += 3;
    }
    for (const kw of keywords) {
      if (name.includes(kw)) score += 3;
      else if (text.includes(kw)) score += 2;
    }
    for (const cu of cuisines) {
      if (text.includes(cu)) score += 1;
    }

    // If the query carried soft signals but nothing matched, drop it —
    // unless a hard filter (category/tag/etc.) is what defined the query.
    const hasHardFilter =
      spec.categories.length > 0 ||
      spec.triedTags.length > 0 ||
      spec.untriedOnly ||
      spec.triedOnly ||
      spec.hasLink ||
      spec.books.length > 0 ||
      spec.authors.length > 0 ||
      uiIngredients.length > 0;

    if (hasSoftSignal && score === 0 && !hasHardFilter) continue;

    out.push({ recipe: r, score });
  }

  out.sort((a, b) => b.score - a.score || a.recipe.id - b.recipe.id);
  return out.slice(0, MAX_CANDIDATES);
}

// ---------------------------------------------------------------------------
// Stage 3 — Claude reranks the candidates and explains each match.
// ---------------------------------------------------------------------------

const RERANK_SYSTEM = `You are helping a home cook find recipes from their cookbook catalogue.
Given their request and a numbered list of candidate recipes, return the recipes that genuinely match, best first.

Use real culinary knowledge: recognize cuisines from dish names (e.g. "Cacio e Pepe" and "Caprese" are Italian; "Pad Thai" is Thai), recognize ingredients implied by names, and respect every constraint in the request (dish type, ingredients, etc.).
Exclude candidates that don't truly fit. It's fine to return few results. For each kept recipe give a short reason (max ~12 words) for why it matches.
Reference recipes only by their given id.`;

const RERANK_SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["id", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

function candidateLine(r: Recipe): string {
  const ing = r.ingredients.join(", ") || "—";
  return `${r.id}: ${r.name} | ${r.book} (${r.author}) | ${r.chapter} | ${r.category} | ${ing}`;
}

async function rerank(
  api: Anthropic,
  query: string,
  candidates: Recipe[],
): Promise<SearchResult[]> {
  const list = candidates.map(candidateLine).join("\n");
  const res = await api.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: [
      { type: "text", text: RERANK_SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    tools: [
      {
        name: "emit_results",
        description: "Record the matching recipes in ranked order with reasons.",
        input_schema: RERANK_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: "emit_results" },
    messages: [
      {
        role: "user",
        content: `Request: ${query}\n\nCandidate recipes:\n${list}`,
      },
    ],
  });

  const parsed = toolInput<{ results: { id: number; reason: string }[] }>(
    res,
    "emit_results",
  );
  if (!parsed || !Array.isArray(parsed.results)) return [];

  const byId = new Map(candidates.map((r) => [r.id, r]));
  const seen = new Set<number>();
  const out: SearchResult[] = [];
  for (const { id, reason } of parsed.results) {
    const recipe = byId.get(id);
    if (recipe && !seen.has(id)) {
      seen.add(id);
      out.push({ recipe, reason });
      if (out.length >= MAX_RESULTS) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keyword fallback — used when there is no API key, or the model call fails.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "with", "without", "for", "of", "in", "on",
  "to", "i", "want", "need", "find", "show", "me", "some", "any", "that",
  "recipe", "recipes", "dish", "dishes", "please", "make", "cook", "something",
]);

function keywordSearch(
  recipes: Recipe[],
  query: string,
  ui?: UiFilters,
): SearchResult[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

  const scored: Scored[] = [];
  for (const r of recipes) {
    if (ui?.categories?.length && !ui.categories.some((c) => eq(c, r.category)))
      continue;
    if (
      ui?.triedTags?.length &&
      !ui.triedTags.some((t) => eq(t, r.triedTag))
    )
      continue;
    if (
      ui?.ingredients?.length &&
      !ui.ingredients.every((x) => r.ingredients.some((i) => eq(i, x)))
    )
      continue;

    const name = r.name.toLowerCase();
    const text = searchableText(r);
    const ingText = r.ingredients.join(" ").toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (name.includes(t)) score += 3;
      else if (text.includes(t)) score += 2;
      if (ingText.includes(t)) score += 1;
    }
    // With no search tokens (e.g. dropdown-only filtering) keep everything that
    // passed the UI filters.
    if (tokens.length && score === 0) continue;
    scored.push({ recipe: r, score });
  }

  scored.sort((a, b) => b.score - a.score || a.recipe.id - b.recipe.id);
  return scored.slice(0, MAX_RESULTS).map(({ recipe }) => ({
    recipe,
    reason: recipe.ingredients.length
      ? `${recipe.category} · ${recipe.ingredients.join(", ")}`
      : recipe.category,
  }));
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export async function search(
  recipes: Recipe[],
  query: string,
  ui?: UiFilters,
): Promise<SearchResponse> {
  const trimmed = query.trim();
  const api = getClient();

  // No query text: just apply any dropdown filters (or show nothing).
  if (!trimmed) {
    const results = keywordSearch(recipes, "", ui);
    return {
      results,
      spec: null,
      aiPowered: false,
      totalRecipes: recipes.length,
    };
  }

  if (!api) {
    return {
      results: keywordSearch(recipes, trimmed, ui),
      spec: null,
      aiPowered: false,
      totalRecipes: recipes.length,
      note: "Showing basic keyword results. Add an ANTHROPIC_API_KEY for natural-language search.",
    };
  }

  try {
    const parsed = await parseQuery(api, trimmed);
    const spec = mergeUiFilters(parsed, ui);
    const candidates = filterAndScore(recipes, spec, ui).map((s) => s.recipe);

    if (candidates.length === 0) {
      return {
        results: [],
        spec,
        aiPowered: true,
        totalRecipes: recipes.length,
        note: "No recipes matched. Try rephrasing or loosening your filters.",
      };
    }

    const results = await rerank(api, trimmed, candidates);
    return { results, spec, aiPowered: true, totalRecipes: recipes.length };
  } catch (err) {
    // Any model/parse failure: degrade to keyword search rather than erroring.
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      results: keywordSearch(recipes, trimmed, ui),
      spec: null,
      aiPowered: false,
      totalRecipes: recipes.length,
      note: `Natural-language search was unavailable (${message}); showing keyword results.`,
    };
  }
}
