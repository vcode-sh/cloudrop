// Type inference tests (spec §11.5). `bun run typecheck` compiles this file: every expectTypeOf and every
// expect-error directive is an assertion. The runtime tests only keep Vitest from reporting an empty file.

import { describe, expectTypeOf, it } from "vitest";
import type { RouteMetadata, RouteName, RouteResult } from "../protocol/types.ts";
import { r2 } from "../storage/presets.ts";
import { createCloudrop } from "./cloudrop.ts";
import { allowAnyone, type Route, route, unauthorized } from "./route.ts";
import type { StandardSchema } from "./schema.ts";

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
    expectTypeOf(contextOf).toEqualTypeOf<Route<undefined, null>>();
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
    expectTypeOf(albums).toEqualTypeOf<Route<{ albumId: string }, { userId: string }>>();
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
