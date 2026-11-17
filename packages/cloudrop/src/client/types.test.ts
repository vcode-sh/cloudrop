// Type tests for cloudrop/client (decisions S2 and S3; M3-O2 for the wire name `id`; M3-U77 and M3-U78 for resume).
// `bun run typecheck` compiles this file: every expectTypeOf and every expect-error directive is an assertion. Oracle:
// the route definitions below. At run time the tests only keep Vitest from reporting an empty file.

import { describe, expectTypeOf, it } from "vitest";
import {
  type AbortResponse,
  type CompleteResponse,
  createCloudropClient,
  type MultipartTicket,
  type Result,
  type ResumableUpload,
  type RouteMetadata,
  type RouteName,
  type RouteResult,
  type SingleTicket,
  type UploadedFile,
  type UploadJob,
  type UploadResult,
} from "../client.ts";
import { createCloudrop } from "../server/cloudrop.ts";
import { allowAnyone, route } from "../server/route.ts";
import type { StandardSchema } from "../server/schema.ts";
import { r2 } from "../storage/presets.ts";
import { albumSchema } from "../testing/upload-fixture.ts";

const optionalSchema: StandardSchema<{ a: string } | undefined> = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value: value as { a: string } | undefined }) },
};

// Inline, as spec §1 writes routes: a route assigned to a constant first would type a missing onComplete as null even
// without route()'s NoInfer.
const cloudrop = createCloudrop({
  storage: r2({
    bucket: "uploads",
    accountId: "0123456789abcdef0123456789abcdef",
    accessKeyId: "k",
    secretAccessKey: "s",
  }),
  secret: "test-secret-0123456789abcdef0123456789",
  routes: {
    avatar: route({
      accept: "image/*",
      maxSize: "5MB",
      metadata: albumSchema,
      authorize: allowAnyone,
      onComplete: ({ file }) => ({ url: file.url, at: new Date() }),
    }),
    notes: route({ accept: "text/plain", maxSize: 1024, authorize: allowAnyone }),
    optional: route({ accept: "*/*", maxSize: 1, metadata: optionalSchema, authorize: allowAnyone }),
  },
});

// The calls below run, so each needs an answer: this one ends the call at /upload, before any timer or real request.
const noFiles = async () => Response.json({ files: [] });
const client = createCloudropClient<typeof cloudrop>({ fetch: noFiles });
const file = new File(["hi"], "note.txt", { type: "text/plain" });

describe("cloudrop/client types", () => {
  it("infers routes, metadata and results from the server type, and names the file id `id`", () => {
    expectTypeOf<Parameters<typeof client.upload>[0]>().toEqualTypeOf<"avatar" | "notes" | "optional">();
    expectTypeOf(client.upload("avatar", file, { metadata: { albumId: "a" } })).toEqualTypeOf<
      Promise<Result<CompleteResponse<{ url: string | null; at: string }>>>
    >();
    // @ts-expect-error: avatar's schema requires metadata.
    client.upload("avatar", file);
    // @ts-expect-error: albumId is a string.
    client.upload("avatar", file, { metadata: { albumId: 1 } });
    // @ts-expect-error: notes has no schema, so it takes no metadata.
    client.upload("notes", file, { metadata: { a: "x" } });
    expectTypeOf(client.upload("notes", file)).toEqualTypeOf<Promise<Result<CompleteResponse<null>>>>();
    client.upload("optional", file);
    client.upload("optional", file, { metadata: { a: "x" } });
    // @ts-expect-error: there is no route named "banner".
    client.upload("banner", file);
    expectTypeOf(createCloudropClient({ fetch: noFiles }).upload("anything", file)).toEqualTypeOf<
      Promise<Result<CompleteResponse<unknown>>>
    >();
    const { upload } = client;
    upload("notes", file);

    expectTypeOf(client.start("notes", file)).toEqualTypeOf<UploadJob<null>>();
    expectTypeOf(client.start("avatar", [file], { metadata: { albumId: "a" } })).toEqualTypeOf<
      UploadJob<{ url: string | null; at: string }>
    >();
    // @ts-expect-error: avatar's schema requires metadata in start() too.
    client.start("avatar", [file]);
    expectTypeOf(client.upload("notes", [file])).toEqualTypeOf<Promise<UploadResult<null>>>();
    const snapshot = client.start("avatar", [file], { metadata: { albumId: "a" } }).getSnapshot();
    expectTypeOf(snapshot.files[0]?.result).toEqualTypeOf<
      CompleteResponse<RouteResult<typeof cloudrop, "avatar">> | null | undefined
    >();

    expectTypeOf<MultipartTicket["id"]>().toEqualTypeOf<string>();
    expectTypeOf<AbortResponse["id"]>().toEqualTypeOf<string>();
    expectTypeOf<UploadedFile["id"]>().toEqualTypeOf<string>();
    // @ts-expect-error: the wire name is `id`, not `fileId` (M3-O2).
    expectTypeOf<SingleTicket["fileId"]>();
    expectTypeOf<RouteName<typeof cloudrop>>().toEqualTypeOf<"avatar" | "notes" | "optional">();
    expectTypeOf<RouteMetadata<typeof cloudrop, "avatar">>().toEqualTypeOf<{ albumId: string }>();
    expectTypeOf<RouteResult<typeof cloudrop, "notes">>().toEqualTypeOf<null>();
  });

  it("types resume after a reload by the record's route (audit M10)", () => {
    expectTypeOf(client.resumable()).toEqualTypeOf<
      Promise<Result<ResumableUpload<"avatar" | "notes" | "optional">[]>>
    >();
    expectTypeOf(client.resumable("avatar")).toEqualTypeOf<Promise<Result<ResumableUpload<"avatar">[]>>>();
    // @ts-expect-error: there is no route named "banner".
    client.resumable("banner");
    expectTypeOf<ResumableUpload>().toEqualTypeOf<ResumableUpload<string>>();
    // Refused at once at run time: an upload with no id sends nothing.
    const avatar = {} as ResumableUpload<"avatar">;
    expectTypeOf(client.resume(avatar, file)).toEqualTypeOf<UploadJob<{ url: string | null; at: string }>>();
    expectTypeOf(
      client.resume({} as ResumableUpload<"notes">, file, { signal: new AbortController().signal }),
    ).toEqualTypeOf<UploadJob<null>>();
    // @ts-expect-error: the metadata is the record's.
    client.resume(avatar, file, { metadata: { albumId: "a" } });
    expectTypeOf(client.forget()).toEqualTypeOf<Promise<Result<{ forgotten: number }>>>();
    client.forget({ all: true });
    // @ts-expect-error: forget() takes nothing or { all: true } (ruling M3-U78).
    client.forget({ all: false });
  });
});
