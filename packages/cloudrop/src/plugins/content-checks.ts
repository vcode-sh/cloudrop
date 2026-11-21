// contentChecks(): at /complete, the first 4 KiB of the stored file decide whether its content is what it was declared
// as and what the route accepts (M10-K). A refusal is an afterVerify refusal: the server ends the upload, deletes the
// object only when it is this upload's, and tells the plugins through onAbort.

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

const named = (name: string, types: readonly string[]) => types.map((type) => [type, name] as const);
/** Refused by default, whatever the route accepts (M10-K3): what a browser runs, and programs. */
const REFUSED: ReadonlyMap<string, string> = new Map([
  ...named("a web page (HTML)", ["text/html", "application/xhtml+xml"]),
  ...named("a program", [
    "application/vnd.microsoft.portable-executable",
    "application/x-msdownload",
    "application/x-msdos-program",
    "application/x-dosexec",
    "application/x-executable",
    "application/x-elf",
    "application/x-sharedlib",
    "application/x-mach-binary",
  ]),
  ...named("a script", [
    "text/javascript",
    "application/javascript",
    "application/x-javascript",
    "text/ecmascript",
    "application/ecmascript",
    "text/x-shellscript",
    "application/x-sh",
    "application/x-shellscript",
    "text/x-sh",
  ]),
]);

/** XML types (RFC 7303 §3, and every "+xml" type): a browser renders them, SVG with its scripts. */
const isXml = (type: string) => type === "text/xml" || type === "application/xml" || type.endsWith("+xml");

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

/** Whether `type` is refused before anything else is compared. */
function isRefused(type: string, declared: string, accept: readonly string[], { allow, deny }: Lists): boolean {
  if (acceptsType(deny, type)) return true;
  if (acceptsType(allow, type)) return false;
  if (REFUSED.has(type)) return true;
  // XML and SVG pass only on a route that names the type the file was sent as (M10-K3).
  return isXml(type) && !(isXml(declared) && accept.includes(declared));
}

function nameOf(type: string, sniffed: Sniffed | null): string {
  if (sniffed?.type === type) return sniffed.name;
  if (type === "image/svg+xml") return "an SVG image";
  return REFUSED.get(type) ?? (isXml(type) ? "an XML document" : `a ${type} file`);
}

/** An entry of Sniffed.agrees: an exact type, a prefix ending in "*" or a suffix starting with "*". */
function agrees(sniffed: Sniffed, declared: string): boolean {
  return sniffed.agrees.some((entry) => {
    if (entry.endsWith("*")) return declared.startsWith(entry.slice(0, -1));
    return entry.startsWith("*") ? declared.endsWith(entry.slice(1)) : declared === entry;
  });
}

const notAccepted = (name: string) =>
  new CloudropError(
    "FILE_TYPE_NOT_ALLOWED",
    `This file is ${name}, which this upload does not accept. Pick another file.`,
  );

/** The refusal for a file declared as `declared` whose content shows `sniffed`, or undefined when it may be kept. */
function check(declared: string, sniffed: Sniffed | null, accept: readonly string[], lists: Lists) {
  // The content first: a file is refused as what it is before what it was sent as.
  const refused = [sniffed?.type, declared].find(
    (type) => type !== undefined && isRefused(type, declared, accept, lists),
  );
  if (refused) return notAccepted(nameOf(refused, sniffed));
  if (!sniffed) return undefined;
  // A browser that could not type the file sent it as application/octet-stream: nothing to contradict, so the content's
  // own type must be accepted (M10-K2).
  if (declared === OCTET_STREAM) {
    const types = [sniffed.type, ...sniffed.agrees.filter((entry) => !entry.includes("*"))];
    return types.some((type) => acceptsType(accept, type)) ? undefined : notAccepted(sniffed.name);
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
 * Refuses a file whose first bytes show a type the route does not accept, a type other than the one it was sent as,
 * or a web page, program or script whatever it was sent as. XML and SVG pass only on a route that names their type.
 * A file whose bytes show no known type passes as the type it was sent as.
 */
export function contentChecks(options?: ContentCheckOptions): CloudropPlugin {
  const lists = { allow: readList(options?.allow), deny: readList(options?.deny) };
  return {
    id: "content-checks",
    server: {
      async afterVerify({ file, accept, storage }) {
        return check(file.type, sniff(await firstBytes(storage, file)), accept, lists);
      },
    },
  };
}
