// A cloudrop server on the in-process fake R2 behind a fetch the client can use, for the client's unit tests. Requests
// to the app reach cloudrop.handler as a same-origin browser sends them; presigned requests reach the fake bucket. A
// fault can answer any request in their place.

import type { ClientFetch } from "../client/endpoints.ts";
import type { FileStatus, UploadJob } from "../client.ts";
import type { Route } from "../server/route.ts";
import { APP_ORIGIN, type ServerFixture, serverFixture } from "./server-fixture.ts";

export interface FaultCall {
  /** What `requests` records for this call, such as "POST /sign" or "PUT part 2". */
  label: string;
  /** 1 for the first call with this label, 2 for the second… */
  nth: number;
  init: RequestInit;
  /** Sends the request to where it was going and returns the real answer. */
  forward(init: RequestInit): Promise<Response>;
}

/** Answers a call in place of its target, or returns undefined to let it through. A throw is a network failure. */
export type Fault = (call: FaultCall) => Response | undefined | Promise<Response | undefined>;

export interface ClientFixture {
  server: ServerFixture;
  /** The client's fetch: the app origin goes to cloudrop.handler, the bucket to the fake R2. */
  fetch: ClientFetch;
  /** `${APP_ORIGIN}/api/cloudrop` */
  basePath: string;
  /** "POST /upload", "POST /sign", "POST /complete", "POST /abort", "PUT object", "PUT part 2": never a URL. */
  requests: string[];
}

const BASE_PATH = `${APP_ORIGIN}/api/cloudrop`;

function labelOf(url: string, init: RequestInit): string {
  const method = init.method ?? "GET";
  if (url.startsWith(BASE_PATH)) return `${method} ${url.slice(BASE_PATH.length)}`;
  const partNumber = new URL(url).searchParams.get("partNumber");
  return partNumber === null ? `${method} object` : `${method} part ${partNumber}`;
}

export function clientFixture<TRoutes extends Record<string, Route>>(
  routes: TRoutes,
  options: Parameters<typeof serverFixture<TRoutes>>[1] & {
    fault?: Fault;
    /** Added to every request to the app, as a browser's session cookie would be: the client itself sends none. */
    appHeaders?: Record<string, string>;
  } = {},
): ClientFixture {
  const { fault, appHeaders, ...rest } = options;
  const server = serverFixture(routes, rest);
  const requests: string[] = [];
  const counts = new Map<string, number>();

  const send = (url: string, init: RequestInit): Promise<Response> =>
    url.startsWith(APP_ORIGIN)
      ? server.cloudrop.handler(
          new Request(url, {
            method: init.method,
            body: init.body,
            headers: { ...Object.fromEntries(new Headers(init.headers)), ...appHeaders, origin: APP_ORIGIN },
          }),
        )
      : server.fake.fetch(url, init);

  const fetch: ClientFetch = async (url, init) => {
    // A browser starts no request for a cancelled signal, and rejects one cancelled meanwhile with AbortError.
    init.signal?.throwIfAborted();
    const label = labelOf(url, init);
    const nth = (counts.get(label) ?? 0) + 1;
    counts.set(label, nth);
    requests.push(label);
    const answer =
      (await fault?.({ label, nth, init, forward: (changed) => send(url, changed) })) ?? (await send(url, init));
    init.signal?.throwIfAborted();
    return answer;
  };

  return { server, fetch, basePath: BASE_PATH, requests };
}

// Answers the server and the bucket really send, for faults to return in place of the real answer.

/** A part the bucket says it stored, though it never reached it. */
export const lostPart = (): Response => new Response(null, { status: 200 });

/** The server's answer when storage is rate-limited (storageFailure in server/http.ts). */
export const storageBusy = (): Response =>
  Response.json(
    {
      error: { code: "RATE_LIMITED", message: "The storage service is busy. Try again in a moment.", retryable: true },
    },
    { status: 503 },
  );

/** The server's answer after it verified and kept the object but could not finish (unfinished() in complete.ts). */
export const unfinished = (): Response =>
  Response.json(
    {
      error: {
        code: "SERVER_ERROR",
        message: "The file was uploaded, but the server could not finish processing it. Try again in a moment.",
        retryable: true,
      },
    },
    { status: 500 },
  );

/** Each file's status, in the order the files were passed. */
export const statuses = (job: UploadJob<unknown>): FileStatus[] => job.getSnapshot().files.map((file) => file.status);
