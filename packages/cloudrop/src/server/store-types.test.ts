// Type tests for the store's route callbacks (M5 spec §5.1, §5.5). `bun run typecheck` compiles this file: every
// expectTypeOf and every expect-error directive is an assertion. The runtime test only keeps Vitest from reporting an
// empty file.

import { describe, expectTypeOf, it } from "vitest";
import type { RouteResult } from "../protocol/types.ts";
import type { Cloudrop } from "./cloudrop.ts";
import { route, routeFor } from "./route.ts";
import type { CloudropStore } from "./store.ts";

interface DrizzleTx {
  insert(table: string): Promise<void>;
}
// routeFor reads nothing of the store at runtime: it only marks the routes it makes as this store's.
const store = {} as CloudropStore<DrizzleTx>;
const txRoute = routeFor<{ tx: DrizzleTx }>(store);

const avatar = route(
  { accept: "image/*", maxSize: "5MB", authorize: () => ({ userId: "u1", since: new Date(0) }) },
  {
    owner: (context) => {
      expectTypeOf(context.userId).toEqualTypeOf<string>();
      expectTypeOf(context.request).toEqualTypeOf<Request>();
      expectTypeOf(context.metadata).toEqualTypeOf<undefined>();
      // @ts-expect-error: owner runs once per /upload, for every file at once, so it sees no file.
      void context.file;
      return context.userId;
    },
    onComplete: (context) => {
      // @ts-expect-error: a plain route() has no tx.
      void context.tx;
      return { id: 7 };
    },
    afterComplete: ({ userId, since, file, data }) => {
      expectTypeOf(userId).toEqualTypeOf<string>();
      expectTypeOf(since).toEqualTypeOf<string>();
      expectTypeOf(file.key).toEqualTypeOf<string>();
      expectTypeOf(data).toEqualTypeOf<{ id: number }>();
    },
  },
);

const albums = txRoute(
  { accept: "image/*", maxSize: "5MB", authorize: () => ({ userId: "u1", tx: 42 }) },
  {
    owner: ({ userId }) => userId,
    onComplete: async ({ tx, userId, file }) => {
      // The store's tx replaces an authorize field of the same name.
      expectTypeOf(tx).toEqualTypeOf<DrizzleTx>();
      await tx.insert(`${userId}:${file.key}`);
      return { url: file.url };
    },
  },
);

// @ts-expect-error: owner returns a string or null.
route({ accept: "*/*", maxSize: 1, authorize: () => ({}) }, { owner: () => 42 });

declare const cloudrop: Cloudrop<{ avatar: typeof avatar; albums: typeof albums }>;
expectTypeOf<RouteResult<typeof cloudrop, "avatar">>().toEqualTypeOf<{ id: number }>();
expectTypeOf<RouteResult<typeof cloudrop, "albums">>().toEqualTypeOf<{ url: string | null }>();

describe("store route types", () => {
  it("compile", () => {});
});
