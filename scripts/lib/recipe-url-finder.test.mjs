import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isReputableDomain,
  isAllowedPaywall,
  reputationTier,
  TIER,
} from "./trusted-sites.mjs";
import {
  parseHttpsUrl,
  isFetchableUrl,
  sanitizeUrlForSheet,
  isPrivateHost,
} from "./url-safety.mjs";
import {
  normalize,
  nameMatchStrength,
  softContains,
  scoreCandidate,
  pickBest,
} from "./matching.mjs";

// --- trusted-sites (reputation map) --------------------------------------

test("reputable map matches sites and sub-domains, rejects everything else", () => {
  assert.equal(isReputableDomain("epicurious.com"), true);
  assert.equal(isReputableDomain("www.epicurious.com"), true);
  assert.equal(isReputableDomain("cooking.nytimes.com"), true);
  assert.equal(isReputableDomain("pbs.org"), true); // newly added
  assert.equal(isReputableDomain("evil.com"), false);
  // suffix look-alike must not pass
  assert.equal(isReputableDomain("notepicurious.com"), false);
  assert.equal(isReputableDomain("epicurious.com.evil.com"), false);
});

test("only subscribed sites count as allowed paywalls", () => {
  assert.equal(isAllowedPaywall("cooking.nytimes.com"), true);
  assert.equal(isAllowedPaywall("www.nytimes.com"), true);
  assert.equal(isAllowedPaywall("americastestkitchen.com"), true);
  assert.equal(isAllowedPaywall("epicurious.com"), true);
  assert.equal(isAllowedPaywall("seriouseats.com"), false);
  assert.equal(isAllowedPaywall("foodnetwork.com"), false);
});

test("reputation tiers", () => {
  assert.equal(reputationTier("cooking.nytimes.com"), TIER.TOP);
  assert.equal(reputationTier("pbs.org"), TIER.STRONG);
  assert.equal(reputationTier("saltfatacidheat.com"), TIER.GOOD);
  assert.equal(reputationTier("budgetbytes.com"), TIER.GOOD);
  assert.equal(reputationTier("evil.com"), 0);
});

// --- url-safety ----------------------------------------------------------

test("parseHttpsUrl accepts only safe public https URLs", () => {
  assert.ok(parseHttpsUrl("https://www.epicurious.com/recipes/food/views/x"));
  assert.equal(parseHttpsUrl("http://epicurious.com"), null); // not https
  assert.equal(parseHttpsUrl("javascript:alert(1)"), null);
  assert.equal(parseHttpsUrl("data:text/html,hi"), null);
  assert.equal(parseHttpsUrl("https://user:pass@epicurious.com"), null); // creds
  assert.equal(parseHttpsUrl("https://epicurious.com:8080"), null); // odd port
  assert.equal(parseHttpsUrl("https://127.0.0.1/x"), null); // IP literal
  assert.equal(parseHttpsUrl("https://[::1]/x"), null); // IPv6 literal
  assert.equal(parseHttpsUrl("https://localhost/x"), null); // private host
});

test("isFetchableUrl checks https-safety only (any public host)", () => {
  assert.equal(isFetchableUrl("https://www.seriouseats.com/recipe"), true);
  assert.equal(isFetchableUrl("https://some-random-blog.example/recipe"), true);
  assert.equal(isFetchableUrl("http://www.seriouseats.com/recipe"), false); // not https
  assert.equal(isFetchableUrl("https://127.0.0.1/x"), false); // private/IP
  assert.equal(isFetchableUrl("https://localhost/x"), false);
});

test("sanitizeUrlForSheet returns a clean safe URL or null", () => {
  assert.equal(
    sanitizeUrlForSheet("https://food52.com/recipes/1-x#comments"),
    "https://food52.com/recipes/1-x",
  );
  // safety-only: a non-reputable but safe https URL is allowed through here
  // (reputation is enforced separately, when deciding what to write).
  assert.equal(sanitizeUrlForSheet("https://some-blog.example/x"), "https://some-blog.example/x");
  assert.equal(sanitizeUrlForSheet("http://food52.com/x"), null); // not https
  assert.equal(sanitizeUrlForSheet("https://127.0.0.1/x"), null); // private
  assert.equal(sanitizeUrlForSheet("=HYPERLINK(1)"), null);
});

test("isPrivateHost blocks loopback/private/metadata ranges", () => {
  assert.equal(isPrivateHost("localhost"), true);
  assert.equal(isPrivateHost("127.0.0.1"), true);
  assert.equal(isPrivateHost("10.0.0.5"), true);
  assert.equal(isPrivateHost("192.168.1.1"), true);
  assert.equal(isPrivateHost("169.254.169.254"), true); // cloud metadata
  assert.equal(isPrivateHost("172.16.0.1"), true);
  assert.equal(isPrivateHost("example.com"), false);
});

// --- matching ------------------------------------------------------------

test("normalize folds accents and punctuation", () => {
  assert.equal(normalize("Pâté de Campagne!"), "pate de campagne");
});

test("nameMatchStrength is strict about partial names", () => {
  assert.equal(
    nameMatchStrength("The Best Chicken Noodle Soup Recipe", "Chicken Noodle Soup"),
    "exact",
  );
  // missing a distinctive word ("noodle") must not match
  assert.equal(nameMatchStrength("Chicken Soup", "Chicken Noodle Soup"), "none");
  assert.equal(
    nameMatchStrength("Country Pâté (Pâté de Campagne)", "Pate de Campagne"),
    "exact",
  );
  assert.equal(nameMatchStrength("Beef Stew", "Chicken Noodle Soup"), "none");
});

test("softContains finds an author surname in a credit line", () => {
  assert.equal(softContains("Adapted from Soup Book by Joe Smith", "Joe Smith"), true);
  assert.equal(softContains("A generic page", "Joe Smith"), false);
});

test("scoreCandidate: reputable-only write policy", () => {
  const base = { contentVerified: true, structuredRecipe: false };
  const q = (host, sig, opts) => scoreCandidate(host, { ...base, ...sig }, opts).qualifies;

  // Must always be a direct match (name AND book-or-author).
  assert.equal(q("epicurious.com", { name: "exact", book: false, author: false }), false);
  assert.equal(q("epicurious.com", { name: "none", book: true, author: true }), false);

  // Reputable site + direct match → writes.
  assert.equal(q("epicurious.com", { name: "exact", book: true, author: false }), true);
  assert.equal(q("pbs.org", { name: "exact", book: false, author: true }), true);

  // Unknown site: a weak (name+author only) match is skipped...
  assert.equal(q("some-blog.example", { name: "exact", book: false, author: true }), false);
  // ...but a strong name+book+author match qualifies anywhere.
  assert.equal(q("some-blog.example", { name: "exact", book: true, author: true }), true);

  // acceptAny loosens to any safe direct match.
  assert.equal(
    q("some-blog.example", { name: "exact", book: false, author: true }, { acceptAny: true }),
    true,
  );
});

test("pickBest prefers strongest signals, then reputation", () => {
  const a = { url: "a", score: 9, reputation: TIER.STRONG, signalScore: 4, qualifies: true };
  const b = { url: "b", score: 11, reputation: TIER.GOOD, signalScore: 5, qualifies: true };
  assert.equal(pickBest([a, b]).url, "b"); // higher score wins

  const c = { url: "c", score: 10, reputation: TIER.TOP, signalScore: 4, qualifies: true };
  const d = { url: "d", score: 10, reputation: TIER.GOOD, signalScore: 4, qualifies: true };
  assert.equal(pickBest([c, d]).url, "c"); // tie on score → reputation

  assert.equal(pickBest([{ url: "x", qualifies: false, score: 99 }]), null);
});
