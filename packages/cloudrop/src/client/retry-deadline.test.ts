// Contract: M9-H3 through the real client. The server signs no URL in a ticket's last 15 minutes, so retry() of a
// failed file there asks /upload for a new ticket when parts are still to send, and keeps the ticket when only
// /complete is left, which the token still answers until it expires.
// Oracle: the requests the fixture saw and the keys the server issued.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient } from "../client.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, storageBusy } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone });

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Uploads three parts (8 MiB, 8 MiB, 5 bytes) while `failing` answers for the request it names, then retries the
 * failed file 14 minutes before its ticket expires, with nothing failing any more.
 */
async function retryInLastMinutes(label: string, failing: () => Response) {
  const issued: { key: string; expiresAt: string }[] = [];
  let failed = true;
  const fixture = clientFixture(
    { files },
    {
      multipartThreshold: "8MB",
      fault: async (call) => {
        if (call.label === "POST /upload") {
          const answer = await call.forward(call.init);
          issued.push(...(await answer.clone().json()).files);
          return answer;
        }
        return failed && call.label === label ? failing() : undefined;
      },
    },
  );
  const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch });
  const job = client.start("files", new File([offsetBytes(16 * MiB + 5)], "a.bin"));
  const first = await job.done;
  failed = false;
  vi.setSystemTime(Date.parse(issued[0]?.expiresAt ?? "") - 14 * 60_000);
  const start = fixture.requests.length;
  const outcome = await job.files[0]?.retry();
  return {
    first: first.error?.code,
    sent: fixture.requests.slice(start).sort(),
    key: outcome?.status === "done" ? outcome.result.file.key : outcome?.error.code,
    issued: issued.map(({ key }) => key),
  };
}

describe("retry() in a ticket's last 15 minutes (M9-H3)", () => {
  it("asks /upload for a new ticket when a part is still to send: the server would not sign it", async () => {
    const storageDown = () => errorResponse(500, "InternalError", "We encountered an internal error.");
    const { issued, ...result } = await retryInLastMinutes("PUT part 2", storageDown);
    expect(result).toEqual({
      first: "STORAGE_ERROR",
      // The /abort gives the first ticket up, whose part 1 had landed (M11-R89).
      sent: ["POST /abort", "POST /complete", "POST /upload", "PUT part 1", "PUT part 2", "PUT part 3"],
      key: issued[1],
    });
  });

  it("keeps the ticket when every part landed: its /complete still works", async () => {
    const { issued, ...result } = await retryInLastMinutes("POST /complete", storageBusy);
    expect(result).toEqual({ first: "RATE_LIMITED", sent: ["POST /complete"], key: issued[0] });
  });
});
