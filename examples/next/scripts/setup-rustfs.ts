// Prepares the local RustFS bucket this example uploads to: `bun run setup:rustfs` (README.md). Run it after
// `scripts/rustfs.sh up`; it is safe to run again. One line per step, never a secret.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { AwsClient } from "aws4fetch";

const PAGE_ORIGIN = "http://localhost:5173";
const ORIGINS = [PAGE_ORIGIN, "http://127.0.0.1:5173"];
// The headers cloudrop's signed PUTs carry; `checkBucket` reports a rule that omits one.
const UPLOAD_HEADERS = ["content-type", "content-disposition", "if-none-match", "x-amz-meta-cloudrop-id"];
// Browsers hide answer headers a rule does not expose: the client reads ETag, and Retry-After to wait as long as a busy
// bucket asks (without it, a retry waits its own backoff only).
const EXPOSED_HEADERS = ["ETag", "Retry-After"];

const endpoint = process.env.CLOUDROP_S3_ENDPOINT || "http://127.0.0.1:19000";
const bucket = "cloudrop-example";
// The keys scripts/rustfs.sh starts RustFS with.
const accessKeyId = "cloudrop-test";
const secretAccessKey = "cloudrop-test-secret";
const bucketUrl = `${endpoint}/${bucket}`;
const aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "us-east-1" });

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

/** S3 requires Content-MD5 on both bucket configuration PUTs. */
function putBucketConfig(query: string, xml: string): Promise<Response> {
  const headers = { "content-md5": createHash("md5").update(xml).digest("base64"), "content-type": "application/xml" };
  return aws.fetch(`${bucketUrl}?${query}`, { method: "PUT", body: xml, headers });
}

const created = await aws.fetch(bucketUrl, { method: "PUT" }).catch(() => undefined);
if (!created) stop(`Could not reach RustFS at ${endpoint}. Start it with scripts/rustfs.sh up.`);
// 409, or 200 from RustFS, when the bucket already exists.
if (!created.ok && created.status !== 409) stop(`RustFS refused to create bucket ${bucket} (HTTP ${created.status}).`);
console.log(`Bucket ${bucket} is ready`);

const cors = await putBucketConfig(
  "cors",
  "<CORSConfiguration><CORSRule>" +
    ORIGINS.map((origin) => `<AllowedOrigin>${origin}</AllowedOrigin>`).join("") +
    ["PUT", "GET", "HEAD"].map((method) => `<AllowedMethod>${method}</AllowedMethod>`).join("") +
    UPLOAD_HEADERS.map((header) => `<AllowedHeader>${header}</AllowedHeader>`).join("") +
    EXPOSED_HEADERS.map((header) => `<ExposeHeader>${header}</ExposeHeader>`).join("") +
    "</CORSRule></CORSConfiguration>",
);
if (!cors.ok) stop(`RustFS refused the CORS rule (HTTP ${cors.status}).`);
console.log("CORS rule set");

// RustFS answers a preflight 200 even without a rule, so only the allow-origin header proves the rule works.
const preflight = await fetch(`${bucketUrl}/setup-check`, {
  method: "OPTIONS",
  headers: {
    origin: PAGE_ORIGIN,
    "access-control-request-method": "PUT",
    "access-control-request-headers": "content-type,if-none-match,x-amz-meta-cloudrop-id,content-disposition",
  },
});
if (!preflight.ok || preflight.headers.get("access-control-allow-origin") !== PAGE_ORIGIN) {
  stop("RustFS did not accept the CORS rule: browsers cannot upload to it. See examples/next/README.md.");
}
console.log(`Preflight from ${PAGE_ORIGIN} allowed`);

const lifecycle = await putBucketConfig(
  "lifecycle",
  "<LifecycleConfiguration><Rule><ID>cloudrop-abort-incomplete</ID><Filter><Prefix></Prefix></Filter>" +
    "<Status>Enabled</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation>" +
    "</AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>",
);
if (lifecycle.ok) console.log("Lifecycle rule set");
else {
  console.log(
    `RustFS did not accept the lifecycle rule (HTTP ${lifecycle.status}); the dev server will warn about it. ` +
      "Uploads work without it.",
  );
}

const envFile = new URL("../.env.local", import.meta.url);
if (process.env.CLOUDROP_SETUP_ENV_FILE === "0") {
  console.log("Skipped .env.local (CLOUDROP_SETUP_ENV_FILE=0)");
} else if (existsSync(envFile)) {
  console.log("Kept the existing .env.local");
} else {
  const settings = {
    CLOUDROP_SECRET: randomBytes(32).toString("base64"),
    CLOUDROP_S3_ENDPOINT: endpoint,
    CLOUDROP_S3_REGION: "us-east-1",
    CLOUDROP_S3_BUCKET: bucket,
    CLOUDROP_S3_ACCESS_KEY_ID: accessKeyId,
    CLOUDROP_S3_SECRET_ACCESS_KEY: secretAccessKey,
  };
  const lines = Object.entries(settings).map(([name, value]) => `${name}=${value}\n`);
  writeFileSync(envFile, lines.join(""), { mode: 0o600 });
  console.log("Wrote .env.local");
}
