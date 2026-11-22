// Type tests for cloudrop/react (spec §6.1, M4-B1 and M4-B2): the route name, its metadata and its result are inferred
// from useUpload's first argument; metadata is required where the route's schema requires it; a record from
// useResumable resumes only into a hook of its route. `bun run typecheck` compiles this file: every expectTypeOf and
// every expect-error directive is an assertion. Oracle: the route definitions below.

import { describe, expectTypeOf, it } from "vitest";
import { type CompleteResponse, createCloudropClient, type ResumableUpload, type UploadResult } from "../client.ts";
import { createUploadHooks } from "../react.ts";
import { createCloudrop } from "../server/cloudrop.ts";
import { allowAnyone, route } from "../server/route.ts";
import type { StandardSchema } from "../server/schema.ts";
import { r2 } from "../storage/presets.ts";
import { albumSchema } from "../testing/upload-fixture.ts";

/** A schema that accepts undefined: the route's metadata is optional. */
const optionalSchema: StandardSchema<{ a: string } | undefined> = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value: value as { a: string } | undefined }) },
};

const cloudrop = createCloudrop({
  storage: r2({
    bucket: "uploads",
    accountId: "0123456789abcdef0123456789abcdef",
    accessKeyId: "k",
    secretAccessKey: "s",
  }),
  secret: "test-secret-0123456789abcdef0123456789",
  routes: {
    avatar: route(
      { accept: "image/*", maxSize: "5MB", metadata: albumSchema, authorize: allowAnyone },
      { onComplete: ({ file }) => ({ url: file.url }) },
    ),
    notes: route({ accept: "text/plain", maxSize: 1024, authorize: allowAnyone }),
    optional: route({ accept: "*/*", maxSize: 1, metadata: optionalSchema, authorize: allowAnyone }),
  },
});

/** A server with only the notes route: fewer route names than `cloudrop`. */
const fewer = createCloudrop({
  storage: r2({ bucket: "few", accountId: "0123456789abcdef0123456789abcdef", accessKeyId: "k", secretAccessKey: "s" }),
  secret: "test-secret-0123456789abcdef0123456789",
  routes: { notes: route({ accept: "text/plain", maxSize: 1024, authorize: allowAnyone }) },
});

/** Another server, whose only route returns a different result. */
const other = createCloudrop({
  storage: r2({
    bucket: "other",
    accountId: "0123456789abcdef0123456789abcdef",
    accessKeyId: "k",
    secretAccessKey: "s",
  }),
  secret: "test-secret-0123456789abcdef0123456789",
  routes: {
    videos: route(
      { accept: "video/*", maxSize: "1GB", authorize: allowAnyone },
      { onComplete: () => ({ seconds: 1 }) },
    ),
  },
});

const { useUpload, useResumable } = createUploadHooks<typeof cloudrop>();
const file = new File(["hi"], "note.txt", { type: "text/plain" });

describe("cloudrop/react types", () => {
  it("infers each route's metadata and result from the route name", () => {
    // A hook runs only while a component renders: this body is type-checked and never called.
    const component = () => {
      const avatar = useUpload("avatar", { metadata: { albumId: "a1" } });
      expectTypeOf(avatar.files[0]?.result).toEqualTypeOf<
        CompleteResponse<{ url: string | null }> | null | undefined
      >();
      expectTypeOf(avatar.upload).returns.toEqualTypeOf<Promise<UploadResult<{ url: string | null }> | null>>();
      void avatar.upload([file], { metadata: { albumId: "a2" } });
      // @ts-expect-error the call's metadata is the route's too
      void avatar.upload([file], { metadata: { albumId: 1 } });

      // @ts-expect-error the avatar route's schema requires metadata
      useUpload("avatar");
      // @ts-expect-error the avatar route's schema requires metadata
      useUpload("avatar", { multiple: true });
      // @ts-expect-error albumId is a string
      useUpload("avatar", { metadata: { albumId: 1 } });
      // @ts-expect-error not a route of this server
      useUpload("videos");

      const notes = useUpload("notes");
      expectTypeOf(notes.files[0]?.result).toEqualTypeOf<CompleteResponse<null> | null | undefined>();

      // A schema that accepts undefined leaves the options optional, and metadata may be passed.
      useUpload("optional");
      useUpload("optional", { metadata: { a: "x" } });
    };
    expectTypeOf(component).toBeFunction();
  });

  it("types useResumable's records by route, and resumes a record only into a hook of its route", () => {
    const component = () => {
      const notes = useUpload("notes");
      const { uploads } = useResumable("notes");
      expectTypeOf(uploads).toEqualTypeOf<readonly ResumableUpload<"notes">[]>();
      const [record] = uploads;
      if (record) void notes.resumeUpload(record, file);
      // @ts-expect-error resume() only un-pauses; a listed upload continues through resumeUpload.
      if (record) void notes.resume(record, file);

      const [avatarRecord] = useResumable("avatar").uploads;
      // @ts-expect-error an avatar upload resumes into the avatar hook, whose result type it has
      if (avatarRecord) void notes.resumeUpload(avatarRecord, file);

      // Every route's records narrow by `route`.
      const [any] = useResumable().uploads;
      if (any?.route === "notes") void notes.resumeUpload(any, file);
    };
    expectTypeOf(component).toBeFunction();
  });

  it("takes { client } only for the same server's type", () => {
    createUploadHooks<typeof cloudrop>({ client: createCloudropClient<typeof cloudrop>() });
    // Never called: a client is created only in the browser.
    const wrongServer = () =>
      // @ts-expect-error a client of another server's routes
      createUploadHooks<typeof cloudrop>({ client: createCloudropClient<typeof other>() });
    const fewerRoutes = () =>
      // @ts-expect-error a client that lacks the avatar and optional routes
      createUploadHooks<typeof cloudrop>({ client: createCloudropClient<typeof fewer>() });
    expectTypeOf(wrongServer).toBeFunction();
    expectTypeOf(fewerRoutes).toBeFunction();
  });
});
