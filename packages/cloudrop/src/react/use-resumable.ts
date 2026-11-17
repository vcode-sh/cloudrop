// useResumable (spec §6.1, M4-B3): the client's resumable() list, read after mount and after every job the hooks start
// settles. Only reads happen in the effect; StrictMode's second effect reads once more and changes nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ResumableUpload } from "../client.ts";
import type { UseResumableResult } from "./types.ts";
import type { HookSource } from "./use-upload.ts";

/** One constant, so the server render and the first browser render agree. */
const NO_UPLOADS: readonly ResumableUpload[] = [];

export function useResumableWith(source: HookSource, route?: string): UseResumableResult<string> {
  const [uploads, setUploads] = useState(NO_UPLOADS);
  const reads = useRef(0);
  const refresh = useCallback(async () => {
    const read = ++reads.current;
    const answer = await source.client().resumable(route);
    // A read that answers after a newer one started must not replace the newer list.
    if (read === reads.current) setUploads(answer.data ?? NO_UPLOADS);
    return answer;
  }, [source, route]);
  useEffect(() => {
    void refresh();
    return source.onSettled(() => void refresh());
  }, [source, refresh]);
  return { uploads, refresh };
}
