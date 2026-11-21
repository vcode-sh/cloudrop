// contentChecks(): the declared type is judged at /upload, before anything is signed, and the content at /complete,
// from the first 4 KiB of the stored file (M10-K2). A refusal at /complete is an afterVerify refusal: the server ends
// the upload, deletes the object only when it is this upload's, and tells the plugins through onAbort.

// CloudropError comes through the published entry, so a refusal is an instance of the class the server checks for
// (M10-K5, as M9-T2 does for cloudrop/testing).
import {
  type AfterVerifyContext,
  CloudropError,
  type CloudropPlugin,
  type ContentRefusal,
  type StorageDriver,
} from "../index.ts";
import { acceptsType, isAcceptEntry } from "../server/accept-entry.ts";
import { LINUX, MAC, OLE, type Sniffed, sniff, WINDOWS } from "./sniff.ts";
import { HTML, SCRIPT } from "./sniff-text.ts";

export interface ContentCheckOptions {
  /**
   * Types let through the default refusals: web pages, programs, scripts, and XML or SVG on a route that does not name
   * the type. One name of a kind lets the kind through under all its names, such as ["text/html"] for web pages or
   * ["application/x-msdownload"] for Windows programs. The route's `accept` and the match between content and
   * declared type still apply.
   */
  allow?: readonly string[];
  /**
   * Types refused on every route, by declared type or by content; wins over `allow`. Such as ["application/zip"]. A
   * container whose bytes do not say which of its types it is (WebM, MP4, Ogg, a ZIP that names no package) is the
   * type it was sent as: ["video/*"] does not refuse a recording sent as audio/webm.
   */
  deny?: readonly string[];
}

/** How much of a file is read: enough for every signature and an XML document's root element. */
const SNIFF_BYTES = 4096;
const OCTET_STREAM = "application/octet-stream";

/** WHATWG MIME Sniffing §7's unknown types, which a browser sniffs and may render as a web page. */
const UNKNOWN = ["unknown/unknown", "application/unknown"];
/** Windows installers, which a browser hands to the system to run. */
const INSTALLER = ["application/x-msi", "application/x-ms-installer"];
/** Every JavaScript MIME type essence of WHATWG MIME Sniffing §4.6. */
const JAVASCRIPT = [
  ..."application/ecmascript application/javascript application/x-ecmascript application/x-javascript".split(" "),
  ..."text/ecmascript text/javascript text/jscript text/livescript text/x-ecmascript text/x-javascript".split(" "),
  ..."text/javascript1.0 text/javascript1.1 text/javascript1.2 text/javascript1.3 text/javascript1.4".split(" "),
  "text/javascript1.5",
];

/** Refused by default, whatever the route accepts (M10-K3). */
const REFUSED: ReadonlySet<string> = new Set([
  // Web pages, HTML applications among them, and programs: the types the sniffer gives them and their aliases.
  ...HTML.agrees,
  ...UNKNOWN,
  // A browser navigated to it renders each body part by the part's own type, text/html among them (HTML Standard
  // §7.5.5, Loading multipart/x-mixed-replace documents, and §17.2).
  "multipart/x-mixed-replace",
  ...WINDOWS.agrees,
  ...LINUX.agrees,
  ...MAC.agrees,
  ...INSTALLER,
  // Scripts: JavaScript, shell scripts and VBScript.
  ...JAVASCRIPT,
  ..."text/x-shellscript application/x-sh application/x-shellscript text/x-sh text/vbscript".split(" "),
]);

/**
 * The refused kinds that go by several names. `allow` lets a kind through by any of them (M11-R134): a browser picks
 * the name, and the sniffer has one of its own.
 */
const KINDS = [HTML, WINDOWS, LINUX, MAC, SCRIPT].map(({ agrees }) => agrees).concat([UNKNOWN, INSTALLER, JAVASCRIPT]);

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

/**
 * Whether `type`, sent as or found in a file sent as `declared`, is refused whatever else matches. `names` are the
 * types `allow` lets it through by: its kind's, and for content, every type that content can be here.
 */
function isRefused(
  type: string,
  declared: string,
  accept: readonly string[],
  { allow, deny }: Lists,
  names: readonly string[] = KINDS.find((kind) => kind.includes(type)) ?? [type],
): boolean {
  if (acceptsType(deny, type)) return true;
  if (names.some((name) => acceptsType(allow, name))) return false;
  if (REFUSED.has(type)) return true;
  // XML and SVG pass only on a route that names the type the file was sent as (M10-K3).
  return isXml(type) && !(isXml(declared) && accept.includes(declared));
}

/** Whether `type` is one of `entries`: an exact type, a prefix ending in "*" or a suffix starting with "*". */
const fits = (entries: readonly string[] = [], type: string): boolean =>
  entries.some((entry) => {
    if (entry.endsWith("*")) return type.startsWith(entry.slice(0, -1));
    return entry.startsWith("*") ? type.endsWith(entry.slice(1)) : type === entry;
  });

/** A refusal with `content`, which says in data what `message` says in English (M11-K1). */
const refusal = (message: string, content: ContentRefusal) =>
  new CloudropError("FILE_TYPE_NOT_ALLOWED", message, { content });

const notAccepted = (what: string, content: ContentRefusal) =>
  refusal(`${what}, which this upload does not accept. Pick another file.`, content);

/** The refusal of a file sent as `declared` whose first bytes show `sniffed`, or undefined when it may be kept. */
function checkContent(declared: string, sniffed: Sniffed | null, accept: readonly string[], lists: Lists) {
  // /upload refused these already; a token signed before the plugin or its lists changed was not judged there. The
  // declared type decides, so `detected` is left out whatever the bytes show (M11-K2).
  if (isRefused(declared, declared, accept, lists)) {
    return notAccepted(`This file was sent as ${declared}`, { declared, reason: "refused" });
  }
  if (!sniffed) return undefined;
  const detected = sniffed.type;
  const what = `This file is ${sniffed.name}`;
  // A browser that could not type the file sent it as application/octet-stream: nothing to contradict (M10-K2).
  const typed = declared !== OCTET_STREAM;
  const agreed = typed && (fits(sniffed.agrees, declared) || fits(sniffed.loose, declared));
  // The types this content can be here: its own names, and of the type it was sent as, or untyped of the route's
  // entries, those it can be.
  const can = [...sniffed.agrees, ...(typed ? [declared] : accept)].filter(
    (type) => !type.includes("*") && fits(sniffed.agrees, type),
  );
  // `allow` lets the content through by any of them, and by the type it was sent as when it agrees with that one.
  const names = agreed ? [...can, declared] : can;
  // A container's bytes do not say which of its types the file is (M11-R133).
  const judged = sniffed.container ? can : [detected];
  const open = judged.filter((type) => !isRefused(type, declared, accept, lists, names));
  // Sent as one of its types, a container is that one, judged above; sent untyped, nobody said which, so one refused
  // type refuses it (M11-R136).
  if (typed ? !open.length : open.length < judged.length) {
    return notAccepted(what, { declared, detected, reason: "refused" });
  }
  // The content's own type must be accepted. A compound file has none: untyped, it is what it was sent as (M11-R254).
  if (!typed && sniffed !== OLE && !can.some((type) => acceptsType(accept, type))) {
    return notAccepted(what, { declared, detected, reason: "not-accepted" });
  }
  if (!typed || agreed) return undefined;
  return refusal(`${what}, but it was sent as ${declared}. Give it the right extension, or pick another file.`, {
    declared,
    detected,
    reason: "mismatch",
  });
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
        return (
          refused &&
          notAccepted(`One of the files was sent as ${refused.type}`, { declared: refused.type, reason: "refused" })
        );
      },
      async afterVerify({ file, accept, storage }) {
        return checkContent(file.type, sniff(await firstBytes(storage, file), file.size), accept, lists);
      },
    },
  };
}
