// Setup shared by the handler's unit tests: one route, one upload body and requests built around them. It builds
// inputs only; every expected value stays in the tests.

import type { FileDescriptor } from "../protocol/types.ts";
import { allowAnyone, type Route, route } from "../server/route.ts";
import { APP_ORIGIN, type ServerFixture, serverFixture } from "./server-fixture.ts";

export const TRUSTED = "https://admin.example.com";
export const avatar: Route<undefined, null> = route({ accept: "image/png", maxSize: "1MB", authorize: allowAnyone });
export const uploadBody: { route: string; files: FileDescriptor[] } = {
  route: "avatar",
  files: [{ name: "a.png", size: 10, type: "image/png" }],
};

export function setup(): ServerFixture {
  return serverFixture({ avatar }, { trustedOrigins: [TRUSTED] });
}

export function request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method: "POST",
    body: JSON.stringify(uploadBody),
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

export async function outcome(response: Response): Promise<{ status: number; code: string | undefined }> {
  const body = (await response.json()) as { error?: { code: string } };
  return { status: response.status, code: body.error?.code };
}
