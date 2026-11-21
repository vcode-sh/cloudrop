// What trustedOrigins, api.checkBucket and the cloudrop command's --origin take as an origin: the exact text a browser
// sends in its Origin header. One rule for all three, so they can never disagree (M11-R111).

/**
 * `scheme://host[:port]` of an app's own scheme, such as capacitor://localhost or chrome-extension://<id>. The URL
 * standard gives such a URL an opaque origin, which serializes as "null", but WebKit and Chromium give a scheme the
 * app registered an origin like http's and send this text (M11-R41). Lowercase, as the Fetch standard writes the
 * header. "file:" stays out: a file page sends "null".
 */
const APP_ORIGIN = /^(?!file:)[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

/**
 * Of the URL standard's special schemes (ftp, file, http, https, ws, wss: https://url.spec.whatwg.org/#special-scheme)
 * a browser loads a page over these two alone. The parser gives ws://, wss:// and ftp:// URLs an origin all the same,
 * which no page has.
 */
const PAGE_SCHEME = /^https?:/;

const NOT_TEXT = 'pass a list of origins as text, such as ["https://app.example.com"].';

const EXAMPLE = "such as https://app.example.com.";

/** What is wrong with `value` as an origin and what to write instead, or null when a page can have it. */
function originFault(value: string): [wrong: string, fix: string] | null {
  // A browser never sends a pattern, so one matches no request (URL accepts "*" in a host).
  if (value.includes("*")) {
    return ["is a pattern, not an origin.", `Name each origin your pages upload from, ${EXAMPLE}`];
  }
  // "null" is the origin of a URL without one (file:, data:, an app's own scheme) and of text that is no URL.
  const origin = URL.canParse(value) ? new URL(value).origin : "null";
  if (origin === "null") {
    if (APP_ORIGIN.test(value)) return null;
    return ["is not an origin.", `Write it in lowercase as scheme://host[:port] with no path, ${EXAMPLE}`];
  }
  if (!PAGE_SCHEME.test(origin)) {
    return [
      "is not a page's origin: a page is loaded over http or https, or over an app's own scheme.",
      `Name the origin of the page that uploads, ${EXAMPLE}`,
    ];
  }
  // Naming the origin also corrects a host a browser sends differently: lowercase, and punycode for other scripts.
  if (origin === value) return null;
  return ["is not an origin.", `Use ${origin}: an origin is the scheme, host and port, with no path.`];
}

/**
 * What is wrong with `value` as an origin (M9-H100), or null when a browser can send it as a page's origin. The
 * message repeats the value unless it holds an "@": what stands before one may be a password, and the message goes to
 * a terminal or a log (M11-R115).
 */
export function originProblem(value: unknown): string | null {
  if (typeof value !== "string") return NOT_TEXT;
  const fault = originFault(value);
  if (!fault) return null;
  const [wrong, fix] = fault;
  return value.includes("@")
    ? `An origin holds no user name or password, so this one is not repeated here. ${fix}`
    : `${JSON.stringify(value)} ${wrong} ${fix}`;
}

/** Whether `origin` is text a browser can send as an origin, and so safe to echo in a log line or a report. */
export const isExactOrigin = (origin: unknown): origin is string => originProblem(origin) === null;

/** The list, when every entry is an exact origin; otherwise what is wrong with the first that is not. */
export function readOrigins(given: unknown): { origins: string[] } | { problem: string } {
  if (!Array.isArray(given)) return { problem: NOT_TEXT };
  const problem = given.map(originProblem).find((found) => found !== null);
  return problem ? { problem } : { origins: given };
}
