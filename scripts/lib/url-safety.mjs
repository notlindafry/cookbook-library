// Foundational URL-safety controls. Everything that decides whether a URL is
// allowed to be fetched or written to the sheet lives here so it can be unit
// tested in isolation. These checks run BEFORE any network request and again
// before any write — a candidate has to clear them no matter where it came from.
// Note: these enforce *safety* (https, public host, no injection), not site
// reputation — reputation is a separate, ranking/precision concern.

const MAX_URL_LEN = 2048;

// Hosts that must never be fetched, even if (somehow) on the allowlist. This is
// belt-and-suspenders SSRF defense: the trusted allowlist is all public
// domains, but we still refuse to resolve to loopback/private/link-local space
// or cloud metadata so a hijacked DNS record or redirect can't reach internals.
const PRIVATE_HOST_RE =
  /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|169\.254\.\d+\.\d+|10\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

// ASCII control characters (0x00–0x1F, 0x7F) and the space (0x20). None of
// these belong in a raw URL; their presence means something was smuggled in.
const CONTROL_OR_SPACE_RE = /[\u0000-\u0020\u007f]/;

function isIpLiteral(hostname) {
  // IPv4 dotted quad or any bracketed IPv6 literal.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

export function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  return PRIVATE_HOST_RE.test(h);
}

/**
 * Parse a string into a URL only if it is a safe, public https URL. Rejects
 * non-https schemes (no javascript:/data:/file:), embedded credentials,
 * IP-literal hosts, non-standard ports, and private/loopback hosts. Returns the
 * URL object or null.
 */
export function parseHttpsUrl(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URL_LEN) return null;
  if (CONTROL_OR_SPACE_RE.test(s)) return null;

  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  if (isIpLiteral(url.hostname)) return null;
  if (isPrivateHost(url.hostname)) return null;
  return url;
}

/**
 * A URL is safe to fetch when it parses as a public https URL. Used for the
 * initial candidate and re-checked for every redirect hop, so a page can never
 * bounce us to a private/loopback host (SSRF). Site reputation is NOT checked
 * here — that's decided later, after the page is validated.
 */
export function isFetchableUrl(raw) {
  return parseHttpsUrl(raw) !== null;
}

/**
 * Final gate before a value is written to the sheet. Returns a clean canonical
 * https URL string, or null if it isn't a safe public https URL. Guards against
 * CSV/formula injection (a stored URL can never begin with = + - @) and strips
 * any fragment so we never persist junk.
 */
export function sanitizeUrlForSheet(raw) {
  const url = parseHttpsUrl(raw);
  if (!url) return null;
  url.hash = "";
  const out = url.toString();
  if (/^[=+\-@\t\r]/.test(out)) return null; // never store something a sheet might evaluate
  return out;
}
