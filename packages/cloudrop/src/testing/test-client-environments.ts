// What testClient promises in every test environment an app may run it in (M11-R1): Node, and Vitest's happy-dom and
// jsdom environments, which replace Request, Headers, Blob and File with their own. One set of cases, run by
// testing.test.ts, testing.happy-dom.test.ts and testing.jsdom.test.ts.
// Oracle: the headers the handler's `authorize` read, and the bytes the bucket stored.

import { describe, expect, it } from "vitest";
import { createCloudrop, route } from "../index.ts";
import { testBucket, testClient } from "../testing.ts";

const secret = "a-test-secret-of-at-least-32-characters";

/** How each environment names itself in `navigator.userAgent`. */
const USER_AGENT = { node: /^Node\.js\//, "happy-dom": /HappyDOM\//, jsdom: /jsdom\// };

export function testClientEnvironmentCases(environment: keyof typeof USER_AGENT): void {
  describe(`testClient in ${environment}`, () => {
    // A misspelt `@vitest-environment` comment would run the cases below in Node and prove nothing.
    it("runs in the environment this file names", () => {
      expect(navigator.userAgent).toMatch(USER_AGENT[environment]);
    });

    // happy-dom's Request drops the headers a page may not set, cookie and origin among them.
    it("gives the handler every header the client sent, cookie and Origin included", async () => {
      const seen: Record<string, string | null>[] = [];
      const bucket = testBucket();
      const files = route({
        accept: "*/*",
        maxSize: "1MB",
        authorize: ({ request }) => {
          const { headers } = request;
          seen.push({
            cookie: headers.get("cookie"),
            origin: headers.get("origin"),
            authorization: headers.get("authorization"),
            type: headers.get("content-type"),
          });
          return {};
        },
      });
      const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { files } });
      const client = testClient(cloudrop, {
        bucket,
        headers: { cookie: "session=alice", authorization: "Bearer token" },
      });

      const { error } = await client.upload("files", new File(["hello"], "a.txt", { type: "text/plain" }));

      expect(error).toBeNull();
      expect(seen).toEqual([
        {
          cookie: "session=alice",
          origin: "http://localhost",
          authorization: "Bearer token",
          type: "application/json",
        },
      ]);
    });

    it("stores the bytes of the environment's File", async () => {
      const bucket = testBucket();
      const files = route({ accept: "*/*", maxSize: "1MB", authorize: () => ({}) });
      const cloudrop = createCloudrop({ storage: bucket.storage, secret, routes: { files } });

      const { data } = await testClient(cloudrop, { bucket }).upload(
        "files",
        new File([new Uint8Array([1, 2, 3, 250])], "a.bin", { type: "application/octet-stream" }),
      );

      expect(bucket.object(data?.file.key ?? "")?.body).toEqual(new Uint8Array([1, 2, 3, 250]));
    });
  });
}
