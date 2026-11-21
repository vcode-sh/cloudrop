// Contract: M11-R260, over sequences of client calls. Once the server has finished a /complete (onComplete ran), no
// later call of the client deletes that file: not after the answer was lost, the tab closed or the page reloaded, and
// not through resume(), pause(), abort(), the signal, retry(), close(), discard(), forget(), going offline or pagehide,
// whatever the server or a proxy answers the /complete calls in between.
// Oracle: the keys onComplete was called with, each still in the fake bucket at the end, and with a store each one's
// row still `completed`. The literal cases the fuzz first found are in resume-keep.test.ts.
// The answers are those a finished upload can get. PARTS_MISSING, NOT_UPLOADED and NO_SUCH_UPLOAD are never made up:
// a server says them only of an upload it looked at and found unfinished, which is what ends `keep`.

import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCloudropClient, type UploadJob } from "../client.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type FaultCall, storageBusy } from "../testing/client-fixture.ts";
import { fakeIndexedDb } from "../testing/fake-indexeddb.ts";
import { fakeLocks } from "../testing/fake-locks.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { pageEvents } from "../testing/page-events.ts";
import { serverError } from "../testing/persist-fixture.ts";
import { offsetBytes } from "../testing/storage-contract.ts";
import type { ClientFetch } from "./endpoints.ts";

/** Sequences per run of the lane, about 0.5 s. M11-R260 records a run of 24,000 over four seeds: raise it to repeat. */
const RUNS = 40;
const SEED = 20261121;

/** "lost": the server's success never reaches the page. "cut": the request never reaches the server. */
const MODES = [
  ...(["pass", "lost", "cut", "noHeaders", "busyPage", "gatewayPage", "storageBusy"] as const),
  ...(["expired", "badToken", "unknownRoute", "refused"] as const),
];
type Mode = (typeof MODES)[number];

/** What a /complete is answered in the server's place. */
const ANSWERS: Partial<Record<Mode, () => Response>> = {
  // A proxy's own pages: RATE_LIMITED, and a SERVER_ERROR that leaves the doubt.
  busyPage: () => new Response("Too many requests", { status: 429 }),
  gatewayPage: () => new Response("Bad gateway", { status: 502 }),
  storageBusy,
  // Another instance of the server, whose clock is ahead or whose deploy lost the route or the secret.
  expired: () => serverError(410, "UPLOAD_EXPIRED", "This upload has expired. Start it again."),
  badToken: () => serverError(400, "INVALID_TOKEN", "The upload token is not valid. Start the upload again."),
  unknownRoute: () => serverError(404, "UNKNOWN_ROUTE", "This server has no such upload route."),
  refused: () => serverError(403, "ORIGIN_NOT_ALLOWED", "This origin may not upload here."),
};

const ACTIONS = [
  ...["resume", "pause", "unpause", "abort", "dismiss", "signal", "retry", "close", "closeAbort"],
  ...["discard", "forget", "offline", "online", "pagehide", "reload"],
] as const;
type Action = (typeof ACTIONS)[number];

/**
 * How the first page left the upload. "closed": its tab closed while /complete was in flight, and the server finished
 * the file. "doubt" and "upload": the page lives, and the answer of its first /complete, which the server finished,
 * was lost; start() and upload(). "unfinished": the tab closed before its one part was sent.
 */
type First = "closed" | "doubt" | "upload" | "unfinished";

interface Sequence {
  stored: boolean;
  first: First;
  mode: Mode;
  steps: { act: Action | Mode; wait: 0 | 1 | 2 }[];
  end: "close" | "closeAbort";
}

const file = () => new File([offsetBytes(1000)], "a.bin", { type: "application/octet-stream", lastModified: 1 });
const never = () => new Promise<never>(() => {});
const turn = () => new Promise((resolve) => setImmediate(resolve));

interface Page {
  dead: boolean;
  events: ReturnType<typeof pageEvents>;
  client: ReturnType<typeof createCloudropClient>;
  open(): ReturnType<typeof createCloudropClient>;
  job: UploadJob<unknown> | null;
  cancel: AbortController;
  /** What the page's calls answered with: all of it is awaited before the bucket is read. */
  loose: Promise<unknown>[];
}

/** One server and bucket, one browser profile (IndexedDB, Web Locks), and the page that is open now. */
function createWorld({ stored, first, mode }: Sequence) {
  const db = fakeIndexedDb();
  const locks = fakeLocks();
  const navigator = { locks: locks.locks, onLine: true };
  vi.stubGlobal("indexedDB", db.indexedDB);
  vi.stubGlobal("navigator", navigator);
  const finished = new Set<string>();
  const files = route(
    { accept: "*/*", maxSize: "1MB", authorize: allowAnyone },
    {
      onComplete: ({ file }) => {
        finished.add(file.key);
        return null;
      },
    },
  );
  const store = stored ? memoryStore() : undefined;
  // The first page works on a server that answers; `mode` holds from where `first` says the page got to.
  const state = { mode: "pass" as Mode, completes: 0, inFlight: 0 };
  /** A /complete answered as `how` says: by the server, by nobody, or by an answer made up in the server's place. */
  const complete = async (call: FaultCall, how: Mode): Promise<Response> => {
    if (how === "cut") throw new TypeError("Failed to fetch");
    const made = ANSWERS[how];
    if (made) return made();
    const sent = await call.forward(call.init);
    if (how === "lost" && sent.ok) throw new TypeError("Failed to fetch");
    return sent;
  };
  const answer = async (call: FaultCall): Promise<Response> => {
    const { page } = self;
    if (first === "unfinished" && call.label === "PUT part 1" && call.nth === 1) {
      page.dead = true;
      state.mode = mode;
      throw new TypeError("The tab closed.");
    }
    if (call.label !== "POST /complete") return call.forward(call.init);
    if (first === "unfinished" || state.completes++ > 0) return complete(call, state.mode);
    // The first page's first /complete: the server finishes it, and its answer reaches nobody.
    try {
      return await complete(call, "lost");
    } finally {
      page.dead = first === "closed";
      state.mode = mode;
    }
  };
  const fixture = clientFixture(
    { files },
    {
      multipartThreshold: 0,
      store,
      fault: (call) => {
        state.inFlight += 1;
        return answer(call).finally(() => {
          state.inFlight -= 1;
        });
      },
    },
  );
  function openPage(): Page {
    const page: Page = {
      dead: false,
      // A new target each time: the listeners of a page that is gone hear nothing more.
      events: pageEvents(),
      open: () =>
        createCloudropClient({
          basePath: fixture.basePath,
          // A page that is gone hears no answer, and sends nothing more.
          fetch: (async (url, init) => {
            if (page.dead) return never();
            const outcome = await fixture.fetch(url, init).then(
              (response) => () => response,
              (error) => () => Promise.reject(error),
            );
            return page.dead ? never() : outcome();
          }) satisfies ClientFetch,
          headers: () => {
            if (state.mode === "noHeaders") throw new Error("No session token.");
            return {};
          },
        }),
      client: null as never,
      job: null,
      cancel: new AbortController(),
      loose: [],
    };
    page.client = page.open();
    return page;
  }
  const self = {
    db,
    locks,
    navigator,
    state,
    store,
    finished,
    storage: fixture.server.storage,
    page: openPage(),
    reload() {
      self.page.dead = true;
      locks.releaseAll();
      navigator.onLine = true;
      self.page = openPage();
    },
    /** Resolves once no request is in flight and the browser's store is quiet, twice in a row. */
    async quiet() {
      for (let calm = 0; calm < 2; calm = state.inFlight === 0 ? calm + 1 : 0) await db.settled();
    },
  };
  return self;
}

type World = ReturnType<typeof createWorld>;

const listed = async ({ page }: World) => ((await page.client.resumable()).data ?? [])[0];

const ACT: Record<Action, (world: World) => unknown> = {
  resume: async (world) => {
    const upload = await listed(world);
    const { page } = world;
    if (!upload) return;
    page.cancel = new AbortController();
    page.job = page.client.resume(upload, file(), { signal: page.cancel.signal });
  },
  pause: ({ page }) => page.job?.pause(),
  unpause: ({ page }) => page.job?.resume(),
  abort: ({ page }) => page.job?.abort(),
  dismiss: ({ page }) => page.job?.files[0]?.abort(),
  signal: ({ page }) => page.cancel.abort(),
  retry: ({ page }) => page.job && page.loose.push(page.job.retry()),
  close: ({ page }) => {
    page.loose.push(page.client.close());
    page.client = page.open();
  },
  closeAbort: ({ page }) => {
    page.loose.push(page.client.close({ abort: true }));
    page.client = page.open();
  },
  discard: async (world) => {
    const upload = await listed(world);
    if (upload) world.page.loose.push(world.page.client.discard(upload));
  },
  forget: ({ page }) => page.loose.push(page.client.forget()),
  offline: ({ page, navigator }) => {
    navigator.onLine = false;
    page.events.fire("offline");
  },
  online: ({ page, navigator }) => {
    navigator.onLine = true;
    page.events.fire("online");
  },
  pagehide: ({ page }) => page.events.fire("pagehide"),
  reload: (world) => world.reload(),
};

/** Runs `sequence` and answers the finished files that are gone, and with a store those whose row is not completed. */
async function run(sequence: Sequence): Promise<{ deleted: string[]; notCompleted: string[] }> {
  const world = createWorld(sequence);
  const { first } = sequence;
  const { page } = world;
  if (first === "upload") page.loose.push(page.client.upload("files", file(), { signal: page.cancel.signal }));
  else page.job = page.client.start("files", file(), { signal: page.cancel.signal });
  // Until the first page got as far as `first` says, and its record is saved where the tab then closes.
  const closes = first === "closed" || first === "unfinished";
  const there = () =>
    closes ? page.dead && Object.keys(world.db.stored()).length === 1 : world.finished.size > 0 || page.dead;
  for (let turns = 0; !there(); turns++) {
    if (turns > 100_000) throw new Error(`The first page never got as far as "${first}".`);
    await turn();
  }
  if (closes) world.reload();
  for (const { act, wait } of sequence.steps) {
    if (act in ACT) await ACT[act as Action](world);
    else world.state.mode = act as Mode;
    if (wait === 1) await turn();
    if (wait === 2) await world.quiet();
  }
  // The page that is open ends every job it runs, and each /abort it sends is answered.
  world.state.mode = "pass";
  await ACT[sequence.end](world);
  await Promise.all(world.page.loose);
  await world.quiet();
  const keys = [...world.finished];
  const heads = await Promise.all(keys.map((key) => world.storage.head(key)));
  const rows = (await world.store?.raw.files()) ?? [];
  const completed = new Set(rows.filter((row) => row.status === "completed").map((row) => row.key));
  return {
    deleted: keys.filter((_, index) => !heads[index]?.data),
    notCompleted: world.store ? keys.filter((key) => !completed.has(key)) : [],
  };
}

// Biased toward the calls that end an upload and toward the answers that hide a completion.
const step = fc.record({
  act: fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom<Action | Mode>("resume", "abort", "dismiss", "pause") },
    { weight: 3, arbitrary: fc.constantFrom<Action | Mode>("retry", "close", "closeAbort", "discard", "reload") },
    { weight: 3, arbitrary: fc.constantFrom<Action | Mode>("lost", "busyPage", "expired", "unknownRoute", "pass") },
    { weight: 2, arbitrary: fc.constantFrom<Action | Mode>(...ACTIONS, ...MODES) },
  ),
  wait: fc.constantFrom<0 | 1 | 2>(0, 1, 2, 2),
});
const sequences: fc.Arbitrary<Sequence> = fc.record({
  stored: fc.boolean(),
  first: fc.constantFrom<First>("closed", "closed", "closed", "doubt", "upload", "unfinished"),
  mode: fc.constantFrom<Mode>("pass", "lost", "lost", "busyPage", ...MODES),
  steps: fc.array(step, { minLength: 1, maxLength: 12 }),
  end: fc.constantFrom<"close" | "closeAbort">("close", "closeAbort"),
});

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// About 0.5 s: each of the 40 sequences runs a server, a bucket and one or more pages through real 1 ms timers.
it("never deletes a file whose /complete the server finished, whatever the client is asked next", async () => {
  await fc.assert(
    fc.asyncProperty(sequences, async (sequence) => {
      expect(await run(sequence)).toEqual({ deleted: [], notCompleted: [] });
    }),
    { seed: SEED, numRuns: RUNS },
  );
});
