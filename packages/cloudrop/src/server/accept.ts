// The `accept` policy (spec §7.4): the declared MIME type must be accepted, and the file name's extension must agree
// with it. The extension list covers the types upload forms meet; a type outside it is matched by MIME alone.

const EXTENSIONS: Record<string, readonly string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "image/avif": ["avif"],
  "image/heic": ["heic"],
  "image/heif": ["heif"],
  "image/bmp": ["bmp"],
  "image/tiff": ["tif", "tiff"],
  "image/svg+xml": ["svg"],
  "image/x-icon": ["ico"],
  "image/vnd.microsoft.icon": ["ico"],
  "video/mp4": ["mp4", "m4v"],
  "video/webm": ["webm"],
  "video/quicktime": ["mov"],
  "audio/mpeg": ["mp3"],
  "audio/mp4": ["m4a"],
  "audio/wav": ["wav"],
  "audio/x-wav": ["wav"],
  "audio/ogg": ["ogg", "oga"],
  "audio/webm": ["weba", "webm"],
  "audio/flac": ["flac"],
  "application/pdf": ["pdf"],
  "application/zip": ["zip"],
  "application/json": ["json"],
  "application/xml": ["xml"],
  "text/xml": ["xml"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  "text/markdown": ["md", "markdown"],
  "text/html": ["html", "htm"],
  "application/msword": ["doc"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
};

/** Extensions of the known types: a file declared as another type never carries one into its key. */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set(Object.values(EXTENSIONS).flat());

// The only extensions that go into a key or a message.
const PLAIN_EXTENSION = /^[a-z0-9]{1,16}$/;

// RFC 6838 type and subtype names, lower case, no parameters: this value is signed and stored as the object's type.
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const ACCEPT_ENTRY = /^(\*\/\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,63}))$/;

/** A browser sends "" for a type it does not know; that file is stored as application/octet-stream. */
export function normalizeType(type: string): string | null {
  const lower = type === "" ? "application/octet-stream" : type.toLowerCase();
  return MIME_TYPE.test(lower) ? lower : null;
}

export function isAcceptEntry(entry: string): boolean {
  return ACCEPT_ENTRY.test(entry);
}

function extensionOf(name: string): string | null {
  // Downloads may lose trailing dots, so they cannot hide a contradictory extension.
  const trimmed = name.replace(/\.+$/, "");
  const dot = trimmed.lastIndexOf(".");
  // ".env" is a name without an extension, not an extension without a name.
  return dot > 0 ? trimmed.slice(dot + 1).toLowerCase() : null;
}

/**
 * The key extension for an accepted file (".jpg", or "" for none), or a message saying why the file is refused.
 * `type` must already be normalized.
 */
export function matchAccept(
  accept: readonly string[],
  type: string,
  name: string,
): { ext: string } | { problem: string } {
  const accepted = accept.some(
    (entry) => entry === "*/*" || entry === type || (entry.endsWith("/*") && type.startsWith(entry.slice(0, -1))),
  );
  if (!accepted) return { problem: `This upload does not accept ${type} files.` };
  const ext = extensionOf(name);
  const known = EXTENSIONS[type];
  const plain = ext !== null && PLAIN_EXTENSION.test(ext);
  if (known === undefined) return { ext: plain && !KNOWN_EXTENSIONS.has(ext) ? `.${ext}` : "" };
  if (ext === null) return { ext: `.${known[0]}` };
  if (known.includes(ext)) return { ext: `.${ext}` };
  // The extension is the client's text: it is echoed only when it is plain, never as sent.
  return {
    problem: plain
      ? `The file name ends in .${ext}, which does not match its type ${type}. Rename the file or pick another.`
      : `The file name's extension does not match its type ${type}. Rename the file or pick another.`,
  };
}
