// The run's request log: what the lab keeps of each request the client sends, and never its URL, headers or body.
import { displayHost } from "./host";

/** What the log keeps of one request: never its URL, headers or body, which hold a signature or a token. */
export interface RequestRecord {
  /** "/upload", "/sign", "/complete", "/abort", "PUT single" or "PUT part n". */
  kind: string;
  isBucketPut: boolean;
  /** The bucket's host for a PUT, the page's own host for an endpoint call. */
  host: string;
  /** The upload the request belongs to, as a number the run gives it: one file's requests apart from another's. */
  subject: string;
  /** For a /sign, the URL it asks for: "the PUT" or "part n"; null for every other request. */
  signedFor: string | null;
  /**
   * An HTTP status; "cancelled" when the client stopped the request because the person paused or cancelled, or the page
   * went offline; "stalled" when it gave up on its own, after 30 s without progress (M3-U27, M3-U47); null in flight.
   */
  status: number | "network error" | "cancelled" | "stalled" | null;
  startMs: number;
  endMs: number | null;
  /** The size of the request body; 0 when the lab answered in the bucket's place, which sends nothing. */
  bytes: number;
  /** The faults the lab injected into this request, in words. */
  injected: string[];
}

export interface Journal {
  /** Appends a record for a request about to be sent. The URL and body are read here and kept nowhere. */
  start(url: string, method: string, body: unknown): RequestRecord;
  end(record: RequestRecord, status: NonNullable<RequestRecord["status"]>): void;
  /** Adds what the lab did to a request still in flight, and shows it at once. */
  note(record: RequestRecord, words: string): void;
}

function sizeOf(body: unknown): number {
  if (body instanceof Blob) return body.size;
  return typeof body === "string" ? new TextEncoder().encode(body).length : 0;
}

type Target = Pick<RequestRecord, "kind" | "isBucketPut" | "host" | "signedFor"> & {
  /** What tells this request's upload from another's: a PUT's URL path or an endpoint's token. Held only as a key in
   * memory for the run's numbering; never shown, logged or stored. */
  secret: string;
};

/** The URL and body are read here and nowhere else: only the endpoint's name, the part number and the host leave. */
function readTarget(url: string, method: string, body: unknown): Target {
  const parsed = new URL(url, window.location.href);
  if (method === "PUT") {
    const part = parsed.searchParams.get("partNumber");
    const kind = part ? `PUT part ${part}` : "PUT single";
    return { kind, isBucketPut: true, host: displayHost(parsed.host), signedFor: null, secret: parsed.pathname };
  }
  // /sign, /complete and /abort send { token }; a /sign adds the parts it asks for, and /upload has no token.
  const { token = "", parts } = (typeof body === "string" ? JSON.parse(body) : {}) as {
    token?: string;
    parts?: number[];
  };
  const kind = `/${parsed.pathname.split("/").at(-1)}`;
  const signedFor = kind === "/sign" ? (parts ? `part ${parts.join(", ")}` : "the PUT") : null;
  return { kind, isBucketPut: false, host: parsed.host, signedFor, secret: token };
}

/** A log that calls `changed` whenever a record starts or ends. */
export function createJournal(log: RequestRecord[], changed: () => void): Journal {
  // Each upload gets a number on first sight, so the notes tell one file's requests from another's; the numbers die
  // with the run.
  const numbers = new Map<string, string>();
  function numberOf(secret: string): string {
    const known = numbers.get(secret);
    if (known) return known;
    const next = String(numbers.size + 1);
    numbers.set(secret, next);
    return next;
  }
  return {
    start(url, method, body) {
      const { secret, ...target } = readTarget(url, method, body);
      const record: RequestRecord = {
        ...target,
        subject: numberOf(secret),
        status: null,
        startMs: performance.now(),
        endMs: null,
        bytes: sizeOf(body),
        injected: [],
      };
      log.push(record);
      changed();
      return record;
    },
    end(record, status) {
      record.status = status;
      record.endMs = performance.now();
      changed();
    },
    note(record, words) {
      record.injected.push(words);
      changed();
    },
  };
}
