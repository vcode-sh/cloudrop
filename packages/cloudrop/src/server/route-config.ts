// One route's options, checked once at construction. The first mistake found is the one reported.

import { configError } from "../errors.ts";
import type { StorageDriver } from "../storage/driver.ts";
import { formatBytes } from "../storage/validate.ts";
import { isAcceptEntry } from "./accept.ts";
import type { RouteConfig } from "./config.ts";
import type { Route, RouteDefinition } from "./route.ts";
import { parseSize } from "./size.ts";

const MAX_FILES_LIMIT = 100;
const DEFAULT_MAX_FILES = 10;

export const isFunction = (value: unknown): boolean => typeof value === "function";

function readAccept(where: string, definition: RouteDefinition): string[] {
  const accept = [definition.accept].flat();
  if (accept.length === 0 || !accept.every((entry) => typeof entry === "string" && isAcceptEntry(entry))) {
    throw configError(`${where}: accept takes MIME types in lower case, such as "image/png", "image/*" or "*/*".`);
  }
  return accept;
}

function readMaxSize(where: string, definition: RouteDefinition, storage: StorageDriver): number {
  const maxSize = parseSize(definition.maxSize);
  const limit = storage.rules.maxObjectSize;
  if (maxSize === null || maxSize < 1 || maxSize > limit) {
    throw configError(`${where}: maxSize must be between 1 byte and ${formatBytes(limit)}, such as 5242880 or "5MB".`);
  }
  return maxSize;
}

function readMaxFiles(where: string, definition: RouteDefinition): number {
  if (definition.replace === true) {
    if (definition.maxFiles !== undefined && definition.maxFiles !== 1) {
      throw configError(`${where}: replace keeps one file per owner, so maxFiles must be 1. Leave maxFiles out.`);
    }
    return 1;
  }
  const maxFiles = definition.maxFiles ?? DEFAULT_MAX_FILES;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES_LIMIT) {
    throw configError(`${where}: maxFiles must be a whole number from 1 to ${MAX_FILES_LIMIT}.`);
  }
  return maxFiles;
}

function checkCallbacks(where: string, definition: RouteDefinition): void {
  if (definition.metadata !== undefined && !isFunction(definition.metadata?.["~standard"]?.validate)) {
    throw configError(`${where}: metadata must be a Standard Schema, such as a zod, valibot or arktype schema.`);
  }
  for (const option of ["prefix", "key", "owner", "onComplete", "afterComplete"] as const) {
    if (definition[option] !== undefined && !isFunction(definition[option])) {
      throw configError(`${where}: ${option} must be a function.`);
    }
  }
  if (definition.prefix && definition.key) {
    throw configError(`${where}: pass prefix or key, not both. key builds the whole key; prefix only its folder.`);
  }
}

function readVisibility(where: string, definition: RouteDefinition, storage: StorageDriver): RouteConfig["visibility"] {
  const visibility = definition.visibility ?? (storage.publicUrl ? "public" : "private");
  if (visibility !== "public" && visibility !== "private") {
    throw configError(`${where}: visibility must be "public" or "private".`);
  }
  if (visibility === "public" && !storage.publicUrl) {
    throw configError(
      `${where} is public, but the storage has no publicUrl. Pass publicUrl to the storage preset, or make the route private.`,
    );
  }
  return visibility;
}

export function readRoute(name: string, route: Route, storage: StorageDriver): RouteConfig {
  const where = `Route "${name}"`;
  const definition = (route as Partial<Route> | null)?.definition;
  if (typeof definition !== "object" || definition === null) {
    throw configError(`${where} is not a route. Wrap its options in route({ ... }).`);
  }
  if (!isFunction(definition.authorize)) {
    throw configError(`${where} needs authorize. Use authorize: allowAnyone for a route anyone may upload to.`);
  }
  if (definition.replace !== undefined && typeof definition.replace !== "boolean") {
    throw configError(`${where}: replace must be true or false.`);
  }
  const accept = readAccept(where, definition);
  const maxSize = readMaxSize(where, definition, storage);
  const maxFiles = readMaxFiles(where, definition);
  checkCallbacks(where, definition);
  const visibility = readVisibility(where, definition, storage);
  return { name, definition, accept, maxSize, maxFiles, visibility, replace: definition.replace === true };
}
