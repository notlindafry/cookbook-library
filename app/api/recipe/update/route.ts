import { NextRequest, NextResponse } from "next/server";
import { getRecipes, getSheetMeta, invalidateCache } from "@/lib/data";
import { writeEnabled, updateRecipeCell } from "@/lib/sheets";
import { guard, readJson, clampStr } from "@/lib/api";
import { TRIED_TAGS } from "@/lib/vocab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TAGS = new Set<string>([...TRIED_TAGS, ""]);
const MAX_NOTE_LEN = 500;

export async function POST(req: NextRequest) {
  const blocked = guard(req, "update", 20, 60 * 1000);
  if (blocked) return blocked;

  if (!writeEnabled()) {
    return NextResponse.json(
      { error: "Saving changes isn't enabled on this server." },
      { status: 503 },
    );
  }

  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const id = Number(body.id);
  const field = body.field;
  if (!Number.isInteger(id) || id < 0) {
    return NextResponse.json({ error: "Invalid recipe id." }, { status: 400 });
  }
  if (field !== "triedTag" && field !== "notes") {
    return NextResponse.json({ error: "Unsupported field." }, { status: 400 });
  }

  // Strict value validation (prevents writing arbitrary content to the sheet).
  let value: string;
  if (field === "triedTag") {
    value = clampStr(body.value, 80);
    if (!ALLOWED_TAGS.has(value)) {
      return NextResponse.json({ error: "Invalid verdict value." }, { status: 400 });
    }
  } else {
    value = clampStr(body.value, MAX_NOTE_LEN);
  }

  try {
    const [recipes, meta] = await Promise.all([getRecipes(), getSheetMeta()]);
    const recipe = recipes.find((r) => r.id === id);
    if (!recipe || !recipe.row) {
      return NextResponse.json({ error: "Recipe not found." }, { status: 404 });
    }
    if (meta.nameCol === null) {
      return NextResponse.json(
        { error: "Could not locate the recipe-name column for the safety check." },
        { status: 400 },
      );
    }
    const targetCol = field === "triedTag" ? meta.triedTagCol : meta.notesCol;
    if (targetCol === null) {
      return NextResponse.json(
        { error: `Could not locate the ${field} column in the sheet.` },
        { status: 400 },
      );
    }

    await updateRecipeCell({
      row: recipe.row,
      nameCol: meta.nameCol,
      expectedName: recipe.name,
      targetCol,
      value,
    });

    invalidateCache(); // next read reflects the change
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save the change.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
