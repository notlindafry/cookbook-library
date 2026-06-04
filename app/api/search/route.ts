import { NextRequest, NextResponse } from "next/server";
import { getRecipes } from "@/lib/data";
import { search } from "@/lib/search";
import type { UiFilters } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { query?: string; filters?: UiFilters; refresh?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query : "";
  const filters = body.filters ?? {};

  try {
    const recipes = await getRecipes(Boolean(body.refresh));
    const response = await search(recipes, query, filters);
    return NextResponse.json(response);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Something went wrong loading the catalogue.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
