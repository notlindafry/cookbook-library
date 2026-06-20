// Independent, code-side validation of a candidate URL. Nothing a model says is
// trusted here: we fetch the page ourselves (with strict limits), confirm it is
// a real, reachable recipe page — not a 404, a parked/placeholder page, or a
// paywall (except on the user's subscribed sites) — and extract our own match
// signals from the actual content. This is the gate that protects the sheet.

import { parseHttpsUrl, isFetchableUrl } from "./url-safety.mjs";
import { isAllowedPaywall } from "./trusted-sites.mjs";
import { nameMatchStrength, softContains } from "./matching.mjs";

const TIMEOUT_MS = 12_000;
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;
// A real, non-malicious browser UA. We validate pages the user can already open;
// this is so legitimate sites don't serve us a stub, not to evade controls.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const PAYWALL_MARKERS = [
  "subscribe to continue", "subscribe to read", "to continue reading",
  "this content is for subscribers", "create a free account to continue",
  "log in to view", "sign in to continue", "subscribers only",
  "become a member to", "you've reached your", "metered",
];

const PLACEHOLDER_MARKERS = [
  "page not found", "page can't be found", "page can not be found",
  "couldn't find that page", "could not find that page", "404 error",
  "error 404", "recipe not found", "no longer available", "page has moved",
  "domain is for sale", "buy this domain", "this domain is parked",
  "is for sale", "parked free", "sedoparking", "hugedomains",
];

/** Read at most MAX_BYTES of a response body as text, aborting if it overruns. */
async function readCappedText(res) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

/**
 * Fetch with SSRF/redirect guards: every hop must re-clear the safe-https check
 * (so a page can't redirect us to a private/loopback host), redirects are
 * capped, the body is size-capped, and the whole thing is time-bounded.
 * Returns { status, finalUrl, body } or throws on a network error.
 */
async function safeFetch(startUrl) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isFetchableUrl(current)) {
      return { status: 0, finalUrl: current, body: "", unsafeRedirect: true };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      });
    } finally {
      clearTimeout(timer);
    }

    // Follow redirects ourselves so we can re-validate each destination host.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { status: res.status, finalUrl: current, body: "" };
      let next;
      try {
        next = new URL(loc, current).toString();
      } catch {
        return { status: res.status, finalUrl: current, body: "" };
      }
      try { await res.body?.cancel(); } catch { /* ignore */ }
      current = next;
      continue;
    }

    // Read the body for 200 (content check) and 401/403 (paywall vs. block).
    const readBody =
      res.status === 200 || res.status === 401 || res.status === 403;
    const body = readBody ? await readCappedText(res) : "";
    return { status: res.status, finalUrl: res.url || current, body };
  }
  return { status: 0, finalUrl: current, body: "", tooManyRedirects: true };
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? htmlToText(m[1]) : "";
}

/** Pull name/author from a JSON-LD Recipe block, if the page exposes one. */
function structuredRecipe(html) {
  const blocks = html.match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  if (!blocks) return null;
  for (const raw of blocks) {
    const json = raw.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "");
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      continue;
    }
    const nodes = Array.isArray(data) ? data : [data, ...(data["@graph"] || [])];
    for (const node of nodes) {
      const t = node && node["@type"];
      const types = Array.isArray(t) ? t : [t];
      if (types.includes("Recipe")) {
        const author = node.author;
        const authorName = Array.isArray(author)
          ? author.map((a) => a?.name).filter(Boolean).join(", ")
          : author?.name || (typeof author === "string" ? author : "");
        return { name: node.name || "", author: authorName || "" };
      }
    }
  }
  return null;
}

function hasMarker(text, markers) {
  const t = text.toLowerCase();
  return markers.some((m) => t.includes(m));
}

/**
 * Validate a candidate URL against a recipe.
 *
 * @param {string} rawUrl
 * @param {{name:string, book:string, author:string}} recipe
 * @param {{name?:boolean, book?:boolean, author?:boolean}} reported - signals
 *        Claude observed in search snippets (used only when we can't read the
 *        page, e.g. behind an allowed paywall).
 * @returns {Promise<{accepted:boolean, classification:string, finalUrl:string|null,
 *                    signals:object, reason:string}>}
 */
export async function validateUrl(rawUrl, recipe, reported = {}) {
  const url = parseHttpsUrl(rawUrl);
  if (!url) {
    return reject("unsafe", null, "not a safe https URL");
  }

  let result;
  try {
    result = await safeFetch(url.toString());
  } catch (err) {
    const why = err?.name === "AbortError" ? "timed out" : "unreachable";
    return reject("error", null, why);
  }

  const { status, finalUrl, body, unsafeRedirect } = result;
  if (unsafeRedirect) return reject("unsafe", finalUrl, "redirected to an unsafe host");

  const host = (() => {
    try { return new URL(finalUrl).hostname; } catch { return url.hostname; }
  })();
  const paywallAllowed = isAllowedPaywall(host);

  // Behind a login/paywall: accept only on the user's subscribed sites, and only
  // if the search snippets already showed this is the right recipe.
  if (status === 401 || status === 403) {
    if (paywallAllowed) {
      const signals = {
        name: reported.name ? "exact" : "none",
        book: Boolean(reported.book),
        author: Boolean(reported.author),
        contentVerified: false,
        structuredRecipe: false,
      };
      return { accepted: true, classification: "paywall", finalUrl, signals,
        reason: "subscribed paywall" };
    }
    if (hasMarker(body, PAYWALL_MARKERS)) {
      return reject("paywall", finalUrl, "paywalled (no subscription)");
    }
    return reject("blocked", finalUrl, `blocked (HTTP ${status})`);
  }

  if (status === 404 || status === 410) return reject("not_found", finalUrl, "404/410");
  if (status >= 500) return reject("server_error", finalUrl, `HTTP ${status}`);
  if (status !== 200) return reject("error", finalUrl, `HTTP ${status}`);

  const text = `${titleOf(body)} \n ${htmlToText(body)}`;

  // A 200 that is really a "not found" / parked page.
  if (hasMarker(text, PLACEHOLDER_MARKERS) && nameMatchStrength(text, recipe.name) === "none") {
    return reject("placeholder", finalUrl, "soft-404 / placeholder");
  }
  // A 200 metered paywall on a site we don't subscribe to.
  if (!paywallAllowed && hasMarker(text, PAYWALL_MARKERS) &&
      nameMatchStrength(text, recipe.name) === "none") {
    return reject("paywall", finalUrl, "metered paywall (no subscription)");
  }

  const ld = structuredRecipe(body);
  const haystack = ld ? `${ld.name} ${ld.author} ${text}` : text;

  const signals = {
    name: nameMatchStrength(haystack, recipe.name),
    book: (recipe.book && softContains(haystack, recipe.book)) || Boolean(reported.book),
    author:
      (recipe.author && softContains(haystack, recipe.author)) || Boolean(reported.author),
    contentVerified: true,
    structuredRecipe: Boolean(ld),
  };

  return { accepted: true, classification: "ok", finalUrl, signals, reason: "reachable" };
}

function reject(classification, finalUrl, reason) {
  return {
    accepted: false,
    classification,
    finalUrl: finalUrl ?? null,
    signals: { name: "none", book: false, author: false, contentVerified: false, structuredRecipe: false },
    reason,
  };
}
