// A cloudrop server on the in-process fake R2, for the server's unit tests. Requests go through cloudrop.handler, the
// entry point every framework adapter calls.

import type { FileDescriptor, FileTicket, MultipartTicket, SingleTicket, UploadResponse } from "../protocol/types.ts";
import { type Cloudrop, createCloudrop } from "../server/cloudrop.ts";
import type { CloudropOptions } from "../server/config.ts";
import type { Logger } from "../server/plugins.ts";
import type { Route } from "../server/route.ts";
import type { FetchLike, StorageDriver } from "../storage/driver.ts";
import { r2 } from "../storage/presets.ts";
import { createFakeR2, type FakeR2, type FakeR2Options } from "./fake-r2.ts";

export const SECRET = "test-secret-0123456789abcdef0123456789";
/** The origin the server is reached at; requests from it are same-origin. */
export const APP_ORIGIN = "https://app.example.com";
export const PUBLIC_URL = "https://cdn.example.com";

const credentials = { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key" };

export interface RecordingLogger extends Logger {
  errors: { message: string; error: unknown }[];
  warnings: string[];
}

export function recordingLogger(): RecordingLogger {
  const errors: { message: string; error: unknown }[] = [];
  const warnings: string[] = [];
  return {
    errors,
    warnings,
    error: (message, error) => {
      errors.push({ message, error });
    },
    warn: (message) => {
      warnings.push(message);
    },
  };
}

export interface ServerFixture {
  fake: FakeR2;
  /** A driver on the same fake bucket, for reading and planting objects behind the server's back. */
  storage: StorageDriver;
  cloudrop: Cloudrop;
  logger: RecordingLogger;
  /** Every request the server sent to storage, as "METHOD path?query-names". */
  storageCalls: string[];
  /** POSTs JSON to an endpoint as a same-origin browser would. */
  post(endpoint: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  /** POSTs /upload with one file and returns its single-PUT ticket; anything else fails the test. */
  single(route: string, file: FileDescriptor): Promise<SingleTicket>;
  /** POSTs /upload with one file and returns its multipart ticket; anything else fails the test. */
  multipart(route: string, file: FileDescriptor): Promise<MultipartTicket>;
  /** Sends a presigned request to the fake bucket, as the browser would. */
  send(signed: { url: string; headers: Record<string, string> }, body: Uint8Array<ArrayBuffer>): Promise<Response>;
}

export function serverFixture<TRoutes extends Record<string, Route>>(
  routes: TRoutes,
  options: Omit<Partial<CloudropOptions<TRoutes>>, "routes"> & {
    publicUrl?: boolean;
    bucketConfig?: FakeR2Options["bucketConfig"];
  } = {},
): ServerFixture {
  const { publicUrl, bucketConfig, ...rest } = options;
  const fake = createFakeR2({ bucket: "uploads", credentials, bucketConfig });
  const storageCalls: string[] = [];
  const recording: FetchLike = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const names = [...url.searchParams.keys()].filter((name) => !name.startsWith("X-Amz-"));
    storageCalls.push(`${init?.method ?? "GET"} ${url.pathname}${names.length > 0 ? `?${names.join("&")}` : ""}`);
    return fake.fetch(input, init);
  };
  const storage = r2({
    bucket: "uploads",
    accountId: "0123456789abcdef0123456789abcdef",
    ...credentials,
    fetch: recording,
    publicUrl: publicUrl ? PUBLIC_URL : undefined,
  });
  const logger = recordingLogger();
  const cloudrop = createCloudrop({ storage, secret: SECRET, logger, routes, ...rest });
  const post = (endpoint: string, body: unknown, headers: Record<string, string> = {}) =>
    cloudrop.handler(
      new Request(`${APP_ORIGIN}/api/cloudrop/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN, ...headers },
        body: JSON.stringify(body),
      }),
    );
  async function ticket<TKind extends FileTicket["kind"]>(route: string, file: FileDescriptor, kind: TKind) {
    const response = await post("upload", { route, files: [file] });
    const [first] = ((await response.json()) as UploadResponse).files;
    if (first?.kind !== kind) throw new Error(`Expected a ${kind} ticket, got ${JSON.stringify(first)}`);
    return first as Extract<FileTicket, { kind: TKind }>;
  }
  return {
    fake,
    storage,
    cloudrop,
    logger,
    storageCalls,
    post,
    single: (route, file) => ticket(route, file, "single"),
    multipart: (route, file) => ticket(route, file, "multipart"),
    send: (signed, body) => fake.fetch(signed.url, { method: "PUT", headers: signed.headers, body }),
  };
}

/** The JSON payload of an upload token, read the way any client can read it. */
export function tokenPayload(token: string): Record<string, unknown> {
  const [body = ""] = token.split(".");
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(body.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0)),
    ),
  );
}
