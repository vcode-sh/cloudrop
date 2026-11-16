import { describe, expect, it } from "vitest";
import { createRedactor, exitCodeFor, explainMissing, loadSettings, parseSettingsFile } from "./live-r2-settings.ts";

// Fake values only: they merely have to look different from each other.
const FAKE_SECRET = "FakeSecretValueAbc123";

describe("parseSettingsFile", () => {
  it("reads cloudrop and BB names from literal NAME=value lines and strips matching quotes", () => {
    const text = [
      "CLOUDROP_R2_ACCOUNT_ID=acct-1",
      "BB_R2_BUCKET='bucket-1'",
      'CLOUDROP_R2_ACCESS_KEY_ID="key-1"',
      "  BB_R2_SECRET_ACCESS_KEY=secret-1  ",
      "UNRELATED=ignored",
    ].join("\n");
    expect(parseSettingsFile(text)).toEqual({
      CLOUDROP_R2_ACCOUNT_ID: "acct-1",
      CLOUDROP_R2_BUCKET: "bucket-1",
      CLOUDROP_R2_ACCESS_KEY_ID: "key-1",
      CLOUDROP_R2_SECRET_ACCESS_KEY: "secret-1",
    });
  });

  it("does not read lines that start with export or have spaces around the equals sign", () => {
    const text = "export CLOUDROP_R2_BUCKET=b\nCLOUDROP_R2_ACCOUNT_ID = a\n";
    expect(parseSettingsFile(text)).toEqual({});
  });
});

describe("explainMissing", () => {
  it("names the missing variables and the literal format when the file was read", () => {
    const message = explainMissing(["CLOUDROP_R2_BUCKET"], "/some/r2.env", "read");
    expect(message).toContain("CLOUDROP_R2_BUCKET");
    expect(message).toContain("/some/r2.env");
    expect(message).toContain("NAME=value");
    expect(message).toContain("no `export`");
    expect(message).toContain("no inline comments");
  });

  it("says the file was not found, without an error stack, when it does not exist", () => {
    const message = explainMissing(["CLOUDROP_R2_BUCKET"], "/missing/r2.env", "not-found");
    expect(message).toContain("/missing/r2.env (from CLOUDROP_R2_ENV_FILE) does not exist");
    expect(message).not.toContain("ENOENT");
    expect(message).not.toContain("NAME=value");
  });

  it("points at the environment when no file was given", () => {
    expect(explainMissing(["CLOUDROP_R2_BUCKET"], undefined, "none")).toContain("CLOUDROP_R2_ENV_FILE");
  });
});

describe("loadSettings", () => {
  const FROM_ENV = {
    CLOUDROP_R2_ACCOUNT_ID: "acct-env",
    CLOUDROP_R2_BUCKET: "bucket-env",
    CLOUDROP_R2_ACCESS_KEY_ID: "key-env",
    CLOUDROP_R2_SECRET_ACCESS_KEY: "secret-env",
  };
  const failingRead = (code: string) => () => {
    throw Object.assign(new Error(`cannot open: ${FAKE_SECRET}`), { code });
  };

  it("lets the file's values win over the environment's", () => {
    const env = { ...FROM_ENV, CLOUDROP_R2_ENV_FILE: "/some/r2.env" };
    expect(loadSettings(env, () => "BB_R2_BUCKET=bucket-file\n")).toEqual({
      settings: { ...FROM_ENV, CLOUDROP_R2_BUCKET: "bucket-file" },
    });
  });

  it("reports only the error code when the file exists but cannot be read", () => {
    const env = { ...FROM_ENV, CLOUDROP_R2_ENV_FILE: "/some/r2.env" };
    expect(loadSettings(env, failingRead("EACCES"))).toEqual({
      problem: "Cannot read /some/r2.env (EACCES). Check its permissions.",
    });
  });

  it("says a missing file does not exist when the environment lacks a setting", () => {
    const env = { CLOUDROP_R2_BUCKET: "bucket-env", CLOUDROP_R2_ENV_FILE: "/missing/r2.env" };
    expect(loadSettings(env, failingRead("ENOENT"))).toEqual({
      problem:
        "Missing R2 settings: CLOUDROP_R2_ACCOUNT_ID, CLOUDROP_R2_ACCESS_KEY_ID, CLOUDROP_R2_SECRET_ACCESS_KEY. /missing/r2.env (from CLOUDROP_R2_ENV_FILE) does not exist. Fix the path or export the variables.",
    });
  });
});

describe("createRedactor", () => {
  it("replaces every occurrence, longest value first, and counts them", () => {
    const redactor = createRedactor(["abc", "abcdef"]);
    expect(redactor.redact("x abcdef y abc")).toBe("x <redacted> y <redacted>");
    expect(redactor.count()).toBe(2);
  });

  it("also redacts the lowercase form of a value", () => {
    const redactor = createRedactor([FAKE_SECRET]);
    expect(redactor.redact(`bucket ${FAKE_SECRET.toLowerCase()} and ${FAKE_SECRET}`)).toBe(
      "bucket <redacted> and <redacted>",
    );
  });

  it("redacts a value that an ANSI colour code splits in two", () => {
    const redactor = createRedactor([FAKE_SECRET]);
    const split = `${FAKE_SECRET.slice(0, 8)}\u001b[31m${FAKE_SECRET.slice(8)}`;
    expect(redactor.redact(`secret ${split} end`)).toBe("secret <redacted> end");
  });

  it("replaces a presigned URL whole", () => {
    const redactor = createRedactor([FAKE_SECRET]);
    const line = "PUT https://h.example/k?X-Amz-Credential=zzz&X-Amz-Signature=yyy failed";
    expect(redactor.redact(line)).toBe("PUT <presigned URL> failed");
    expect(redactor.count()).toBe(1);
  });

  it("ignores empty values instead of splitting every character", () => {
    expect(createRedactor([""]).redact("plain")).toBe("plain");
  });
});

describe("exitCodeFor", () => {
  it("keeps the child's failure code", () => {
    expect(exitCodeFor(1, undefined)).toBe(1);
    expect(exitCodeFor(1, "SIGINT")).toBe(1);
  });

  it("passes a clean child run", () => {
    expect(exitCodeFor(0, undefined)).toBe(0);
  });

  it("never reports success for an interrupted run, even when the child exited 0", () => {
    expect(exitCodeFor(0, "SIGINT")).toBe(130);
    expect(exitCodeFor(0, "SIGTERM")).toBe(143);
    expect(exitCodeFor(0, "SIGHUP")).toBe(129);
  });
});
