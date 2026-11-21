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

/** The special schemes no page is loaded over, read from text the parser refused as from an origin it gave. */
const NO_PAGE_SCHEME = /^(wss?|ftp):/i;

/** Text already written as lowercase scheme://host[:port], whatever its host and port are worth. */
const WRITTEN_AS_ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9._:[\]-]+$/;

/**
 * The hosts a browser loads a page from: an address, or a name of letters, digits, "-" and "_" in parts joined by
 * single dots, with or without a last dot. The URL standard forbids fewer characters in a host
 * (https://url.spec.whatwg.org/#forbidden-host-code-point), so its parser keeps "$", "(", ")", "&", "'", "+" and more;
 * Chromium refuses to load such a host, and one with an empty part, with ERR_INVALID_URL, so no page has it as its
 * origin (measured 2026-11-21, Chromium 159: M11-R176). Read from the parsed host, which is lowercase ASCII.
 */
const PAGE_HOST = /^([a-z0-9_-]+(\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])$/;

const NOT_TEXT = 'pass a list of origins as text, such as ["https://app.example.com"].';

const EXAMPLE = "such as https://app.example.com.";

/** What is wrong, then what to write instead. */
type Fault = [wrong: string, fix: string];

const NO_PAGE: Fault = [
  "is not a page's origin: a page is loaded over http or https, or over an app's own scheme.",
  `Name the origin of the page that uploads, ${EXAMPLE}`,
];

const NOT_ORIGIN: Fault = [
  "is not an origin.",
  `Write it in lowercase as scheme://host[:port] with no path, ${EXAMPLE}`,
];

const use = (origin: string): Fault => [
  "is not an origin.",
  `Use ${origin}: an origin is the scheme, host and port, with no path.`,
];

/**
 * Text the URL parser refuses is no origin under any scheme, an app's own included: the parser refuses a port over
 * 65535 and a host that is no name and no address, and nothing sends either (M11-R230).
 */
function unreadFault(value: string): Fault {
  if (NO_PAGE_SCHEME.test(value)) return NO_PAGE;
  return WRITTEN_AS_ORIGIN.test(value)
    ? [
        "is not an origin: its host or port is not valid.",
        "Check the host's spelling and that the port is at most 65535.",
      ]
    : NOT_ORIGIN;
}

/**
 * A URL whose origin the parser gives as "null": file:, data:, and an app's own scheme, which alone is an origin, as
 * the text the parser writes for it (a port loses its leading zeros).
 */
function appFault(value: string, url: URL): Fault | null {
  if (!APP_ORIGIN.test(value)) return NOT_ORIGIN;
  const sent = `${url.protocol}//${url.host}`;
  return sent === value ? null : use(sent);
}

/** What is wrong with `value` as an origin and what to write instead, or null when a page can have it. */
function originFault(value: string): Fault | null {
  // A browser never sends a pattern, so one matches no request (URL accepts "*" in a host).
  if (value.includes("*")) {
    return ["is a pattern, not an origin.", `Name each origin your pages upload from, ${EXAMPLE}`];
  }
  if (!URL.canParse(value)) return unreadFault(value);
  const url = new URL(value);
  const { origin } = url;
  if (origin === "null") return appFault(value, url);
  if (!PAGE_SCHEME.test(origin)) return NO_PAGE;
  // Before any correction is offered, so that no such host is named as the origin to use.
  if (!PAGE_HOST.test(url.hostname)) {
    return [
      'is not an origin: no browser loads a page from this host. A host is an address, or a name of letters, digits, "-" and "_" in parts joined by single dots.',
      `Name the origin of the page that uploads, ${EXAMPLE}`,
    ];
  }
  // Naming the origin also corrects a host a browser sends differently: lowercase, and punycode for other scripts.
  return origin === value ? null : use(origin);
}

/**
 * What is wrong with `value` as an origin (M9-H100), or null when a browser can send it as a page's origin. The
 * message repeats the value unless it holds an "@": what stands before one may be a password, and the message goes to
 * a terminal or a log (M11-R115). With `named`, the message says that in the value's place and never repeats it.
 */
export function originProblem(value: unknown, named?: string): string | null {
  if (typeof value !== "string") return NOT_TEXT;
  const fault = originFault(value);
  if (!fault) return null;
  const [wrong, fix] = fault;
  if (named !== undefined) return `${named} ${wrong} ${fix}`;
  return value.includes("@")
    ? `An origin holds no user name or password, so this one is not repeated here. ${fix}`
    : `${JSON.stringify(value)} ${wrong} ${fix}`;
}

/** Whether `origin` is text a browser can send as an origin, and so safe to echo in a log line or a report. */
export const isExactOrigin = (origin: unknown): origin is string => originProblem(origin) === null;

/** The list, when every entry is an exact origin; otherwise what is wrong with the first that is not. */
export function readOrigins(given: unknown): { origins: string[] } | { problem: string } {
  if (!Array.isArray(given)) return { problem: NOT_TEXT };
  const problem = given.map((each) => originProblem(each)).find((found) => found !== null);
  return problem ? { problem } : { origins: given };
}
