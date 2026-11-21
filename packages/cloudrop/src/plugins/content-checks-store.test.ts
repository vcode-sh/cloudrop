import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SignedPart } from "../protocol/types.ts";
import type { CloudropPlugin } from "../server/plugins.ts";
import { route } from "../server/route.ts";
import { complete } from "../testing/complete-fixture.ts";
import { HTML } from "../testing/file-samples.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { leaseStore, NOW, storeFixture } from "../testing/store-fixture.ts";
import { contentChecks } from "./content-checks.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const PAGE = { name: "photo.png", size: HTML.length, type: "image/png" };

it.for([
  { name: "a single PUT under a lease", store: () => leaseStore(), multipartThreshold: undefined },
  { name: "a single PUT in a transaction", store: () => memoryStore(), multipartThreshold: undefined },
  { name: "a multipart upload under a lease", store: () => leaseStore(), multipartThreshold: 0 },
  { name: "a multipart upload in a transaction", store: () => memoryStore(), multipartThreshold: 0 },
])("ends a refused file rejected with nothing left behind: $name", async ({ store, multipartThreshold }) => {
  const reasons: string[] = [];
  let completions = 0;
  const witness: CloudropPlugin = { id: "witness", server: { onAbort: ({ reason }) => void reasons.push(reason) } };
  const fixture = storeFixture(
    {
      owned: route(
        { accept: "image/*", maxSize: "1MB", authorize: () => ({ userId: "u1" }) },
        { owner: ({ userId }) => userId, onComplete: () => void completions++ },
      ),
    },
    { store: store(), multipartThreshold, quota: () => 1000, plugins: [witness, contentChecks()] },
  );
  const response = await fixture.post("upload", { route: "owned", files: [PAGE] });
  const [ticket] = (await response.json()).files;
  const signed = ticket.kind === "single" ? ticket.put : (ticket.parts[0] as SignedPart);
  expect((await fixture.send(signed, HTML)).status).toBe(200);
  expect(await fixture.store.usage("u1")).toEqual({ reservedBytes: HTML.length, activeBytes: 0, files: 0 });

  expect((await complete(fixture, ticket.token)).body.error?.code).toBe("FILE_TYPE_NOT_ALLOWED");
  const [row] = await fixture.store.raw.files();
  expect([row?.status, row?.completedAt, fixture.fake.keys(), fixture.fake.pendingUploads()]).toEqual([
    "rejected",
    null,
    [],
    0,
  ]);
  expect(await fixture.store.usage("u1")).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0 });
  // The row decided: a retry finds the upload ended, and no hook runs again.
  expect((await complete(fixture, ticket.token)).body.error?.code).toBe("UPLOAD_EXPIRED");
  expect([reasons, completions]).toEqual([["rejected"], 0]);
});
