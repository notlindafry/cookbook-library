import { NextRequest, NextResponse } from "next/server";
import { getRecipes } from "@/lib/data";
import { similar } from "@/lib/search";
import { guard, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const blocked = guard(req, "similar", 60, 60 * 1000);
  if (blocked) return blocked;

  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 0) {
    return NextResponse.json({ error: "Invalid recipe id." }, { status: 400 });
  }

  try {
    const recipes = await getRecipes();
    return NextResponse.json({
      results: similar(recipes, id),
      totalRecipes: recipes.length,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Something went wrong loading the catalogue.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
