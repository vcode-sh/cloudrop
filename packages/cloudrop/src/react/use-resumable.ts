// useResumable (spec §6.1, M4-B3, M4-B12): the client's resumable() list, which leaves out the uploads this page holds
// (M4-F22), read after mount and whenever a job of the hooks may have changed it (job-tracker.ts). Only reads happen in
// the effect; StrictMode's second effect reads once more and changes nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudropClient, Result, ResumableUpload } from "../client.ts";
import type { UseResumableResult } from "./types.ts";
import type { HookSource } from "./use-upload.ts";

/** Constants, so the server render and the first browser render agree. */
const NO_UPLOADS: readonly ResumableUpload[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

export function useResumableWith(source: HookSource, route?: string): UseResumableResult<string> {
  const [uploads, setUploads] = useState(NO_UPLOADS);
  const [discarding, setDiscarding] = useState(NO_IDS);
  // Calls in flight per id: a second press, refused UPLOAD_IN_USE at once, must not end the first one's hold.
  const inFlight = useRef(new Map<string, number>());
  const reads = useRef(0);
  const refresh = useCallback(async (): Promise<Result<ResumableUpload[]>> => {
    const read = ++reads.current;
    const client = source.client();
    const answer = client.error ? client : await client.data.resumable(route);
    // A read that answers after a newer one started must not replace the newer list.
    if (read === reads.current) setUploads(answer.data ?? NO_UPLOADS);
    return answer;
  }, [source, route]);
  useEffect(() => {
    void refresh();
    return source.onChange(() => void refresh());
  }, [source, refresh]);
  /**
   * Runs `change` on the client, then reads the list again, whatever it answered: a failed discard keeps its record.
   * Every other useResumable of the factory reads again too, since one route's discard shows in a list of every route.
   */
  const changeThenRead = useCallback(
    async <T>(change: (client: CloudropClient) => Promise<Result<T>>): Promise<Result<T>> => {
      const client = source.client();
      const answer = client.error ? client : await change(client.data);
      source.changed();
      await refresh();
      return answer;
    },
    [source, refresh],
  );
  const discard = useCallback(
    async (upload: ResumableUpload) => {
      // The client refuses a wrong argument at once, so its id is held only until then.
      const id = String(upload?.id);
      const count = (step: number) => {
        const calls = (inFlight.current.get(id) ?? 0) + step;
        if (calls > 0) inFlight.current.set(id, calls);
        else inFlight.current.delete(id);
        setDiscarding(new Set(inFlight.current.keys()));
      };
      count(1);
      try {
        return await changeThenRead((client) => client.discard(upload));
      } finally {
        count(-1);
      }
    },
    [changeThenRead],
  );
  const forget = useCallback(() => changeThenRead((client) => client.forget()), [changeThenRead]);
  return { uploads, discarding, refresh, discard, forget };
}
