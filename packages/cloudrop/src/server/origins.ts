// What trustedOrigins and api.checkBucket take as an origin: the exact text a browser sends in its Origin header.

/**
 * `scheme://host[:port]` of an app's own scheme, such as capacitor://localhost or chrome-extension://<id>. The URL
 * standard gives such a URL an opaque origin, which serializes as "null", but WebKit and Chromium give a scheme the
 * app registered an origin like http's and send this text (M11-R41). Lowercase, as the Fetch standard writes the
 * header. "file:" stays out: a file page sends "null".
 */
const APP_ORIGIN = /^(?!file:)[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

const NOT_TEXT = 'pass a list of origins as text, such as ["https://app.example.com"].';

/** What is wrong with `value` as an origin, in the command's words (M9-H100), or null when a browser can send it. */
function originProblem(value: unknown): string | null {
  if (typeof value !== "string") return NOT_TEXT;
  const shown = JSON.stringify(value);
  // A browser never sends a pattern, so one matches no request (URL accepts "*" in a host).
  if (value.includes("*")) {
    return `${shown} is a pattern, not an origin. Name each origin your pages upload from, such as https://app.example.com.`;
  }
  // "null" is the origin of a URL without one (file:, data:, an app's own scheme) and of text that is no URL.
  const origin = URL.canParse(value) ? new URL(value).origin : "null";
  if (origin === "null" ? APP_ORIGIN.test(value) : origin === value) return null;
  // Naming the origin also corrects a host a browser sends differently: lowercase, and punycode for other scripts.
  return origin === "null"
    ? `${shown} is not an origin. Write it in lowercase as scheme://host[:port] with no path, such as https://app.example.com.`
    : `${shown} is not an origin. Use ${origin}: an origin is the scheme, host and port, with no path.`;
}

/** Whether `origin` is text a browser can send as an origin, and so safe to echo in a log line or a report. */
export const isExactOrigin = (origin: unknown): origin is string => originProblem(origin) === null;

/** The list, when every entry is an exact origin; otherwise what is wrong with the first that is not. */
export function readOrigins(given: unknown): { origins: string[] } | { problem: string } {
  if (!Array.isArray(given)) return { problem: NOT_TEXT };
  const problem = given.map(originProblem).find((found) => found !== null);
  return problem ? { problem } : { origins: given };
}
