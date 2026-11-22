// Type tests: `bun run typecheck` compiles this file, and every expectTypeOf and every expect-error directive is an
// assertion. The runtime tests only keep Vitest from reporting an empty file.

import { describe, expectTypeOf, it } from "vitest";
import type { InferableCloudrop, Jsonified, RouteMetadata, RouteName, RouteResult } from "./types.ts";

type Server = InferableCloudrop<{
  avatar: { metadata: { albumId: string }; result: { url: string } };
  notes: { metadata: undefined; result: null };
}>;

describe("Jsonified", () => {
  it("is what JSON.stringify and JSON.parse make of a value", () => {
    expectTypeOf<
      Jsonified<{ a: Date; b?: number; c: () => void; d: undefined; e: [Date]; f: string | null }>
    >().toEqualTypeOf<{
      a: string;
      b?: number;
      e: string[];
      f: string | null;
    }>();
  });

  it("keeps unknown values and numeric keys, as JSON does", () => {
    expectTypeOf<Jsonified<{ a: unknown; 1: string }>>().toEqualTypeOf<{ a?: unknown; 1: string }>();
  });

  // JSON.stringify leaves out a key whose value is undefined, so a value that may be undefined may be missing (M12-R20).
  it("makes a key optional when its value may be undefined", () => {
    expectTypeOf<
      Jsonified<{ teamId: string | undefined; at: Date | undefined; nested: { id: number | undefined } }>
    >().toEqualTypeOf<{ teamId?: string; at?: string; nested: { id?: number } }>();
  });
});

describe("route types read from a server type", () => {
  it("names the routes and their metadata and result types", () => {
    expectTypeOf<RouteName<Server>>().toEqualTypeOf<"avatar" | "notes">();
    expectTypeOf<RouteMetadata<Server, "avatar">>().toEqualTypeOf<{ albumId: string }>();
    expectTypeOf<RouteMetadata<Server, "notes">>().toEqualTypeOf<undefined>();
    expectTypeOf<RouteResult<Server, "avatar">>().toEqualTypeOf<{ url: string }>();
    expectTypeOf<RouteResult<Server, "notes">>().toEqualTypeOf<null>();
    // @ts-expect-error: there is no route named "banner".
    expectTypeOf<RouteResult<Server, "banner">>();
  });
});
