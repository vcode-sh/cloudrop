// The chaos proxy as the `*.chaos.browser.test.ts` rows see it: scripts/test-browser.sh starts it between the example's
// server and RustFS and passes its control endpoint here. `test` clears the rules and the log before each row and the
// rules after it, so no fault outlives its row, and notes the multipart uploads already open, so a row can name the
// ones it left. Those are read from RustFS itself, past the proxy, so the reads stay out of the log the rows assert.
import { test as base } from "@playwright/test";
import { AwsClient } from "aws4fetch";
import type { ChaosEntry, ChaosRule } from "../../../packages/cloudrop/src/testing/chaos-proxy.ts";

export type { ChaosEntry, ChaosRule };

const { CLOUDROP_CHAOS_CONTROL_URL: controlUrl, CLOUDROP_RUSTFS_PORT: rustfsPort } = process.env;
if (!controlUrl || !rustfsPort)
  throw new Error(
    "CLOUDROP_CHAOS_CONTROL_URL or CLOUDROP_RUSTFS_PORT is not set. Run the chaos rows through `bun run test:browser`, which starts the proxy and RustFS.",
  );

// The settings scripts/test-browser.sh exports for the example: its bucket, its test keys and the run's prefix.
const bucketUrl = `http://127.0.0.1:${rustfsPort}/${process.env.CLOUDROP_S3_BUCKET}`;
const rustfs = new AwsClient({
  accessKeyId: process.env.CLOUDROP_S3_ACCESS_KEY_ID ?? "",
  secretAccessKey: process.env.CLOUDROP_S3_SECRET_ACCESS_KEY ?? "",
  service: "s3",
  region: "us-east-1",
});

/** The keys of the multipart uploads open under the run's prefix, as ListMultipartUploads names them. */
async function openUploads(): Promise<string[]> {
  const url = new URL(bucketUrl);
  url.searchParams.set("uploads", "");
  url.searchParams.set("prefix", `${process.env.CLOUDROP_EXAMPLE_PREFIX}/`);
  const response = await rustfs.fetch(url);
  if (!response.ok) throw new Error(`ListMultipartUploads on RustFS failed with HTTP ${response.status}.`);
  const text = await response.text();
  return [...text.matchAll(/<Upload>[\s\S]*?<Key>([^<]*)<\/Key>/g)].map((match) => match[1] ?? "");
}

async function control(route: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${controlUrl}${route}`, {
    method: route === "/log" ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`The chaos proxy refused ${route} (HTTP ${response.status}): ${await response.text()}`);
  return response;
}

export interface Chaos {
  /** Replaces the proxy's rules and their counters. */
  set(rules: ChaosRule[]): Promise<void>;
  /** What reached the proxy, in start order: requests that ended, and black-holed ones still held. */
  log(): Promise<ChaosEntry[]>;
  /** The keys of the multipart uploads this row opened that are still open: [] once every file ended `done`. */
  uploadsLeft(): Promise<string[]>;
}

export const test = base.extend<{ chaos: Chaos }>({
  chaos: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this pattern; it has none.
    async ({}, use) => {
      await control("/rules", []);
      await control("/clear-log");
      // Earlier rows may leave uploads by design, such as a failed file's or a first ticket's (M3-U55).
      const before = new Set(await openUploads());
      await use({
        set: async (rules) => void (await control("/rules", rules)),
        log: async () => (await control("/log")).json(),
        uploadsLeft: async () => (await openUploads()).filter((key) => !before.has(key)),
      });
      await control("/rules", []);
      // A held request would keep its socket open into the next row.
      await control("/release");
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";

/** The presigned PUTs that reached the proxy, as [label, outcome], in start order. */
export const bucketPuts = (log: readonly ChaosEntry[]): [string, ChaosEntry["outcome"]][] =>
  log.filter((entry) => entry.kind === "presigned").map((entry) => [entry.label, entry.outcome]);
