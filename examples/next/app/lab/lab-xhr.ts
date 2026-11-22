// The XMLHttpRequest the lab installs while a run or a retry goes: it records each bucket PUT the client sends and
// injects the bucket faults ticked on the page. cloudrop/client reads window.XMLHttpRequest on every PUT, so no library
// option is needed (spec §6).
import type { Journal, RequestRecord } from "./journal";
import { abortedAs, bucketFault, type FaultSwitch, REFUSAL } from "./lab-fetch";

/** Makes window.XMLHttpRequest record and fault bucket PUTs, until the returned function puts the browser's back. */
export function installLabXhr(journal: Journal, faults: FaultSwitch): () => void {
  // Defined here, not at the top of the module: the server renders this page too, and has no XMLHttpRequest.
  const RealXhr = window.XMLHttpRequest;

  class LabXhr extends RealXhr {
    #method = "";
    #url = "";
    /**
     * Cancels what the lab does in the request's place: the injected delay, network error or refusal still to come, or
     * the PUT whose answer it drops. Null while nothing is pending, as once the request is really sent.
     */
    #pending: (() => void) | null = null;
    /** True once the lab answered with its refusal in the bucket's place: the getters below then return it. */
    #refused = false;
    /** The headers the client set, for a PUT the lab sends itself to drop its answer. */
    #headers = new Headers();

    override get readyState() {
      return this.#refused ? RealXhr.DONE : super.readyState;
    }

    override get status() {
      return this.#refused ? REFUSAL.status : super.status;
    }

    override get responseText() {
      return this.#refused ? REFUSAL.body : super.responseText;
    }

    override getResponseHeader(name: string) {
      return this.#refused ? null : super.getResponseHeader(name);
    }

    override open(method: string, url: string | URL, async = true, username?: string | null, password?: string | null) {
      this.#method = method;
      this.#url = String(url);
      super.open(method, url, async, username, password);
    }

    override setRequestHeader(name: string, value: string) {
      this.#headers.append(name, value);
      super.setRequestHeader(name, value);
    }

    override send(body?: Document | XMLHttpRequestBodyInit | null) {
      if (this.#method !== "PUT") return super.send(body);
      const record = journal.start(this.#url, "PUT", body);
      // The client's transport sets the on… properties; these listeners only watch. An answer is logged on
      // readystatechange, which comes before load: the client's onload can start the next PUT before a load listener
      // runs, and with one connection the log would show two PUTs in flight. Status 0 is an error or an abort.
      this.addEventListener("readystatechange", () => {
        if (this.readyState === RealXhr.DONE && this.status !== 0) journal.end(record, this.status);
      });
      this.addEventListener("error", () => journal.end(record, "network error"));
      this.addEventListener("abort", () => journal.end(record, abortedAs(faults)));
      const delayMs = faults.delayMs();
      if (delayMs === 0) return this.#sendOrFail(record, body);
      record.injected.push(`delayed ${delayMs} ms`);
      this.#later(() => this.#sendOrFail(record, body), delayMs);
    }

    /** Runs `next` after `ms`, unless abort() comes first. */
    #later(next: () => void, ms?: number) {
      const timer = setTimeout(() => {
        this.#pending = null;
        next();
      }, ms);
      this.#pending = () => clearTimeout(timer);
    }

    #sendOrFail(record: RequestRecord, body?: Document | XMLHttpRequestBodyInit | null) {
      const fault = bucketFault(record, faults);
      if (fault === null) return super.send(body);
      if (fault === "answer dropped") return this.#sendUnheard(record, body);
      // A real answer or network error arrives after send() returns, never inside it.
      this.#later(() => {
        // A network error comes after part of the body left, as a lost connection does, so the client keeps its six
        // attempts; a block comes before any byte, as for a failed preflight, and ends in BUCKET_BLOCKED (M12-E7).
        if (fault === "network error") {
          const total = (body as Blob).size;
          this.upload.dispatchEvent(
            new ProgressEvent("progress", { lengthComputable: true, loaded: Math.ceil(total / 2), total }),
          );
        }
        if (fault === "network error" || fault === "blocked") return this.dispatchEvent(new ProgressEvent("error"));
        this.#refused = true;
        for (const type of ["readystatechange", "load", "loadend"]) this.dispatchEvent(new ProgressEvent(type));
      });
    }

    /**
     * Sends the PUT through fetch with the client's headers, then tells the client it got no answer, as a connection
     * lost after the bucket stored the bytes. This XMLHttpRequest itself sends nothing.
     */
    #sendUnheard(record: RequestRecord, body?: Document | XMLHttpRequestBodyInit | null) {
      const unheard = new AbortController();
      this.#pending = () => unheard.abort();
      // The client sends a Blob, which fetch takes as it is.
      const init = { method: "PUT", headers: this.#headers, body: body as BodyInit, signal: unheard.signal };
      fetch(this.#url, init)
        .then(async (response) => {
          await response.body?.cancel();
          record.injected.push(`answer dropped (the bucket sent ${response.status})`);
        })
        // A real network error ends as a dropped answer does.
        .catch(() => undefined)
        .finally(() => {
          if (unheard.signal.aborted) return;
          this.#pending = null;
          this.dispatchEvent(new ProgressEvent("error"));
        });
    }

    override abort() {
      if (this.#pending === null) return super.abort();
      // This XMLHttpRequest sent nothing, so a real abort() would fire nothing: fire the event it fires for a request
      // in flight.
      this.#pending();
      this.#pending = null;
      this.dispatchEvent(new ProgressEvent("abort"));
    }
  }

  window.XMLHttpRequest = LabXhr;
  return () => {
    window.XMLHttpRequest = RealXhr;
  };
}
