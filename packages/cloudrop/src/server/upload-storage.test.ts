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

  // StorageDriver is a public interface: a custom driver's throw is that file's failure, not the whole request's.
  it("rejects only the file whose driver threw while starting it, and releases it", async () => {
    const bucket = serverFixture({ files }).storage;
    const storage: StorageDriver = {
      ...bucket,
      createMultipart: () => {
        throw new Error("driver bug");
      },
    };
    const events: string[] = [];
    const fixture = serverFixture({ files }, { storage, multipartThreshold: MiB, plugins: [releases(events)] });
    const { body } = await upload(fixture, { route: "files", files: [png(2 * MiB, "big.png"), png(10, "small.png")] });
    expect({ tickets: rejections(body), logged: fixture.logger.errors.map(({ message }) => message), events }).toEqual({
      tickets: [
        {
          code: "SERVER_ERROR",
          message: "The server could not handle the upload. Contact the site owner if this keeps happening.",
          retryable: false,
        },
        "single",
      ],
      // The file id is the key's random ULID.
      logged: [expect.stringMatching(/^cloudrop: could not start the upload of file [0-9A-Z]{26} on route "files"\.$/)],
      events: ["release failed big.png"],
    });
  });
});
