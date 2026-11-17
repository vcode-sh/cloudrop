// The chaos proxy as the `*.chaos.browser.test.ts` rows see it: scripts/test-browser.sh starts it between the example's
// server and RustFS and passes its control endpoint here. `test` clears the rules and the log before each row and the
// rules after it, so no fault outlives its row.
import { test as base } from "@playwright/test";

// The parts of the proxy's API (packages/cloudrop/src/testing/chaos-proxy.ts) these rows use, written out: importing
// that file would pull its `.ts` import paths into the example's typecheck, which does not allow them.
type Match = {
  kind: "presigned" | "server";
  operation: "PutObject" | "UploadPart";
  part?: number;
  nth?: number | "every";
};
type Fault =
  | { kind: "reset"; afterBytes: number }
  | { kind: "blackhole" }
  | { kind: "throttle"; bytesPerSecond: number }
  | {
      kind: "answer";
      status: number;
      body?: string;
      headers?: Record<string, string>;
      cors?: boolean;
      exposeRetryAfter?: boolean;
    }
  | { kind: "truncate"; at: "beforeHeaders" };
export interface ChaosRule {
  match: Match;
  fault: Fault;
}
export interface ChaosEntry {
  label: string;
  kind: "presigned" | "server" | "preflight";
  outcome: number | "reset" | "closed" | "held" | "aborted" | "error";
  bytesIn: number;
  startMs: number;
  endMs: number | null;
}

const controlUrl = process.env.CLOUDROP_CHAOS_CONTROL_URL;
if (!controlUrl)
  throw new Error(
    "CLOUDROP_CHAOS_CONTROL_URL is not set. Run the chaos rows through `bun run test:browser`, which starts the proxy.",
  );

async function control(route: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${controlUrl}${route}`, {
    method: route === "/log" ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`The chaos proxy refused ${route} (HTTP ${response.status}): ${await response.text()}`);
  return response;
}

export interface Chaos {
  /** Replaces the proxy's rules and their counters. */
  set(rules: ChaosRule[]): Promise<void>;
  /** What reached the proxy, in start order: requests that ended, and black-holed ones still held. */
  log(): Promise<ChaosEntry[]>;
}

export const test = base.extend<{ chaos: Chaos }>({
  chaos: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this pattern; it has none.
    async ({}, use) => {
      await control("/rules", []);
      await control("/clear-log");
      await use({
        set: async (rules) => void (await control("/rules", rules)),
        log: async () => (await control("/log")).json(),
      });
      await control("/rules", []);
      // A held request would keep its socket open into the next row.
      await control("/release");
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";

/** The presigned PUTs that reached the proxy, as [label, outcome], in start order. */
export const bucketPuts = (log: readonly ChaosEntry[]): [string, ChaosEntry["outcome"]][] =>
  log.filter((entry) => entry.kind === "presigned").map((entry) => [entry.label, entry.outcome]);
