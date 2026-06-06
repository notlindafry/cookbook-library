"use client";

import { useState } from "react";
import { CATEGORIES, INGREDIENTS, TRIED_TAGS } from "@/lib/vocab";
import type { SearchResponse } from "@/lib/types";
import MultiSelect from "./components/MultiSelect";

export default function Home() {
  const [query, setQuery] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [ingredients, setIngredients] = useState<string[]>([]);
  const [triedTags, setTriedTags] = useState<string[]>([]);
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
          filters: { categories, ingredients, triedTags },
        }),
      });
      if (res.status === 401) {
        // Session expired — send back to login.
        window.location.href = "/login";
        return;
      }
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

  function clearFilters() {
    setCategories([]);
    setIngredients([]);
    setTriedTags([]);
  }

  async function logout() {
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  }

  const hasFilters =
    categories.length > 0 || ingredients.length > 0 || triedTags.length > 0;

  return (
    <div className="wrap">
      <header className="hero">
        <h1>Linda&apos;s Cookbook Collection Search</h1>
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
            Search above, or use the filters, to get started.
          </div>
        )}
      </main>

      <footer className="foot">
        Searches your live Google Sheet · powered by Claude
        <br />
        <button type="button" className="logout" onClick={logout}>
          Log out
        </button>
      </footer>
    </div>
  );
}
