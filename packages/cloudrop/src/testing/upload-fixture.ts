// Setup shared by the /upload unit tests: the time the clock is fixed at, a metadata schema, the avatar route, a route
// that takes any file, and the call that posts an upload as a signed-in user. It builds inputs only; every expected value
// stays in the tests.

import type { FileDescriptor, UploadResponse } from "../protocol/types.ts";
import { allowAnyone, type Route, route, unauthorized } from "../server/route.ts";
import type { StandardSchema } from "../server/schema.ts";
import type { ServerFixture } from "./server-fixture.ts";

export const NOW: Date = new Date("2026-11-15T12:00:00Z");

export const albumSchema: StandardSchema<{ albumId: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const albumId = (value as { albumId?: unknown } | null)?.albumId;
      return typeof albumId === "string"
        ? { value: { albumId } }
        : { issues: [{ message: "Expected a string", path: ["albumId"] }] };
    },
  },
};

/** Signed-in users ("x-user") upload up to two images of at most 1 MB into their album's folder. */
export const avatar: Route<{ albumId: string }, null> = route({
  accept: ["image/png", "image/jpeg"],
  maxSize: "1MB",
  maxFiles: 2,
  metadata: albumSchema,
  authorize: ({ request, metadata }) =>
    request.headers.get("x-user")
      ? { userId: request.headers.get("x-user") as string, albumId: metadata.albumId }
      : unauthorized(),
  prefix: ({ userId, metadata }) => `users/${userId}/${metadata.albumId}`,
});

export const files: Route<undefined, null> = route({ accept: "*/*", maxSize: "100GB", authorize: allowAnyone });

const signedIn = { "x-user": "42" };
export const png = (size = 1024, name = "me.png"): FileDescriptor => ({ name, size, type: "image/png" });

export async function upload(
  fixture: ServerFixture,
  body: unknown,
): Promise<{ status: number; body: UploadResponse & { error?: { code: string; message: string } } }> {
  const response = await fixture.post("upload", body, signedIn);
  return {
    status: response.status,
    body: (await response.json()) as UploadResponse & { error?: { code: string; message: string } },
  };
}
