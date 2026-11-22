// A fake XMLHttpRequest for the client's unit tests: the presigned PUT of client/transport.ts, sent through the client
// fixture's fetch, with upload progress fired on demand. It fakes only what transport.ts uses and is never shipped.

import type { ClientFetch } from "../client/endpoints.ts";

export interface XhrCall {
  /** As clientFixture labels requests: "PUT object", "PUT part 2". */
  readonly label: string;
  /** The body's bytes. */
  readonly size: number;
  /** Fires upload.onprogress. */
  progress(loaded: number): void;
  /** Sends through the fixture's fetch; fires onload, or onerror when it throws. */
  finish(): Promise<void>;
  /** Fires onerror, as a browser does for a network or CORS failure. */
  fail(): void;
}

export interface FakeXhr {
  /** For vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest). */
  XMLHttpRequest: new () => unknown;
  /** Requests sent and not yet finished, failed or aborted, oldest first. Only `hold: true` leaves any here. */
  open: XhrCall[];
  /** The label of every request ever sent, aborted ones included, in order. */
  sent: readonly string[];
  /**
   * Resolves with the next call when it is sent (or at once with one already sent and not yet taken). Lets a test
   * wait for a request without moving fake timers (`vi.waitFor` advances them).
   */
  next(): Promise<XhrCall>;
}

type Handler = (() => void) | null;

/** The fixture's label for a bucket request (labelOf in client-fixture.ts). */
function labelOf(method: string, url: string): string {
  const partNumber = new URL(url).searchParams.get("partNumber");
  return partNumber === null ? `${method} object` : `${method} part ${partNumber}`;
}

interface FakeXhrOptions {
  /** Leaves each request open until the test ends it through `open` or `next()`. */
  hold?: boolean;
  /** Called with each request once it is sent, to end it in its place (with `hold` set, never called). */
  end?: (call: XhrCall) => void;
}

/** Without `hold` or `end`, each request reports half its body, then all of it, then finishes by itself. */
export function fakeXhr(fetch: ClientFetch, options: FakeXhrOptions = {}): FakeXhr {
  const open: XhrCall[] = [];
  const sent: string[] = [];
  const untaken: XhrCall[] = [];
  const waiting: ((call: XhrCall) => void)[] = [];

  class FakeXMLHttpRequest {
    upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = {
      onprogress: null,
    };
    onload: Handler = null;
    onerror: Handler = null;
    onabort: Handler = null;
    ontimeout: Handler = null;
    status = 0;
    responseText = "";
    #method = "";
    #url = "";
    #headers: Record<string, string> = {};
    #answer: Headers | undefined;
    /** The call while it is open. */
    #call: XhrCall | undefined;

    open(method: string, url: string): void {
      this.#method = method;
      this.#url = url;
    }

    setRequestHeader(name: string, value: string): void {
      this.#headers[name] = value;
    }

    getResponseHeader(name: string): string | null {
      return this.#answer?.get(name) ?? null;
    }

    /** Leaves `open` and ignores everything after; false when the call had already ended. */
    #end(): boolean {
      const call = this.#call;
      if (call === undefined) return false;
      this.#call = undefined;
      open.splice(open.indexOf(call), 1);
      return true;
    }

    send(body: Blob): void {
      const call: XhrCall = {
        label: labelOf(this.#method, this.#url),
        size: body.size,
        progress: (loaded) => {
          if (this.#call === call) this.upload.onprogress?.({ loaded, total: body.size, lengthComputable: true });
        },
        finish: async () => {
          if (this.#call !== call) return;
          const init = { method: this.#method, headers: this.#headers, body };
          const answer = await fetch(this.#url, init).catch(() => undefined);
          const text = (await answer?.text()) ?? "";
          // An abort while the answer was on its way wins, as in a browser.
          if (!this.#end()) return;
          if (answer === undefined) return this.onerror?.();
          this.status = answer.status;
          this.responseText = text;
          this.#answer = answer.headers;
          this.onload?.();
        },
        fail: () => {
          if (this.#end()) this.onerror?.();
        },
      };
      this.#call = call;
      open.push(call);
      sent.push(call.label);
      const waiter = waiting.shift();
      if (waiter) waiter(call);
      else untaken.push(call);
      if (options.hold) return;
      const { end } = options;
      if (end) {
        queueMicrotask(() => end(call));
        return;
      }
      queueMicrotask(() => {
        call.progress(Math.floor(body.size / 2));
        call.progress(body.size);
        void call.finish();
      });
    }

    abort(): void {
      if (this.#end()) this.onabort?.();
    }
  }

  return {
    XMLHttpRequest: FakeXMLHttpRequest,
    open,
    sent,
    next: () => {
      const call = untaken.shift();
      return call ? Promise.resolve(call) : new Promise((resolve) => waiting.push(resolve));
    },
  };
}
