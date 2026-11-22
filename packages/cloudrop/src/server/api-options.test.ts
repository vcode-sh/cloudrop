// One rule for the options argument of every api call that can do without it (M11-R245): null and undefined both mean
// no options, and anything else that is not a plain object is refused with the call's own message.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Result } from "../errors.ts";
import { NOW, owned, storeFixture } from "../testing/store-fixture.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type Api = ReturnType<typeof storeFixture>["cloudrop"]["api"];

it.for<{ name: string; call: (api: Api, options: never) => Promise<Result<unknown>>; message: string }>([
  {
    name: "allFiles",
    call: (api, options) => api.allFiles(options),
    message: "allFiles takes { owner, status, route, name, type, order, limit, cursor }, all optional.",
  },
  {
    name: "deleteFile",
    call: (api, options) => api.deleteFile("no-such-file", options),
    message: "deleteFile takes the file id and optionally { context }.",
  },
  {
    name: "eraseOwner",
    call: (api, options) => api.eraseOwner("u1", options),
    message: "eraseOwner takes options such as { graceMs: 3600000 }.",
  },
  {
    name: "reconcile",
    call: (api, options) => api.reconcile(options),
    message: "reconcile takes { owner } or nothing.",
  },
  { name: "sweep", call: (api, options) => api.sweep(options), message: "sweep takes options such as { limit: 100 }." },
  {
    name: "getUrl",
    call: (api, options) => api.getUrl("users/u1/a.txt", options),
    message: "getUrl options must be an object, such as { expiresIn: 3600 }.",
  },
  {
    name: "putObject",
    call: (api, options) => api.putObject("users/u1/a.txt", "a", options),
    message: 'putObject options must be an object, such as { type: "text/plain" }.',
  },
  {
    name: "checkBucket",
    call: (api, options) => api.checkBucket(options),
    message: 'checkBucket: pass a list of origins as text, such as ["https://app.example.com"].',
  },
])("api.$name reads null as no options, and refuses options that are an array or text", async (row) => {
  const { api } = storeFixture({ owned }).cloudrop;
  const call = (options: unknown) => row.call(api, options as never);
  const refusal = { data: null, error: expect.objectContaining({ code: "INVALID_INPUT", message: row.message }) };
  expect([await call([]), await call("image/png")]).toEqual([refusal, refusal]);
  // Whatever the call answers without options (deleteFile's NOT_FOUND for this id too), it answers the same to null.
  expect(await call(null)).toEqual(await call(undefined));
});
