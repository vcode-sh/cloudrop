// Type inference tests (spec §11.5). `bun run typecheck` compiles this file: every expectTypeOf and every
// expect-error directive is an assertion. The runtime tests only keep Vitest from reporting an empty file.

import { describe, expectTypeOf, it } from "vitest";
import { sqliteExecutor, sqlStore } from "../adapters/sql.ts";
import type { RouteMetadata, RouteName, RouteResult } from "../protocol/types.ts";
import { r2 } from "../storage/presets.ts";
import { memoryStore } from "../testing.ts";
import { createCloudrop } from "./cloudrop.ts";
import { allowAnyone, type Route, route, unauthorized } from "./route.ts";
import type { StandardSchema } from "./schema.ts";
import type { AbortedRecord, CompletedRecord, ExpiredRecord, FailedRecord, FileRecord, RecordOf } from "./store.ts";

interface User {
  id: string;
  joined: Date;
}
const getUser = async (request: Request): Promise<User | null> =>
  request.headers.has("cookie") ? { id: "42", joined: new Date(0) } : null;
const albumSchema: StandardSchema<{ albumId: string }, { albumId: string; takenAt: Date }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({
      value: { albumId: String((value as { albumId: unknown }).albumId), takenAt: new Date(0) },
    }),
  },
};
const optionalSchema: StandardSchema<{ a: string } | undefined, { a: string } | undefined> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value as { a: string } | undefined }),
  },
};

const avatar = route(
  {
    accept: "image/*",
    maxSize: "5MB",
    metadata: albumSchema,
    authorize: async ({ request, metadata }) => {
      expectTypeOf(metadata).toEqualTypeOf<{ albumId: string; takenAt: Date }>();
      const user = await getUser(request);
      return user ? { user } : unauthorized();
    },
  },
  {
    prefix: ({ user, metadata }) => {
      expectTypeOf(user).toEqualTypeOf<User>();
      return `users/${user.id}/${metadata.albumId}`;
    },
    onComplete: async ({ user, metadata, file }) => {
      // onComplete reads the token's JSON copy: Dates are strings there, and the types say so.
      expectTypeOf(user).toEqualTypeOf<{ id: string; joined: string }>();
      expectTypeOf(metadata).toEqualTypeOf<{ albumId: string; takenAt: string }>();
      return { url: file.url, at: new Date() };
    },
  },
);

const notes = route({ accept: "text/plain", maxSize: 1024, authorize: allowAnyone });

const optional = route(
  {
    accept: "*/*",
    maxSize: 1,
    metadata: optionalSchema,
    authorize: allowAnyone,
  },
  {
    onComplete: ({ metadata }) => {
      expectTypeOf(metadata).toEqualTypeOf<{ a: string } | undefined>();
    },
  },
);

const cloudrop = createCloudrop({
  storage: r2({
    bucket: "uploads",
    accountId: "0123456789abcdef0123456789abcdef",
    accessKeyId: "k",
    secretAccessKey: "s",
  }),
  secret: "test-secret-0123456789abcdef0123456789",
  routes: { avatar, notes, optional },
});

describe("type inference for the client", () => {
  it("reads route names, metadata input and result types from the server type", () => {
    expectTypeOf<RouteName<typeof cloudrop>>().toEqualTypeOf<"avatar" | "notes" | "optional">();
    expectTypeOf<RouteMetadata<typeof cloudrop, "avatar">>().toEqualTypeOf<{ albumId: string }>();
    expectTypeOf<RouteMetadata<typeof cloudrop, "notes">>().toEqualTypeOf<undefined>();
    expectTypeOf<RouteMetadata<typeof cloudrop, "optional">>().toEqualTypeOf<{ a: string } | undefined>();
    expectTypeOf<RouteResult<typeof cloudrop, "avatar">>().toEqualTypeOf<{ url: string | null; at: string }>();
    expectTypeOf<RouteResult<typeof cloudrop, "notes">>().toEqualTypeOf<null>();
    // @ts-expect-error: there is no route named "banner".
    expectTypeOf<RouteResult<typeof cloudrop, "banner">>();
  });

  it("types an inline route without onComplete as null, as the quickstart writes routes", () => {
    const inline = createCloudrop({
      storage: r2({
        bucket: "uploads",
        accountId: "0123456789abcdef0123456789abcdef",
        accessKeyId: "k",
        secretAccessKey: "s",
      }),
      secret: "test-secret-0123456789abcdef0123456789",
      routes: { notes: route({ accept: "text/plain", maxSize: 1024, authorize: allowAnyone }) },
    });
    expectTypeOf<RouteResult<typeof inline, "notes">>().toEqualTypeOf<null>();
  });

  it("requires authorize", () => {
    // @ts-expect-error: a route without authorize does not type-check; public routes say authorize: allowAnyone.
    route({ accept: "*/*", maxSize: 1 });
  });

  it("refuses an authorize result that uses a name cloudrop puts into the route context", () => {
    const policy = { accept: "*/*", maxSize: 1 } as const;
    // @ts-expect-error: `data` is afterComplete's; the context would hide this field.
    route({ ...policy, authorize: () => ({ data: 1 }) });
    // @ts-expect-error: `tx` is a store route's transaction.
    route({ ...policy, authorize: () => ({ tx: "t" }) });
    // @ts-expect-error: `route` is reserved for the route's name.
    route({ ...policy, authorize: () => ({ route: "avatar" }) });
    // @ts-expect-error: `signal` is reserved for cancelling a hook.
    route({ ...policy, authorize: () => ({ signal: null }) });
    // @ts-expect-error: `request` was reserved before 1.0 too, and is now a type error as well.
    route({ ...policy, authorize: () => ({ request: "r" }) });
    // Every other name, a refusal beside it, and allowAnyone still compile.
    route({ ...policy, authorize: () => (policy ? { userId: "u1", dataset: 1 } : unauthorized()) });
    route({ ...policy, authorize: allowAnyone });
  });

  it("types every callback from authorize, whatever order the options are written in", () => {
    // One object used to infer left to right: a callback written before authorize fixed its context at object.
    const contextOf = route(
      { authorize: ({ request }) => ({ teamId: request.url }), maxSize: 1, accept: "*/*" },
      {
        onComplete: ({ teamId, metadata }) => {
          expectTypeOf(teamId).toEqualTypeOf<string>();
          expectTypeOf(metadata).toEqualTypeOf<undefined>();
        },
        prefix: ({ teamId, file }) => {
          expectTypeOf(teamId).toEqualTypeOf<string>();
          expectTypeOf(file).toEqualTypeOf<{ id: string; name: string; size: number; type: string; ext: string }>();
          return teamId;
        },
      },
    );
    route(
      { accept: "*/*", maxSize: 1, authorize: () => ({ teamId: "t" }) },
      {
        key: ({ teamId }) => {
          expectTypeOf(teamId).toEqualTypeOf<string>();
          return teamId;
        },
        onComplete: ({ teamId }) => expectTypeOf(teamId).toEqualTypeOf<string>(),
      },
    );
    expectTypeOf(contextOf).toEqualTypeOf<Route<undefined, null, { teamId: string }>>();
  });

  it("types the schema's output in authorize and the callbacks when metadata is written after authorize", () => {
    const albums = route(
      {
        authorize: ({ metadata }) => {
          expectTypeOf(metadata).toEqualTypeOf<{ albumId: string; takenAt: Date }>();
          return { userId: metadata.albumId };
        },
        metadata: albumSchema,
        maxSize: 1,
        accept: "*/*",
      },
      {
        onComplete: ({ userId, metadata }) => {
          expectTypeOf(userId).toEqualTypeOf<string>();
          expectTypeOf(metadata).toEqualTypeOf<{ albumId: string; takenAt: string }>();
          return { userId };
        },
        key: ({ userId, metadata }) => {
          expectTypeOf(metadata).toEqualTypeOf<{ albumId: string; takenAt: Date }>();
          return `${userId}/${metadata.albumId}`;
        },
      },
    );
    expectTypeOf(albums).toEqualTypeOf<Route<{ albumId: string }, { userId: string }, { userId: string }>>();
  });

  it("types onComplete's metadata as undefined without a schema", () => {
    route(
      { accept: "*/*", maxSize: 1, authorize: allowAnyone },
      {
        onComplete: ({ metadata }) => {
          expectTypeOf(metadata).toEqualTypeOf<undefined>();
        },
      },
    );
  });

  it("gives the client the resolved value when the result type is a promise", () => {
    // Explicit generics: inferring from an async onComplete already unwraps Awaitable<TResult>, so TResult would be
    // { id: string } and the row would pass without route()'s Awaited. Only a TResult that is a promise proves it.
    const resolves = route<object, undefined, Promise<{ id: string }>>(
      { accept: "*/*", maxSize: 1, authorize: allowAnyone },
      { onComplete: async () => ({ id: "1" }) },
    );
    expectTypeOf(resolves).toEqualTypeOf<Route<undefined, { id: string }>>();
  });

  it("gives the client null when onComplete returns nothing, as /complete sends it", () => {
    const policy = { accept: "*/*", maxSize: 1, authorize: allowAnyone };
    const returnsNothing = route(policy, { onComplete: () => {} });
    const returnsUndefined = route(policy, { onComplete: () => undefined });
    const returnsObjectOrUndefined = route(policy, { onComplete: (): { id: string } | undefined => undefined });
    expectTypeOf(returnsNothing).toEqualTypeOf<Route<undefined, null>>();
    expectTypeOf(returnsUndefined).toEqualTypeOf<Route<undefined, null>>();
    expectTypeOf(returnsObjectOrUndefined).toEqualTypeOf<Route<undefined, { id: string } | null>>();
  });
});

describe("records and api by the server's routes and store (M12-T)", () => {
  const storage = r2({
    bucket: "uploads",
    accountId: "0123456789abcdef0123456789abcdef",
    accessKeyId: "k",
    secretAccessKey: "s",
  });
  const routes = {
    avatar: route({ accept: "image/*", maxSize: "5MB", authorize: allowAnyone }),
    docs: route({ accept: "application/pdf", maxSize: "50MB", authorize: allowAnyone }),
  };
  const store = sqlStore(sqliteExecutor({ exec() {}, prepare: () => ({ all: () => [] }) }));
  const stored = () => createCloudrop({ storage, secret: "test-secret-0123456789abcdef0123456789", routes, store });

  /** The records a listing call answers. The calls below sit in functions that never run: only types are asserted. */
  type ItemsOf<TCall extends () => Promise<{ data: { items: unknown[] } | null }>> = NonNullable<
    Awaited<ReturnType<TCall>>["data"]
  >["items"];

  it("types api.files as completed records of the server's routes", () => {
    const { api } = stored();
    type Item = ItemsOf<() => ReturnType<typeof api.files>>[number];
    expectTypeOf<Item>().toEqualTypeOf<CompletedRecord<"avatar" | "docs">>();
    expectTypeOf<Item["completedAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<Item["route"]>().toEqualTypeOf<"avatar" | "docs">();
    // @ts-expect-error: "nope" is not one of the server's routes.
    void (() => api.files({ owner: "u1", route: "nope" }));
    // @ts-expect-error: allFiles filters by the same route names.
    void (() => api.allFiles({ route: "nope" }));
  });

  it("narrows api.allFiles's records by the status asked for, and leaves them a union without one", () => {
    const { api } = stored();
    const failed = () => api.allFiles({ status: "failed" });
    const all = () => api.allFiles();
    expectTypeOf<ItemsOf<typeof failed>>().toEqualTypeOf<FailedRecord<"avatar" | "docs">[]>();
    expectTypeOf<ItemsOf<typeof all>>().toEqualTypeOf<FileRecord<"avatar" | "docs">[]>();
    expectTypeOf(api.file)
      .returns.resolves.toHaveProperty("data")
      .toEqualTypeOf<FileRecord<"avatar" | "docs"> | null>();
  });

  it("gives each status its own times, so a status check narrows them", () => {
    const record = {} as FileRecord;
    if (record.status === "completed") expectTypeOf(record.completedAt).toEqualTypeOf<Date>();
    if (record.status === "pending") expectTypeOf(record.claimedAt).toEqualTypeOf<null>();
    if (record.status === "deleted") expectTypeOf(record.cleanedAt).toEqualTypeOf<Date | null>();
    // A failed row that was claimed is a stuck completion, which the sweep ends cleaned.
    if (record.status === "failed" && record.claimedAt !== null) expectTypeOf(record.cleanedAt).toEqualTypeOf<Date>();
    expectTypeOf<RecordOf<"aborted" | "expired">>().toEqualTypeOf<AbortedRecord | ExpiredRecord>();
  });

  it("has the store's calls in api only when a store is surely passed", () => {
    const stateless = createCloudrop({ storage, secret: "test-secret-0123456789abcdef0123456789", routes });
    // @ts-expect-error: without a store, api has no store calls.
    void stateless.api.files;
    expectTypeOf(stateless.api.getUrl).toBeFunction();
    expectTypeOf(stored().api.files).toBeFunction();
    const withMemory = createCloudrop({ storage, routes, store: memoryStore({ transaction: true }) });
    expectTypeOf(withMemory.api.deleteFile).toBeFunction();
    const flag = Math.random() > 2;
    const maybe = createCloudrop({ storage, routes, store: flag ? store : undefined });
    // @ts-expect-error: a store that may be undefined gives the store-less api.
    void maybe.api.files;
  });
});
