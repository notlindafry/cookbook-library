import Anthropic from "@anthropic-ai/sdk";
import type {
  Recipe,
  QuerySpec,
  UiFilters,
  SearchResult,
  SearchResponse,
  MenuCourse,
  MenuResponse,
} from "./types";
import { CATEGORIES, INGREDIENTS, TRIED_TAGS, VOCAB_GUIDE } from "./vocab";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

const MAX_CANDIDATES = 220; // forwarded to Claude for reranking
const MAX_RESULTS = 48;
const MAX_SIMILAR = 12;
const MAX_MENU_CANDIDATES_PER_COURSE = 24;

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

export function aiAvailable(): boolean {
  return Boolean(resolveApiKey());
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
// Query understanding (Claude → structured spec).
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
// Filtering & scoring (local, scales without the model).
// ---------------------------------------------------------------------------

function searchableText(r: Recipe): string {
  return [r.name, r.chapter, r.book, r.author, r.notes].join(" ").toLowerCase();
}

function eq(a: string, b: string): boolean {
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

/** Merge the AI-parsed spec with explicit UI filters (UI is authoritative per facet). */
export function effectiveSpec(parsed: QuerySpec | null, ui?: UiFilters): QuerySpec {
  const base = parsed ? { ...EMPTY_SPEC, ...parsed } : { ...EMPTY_SPEC };
  if (!ui) return base;
  return {
    ...base,
    categories: ui.categories?.length ? ui.categories : base.categories,
    triedTags: ui.triedTags?.length ? ui.triedTags : base.triedTags,
    books: ui.books?.length ? ui.books : base.books,
    authors: ui.authors?.length ? ui.authors : base.authors,
    excludeIngredients: uniq([
      ...base.excludeIngredients,
      ...(ui.excludeIngredients ?? []),
    ]),
    untriedOnly: base.untriedOnly || Boolean(ui.untriedOnly),
    hasLink: base.hasLink || Boolean(ui.hasLink),
  };
}

/** Hard filters that must all pass (AND). UI-only facets (ingredients, cuisines) read from `ui`. */
function passesHardFilters(r: Recipe, spec: QuerySpec, ui?: UiFilters): boolean {
  if (spec.categories.length && !spec.categories.some((c) => eq(c, r.category)))
    return false;
  if (spec.triedTags.length && !spec.triedTags.some((t) => eq(t, r.triedTag)))
    return false;
  if (spec.untriedOnly && r.triedTag) return false;
  if (spec.triedOnly && !r.triedTag) return false;
  if (spec.hasLink && !r.link) return false;
  if (
    spec.books.length &&
    !spec.books.some((b) => r.book.toLowerCase().includes(b.toLowerCase()))
  )
    return false;
  if (
    spec.authors.length &&
    !spec.authors.some((a) => r.author.toLowerCase().includes(a.toLowerCase()))
  )
    return false;
  if (
    spec.excludeIngredients.length &&
    spec.excludeIngredients.some((x) => r.ingredients.some((i) => eq(i, x)))
  )
    return false;

  const uiIngredients = ui?.ingredients ?? [];
  if (
    uiIngredients.length &&
    !uiIngredients.some((x) => r.ingredients.some((i) => eq(i, x)))
  )
    return false;

  const uiCuisines = ui?.cuisines ?? [];
  if (
    uiCuisines.length &&
    !(r.cuisine && uiCuisines.some((c) => eq(c, r.cuisine!)))
  )
    return false;

  return true;
}

/** All recipes that pass the hard filters (no scoring, no cap). */
export function hardFilter(
  recipes: Recipe[],
  spec: QuerySpec,
  ui?: UiFilters,
): Recipe[] {
  return recipes.filter((r) => passesHardFilters(r, spec, ui));
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
  const keywords = spec.keywords.map((k) => k.toLowerCase()).filter(Boolean);
  const cuisines = spec.cuisines.map((c) => c.toLowerCase()).filter(Boolean);
  const hasSoftSignal =
    keywords.length > 0 || cuisines.length > 0 || spec.ingredients.length > 0;

  const hasHardFilter =
    spec.categories.length > 0 ||
    spec.triedTags.length > 0 ||
    spec.untriedOnly ||
    spec.triedOnly ||
    spec.hasLink ||
    spec.books.length > 0 ||
    spec.authors.length > 0 ||
    (ui?.ingredients?.length ?? 0) > 0 ||
    (ui?.cuisines?.length ?? 0) > 0;

  const out: Scored[] = [];

  for (const r of recipes) {
    if (!passesHardFilters(r, spec, ui)) continue;

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
      if (r.cuisine && eq(r.cuisine, cu)) score += 3;
      else if (text.includes(cu)) score += 1;
    }

    if (hasSoftSignal && score === 0 && !hasHardFilter) continue;

    out.push({ recipe: r, score });
  }

  out.sort((a, b) => b.score - a.score || a.recipe.id - b.recipe.id);
  return out.slice(0, MAX_CANDIDATES);
}

// ---------------------------------------------------------------------------
// Reranking (Claude).
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
      { role: "user", content: `Request: ${query}\n\nCandidate recipes:\n${list}` },
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
      out.push({ recipe, reason: String(reason ?? "").slice(0, 200) });
      if (out.length >= MAX_RESULTS) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keyword fallback.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "with", "without", "for", "of", "in", "on",
  "to", "i", "want", "need", "find", "show", "me", "some", "any", "that",
  "recipe", "recipes", "dish", "dishes", "please", "make", "cook", "something",
]);

function describe(r: Recipe): string {
  return r.ingredients.length
    ? `${r.category} · ${r.ingredients.join(", ")}`
    : r.category;
}

function keywordSearch(
  recipes: Recipe[],
  query: string,
  ui?: UiFilters,
): SearchResult[] {
  const spec = effectiveSpec(null, ui);
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

  const scored: Scored[] = [];
  for (const r of recipes) {
    if (!passesHardFilters(r, spec, ui)) continue;

    const name = r.name.toLowerCase();
    const text = searchableText(r);
    const ingText = r.ingredients.join(" ").toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (name.includes(t)) score += 3;
      else if (text.includes(t)) score += 2;
      if (ingText.includes(t)) score += 1;
    }
    if (tokens.length && score === 0) continue;
    scored.push({ recipe: r, score });
  }

  scored.sort((a, b) => b.score - a.score || a.recipe.id - b.recipe.id);
  return scored.slice(0, MAX_RESULTS).map(({ recipe }) => ({
    recipe,
    reason: describe(recipe),
  }));
}

// ---------------------------------------------------------------------------
// Public: search.
// ---------------------------------------------------------------------------

export async function search(
  recipes: Recipe[],
  query: string,
  ui?: UiFilters,
): Promise<SearchResponse> {
  const trimmed = query.trim();
  const api = getClient();

  if (!trimmed) {
    return {
      results: keywordSearch(recipes, "", ui),
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
      note: "Showing basic keyword results. Add an Anthropic API key for natural-language search.",
    };
  }

  try {
    const parsed = await parseQuery(api, trimmed);
    const spec = effectiveSpec(parsed, ui);
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

// ---------------------------------------------------------------------------
// Public: surprise me (random pick from filtered set).
// ---------------------------------------------------------------------------

export function randomPick(
  recipes: Recipe[],
  ui: UiFilters | undefined,
  count: number,
): SearchResult[] {
  const pool = hardFilter(recipes, effectiveSpec(null, ui), ui);
  // Fisher–Yates partial shuffle.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, Math.max(1, Math.min(count, 12))).map((recipe) => ({
    recipe,
    reason: describe(recipe),
  }));
}

// ---------------------------------------------------------------------------
// Public: more like this (local similarity).
// ---------------------------------------------------------------------------

function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

export function similar(recipes: Recipe[], id: number): SearchResult[] {
  const target = recipes.find((r) => r.id === id);
  if (!target) return [];
  const targetTokens = nameTokens(target.name);

  const scored: { recipe: Recipe; score: number; reasons: string[] }[] = [];
  for (const r of recipes) {
    if (r.id === target.id) continue;
    let score = 0;
    const reasons: string[] = [];

    if (r.category && eq(r.category, target.category)) {
      score += 2;
      reasons.push(r.category);
    }
    const sharedIng = r.ingredients.filter((i) =>
      target.ingredients.some((t) => eq(t, i)),
    );
    if (sharedIng.length) {
      score += 2 * sharedIng.length;
      reasons.push(sharedIng.join(", "));
    }
    if (r.cuisine && target.cuisine && eq(r.cuisine, target.cuisine)) {
      score += 2;
      reasons.push(r.cuisine);
    }
    if (r.book && eq(r.book, target.book)) score += 1;
    if (r.author && eq(r.author, target.author)) score += 1;

    const tokens = nameTokens(r.name);
    let shared = 0;
    for (const t of tokens) if (targetTokens.has(t)) shared++;
    score += shared;

    if (score <= 0) continue;
    scored.push({ recipe: r, score, reasons });
  }

  scored.sort((a, b) => b.score - a.score || a.recipe.id - b.recipe.id);
  return scored.slice(0, MAX_SIMILAR).map(({ recipe, reasons }) => ({
    recipe,
    reason: reasons.length ? `Shares ${reasons.slice(0, 3).join(" · ")}` : describe(recipe),
  }));
}

// ---------------------------------------------------------------------------
// Public: plan a menu (Claude composes a multi-course menu).
// ---------------------------------------------------------------------------

const MENU_COURSES = [
  "Appetizer or snack",
  "Salad",
  "Soup or stew",
  "Main or entree",
  "Side dish",
  "Dessert",
  "Beverage",
];

const MENU_SYSTEM = `You are a thoughtful home chef composing a coherent menu from someone's personal cookbook collection.
You receive their request and a list of candidate recipes (grouped by course) with ids.
Pick a small, well-balanced menu (typically 3–5 courses) that fits the request, choosing ONLY from the given candidate ids.
Make the courses complement each other (flavors, cuisine, season, effort). For each chosen recipe give a one-line reason.
Reference recipes only by their given id. Do not invent recipes.`;

const MENU_SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    courses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          course: { type: "string" },
          id: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["course", "id", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["courses"],
  additionalProperties: false,
};

function sample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

export async function planMenu(
  recipes: Recipe[],
  request: string,
  ui?: UiFilters,
): Promise<MenuResponse> {
  const api = getClient();
  if (!api) {
    return {
      menu: [],
      aiPowered: false,
      totalRecipes: recipes.length,
      note: "Menu planning needs an Anthropic API key.",
    };
  }

  const pool = hardFilter(recipes, effectiveSpec(null, ui), ui);
  const byCourse: Recipe[] = [];
  for (const course of MENU_COURSES) {
    const inCourse = pool.filter((r) => eq(r.category, course));
    byCourse.push(...sample(inCourse, MAX_MENU_CANDIDATES_PER_COURSE));
  }
  const candidates = byCourse.length ? byCourse : sample(pool, 120);

  if (candidates.length === 0) {
    return {
      menu: [],
      aiPowered: true,
      totalRecipes: recipes.length,
      note: "No recipes available to build a menu. Try loosening your filters.",
    };
  }

  try {
    const list = candidates.map(candidateLine).join("\n");
    const res = await api.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: [
        { type: "text", text: MENU_SYSTEM, cache_control: { type: "ephemeral" } },
      ],
      tools: [
        {
          name: "emit_menu",
          description: "Record the composed menu.",
          input_schema: MENU_SCHEMA,
        },
      ],
      tool_choice: { type: "tool", name: "emit_menu" },
      messages: [
        {
          role: "user",
          content: `Request: ${request || "a balanced dinner menu"}\n\nCandidate recipes:\n${list}`,
        },
      ],
    });

    const parsed = toolInput<{
      courses: { course: string; id: number; reason: string }[];
    }>(res, "emit_menu");
    const byId = new Map(candidates.map((r) => [r.id, r]));
    const menu: MenuCourse[] = [];
    const seen = new Set<number>();
    for (const c of parsed?.courses ?? []) {
      const recipe = byId.get(c.id);
      if (recipe && !seen.has(c.id)) {
        seen.add(c.id);
        menu.push({
          course: String(c.course ?? recipe.category).slice(0, 60),
          recipe,
          reason: String(c.reason ?? "").slice(0, 200),
        });
      }
    }
    return { menu, aiPowered: true, totalRecipes: recipes.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      menu: [],
      aiPowered: false,
      totalRecipes: recipes.length,
      note: `Menu planning was unavailable (${message}).`,
    };
  }
}
