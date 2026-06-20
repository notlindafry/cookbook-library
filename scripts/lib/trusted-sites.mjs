// Reputation map of recognized recipe sources. This is no longer a hard search
// gate — the finder searches the whole web and validates each candidate for
// safety in code. This list serves two remaining jobs:
//
//  * Quality / precision — in "reputable-only" write mode, a match auto-fills
//    only when it's on a recognized reputable site here OR it matches the recipe
//    name AND book AND author strongly. Tiers also break ties ("most reputable").
//  * Paywall policy — see ALLOWED_PAYWALL_DOMAINS.
//
// It does NOT need to be exhaustive: a strong name+book+author match on an
// unlisted site still qualifies, and every candidate (listed or not) must pass
// the same safety validation (https-only, reachable, not a 404/placeholder, no
// SSRF) before it can be written. Add a domain to prefer it and to let weaker
// (e.g. name+author only) matches on it auto-fill.

/** Reputation tiers (higher = preferred when breaking ties between matches). */
export const TIER = { TOP: 3, STRONG: 2, GOOD: 1 };

/**
 * domain -> { name, tier }. Domains are registrable hosts; a page is considered
 * "on" a domain when its hostname equals the domain or is a sub-domain of it.
 */
export const TRUSTED_SITES = new Map([
  // --- Tier: TOP (editorially rigorous; includes the user's paid subscriptions) ---
  ["cooking.nytimes.com", { name: "NYT Cooking", tier: TIER.TOP }],
  ["nytimes.com", { name: "The New York Times", tier: TIER.TOP }],
  ["epicurious.com", { name: "Epicurious", tier: TIER.TOP }],
  ["americastestkitchen.com", { name: "America's Test Kitchen", tier: TIER.TOP }],
  ["cooksillustrated.com", { name: "Cook's Illustrated", tier: TIER.TOP }],
  ["cookscountry.com", { name: "Cook's Country", tier: TIER.TOP }],
  ["seriouseats.com", { name: "Serious Eats", tier: TIER.TOP }],
  ["bonappetit.com", { name: "Bon Appétit", tier: TIER.TOP }],
  ["food52.com", { name: "Food52", tier: TIER.TOP }],
  ["kingarthurbaking.com", { name: "King Arthur Baking", tier: TIER.TOP }],
  ["smittenkitchen.com", { name: "Smitten Kitchen", tier: TIER.TOP }],
  ["thekitchn.com", { name: "The Kitchn", tier: TIER.TOP }],

  // --- Tier: STRONG (large, reputable, professionally edited media) ---
  ["foodnetwork.com", { name: "Food Network", tier: TIER.STRONG }],
  ["foodandwine.com", { name: "Food & Wine", tier: TIER.STRONG }],
  ["simplyrecipes.com", { name: "Simply Recipes", tier: TIER.STRONG }],
  ["eatingwell.com", { name: "EatingWell", tier: TIER.STRONG }],
  ["bbcgoodfood.com", { name: "BBC Good Food", tier: TIER.STRONG }],
  ["saveur.com", { name: "Saveur", tier: TIER.STRONG }],
  ["splendidtable.org", { name: "The Splendid Table", tier: TIER.STRONG }],
  ["marthastewart.com", { name: "Martha Stewart", tier: TIER.STRONG }],
  ["allrecipes.com", { name: "Allrecipes", tier: TIER.STRONG }],
  ["delish.com", { name: "Delish", tier: TIER.STRONG }],
  ["tasteofhome.com", { name: "Taste of Home", tier: TIER.STRONG }],
  ["food.com", { name: "Food.com", tier: TIER.STRONG }],
  ["thespruceeats.com", { name: "The Spruce Eats", tier: TIER.STRONG }],
  ["pbs.org", { name: "PBS", tier: TIER.STRONG }],
  ["npr.org", { name: "NPR", tier: TIER.STRONG }],
  ["washingtonpost.com", { name: "The Washington Post", tier: TIER.STRONG }],
  ["latimes.com", { name: "Los Angeles Times", tier: TIER.STRONG }],
  ["theguardian.com", { name: "The Guardian", tier: TIER.STRONG }],
  ["bbc.co.uk", { name: "BBC", tier: TIER.STRONG }],
  ["wsj.com", { name: "The Wall Street Journal", tier: TIER.STRONG }],

  // --- Tier: GOOD (well-known author/publisher sites & established food blogs) ---
  ["saltfatacidheat.com", { name: "Salt Fat Acid Heat (Samin Nosrat)", tier: TIER.GOOD }],
  ["michaelpollan.com", { name: "Michael Pollan", tier: TIER.GOOD }],
  ["ottolenghi.co.uk", { name: "Ottolenghi", tier: TIER.GOOD }],
  ["davidlebovitz.com", { name: "David Lebovitz", tier: TIER.GOOD }],
  ["101cookbooks.com", { name: "101 Cookbooks", tier: TIER.GOOD }],
  ["cookieandkate.com", { name: "Cookie and Kate", tier: TIER.GOOD }],
  ["minimalistbaker.com", { name: "Minimalist Baker", tier: TIER.GOOD }],
  ["loveandlemons.com", { name: "Love and Lemons", tier: TIER.GOOD }],
  ["budgetbytes.com", { name: "Budget Bytes", tier: TIER.GOOD }],
  ["onceuponachef.com", { name: "Once Upon a Chef", tier: TIER.GOOD }],
  ["sallysbakingaddiction.com", { name: "Sally's Baking Addiction", tier: TIER.GOOD }],
  ["halfbakedharvest.com", { name: "Half Baked Harvest", tier: TIER.GOOD }],
  ["pinchofyum.com", { name: "Pinch of Yum", tier: TIER.GOOD }],
  ["gimmesomeoven.com", { name: "Gimme Some Oven", tier: TIER.GOOD }],
  ["ambitiouskitchen.com", { name: "Ambitious Kitchen", tier: TIER.GOOD }],
  ["thepioneerwoman.com", { name: "The Pioneer Woman", tier: TIER.GOOD }],
]);

/**
 * Domains the user holds a paid subscription to. A recipe that is reachable but
 * sits behind a login/paywall on one of these is still a valid match (the user
 * can open it); on any other site a paywall disqualifies the match.
 */
export const ALLOWED_PAYWALL_DOMAINS = new Set([
  "cooking.nytimes.com",
  "nytimes.com",
  "epicurious.com",
  "americastestkitchen.com",
  "cooksillustrated.com",
  "cookscountry.com",
]);

function normalizeHost(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
}

/** True when `hostname` equals `domain` or is a sub-domain of it. */
function hostMatchesDomain(hostname, domain) {
  const h = normalizeHost(hostname);
  return h === domain || h.endsWith(`.${domain}`);
}

/** The matching reputable-site entry for a hostname, or null. */
export function trustedSiteFor(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return null;
  for (const [domain, meta] of TRUSTED_SITES) {
    if (hostMatchesDomain(h, domain)) return { domain, ...meta };
  }
  return null;
}

/** True when the host is a recognized reputable source. */
export function isReputableDomain(hostname) {
  return trustedSiteFor(hostname) !== null;
}

export function reputationTier(hostname) {
  return trustedSiteFor(hostname)?.tier ?? 0;
}

export function isAllowedPaywall(hostname) {
  const h = normalizeHost(hostname);
  for (const domain of ALLOWED_PAYWALL_DOMAINS) {
    if (hostMatchesDomain(h, domain)) return true;
  }
  return false;
}
