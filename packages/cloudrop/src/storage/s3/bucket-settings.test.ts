import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { R2_RULES } from "../../rules.ts";
import { credentials, driverWith, endpoint, neverCalled, now, stubbed } from "../../testing/driver-fixture.ts";
import { createFakeR2 } from "../../testing/fake-r2.ts";
import type { FetchLike, StorageDriver } from "../driver.ts";
import { createS3DriverWithWrites, type S3Driver } from "../s3-driver.ts";

const writable = (fetch: FetchLike): S3Driver =>
  createS3DriverWithWrites({ endpoint, region: "auto", bucket: "test", credentials, rules: R2_RULES, fetch, now });

describe("bucket configuration", () => {
  const cors =
    "<CORSConfiguration><CORSRule><AllowedOrigin>http://localhost:5173</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedHeader>content-type</AllowedHeader><AllowedHeader>x-amz-meta-*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>";
  // R2's default multipart rule, plus a prefix-scoped expiry such as the test bucket's.
  const lifecycle =
    "<LifecycleConfiguration><Rule><ID>Default Multipart Abort Rule</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule><Rule><ID>live-test</ID><Status>Disabled</Status><Filter><Prefix>live-test/</Prefix></Filter><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>";

  function configured(bucketConfig?: { cors?: string; lifecycle?: string }): StorageDriver {
    return driverWith(createFakeR2({ bucket: "test", credentials, now, bucketConfig }).fetch);
  }

  it("reads the CORS rules", async () => {
    expect((await configured({ cors }).getBucketCors()).data).toEqual([
      {
        allowedOrigins: ["http://localhost:5173"],
        allowedMethods: ["PUT", "GET"],
        allowedHeaders: ["content-type", "x-amz-meta-*"],
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 3600,
      },
    ]);
  });

  it("reads the lifecycle rules with their abort days, prefixes and XML", async () => {
    expect((await configured({ lifecycle }).getBucketLifecycle()).data).toEqual([
      {
        id: "Default Multipart Abort Rule",
        enabled: true,
        prefix: "",
        abortIncompleteMultipartUploadDays: 7,
        sourceXml:
          "<ID>Default Multipart Abort Rule</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload>",
      },
      {
        id: "live-test",
        enabled: false,
        prefix: "live-test/",
        sourceXml:
          "<ID>live-test</ID><Status>Disabled</Status><Filter><Prefix>live-test/</Prefix></Filter><Expiration><Days>1</Days></Expiration>",
      },
    ]);
  });

  it("answers no rules for a bucket without configuration", async () => {
    const driver = configured({});
    expect([(await driver.getBucketCors()).data, (await driver.getBucketLifecycle()).data]).toEqual([[], []]);
  });

  it.each([
    ["CORS", (driver: StorageDriver) => driver.getBucketCors(), "CORS configuration"],
    ["lifecycle", (driver: StorageDriver) => driver.getBucketLifecycle(), "lifecycle configuration"],
  ])(
    "reports a %s answer without its configuration element as a retryable storage error",
    async (_name, read, missing) => {
      // An HTML error page from a proxy is not "no rules": checkBucket would report rules the bucket may have.
      const html = stubbed(async () => new Response("<html><body>Bad gateway</body></html>"));
      expect((await read(driverWith(html))).error).toMatchObject({
        code: "STORAGE_ERROR",
        retryable: true,
        message: `The storage service's response had no ${missing}. Retry the request.`,
      });
    },
  );

  it.each([
    ["CORS", (driver: StorageDriver) => driver.getBucketCors(), "CORS"],
    ["lifecycle", (driver: StorageDriver) => driver.getBucketLifecycle(), "lifecycle"],
  ])(
    "reports a %s 404 without the missing-configuration code as a non-retryable storage error",
    async (_name, read, setting) => {
      // A proxy or a wrong endpoint path also answers 404; only the storage's own code means "no configuration".
      // Retrying the same path cannot fix a wrong endpoint (ruling M2-X40).
      const proxy = stubbed(async () => new Response("<html><body>Not found</body></html>", { status: 404 }));
      expect((await read(driverWith(proxy))).error).toMatchObject({
        code: "STORAGE_ERROR",
        retryable: false,
        message: `The storage service answered 404 without saying that the bucket has no ${setting} configuration. Check the endpoint, then retry.`,
      });
    },
  );

  it("reports malformed abort days as a retryable storage error, never as NaN", async () => {
    const malformed = lifecycle.replace("<DaysAfterInitiation>7<", "<DaysAfterInitiation>seven<");
    expect((await configured({ lifecycle: malformed }).getBucketLifecycle()).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no valid multipart abort days. Retry the request.",
    });
  });

  it("reads an empty, self-closing configuration as no rules", async () => {
    const driver = configured({ cors: "<CORSConfiguration/>", lifecycle: '<LifecycleConfiguration xmlns="x" />' });
    expect([(await driver.getBucketCors()).data, (await driver.getBucketLifecycle()).data]).toEqual([[], []]);
  });

  it.each([
    ["CDATA", "<AllowedOrigin><![CDATA[https://a.example]]></AllowedOrigin>"],
    ["a comment", "<!-- <AllowedOrigin>https://old.example</AllowedOrigin> -->"],
    ["a namespace prefix", "<s3:AllowedOrigin>https://a.example</s3:AllowedOrigin>"],
  ])("refuses to read a configuration with %s, which the tag reader would misread", async (_name, inner) => {
    const cors = `<CORSConfiguration><CORSRule>${inner}<AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>`;
    expect((await configured({ cors }).getBucketCors()).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: false,
      message:
        "The bucket's CORS configuration uses XML that cloudrop does not read (CDATA, comments or namespace prefixes). Check its rules by hand.",
    });
  });

  it("reports a refused read as STORAGE_DENIED, never as no rules", async () => {
    const driver = configured();
    expect([(await driver.getBucketCors()).error?.code, (await driver.getBucketLifecycle()).error?.code]).toEqual([
      "STORAGE_DENIED",
      "STORAGE_DENIED",
    ]);
  });
});

describe("bucket configuration writes", () => {
  const abortRule = {
    id: "cloudrop-abort-incomplete",
    enabled: true,
    prefix: "",
    abortIncompleteMultipartUploadDays: 1,
  };
  // Without bucketConfig the fake answers as for an R2 object token, which may not change bucket settings.
  const fake = (bucketConfig: { cors?: string; lifecycle?: string } | undefined) =>
    writable(createFakeR2({ bucket: "test", credentials, now, bucketConfig }).fetch);

  it("writes CORS rules that read back unchanged, IDs with XML characters and max age included", async () => {
    const driver = fake({});
    const rules = [
      {
        id: "R&D <uploads>",
        allowedOrigins: ["https://app.example.com", "http://localhost:5173"],
        allowedMethods: ["PUT"],
        allowedHeaders: ["content-type", "x-amz-meta-*"],
        exposeHeaders: ["ETag", "Retry-After"],
        maxAgeSeconds: 3600,
      },
      { allowedOrigins: ["*"], allowedMethods: ["GET", "HEAD"], allowedHeaders: [], exposeHeaders: [] },
    ];
    expect((await driver.putBucketCors(rules)).error).toBeNull();
    expect((await driver.getBucketCors()).data).toEqual(rules);
  });

  it("writes a new lifecycle rule from its fields and keeps a rule it read, actions included", async () => {
    const lifecycle =
      "<LifecycleConfiguration><Rule><ID>expire-logs</ID><Filter><And><Prefix>logs/</Prefix><Tag><Key>tier</Key><Value>cold</Value></Tag></And></Filter><Status>Enabled</Status><Expiration><Days>30</Days></Expiration></Rule></LifecycleConfiguration>";
    const driver = fake({ lifecycle });
    const read = await driver.getBucketLifecycle();
    expect((await driver.putBucketLifecycle([...(read.data ?? []), abortRule])).error).toBeNull();
    expect((await driver.getBucketLifecycle()).data).toEqual([
      {
        id: "expire-logs",
        enabled: true,
        prefix: "logs/",
        sourceXml:
          "<ID>expire-logs</ID><Filter><And><Prefix>logs/</Prefix><Tag><Key>tier</Key><Value>cold</Value></Tag></And></Filter><Status>Enabled</Status><Expiration><Days>30</Days></Expiration>",
      },
      {
        ...abortRule,
        sourceXml:
          "<ID>cloudrop-abort-incomplete</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload>",
      },
    ]);
  });

  it("sends the SHA-256 of the exact body, the checksum S3 requires on these calls", async () => {
    const sent: { checksum: string | null; body: Uint8Array }[] = [];
    const capture: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "PUT") return new Response("<LifecycleConfiguration></LifecycleConfiguration>");
      sent.push({ checksum: request.headers.get("x-amz-checksum-sha256"), body: await request.bytes() });
      return new Response(null, { status: 200 });
    };
    const driver = writable(capture);
    await driver.putBucketCors([
      { allowedOrigins: ["*"], allowedMethods: ["GET"], allowedHeaders: [], exposeHeaders: [] },
    ]);
    await driver.putBucketLifecycle([abortRule]);
    // Node's own SHA-256 is the oracle, independent of the web crypto call the driver makes.
    const sha256 = (body: Uint8Array) => createHash("sha256").update(body).digest("base64");
    expect(sent.map(({ checksum, body }) => body.length > 0 && checksum === sha256(body))).toEqual([true, true]);
  });

  it.each([
    {
      name: "a bucket without lifecycle rules sends no transition default",
      answer: { status: 404, body: "<Error><Code>NoSuchLifecycleConfiguration</Code></Error>" },
      outcome: { error: null, sent: [null] },
    },
    {
      name: "a bare 404 to the read of the transition default fails the write as a wrong endpoint",
      answer: { status: 404, body: "<html>Not found</html>" },
      outcome: {
        error:
          "The storage service answered 404 without saying that the bucket has no lifecycle configuration. Check the endpoint, then retry.",
        sent: [],
      },
    },
  ])("$name", async ({ answer, outcome }) => {
    const sent: (string | null)[] = [];
    const stub: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "PUT") return new Response(answer.body, { status: answer.status });
      sent.push(request.headers.get("x-amz-transition-default-minimum-object-size"));
      return new Response(null);
    };
    const written = await writable(stub).putBucketLifecycle([abortRule]);
    expect({ error: written.error?.message ?? null, sent }).toEqual(outcome);
  });

  it("sends back the bucket's transition default with a lifecycle write, so the write changes only the rules", async () => {
    const header = "x-amz-transition-default-minimum-object-size";
    const sent: (string | null)[] = [];
    const awsLike: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "PUT") {
        sent.push(request.headers.get(header));
        return new Response(null);
      }
      return new Response("<LifecycleConfiguration></LifecycleConfiguration>", {
        headers: { [header]: "varies_by_storage_class" },
      });
    };
    expect((await writable(awsLike).putBucketLifecycle([abortRule])).error).toBeNull();
    expect(sent).toEqual(["varies_by_storage_class"]);
  });

  it.each([
    {
      name: "no CORS rule",
      write: (driver: S3Driver) => driver.putBucketCors([]),
      message: "Pass at least one CORS rule: an empty list would remove every rule.",
    },
    {
      name: "no lifecycle rule",
      write: (driver: S3Driver) => driver.putBucketLifecycle([]),
      message: "Pass at least one lifecycle rule: an empty list would remove every rule.",
    },
  ])("refuses $name before sending anything", async ({ write, message }) => {
    expect((await write(writable(neverCalled))).error).toMatchObject({ code: "INVALID_INPUT", message });
  });

  it("reports a refused write as STORAGE_DENIED", async () => {
    const driver = fake(undefined);
    const results = [
      await driver.putBucketCors([
        { allowedOrigins: ["*"], allowedMethods: ["GET"], allowedHeaders: [], exposeHeaders: [] },
      ]),
      await driver.putBucketLifecycle([abortRule]),
    ];
    expect(results.map((result) => result.error?.code)).toEqual(["STORAGE_DENIED", "STORAGE_DENIED"]);
  });
});
