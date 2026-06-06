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
  /** 1-based row number in the source sheet (for write-back). */
  row?: number;
  /** Cuisine, if a pre-tagged data/cuisines.json is present. */
  cuisine?: string;
}

/** Structured interpretation of a natural-language query. */
export interface QuerySpec {
  categories: string[];
  ingredients: string[];
  excludeIngredients: string[];
  triedTags: string[];
  books: string[];
  authors: string[];
  keywords: string[];
  cuisines: string[];
  untriedOnly: boolean;
  triedOnly: boolean;
  hasLink: boolean;
}

/** Hard filters coming from explicit UI controls (always AND-applied). */
export interface UiFilters {
  categories?: string[];
  ingredients?: string[];
  triedTags?: string[];
  books?: string[];
  authors?: string[];
  excludeIngredients?: string[];
  cuisines?: string[];
  untriedOnly?: boolean;
  hasLink?: boolean;
}

export interface SearchResult {
  recipe: Recipe;
  reason: string;
}

export interface SearchResponse {
  results: SearchResult[];
  spec: QuerySpec | null;
  aiPowered: boolean;
  totalRecipes: number;
  note?: string;
}

export interface MenuCourse {
  course: string;
  recipe: Recipe;
  reason: string;
}

export interface MenuResponse {
  menu: MenuCourse[];
  aiPowered: boolean;
  totalRecipes: number;
  note?: string;
}

export interface MetaResponse {
  totalRecipes: number;
  books: string[];
  authors: string[];
  cuisines: string[];
  features: {
    ai: boolean;
    cuisine: boolean;
    writeback: boolean;
  };
}
