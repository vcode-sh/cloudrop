import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudropError } from "../errors.ts";
import type { FileTicket, UploadResponse } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import type { FetchLike, StorageDriver } from "../storage/driver.ts";
import { r2 } from "../storage/presets.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";
import { allowAnyone, route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const files = route({ accept: "*/*", maxSize: "100GB", authorize: allowAnyone });
const png = (size: number, name: string) => ({ name, size, type: "image/png" });

async function upload(fixture: ReturnType<typeof serverFixture>, body: unknown) {
  const response = await fixture.post("upload", body);
  return { status: response.status, body: (await response.json()) as UploadResponse };
}

function releases(events: string[]): CloudropPlugin {
  return { id: "quota", server: { onAbort: ({ reason, file }) => void events.push(`release ${reason} ${file.name}`) } };
}

const rejections = (body: UploadResponse) =>
  body.files.map((ticket: FileTicket) => (ticket.kind === "rejected" ? ticket.error : ticket.kind));

describe("POST /upload: storage failures and plugins", () => {
  it("rejects only the file whose upload could not start, without the storage's own message, and releases it", async () => {
    const fake = serverFixture({ files }).fake;
    // The bucket refuses to start a multipart upload, as R2 does for a token without write access.
    const refusing: FetchLike = (input, init) =>
      new URL(String(input)).searchParams.has("uploads")
        ? Promise.resolve(
            new Response("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>", { status: 403 }),
          )
        : fake.fetch(input, init);
    const storage = r2({
      bucket: "uploads",
      accountId: "0123456789abcdef0123456789abcdef",
      accessKeyId: "k",
      secretAccessKey: "s",
      fetch: refusing,
    });
    const events: string[] = [];
    const quota: CloudropPlugin = {
      id: "quota",
      server: { onAbort: ({ reason, file }) => void events.push(`release ${reason} ${file.name}`) },
    };
    const fixture = serverFixture({ files }, { storage, multipartThreshold: MiB, plugins: [quota] });
    const { body } = await upload(fixture, { route: "files", files: [png(2 * MiB, "big.png"), png(10, "small.png")] });
    expect(body.files.map((ticket: FileTicket) => (ticket.kind === "rejected" ? ticket.error : ticket.kind))).toEqual([
      {
        code: "STORAGE_ERROR",
        message: "The storage service refused the request. Contact the site owner if this keeps happening.",
        retryable: false,
      },
      "single",
    ]);
    expect({
      logged: fixture.logger.errors.map(({ message, error }) => [message, (error as CloudropError).code]),
      events,
    }).toEqual({
      logged: [["cloudrop: a storage request failed.", "STORAGE_DENIED"]],
      events: ["release failed big.png"],
    });
  });

  // StorageDriver is a public interface: a custom driver's throw is that file's failure, not the whole request's, and
  // a multipart upload created before the throw is aborted, not left open in the bucket.
  it.for<{ method: "createMultipart" | "presignPart" }>([{ method: "createMultipart" }, { method: "presignPart" }])(
    "rejects only the file whose driver threw in $method, releases it and leaves no upload open",
    async ({ method }) => {
      const { storage: bucket, fake } = serverFixture({ files });
      const storage: StorageDriver = {
        ...bucket,
        [method]: () => {
          throw new Error("driver bug");
        },
      };
      const events: string[] = [];
      const fixture = serverFixture({ files }, { storage, multipartThreshold: MiB, plugins: [releases(events)] });
      const { body } = await upload(fixture, {
        route: "files",
        files: [png(2 * MiB, "big.png"), png(10, "small.png")],
      });
      expect({
        tickets: rejections(body),
        logged: fixture.logger.errors.map(({ message }) => message),
        events,
      }).toEqual({
        tickets: [
          {
            code: "SERVER_ERROR",
            message: "The server could not handle the upload. Contact the site owner if this keeps happening.",
            retryable: false,
          },
          "single",
        ],
        // The file id is the key's random ULID.
        logged: [
          expect.stringMatching(/^cloudrop: could not start the upload of file [0-9A-Z]{26} on route "files"\.$/),
        ],
        events: ["release failed big.png"],
      });
      expect(fake.pendingUploads()).toBe(0);
    },
  );
});

// Spec 1.0 §2b (M12-E5): the bucket's Retry-After reaches the client on the 200 that refuses the files storage could
// not start, as the longest of their waits; the client applies it to each such file. Oracle: R2's throttle answer
// (503 SlowDown with Retry-After) and RFC 9110's whole seconds.
describe("POST /upload: the bucket's Retry-After on the 200", () => {
  const OTHER_ORIGIN = "https://admin.example.com";

  /** A fixture whose bucket throttles each multipart start with the next of `retryAfters` (null: no header). */
  function throttled(retryAfters: (string | null)[]) {
    const { fake } = serverFixture({ files });
    const pending = [...retryAfters];
    const fetch: FetchLike = (input, init) => {
      if (!new URL(String(input)).searchParams.has("uploads")) return fake.fetch(input, init);
      const retryAfter = pending.shift() ?? null;
      const headers: Record<string, string> = retryAfter === null ? {} : { "retry-after": retryAfter };
      return Promise.resolve(new Response("<Error><Code>SlowDown</Code></Error>", { status: 503, headers }));
    };
    const storage = r2({
      bucket: "uploads",
      accountId: "0123456789abcdef0123456789abcdef",
      accessKeyId: "k",
      secretAccessKey: "s",
      fetch,
    });
    return serverFixture({ files }, { storage, multipartThreshold: MiB, trustedOrigins: [OTHER_ORIGIN] });
  }

  async function answer(retryAfters: (string | null)[], headers: Record<string, string> = {}) {
    const body = { route: "files", files: retryAfters.map((_, index) => png(2 * MiB, `${index}.png`)) };
    const response = await throttled(retryAfters).post("upload", body, headers);
    const { files: tickets } = (await response.json()) as UploadResponse;
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      exposed: response.headers.get("access-control-expose-headers"),
      codes: tickets.map((ticket) => (ticket.kind === "rejected" ? ticket.error.code : ticket.kind)),
    };
  }

  it("answers the longest wait of the files it refused", async () => {
    expect(await answer(["3", "9"])).toEqual({
      status: 200,
      retryAfter: "9",
      exposed: null,
      codes: ["RATE_LIMITED", "RATE_LIMITED"],
    });
  });

  it("sends no Retry-After when the bucket gave none", async () => {
    expect(await answer([null])).toEqual({ status: 200, retryAfter: null, exposed: null, codes: ["RATE_LIMITED"] });
  });

  it("exposes it to a page on a trusted origin", async () => {
    expect(await answer(["3"], { origin: OTHER_ORIGIN })).toEqual({
      status: 200,
      retryAfter: "3",
      exposed: "Retry-After",
      codes: ["RATE_LIMITED"],
    });
  });
});
