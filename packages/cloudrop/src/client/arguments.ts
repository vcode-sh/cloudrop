// What plain JavaScript can get wrong in upload() and start(), refused before any request (S17, ruling S-2).

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";

export interface Arguments {
  route: string;
  files: File[];
  metadata: unknown;
  signal: AbortSignal;
}

/**
 * What `read` returns, or undefined when it threw: reading a caller's value runs the caller's code (a getter, a proxy),
 * and its throw must not leave a call that answers with an error (M11-R84).
 */
export function tryRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** A list of files as a caller passes it: an array, `input.files`, or any other object with a numeric `length`. */
export const isList = (value: unknown): value is ArrayLike<unknown> =>
  tryRead(
    () => typeof value === "object" && value !== null && "length" in value && typeof value.length === "number",
  ) === true;

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
  // Read one by one and refused at the first that is no File, never copied first: Array.from throws for a length of
  // Infinity or 2 ** 32 and runs out of memory just below it (M11-R84).
  const list: File[] = [];
  const { length } = files;
  for (let index = 0; index < length; index++) {
    const file = files[index];
    if (!(file instanceof File)) {
      return refuse('Pass the files as File objects, such as input.files from <input type="file" multiple>.');
    }
    list.push(file);
  }
  return list.length === 0 ? refuse("Pass at least one file to upload.") : ok(list);
}

function read(route: unknown, files: unknown, options: unknown): Result<Arguments> {
  if (typeof route !== "string" || route === "") {
    return refuse('Name the upload route as text, such as upload("avatar", file).');
  }
  const listed = readFiles(files);
  if (listed.error) return listed;
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
  return ok({ route, files: listed.data, metadata, signal });
}

export function readArguments(route: unknown, files: unknown, options: unknown): Result<Arguments> {
  return (
    tryRead(() => read(route, files, options)) ??
    refuse("An argument threw an error while it was read. Pass plain values: a route name, File objects and options.")
  );
}
