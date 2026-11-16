// In-process fake of the R2 S3 API with the behaviour measured on real R2 (docs/research/r2-spike-findings.md).
// It re-signs requests with cloudrop's own signer, so it proves R2's rules (signed headers, expiry, part sizes),
// never the signer itself: sigv4.test.ts (AWS vectors, aws4fetch) and the RustFS, Wrangler and R2 lanes do that.

import type { FetchLike } from "../storage/driver.ts";
import type { Credentials } from "../storage/sigv4.ts";
import type { Bytes, FakeBucket, FakeRequest } from "./fake-r2/bucket.ts";
import { bucketConfig, copy } from "./fake-r2/copy.ts";
import { abortUpload, completeUpload, createUpload, listParts, uploadPart } from "./fake-r2/multipart.ts";
import { deleteObject, getObject, listObjects, putObject } from "./fake-r2/objects.ts";
import { errorResponse } from "./fake-r2/responses.ts";
import { verifySignature } from "./fake-r2/signature.ts";

export interface FakeR2Options {
  bucket: string;
  credentials: Credentials;
  now?: () => Date;
  /**
   * The CORS and lifecycle XML the bucket serves; a missing entry answers 404 as a bucket without that configuration.
   * Without this option, both reads answer 403 AccessDenied, as they do for an R2 object token (spike Q8).
   */
  bucketConfig?: { cors?: string; lifecycle?: string };
}

export interface FakeR2 {
  fetch: FetchLike;
  pendingUploads(): number;
}

interface Route {
  matches(request: FakeRequest): boolean;
  run(bucket: FakeBucket, request: FakeRequest): Response | Promise<Response>;
}

const isBucketGet = (request: FakeRequest): boolean => request.method === "GET" && request.key === "";

// The first route that matches answers, so the order is part of the behaviour: a PUT with x-amz-copy-source is a copy
// before it is a part or an object, and a request naming an upload is a multipart call before it is an object call.
const ROUTES: Route[] = [
  { matches: (r) => isBucketGet(r) && r.query.get("list-type") === "2", run: listObjects },
  { matches: (r) => isBucketGet(r) && r.query.has("cors"), run: (bucket) => bucketConfig(bucket, "cors") },
  { matches: (r) => isBucketGet(r) && r.query.has("lifecycle"), run: (bucket) => bucketConfig(bucket, "lifecycle") },
  { matches: (r) => r.method === "POST" && r.query.has("uploads"), run: createUpload },
  { matches: (r) => r.method === "PUT" && r.headers.has("x-amz-copy-source"), run: copy },
  { matches: (r) => r.method === "PUT" && r.query.has("uploadId"), run: uploadPart },
  { matches: (r) => r.method === "POST" && r.query.has("uploadId"), run: completeUpload },
  { matches: (r) => r.method === "GET" && r.query.has("uploadId"), run: listParts },
  { matches: (r) => r.method === "DELETE" && r.query.has("uploadId"), run: abortUpload },
  { matches: (r) => r.method === "PUT", run: putObject },
  { matches: (r) => r.method === "GET" || r.method === "HEAD", run: getObject },
  { matches: (r) => r.method === "DELETE", run: deleteObject },
];

export function createFakeR2(options: FakeR2Options): FakeR2 {
  const bucket: FakeBucket = {
    name: options.bucket,
    credentials: options.credentials,
    now: options.now ?? (() => new Date()),
    config: options.bucketConfig,
    objects: new Map(),
    uploads: new Map(),
    listTokens: new Map(),
    uploadCounter: 0,
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, bucketSegment = "", ...keySegments] = url.pathname.split("/");
    if (decodeURIComponent(bucketSegment) !== bucket.name) {
      return errorResponse(404, "NoSuchBucket", "The specified bucket does not exist.");
    }
    const key = keySegments.map(decodeURIComponent).join("/");
    const body: Bytes = new Uint8Array(await request.arrayBuffer());
    const denied = await verifySignature(bucket, request, url, body);
    if (denied) return denied;

    const verified: FakeRequest = {
      method: request.method,
      key,
      query: url.searchParams,
      headers: request.headers,
      body,
    };
    const route = ROUTES.find((candidate) => candidate.matches(verified));
    if (route) return route.run(bucket, verified);
    return errorResponse(501, "NotImplemented", `${request.method} is not implemented by the fake.`);
  }

  return {
    fetch: (input, init) => handle(new Request(input, init)),
    pendingUploads: () => bucket.uploads.size,
  };
}
