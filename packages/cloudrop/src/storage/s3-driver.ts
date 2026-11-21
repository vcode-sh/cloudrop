import type { StorageRules } from "../rules.ts";
import type { FetchLike, StorageDriver } from "./driver.ts";
import { bucketSettingsMethods } from "./s3/bucket-settings.ts";
import { bucketWriteMethods } from "./s3/bucket-writes.ts";
import { createContext } from "./s3/context.ts";
import { copyMethods } from "./s3/copy.ts";
import { multipartMethods } from "./s3/multipart.ts";
import { objectMethods } from "./s3/objects.ts";
import { presignMethods } from "./s3/presign.ts";
import { checkBaseUrl } from "./s3/settings.ts";
import type { Credentials } from "./sigv4.ts";

export interface S3DriverConfig {
  /**
   * An http or https URL with no query or fragment, such as "https://<account>.r2.cloudflarestorage.com". A path is
   * kept as a prefix of every request.
   */
  endpoint: string;
  region: string;
  bucket: string;
  credentials: Credentials;
  rules: StorageRules;
  publicUrl?: string;
  fetch?: FetchLike;
  /** Clock for signing; tests use it to produce expired URLs. */
  now?: () => Date;
}

/** A driver with the optional bucket-settings writes. */
export type S3Driver = StorageDriver & Required<Pick<StorageDriver, "putBucketCors" | "putBucketLifecycle">>;

export function createS3Driver(config: S3DriverConfig): StorageDriver {
  const ctx = createContext(config);
  const publicUrl =
    config.publicUrl === undefined
      ? undefined
      : // Trailing slashes dropped so callers can append "/<key>".
        checkBaseUrl(config.publicUrl, "publicUrl", "https://cdn.example.com/files").href.replace(/\/+$/, "");
  const objects = objectMethods(ctx);
  const multipart = multipartMethods(ctx);
  return {
    rules: ctx.rules,
    publicUrl,
    ...presignMethods(ctx),
    ...bucketSettingsMethods(ctx),
    ...multipart,
    ...objects,
    ...copyMethods(ctx, { head: objects.head, ...multipart }),
  };
}

/**
 * createS3Driver with the bucket-settings writes, for the cloudrop command and the storage contract. A function of its
 * own so that the writes stay out of an app's server bundle: r2() and s3() do not include them (M9-C4).
 */
export function createS3DriverWithWrites(config: S3DriverConfig): S3Driver {
  return { ...createS3Driver(config), ...bucketWriteMethods(createContext(config)) };
}
