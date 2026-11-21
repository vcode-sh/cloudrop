// contentChecks(): the declared type is judged at /upload, before anything is signed, and the content at /complete,
// from the first 4 KiB of the stored file (M10-K2). A refusal at /complete is an afterVerify refusal: the server ends
// the upload, deletes the object only when it is this upload's, and tells the plugins through onAbort.

// CloudropError comes through the published entry, so a refusal is an instance of the class the server checks for
// (M10-K5, as M9-T2 does for cloudrop/testing).
import { type AfterVerifyContext, CloudropError, type CloudropPlugin, type StorageDriver } from "../index.ts";
import { acceptsType, isAcceptEntry } from "../server/accept-entry.ts";
import { type Sniffed, sniff } from "./sniff.ts";

export interface ContentCheckOptions {
  /**
   * Types let through the default refusals: web pages, programs, scripts, and XML or SVG on a route that does not name
   * the type. The route's `accept` and the match between content and declared type still apply. Such as ["text/html"].
   */
  allow?: readonly string[];
  /** Types refused on every route, by declared type or by content; wins over `allow`. Such as ["application/zip"]. */
  deny?: readonly string[];
}

/** How much of a file is read: enough for every signature and an XML document's root element. */
const SNIFF_BYTES = 4096;
const OCTET_STREAM = "application/octet-stream";

/** Refused by default, whatever the route accepts (M10-K3). */
const REFUSED: ReadonlySet<string> = new Set([
  // Web pages, and WHATWG MIME Sniffing §7's unknown types, which a browser sniffs and may render as one.
  "text/html",
  "application/xhtml+xml",
  "unknown/unknown",
  "application/unknown",
  // A browser navigated to it renders each body part by the part's own type, text/html among them (HTML Standard
  // §7.5.5, Loading multipart/x-mixed-replace documents, and §17.2).
  "multipart/x-mixed-replace",
  // Programs: the types the sniffer gives them (sniff.ts) and their common aliases.
  "application/vnd.microsoft.portable-executable",
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-dosexec",
  "application/x-executable",
  "application/x-elf",
  "application/x-sharedlib",
  "application/x-mach-binary",
  "application/x-mach-o-executable",
  // Windows installers and HTML applications, which a browser hands to the system to run.
  "application/x-msi",
  "application/x-ms-installer",
  "application/hta",
  // Scripts: every JavaScript MIME type essence of WHATWG MIME Sniffing §4.6, shell scripts and VBScript.
  ..."application/ecmascript application/javascript application/x-ecmascript application/x-javascript".split(" "),
  ..."text/ecmascript text/javascript text/jscript text/livescript text/x-ecmascript text/x-javascript".split(" "),
  ..."text/javascript1.0 text/javascript1.1 text/javascript1.2 text/javascript1.3 text/javascript1.4".split(" "),
  "text/javascript1.5",
  ..."text/x-shellscript application/x-sh application/x-shellscript text/x-sh text/vbscript".split(" "),
]);

/** XML types (RFC 7303 §3, every "+xml" type, and text/xsl): a browser renders them, SVG with its scripts. */
const isXml = (type: string) =>
  type === "text/xml" || type === "application/xml" || type === "text/xsl" || type.endsWith("+xml");

interface Lists {
  allow: readonly string[];
  deny: readonly string[];
}

function readList(list: readonly string[] | undefined): readonly string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string" && isAcceptEntry(entry))) {
    throw new CloudropError(
      "INVALID_CONFIG",
      'contentChecks: allow and deny take lists of MIME types or wildcards, in lower case, such as ["text/html"] or ["image/*"].',
    );
  }
  return list;
}

/** Whether `type`, sent as or found in a file sent as `declared`, is refused whatever else matches. */
function isRefused(type: string, declared: string, accept: readonly string[], { allow, deny }: Lists): boolean {
  if (acceptsType(deny, type)) return true;
  if (acceptsType(allow, type)) return false;
  if (REFUSED.has(type)) return true;
  // XML and SVG pass only on a route that names the type the file was sent as (M10-K3).
  return isXml(type) && !(isXml(declared) && accept.includes(declared));
}

/** An entry of Sniffed.agrees: an exact type, a prefix ending in "*" or a suffix starting with "*". */
function agrees(sniffed: Sniffed, declared: string): boolean {
  return sniffed.agrees.some((entry) => {
    if (entry.endsWith("*")) return declared.startsWith(entry.slice(0, -1));
    return entry.startsWith("*") ? declared.endsWith(entry.slice(1)) : declared === entry;
  });
}

const notAccepted = (what: string) =>
  new CloudropError("FILE_TYPE_NOT_ALLOWED", `${what}, which this upload does not accept. Pick another file.`);

/** The refusal of a file sent as `declared` whose first bytes show `sniffed`, or undefined when it may be kept. */
function checkContent(declared: string, sniffed: Sniffed | null, accept: readonly string[], lists: Lists) {
  // /upload refused these already; a token signed before the plugin or its lists changed was not judged there.
  if (isRefused(declared, declared, accept, lists)) return notAccepted(`This file was sent as ${declared}`);
  if (!sniffed) return undefined;
  if (isRefused(sniffed.type, declared, accept, lists)) return notAccepted(`This file is ${sniffed.name}`);
  // A browser that could not type the file sent it as application/octet-stream: nothing to contradict, so the content's
  // own type must be accepted (M10-K2).
  if (declared === OCTET_STREAM) {
    const types = [sniffed.type, ...sniffed.agrees.filter((entry) => !entry.includes("*"))];
    return types.some((type) => acceptsType(accept, type)) ? undefined : notAccepted(`This file is ${sniffed.name}`);
  }
  if (agrees(sniffed, declared)) return undefined;
  return new CloudropError(
    "FILE_TYPE_NOT_ALLOWED",
    `This file is ${sniffed.name}, but it was sent as ${declared}. Give it the right extension, or pick another file.`,
  );
}

/** The first bytes of the stored file. An empty file has none: R2 answers any range of it with 416. */
async function firstBytes(storage: StorageDriver, { key, size }: AfterVerifyContext["file"]): Promise<Uint8Array> {
  if (size === 0) return new Uint8Array(0);
  const read = await storage.getRange(key, 0, Math.min(size, SNIFF_BYTES) - 1);
  // A throw keeps the verified object and asks the client to retry; the handler logs the cause.
  if (read.error) throw read.error;
  return read.data.subarray(0, SNIFF_BYTES);
}

/**
 * Refuses, at /upload, a file sent as a web page, program, script, or XML or SVG type the route does not name; and at
 * /complete, a file whose first bytes show such a type, a type other than the one it was sent as, or, for a file the
 * browser could not type, a type the route does not accept. A file whose bytes show no known type passes as sent.
 */
export function contentChecks(options?: ContentCheckOptions): CloudropPlugin {
  const lists = { allow: readList(options?.allow), deny: readList(options?.deny) };
  return {
    id: "content-checks",
    server: {
      // A refusal here refuses the whole request, before anything is signed, so no such file reaches the bucket.
      beforeUpload({ files, accept }) {
        const refused = files.find(({ type }) => isRefused(type, type, accept, lists));
        return refused && notAccepted(`One of the files was sent as ${refused.type}`);
      },
      async afterVerify({ file, accept, storage }) {
        return checkContent(file.type, sniff(await firstBytes(storage, file), file.size), accept, lists);
      },
    },
  };
}
