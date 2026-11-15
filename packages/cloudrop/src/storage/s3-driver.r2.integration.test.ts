// The storage contract against a real R2 bucket. Run it with `bun run test:live`, which loads the credentials.
import { R2_RULES } from "../rules.ts";
import { describeStorageContract, randomPrefix } from "../testing/storage-contract.ts";
import { r2 } from "./presets.ts";
import { createS3Driver } from "./s3-driver.ts";

const SETTINGS = [
  "CLOUDROP_R2_ACCOUNT_ID",
  "CLOUDROP_R2_BUCKET",
  "CLOUDROP_R2_ACCESS_KEY_ID",
  "CLOUDROP_R2_SECRET_ACCESS_KEY",
] as const;

describeStorageContract("live R2", async () => {
  const missing = SETTINGS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Live R2 settings are missing: ${missing.join(", ")}. Run \`bun run test:live\` with CLOUDROP_R2_ENV_FILE naming a file that sets them, or export them.`,
    );
  }
  const env = process.env as Record<(typeof SETTINGS)[number], string>;
  const bucket = env.CLOUDROP_R2_BUCKET;
  return {
    // The public preset, built the way an application builds it: everything but the bucket comes from the environment.
    driver: r2({ bucket }),
    // Presets expose neither the clock nor the rules, so variants use the driver r2() wraps, on the same endpoint.
    driverWith: ({ secondsAgo = 0, maxSinglePutSize = R2_RULES.maxSinglePutSize }) =>
      createS3Driver({
        endpoint: `https://${env.CLOUDROP_R2_ACCOUNT_ID.toLowerCase()}.r2.cloudflarestorage.com`,
        region: "auto",
        bucket,
        credentials: { accessKeyId: env.CLOUDROP_R2_ACCESS_KEY_ID, secretAccessKey: env.CLOUDROP_R2_SECRET_ACCESS_KEY },
        rules: { ...R2_RULES, maxSinglePutSize },
        now: () => new Date(Date.now() - secondsAgo * 1000),
      }),
    prefix: randomPrefix("live-test/"),
    http: fetch,
    // Real R2 passed every contract case on 2026-11-15, so it declares no gap.
    gaps: {},
    // Measured by this lane on 2026-11-15: 403 SignatureDoesNotMatch, nothing stored (r2-spike-findings.md, row 18).
    unsignedMetaOnPresignedPut: "rejected",
  };
});
