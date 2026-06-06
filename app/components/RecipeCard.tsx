"use client";

import { useState } from "react";
import { TRIED_TAGS } from "@/lib/vocab";
import type { SearchResult } from "@/lib/types";

interface Props {
  result: SearchResult;
  canEdit: boolean;
  onSimilar: (id: number) => void;
}

export default function RecipeCard({ result, canEdit, onSimilar }: Props) {
  const { recipe } = result;
  const [triedTag, setTriedTag] = useState(recipe.triedTag);
  const [notes, setNotes] = useState(recipe.notes);
  const [editingNote, setEditingNote] = useState(false);
  const [draftNote, setDraftNote] = useState(recipe.notes);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(field: "triedTag" | "notes", value: string) {
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

  async function onVerdictChange(value: string) {
    const prev = triedTag;
    setTriedTag(value);
    const ok = await save("triedTag", value);
    if (!ok) setTriedTag(prev);
  }

  async function onSaveNote() {
    const ok = await save("notes", draftNote);
    if (ok) {
      setNotes(draftNote);
      setEditingNote(false);
    }
  }

  return (
    <article className="card">
      <h3>
        {recipe.link ? (
          <a href={recipe.link} target="_blank" rel="noreferrer noopener">
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
      {result.reason && <div className="reason">{result.reason}</div>}

      <div className="tags">
        {recipe.category && <span className="tag">{recipe.category}</span>}
        {recipe.cuisine && <span className="tag tag-cuisine">{recipe.cuisine}</span>}
        {recipe.ingredients.map((i) => (
          <span className="tag" key={i}>
            {i}
          </span>
        ))}
        {recipe.page && <span className="tag tag-page">p. {recipe.page}</span>}
        {triedTag && <span className="tag tag-tried">{triedTag}</span>}
      </div>

      {notes && !editingNote && <div className="card-note">📝 {notes}</div>}

      <div className="card-actions">
        <button type="button" className="link-btn" onClick={() => onSimilar(recipe.id)}>
          More like this
        </button>

        {canEdit && (
          <>
            <label className="verdict-edit">
              <span className="sr-only">Set verdict</span>
              <select
                value={triedTag}
                disabled={busy}
                onChange={(e) => onVerdictChange(e.target.value)}
              >
                <option value="">Set verdict…</option>
                {TRIED_TAGS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {!editingNote ? (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setDraftNote(notes);
                  setEditingNote(true);
                }}
              >
                {notes ? "Edit note" : "Add note"}
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

      {err && <div className="card-err">{err}</div>}
    </article>
  );
}
