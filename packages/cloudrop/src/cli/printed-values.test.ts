import { describe, expect, it } from "vitest";
import type { FetchLike } from "../storage/driver.ts";
import { bucket, ENV, ORIGIN, run } from "./command-fixture.ts";

// What the command may print of its settings (M11-R177): the bucket's name and the S3 endpoint, and those only as
// words of a Wrangler or AWS CLI command it suggests. Never the access key ID, the secret access key, the upload token
// secret, the R2 account ID or the S3 region. Every setting has a value of its own here, so each can be looked for.
const R2: Record<string, string> = ENV;
const S3: Record<string, string> = {
  CLOUDROP_S3_ENDPOINT: "https://objects.zq7.example:8443",
  CLOUDROP_S3_REGION: "zq7-region-1",
  // The fake bucket of the fixture answers to these three.
  CLOUDROP_S3_BUCKET: ENV.CLOUDROP_R2_BUCKET,
  CLOUDROP_S3_ACCESS_KEY_ID: ENV.CLOUDROP_R2_ACCESS_KEY_ID,
  CLOUDROP_S3_SECRET_ACCESS_KEY: ENV.CLOUDROP_R2_SECRET_ACCESS_KEY,
  CLOUDROP_SECRET: ENV.CLOUDROP_SECRET,
};

const READY = {
  cors: `<CORSConfiguration><CORSRule><AllowedOrigin>${ORIGIN}</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>Retry-After</ExposeHeader></CORSRule></CORSConfiguration>`,
  lifecycle:
    "<LifecycleConfiguration><Rule><ID>abort</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>",
};
const NO_RULES = { cors: "<CORSConfiguration></CORSConfiguration>" };
const unreachable: FetchLike = () => Promise.reject(new TypeError("fetch failed"));

interface Path {
  name: string;
  argv: string[];
  /** The bucket the run reaches; none for a run that must not reach one. */
  fetch?: () => FetchLike;
  /** Settings changed or removed for this run, by service. */
  change?: { R2?: Record<string, string | undefined>; S3?: Record<string, string | undefined> };
  files?: (env: Record<string, string>) => Record<string, string>;
  /** The settings whose value the output holds, by service. */
  r2: string[];
  s3: string[];
}

const BUCKET_ONLY = { r2: ["CLOUDROP_R2_BUCKET"], s3: ["CLOUDROP_S3_ENDPOINT", "CLOUDROP_S3_BUCKET"] };
const NOTHING = { r2: [], s3: [] };
const doctor = ["doctor", "--origin", ORIGIN];
const setup = ["setup", "--origin", ORIGIN];

const PATHS: Path[] = [
  { name: "doctor on a ready bucket", argv: doctor, fetch: () => bucket(READY).fetch, ...NOTHING },
  // Each check that could not run ends with the Wrangler or AWS CLI command that reads the setting by hand.
  { name: "doctor with a token that reads no rules", argv: doctor, fetch: () => bucket().fetch, ...BUCKET_ONLY },
  { name: "doctor on a bucket without rules", argv: doctor, fetch: () => bucket(NO_RULES).fetch, ...NOTHING },
  { name: "doctor on a service it cannot reach", argv: doctor, fetch: () => unreachable, ...NOTHING },
  {
    name: "doctor with a secret access key the bucket refuses",
    argv: doctor,
    fetch: () => bucket(READY).fetch,
    change: {
      R2: { CLOUDROP_R2_SECRET_ACCESS_KEY: "refused-r2-secret-access-key" },
      S3: { CLOUDROP_S3_SECRET_ACCESS_KEY: "refused-s3-secret-access-key" },
    },
    ...NOTHING,
  },
  {
    name: "doctor with a value that is not valid",
    argv: doctor,
    change: {
      R2: { CLOUDROP_R2_ACCOUNT_ID: "zq7-not-an-account-id" },
      S3: { CLOUDROP_S3_ENDPOINT: "ftp://objects.zq7.example/files" },
    },
    ...NOTHING,
  },
  {
    name: "doctor with a setting missing",
    argv: doctor,
    change: { R2: { CLOUDROP_R2_BUCKET: undefined }, S3: { CLOUDROP_S3_BUCKET: undefined } },
    ...NOTHING,
  },
  {
    name: "doctor with every setting in an --env-file",
    argv: [...doctor, "--env-file", ".env.local"],
    fetch: () => bucket().fetch,
    files: (env) => ({
      ".env.local": Object.entries(env)
        .map(([name, value]) => `${name}="${value}"`)
        .join("\n"),
    }),
    ...BUCKET_ONLY,
  },
  { name: "setup, which prints the rules and the commands", argv: setup, ...BUCKET_ONLY },
  { name: "setup --dry-run", argv: [...setup, "--dry-run"], fetch: () => bucket(NO_RULES).fetch, ...NOTHING },
  { name: "setup --apply", argv: [...setup, "--apply"], fetch: () => bucket(NO_RULES).fetch, ...NOTHING },
  { name: "setup --apply that may not read", argv: [...setup, "--apply"], fetch: () => bucket().fetch, ...NOTHING },
  {
    name: "setup --apply --replace whose write is refused",
    argv: [...setup, "--apply", "--replace"],
    fetch: () => bucket().fetch,
    ...NOTHING,
  },
  { name: "the usage", argv: ["--help"], ...NOTHING },
  { name: "an unknown option", argv: [...doctor, "--force"], ...NOTHING },
  { name: "a secret typed as an argument", argv: [...doctor, ENV.CLOUDROP_SECRET], ...NOTHING },
  { name: "a secret typed as NAME=value", argv: [...doctor, `CLOUDROP_SECRET=${ENV.CLOUDROP_SECRET}`], ...NOTHING },
  { name: "a secret typed as the --env-file", argv: [...doctor, "--env-file", ENV.CLOUDROP_SECRET], ...NOTHING },
];

/** `output` without the places a bucket name or an endpoint may stand: as that word of a suggested command. */
function outsideCommands(output: string, env: Record<string, string | undefined>): string {
  const literal = (value: string | undefined) => (value ?? "\u0000").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const name = literal(env.CLOUDROP_R2_BUCKET ?? env.CLOUDROP_S3_BUCKET);
  return output
    .replace(new RegExp(`(wrangler r2 bucket (?:cors|lifecycle) (?:list|set|add) )${name}(?= |$)`, "gm"), "$1")
    .replace(new RegExp(`(aws s3api [a-z-]+ --bucket )${name}(?= )`, "gm"), "$1")
    .replace(new RegExp(`( --endpoint-url )${literal(env.CLOUDROP_S3_ENDPOINT)}$`, "gm"), "$1");
}

describe.each([
  { service: "R2" as const, settings: R2 },
  { service: "S3" as const, settings: S3 },
])("the setting values $service output holds", ({ service, settings }) => {
  it.each(PATHS)("$name", async (path) => {
    const env = { ...settings, ...path.change?.[service] };
    const set = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => !!entry[1]));
    const fromFile = path.files !== undefined;
    const result = await run(path.argv, {
      env: fromFile ? {} : env,
      files: path.files?.(set),
      fetch: path.fetch?.(),
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const holds = (text: string) => Object.keys(set).filter((name) => text.includes(set[name] ?? ""));
    expect({ printed: holds(output), outsideCommands: holds(outsideCommands(output, env)) }).toEqual({
      printed: service === "R2" ? path.r2 : path.s3,
      outsideCommands: [],
    });
  });
});
