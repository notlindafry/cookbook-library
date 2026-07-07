"use client";

import { useEffect, useState, useCallback } from "react";
import { CATEGORIES, INGREDIENTS, TRIED_TAGS } from "@/lib/vocab";
import type {
  Recipe,
  SearchResponse,
  MenuResponse,
  MetaResponse,
  UiFilters,
} from "@/lib/types";
import MultiSelect from "./components/MultiSelect";
import RecipeCard from "./components/RecipeCard";

const WANT_TO_MAKE = "I really want to make this";
const SHORTLIST_KEY = "cookbook.shortlist";

export default function Home() {
  const [query, setQuery] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [ingredients, setIngredients] = useState<string[]>([]);
  const [triedTags, setTriedTags] = useState<string[]>([]);
  const [books, setBooks] = useState<string[]>([]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [excludeIngredients, setExcludeIngredients] = useState<string[]>([]);
  const [cuisines, setCuisines] = useState<string[]>([]);
  const [untriedOnly, setUntriedOnly] = useState(false);
  const [hasLink, setHasLink] = useState(false);
  const [showMore, setShowMore] = useState(false);

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [menu, setMenu] = useState<MenuResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [meta, setMeta] = useState<MetaResponse | null>(null);

  // Shortlist: recipes the user has saved to compare across separate searches.
  // It lives outside the search state, so a new search never clears it, and it
  // is persisted to localStorage so it also survives reloads.
  const [shortlist, setShortlist] = useState<Recipe[]>([]);
  const [shortlistOpen, setShortlistOpen] = useState(true);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/meta");
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (res.ok) setMeta(await res.json());
      } catch {
        /* meta is optional; ignore */
      }
    })();
  }, []);

  // Load any previously saved shortlist once, on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SHORTLIST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setShortlist(parsed as Recipe[]);
      }
    } catch {
      /* corrupt or unavailable storage; start empty */
    }
    setHydrated(true);
  }, []);

  // Persist on change (but not before the initial load, or we'd clobber it).
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(SHORTLIST_KEY, JSON.stringify(shortlist));
    } catch {
      /* quota exceeded or storage disabled; ignore */
    }
  }, [shortlist, hydrated]);

  const toggleSave = useCallback((recipe: Recipe) => {
    setShortlist((prev) =>
      prev.some((r) => r.id === recipe.id)
        ? prev.filter((r) => r.id !== recipe.id)
        : [...prev, recipe],
    );
  }, []);

  const savedIds = new Set(shortlist.map((r) => r.id));

  // canWrite: server can write at all (Find link / Reject — available to guests).
  // canEdit: this user may change verdicts/notes (owner only).
  const canWrite = meta?.features.writeback ?? false;
  const canEdit = meta?.features.canEdit ?? false;

  function currentFilters(overrides?: Partial<UiFilters>): UiFilters {
    return {
      categories,
      ingredients,
      triedTags,
      books,
      authors,
      excludeIngredients,
      cuisines,
      untriedOnly,
      hasLink,
      ...overrides,
    };
  }

  const post = useCallback(async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      window.location.href = "/login";
      return null;
    }
    return res;
  }, []);

  async function doSearch(q: string, filters: UiFilters) {
    setLoading(true);
    setError(null);
    setSearched(true);
    setMenu(null);
    try {
      const res = await post("/api/search", { query: q, filters });
      if (!res) return;
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Search failed.");
        setData(null);
      } else {
        setData(json as SearchResponse);
      }
    } catch {
      setError("Could not reach the server. Please try again.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  async function doSimple(
    url: string,
    body: unknown,
    note: string,
  ) {
    setLoading(true);
    setError(null);
    setSearched(true);
    setMenu(null);
    try {
      const res = await post(url, body);
      if (!res) return;
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Request failed.");
        setData(null);
      } else {
        setData({
          results: json.results ?? [],
          spec: null,
          aiPowered: false,
          totalRecipes: json.totalRecipes ?? 0,
          note: json.results?.length ? note : "No matches. Try loosening your filters.",
        });
      }
    } catch {
      setError("Could not reach the server. Please try again.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  async function doMenu() {
    setLoading(true);
    setError(null);
    setSearched(true);
    setData(null);
    try {
      const res = await post("/api/menu", {
        query,
        filters: currentFilters(),
      });
      if (!res) return;
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Menu planning failed.");
        setMenu(null);
      } else {
        setMenu(json as MenuResponse);
      }
    } catch {
      setError("Could not reach the server. Please try again.");
      setMenu(null);
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    doSearch(query, currentFilters());
  }

  function surprise() {
    doSimple("/api/random", { filters: currentFilters(), count: 5 }, "A few picks for you 🎲");
  }

  function wantToMake() {
    setTriedTags([WANT_TO_MAKE]);
    doSearch("", currentFilters({ triedTags: [WANT_TO_MAKE] }));
  }

  function moreLikeThis(id: number) {
    doSimple("/api/similar", { id }, "Similar recipes");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetFilters() {
    // Drop every filter selection...
    setCategories([]);
    setIngredients([]);
    setTriedTags([]);
    setBooks([]);
    setAuthors([]);
    setExcludeIngredients([]);
    setCuisines([]);
    setUntriedOnly(false);
    setHasLink(false);
    // ...and return to a clean slate: clear the query and any results so the
    // reset is visible rather than leaving stale, now-unfiltered results on
    // screen. The shortlist is intentionally left alone — it lives outside the
    // search and persists across searches.
    setQuery("");
    setData(null);
    setMenu(null);
    setError(null);
    setSearched(false);
  }

  async function logout() {
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  }

  const hasFilters =
    categories.length > 0 ||
    ingredients.length > 0 ||
    triedTags.length > 0 ||
    books.length > 0 ||
    authors.length > 0 ||
    excludeIngredients.length > 0 ||
    cuisines.length > 0 ||
    untriedOnly ||
    hasLink;

  // Offer the reset whenever there's something to undo — active filters, a
  // typed query, or results already on screen — so it's reachable right after
  // a search, not only once a filter chip happens to be set.
  const canReset = hasFilters || query.trim().length > 0 || searched;

  const cuisineAvailable = meta?.features.cuisine ?? false;

  return (
    <div className="wrap">
      <header className="hero">
        <h1>Linda&apos;s Cookbook Library</h1>
        <p>Search Linda&apos;s cookbook collection in plain English.</p>

        <form className="search" onSubmit={onSubmit}>
          <input
            type="text"
            placeholder="e.g. a cozy soup with chicken and pasta, or 4 course Persian dinner with eggplant"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search recipes"
          />
          <button type="submit" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </form>

        <div className="actions">
          <button type="button" className="action" onClick={doMenu} disabled={loading}>
            🍽 Plan a menu
          </button>
          <button type="button" className="action" onClick={surprise} disabled={loading}>
            🎲 Surprise me
          </button>
          <button type="button" className="action" onClick={wantToMake} disabled={loading}>
            ★ Want to make
          </button>
        </div>

        <div className="filters">
          <MultiSelect
            label="Any category"
            options={CATEGORIES.filter((c) => c !== "I don't know")}
            selected={categories}
            onChange={setCategories}
          />
          <MultiSelect
            label="Any main ingredient"
            options={INGREDIENTS.filter(
              (i) => i !== "I don't know" && i !== "N/A" && i !== "Other",
            )}
            selected={ingredients}
            onChange={setIngredients}
          />
          <MultiSelect
            label="Any verdict"
            options={TRIED_TAGS}
            selected={triedTags}
            onChange={setTriedTags}
          />
          <button
            type="button"
            className="clear"
            onClick={() => setShowMore((s) => !s)}
          >
            {showMore ? "Fewer filters" : "More filters"}
          </button>
          {canReset && (
            <button type="button" className="clear" onClick={resetFilters}>
              Reset filters
            </button>
          )}
        </div>

        {showMore && (
          <div className="filters filters-more">
            <MultiSelect
              label="Any book"
              options={meta?.books ?? []}
              selected={books}
              onChange={setBooks}
            />
            <MultiSelect
              label="Any author"
              options={meta?.authors ?? []}
              selected={authors}
              onChange={setAuthors}
            />
            <MultiSelect
              label="Exclude ingredient"
              options={INGREDIENTS.filter(
                (i) => i !== "I don't know" && i !== "N/A" && i !== "Other",
              )}
              selected={excludeIngredients}
              onChange={setExcludeIngredients}
            />
            {cuisineAvailable && (
              <MultiSelect
                label="Any cuisine"
                options={meta?.cuisines ?? []}
                selected={cuisines}
                onChange={setCuisines}
              />
            )}
            <label className="toggle">
              <input
                type="checkbox"
                checked={untriedOnly}
                onChange={(e) => setUntriedOnly(e.target.checked)}
              />
              Not tried yet
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={hasLink}
                onChange={(e) => setHasLink(e.target.checked)}
              />
              Has a link
            </label>
          </div>
        )}
      </header>

      <main>
        {shortlist.length > 0 && (
          <section className="shortlist">
            <div className="shortlist-head">
              <button
                type="button"
                className="shortlist-toggle"
                aria-expanded={shortlistOpen}
                onClick={() => setShortlistOpen((o) => !o)}
              >
                <span className="shortlist-caret">{shortlistOpen ? "▼" : "▶"}</span>
                ★ Your shortlist{" "}
                <span className="shortlist-count">({shortlist.length})</span>
              </button>
              <button
                type="button"
                className="shortlist-clear"
                onClick={() => setShortlist([])}
              >
                Clear
              </button>
            </div>
            {shortlistOpen && (
              <div className="results">
                {shortlist.map((recipe) => (
                  <RecipeCard
                    key={recipe.id}
                    result={{ recipe, reason: "" }}
                    canEdit={canEdit}
                    canWrite={canWrite}
                    onSimilar={moreLikeThis}
                    saved
                    onToggleSave={toggleSave}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {loading && (
          <div className="status">
            <span className="spinner" />
            Reading your catalogue…
          </div>
        )}

        {error && <div className="error">{error}</div>}

        {!loading && menu && (
          <>
            {menu.note && <div className="note">{menu.note}</div>}
            {menu.menu.length > 0 && (
              <div className="status">Your menu</div>
            )}
            <div className="results">
              {menu.menu.map((c, i) => (
                <div className="menu-course" key={`${c.recipe.id}-${i}`}>
                  <div className="course-label">{c.course}</div>
                  <RecipeCard
                    result={{ recipe: c.recipe, reason: c.reason }}
                    canEdit={canEdit}
                    canWrite={canWrite}
                    onSimilar={moreLikeThis}
                    saved={savedIds.has(c.recipe.id)}
                    onToggleSave={toggleSave}
                  />
                </div>
              ))}
            </div>
          </>
        )}

        {!loading && data && (
          <>
            <div className="status">
              {data.results.length > 0
                ? `${data.results.length} match${
                    data.results.length === 1 ? "" : "es"
                  } from ${data.totalRecipes.toLocaleString()} recipes`
                : ""}
            </div>

            {data.note && <div className="note">{data.note}</div>}

            {data.results.length === 0 && !data.note && (
              <div className="empty">
                No matches. Try rephrasing, or loosen your filters.
              </div>
            )}

            <div className="results">
              {data.results.map((result) => (
                <RecipeCard
                  key={result.recipe.id}
                  result={result}
                  canEdit={canEdit}
                  canWrite={canWrite}
                  onSimilar={moreLikeThis}
                  saved={savedIds.has(result.recipe.id)}
                  onToggleSave={toggleSave}
                />
              ))}
            </div>
          </>
        )}

        {!loading && !data && !menu && !error && !searched && (
          <div className="empty">
            Search above, plan a menu, or use the filters to get started.
          </div>
        )}
      </main>

      <footer className="foot">
        {meta ? `${meta.totalRecipes.toLocaleString()} recipes · ` : ""}
        powered by Claude
        <br />
        <button type="button" className="logout" onClick={logout}>
          Log out
        </button>
      </footer>
    </div>
  );
}
