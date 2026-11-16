import { describe, expect, it } from "vitest";
import { APP_ORIGIN, serverFixture } from "../testing/server-fixture.ts";
import { allowAnyone, route } from "./route.ts";

const avatar = route({ accept: "image/png", maxSize: "1MB", authorize: allowAnyone });
// Behind a proxy that terminates TLS, the browser's page is https while the handler sees plain http.
const BEHIND_PROXY = "http://app.example.com/api/cloudrop/upload";

function upload(origin: string, url = BEHIND_PROXY): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ route: "avatar", files: [{ name: "a.png", size: 10, type: "image/png" }] }),
  });
}

async function answer(response: Response) {
  return {
    status: response.status,
    cors: response.headers.get("access-control-allow-origin"),
    ...(await response.json()),
  };
}

describe("cloudrop.handler hint for a refused origin", () => {
  it("still refuses the app behind a TLS-terminating proxy, and tells the operator once what to configure", async () => {
    const fixture = serverFixture({ avatar });
    const first = await answer(await fixture.cloudrop.handler(upload(APP_ORIGIN)));
    await fixture.cloudrop.handler(upload(APP_ORIGIN));
    expect(first).toEqual({
      status: 403,
      cors: null,
      error: {
        code: "ORIGIN_NOT_ALLOWED",
        message: "This site may not upload here. Add its origin to trustedOrigins in createCloudrop.",
        retryable: false,
      },
    });
    expect(fixture.logger.warnings).toEqual([
      "cloudrop: refused a request from https://app.example.com, but this server sees its own origin as http://app.example.com. If a proxy terminates TLS or rewrites Host, add the app's public origin to trustedOrigins.",
    ]);
  });

  it.for([
    { name: "null", origin: "null" },
    { name: "an origin with a path", origin: "https://evil.example/upload" },
    { name: "a value that is no URL", origin: "not an origin" },
  ])("never echoes $name, which is not an exact origin", async ({ origin }) => {
    const fixture = serverFixture({ avatar });
    expect((await fixture.cloudrop.handler(upload(origin))).status).toBe(403);
    expect(fixture.logger.warnings).toEqual([]);
  });

  it("stops hinting after 16 distinct origins, so a flood of cross-site requests cannot fill the log", async () => {
    const fixture = serverFixture({ avatar });
    const origins = Array.from({ length: 20 }, (_, index) => `https://site${index}.example`);
    for (const origin of origins) await fixture.cloudrop.handler(upload(origin, `${APP_ORIGIN}/api/cloudrop/upload`));
    expect(fixture.logger.warnings).toHaveLength(16);
    expect(fixture.logger.warnings.at(-1)).toBe(
      "cloudrop: refused a request from https://site15.example, but this server sees its own origin as https://app.example.com. If a proxy terminates TLS or rewrites Host, add the app's public origin to trustedOrigins.",
    );
  });
});
