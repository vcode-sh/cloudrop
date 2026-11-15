// Independent, read-only check that spike prefixes hold no objects and no multipart uploads.
// Usage: bun run verify-empty.ts spike/cloudrop-<hex>/ [...]
import { AwsClient } from "aws4fetch";
import { loadEnv, redact, registerRedactions, s3Host } from "./lib.ts";

const env = loadEnv(process.env.CLOUDROP_R2_ENV_FILE ?? "~/projects/linux-apps/app-d/.env.local");
registerRedactions(env);
const aws = new AwsClient({ accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey, service: "s3", region: "auto", retries: 0 });
const base = `https://${s3Host(env)}/${env.bucket}`;

let failed = false;
for (const prefix of process.argv.slice(2)) {
  if (!/^spike\/cloudrop-[0-9a-f]{32}\/$/.test(prefix)) throw new Error(`Refusing a prefix outside spike/cloudrop-<128-bit hex>/: ${prefix}`);
  const p = encodeURIComponent(prefix);
  const objs = await (await aws.fetch(`${base}?list-type=2&prefix=${p}&max-keys=1000`)).text();
  const ups = await (await aws.fetch(`${base}?uploads&prefix=${p}&max-uploads=1000`)).text();
  const objects = (objs.match(/<Key>/g) ?? []).length;
  const uploads = (ups.match(/<Upload>/g) ?? []).length;
  const truncated = /<IsTruncated>true/.test(objs) || /<IsTruncated>true/.test(ups);
  const ok = objs.includes("<ListBucketResult") && ups.includes("<ListMultipartUploadsResult");
  if (!ok || objects || uploads || truncated) failed = true;
  console.log(redact(`${prefix} objects=${objects} multipart_uploads=${uploads} truncated=${truncated} listings_ok=${ok}`));
}
process.exit(failed ? 1 : 0);
