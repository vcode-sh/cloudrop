import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { orpc } from "@/lib/orpc";

/** Reads `files.*` again each time another upload finishes, so the table and the avatar show it. */
export function useRefreshFilesWhenDone(done: number): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (done > 0) void queryClient.invalidateQueries({ queryKey: orpc.files.key() });
  }, [done, queryClient]);
}
