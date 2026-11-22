// Type tests for the store's route callbacks (M5 spec §5.1, §5.5). `bun run typecheck` compiles this file: every
// expectTypeOf and every expect-error directive is an assertion; each `it` names the contract its block pins.

import { describe, expectTypeOf, it } from "vitest";
import { CloudropError } from "../errors.ts";
import { contentChecks } from "../plugins.ts";
import type { RouteResult } from "../protocol/types.ts";
import { type Cloudrop, createCloudrop, type StoreApiOf } from "./cloudrop.ts";
import type { DeleteContext } from "./delete-context.ts";
import type { CloudropPlugin } from "./plugins.ts";
import { forbidden, rateLimited } from "./refusal.ts";
import { allowAnyone, type Route, route, routeFor } from "./route.ts";
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

// @ts-expect-error: `tx` is reserved (M12-A8): an authorize result may not use it, in a store's route() too.
txRoute({ accept: "*/*", maxSize: 1, authorize: () => ({ userId: "u1", tx: 42 }) });

/** A store's route: onComplete gets the store's tx. */
const albums = txRoute(
  { accept: "image/*", maxSize: "5MB", authorize: () => ({ userId: "u1" }) },
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
      // Without an annotation, what the caller passed is unknown (M12-T6).
      expectTypeOf(context.context).toEqualTypeOf<unknown>();
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

  it("onDelete returns nothing or a CloudropError, from a plain or an async function", () => {
    const policy = { accept: "*/*", maxSize: 1, authorize: () => ({}) };
    route(policy, { onDelete: () => new CloudropError("FORBIDDEN", "Kept.") });
    route(policy, {
      onDelete: async ({ owner }) => (owner === null ? undefined : new CloudropError("FORBIDDEN", "Kept.")),
    });
    // @ts-expect-error: any other value is the hook's bug, and a failure at run time.
    route(policy, { onDelete: () => "kept" });
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

// Typed auth in plugins and a typed deletion context (spec 1.0 §3a, M12-T5, M12-T6). The createCloudrop calls sit in
// functions that never run: only their types are asserted.
interface FileDeleter {
  adminId: string;
  why: string;
}
const deleter: FileDeleter = { adminId: "a1", why: "spam" };
const policy = { accept: "*/*", maxSize: 1 } as const;
const signedIn = route({ ...policy, authorize: () => ({ userId: "u1", since: new Date(0) }) });
const team = route({ ...policy, authorize: () => ({ userId: "u2", teamId: "t1" }) });
const open = route({ ...policy, authorize: allowAnyone });
const perUser: CloudropPlugin<{ userId: string }> = {
  id: "per-user",
  server: {
    afterVerify: ({ auth }) => {
      expectTypeOf(auth.userId).toEqualTypeOf<string>();
      return undefined;
    },
  },
};
/** A store route whose onDelete declares who deletes, and nothing for an erasure. */
const moderated = txRoute(
  { ...policy, authorize: () => ({ userId: "u1" }) },
  {
    onDelete: async ({ tx, reason, context }: DeleteContext<FileDeleter, undefined> & { tx: DrizzleTx }) => {
      if (reason === "deleted") await tx.insert(context.adminId);
    },
  },
);
const ticketed = route(
  { ...policy, authorize: () => ({ userId: "u1" }) },
  { onDelete: ({ context }: DeleteContext<{ ticket: string }>) => void context },
);

// M12-T7: a route whose authorize only refuses authorizes no one, so its auth type is never, not the refusal's own
// fields, and a typed plugin beside it still compiles.
const closed = route(
  { ...policy, authorize: () => forbidden("closed") },
  {
    prefix: (context) => {
      // Before M12-T7 the context offered the refusal's code and message, which no authorize result carries.
      // @ts-expect-error: nobody is authorized, so there is no message.
      void context.message;
      // @ts-expect-error: nor a code.
      void context.code;
      return "closed";
    },
  },
);
const closedLater = route({ ...policy, authorize: async () => forbidden("closed") });
const throttled = route({ ...policy, authorize: () => rateLimited(30) });
expectTypeOf(closed).toEqualTypeOf<Route<undefined, null, never>>();
expectTypeOf(closedLater).toEqualTypeOf<Route<undefined, null, never>>();
expectTypeOf(throttled).toEqualTypeOf<Route<undefined, null, never>>();
// A route that authorizes someone keeps exactly that result.
expectTypeOf(team).toEqualTypeOf<Route<undefined, null, { userId: string; teamId: string }>>();

describe("typed auth in plugins and a typed deletion context", () => {
  it("accepts a typed plugin beside routes whose authorize only refuses, sync or async", () => {
    void (() => createCloudrop({ routes: { signedIn, closed, closedLater, throttled }, plugins: [perUser] }));
  });

  it("refuses a plugin that reads a field one of the routes' authorize results lacks", () => {
    // @ts-expect-error: `open` authorizes without a userId, so the plugin would read one that is not there.
    void (() => createCloudrop({ routes: { signedIn, open }, plugins: [perUser] }));
  });

  it("accepts it when every route authorizes with that field, and types inline hooks with the JSON form", () => {
    void (() =>
      createCloudrop({
        routes: { signedIn, team },
        plugins: [
          perUser,
          contentChecks(),
          {
            id: "inline",
            server: {
              beforeUpload: ({ auth }) => {
                // One of the routes' results, as the token's JSON snapshot: a Date is its ISO string there.
                expectTypeOf(auth).toEqualTypeOf<
                  { userId: string; since: string } | { userId: string; teamId: string }
                >();
                return undefined;
              },
            },
          },
        ],
      }));
  });

  it("requires the context a route's onDelete declares, and leaves it optional where it admits undefined", () => {
    void (() => {
      const { api } = createCloudrop({ routes: { moderated, open }, store });
      // @ts-expect-error: moderated's onDelete needs to know who deletes.
      void api.deleteFile("f1");
      void api.deleteFile("f1", { context: deleter });
      // @ts-expect-error: a context of another type.
      void api.deleteFile("f1", { context: "a1" });
      // An erasure's context is declared undefined, so it is optional, and anything else is refused.
      void api.eraseOwner("u1");
      // @ts-expect-error: the erased context is declared undefined.
      void api.eraseOwner("u1", { context: deleter });
    });
  });

  it("asks for a context that every route's onDelete accepts", () => {
    void (() => {
      const { api } = createCloudrop({ routes: { moderated, ticketed }, store });
      // @ts-expect-error: ticketed needs its ticket as well.
      void api.deleteFile("f1", { context: deleter });
      void api.deleteFile("f1", { context: { ...deleter, ticket: "T-1" } });
    });
  });

  it("keeps the context unknown and optional without annotations", () => {
    void (() => {
      const { api } = createCloudrop({ routes: { deleted, audited }, store });
      void api.deleteFile("f1");
      void api.eraseOwner("u1");
      expectTypeOf(api.deleteFile).parameter(1).toEqualTypeOf<{ context?: unknown } | undefined>();
    });
  });
});

// M12-R71: an app names its server's store-backed api from the server alone, routes and deletion contexts included.
describe("StoreApiOf", () => {
  it("is the api of a server with a store", () => {
    void (() => {
      const server = createCloudrop({ routes: { moderated, open }, store });
      expectTypeOf<StoreApiOf<typeof server>>().toEqualTypeOf<typeof server.api>();
    });
  });

  it("keeps the route names and the declared contexts in the view of an opt-in store", () => {
    void (() => {
      const optional = store as CloudropStore<DrizzleTx> | undefined;
      const server = createCloudrop({ routes: { moderated, open }, ...(optional && { store: optional }) });
      const view = server.api as StoreApiOf<typeof server>;
      // @ts-expect-error: moderated's onDelete needs to know who deletes.
      void view.deleteFile("f1");
      void view.deleteFile("f1", { context: deleter });
      // @ts-expect-error: the erased context is declared undefined.
      void view.eraseOwner("u1", { context: deleter });
      // @ts-expect-error: no route of that name.
      void view.files({ owner: "u1", route: "avatar" });
    });
  });
});
