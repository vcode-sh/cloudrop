// POST /upload (spec §5): bounds, metadata, authorize, policy, plugins, then one ticket per file. Nothing is signed
// before authorize has passed and the policy has accepted the file.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { isPlainObject } from "../input.ts";
import { planUpload } from "../plan.ts";
import { type FileTicket, PARTS_PER_SIGN, type UploadResponse } from "../protocol/types.ts";
import type { EndpointConfig, EndpointInput } from "./config.ts";
import { errorBody, serverError, storageFailure } from "./http.ts";
import { abortContexts, type PluginFile, runBeforeUpload, runOnAbort } from "./plugins.ts";
import { nowSeconds, objectOptions, presignParts, presignSingle, TOKEN_LIFETIME_SECONDS } from "./presign.ts";
import { isRefusal, refusalError } from "./route.ts";
import { MAX_METADATA_JSON_BYTES, validateMetadata } from "./schema.ts";
import { type MultipartToken, signToken, type UploadTokenPayload } from "./token.ts";
import { prepareFile, readRequest } from "./upload-request.ts";

/** One file's ticket: create the multipart upload if needed, sign the first URLs and the token. */
async function startFile(
  config: EndpointConfig,
  base: Omit<UploadTokenPayload, "uploadId" | "partSize">,
): Promise<FileTicket> {
  const { storage, logger } = config;
  const { signing } = config.tokenKeys;
  const expiresAt = new Date(base.exp * 1000).toISOString();
  const ticket = { id: base.id, key: base.key, expiresAt };
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
  const abort = () => storage.abortMultipart(token.key, token.uploadId);
  const [parts, signed] = await Promise.all([presignParts(storage, token, first), signToken(token, signing)]).catch(
    // A custom driver's presignPart may throw: the upload created above must not stay open in the bucket.
    async (error: unknown) => {
      await abort();
      throw error;
    },
  );
  if (parts.error) {
    await abort();
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

/** A custom StorageDriver may throw: that file is rejected and released like a storage failure, and the others go on. */
async function startFileSafely(
  config: EndpointConfig,
  base: Omit<UploadTokenPayload, "uploadId" | "partSize">,
): Promise<FileTicket> {
  try {
    return await startFile(config, base);
  } catch (error) {
    config.logger.error(`cloudrop: could not start the upload of file ${base.id} on route "${base.route}".`, error);
    return { kind: "rejected", error: errorBody(serverError()) };
  }
}

export async function handleUpload({ request, body, config }: EndpointInput): Promise<Result<UploadResponse>> {
  const parsed = readRequest(body, config);
  if (parsed.error) return parsed;
  const { route, files } = parsed.data;
  const validated = await validateMetadata(route.definition.metadata, parsed.data.metadata);
  if (validated.error) return validated;
  const { value: metadata, json: metadataJson } = validated.data;
  const auth = await route.definition.authorize({ request, metadata });
  if (isRefusal(auth)) return fail(refusalError(auth));
  // Only a plain object whose JSON is an object authorizes: a Response or an Error is an object too, and reading one
  // as the user would sign uploads for a refused request. The token carries this one JSON snapshot, measured and
  // signed as the same text, because a toJSON may answer differently each time it runs. JSON.stringify throws for a
  // BigInt or a cycle, which the handler reports.
  if (!isPlainObject(auth)) {
    throw new TypeError(`Route "${route.name}": authorize must return a plain object, unauthorized() or forbidden().`);
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
        : startFileSafely(config, {
            v: 1,
            route: route.name,
            id: file.id,
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
  // Files that beforeUpload accepted but could not be started: release what plugins reserved for them.
  const failed = prepared.filter(
    (file, index): file is PluginFile => !(file instanceof CloudropError) && tickets[index]?.kind === "rejected",
  );
  await runOnAbort(plugins, abortContexts({ route: route.name, metadata, auth }, failed, "failed"), config.logger);
  return ok({ files: tickets });
}
