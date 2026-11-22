// A store object without the store's code (M12-S): the server cannot run a store path without it, so every request and
// every api call answers INVALID_CONFIG naming the fix, as for a missing environment setting.

import { describe, expect, it } from "vitest";
import { files } from "../testing/complete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import type { CloudropStore } from "./store.ts";

const NO_PATHS =
  'The store carries none of the store code the server runs. If you wrote it yourself, wrap it with defineStore from "cloudrop/store"; if you wrapped an adapter\'s store, copy it with spread ({ ...store }), which keeps that code.';

/** Every CloudropStore method, copied by name the way a hand-written store or wrapper would: no symbol properties. */
const methodsOnly = (): CloudropStore<unknown> =>
  Object.fromEntries(Object.entries(memoryStore())) as unknown as CloudropStore<unknown>;

describe("createCloudrop with a store that carries no store code", () => {
  it("answers every endpoint a retryable 500 and logs the INVALID_CONFIG once", async () => {
    const fixture = serverFixture({ files }, { store: methodsOnly() });
    const answers = await Promise.all(
      ["upload", "sign", "complete", "abort"].map(async (endpoint) => {
        const response = await fixture.post(endpoint, {});
        return [endpoint, response.status, ((await response.json()) as { error: unknown }).error];
      }),
    );
    const notReady = {
      code: "SERVER_ERROR",
      message: "The upload server is not ready. Try again in a moment.",
      retryable: true,
    };
    expect(answers).toEqual([
      ["upload", 500, notReady],
      ["sign", 500, notReady],
      ["complete", 500, notReady],
      ["abort", 500, notReady],
    ]);
    expect(fixture.logger.errors).toEqual([
      {
        message: `cloudrop: every request answers 500 until this is fixed. ${NO_PATHS}`,
        error: expect.objectContaining({ code: "INVALID_CONFIG", message: NO_PATHS }),
      },
    ]);
  });

  it("answers an api call INVALID_CONFIG with the fix", async () => {
    const { cloudrop } = serverFixture({ files }, { store: methodsOnly() });
    expect(await cloudrop.api.files({ owner: "u1" })).toEqual({
      data: null,
      error: expect.objectContaining({ code: "INVALID_CONFIG", message: NO_PATHS }),
    });
  });
});
