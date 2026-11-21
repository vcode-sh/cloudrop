// Setup shared by the contentChecks() tests: a route that accepts what a case says, one file uploaded to it, and what
// /complete then answers. It builds inputs only; every expected value stays in the tests.

import { type ContentCheckOptions, contentChecks } from "../plugins/content-checks.ts";
import type { CloudropPlugin } from "../server/plugins.ts";
import { allowAnyone, route } from "../server/route.ts";
import { complete } from "./complete-fixture.ts";
import { serverFixture } from "./server-fixture.ts";

export interface ContentCase {
  accept: string | string[];
  file: { name: string; type: string };
  body: Uint8Array<ArrayBuffer>;
  options?: ContentCheckOptions;
}

export interface ContentOutcome {
  status: number;
  error: Record<string, unknown> | null;
  /** Whether the bucket still holds the object. */
  kept: boolean;
  /** The reasons onAbort heard. */
  aborted: string[];
}

/**
 * A server with contentChecks on a route that accepts `accept`, `body` uploaded to it as `file`, and then the answer
 * to /complete, whether the bucket kept the object, and the reasons onAbort heard.
 */
export async function contentOutcome({ accept, file, body, options }: ContentCase): Promise<ContentOutcome> {
  const aborted: string[] = [];
  const witness: CloudropPlugin = { id: "witness", server: { onAbort: ({ reason }) => void aborted.push(reason) } };
  const files = route({ accept, maxSize: "1MB", authorize: allowAnyone });
  const fixture = serverFixture({ files }, { plugins: [witness, contentChecks(options)] });
  const ticket = await fixture.single("files", { ...file, size: body.length });
  const put = await fixture.send(ticket.put, body);
  if (put.status !== 200) throw new Error(`The fake bucket answered ${put.status} to the upload of ${file.name}.`);
  const { status, body: answer } = await complete(fixture, ticket.token);
  const kept = (await fixture.storage.head(ticket.key)).data !== null;
  return { status, error: answer.error ?? null, kept, aborted };
}
