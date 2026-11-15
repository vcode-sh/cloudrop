// Type tests: `bun run typecheck` compiles this file, and every expectTypeOf and every expect-error directive is an
// assertion. The runtime tests only keep Vitest from reporting an empty file.

import { describe, expectTypeOf, it } from "vitest";
import type { InferableCloudrop, Jsonified, RouteMetadata, RouteName, RouteResult } from "./types.ts";

interface Server
  extends InferableCloudrop<{
    avatar: { metadata: { albumId: string }; result: { url: string } };
    notes: { metadata: undefined; result: null };
  }> {
  handler(request: Request): Promise<Response>;
}

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
    expectTypeOf<Jsonified<{ a: unknown; 1: string }>>().toEqualTypeOf<{ a: unknown; 1: string }>();
  });
});

describe("route types read from a server type", () => {
  it("names the routes and their metadata and result types", () => {
    expectTypeOf<RouteName<Server>>().toEqualTypeOf<"avatar" | "notes">();
    expectTypeOf<RouteMetadata<Server, "avatar">>().toEqualTypeOf<{ albumId: string }>();
    expectTypeOf<RouteResult<Server, "notes">>().toEqualTypeOf<null>();
    // @ts-expect-error: there is no route named "banner".
    expectTypeOf<RouteResult<Server, "banner">>();
  });
});
