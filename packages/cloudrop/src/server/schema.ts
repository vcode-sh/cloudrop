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

const invalidMetadata = (message: string): CloudropError =>
  new CloudropError("INVALID_METADATA", message, { status: 400 });

/**
 * The first issue for the client: the message with its path, cut to 200 characters. Both can echo the client's own
 * input (a record key, a received value), so line breaks and other control characters become spaces.
 */
function describeIssue(issue: StandardIssue): string {
  const path = (issue.path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment));
  const text = path.length > 0 ? `${String(issue.message)} (at ${path.join(".")})` : String(issue.message);
  return Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
  })
    .slice(0, 200)
    .join("");
}

/**
 * The schema's output for `value`, checked to fit in a token as JSON. A route without a schema takes no metadata.
 * A schema that throws is a server bug: the error escapes to the handler, which answers SERVER_ERROR.
 */
export async function validateMetadata(schema: StandardSchema | undefined, value: unknown): Promise<Result<unknown>> {
  if (schema === undefined) {
    return value === undefined ? ok(undefined) : fail(invalidMetadata("This upload takes no metadata. Remove it."));
  }
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    const first = result.issues[0];
    const detail = first ? `: ${describeIssue(first)}` : "";
    return fail(invalidMetadata(`The metadata is not valid${detail}. Correct it and try again.`));
  }
  const json = JSON.stringify(result.value);
  if (json !== undefined && new TextEncoder().encode(json).length > MAX_METADATA_JSON_BYTES) {
    return fail(
      invalidMetadata("The metadata is larger than 2 KiB. Send less, and keep large values in your database."),
    );
  }
  return ok(result.value);
}
