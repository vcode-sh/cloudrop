// Setup shared by the /complete unit tests: a route that takes any file and the call that completes an upload. It
// builds inputs only; every expected value stays in the tests.

import type { CompleteResponse } from "../protocol/types.ts";
import { allowAnyone, type Route, route } from "../server/route.ts";
import type { ServerFixture } from "./server-fixture.ts";

export const files: Route<undefined, null> = route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone });

export async function complete(
  fixture: ServerFixture,
  token: string,
): Promise<{ status: number; body: CompleteResponse & { error?: Record<string, unknown> } }> {
  const response = await fixture.post("complete", { token });
  return {
    status: response.status,
    body: (await response.json()) as CompleteResponse & { error?: Record<string, unknown> },
  };
}
