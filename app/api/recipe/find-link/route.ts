import { NextRequest, NextResponse } from "next/server";
import { getRecipes, getSheetMeta, invalidateCache } from "@/lib/data";
import { writeEnabled, updateRecipeCell } from "@/lib/sheets";
import { aiAvailable } from "@/lib/search";
import { guard, readJson } from "@/lib/api";
import { findBestLink } from "@/scripts/lib/find-link.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One recipe can take a few web searches + validation fetches; give it room.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Web search + fetches are costly, so keep this on a tight per-IP budget.
  const blocked = guard(req, "find-link", 15, 60 * 1000);
  if (blocked) return blocked;

  if (!writeEnabled()) {
    return NextResponse.json(
      { error: "Saving links isn't enabled on this server." },
      { status: 503 },
    );
  }
  if (!aiAvailable()) {
    return NextResponse.json(
      { error: "Finding links needs an Anthropic API key." },
      { status: 503 },
    );
  }

  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 0) {
    return NextResponse.json({ error: "Invalid recipe id." }, { status: 400 });
  }

  try {
    const [recipes, meta] = await Promise.all([getRecipes(), getSheetMeta()]);
    const recipe = recipes.find((r) => r.id === id);
    if (!recipe || !recipe.row) {
      return NextResponse.json({ error: "Recipe not found." }, { status: 404 });
    }
    // Never re-query a recipe that already has a link.
    if (recipe.link) {
      return NextResponse.json({ link: recipe.link, alreadyLinked: true });
    }
    if (!recipe.book && !recipe.author) {
      return NextResponse.json(
        { error: "This recipe has no book or author to match against." },
        { status: 400 },
      );
    }
    if (meta.nameCol === null || meta.linkCol === null) {
      return NextResponse.json(
        { error: "Could not locate the recipe-name and link columns in the sheet." },
        { status: 400 },
      );
    }

    const result = await findBestLink({
      name: recipe.name,
      book: recipe.book,
      author: recipe.author,
    });
    if (result.status !== "matched" || !result.url) {
      return NextResponse.json({ link: null, status: result.status });
    }

    await updateRecipeCell({
      row: recipe.row,
      nameCol: meta.nameCol,
      expectedName: recipe.name,
      targetCol: meta.linkCol,
      value: result.url,
    });
    invalidateCache(); // next read reflects the new link

    return NextResponse.json({ link: result.url });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Safety check failed")) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("find-link error:", err);
    // This route talks to the owner's own Anthropic account behind a login gate,
    // so surfacing a trimmed error (no secrets in these messages) is far more
    // useful than an opaque 500 when diagnosing setup issues like web search.
    const { status, message } = describeError(err);
    const webSearchIssue = /web[\s_-]?search|server[\s_-]?tool|tool .*(unavailable|not)/i.test(
      message,
    );
    if (status === 401 || status === 403 || webSearchIssue) {
      return NextResponse.json(
        {
          error:
            "Link search is unavailable — likely the Anthropic API key doesn't have web search enabled. " +
            `(${status ?? "error"}: ${message})`,
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: `Could not find a link for this recipe. (${status ?? "error"}: ${message})` },
      { status: 500 },
    );
  }
}

/** Pull a safe status + short message out of an unknown (often SDK) error. */
function describeError(err: unknown): { status: number | null; message: string } {
  const status =
    typeof (err as { status?: unknown })?.status === "number"
      ? (err as { status: number }).status
      : null;
  const nested = (err as { error?: { error?: { message?: string } } })?.error?.error?.message;
  const raw = nested || (err instanceof Error ? err.message : String(err));
  return { status, message: raw.slice(0, 300) };
}
