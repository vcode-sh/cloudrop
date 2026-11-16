// What plain JavaScript can get wrong in upload() and start(), refused before any request (S17, ruling S-2).

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";

export interface Arguments {
  route: string;
  files: File[];
  metadata: unknown;
  signal: AbortSignal;
}

/** A list of files as a caller passes it: an array, `input.files`, or any other object with a numeric `length`. */
export const isList = (value: unknown): value is ArrayLike<unknown> =>
  typeof value === "object" && value !== null && "length" in value && typeof value.length === "number";

const refuse = (message: string) => fail(invalidInput(message));

function encodesAsJson(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function readFiles(files: unknown): Result<File[]> {
  if (files instanceof File) return ok([files]);
  if (!isList(files)) return refuse('Pass the file as a File, such as one from <input type="file">.');
  const list = Array.from(files);
  if (!list.every((file) => file instanceof File)) {
    return refuse('Pass the files as File objects, such as input.files from <input type="file" multiple>.');
  }
  return list.length === 0 ? refuse("Pass at least one file to upload.") : ok(list);
}

export function readArguments(route: unknown, files: unknown, options: unknown): Result<Arguments> {
  if (typeof route !== "string" || route === "") {
    return refuse('Name the upload route as text, such as upload("avatar", file).');
  }
  const read = readFiles(files);
  if (read.error) return read;
  if (options !== undefined && !isPlainObject(options)) {
    return refuse("Pass the upload options as an object, such as { metadata, signal }.");
  }
  // A signal per call, not one module-level object: the package declares sideEffects: false.
  const { metadata, signal = new AbortController().signal } = options ?? {};
  if (!(signal instanceof AbortSignal)) {
    return refuse("options.signal must be an AbortSignal, such as new AbortController().signal.");
  }
  // Retrying cannot fix a BigInt or a cycle, so it is the caller's mistake, not a network failure.
  if (!encodesAsJson(metadata)) {
    return refuse(
      "options.metadata must be JSON data, such as objects, strings and numbers: it holds a value JSON cannot encode, such as a BigInt or a circular reference.",
    );
  }
  return ok({ route, files: read.data, metadata, signal });
}
