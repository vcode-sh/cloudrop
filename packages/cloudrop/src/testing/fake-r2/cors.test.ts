import { describe, expect, it } from "vitest";
import { createFakeR2 } from "../fake-r2.ts";
import { call, objectUrl, presignedPut, signedAt, text } from "./fixture.ts";

const ORIGIN = "https://app.example.com";
const rule = (origin: string, rest: string) => `<CORSRule><AllowedOrigin>${origin}</AllowedOrigin>${rest}</CORSRule>`;
// The two rules of the measurement (r2-spike-findings.md, "Which CORS rule answers when several match", 2026-11-21).
const A =
  "<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>x-rule-a</ExposeHeader><MaxAgeSeconds>111</MaxAgeSeconds>";
const B =
  "<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedHeader>content-type</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>x-rule-b</ExposeHeader><MaxAgeSeconds>222</MaxAgeSeconds>";

function bucketWith(...rules: string[]) {
  const fake = createFakeR2({
    bucket: "test",
    credentials: { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key" },
    now: () => signedAt,
    bucketConfig: { cors: `<CORSConfiguration>${rules.join("")}</CORSConfiguration>` },
  });
  /** What a browser's preflight learns: the answering rule's max age and the origin it allows, or the refusal. */
  const preflight = async (method: string, headers?: string) => {
    const answer = await fake.fetch(objectUrl("a.txt"), {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": method,
        ...(headers ? { "access-control-request-headers": headers } : {}),
      },
    });
    return answer.status === 204
      ? `${answer.headers.get("access-control-max-age")} ${answer.headers.get("access-control-allow-origin")}`
      : answer.status;
  };
  const getExposes = async () =>
    (await call(fake, "GET", "/missing.txt", { headers: { origin: ORIGIN } })).headers.get(
      "access-control-expose-headers",
    );
  return { fake, preflight, getExposes };
}

describe("fake R2 CORS", () => {
  // Each row is a row of the measured table: which rule answered, told by its max age and exposed headers.
  it.each([
    {
      name: "A, B",
      rules: [rule(ORIGIN, A), rule(ORIGIN, B)],
      answers: [`111 ${ORIGIN}`, `111 ${ORIGIN}`, `111 ${ORIGIN}`, "x-rule-a"],
    },
    {
      name: "B, A",
      rules: [rule(ORIGIN, B), rule(ORIGIN, A)],
      answers: [`222 ${ORIGIN}`, `111 ${ORIGIN}`, `111 ${ORIGIN}`, "ETag,x-rule-b"],
    },
    {
      name: "A for any origin, B",
      rules: [rule("*", A), rule(ORIGIN, B)],
      answers: ["111 *", "111 *", "111 *", "x-rule-a"],
    },
    {
      name: "B, A for any origin",
      rules: [rule(ORIGIN, B), rule("*", A)],
      answers: [`222 ${ORIGIN}`, "111 *", "111 *", "ETag,x-rule-b"],
    },
  ])("answers with the first rule that matches the whole request, stored as $name", async ({ rules, answers }) => {
    const { preflight, getExposes } = bucketWith(...rules);
    expect([
      await preflight("PUT", "content-type"),
      await preflight("PUT", "x-other"),
      await preflight("HEAD"),
      await getExposes(),
    ]).toEqual(answers);
  });

  // Measured 2026-11-16: 204 names the rule's methods and the headers asked for; a header or an origin the rule
  // lacks gets 403 without a CORS header.
  it("answers a preflight with the rule's methods and the headers asked for, or 403 without a CORS header", async () => {
    const { fake, preflight } = bucketWith(rule(ORIGIN, B));
    const allowed = await fake.fetch(objectUrl("a.txt"), {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "Content-Type",
      },
    });
    expect([
      allowed.headers.get("access-control-allow-methods"),
      allowed.headers.get("access-control-allow-headers"),
    ]).toEqual(["GET, PUT", "Content-Type"]);
    const refused = await fake.fetch(objectUrl("a.txt"), {
      method: "OPTIONS",
      headers: { origin: "https://other.example.com", "access-control-request-method": "PUT" },
    });
    expect([refused.status, refused.headers.get("access-control-allow-origin")]).toEqual([403, null]);
    expect(await preflight("PUT", "content-type, x-amz-checksum-sha256")).toBe(403);
  });

  // Spike Q8 and U2: a PUT from an origin without a rule is stored and answered without CORS headers, and so is a
  // refused URL even when a rule matches.
  it("sends CORS headers only on an answer to a signed request from an origin a rule allows", async () => {
    const { fake } = bucketWith(rule(ORIGIN, B));
    const put = async (key: string, origin: string, url?: URL) => {
      const answer = await fake.fetch(url ?? (await presignedPut(key, {})), {
        method: "PUT",
        body: text("hi"),
        headers: { origin },
      });
      return [answer.status, answer.headers.get("access-control-allow-origin")];
    };
    expect([
      await put("a.txt", ORIGIN),
      await put("b.txt", "https://other.example.com"),
      await put("c.txt", ORIGIN, await presignedPut("c.txt", {}, { secret: "another-secret" })),
    ]).toEqual([
      [200, ORIGIN],
      [200, null],
      [403, null],
    ]);
  });
});
