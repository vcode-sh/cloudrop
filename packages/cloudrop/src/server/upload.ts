// POST /upload (spec §5): bounds, metadata, authorize, policy, plugins, then one ticket per file. Nothing is signed
// before authorize has passed and the policy has accepted the file.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { planUpload } from "../plan.ts";
import {
  type FileDescriptor,
  type FileTicket,
  MAX_NAME_LENGTH,
  PARTS_PER_SIGN,
  type UploadResponse,
} from "../protocol/types.ts";
import { formatBytes, invalidInput, isPlainObject } from "../storage/validate.ts";
import { matchAccept, normalizeType } from "./accept.ts";
import { type EndpointInput, ROUTE_NAME, type RouteConfig, type ServerConfig } from "./config.ts";
import { errorBody, storageFailure } from "./http.ts";
import { generatedKey, newFileId, normalizeKey } from "./key.ts";
import { type AbortContext, type PluginFile, runBeforeUpload, runOnAbort } from "./plugins.ts";
import { nowSeconds, objectOptions, presignParts, presignSingle, TOKEN_LIFETIME_SECONDS } from "./presign.ts";
import { isUnauthorized, unauthorized } from "./route.ts";
import { MAX_METADATA_JSON_BYTES, validateMetadata } from "./schema.ts";
import { type MultipartToken, signToken, type UploadTokenPayload } from "./token.ts";

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

function readRequest(
  body: unknown,
  config: ServerConfig,
): Result<{ route: RouteConfig; files: FileDescriptor[]; metadata: unknown }> {
  if (!isPlainObject(body)) return fail(invalidInput("Send a JSON object: { route, files, metadata }."));
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
  return ok({ route, files: descriptors as FileDescriptor[], metadata: body.metadata });
}

/** The file's key and stored type, or why the route refuses it. */
function prepareFile(
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

/** One file's ticket: create the multipart upload if needed, sign the first URLs and the token. */
async function startFile(
  config: ServerConfig,
  base: Omit<UploadTokenPayload, "uploadId" | "partSize">,
): Promise<FileTicket> {
  const { storage, logger } = config;
  const { signing } = await config.tokenKeys;
  const expiresAt = new Date(base.exp * 1000).toISOString();
  const ticket = { fileId: base.fileId, key: base.key, expiresAt };
  const rejected = (error: CloudropError): FileTicket => ({
    kind: "rejected",
    error: errorBody(storageFailure(error, logger)),
  });
  const plan = planUpload(base.size, storage.rules, { multipartThreshold: config.multipartThreshold });
  if (plan.kind === "single") {
    const [put, token] = await Promise.all([presignSingle(storage, base), signToken(base, signing)]);
    return put.error ? rejected(put.error) : { kind: "single", ...ticket, token, put: put.data };
  }
  const created = await storage.createMultipart(base.key, objectOptions(base));
  if (created.error) return rejected(created.error);
  const token: MultipartToken = { ...base, uploadId: created.data.uploadId, partSize: plan.partSize };
  const first = Array.from({ length: Math.min(PARTS_PER_SIGN, plan.partCount) }, (_, index) => index + 1);
  const [parts, signed] = await Promise.all([presignParts(storage, token, first), signToken(token, signing)]);
  if (parts.error) {
    await storage.abortMultipart(token.key, token.uploadId);
    return rejected(parts.error);
  }
  return {
    kind: "multipart",
    ...ticket,
    token: signed,
    partSize: plan.partSize,
    partCount: plan.partCount,
    parts: parts.data,
  };
}

export async function handleUpload({ request, body, config }: EndpointInput): Promise<Result<UploadResponse>> {
  const parsed = readRequest(body, config);
  if (parsed.error) return parsed;
  const { route, files } = parsed.data;
  const validated = await validateMetadata(route.definition.metadata, parsed.data.metadata);
  if (validated.error) return validated;
  const { value: metadata, json: metadataJson } = validated.data;
  const auth = await route.definition.authorize({ request, metadata });
  if (isUnauthorized(auth)) {
    // A refusal built by plain JavaScript or another copy of cloudrop may lack a message; it still refuses.
    const message = typeof auth.message === "string" && auth.message !== "" ? auth.message : unauthorized().message;
    return fail(new CloudropError("UNAUTHORIZED", message));
  }
  // Only a plain object whose JSON is an object authorizes: a Response or an Error is an object too, and reading one
  // as the user would sign uploads for a refused request. The token carries this one JSON snapshot, measured and
  // signed as the same text, because a toJSON may answer differently each time it runs. JSON.stringify throws for a
  // BigInt or a cycle, which the handler reports.
  if (!isPlainObject(auth)) {
    throw new TypeError(`Route "${route.name}": authorize must return a plain object or unauthorized().`);
  }
  const ownerJson: string | undefined = JSON.stringify(auth);
  if (ownerJson?.[0] !== "{") {
    throw new TypeError(
      `Route "${route.name}": authorize returned an object whose toJSON does not give a JSON object. Return plain data or unauthorized().`,
    );
  }
  if (new TextEncoder().encode(ownerJson).length > MAX_METADATA_JSON_BYTES) {
    throw new TypeError(`Route "${route.name}": authorize returned more than 2 KiB of JSON. Return ids, not records.`);
  }
  const owner: unknown = JSON.parse(ownerJson);
  const signedMetadata: unknown = metadataJson === undefined ? undefined : JSON.parse(metadataJson);
  const prepared = files.map((file) => prepareFile(route, file, { request, metadata, auth }));
  const accepted = prepared.filter((file): file is PluginFile => !(file instanceof CloudropError));
  const { plugins } = config;
  if (accepted.length > 0) {
    const refused = await runBeforeUpload(
      plugins,
      { request, route: route.name, files: accepted, metadata, auth },
      config.logger,
    );
    if (refused) return fail(refused);
  }
  const exp = nowSeconds() + TOKEN_LIFETIME_SECONDS;
  const tickets = await Promise.all(
    prepared.map((file): FileTicket | Promise<FileTicket> =>
      file instanceof CloudropError
        ? { kind: "rejected", error: errorBody(file) }
        : startFile(config, {
            v: 1,
            route: route.name,
            fileId: file.id,
            key: file.key,
            name: file.name,
            size: file.size,
            type: file.type,
            owner,
            metadata: signedMetadata,
            exp,
          }),
    ),
  );
  // Files that beforeUpload accepted but storage could not start: release what plugins reserved for them.
  const failed = prepared.flatMap((file, index): AbortContext[] =>
    file instanceof CloudropError || tickets[index]?.kind !== "rejected"
      ? []
      : [{ route: route.name, file, metadata, auth, reason: "failed" }],
  );
  await runOnAbort(plugins, failed, config.logger);
  return ok({ files: tickets });
}
