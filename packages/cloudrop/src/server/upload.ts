// POST /upload (spec §5): bounds, metadata, authorize, policy, plugins, then one ticket per file. Nothing is signed
// before authorize has passed and the policy has accepted the file.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { isPlainObject } from "../input.ts";
import { planUpload } from "../plan.ts";
import { type FileTicket, PARTS_PER_SIGN, type UploadResponse } from "../protocol/types.ts";
import { retryAfterOf, waitAtLeast } from "../retry-after.ts";
import type { EndpointConfig, EndpointInput, ServerConfig } from "./config.ts";
import { errorBody, serverError, storageFailure } from "./http.ts";
import { abortContexts, type Logger, type PluginFile, runBeforeUpload, runOnAbort } from "./plugins.ts";
import { nowSeconds, objectOptions, presignParts, presignSingle, TOKEN_LIFETIME_SECONDS } from "./presign.ts";
import { isRefusal, refusalError, uploadRefusal } from "./refusal.ts";
import { MAX_METADATA_JSON_BYTES, validateMetadata } from "./schema.ts";
import { type MultipartToken, signToken, type UploadTokenPayload } from "./token.ts";
import { accountChanged, prepareFile, readRequest } from "./upload-request.ts";

/** One file's ticket: create the multipart upload if needed, sign the first URLs and the token. */
async function startFile(
  config: EndpointConfig,
  base: Omit<UploadTokenPayload, "uploadId" | "partSize">,
): Promise<FileTicket> {
  const { storage, logger } = config;
  const { signing } = config.tokenKeys;
  const expiresAt = new Date(base.exp * 1000).toISOString();
  const ticket = { id: base.id, key: base.key, expiresAt };
  // The ticket keeps the wait the storage asked for, which the 200 answers as Retry-After (M12-E5).
  const rejected = (error: CloudropError): FileTicket => {
    const failure = storageFailure(error, logger);
    return waitAtLeast({ kind: "rejected", error: errorBody(failure) }, retryAfterOf(failure));
  };
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
  // A row that cannot record the upload could never abort it later: abort it now and start nothing.
  const { store, paths } = config;
  const unattached = store && paths && token.stored ? await paths.upload.attachUpload(config, store, token) : null;
  if (unattached) {
    await abort();
    return { kind: "rejected", error: errorBody(unattached) };
  }
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

/**
 * Releases what was reserved for accepted files that were not started. Their plugins hear "rejected" for a file over
 * its quota and "failed" otherwise; a reserved row whose upload could not start ends as failed, best effort.
 */
async function releaseUnstarted(
  config: ServerConfig,
  shared: { route: string; metadata: unknown; auth: unknown },
  unstarted: readonly PluginFile[],
  refusals: ReadonlyMap<string, CloudropError>,
): Promise<void> {
  const { plugins, logger } = config;
  const overQuota = unstarted.filter((file) => refusals.get(file.id)?.code === "QUOTA_EXCEEDED");
  const failed = unstarted.filter((file) => !overQuota.includes(file));
  await config.paths?.upload.endUnstarted(
    config,
    failed.filter(({ id }) => !refusals.has(id)),
  );
  await runOnAbort(plugins, abortContexts(shared, overQuota, "rejected"), logger);
  await runOnAbort(plugins, abortContexts(shared, failed, "failed"), logger);
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

/**
 * What `authorize` answered: a refusal, or the caller with the one JSON snapshot of it the token carries, measured and
 * signed as the same text, because a toJSON may answer differently each time it runs. Anything else is the route's bug,
 * thrown for the handler to report; JSON.stringify throws for a BigInt or a cycle too.
 */
function readAuth(
  routeName: string,
  auth: unknown,
  logger: Logger,
): Result<{ auth: Record<string, unknown>; ownerJson: string }> {
  if (isRefusal(auth)) return fail(refusalError(auth));
  if (auth instanceof CloudropError) return fail(uploadRefusal(auth, "authorize", logger));
  // A CloudropError from a second installed copy of cloudrop fails the check above, so the message names that cause.
  if (auth instanceof Error && auth.name === "CloudropError") {
    throw new TypeError(
      `Route "${routeName}": authorize returned a CloudropError from another copy of cloudrop than the server uses. Install cloudrop once, so the route and the server share it.`,
    );
  }
  // Only a plain object whose JSON is an object authorizes: a Response or an Error is an object too, and reading one
  // as the user would sign uploads for a refused request.
  if (!isPlainObject(auth)) {
    throw new TypeError(
      `Route "${routeName}": authorize must return a plain object, unauthorized(), forbidden() or a CloudropError.`,
    );
  }
  const ownerJson: string | undefined = JSON.stringify(auth);
  if (ownerJson?.[0] !== "{") {
    throw new TypeError(
      `Route "${routeName}": authorize returned an object whose toJSON does not give a JSON object. Return plain data or unauthorized().`,
    );
  }
  if (new TextEncoder().encode(ownerJson).length > MAX_METADATA_JSON_BYTES) {
    throw new TypeError(`Route "${routeName}": authorize returned more than 2 KiB of JSON. Return ids, not records.`);
  }
  return ok({ auth, ownerJson });
}

export async function handleUpload({ request, body, config }: EndpointInput): Promise<Result<UploadResponse>> {
  const parsed = readRequest(body, config);
  if (parsed.error) return parsed;
  const { route, files } = parsed.data;
  const validated = await validateMetadata(route.definition.metadata, parsed.data.metadata);
  if (validated.error) return validated;
  const { value: metadata, json: metadataJson } = validated.data;
  const answered = readAuth(route.name, await route.definition.authorize({ request, metadata }), config.logger);
  if (answered.error) return answered;
  const { auth, ownerJson } = answered.data;
  const owner: unknown = JSON.parse(ownerJson);
  // Plugin hooks see the same snapshot as onComplete, never the live object (M12-T5), in a copy of their own: a hook
  // that writes to it must not change what the token signs.
  const pluginAuth: unknown = JSON.parse(ownerJson);
  const signedMetadata: unknown = metadataJson === undefined ? undefined : JSON.parse(metadataJson);
  const prepared = files.map((file) => prepareFile(route, file, { request, metadata, auth }));
  const accepted = prepared.filter((file): file is PluginFile => !(file instanceof CloudropError));
  const { plugins, store, paths } = config;
  // Like prefix, a bad owner is the route's bug, found before any plugin reserves anything.
  const rowOwner =
    paths && accepted.length > 0 ? await paths.upload.readOwner(route, { ...auth, request, metadata }) : null;
  // Only an owner a store records can be compared: without one the header is ignored.
  const changed = rowOwner === null ? null : accountChanged(request, rowOwner);
  if (changed) return fail(changed);
  if (accepted.length > 0) {
    const refused = await runBeforeUpload(
      plugins,
      { request, route: route.name, accept: route.accept, files: accepted, metadata, auth: pluginAuth },
      config.logger,
    );
    if (refused) return fail(uploadRefusal(refused, "a plugin's beforeUpload", config.logger));
  }
  const exp = nowSeconds() + TOKEN_LIFETIME_SECONDS;
  const refusals =
    (await paths?.upload.reserveFiles(config, {
      route,
      owner: rowOwner,
      files: accepted,
      metadataJson,
      exp,
      requestKey: parsed.data.idempotencyKey,
    })) ?? new Map<string, CloudropError>();
  const tickets = await Promise.all(
    prepared.map((file): FileTicket | Promise<FileTicket> => {
      if (file instanceof CloudropError) return { kind: "rejected", error: errorBody(file) };
      const refused = refusals.get(file.id);
      return refused
        ? { kind: "rejected", error: errorBody(refused) }
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
            ...(store && { stored: true as const }),
          });
    }),
  );
  // Files that beforeUpload accepted but could not be started: release what plugins and the store reserved for them.
  const unstarted = prepared.filter(
    (file, index): file is PluginFile => !(file instanceof CloudropError) && tickets[index]?.kind === "rejected",
  );
  await releaseUnstarted(config, { route: route.name, metadata, auth: pluginAuth }, unstarted, refusals);
  // Only a retryable storage failure carries a wait. The client waits it out for each file refused with one.
  return ok(waitAtLeast({ files: tickets }, Math.max(0, ...tickets.map(retryAfterOf))));
}
