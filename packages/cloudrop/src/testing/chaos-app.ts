// The chaos lane's path from the client to the app: cloudrop.handler in process, as a same-origin browser reaches it,
// recorded call by call. App faults lose an answer the server has already worked out, which is the case a database
// store exists for: the client cannot tell whether the call happened, so it asks again.

import type { ClientFetch } from "../client/endpoints.ts";

export type AppCall = "upload" | "sign" | "complete" | "abort";

/**
 * - reset: the server answers in full and the connection drops before the client reads a byte.
 * - late: the client's deadline passes while the server is still working: once `until` settles (at once without
 *   it), the client gets no answer and the server's call runs on. The client's own deadline (120 s for /complete)
 *   would make the row that slow; `until` places the moment, such as when onComplete has started.
 * - gateway: a proxy in front of the app replaces the server's finished answer with its own page of this status.
 */
export type AppFault =
  | { kind: "reset" }
  | { kind: "late"; until?: Promise<unknown> }
  | { kind: "gateway"; status: number };

/** Faults the next call to `call`, once. */
export interface AppRule {
  call: AppCall;
  fault: AppFault;
}

export interface AppTransport {
  /** The client's fetch: refuses everything once `ended` fired, so a test's calls cannot reach the next test. */
  fetchUntil(ended: AbortSignal): ClientFetch;
  /** "POST /complete 200", with the fault after the server's status: "POST /complete 200 reset". */
  requests(): string[];
  /** The bodies of the app's error answers, in order, as the client got them. */
  errors(): unknown[];
  /** Replaces the faults still waiting for their call. */
  setFaults(rules: AppRule[]): void;
  /** Waits for every call whose answer was lost and which the server is still working on. */
  settled(): Promise<void>;
  /** Clears the faults and the logs; call after settled(). */
  clear(): void;
}

const lostAnswer = () => new TypeError("fetch failed: the connection was reset before the answer arrived.");
const deadlinePassed = () => new DOMException("The client's deadline passed before the server answered.", "AbortError");

export function appTransport(
  handler: (request: Request) => Promise<Response>,
  basePath: string,
  origin: string,
): AppTransport {
  const requests: string[] = [];
  const errors: unknown[] = [];
  const running = new Set<Promise<unknown>>();
  let faults: AppRule[] = [];

  const takeFault = (call: string): AppFault | undefined => {
    const index = faults.findIndex((rule) => rule.call === call);
    if (index === -1) return undefined;
    const [rule] = faults.splice(index, 1);
    return rule?.fault;
  };

  /** What the client gets for an answer the server is still working out, after `fault`. */
  async function deliver(label: string, answer: Promise<Response>, fault: AppFault | undefined): Promise<Response> {
    if (fault?.kind === "late") {
      const finished = answer.then((response) => requests.push(`${label} ${response.status} late`));
      running.add(finished);
      void finished.finally(() => running.delete(finished));
      await fault.until;
      throw deadlinePassed();
    }
    const response = await answer;
    if (fault?.kind === "reset") {
      requests.push(`${label} ${response.status} reset`);
      throw lostAnswer();
    }
    if (fault?.kind === "gateway") {
      requests.push(`${label} ${response.status} then ${fault.status}`);
      return new Response("<h1>Service Unavailable</h1>", { status: fault.status });
    }
    requests.push(`${label} ${response.status}`);
    // A clone, so the client still reads the body; the handler answers every error with cloudrop's JSON body.
    if (!response.ok) errors.push(await response.clone().json());
    return response;
  }

  const fetchUntil =
    (ended: AbortSignal): ClientFetch =>
    async (url, init) => {
      ended.throwIfAborted();
      if (!url.startsWith(basePath)) return globalThis.fetch(url, init);
      init.signal?.throwIfAborted();
      const path = url.slice(basePath.length);
      const headers = { ...Object.fromEntries(new Headers(init.headers)), origin };
      const answer = handler(new Request(url, { method: init.method, body: init.body, headers }));
      return deliver(`${init.method ?? "GET"} ${path}`, answer, takeFault(path.slice(1)));
    };

  return {
    fetchUntil,
    requests: () => [...requests],
    errors: () => [...errors],
    setFaults(rules) {
      faults = [...rules];
    },
    async settled() {
      await Promise.allSettled([...running]);
    },
    clear() {
      faults = [];
      requests.length = 0;
      errors.length = 0;
    },
  };
}
