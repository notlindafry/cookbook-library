"use client";

import { useState } from "react";
import { CATEGORIES, INGREDIENTS, TRIED_TAGS } from "@/lib/vocab";
import type { SearchResponse } from "@/lib/types";

const EXAMPLES = [
  "a soup with chicken and pasta",
  "italian eggplant dishes",
  "guest-worthy desserts I haven't tried",
  "quick vegetarian salads",
  "spicy seafood mains",
];

export default function Home() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [ingredient, setIngredient] = useState("");
  const [triedTag, setTriedTag] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function runSearch(q: string) {
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          filters: {
            categories: category ? [category] : [],
            ingredients: ingredient ? [ingredient] : [],
            triedTags: triedTag ? [triedTag] : [],
          },
        }),
      });
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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    runSearch(query);
  }

  function pickExample(ex: string) {
    setQuery(ex);
    runSearch(ex);
  }

  function clearFilters() {
    setCategory("");
    setIngredient("");
    setTriedTag("");
  }

  const hasFilters = category || ingredient || triedTag;

  return (
    <div className="wrap">
      <header className="hero">
        <h1>Recipe Finder</h1>
        <p>Search your cookbook collection in plain English.</p>

        <form className="search" onSubmit={onSubmit}>
          <input
            type="text"
            placeholder="e.g. a cozy soup with chicken and pasta"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search recipes"
          />
          <button type="submit" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </form>

        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              className="chip"
              onClick={() => pickExample(ex)}
            >
              {ex}
            </button>
          ))}
        </div>

        <div className="filters">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Any category</option>
            {CATEGORIES.filter((c) => c !== "I don't know").map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={ingredient}
            onChange={(e) => setIngredient(e.target.value)}
          >
            <option value="">Any main ingredient</option>
            {INGREDIENTS.filter(
              (i) => i !== "I don't know" && i !== "N/A" && i !== "Other",
            ).map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
          <select value={triedTag} onChange={(e) => setTriedTag(e.target.value)}>
            <option value="">Any verdict</option>
            {TRIED_TAGS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {hasFilters && (
            <button type="button" className="clear" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </header>

      <main>
        {loading && (
          <div className="status">
            <span className="spinner" />
            Reading your catalogue…
          </div>
        )}

        {error && <div className="error">{error}</div>}

        {!loading && data && (
          <>
            <div className="status">
              {data.results.length > 0
                ? `${data.results.length} match${
                    data.results.length === 1 ? "" : "es"
                  } from ${data.totalRecipes.toLocaleString()} recipes${
                    data.aiPowered ? "" : " (keyword search)"
                  }`
                : ""}
            </div>

            {data.note && <div className="note">{data.note}</div>}

            {data.results.length === 0 && !data.note && (
              <div className="empty">
                No matches. Try rephrasing, or loosen your filters.
              </div>
            )}

            <div className="results">
              {data.results.map(({ recipe, reason }) => (
                <article className="card" key={recipe.id}>
                  <h3>
                    {recipe.link ? (
                      <a href={recipe.link} target="_blank" rel="noreferrer">
                        {recipe.name}
                      </a>
                    ) : (
                      recipe.name
                    )}
                  </h3>
                  <div className="meta">
                    <span className="book">{recipe.book}</span>
                    {recipe.author && <> · {recipe.author}</>}
                    {recipe.chapter && <> · {recipe.chapter}</>}
                  </div>
                  {reason && <div className="reason">{reason}</div>}
                  <div className="tags">
                    {recipe.category && (
                      <span className="tag">{recipe.category}</span>
                    )}
                    {recipe.ingredients.map((i) => (
                      <span className="tag" key={i}>
                        {i}
                      </span>
                    ))}
                    {recipe.page && (
                      <span className="tag tag-page">p. {recipe.page}</span>
                    )}
                    {recipe.triedTag && (
                      <span className="tag tag-tried">{recipe.triedTag}</span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </>
        )}

        {!loading && !data && !error && !searched && (
          <div className="empty">
            Try a search above, or tap an example to get started.
          </div>
        )}
      </main>

      <footer className="foot">
        Searches your live Google Sheet · powered by Claude
      </footer>
    </div>
  );
}
