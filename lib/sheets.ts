import { SignJWT, importPKCS8 } from "jose";
import { canonicalUrlForMatch } from "@/scripts/lib/url-safety.mjs";

// Optional Google Sheets write-back. Activates only when a service account is
// configured. Reads stay on the public CSV; only writes use this path.
//
// Required env:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  - the service account's email
//   GOOGLE_PRIVATE_KEY            - its PEM private key (literal \n allowed)
//   SHEET_ID                      - the spreadsheet ID (from its URL)
//   SHEET_TAB_NAME               - the recipe tab's name (e.g. "Sheet1")
// The sheet must be shared with the service account email as an Editor.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export function writeEnabled(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      process.env.GOOGLE_PRIVATE_KEY &&
      process.env.SHEET_ID &&
      process.env.SHEET_TAB_NAME,
  );
}

export function columnLetter(index0: number): string {
  let s = "";
  let n = index0 + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

let cachedToken: { token: string; exp: number } | null = null;

/**
 * Robustly normalize the GOOGLE_PRIVATE_KEY env var into a real PKCS#8 PEM.
 * Handles every common copy/paste mishap from a service-account JSON file.
 */
function normalizePrivateKey(raw: string): string {
  let pem = raw.trim();
  // Strip surrounding double or single quotes if accidentally included.
  if (
    (pem.startsWith('"') && pem.endsWith('"')) ||
    (pem.startsWith("'") && pem.endsWith("'"))
  ) {
    pem = pem.slice(1, -1).trim();
  }
  // Convert escaped sequences to real characters (handles the JSON-string form
  // "\\n" as well as a single backslash-n), then normalize CRLF to LF.
  pem = pem.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
  return pem;
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  const pem = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY!);

  if (!/-----BEGIN PRIVATE KEY-----/.test(pem) || !/-----END PRIVATE KEY-----/.test(pem)) {
    throw new Error(
      "GOOGLE_PRIVATE_KEY is malformed: missing BEGIN/END PRIVATE KEY lines. " +
        "Paste the entire private_key value from your service-account JSON file.",
    );
  }

  let key;
  try {
    key = await importPKCS8(pem, "RS256");
  } catch {
    throw new Error(
      "GOOGLE_PRIVATE_KEY could not be parsed. In Vercel, paste the value " +
        "of the private_key field from your service-account JSON file (no surrounding quotes).",
    );
  }

  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(email)
    .setSubject(email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Google auth failed (HTTP ${res.status}).`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, exp: now + (json.expires_in ?? 3600) };
  return json.access_token;
}

function range(a1: string): string {
  const tab = process.env.SHEET_TAB_NAME!;
  return encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${a1}`);
}

async function readCell(token: string, a1: string): Promise<string> {
  const id = process.env.SHEET_ID!;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range(a1)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Sheet read failed (HTTP ${res.status}).`);
  const json = (await res.json()) as { values?: string[][] };
  return json.values?.[0]?.[0] ?? "";
}

/** Read one whole column; index 0 is row 1. Trailing empty rows are omitted. */
async function readColumnValues(token: string, a1: string): Promise<string[]> {
  const id = process.env.SHEET_ID!;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range(a1)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Sheet read failed (HTTP ${res.status}).`);
  const json = (await res.json()) as { values?: string[][] };
  return (json.values ?? []).map((r) => r?.[0] ?? "");
}

async function writeCell(token: string, a1: string, value: string): Promise<void> {
  const id = process.env.SHEET_ID!;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range(a1)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [[value]] }),
    },
  );
  if (!res.ok) throw new Error(`Sheet write failed (HTTP ${res.status}).`);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

const ROW_MISMATCH_ERROR =
  "Safety check failed: the sheet row no longer matches this recipe. Refresh and try again.";

/**
 * Resolve which live-sheet row to write to for `expectedName`.
 *
 * The catalogue is read from a cached CSV snapshot, so the `preferredRow` we
 * derived from it can drift out of sync with the live sheet when rows are
 * inserted, deleted, or reordered. Rather than blindly write (which could clobber
 * the wrong recipe) or always refuse (which strands the user — a browser refresh
 * only re-serves the same cached rows), we re-check against the live sheet:
 *
 *   1. If `preferredRow` still holds this recipe, use it (the common case).
 *   2. Otherwise relocate by scanning the name column. If exactly one row matches,
 *      use it — that row *is* this recipe, so the write is still safe.
 *   3. If zero or multiple rows match, we can't disambiguate, so refuse.
 */
async function resolveRecipeRow(
  token: string,
  nameCol: number,
  expectedName: string,
  preferredRow: number,
): Promise<number> {
  const names = await readColumnValues(
    token,
    `${columnLetter(nameCol)}1:${columnLetter(nameCol)}`,
  );
  const want = normalize(expectedName);

  // Fast path: the CSV-derived row still points at this recipe.
  if (normalize(names[preferredRow - 1] ?? "") === want) return preferredRow;

  // Drift: relocate by name, but only when the match is unambiguous. Skip row 1
  // (the header). `i` is 0-based over the column, so the sheet row is `i + 1`.
  const matches: number[] = [];
  names.forEach((n, i) => {
    if (i >= 1 && normalize(n) === want) matches.push(i + 1);
  });
  if (matches.length === 1) return matches[0];

  throw new Error(ROW_MISMATCH_ERROR);
}

/**
 * Update a single cell for a recipe, resolving the correct live-sheet row first
 * (see `resolveRecipeRow`) so a stale CSV snapshot doesn't cause the write to
 * refuse or land on the wrong recipe.
 */
export async function updateRecipeCell(params: {
  row: number;
  nameCol: number;
  expectedName: string;
  targetCol: number;
  value: string;
}): Promise<void> {
  const { row, nameCol, expectedName, targetCol, value } = params;
  const token = await getAccessToken();

  const targetRow = await resolveRecipeRow(token, nameCol, expectedName, row);

  await writeCell(token, `${columnLetter(targetCol)}${targetRow}`, value);
}

/**
 * Reject the current link for a recipe: append the rejected URL to the
 * rejected-links cell (de-duplicated, newline-separated) and clear the link
 * cell, using the same live-sheet row resolution as normal edits. The
 * rejection is recorded first, so a failure clearing the link can't lose the
 * fact that the URL was rejected.
 */
export async function rejectRecipeLink(params: {
  row: number;
  nameCol: number;
  expectedName: string;
  linkCol: number;
  rejectedCol: number;
  url: string;
}): Promise<void> {
  const { row, nameCol, expectedName, linkCol, rejectedCol, url } = params;
  const token = await getAccessToken();

  const targetRow = await resolveRecipeRow(token, nameCol, expectedName, row);

  const existingRaw = await readCell(token, `${columnLetter(rejectedCol)}${targetRow}`);
  const existing = existingRaw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const already = new Set(existing.map(canonicalUrlForMatch));
  if (!already.has(canonicalUrlForMatch(url))) existing.push(url);
  await writeCell(
    token,
    `${columnLetter(rejectedCol)}${targetRow}`,
    existing.join("\n"),
  );

  await writeCell(token, `${columnLetter(linkCol)}${targetRow}`, "");
}
