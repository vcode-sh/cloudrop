// Contract: M11-K1 to M11-K5. A FILE_TYPE_NOT_ALLOWED from contentChecks() reaches the page with `content`: on the
// job's error, on each failed file's and in the snapshot, whether /upload refused the whole request or /complete one
// file. The answer is untrusted: a `content` of another shape is dropped and the error kept; a field this client does
// not know is ignored, as an older client ignores `content`; a server that sends none leaves it undefined.
// Oracle: the server's verdicts for the files below (content-checks.test.ts pins each one) and literal answers.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient } from "../client.ts";
import type { CloudropError } from "../errors.ts";
import { contentChecks } from "../plugins/content-checks.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
import { HTML, JPEG, PNG } from "../testing/file-samples.ts";
import { createEndpoints } from "./endpoints.ts";

const files = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone });
const KEY = "0123456789abcdef0123456789abcdef";
const MISMATCH = { declared: "image/png", detected: "image/jpeg", reason: "mismatch" };
const PAGE_REFUSED = { declared: "text/html", reason: "refused" };

function setup(fault?: Fault) {
  const fixture = clientFixture({ files }, { plugins: [contentChecks()], fault });
  const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, persist: false });
  return { fixture, client };
}

const photo = (body: Uint8Array<ArrayBuffer>, name = "photo.png") => new File([body], name, { type: "image/png" });
const page = () => new File([HTML], "page.html", { type: "text/html" });
/** What a page reads from an error to word it: the code, the file it belongs to and `content`. */
const read = (error: CloudropError | null | undefined) =>
  error ? { code: error.code, file: error.file?.name, content: error.content } : null;

beforeEach(() => {
  // Every backoff wait is 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

describe("a file contentChecks() refuses at /complete", () => {
  it("fails with `content` on the job's error, the file's outcome and its snapshot", async () => {
    const { client } = setup();
    const job = client.start("files", photo(JPEG));
    const { data, error } = await job.done;
    const [outcome] = data?.files ?? [];
    const expected = { code: "FILE_TYPE_NOT_ALLOWED", file: "photo.png", content: MISMATCH };

    expect({
      job: read(error),
      outcome: outcome?.status === "failed" ? read(outcome.error) : outcome?.status,
      snapshot: read(job.getSnapshot().files[0]?.error),
    }).toEqual({ job: expected, outcome: expected, snapshot: expected });
  });
});

describe("a request contentChecks() refuses at /upload", () => {
  it("fails every file with the job's error, which names the refused type", async () => {
    const { fixture, client } = setup();
    const job = client.start("files", [photo(PNG), page()]);
    const { data, error } = await job.done;
    const expected = { code: "FILE_TYPE_NOT_ALLOWED", file: undefined, content: PAGE_REFUSED };

    expect({
      data,
      job: read(error),
      files: job.getSnapshot().files.map((file) => read(file.error)),
      requests: fixture.requests,
    }).toEqual({ data: null, job: expected, files: [expected, expected], requests: ["POST /upload"] });
  });

  it("drops it with the error when the retry's /upload fails another way", async () => {
    let down = false;
    const { client } = setup(() => (down ? Response.json({ error: "gone" }, { status: 404 }) : undefined));
    const job = client.start("files", [photo(PNG), page()]);
    await job.done;
    down = true;
    const { error } = await job.retry();
    const expected = { code: "SERVER_ERROR", file: undefined, content: undefined };

    expect([read(error), ...job.getSnapshot().files.map((file) => read(file.error))]).toEqual([
      expected,
      expected,
      expected,
    ]);
  });

  it("keeps `content` on a file's own error when that file alone is asked for again", async () => {
    const { client } = setup();
    const job = client.start("files", [photo(PNG), page()]);
    await job.done;
    const [first, second] = await Promise.all(job.files.map((file) => file.retry()));

    expect({ first: first?.status, second: second?.status === "failed" ? read(second.error) : second?.status }).toEqual(
      { first: "done", second: { code: "FILE_TYPE_NOT_ALLOWED", file: "page.html", content: PAGE_REFUSED } },
    );
  });
});

describe("reading `content` from an answer", () => {
  const message = "This file is a JPEG image, but it was sent as image/png.";
  const refusal = (extra: object, code = "FILE_TYPE_NOT_ALLOWED") => ({ code, message, retryable: false, ...extra });
  /** The error the client reads from a /complete answered with `body`. */
  async function completeError(body: object): Promise<CloudropError | null> {
    const fixture = clientFixture({ files }, { fault: () => Response.json({ error: body }, { status: 400 }) });
    return (await createEndpoints(fixture.basePath, fixture.fetch).complete("token")).error;
  }

  it.for([
    { name: "all three fields", content: MISMATCH, expected: MISMATCH },
    { name: "no detected type", content: PAGE_REFUSED, expected: PAGE_REFUSED },
    {
      name: "only its three fields, whatever else the answer adds",
      content: { ...MISMATCH, key: "uploads/photo.png", name: "photo.png" },
      expected: MISMATCH,
    },
  ])("keeps $name", async ({ content, expected }) => {
    // Strict: a `detected` the answer lacks is no key at all, as on the server's own error.
    expect((await completeError(refusal({ content })))?.content).toStrictEqual(expected);
  });

  it.for([
    { name: "a string", content: "image/jpeg" },
    { name: "a list", content: [MISMATCH] },
    { name: "null", content: null },
    { name: "no declared type", content: { detected: "image/jpeg", reason: "mismatch" } },
    { name: "a declared type that is not a string", content: { ...MISMATCH, declared: 7 } },
    { name: "a detected type that is not a string", content: { ...MISMATCH, detected: { type: "image/jpeg" } } },
    { name: "no reason", content: { declared: "image/png", detected: "image/jpeg" } },
    // A newer server's reason: the type promises one of three, so the page falls back to the message.
    { name: "a reason this client does not know", content: { ...MISMATCH, reason: "quarantined" } },
  ])("drops $name and keeps the error", async ({ content }) => {
    expect(read(await completeError(refusal({ content })))).toEqual({
      code: "FILE_TYPE_NOT_ALLOWED",
      file: undefined,
      content: undefined,
    });
  });

  it("leaves it undefined for a server that sends none, as before 0.6.0", async () => {
    const error = await completeError(refusal({}));
    expect([error?.message, error?.content]).toEqual([message, undefined]);
  });

  it("leaves it off an error with another code", async () => {
    expect((await completeError(refusal({ content: MISMATCH }, "VERIFICATION_FAILED")))?.content).toBeUndefined();
  });

  // What makes a newer server safe for an older client: the reader takes the fields it knows and nothing else decides.
  it("reads an error that carries a field this client does not know", async () => {
    const error = await completeError(refusal({ quarantine: { until: "2027-01-01" } }, "VERIFICATION_FAILED"));
    expect(read(error)).toEqual({ code: "VERIFICATION_FAILED", file: undefined, content: undefined });
  });

  it("reads it from a file /upload rejects alone", async () => {
    const answer = { files: [{ kind: "rejected", error: refusal({ content: MISMATCH }) }] };
    const fixture = clientFixture({ files }, { fault: () => Response.json(answer) });
    const { data } = await createEndpoints(fixture.basePath, fixture.fetch).start(
      "files",
      [photo(JPEG)],
      undefined,
      KEY,
      new AbortController().signal,
    );

    expect(read(data?.[0] as CloudropError)).toEqual({
      code: "FILE_TYPE_NOT_ALLOWED",
      file: undefined,
      content: MISMATCH,
    });
  });
});
