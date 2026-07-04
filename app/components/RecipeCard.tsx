"use client";

import { useState } from "react";
import { TRIED_TAGS } from "@/lib/vocab";
import type { Recipe, SearchResult } from "@/lib/types";

interface Props {
  result: SearchResult;
  /** Owner-only: may change the verdict and prep notes. */
  canEdit: boolean;
  /** Server can write to the sheet: enables Find link / Reject (owner + guests). */
  canWrite: boolean;
  onSimilar: (id: number) => void;
  /** Whether this recipe is on the user's shortlist. */
  saved: boolean;
  /** Add/remove this recipe from the shortlist. */
  onToggleSave: (recipe: Recipe) => void;
}

export default function RecipeCard({
  result,
  canEdit,
  canWrite,
  onSimilar,
  saved,
  onToggleSave,
}: Props) {
  const { recipe } = result;
  // Coerce list fields to arrays: a recipe restored from an older localStorage
  // schema can be missing them, and `.map`/`.includes` on undefined would throw
  // during render — an unrecoverable crash for the whole page.
  const ingredients = recipe.ingredients ?? [];
  const [triedTags, setTriedTags] = useState<string[]>(recipe.triedTags ?? []);
  const [notes, setNotes] = useState(recipe.notes);
  const [editingNote, setEditingNote] = useState(false);
  const [draftNote, setDraftNote] = useState(recipe.notes);
  const [link, setLink] = useState(recipe.link);
  const [finding, setFinding] = useState(false);
  const [findMsg, setFindMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Verdicts not yet applied — the only ones the "Add verdict" dropdown offers.
  const availableVerdicts = TRIED_TAGS.filter((t) => !triedTags.includes(t));

  // Copy "Name — Book, p. N" to the clipboard (page/book dropped if absent), so
  // the recipe is easy to paste into notes or a message. Client-only; no server.
  async function onCopy() {
    const ref = [recipe.name, recipe.book].filter(Boolean).join(" — ");
    const text = recipe.page ? `${ref}, p. ${recipe.page}` : ref;
    try {
      await navigator.clipboard.writeText(text);
      setErr(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setErr("Couldn't copy to the clipboard.");
    }
  }

  async function save(field: "triedTag" | "notes" | "link", value: string) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/recipe/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: recipe.id, field, value }),
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return false;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json.error || "Could not save.");
        return false;
      }
      return true;
    } catch {
      setErr("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Persist the full verdict set (a recipe can carry more than one). Optimistic:
  // reverts to the previous set if the save fails.
  async function updateVerdicts(next: string[]) {
    const prev = triedTags;
    setTriedTags(next);
    const ok = await save("triedTag", next.join(", "));
    if (!ok) setTriedTags(prev);
  }

  async function onSaveNote() {
    const ok = await save("notes", draftNote);
    if (ok) {
      setNotes(draftNote);
      setEditingNote(false);
    }
  }

  // Scan trusted recipe sites for this recipe's online version and, if found,
  // write it to the sheet's link column. Bounded to one recipe per click.
  async function onFindLink() {
    setFinding(true);
    setFindMsg(null);
    setErr(null);
    try {
      const res = await fetch("/api/recipe/find-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: recipe.id }),
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json.error || "Could not find a link.");
        return;
      }
      if (json.link) setLink(json.link);
      else setFindMsg("No trusted online match found.");
    } catch {
      setErr("Could not reach the server.");
    } finally {
      setFinding(false);
    }
  }

  // Reject the proposed URL: record it to the recipe's rejected-links column so
  // it's never suggested again, then clear the link cell so the recipe can be
  // re-searched. Falls back to a plain clear if the sheet has no such column.
  async function onRejectLink() {
    setFindMsg(null);
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/recipe/reject-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: recipe.id, url: link }),
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json.error || "Could not reject the link.");
        return;
      }
      setLink("");
      setFindMsg(
        json.remembered === false
          ? "Link removed."
          : "Link removed — it won't be suggested again.",
      );
    } catch {
      setErr("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card">
      {/* Line 1: recipe title | book | page */}
      <h3>
        {recipe.name}
        <span className="card-title-meta">
          <span className="title-sep"> | </span>
          <span className="book">{recipe.book}</span>
          {recipe.page && (
            <>
              <span className="title-sep"> | </span>
              <span className="page">p. {recipe.page}</span>
            </>
          )}
        </span>
      </h3>

      {/* Line 2: author */}
      {recipe.author && <div className="meta">{recipe.author}</div>}

      {/* Supplemental info */}
      {result.reason && <div className="reason">{result.reason}</div>}

      {/* Online recipe link: shown as the raw URL, with a reject control */}
      {link && (
        <div className="card-link">
          <span aria-hidden="true">🔗</span>
          <a href={link} target="_blank" rel="noreferrer noopener">
            {link}
          </a>
          {canWrite && (
            <button
              type="button"
              className="link-btn reject-btn"
              disabled={busy}
              onClick={onRejectLink}
            >
              Reject
            </button>
          )}
        </div>
      )}

      {/* Category pills */}
      <div className="tags">
        {recipe.category && <span className="tag">{recipe.category}</span>}
        {recipe.cuisine && <span className="tag tag-cuisine">{recipe.cuisine}</span>}
        {ingredients.map((i) => (
          <span className="tag" key={i}>
            {i}
          </span>
        ))}
        {triedTags.map((t) => (
          <span className="tag tag-tried" key={t}>
            {t}
            {canEdit && (
              <button
                type="button"
                className="tag-remove"
                aria-label={`Remove verdict ${t}`}
                disabled={busy}
                onClick={() => updateVerdicts(triedTags.filter((x) => x !== t))}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>

      {notes && !editingNote && (
        <div className="card-note">
          <span className="card-note-label">📝 Linda&apos;s note</span>
          {notes}
        </div>
      )}

      {/* Actions */}
      <div className="card-actions">
        <button
          type="button"
          className={`link-btn save-btn${saved ? " is-saved" : ""}`}
          aria-pressed={saved}
          onClick={() => onToggleSave(recipe)}
        >
          {saved ? "★ Saved" : "☆ Save"}
        </button>
        <span className="action-sep">|</span>
        <button type="button" className="link-btn" onClick={() => onSimilar(recipe.id)}>
          More Like This
        </button>
        <span className="action-sep">|</span>
        <button
          type="button"
          className="link-btn"
          aria-label={`Copy ${recipe.name} reference`}
          onClick={onCopy}
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>

        {canWrite && !link && (
          <>
            <span className="action-sep">|</span>
            <button
              type="button"
              className="link-btn"
              disabled={finding}
              onClick={onFindLink}
            >
              {finding ? "Finding link…" : "🔗 Find link"}
            </button>
          </>
        )}

        {canEdit && (
          <>
            <span className="action-sep">|</span>
            <label className="verdict-edit">
              <span className="sr-only">Add verdict</span>
              <select
                value=""
                disabled={busy || availableVerdicts.length === 0}
                onChange={(e) => {
                  if (e.target.value) updateVerdicts([...triedTags, e.target.value]);
                }}
              >
                <option value="">
                  {availableVerdicts.length === 0
                    ? "All verdicts set"
                    : triedTags.length
                      ? "Add verdict…"
                      : "Set Verdict…"}
                </option>
                {availableVerdicts.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <span className="action-sep">|</span>
            {!editingNote ? (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setDraftNote(notes);
                  setEditingNote(true);
                }}
              >
                {notes ? "Edit Note" : "Add Note"}
              </button>
            ) : (
              <span className="note-editor">
                <input
                  type="text"
                  value={draftNote}
                  maxLength={500}
                  placeholder="Prep note…"
                  onChange={(e) => setDraftNote(e.target.value)}
                />
                <button
                  type="button"
                  className="link-btn"
                  disabled={busy}
                  onClick={onSaveNote}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setEditingNote(false)}
                >
                  Cancel
                </button>
              </span>
            )}
          </>
        )}
      </div>

      {findMsg && <div className="card-note">{findMsg}</div>}
      {err && <div className="card-err">{err}</div>}
    </article>
  );
}
