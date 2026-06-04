export interface Recipe {
  id: number;
  book: string;
  author: string;
  chapter: string;
  name: string;
  page: string;
  category: string;
  ingredients: string[];
  link: string;
  triedTag: string;
  notes: string;
}

/** Structured interpretation of a natural-language query. */
export interface QuerySpec {
  /** Subset of the controlled CATEGORIES vocabulary. */
  categories: string[];
  /** Subset of the controlled INGREDIENTS vocabulary (main ingredient / protein). */
  ingredients: string[];
  /** Ingredients the result must NOT contain. */
  excludeIngredients: string[];
  /** Subset of the controlled TRIED_TAGS vocabulary. */
  triedTags: string[];
  /** Free-text book-title fragments to match. */
  books: string[];
  /** Free-text author fragments to match. */
  authors: string[];
  /** Specific food words to look for in recipe names (e.g. "eggplant", "pasta"). */
  keywords: string[];
  /** Cuisines/regions implied by the query (e.g. "Italian", "Thai"). */
  cuisines: string[];
  /** Only recipes the user has NOT tried yet (no Tried tag). */
  untriedOnly: boolean;
  /** Only recipes the user HAS tried (has a Tried tag). */
  triedOnly: boolean;
  /** Only recipes that have a recipe link. */
  hasLink: boolean;
}

/** Hard filters coming from explicit UI dropdowns (always AND-applied). */
export interface UiFilters {
  categories?: string[];
  ingredients?: string[];
  triedTags?: string[];
}

export interface SearchResult {
  recipe: Recipe;
  /** Short, human-readable explanation of why this recipe matched. */
  reason: string;
}

export interface SearchResponse {
  results: SearchResult[];
  /** How the query was interpreted (null in pure keyword-fallback mode). */
  spec: QuerySpec | null;
  /** Whether Claude-powered understanding was used (vs. keyword fallback). */
  aiPowered: boolean;
  /** Total recipes in the catalogue. */
  totalRecipes: number;
  /** Non-fatal note to surface to the user, if any. */
  note?: string;
}
