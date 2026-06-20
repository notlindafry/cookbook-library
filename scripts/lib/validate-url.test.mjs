import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { validateUrl } from "./validate-url.mjs";

// Drive validateUrl with a stubbed fetch so we can exercise its decision logic
// (the security gate) deterministically, without touching the network.

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

/** Stub global.fetch to answer based on the requested URL. */
function stubFetch(routes) {
  global.fetch = async (url) => {
    for (const [match, make] of routes) {
      if (url.includes(match)) return make();
    }
    return new Response("not found", { status: 404 });
  };
}

const RECIPE = { name: "Chicken Noodle Soup", book: "Soup Book", author: "Joe Smith" };

test("rejects an unsafe (private/loopback) host without fetching", async () => {
  let called = false;
  global.fetch = async () => {
    called = true;
    return new Response("x", { status: 200 });
  };
  const r = await validateUrl("https://127.0.0.1/recipe", RECIPE);
  assert.equal(r.accepted, false);
  assert.equal(r.classification, "unsafe");
  assert.equal(called, false);
});

test("rejects a 404", async () => {
  stubFetch([["seriouseats.com", () => new Response("gone", { status: 404 })]]);
  const r = await validateUrl("https://www.seriouseats.com/x", RECIPE);
  assert.equal(r.accepted, false);
  assert.equal(r.classification, "not_found");
});

test("accepts a paywall on a SUBSCRIBED site using reported signals", async () => {
  stubFetch([
    ["cooking.nytimes.com", () => new Response("Subscribe to continue", { status: 403 })],
  ]);
  const r = await validateUrl(
    "https://cooking.nytimes.com/recipes/1-chicken-noodle-soup",
    RECIPE,
    { name: true, book: true, author: true },
  );
  assert.equal(r.accepted, true);
  assert.equal(r.classification, "paywall");
  assert.equal(r.signals.author, true);
});

test("rejects a paywall on a NON-subscribed site", async () => {
  stubFetch([
    ["foodnetwork.com", () => new Response("Subscribe to continue reading", { status: 403 })],
  ]);
  const r = await validateUrl("https://www.foodnetwork.com/x", RECIPE, {
    name: true,
    author: true,
  });
  assert.equal(r.accepted, false);
  assert.equal(r.classification, "paywall");
});

test("rejects a 200 soft-404 / placeholder page", async () => {
  stubFetch([
    [
      "seriouseats.com",
      () => new Response("<title>Page Not Found</title><body>Sorry</body>", { status: 200 }),
    ],
  ]);
  const r = await validateUrl("https://www.seriouseats.com/missing", RECIPE);
  assert.equal(r.accepted, false);
  assert.equal(r.classification, "placeholder");
});

test("accepts a real matching page and reads signals from content", async () => {
  const html = `
    <title>Chicken Noodle Soup Recipe</title>
    <script type="application/ld+json">
      {"@type":"Recipe","name":"Chicken Noodle Soup","author":{"name":"Joe Smith"}}
    </script>
    <body><h1>Chicken Noodle Soup</h1><p>Adapted from Soup Book by Joe Smith.</p></body>`;
  stubFetch([["seriouseats.com", () => new Response(html, { status: 200 })]]);
  const r = await validateUrl("https://www.seriouseats.com/chicken-noodle-soup", RECIPE);
  assert.equal(r.accepted, true);
  assert.equal(r.classification, "ok");
  assert.equal(r.signals.name, "exact");
  assert.equal(r.signals.book, true);
  assert.equal(r.signals.author, true);
  assert.equal(r.signals.structuredRecipe, true);
});

test("does not follow a redirect to a private/unsafe host (SSRF)", async () => {
  stubFetch([
    [
      "seriouseats.com",
      () =>
        new Response(null, {
          status: 301,
          headers: { Location: "https://169.254.169.254/latest/meta-data/" },
        }),
    ],
  ]);
  const r = await validateUrl("https://www.seriouseats.com/redirect", RECIPE);
  assert.equal(r.accepted, false);
  assert.equal(r.classification, "unsafe");
});

test("accepts a same-site redirect then validates the destination", async () => {
  const html = "<title>Chicken Noodle Soup</title><body>by Joe Smith</body>";
  stubFetch([
    [
      "seriouseats.com/old",
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://www.seriouseats.com/new-chicken-noodle-soup" },
        }),
    ],
    ["seriouseats.com/new", () => new Response(html, { status: 200 })],
  ]);
  const r = await validateUrl("https://www.seriouseats.com/old", RECIPE);
  assert.equal(r.accepted, true);
  assert.equal(r.classification, "ok");
  assert.equal(r.signals.author, true);
});
