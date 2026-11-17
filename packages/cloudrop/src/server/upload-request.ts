// The checks of POST /upload that read the client's request: its shape, the route it names, and each file's
// descriptor, policy and key. Nothing here touches storage or signs anything.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import { type FileDescriptor, MAX_NAME_LENGTH } from "../protocol/types.ts";
import { formatBytes } from "../storage/validate.ts";
import { matchAccept, normalizeType } from "./accept.ts";
import { ROUTE_NAME, type RouteConfig, type ServerConfig } from "./config.ts";
import { generatedKey, newFileId, normalizeKey } from "./key.ts";
import type { PluginFile } from "./plugins.ts";

/**
 * The descriptor with its name in NFC, or null when it is malformed. The name must be well-formed Unicode (a lone
 * surrogate cannot be percent-encoded into Content-Disposition), and its length is counted after NFC, which can
 * lengthen it. The type is checked by the policy, per file.
 */
function readDescriptor(file: unknown): FileDescriptor | null {
  if (
    !isPlainObject(file) ||
    typeof file.name !== "string" ||
    !file.name.isWellFormed() ||
    typeof file.size !== "number" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    typeof file.type !== "string"
  ) {
    return null;
  }
  const name = file.name.normalize("NFC");
  const length = [...name].length;
  return length > 0 && length <= MAX_NAME_LENGTH ? { name, size: file.size, type: file.type } : null;
}

/** An `/upload` request's idempotency key: the client's random id of one ask, sent again by each retry of it. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

export function readRequest(
  body: unknown,
  config: ServerConfig,
): Result<{ route: RouteConfig; files: FileDescriptor[]; metadata: unknown; idempotencyKey: string | null }> {
  if (!isPlainObject(body)) return fail(invalidInput("Send a JSON object: { route, files, metadata }."));
  const { idempotencyKey } = body;
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey))) {
    return fail(
      invalidInput('Send idempotencyKey as 16 to 128 letters, digits, "-" or "_", such as a UUID, or leave it out.'),
    );
  }
  if (typeof body.route !== "string")
    return fail(invalidInput('Name the upload route, such as { "route": "avatar" }.'));
  const route = config.routes.get(body.route);
  if (!route) {
    // The name is echoed only when it is a plausible route name: it comes from the client.
    const named = ROUTE_NAME.test(body.route) ? ` named "${body.route}"` : " with that name";
    return fail(new CloudropError("UNKNOWN_ROUTE", `There is no upload route${named}. Check the route name.`));
  }
  const { files } = body;
  if (!Array.isArray(files) || files.length === 0) {
    return fail(invalidInput('Send at least one file as { "name", "size", "type" }.'));
  }
  if (files.length > route.maxFiles) {
    return fail(
      new CloudropError("TOO_MANY_FILES", `This upload takes at most ${route.maxFiles} files at once. Send fewer.`),
    );
  }
  const descriptors = files.map(readDescriptor);
  const bad = descriptors.indexOf(null);
  if (bad >= 0) {
    return fail(
      invalidInput(
        `File ${bad + 1} needs a name of 1 to ${MAX_NAME_LENGTH} characters, a size in bytes and a type, such as { "name": "a.png", "size": 1024, "type": "image/png" }.`,
      ),
    );
  }
  return ok({
    route,
    files: descriptors as FileDescriptor[],
    metadata: body.metadata,
    idempotencyKey: idempotencyKey ?? null,
  });
}

/** The file's key and stored type, or why the route refuses it. */
export function prepareFile(
  route: RouteConfig,
  descriptor: FileDescriptor,
  context: { request: Request; metadata: unknown; auth: object },
): PluginFile | CloudropError {
  const type = normalizeType(descriptor.type);
  if (type === null) {
    return new CloudropError("FILE_TYPE_NOT_ALLOWED", "The file's type is not a valid MIME type. Pick another file.");
  }
  if (descriptor.size > route.maxSize) {
    return new CloudropError(
      "FILE_TOO_LARGE",
      `This file is over the ${formatBytes(route.maxSize)} limit. Pick a smaller file.`,
    );
  }
  const { name } = descriptor;
  const match = matchAccept(route.accept, type, name);
  if ("problem" in match) return new CloudropError("FILE_TYPE_NOT_ALLOWED", match.problem);
  const id = newFileId();
  const keyContext = {
    ...context.auth,
    request: context.request,
    metadata: context.metadata,
    file: { id, name, size: descriptor.size, type, ext: match.ext },
  };
  const { definition } = route;
  const folder = definition.prefix ? definition.prefix(keyContext) : "";
  // A prefix is often a tenant folder: falling back to the bucket root would mix tenants silently. A leading slash is
  // refused before generatedKey trims trailing ones, which would turn "/" into the root.
  if (typeof folder !== "string") {
    throw new TypeError(`Route "${route.name}": prefix must return a string, got ${typeof folder}.`);
  }
  if (folder.startsWith("/")) {
    throw new TypeError(
      `Route "${route.name}": prefix must be a relative folder such as "users/42", without a leading slash.`,
    );
  }
  const key = normalizeKey(definition.key ? definition.key(keyContext) : generatedKey(folder, id, match.ext));
  // The key comes from the application's prefix or key function, so a bad one is a server bug, not the user's.
  if ("problem" in key) throw new TypeError(`Route "${route.name}" built an unusable key: ${key.problem}`);
  return { id, key: key.key, name, size: descriptor.size, type };
}
