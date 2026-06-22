// Minimal Google Sheets client for the batch script: reads the whole recipe tab
// and writes found URLs back. Uses the same service account the app's write-back
// already relies on (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY / SHEET_ID
// / SHEET_TAB_NAME). Auth + private-key handling mirror lib/sheets.ts.

import { SignJWT, importPKCS8 } from "jose";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export function requireSheetEnv() {
  const missing = [
    "GOOGLE_SERVICE_ACCOUNT_EMAIL",
    "GOOGLE_PRIVATE_KEY",
    "SHEET_ID",
    "SHEET_TAB_NAME",
  ].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required env for sheet write-back: ${missing.join(", ")}. ` +
        "Configure the Google service account (see .env.example).",
    );
  }
}

export function columnLetter(index0) {
  let s = "";
  let n = index0 + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function normalizePrivateKey(raw) {
  let pem = raw.trim();
  if (
    (pem.startsWith('"') && pem.endsWith('"')) ||
    (pem.startsWith("'") && pem.endsWith("'"))
  ) {
    pem = pem.slice(1, -1).trim();
  }
  return pem.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
}

let cachedToken = null;

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const pem = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
  if (!/-----BEGIN PRIVATE KEY-----/.test(pem)) {
    throw new Error("GOOGLE_PRIVATE_KEY is malformed (missing BEGIN PRIVATE KEY).");
  }
  const key = await importPKCS8(pem, "RS256");
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(email)
    .setSubject(email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Google auth failed (HTTP ${res.status}).`);
  const json = await res.json();
  cachedToken = { token: json.access_token, exp: now + (json.expires_in ?? 3600) };
  return cachedToken.token;
}

function a1(tab, range) {
  return encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${range}`);
}

/** Read the entire recipe tab as a 2D array of strings (row 1 = header). */
export async function readSheet() {
  const token = await getAccessToken();
  const id = process.env.SHEET_ID;
  const tab = process.env.SHEET_TAB_NAME;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${a1(tab, "A1:ZZ")}` +
      `?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Sheet read failed (HTTP ${res.status}).`);
  const json = await res.json();
  return (json.values ?? []).map((row) => row.map((c) => String(c ?? "")));
}

/** Write a single header cell (used to create a dedicated column if needed). */
export async function writeHeaderCell(col0, value) {
  const token = await getAccessToken();
  const id = process.env.SHEET_ID;
  const tab = process.env.SHEET_TAB_NAME;
  const cell = `${columnLetter(col0)}1`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${a1(tab, cell)}` +
      `?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[value]] }),
    },
  );
  if (!res.ok) throw new Error(`Header write failed (HTTP ${res.status}).`);
}

/**
 * Batch-write a single column's cells. `updates` is [{ row, value }] (1-based
 * rows). Uses RAW mode so a value is always stored verbatim, never as a formula.
 */
export async function batchWriteColumn(col0, updates) {
  if (updates.length === 0) return;
  const token = await getAccessToken();
  const id = process.env.SHEET_ID;
  const tab = process.env.SHEET_TAB_NAME;
  const data = updates.map(({ row, value }) => ({
    range: decodeURIComponent(a1(tab, `${columnLetter(col0)}${row}`)),
    values: [[value]],
  }));
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "RAW", data }),
    },
  );
  if (!res.ok) throw new Error(`Sheet batch write failed (HTTP ${res.status}).`);
}

/** Read an explicit A1 range (e.g. "A5564:K5570") as a 2D array of strings. */
export async function readRange(rangeA1) {
  const token = await getAccessToken();
  const id = process.env.SHEET_ID;
  const tab = process.env.SHEET_TAB_NAME;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${a1(tab, rangeA1)}` +
      `?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Sheet read failed (HTTP ${res.status}).`);
  const json = await res.json();
  return (json.values ?? []).map((row) => row.map((c) => String(c ?? "")));
}

/**
 * Write a rectangular block of values to an explicit A1 range. RAW so values are
 * always stored verbatim, never interpreted as a formula. `rows` is a 2D array
 * (one inner array per sheet row); its shape must match the range.
 */
export async function writeRange(rangeA1, rows) {
  if (!rows.length) return;
  const token = await getAccessToken();
  const id = process.env.SHEET_ID;
  const tab = process.env.SHEET_TAB_NAME;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${a1(tab, rangeA1)}` +
      `?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows }),
    },
  );
  if (!res.ok) throw new Error(`Sheet write failed (HTTP ${res.status}).`);
}
