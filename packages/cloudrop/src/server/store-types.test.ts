// Type tests for the store's route callbacks (M5 spec §5.1, §5.5). `bun run typecheck` compiles this file: every
// expectTypeOf and every expect-error directive is an assertion; each `it` names the contract its block pins.

import { describe, expectTypeOf, it } from "vitest";
import type { RouteResult } from "../protocol/types.ts";
import type { Cloudrop } from "./cloudrop.ts";
import { route, routeFor } from "./route.ts";
import type { CloudropStore, FileRecord } from "./store.ts";

interface DrizzleTx {
  insert(table: string): Promise<void>;
}
// routeFor reads nothing of the store at runtime: it only marks the routes it makes as this store's.
const store = {} as CloudropStore<DrizzleTx>;
const txRoute = routeFor<{ tx: DrizzleTx }>(store);

/** A plain route: its callbacks see the authorize context, never a tx. */
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

/** A store's route: onComplete gets the store's tx, which replaces an authorize field of the same name. */
const albums = txRoute(
  { accept: "image/*", maxSize: "5MB", authorize: () => ({ userId: "u1", tx: 42 }) },
  {
    owner: ({ userId }) => userId,
    onComplete: async ({ tx, userId, file }) => {
      expectTypeOf(tx).toEqualTypeOf<DrizzleTx>();
      await tx.insert(`${userId}:${file.key}`);
      return { url: file.url };
    },
  },
);

/** onDelete sees the file's row, its owner and why, never the authorize result; a store's route adds its tx. */
const deleted = route(
  { accept: "*/*", maxSize: 1, authorize: () => ({ userId: "u1" }) },
  {
    onDelete: (context) => {
      expectTypeOf(context.file).toEqualTypeOf<FileRecord>();
      expectTypeOf(context.owner).toEqualTypeOf<string | null>();
      expectTypeOf(context.reason).toEqualTypeOf<"deleted" | "replaced" | "erased">();
      // @ts-expect-error: onDelete runs outside any request, with no authorize result.
      void context.userId;
      // @ts-expect-error: a plain route() has no tx.
      void context.tx;
    },
  },
);
const audited = txRoute(
  { accept: "*/*", maxSize: 1, authorize: () => ({ userId: "u1" }) },
  {
    onDelete: async ({ tx, file }) => {
      expectTypeOf(tx).toEqualTypeOf<DrizzleTx>();
      await tx.insert(file.id);
    },
  },
);

describe("store route types", () => {
  it("onDelete is typed like onComplete: the store's tx only on its own routes", () => {
    void [deleted, audited];
  });

  it("owner sees the authorize context and no file, and returns a string or null", () => {
    void avatar;
    // @ts-expect-error: owner returns a string or null.
    route({ accept: "*/*", maxSize: 1, authorize: () => ({}) }, { owner: () => 42 });
  });

  it("each route's result type reaches the client, from a plain route and from a store's route", () => {
    expectTypeOf<RouteResult<Cloudrop<{ avatar: typeof avatar }>, "avatar">>().toEqualTypeOf<{ id: number }>();
    expectTypeOf<RouteResult<Cloudrop<{ albums: typeof albums }>, "albums">>().toEqualTypeOf<{
      url: string | null;
    }>();
  });

  // The supported order is onComplete, then afterComplete. Written the other way round, TypeScript fixes the result
  // type to null before it reads onComplete; this pins that, so the advice in afterComplete's TSDoc stays true.
  it("afterComplete written before onComplete fixes the result to null", () => {
    route(
      { accept: "*/*", maxSize: 1, authorize: () => ({}) },
      {
        afterComplete: ({ data }) => {
          expectTypeOf(data).toEqualTypeOf<null>();
        },
        // @ts-expect-error: in this order the result must be null.
        onComplete: (context) => ({ id: context.file.key }),
      },
    );
  });
});
