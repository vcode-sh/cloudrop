// Contract: M4-F4 and M11-R86. A cancel while /complete is in flight does not cut that request off: the file stays
// `completing` until the server answers, then ends with the answer. A completion that succeeded ends the file `done`,
// with its result and no /abort; one that failed ends it `aborted`. The same through upload() and its signal:
// upload-failures.test.ts ("upload, when it is cancelled").
// Oracle: the statuses the page sees before and after the answer, the result, and the requests the fixture saw.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient } from "../client.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault, statuses, storageBusy } from "../testing/client-fixture.ts";
import { gate } from "../testing/persist-fixture.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone });
const file = () => new File([offsetBytes(1000)], "a.bin", { type: "application/octet-stream" });

/** A client whose /complete is held until `held.open()`, then answered by `answer` or by the server. */
function setup(answer: Fault = () => undefined) {
  const held = gate(({ label }) => label === "POST /complete");
  const fixture = clientFixture(
    { files },
    {
      fault: async (call) => {
        await held.fault(call);
        return answer(call);
      },
    },
  );
  const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, persist: false });
  return { fixture, held, client };
}

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

describe("a cancel while /complete is in flight", () => {
  it("keeps the file completing until the answer, and ends it done when the server completed it", async () => {
    const { fixture, held, client } = setup();
    const job = client.start("files", file());
    await held.reached;
    job.files[0]?.abort();
    const afterCancel = statuses(job);
    held.open();
    const { data, error } = await job.done;

    expect({ afterCancel, error, files: data?.files.map((outcome) => outcome.status), sent: fixture.requests }).toEqual(
      {
        afterCancel: ["completing"],
        error: null,
        files: ["done"],
        sent: ["POST /upload", "PUT object", "POST /complete"],
      },
    );
  });

  it("ends the file aborted once a /complete that failed has answered, without another attempt", async () => {
    // RATE_LIMITED: the storage was busy, so the server completed nothing and the cancel's /abort follows.
    const { fixture, held, client } = setup(({ label }) => (label === "POST /complete" ? storageBusy() : undefined));
    const job = client.start("files", file());
    await held.reached;
    job.abort();
    const afterCancel = statuses(job);
    held.open();
    const { error } = await job.done;

    expect({ afterCancel, error: error?.code, after: statuses(job), sent: fixture.requests }).toEqual({
      afterCancel: ["completing"],
      error: "ABORTED",
      after: ["aborted"],
      sent: ["POST /upload", "PUT object", "POST /complete", "POST /abort"],
    });
  });
});
