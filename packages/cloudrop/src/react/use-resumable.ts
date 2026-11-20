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

/** `ids` with `id` added or, with `remove`, taken out: a new set, as React state needs. */
function changed(ids: ReadonlySet<string>, id: string, remove = false): ReadonlySet<string> {
  const next = new Set(ids);
  if (remove) next.delete(id);
  else next.add(id);
  return next;
}

export function useResumableWith(source: HookSource, route?: string): UseResumableResult<string> {
  const [uploads, setUploads] = useState(NO_UPLOADS);
  const [discarding, setDiscarding] = useState(NO_IDS);
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
      setDiscarding((ids) => changed(ids, id));
      try {
        return await changeThenRead((client) => client.discard(upload));
      } finally {
        // In the same render as the list read again (M8-L8).
        setDiscarding((ids) => changed(ids, id, true));
      }
    },
    [changeThenRead],
  );
  const forget = useCallback(() => changeThenRead((client) => client.forget()), [changeThenRead]);
  return { uploads, discarding, refresh, discard, forget };
}
