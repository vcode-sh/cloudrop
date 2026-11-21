// A preset whose settings come from the environment builds its driver on first use, not at construction, so a build
// with no secrets (next build) can import the server. Until the settings are complete every call answers INVALID_CONFIG
// and the next call reads the environment again; once a driver is built it is kept.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import type { StorageDriver } from "./driver.ts";
import type { S3Driver } from "./s3-driver.ts";

type Build = () => S3Driver;

/**
 * A read of settings from the environment, which throws INVALID_CONFIG, as a Result: such a setting is reported on
 * first use, not thrown at construction. Any other throw is a bug and escapes.
 */
export function readSetting<T>(read: () => T): Result<T> {
  try {
    return ok(read());
  } catch (error) {
    if (error instanceof CloudropError) return fail(error);
    throw error;
  }
}

/** The server reads a lazy driver's settings on the first request, before any endpoint runs. */
const builders = new WeakMap<StorageDriver, () => Result<StorageDriver>>();

/** INVALID_CONFIG when a lazy driver's environment settings are still missing or invalid; null otherwise. */
export function storageSettingsProblem(storage: StorageDriver): CloudropError | null {
  return builders.get(storage)?.().error ?? null;
}

/** `checked` was built from the explicit options with stand-ins for the environment: it lends its rules and publicUrl. */
export function lazyDriver(checked: StorageDriver, build: Build): S3Driver {
  let built: S3Driver | undefined;
  const resolve = (): Result<S3Driver> => readSetting(() => (built ??= build()));
  const use = async <T>(call: (driver: S3Driver) => Promise<Result<T>>): Promise<Result<T>> => {
    const resolved = resolve();
    return resolved.error ? resolved : call(resolved.data);
  };
  const lazy: S3Driver = {
    rules: checked.rules,
    publicUrl: checked.publicUrl,
    presignPut: (...args) => use((driver) => driver.presignPut(...args)),
    createMultipart: (...args) => use((driver) => driver.createMultipart(...args)),
    presignPart: (...args) => use((driver) => driver.presignPart(...args)),
    listParts: (...args) => use((driver) => driver.listParts(...args)),
    completeMultipart: (...args) => use((driver) => driver.completeMultipart(...args)),
    abortMultipart: (...args) => use((driver) => driver.abortMultipart(...args)),
    presignGet: (...args) => use((driver) => driver.presignGet(...args)),
    getBucketCors: () => use((driver) => driver.getBucketCors()),
    getBucketLifecycle: () => use((driver) => driver.getBucketLifecycle()),
    putBucketCors: (rules) => use((driver) => driver.putBucketCors(rules)),
    putBucketLifecycle: (rules) => use((driver) => driver.putBucketLifecycle(rules)),
    head: (...args) => use((driver) => driver.head(...args)),
    getRange: (...args) => use((driver) => driver.getRange(...args)),
    put: (...args) => use((driver) => driver.put(...args)),
    copy: (...args) => use((driver) => driver.copy(...args)),
    delete: (...args) => use((driver) => driver.delete(...args)),
    deleteMany: (...args) => use((driver) => driver.deleteMany(...args)),
    list: (...args) => use((driver) => driver.list(...args)),
  };
  builders.set(lazy, resolve);
  return lazy;
}
