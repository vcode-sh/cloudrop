// POST /complete (spec §5.4, §7.6): verify what the bucket holds against the token, finish a multipart upload with
// the server's own part list, run afterVerify and onComplete. With a store and a stored token, the file's row decides
// instead (store-complete.ts).

import { fail, ok, type Result } from "../errors.ts";
import type { CompleteResponse } from "../protocol/types.ts";
import { checkAfterVerify, completeContext, runOnComplete, uploadedFile } from "./complete-steps.ts";
import { cleanUpRefused, verifyUpload } from "./complete-verify.ts";
import type { EndpointInput } from "./config.ts";
import { completeStored } from "./store-complete.ts";
import { readTokenRequest } from "./token-request.ts";

export async function handleComplete(input: EndpointInput): Promise<Result<CompleteResponse>> {
  const { request, body, config } = input;
  // A store may answer an expired token's retry with the stored result, so its row decides about expiry.
  const verified = await readTokenRequest(body, config, { storedAfterExpiry: true });
  if (verified.error) return verified;
  const { token, route } = verified.data;
  if (config.store && token.stored) return completeStored(input, config.store, token, route);
  const stored = await verifyUpload(config, token);
  if (stored.kind === "failed") return fail(stored.error);
  if (stored.kind === "refused") return cleanUpRefused(config, token, stored);
  const file = uploadedFile(config, token, route);
  const checked = await checkAfterVerify(request, config, { token, route, file });
  if (checked.kind === "failed") return fail(checked.error);
  if (checked.kind === "refused") return cleanUpRefused(config, token, checked);
  const ran = await runOnComplete(config.logger, route, completeContext(request, token, file));
  if (ran.error) return ran;
  // The JSON taken when onComplete returned is what the client gets, as on the store path: encoding the live result
  // again would run a toJSON a second time, which may throw or answer differently (M11-R47). A result JSON leaves out
  // (undefined, a function) is sent as null: without it the answer would have no data at all.
  const { json } = ran.data;
  return ok({ file, data: json === undefined ? null : JSON.parse(json) });
}
