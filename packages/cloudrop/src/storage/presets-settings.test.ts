import { describe, expect, it } from "vitest";
import { goodR2, goodS3, thrownBy } from "../testing/presets-fixture.ts";
import { r2, s3 } from "./presets.ts";

describe("bucket names", () => {
  const rejected = [
    ["too short", "ab"],
    ["too long", "a".repeat(64)],
    ["upper case", "Media"],
    ["underscore", "my_bucket"],
    ["leading hyphen", "-media"],
    ["trailing hyphen", "media-"],
    ["slash", "a/b"],
    ["legacy upper case with underscore", "My_Legacy_Bucket"],
    ["empty", ""],
  ] as const;

  it.each(rejected)("r2() rejects a bucket name that is %s", (_why, bucket) => {
    const error = thrownBy(() => r2({ ...goodR2, bucket }));
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain(bucket === "" ? "Missing R2 settings: bucket" : "bucket name");
  });

  it.each(rejected)("s3() rejects a bucket name that is %s", (_why, bucket) => {
    expect(thrownBy(() => s3({ ...goodS3, bucket })).code).toBe("INVALID_CONFIG");
  });

  it("accepts the shortest and the longest valid name", () => {
    expect(() => r2({ ...goodR2, bucket: "a1b" })).not.toThrow();
    expect(() => r2({ ...goodR2, bucket: `a${"-".repeat(61)}1` })).not.toThrow();
  });

  it("r2() rejects a dot, s3() accepts one but not an IP address or a double dot", () => {
    expect(thrownBy(() => r2({ ...goodR2, bucket: "my.media" })).code).toBe("INVALID_CONFIG");
    expect(() => s3({ ...goodS3, bucket: "my.media" })).not.toThrow();
    expect(thrownBy(() => s3({ ...goodS3, bucket: "192.168.5.4" })).code).toBe("INVALID_CONFIG");
    expect(thrownBy(() => s3({ ...goodS3, bucket: "my..media" })).code).toBe("INVALID_CONFIG");
  });

  it("pins the R2 and S3 bucket messages", () => {
    expect(thrownBy(() => r2({ ...goodR2, bucket: "Media" })).message).toBe(
      "The R2 bucket name must be 3 to 63 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit. Copy the exact name from your R2 bucket list.",
    );
    expect(thrownBy(() => s3({ ...goodS3, bucket: "my..media" })).message).toBe(
      "The S3 bucket name must be 3 to 63 characters: lowercase letters, digits, hyphens and dots, starting and ending with a letter or digit, with no two dots in a row, and not formatted like an IP address. Copy the exact name from your S3 bucket list.",
    );
  });

  it.each([".media", "media.", "-media", "media-"])("s3() rejects the edge character in %s", (bucket) => {
    expect(thrownBy(() => s3({ ...goodS3, bucket })).code).toBe("INVALID_CONFIG");
  });

  it("rejects a bucket that is not a string, as plain-JavaScript callers can pass one", () => {
    expect(thrownBy(() => r2({ ...goodR2, bucket: 42 as unknown as string })).message).toContain("bucket name");
  });
});

describe("publicUrl", () => {
  it.each([
    ["r2", (publicUrl: string) => r2({ ...goodR2, publicUrl })],
    ["s3", (publicUrl: string) => s3({ ...goodS3, publicUrl })],
  ] as const)(
    "%s() passes it to the driver normalised, keeping a CDN path and dropping trailing slashes",
    (_name, make) => {
      const given = ["https://cdn.example.com/files//", "https://cdn.example.com/", " https://cdn.example.com/files"];
      expect(given.map((publicUrl) => make(publicUrl).publicUrl)).toEqual([
        "https://cdn.example.com/files",
        "https://cdn.example.com",
        "https://cdn.example.com/files",
      ]);
    },
  );

  it("leaves the driver's publicUrl undefined when none is given", () => {
    expect(r2(goodR2).publicUrl).toBeUndefined();
    expect(s3(goodS3).publicUrl).toBeUndefined();
  });

  const shapeMessage =
    "The publicUrl must be an http or https URL with no query or fragment, such as https://cdn.example.com/files.";
  it.each([
    ["cdn.example.com", shapeMessage],
    ["ftp://cdn.example.com", shapeMessage],
    ["", shapeMessage],
    // A key appended later would land inside the query or the fragment.
    ["https://cdn.example.com/?v=1", shapeMessage],
    ["https://cdn.example.com/#top", shapeMessage],
    [
      "https://u:p@cdn.example.com",
      "The publicUrl contains a user name or password. Remove it; cloudrop takes credentials only as accessKeyId and secretAccessKey.",
    ],
  ])("rejects %j without echoing it", (publicUrl, message) => {
    const messages = [() => r2({ ...goodR2, publicUrl }), () => s3({ ...goodS3, publicUrl })].map(
      (make) => thrownBy(make).message,
    );
    expect(messages).toEqual([message, message]);
  });
});

describe("credential, region and fetch settings", () => {
  // Never echoed: a key ID or a secret must not reach a log through an error message.
  const unsignable = (setting: string) =>
    `The ${setting} setting must be printable ASCII text with no whitespace or line break; secret files often end in a newline. Copy the value again without it.`;
  const regionMessage =
    "The region setting must be printable ASCII text with no whitespace, line break or slash, such as us-east-1 or auto.";
  it.each<[string, () => unknown, string]>([
    [
      "r2() given a key ID ending in a newline",
      () => r2({ ...goodR2, accessKeyId: "AKIDEXAMPLE\n" }),
      unsignable("accessKeyId"),
    ],
    [
      "s3() given a secret ending in a newline",
      () => s3({ ...goodS3, secretAccessKey: "secret\n" }),
      unsignable("secretAccessKey"),
    ],
    [
      "s3() given a key ID that is not text",
      () => s3({ ...goodS3, accessKeyId: 42 as never }),
      unsignable("accessKeyId"),
    ],
    ["s3() given a region with a slash", () => s3({ ...goodS3, region: "us-east-1/s3" }), regionMessage],
    ["s3() given a region ending in a newline", () => s3({ ...goodS3, region: "us-east-1\n" }), regionMessage],
    ["s3() given a symbol as the region", () => s3({ ...goodS3, region: Symbol("region") as never }), regionMessage],
    [
      "r2() given an account ID that is not text",
      () => r2({ ...goodR2, accountId: 42 as never }),
      "The R2 account ID must be 32 hexadecimal characters (0-9, a-f); the one given is not text. Copy it from the R2 overview page in the Cloudflare dashboard.",
    ],
    [
      "s3() given a fetch that is not a function",
      () => s3({ ...goodS3, fetch: "https://proxy.example.com" as never }),
      "The fetch option must be a function, such as globalThis.fetch. Omit it to use the global fetch.",
    ],
  ])("%s throws INVALID_CONFIG at construction", (_name, make, message) => {
    expect(thrownBy(make)).toMatchObject({ code: "INVALID_CONFIG", message });
  });
});
