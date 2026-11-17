// useResumable (spec §6.1, M4-B3, M4-B12): the client's resumable() list without the uploads this page holds through
// the hooks, read after mount, when a job starts and whenever one of its files ends or starts again. Only reads happen
// in the effect; StrictMode's second effect reads once more and changes nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Result, ResumableUpload } from "../client.ts";
import type { UseResumableResult } from "./types.ts";
import type { HookSource } from "./use-upload.ts";

/** One constant, so the server render and the first browser render agree. */
const NO_UPLOADS: readonly ResumableUpload[] = [];

export function useResumableWith(source: HookSource, route?: string): UseResumableResult<string> {
  const [uploads, setUploads] = useState(NO_UPLOADS);
  const reads = useRef(0);
  const refresh = useCallback(async (): Promise<Result<ResumableUpload[]>> => {
    const read = ++reads.current;
    const client = source.client();
    const answer = client.error ? client : await client.data.resumable(route);
    // Filtered when the read answers, against what the page holds then.
    const listed = answer.error ? answer : { data: answer.data.filter((upload) => !source.holds(upload)), error: null };
    // A read that answers after a newer one started must not replace the newer list.
    if (read === reads.current) setUploads(listed.data ?? NO_UPLOADS);
    return listed;
  }, [source, route]);
  useEffect(() => {
    void refresh();
    return source.onChange(() => void refresh());
  }, [source, refresh]);
  return { uploads, refresh };
}
