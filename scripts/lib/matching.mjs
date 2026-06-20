// Decides whether a candidate page is a DIRECT match for a specific catalogue
// recipe — the same dish from the same book/author, not just any recipe that
// happens to share a name. Pure functions only, so the rules are unit-testable.

import { reputationTier } from "./trusted-sites.mjs";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "with", "without", "of", "in", "on", "to",
  "for", "from", "by", "recipe", "recipes", "best", "easy", "homemade",
  "classic", "perfect", "simple", "style",
]);

export function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents so "Pâté" ~ "Pate"
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contentWords(s) {
  return normalize(s)
    .split(" ")
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * How strongly `haystack` (page title + body text, or a search snippet) reflects
 * `name`: "exact" if the whole normalized name appears, "fuzzy" if most of its
 * content words appear, otherwise "none".
 */
export function nameMatchStrength(haystack, name) {
  const hay = normalize(haystack);
  const target = normalize(name);
  if (!hay || !target) return "none";
  if (hay.includes(target)) return "exact";

  const words = contentWords(name);
  if (words.length === 0) return "none";
  const hits = words.filter((w) => hay.includes(w)).length;
  const ratio = hits / words.length;
  // Require nearly all distinctive words (and at least two for multi-word names)
  // so "Chicken Noodle Soup" doesn't fuzzy-match a plain "Chicken Soup".
  if (words.length === 1) return ratio >= 1 ? "fuzzy" : "none";
  return ratio >= 0.8 && hits >= 2 ? "fuzzy" : "none";
}

/** True when any distinctive word of `needle` (e.g. an author surname) appears. */
export function softContains(haystack, needle) {
  const hay = normalize(haystack);
  if (!hay) return false;
  const words = contentWords(needle);
  if (words.length === 0) return false;
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits / words.length >= 0.5 && hits >= 1;
}

/**
 * Score a validated candidate. `signals` describes what was verified:
 *   name: "exact" | "fuzzy" | "none"
 *   book / author: boolean (the book title / author name was found)
 *   contentVerified: we read real page text (vs. a paywalled/blocked body)
 *   structuredRecipe: the page exposed a Recipe (JSON-LD) schema
 *
 * `opts.acceptAny` — if true, any safe direct match qualifies (max coverage).
 *
 * Returns { score, qualifies, ... }. A match must always be a DIRECT match
 * (recipe name AND book-or-author). In the default "reputable-only" policy it
 * additionally must be on a recognized reputable site OR match name+book+author
 * strongly (high confidence on any site).
 */
export function scoreCandidate(hostname, signals, opts = {}) {
  const directMatch = signals.name !== "none" && (signals.book || signals.author);
  const reputation = reputationTier(hostname);
  const reputable = reputation > 0;
  const strong = signals.name !== "none" && signals.book && signals.author;
  const qualifies =
    directMatch && (opts.acceptAny === true || reputable || strong);

  let signalScore = 0;
  signalScore += signals.name === "exact" ? 3 : signals.name === "fuzzy" ? 2 : 0;
  if (signals.book) signalScore += 2;
  if (signals.author) signalScore += 2;
  if (signals.contentVerified) signalScore += 1;
  if (signals.structuredRecipe) signalScore += 1;

  // Weight matching signals above reputation, but let reputation pull a strong
  // match ahead of an equally-strong one — "most reputable with the highest
  // matching signals".
  const score = signalScore * 2 + reputation;
  return { score, qualifies, signalScore, reputation };
}

/** Pick the best qualifying candidate, breaking ties by reputation then signals. */
export function pickBest(scored) {
  const eligible = scored.filter((c) => c.qualifies);
  if (eligible.length === 0) return null;
  eligible.sort(
    (a, b) =>
      b.score - a.score ||
      b.reputation - a.reputation ||
      b.signalScore - a.signalScore,
  );
  return eligible[0];
}
