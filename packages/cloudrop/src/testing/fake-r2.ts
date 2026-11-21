// In-process fake of the R2 S3 API with the behaviour measured on real R2 (docs/research/r2-spike-findings.md).
// It re-signs requests with cloudrop's own signer, so it proves R2's rules (signed headers, expiry, part sizes),
// never the signer itself: sigv4.test.ts (AWS vectors, aws4fetch) and the RustFS, Wrangler and R2 lanes do that.

import type { FetchLike } from "../storage/driver.ts";
import type { Credentials } from "../storage/sigv4.ts";
import { type Bytes, type FakeBucket, type FakeRequest, objectId, type StoredObject } from "./fake-r2/bucket.ts";
import { bucketConfig, copy, putBucketConfig } from "./fake-r2/copy.ts";
import { corsHeaders, preflight } from "./fake-r2/cors.ts";
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
   * Without this option, both reads answer 403 AccessDenied, as they do for an R2 object token (spike Q8), and so do
   * both writes. A write replaces the fake's copy of the entry, never the object passed here. The CORS XML also
   * answers a browser: a preflight (OPTIONS) and the CORS headers of a request that names an Origin come from its
   * first rule that matches, as on R2.
   */
  bucketConfig?: { cors?: string; lifecycle?: string };
}

export interface FakeR2 {
  fetch: FetchLike;
  /** Multipart uploads created and neither completed nor aborted. */
  pendingUploads(): number;
  /** The object stored under `key`, in either Unicode form, as the bucket holds it: read it, never change it. */
  object(key: string): StoredObject | undefined;
  /** Every stored key as last written, sorted. */
  keys(): string[];
}

interface Route {
  matches(request: FakeRequest): boolean;
  run(bucket: FakeBucket, request: FakeRequest): Response | Promise<Response>;
}

const isBucketGet = (request: FakeRequest): boolean => request.method === "GET" && request.key === "";
const isBucketPut = (request: FakeRequest): boolean => request.method === "PUT" && request.key === "";

// The first route that matches answers, so the order is part of the behaviour: a PUT with x-amz-copy-source is a copy
// before it is a part or an object, and a request naming an upload is a multipart call before it is an object call.
const ROUTES: Route[] = [
  { matches: (r) => isBucketGet(r) && r.query.get("list-type") === "2", run: listObjects },
  { matches: (r) => isBucketGet(r) && r.query.has("cors"), run: (bucket) => bucketConfig(bucket, "cors") },
  { matches: (r) => isBucketGet(r) && r.query.has("lifecycle"), run: (bucket) => bucketConfig(bucket, "lifecycle") },
  { matches: (r) => isBucketPut(r) && r.query.has("cors"), run: (bucket, r) => putBucketConfig(bucket, "cors", r) },
  {
    matches: (r) => isBucketPut(r) && r.query.has("lifecycle"),
    run: (bucket, r) => putBucketConfig(bucket, "lifecycle", r),
  },
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
    config: options.bucketConfig && { ...options.bucketConfig },
    objects: new Map(),
    uploads: new Map(),
    listTokens: new Map(),
    uploadCounter: 0,
  };

  async function handle(request: Request): Promise<Response> {
    const answer = await route(request);
    // R2 dates every answer, and an answer to HEAD has no body, so a refused HEAD carries no S3 error code (measured
    // 2026-11-21: r2-spike-findings.md, "Upload protocol edge cases").
    const headers = new Headers(answer.headers);
    headers.set("date", bucket.now().toUTCString());
    return new Response(request.method === "HEAD" ? null : answer.body, { status: answer.status, headers });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, bucketSegment = "", ...keySegments] = url.pathname.split("/");
    if (decodeURIComponent(bucketSegment) !== bucket.name) {
      return errorResponse(404, "NoSuchBucket", "The specified bucket does not exist.");
    }
    // A browser signs no preflight, so it is answered from the CORS rules alone.
    if (request.method === "OPTIONS") return preflight(bucket, request);
    const key = keySegments.map(decodeURIComponent).join("/");
    const body: Bytes = new Uint8Array(await request.arrayBuffer());
    // R2 sends a request it refuses for its signature or its expiry without CORS headers (spike U2, R1).
    const denied = await verifySignature(bucket, request, url, body);
    if (denied) return denied;

    const verified: FakeRequest = {
      method: request.method,
      key,
      query: url.searchParams,
      headers: request.headers,
      body,
    };
    const matched = ROUTES.find((candidate) => candidate.matches(verified));
    const answer = matched
      ? await matched.run(bucket, verified)
      : errorResponse(501, "NotImplemented", `${request.method} is not implemented by the fake.`);
    for (const [name, value] of Object.entries(corsHeaders(bucket, request))) answer.headers.set(name, value);
    return answer;
  }

  return {
    fetch: (input, init) => handle(new Request(input, init)),
    pendingUploads: () => bucket.uploads.size,
    object: (key) => bucket.objects.get(objectId(key)),
    keys: () => Array.from(bucket.objects.values(), (object) => object.key).sort(),
  };
}
