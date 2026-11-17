// Prepares the local RustFS bucket and settings for this example: `bun run setup:rustfs` (README.md). Run it after
// `scripts/rustfs.sh up`; it is safe to run again. One line per step, never a secret.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { AwsClient } from "aws4fetch";

// The bytes leave from the web app, so the bucket's CORS rule names its origin, never the API's (5181).
const WEB_ORIGIN = "http://localhost:5173";
const ORIGINS = [WEB_ORIGIN, "http://127.0.0.1:5173"];
// The headers cloudrop's signed PUTs carry; the server's bucket check reports a rule that omits one.
const UPLOAD_HEADERS = ["content-type", "content-disposition", "if-none-match", "x-amz-meta-cloudrop-id"];
// The client reads ETag, and waits as long as Retry-After asks when the bucket is busy.
const EXPOSED_HEADERS = ["ETag", "Retry-After"];

const endpoint = process.env.CLOUDROP_S3_ENDPOINT || "http://127.0.0.1:19000";
const bucket = process.env.CLOUDROP_S3_BUCKET || "cloudrop-example-hono";
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

const tags = (name: string, values: string[]) => values.map((value) => `<${name}>${value}</${name}>`).join("");
const cors = await putBucketConfig(
  "cors",
  `<CORSConfiguration><CORSRule>${tags("AllowedOrigin", ORIGINS)}${tags("AllowedMethod", ["PUT", "GET", "HEAD"])}` +
    `${tags("AllowedHeader", UPLOAD_HEADERS)}${tags("ExposeHeader", EXPOSED_HEADERS)}</CORSRule></CORSConfiguration>`,
);
if (!cors.ok) stop(`RustFS refused the CORS rule (HTTP ${cors.status}).`);
// RustFS answers a preflight 200 even without a rule, so only the allow-origin header proves the rule works.
const preflight = await fetch(`${bucketUrl}/setup-check`, {
  method: "OPTIONS",
  headers: {
    origin: WEB_ORIGIN,
    "access-control-request-method": "PUT",
    "access-control-request-headers": UPLOAD_HEADERS.join(","),
  },
});
if (preflight.headers.get("access-control-allow-origin") !== WEB_ORIGIN) {
  stop("RustFS did not accept the CORS rule: browsers cannot upload to it. See examples/hono/README.md.");
}
console.log(`CORS rule set; a preflight from ${WEB_ORIGIN} is allowed`);

const lifecycle = await putBucketConfig(
  "lifecycle",
  "<LifecycleConfiguration><Rule><ID>abort-incomplete-uploads</ID><Filter><Prefix></Prefix></Filter>" +
    "<Status>Enabled</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation>" +
    "</AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>",
);
console.log(
  lifecycle.ok
    ? "Lifecycle rule set"
    : `RustFS did not accept the lifecycle rule (HTTP ${lifecycle.status}); uploads work without it.`,
);

const envFile = new URL("../.env", import.meta.url);
if (process.env.CLOUDROP_SETUP_ENV_FILE === "0") {
  console.log("Skipped .env (CLOUDROP_SETUP_ENV_FILE=0)");
} else if (existsSync(envFile)) {
  console.log("Kept the existing .env");
} else {
  const postgresPort = process.env.CLOUDROP_EXAMPLE_POSTGRES_PORT || "19600";
  const settings = {
    // The credentials scripts/postgres.sh starts the container with.
    DATABASE_URL: `postgres://cloudrop:cloudrop-example@127.0.0.1:${postgresPort}/cloudrop_example`,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
    CLOUDROP_SECRET: randomBytes(32).toString("base64"),
    CLOUDROP_S3_ENDPOINT: endpoint,
    CLOUDROP_S3_REGION: "us-east-1",
    CLOUDROP_S3_BUCKET: bucket,
    CLOUDROP_S3_ACCESS_KEY_ID: accessKeyId,
    CLOUDROP_S3_SECRET_ACCESS_KEY: secretAccessKey,
  };
  const lines = Object.entries(settings).map(([name, value]) => `${name}=${value}\n`);
  writeFileSync(envFile, lines.join(""), { mode: 0o600 });
  console.log("Wrote .env");
}
