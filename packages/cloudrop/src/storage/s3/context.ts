import { configError } from "../../errors.ts";
import type { StorageRules } from "../../rules.ts";
import type { FetchLike } from "../driver.ts";
import type { S3DriverConfig } from "../s3-driver.ts";
import { type Credentials, encodeKeyPath, encodeRfc3986 } from "../sigv4.ts";
import { checkBaseUrl, checkSigningSettings } from "./settings.ts";

/** What every operation of one driver shares. Internal to the storage layer; the package never exports it. */
export interface S3Context {
  readonly http: FetchLike;
  readonly now: () => Date;
  /** One credentials object for the driver's lifetime: sigv4 caches signing keys per object. */
  readonly credentials: Credentials;
  readonly region: string;
  readonly rules: StorageRules;
  readonly bucket: string;
  /** The endpoint with its path prefix, then the encoded bucket name. */
  readonly bucketUrl: string;
}

/** Checks the fetch option, the signing settings and the endpoint, in that order, and throws INVALID_CONFIG. */
export function createContext(config: S3DriverConfig): S3Context {
  const http: FetchLike = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  if (typeof http !== "function") {
    throw configError(
      "The fetch option must be a function, such as globalThis.fetch. Omit it to use the global fetch.",
    );
  }
  checkSigningSettings(config);
  const now = config.now ?? (() => new Date());
  const { credentials, region, rules } = config;
  const endpoint = checkBaseUrl(config.endpoint, "storage endpoint", "https://<account ID>.r2.cloudflarestorage.com");
  const bucketUrl = `${endpoint.origin}${endpoint.pathname.replace(/\/$/, "")}/${encodeRfc3986(config.bucket)}`;
  return { http, now, credentials, region, rules, bucket: config.bucket, bucketUrl };
}

export function objectUrl(ctx: S3Context, key: string, query: Record<string, string> = {}): URL {
  const url = new URL(`${ctx.bucketUrl}/${encodeKeyPath(key)}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}
