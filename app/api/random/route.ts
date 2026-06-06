import { NextRequest, NextResponse } from "next/server";
import { getRecipes } from "@/lib/data";
import { randomPick } from "@/lib/search";
import { guard, parseFilters, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const blocked = guard(req, "random", 30, 60 * 1000);
  if (blocked) return blocked;

  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const filters = parseFilters(body.filters);
  const count = Number.isFinite(body.count) ? Number(body.count) : 5;

  try {
    const recipes = await getRecipes();
    const results = randomPick(recipes, filters, count);
    return NextResponse.json({ results, totalRecipes: recipes.length });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Something went wrong loading the catalogue.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
