import { describe, expect, it } from "vitest";
import { R2_RULES } from "../../rules.ts";
import { driverWith, neverCalled, setup } from "./driver-fixture.ts";

describe("createS3Driver", () => {
  it("presigns a PUT of exactly the single-PUT limit and rejects one byte more", async () => {
    const driver = driverWith(neverCalled);
    const options = { type: "video/mp4", expiresIn: 60 };
    const atLimit = await driver.presignPut("movie.mp4", { ...options, size: R2_RULES.maxSinglePutSize });
    expect(atLimit.data).toEqual({
      method: "PUT",
      url: expect.any(String),
      // Content-Length is signed but not returned: browsers refuse to set it.
      headers: { "content-type": "video/mp4" },
      expiresAt: new Date("2026-11-15T12:01:00Z"),
    });
    const overLimit = await driver.presignPut("movie.mp4", { ...options, size: R2_RULES.maxSinglePutSize + 1 });
    expect(overLimit.error?.code).toBe("INVALID_INPUT");
  });
});

describe("presignGet", () => {
  it("serves the object through the URL, with the signed download name", async () => {
    const { fake, driver } = setup();
    expect((await driver.put("docs/report.txt", "hello", { type: "text/plain" })).error).toBeNull();
    const signed = await driver.presignGet("docs/report.txt", {
      expiresIn: 300,
      disposition: 'attachment; filename="report.txt"',
    });
    expect(signed.data?.expiresAt).toEqual(new Date("2026-11-15T12:05:00Z"));
    const response = await fake.fetch(signed.data?.url ?? "");
    expect({
      status: response.status,
      disposition: response.headers.get("content-disposition"),
      body: await response.text(),
    }).toEqual({ status: 200, disposition: 'attachment; filename="report.txt"', body: "hello" });
  });

  it("signs the same URL for the same signing time, so a rounded time gives one cacheable URL", async () => {
    const { driver } = setup();
    const signedAt = new Date("2026-11-15T11:00:00Z");
    const first = await driver.presignGet("a.txt", { expiresIn: 7200, signedAt });
    const second = await driver.presignGet("a.txt", { expiresIn: 7200, signedAt });
    expect(first.data?.url).toBe(second.data?.url);
    expect(first.data?.url).toContain("X-Amz-Date=20261115T110000Z");
    expect(first.data?.expiresAt).toEqual(new Date("2026-11-15T13:00:00Z"));
  });

  it.each<[string, unknown, string]>([
    [
      "an expiry over seven days",
      { expiresIn: 604_801 },
      "Expiry must be a whole number of seconds between 1 and 604800.",
    ],
    [
      "a disposition outside printable ASCII",
      { expiresIn: 60, disposition: 'attachment; filename="ü.txt"' },
      "The content disposition must be printable ASCII. Percent-encode other characters, for example filename*=UTF-8''r%C3%A9sum%C3%A9.txt.",
    ],
    [
      "an invalid signing time",
      { expiresIn: 60, signedAt: new Date(Number.NaN) },
      "signedAt must be a valid Date from 1970 on, and the URL must expire before the year 10000. Pass a Date, or omit it to sign at the current time.",
    ],
    [
      "a signing time before 1970",
      { expiresIn: 60, signedAt: new Date("1969-12-31T23:59:59Z") },
      "signedAt must be a valid Date from 1970 on, and the URL must expire before the year 10000. Pass a Date, or omit it to sign at the current time.",
    ],
    [
      "a signing time in the year 10000",
      { expiresIn: 60, signedAt: new Date("+010000-01-01T00:00:00Z") },
      "signedAt must be a valid Date from 1970 on, and the URL must expire before the year 10000. Pass a Date, or omit it to sign at the current time.",
    ],
    [
      "an expiry that ends in the year 10000",
      { expiresIn: 3600, signedAt: new Date("9999-12-31T23:30:00Z") },
      "signedAt must be a valid Date from 1970 on, and the URL must expire before the year 10000. Pass a Date, or omit it to sign at the current time.",
    ],
    // Plain-JavaScript callers: none of these may throw a TypeError past the Result.
    ["null options", null, "Expiry must be a whole number of seconds between 1 and 604800."],
    [
      "a signing time given as text",
      { expiresIn: 60, signedAt: "2026-11-15T11:00:00Z" },
      "signedAt must be a valid Date from 1970 on, and the URL must expire before the year 10000. Pass a Date, or omit it to sign at the current time.",
    ],
    [
      "a disposition that is not text",
      { expiresIn: 60, disposition: 1 },
      "The content disposition must be printable ASCII. Percent-encode other characters, for example filename*=UTF-8''r%C3%A9sum%C3%A9.txt.",
    ],
  ])("refuses %s without signing", async (_name, options, message) => {
    expect((await driverWith(neverCalled).presignGet("a.txt", options as { expiresIn: number })).error).toMatchObject({
      code: "INVALID_INPUT",
      message,
    });
  });
});
