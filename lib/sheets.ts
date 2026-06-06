import { SignJWT, importPKCS8 } from "jose";

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

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  const pem = process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n");
  const key = await importPKCS8(pem, "RS256");

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

/**
 * Update a single cell, but only after verifying the recipe-name cell on that
 * row still matches `expectedName`. This makes a row-mapping drift fail safe
 * (it refuses) rather than overwriting the wrong recipe.
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

  const liveName = await readCell(token, `${columnLetter(nameCol)}${row}`);
  if (normalize(liveName) !== normalize(expectedName)) {
    throw new Error(
      "Safety check failed: the sheet row no longer matches this recipe. Refresh and try again.",
    );
  }

  await writeCell(token, `${columnLetter(targetCol)}${row}`, value);
}
