import { describe, expect, it } from "vitest";
import type { BucketLifecycleRule, FetchLike } from "../storage/driver.ts";
import { bucket, ENV, ORIGIN, run } from "./command-fixture.ts";

// Rules the bucket's owner made: setup must keep them as they are.
const PUBLIC_READS =
  "<CORSRule><ID>public-reads</ID><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod></CORSRule>";
const EXPIRE_LOGS =
  "<ID>expire-logs</ID><Filter><And><Prefix>logs/</Prefix><Tag><Key>tier</Key><Value>cold</Value></Tag></And></Filter><Status>Enabled</Status><Expiration><Days>30</Days></Expiration>";
const FOREIGN = {
  cors: `<CORSConfiguration>${PUBLIC_READS}</CORSConfiguration>`,
  lifecycle: `<LifecycleConfiguration><Rule>${EXPIRE_LOGS}</Rule></LifecycleConfiguration>`,
};

const publicReads = {
  id: "public-reads",
  allowedOrigins: ["*"],
  allowedMethods: ["GET", "HEAD"],
  allowedHeaders: [],
  exposeHeaders: [],
};
const uploadsFor = (...origins: string[]) => ({
  id: "cloudrop-uploads",
  allowedOrigins: origins,
  allowedMethods: ["PUT", "GET", "HEAD"],
  allowedHeaders: ["content-type", "content-disposition", "if-none-match", "x-amz-meta-cloudrop-id"],
  exposeHeaders: ["ETag", "Retry-After"],
  maxAgeSeconds: 3600,
});
const abortRule = { id: "cloudrop-abort-incomplete", enabled: true, prefix: "", abortIncompleteMultipartUploadDays: 1 };
const fields = (rules: BucketLifecycleRule[] | null) => rules?.map(({ sourceXml: _, ...rule }) => rule);

const apply = (...extra: string[]) => ["setup", "--origin", ORIGIN, "--apply", ...extra];

describe("cloudrop setup without --apply", () => {
  it("prints both rules in R2 and S3 formats and the commands for both services when no settings name one", async () => {
    const result = await run(["setup", "--origin", ORIGIN], { env: {} });
    expect(result.code).toBe(0);
    const r2Rule = {
      id: "cloudrop-uploads",
      allowed: {
        origins: [ORIGIN],
        methods: ["PUT", "GET", "HEAD"],
        headers: ["content-type", "content-disposition", "if-none-match", "x-amz-meta-cloudrop-id"],
      },
      exposeHeaders: ["ETag", "Retry-After"],
      maxAgeSeconds: 3600,
    };
    expect(result.stdout).toContain(JSON.stringify({ rules: [r2Rule] }, null, 2));
    const { id: _, ...s3Fields } = uploadsFor(ORIGIN);
    expect(result.stdout).toContain(
      JSON.stringify(
        {
          CORSRules: [
            {
              ID: "cloudrop-uploads",
              AllowedOrigins: s3Fields.allowedOrigins,
              AllowedMethods: s3Fields.allowedMethods,
              AllowedHeaders: s3Fields.allowedHeaders,
              ExposeHeaders: s3Fields.exposeHeaders,
              MaxAgeSeconds: 3600,
            },
          ],
        },
        null,
        2,
      ),
    );
    expect(result.lines).toEqual(
      expect.arrayContaining([
        '  wrangler r2 bucket cors set "$CLOUDROP_R2_BUCKET" --file cors.json',
        '  wrangler r2 bucket lifecycle add "$CLOUDROP_R2_BUCKET" cloudrop-abort-incomplete --abort-multipart-days 1',
        '  aws s3api put-bucket-cors --bucket "$CLOUDROP_S3_BUCKET" --cors-configuration file://cors-s3.json --endpoint-url "$CLOUDROP_S3_ENDPOINT"',
      ]),
    );
  });

  it("prints only R2's commands for R2 settings, with the jurisdiction", async () => {
    const result = await run(["setup", "--origin", ORIGIN, "--jurisdiction", "eu"]);
    expect(result.lines).toContain('  wrangler r2 bucket cors list "$CLOUDROP_R2_BUCKET" --jurisdiction eu');
    expect(result.lines).not.toContain("Commands for S3-compatible services:");
  });
});

describe("cloudrop setup --apply", () => {
  it("adds cloudrop's rules and keeps a foreign CORS rule and a foreign lifecycle rule", async () => {
    const storage = bucket(FOREIGN);
    const result = await run(apply(), { fetch: storage.fetch });
    expect(result.code).toBe(0);
    expect(await storage.cors()).toEqual([publicReads, uploadsFor(ORIGIN)]);
    const lifecycle = await storage.lifecycle();
    expect(fields(lifecycle)).toEqual([{ id: "expire-logs", enabled: true, prefix: "logs/" }, abortRule]);
    expect(lifecycle?.[0]?.sourceXml).toBe(EXPIRE_LOGS);
    expect(result.lines.slice(1, 3)).toEqual([
      `ok           CORS: added rule "cloudrop-uploads" for ${ORIGIN} and kept 1 other rule ("public-reads").`,
      'ok           Lifecycle: added rule "cloudrop-abort-incomplete" (aborts incomplete multipart uploads after 1 day, whole bucket) and kept 1 other rule ("expire-logs").',
    ]);
  });

  it("updates its own rule in place for new origins and keeps the others around it", async () => {
    const ours = `<CORSRule><ID>cloudrop-uploads</ID><AllowedOrigin>${ORIGIN}</AllowedOrigin><AllowedMethod>PUT</AllowedMethod></CORSRule>`;
    const storage = bucket({
      cors: `<CORSConfiguration>${ours}${PUBLIC_READS}</CORSConfiguration>`,
      lifecycle: FOREIGN.lifecycle,
    });
    const local = "http://localhost:5173";
    const result = await run(["setup", "--origin", ORIGIN, "--origin", local, "--apply"], { fetch: storage.fetch });
    expect(result.code).toBe(0);
    expect(await storage.cors()).toEqual([uploadsFor(ORIGIN, local), publicReads]);
  });

  it("only adds to its own rule: origins and headers someone added to it stay", async () => {
    const staging = "https://staging.example.com";
    const edited = `<CORSRule><ID>cloudrop-uploads</ID><AllowedOrigin>${ORIGIN}</AllowedOrigin><AllowedOrigin>${staging}</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedHeader>Content-Type</AllowedHeader><AllowedHeader>x-amz-checksum-crc32c</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>600</MaxAgeSeconds></CORSRule>`;
    const storage = bucket({ cors: `<CORSConfiguration>${edited}</CORSConfiguration>`, lifecycle: FOREIGN.lifecycle });
    const dryRun = await run(apply("--dry-run"), { fetch: storage.fetch });
    expect(dryRun.lines[1]).toBe(
      'dry run      CORS: would add methods GET, HEAD; headers content-disposition, if-none-match, x-amz-meta-cloudrop-id; exposed headers Retry-After to rule "cloudrop-uploads".',
    );
    expect((await run(apply(), { fetch: storage.fetch })).code).toBe(0);
    expect(await storage.cors()).toEqual([
      {
        id: "cloudrop-uploads",
        allowedOrigins: [ORIGIN, staging],
        allowedMethods: ["PUT", "GET", "HEAD"],
        allowedHeaders: [
          "Content-Type",
          "x-amz-checksum-crc32c",
          "content-disposition",
          "if-none-match",
          "x-amz-meta-cloudrop-id",
        ],
        exposeHeaders: ["ETag", "Retry-After"],
        maxAgeSeconds: 600,
      },
    ]);
  });

  it("will not touch its own lifecycle rule once someone disabled it, and still writes CORS", async () => {
    const disabled =
      "<LifecycleConfiguration><Rule><ID>cloudrop-abort-incomplete</ID><Filter><Prefix></Prefix></Filter><Status>Disabled</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload><Expiration><Days>90</Days></Expiration></Rule></LifecycleConfiguration>";
    const storage = bucket({ cors: FOREIGN.cors, lifecycle: disabled });
    const result = await run(apply(), { fetch: storage.fetch });
    expect([result.code, storage.writes]).toEqual([1, ["PUT ?cors="]]);
    expect(result.lines.at(-1)).toBe("Some rules were not written; see above.");
    expect(result.lines[2]).toBe(
      'PROBLEM      Lifecycle: rule "cloudrop-abort-incomplete" exists but does not abort incomplete multipart uploads across the whole bucket, so someone changed it (disabled it, or gave it a prefix). setup does not change an edited rule: fix or delete it by hand, then run setup again.',
    );
  });

  it("leaves lifecycle rules alone when another rule already aborts uploads across the bucket", async () => {
    const r2Default =
      "<LifecycleConfiguration><Rule><ID>Default Multipart Abort Rule</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>";
    const storage = bucket({ cors: FOREIGN.cors, lifecycle: r2Default });
    const result = await run(apply(), { fetch: storage.fetch });
    expect(storage.writes).toEqual(["PUT ?cors="]);
    expect(result.lines[2]).toBe(
      'ok           Lifecycle: rule "Default Multipart Abort Rule" already aborts incomplete multipart uploads after 7 days; nothing to change.',
    );
  });

  it("writes nothing when the rules already match", async () => {
    const storage = bucket(FOREIGN);
    await run(apply(), { fetch: storage.fetch });
    const again = await run(apply(), { fetch: storage.fetch });
    expect([again.code, storage.writes]).toEqual([0, ["PUT ?cors=", "PUT ?lifecycle="]]);
  });

  it("refuses to write anything when the current rules cannot be read", async () => {
    // An object token: reads and writes are both refused, so only the refusal of the read can be seen.
    const storage = bucket();
    const result = await run(apply(), { fetch: storage.fetch });
    expect([result.code, storage.writes]).toEqual([1, []]);
    expect(result.lines.slice(1)).toEqual([
      "PROBLEM      CORS: these credentials may not read the bucket's CORS rules (R2 object tokens cannot), and a write replaces every rule, so none was written. Use credentials that may read and change bucket settings for this step, such as an R2 Admin Read & Write token, or pass --replace to replace every rule with cloudrop's alone.",
      "PROBLEM      Lifecycle: these credentials may not read the bucket's lifecycle rules (R2 object tokens cannot), and a write replaces every rule, so none was written. Use credentials that may read and change bucket settings for this step, such as an R2 Admin Read & Write token, or pass --replace to replace every rule with cloudrop's alone.",
      "Nothing was written.",
    ]);
  });

  // Wrong credentials are refused the settings reads too; --replace could not help, so the command does not offer it.
  it.each([
    {
      name: "credentials the bucket refuses",
      env: { ...ENV, CLOUDROP_R2_SECRET_ACCESS_KEY: "another-secret-access-key" },
      fetch: bucket(FOREIGN).fetch,
      line: "PROBLEM      Bucket: The storage service refused these credentials (HTTP 403). Check CLOUDROP_R2_ACCESS_KEY_ID and CLOUDROP_R2_SECRET_ACCESS_KEY, that the token may read and write objects in the bucket named by CLOUDROP_R2_BUCKET, and that the bucket exists. A bucket in a jurisdiction also needs --jurisdiction.",
    },
    {
      name: "an unreachable service",
      env: ENV,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
      line: "PROBLEM      Bucket: Could not reach the storage service. Check the endpoint and the network connection, then retry. The R2 endpoint is built from CLOUDROP_R2_ACCOUNT_ID: check that it is your account ID.",
    },
  ])("reports $name as a bucket problem, not as rules it could not read", async ({ env, fetch, line }) => {
    const result = await run(apply("--dry-run"), { env, fetch });
    expect([result.code, result.lines.slice(1)]).toEqual([1, [line, "Nothing was written."]]);
  });

  const isSettingsRead = (input: string | URL | Request, init?: RequestInit) =>
    /\?(cors|lifecycle)=$/.test(String(input)) && (init?.method ?? "GET") === "GET";
  const isListing = (input: string | URL | Request) => String(input).includes("list-type=2");
  const answer = (status: number, code: string) =>
    Promise.resolve(new Response(`<Error><Code>${code}</Code></Error>`, { status }));

  it("names S3's permissions when S3 credentials may list the bucket but not read its settings", async () => {
    const env = {
      CLOUDROP_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
      CLOUDROP_S3_REGION: "us-east-1",
      CLOUDROP_S3_BUCKET: "acme-s3-uploads",
      CLOUDROP_S3_ACCESS_KEY_ID: "AKIDs3fixture",
      CLOUDROP_S3_SECRET_ACCESS_KEY: "s3-secret-fixture-value",
    };
    const fetch: FetchLike = (input, init) =>
      isSettingsRead(input, init)
        ? answer(403, "AccessDenied")
        : Promise.resolve(new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"));
    const result = await run(apply("--dry-run"), { env, fetch });
    expect(result.lines.slice(1)).toEqual([
      "PROBLEM      CORS: these credentials may not read the bucket's CORS rules, and a write replaces every rule, so none was written. Use credentials that may read and change bucket settings for this step (s3:GetBucketCORS and s3:PutBucketCORS), or pass --replace to replace every rule with cloudrop's alone.",
      "PROBLEM      Lifecycle: these credentials may not read the bucket's lifecycle rules, and a write replaces every rule, so none was written. Use credentials that may read and change bucket settings for this step (s3:GetLifecycleConfiguration and s3:PutLifecycleConfiguration), or pass --replace to replace every rule with cloudrop's alone.",
      "Nothing was written.",
    ]);
  });

  // Wrangler's local R2 answers 501 to the writes as well (M9-C4), so --replace could not act there either.
  it("neither offers nor applies --replace for a service that cannot read bucket settings", async () => {
    const storage = bucket(FOREIGN);
    const fetch: FetchLike = (input, init) =>
      isSettingsRead(input, init) ? answer(501, "NotImplemented") : storage.fetch(input, init);
    const [plain, replacing] = [await run(apply(), { fetch }), await run(apply("--replace"), { fetch })];
    const unsupported =
      "PROBLEM      CORS: could not read the current rules: The storage service does not support this request. Use R2 or another backend that implements it. A write replaces every rule, so none was written.";
    expect([plain.code, plain.lines[1], replacing.code, replacing.lines[1], storage.writes]).toEqual([
      1,
      unsupported,
      1,
      `${unsupported} --replace applies only when the credentials refuse the read.`,
      [],
    ]);
  });

  it("writes when the rules are readable, although the credentials may not list the bucket", async () => {
    const storage = bucket(FOREIGN);
    const fetch: FetchLike = (input, init) =>
      isListing(input) ? answer(403, "AccessDenied") : storage.fetch(input, init);
    const result = await run(apply(), { fetch });
    expect([result.code, storage.writes]).toEqual([0, ["PUT ?cors=", "PUT ?lifecycle="]]);
  });

  it("with --replace, writes cloudrop's rules alone when the current rules cannot be read", async () => {
    const storage = bucket(FOREIGN);
    // The bucket refuses reads of its settings but accepts writes.
    const readsRefused: FetchLike = (input, init) => {
      const request = new Request(input, init);
      const { search } = new URL(request.url);
      const isSettingsRead = request.method === "GET" && (search === "?cors=" || search === "?lifecycle=");
      return isSettingsRead
        ? Promise.resolve(new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }))
        : storage.fetch(request);
    };
    const result = await run(apply("--replace"), { fetch: readsRefused });
    expect(result.code).toBe(0);
    expect(await storage.cors()).toEqual([uploadsFor(ORIGIN)]);
    expect(fields(await storage.lifecycle())).toEqual([abortRule]);
  });

  it("with --replace, still refuses when the read failed for a reason that may pass", async () => {
    const storage = bucket(FOREIGN);
    const readsFail: FetchLike = (input, init) =>
      /\?(cors|lifecycle)=$/.test(String(input)) && (init?.method ?? "GET") === "GET"
        ? Promise.resolve(new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }))
        : storage.fetch(input, init);
    const [replacing, plain] = [
      await run(apply("--replace"), { fetch: readsFail }),
      await run(apply(), { fetch: readsFail }),
    ];
    expect([replacing.code, plain.code, storage.writes]).toEqual([1, 1, []]);
    expect([replacing.lines[1], plain.lines[1]]).toEqual([
      "PROBLEM      CORS: could not read the current rules: The storage service failed. Retry the request. A write replaces every rule, so none was written. --replace applies only when the credentials refuse the read.",
      "PROBLEM      CORS: could not read the current rules: The storage service failed. Retry the request. A write replaces every rule, so none was written.",
    ]);
  });

  it("counts a rule equal to cloudrop's as cloudrop's when the bucket reports no IDs, so a second run adds no copy", async () => {
    const twin = `<CORSRule><AllowedOrigin>${ORIGIN}</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>content-type</AllowedHeader><AllowedHeader>content-disposition</AllowedHeader><AllowedHeader>if-none-match</AllowedHeader><AllowedHeader>x-amz-meta-cloudrop-id</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>Retry-After</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule>`;
    const storage = bucket({ cors: `<CORSConfiguration>${twin}</CORSConfiguration>`, lifecycle: FOREIGN.lifecycle });
    const result = await run(apply(), { fetch: storage.fetch });
    expect(storage.writes).toEqual(["PUT ?lifecycle="]);
    expect(result.lines[1]).toBe(
      `ok           CORS: a rule without an ID already allows uploads from ${ORIGIN} as cloudrop's rule does; nothing to change.`,
    );
  });

  it("with --dry-run and --replace, writes nothing either", async () => {
    const storage = bucket();
    const result = await run(apply("--dry-run", "--replace"), { fetch: storage.fetch });
    expect([result.code, storage.writes]).toEqual([0, []]);
    expect(result.lines[1]).toBe(
      `dry run      CORS: would replace every rule with "cloudrop-uploads" for ${ORIGIN} (--replace: the current rules could not be read).`,
    );
  });

  it("prints a rule ID's control characters as escapes", async () => {
    const storage = bucket({
      cors: "<CORSConfiguration><CORSRule><ID>evil&#x1b;[2J&#10;ok</ID><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>",
      lifecycle: FOREIGN.lifecycle,
    });
    const result = await run(apply("--dry-run"), { fetch: storage.fetch });
    expect(result.lines[1]).toBe(
      `dry run      CORS: would add rule "cloudrop-uploads" for ${ORIGIN} and keep 1 other rule ("evil\\u001b[2J\\u000aok").`,
    );
  });

  it("with --dry-run, shows the merged result and writes nothing", async () => {
    const storage = bucket(FOREIGN);
    const result = await run(apply("--dry-run"), { fetch: storage.fetch });
    expect([result.code, storage.writes]).toEqual([0, []]);
    expect(result.lines.slice(1)).toEqual([
      `dry run      CORS: would add rule "cloudrop-uploads" for ${ORIGIN} and keep 1 other rule ("public-reads").`,
      'dry run      Lifecycle: would add rule "cloudrop-abort-incomplete" (aborts incomplete multipart uploads after 1 day, whole bucket) and keep 1 other rule ("expire-logs").',
      "Dry run: nothing was written. To write, run it with --apply and without --dry-run.",
    ]);
  });

  it("reports a failed write and exits 1", async () => {
    const storage = bucket(FOREIGN);
    const writesFail: FetchLike = (input, init) =>
      init?.method === "PUT"
        ? Promise.resolve(new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }))
        : storage.fetch(input, init);
    const result = await run(apply(), { fetch: writesFail });
    expect(result.code).toBe(1);
    expect(result.lines[1]).toBe("PROBLEM      CORS: the write failed. The storage service failed. Retry the request.");
    expect(result.lines.at(-1)).toBe("Some rules were not written; see above.");
  });

  it("checks the settings before reaching the bucket", async () => {
    const result = await run(apply(), { env: { ...ENV, CLOUDROP_R2_SECRET_ACCESS_KEY: undefined } });
    expect(result.code).toBe(1);
    expect(result.lines).toContain(
      "PROBLEM      CLOUDROP_R2_SECRET_ACCESS_KEY is not set. Set it to the secret access key of an R2 API token.",
    );
  });
});
