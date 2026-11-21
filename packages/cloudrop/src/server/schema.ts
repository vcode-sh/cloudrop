// Standard Schema v1 (https://standardschema.dev), typed here so cloudrop depends on no schema library: zod, valibot
// and arktype values all satisfy this interface.

import { CloudropError, fail, ok, type Result } from "../errors.ts";

export interface StandardSchema<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

export type SchemaInput<TSchema> = TSchema extends StandardSchema<infer Input, unknown> ? Input : undefined;
export type SchemaOutput<TSchema> = TSchema extends StandardSchema<unknown, infer Output> ? Output : undefined;

/** Metadata travels inside every upload token (spec §5.2); the same 2 KiB cap as object metadata keeps tokens small. */
export const MAX_METADATA_JSON_BYTES: number = 2048;

/**
 * Deeper metadata is refused before anything walks it. JSON.parse reads any depth in a loop, but a schema's validation
 * and JSON.stringify recurse, so depth alone, in a body far under the size cap, could overflow the stack (M11-R42).
 */
const MAX_METADATA_DEPTH = 32;

const invalidMetadata = (message: string): CloudropError => new CloudropError("INVALID_METADATA", message);

/** Whether parsed JSON has a value inside more than `limit` nested arrays and objects. A loop, one level per turn. */
function nestsDeeperThan(value: unknown, limit: number): boolean {
  let level = [value];
  for (let depth = 0; depth <= limit && level.length > 0; depth++) {
    level = level.flatMap((item) => (item && typeof item === "object" ? Object.values(item) : []));
  }
  return level.length > 0;
}

/** Control characters, Unicode line and paragraph separators, and bidi overrides and isolates (Trojan Source). */
const UNSAFE_IN_LOGS = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/**
 * The first issue for the client: the message with its path, cut to 200 characters. Both can echo the client's own
 * input (a record key, a received value), so characters that break or reorder a log line become spaces.
 */
function describeIssue(issue: StandardIssue): string {
  const path = (issue.path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment));
  const text = path.length > 0 ? `${String(issue.message)} (at ${path.join(".")})` : String(issue.message);
  return Array.from(text.replace(UNSAFE_IN_LOGS, " ")).slice(0, 200).join("");
}

/**
 * The schema's output for `value` (what the route's callbacks see) and its JSON (what the token carries), checked to
 * fit in a token. The JSON is measured once and returned, because a `toJSON` may answer differently the next time it
 * runs. A route without a schema takes no metadata. A schema that throws, or whose output has no JSON form, is a server
 * bug: the error escapes to the handler, which answers SERVER_ERROR.
 */
export async function validateMetadata(
  schema: StandardSchema | undefined,
  value: unknown,
): Promise<Result<{ value: unknown; json: string | undefined }>> {
  if (schema === undefined) {
    return value === undefined
      ? ok({ value: undefined, json: undefined })
      : fail(invalidMetadata("This upload takes no metadata. Remove it."));
  }
  if (nestsDeeperThan(value, MAX_METADATA_DEPTH)) {
    return fail(invalidMetadata("The metadata is nested more than 32 levels deep. Send a flatter value."));
  }
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    const first = result.issues[0];
    const detail = first ? `: ${describeIssue(first)}` : "";
    return fail(invalidMetadata(`The metadata is not valid${detail}. Correct it and try again.`));
  }
  const json = JSON.stringify(result.value);
  // A function or symbol would vanish from the token while the server treats the metadata as validated.
  if (json === undefined && result.value !== undefined) {
    throw new TypeError(
      "The metadata schema returned a value with no JSON form, such as a function. Return plain data from the schema.",
    );
  }
  if (json !== undefined && new TextEncoder().encode(json).length > MAX_METADATA_JSON_BYTES) {
    return fail(
      invalidMetadata("The metadata is larger than 2 KiB. Send less, and keep large values in your database."),
    );
  }
  return ok({ value: result.value, json });
}
