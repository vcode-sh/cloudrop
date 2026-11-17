// Type tests for cloudrop/react (spec §6.1, M4-B1 and M4-B2): the route name, its metadata and its result are inferred
// from useUpload's first argument; metadata is required where the route's schema requires it; a record from
// useResumable resumes only into a hook of its route. `bun run typecheck` compiles this file: every expectTypeOf and
// every expect-error directive is an assertion. Oracle: the route definitions below.

import { describe, expectTypeOf, it } from "vitest";
import type { CompleteResponse, ResumableUpload, UploadResult } from "../client.ts";
import { createUploadHooks } from "../react.ts";
import { createCloudrop } from "../server/cloudrop.ts";
import { allowAnyone, route } from "../server/route.ts";
import { r2 } from "../storage/presets.ts";
import { albumSchema } from "../testing/upload-fixture.ts";

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
      onComplete: ({ file }) => ({ url: file.url }),
    }),
    notes: route({ accept: "text/plain", maxSize: 1024, authorize: allowAnyone }),
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
    };
    expectTypeOf(component).toBeFunction();
  });

  it("types useResumable's records by route, and resumes a record only into a hook of its route", () => {
    const component = () => {
      const notes = useUpload("notes");
      const { uploads } = useResumable("notes");
      expectTypeOf(uploads).toEqualTypeOf<readonly ResumableUpload<"notes">[]>();
      const [record] = uploads;
      if (record) void notes.resume(record, file);

      const [avatarRecord] = useResumable("avatar").uploads;
      // @ts-expect-error an avatar upload resumes into the avatar hook, whose result type it has
      if (avatarRecord) void notes.resume(avatarRecord, file);

      // Every route's records narrow by `route`.
      const [any] = useResumable().uploads;
      if (any?.route === "notes") void notes.resume(any, file);
    };
    expectTypeOf(component).toBeFunction();
  });
});
