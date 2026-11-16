// The XMLHttpRequest the lab installs for the length of a run: it records each bucket PUT the client sends and injects
// the bucket faults ticked on the page. cloudrop/client reads window.XMLHttpRequest on every PUT, so no library option
// is needed (spec §6).
import type { FaultSwitch, Journal } from "./lab-fetch";

/** Makes window.XMLHttpRequest record and fault bucket PUTs, until the returned function puts the browser's back. */
export function installLabXhr(journal: Journal, faults: FaultSwitch): () => void {
  // Defined here, not at the top of the module: the server renders this page too, and has no XMLHttpRequest.
  const RealXhr = window.XMLHttpRequest;

  class LabXhr extends RealXhr {
    #method = "";
    #url = "";
    /** The injected delay or network error still to come; null once the request is really sent. */
    #pending: ReturnType<typeof setTimeout> | null = null;

    override open(method: string, url: string | URL, async = true, username?: string | null, password?: string | null) {
      this.#method = method;
      this.#url = String(url);
      super.open(method, url, async, username, password);
    }

    override send(body?: Document | XMLHttpRequestBodyInit | null) {
      if (this.#method !== "PUT") return super.send(body);
      const record = journal.start(this.#url, "PUT", body);
      // The client's transport sets the on… properties; these listeners only watch.
      this.addEventListener("load", () => journal.end(record, this.status));
      this.addEventListener("error", () => journal.end(record, "network error"));
      this.addEventListener("abort", () => journal.end(record, "cancelled"));
      const delayMs = faults.delayMs();
      if (delayMs === 0) return this.#sendOrFail(record.injected, body);
      record.injected.push(`delayed ${delayMs} ms`);
      this.#pending = setTimeout(() => this.#sendOrFail(record.injected, body), delayMs);
    }

    #sendOrFail(injected: string[], body?: Document | XMLHttpRequestBodyInit | null) {
      this.#pending = null;
      if (!faults.take("bucketNetworkError")) return super.send(body);
      injected.push("injected network error");
      // A real network error arrives after send() returns, never inside it.
      this.#pending = setTimeout(() => {
        this.#pending = null;
        this.dispatchEvent(new ProgressEvent("error"));
      });
    }

    override abort() {
      if (this.#pending === null) return super.abort();
      // Nothing was sent, so a real abort() would fire nothing: fire the event it fires for a request in flight.
      clearTimeout(this.#pending);
      this.#pending = null;
      this.dispatchEvent(new ProgressEvent("abort"));
    }
  }

  window.XMLHttpRequest = LabXhr;
  return () => {
    window.XMLHttpRequest = RealXhr;
  };
}
