import { NextRequest, NextResponse } from "next/server";
import { getRecipes, cuisineTaggingAvailable } from "@/lib/data";
import { aiAvailable } from "@/lib/search";
import { writeEnabled } from "@/lib/sheets";
import { guard } from "@/lib/api";
import type { MetaResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

export async function GET(req: NextRequest) {
  const blocked = guard(req, "meta", 60, 60 * 1000);
  if (blocked) return blocked;

  try {
    const recipes = await getRecipes();
    const meta: MetaResponse = {
      totalRecipes: recipes.length,
      books: sortedUnique(recipes.map((r) => r.book)),
      authors: sortedUnique(recipes.map((r) => r.author)),
      cuisines: sortedUnique(
        recipes.map((r) => r.cuisine ?? "").filter(Boolean),
      ),
      features: {
        ai: aiAvailable(),
        cuisine: cuisineTaggingAvailable,
        writeback: writeEnabled(),
      },
    };
    return NextResponse.json(meta);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Something went wrong loading the catalogue.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
