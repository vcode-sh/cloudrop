// How the handler talks to a store (M5 spec §4): a store throws on a database failure, and the handler never throws,
// so every call is wrapped here into a Result whose error is retryable and whose cause goes only to the logger.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import type { Logger } from "./plugins.ts";
import type { ClaimOutcome, CloudropStore, Completion, FileRecord, Transition } from "./store.ts";
import type { UploadTokenPayload } from "./token.ts";

export const storeUnavailable = (): CloudropError =>
  new CloudropError("SERVER_ERROR", "The server could not reach its upload records. Try again in a moment.", {
    retryable: true,
  });

/** The row was ended (a cancel, a sign-out, the sweep) or is not there: the client needs a new ticket. */
export const cancelled = (): CloudropError =>
  new CloudropError("UPLOAD_EXPIRED", "This upload was cancelled or has expired. Start it again.");

/** `what` completes "the store failed to …", such as `claim file <id> on route "avatar"`. */
export async function storeCall<T>(logger: Logger, what: string, call: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await call());
  } catch (error) {
    logger.error(`cloudrop: the store failed to ${what}.`, error);
    return fail(storeUnavailable());
  }
}

export interface FileCalls {
  get(): Promise<Result<FileRecord | null>>;
  claim(claim: string, leaseMs: number): Promise<Result<ClaimOutcome>>;
  release(claim: string): Promise<Result<boolean>>;
  complete(claim: string, result: string | null, replace: boolean): Promise<Result<Completion>>;
  end(from: "pending" | "completing", to: "aborted" | "rejected"): Promise<Result<Transition>>;
}

/** The store calls of one token's file, each logged with the file and its route. */
export function fileCalls(store: CloudropStore<unknown>, logger: Logger, token: UploadTokenPayload): FileCalls {
  const call = <T>(method: string, run: () => Promise<T>) =>
    storeCall(logger, `${method} file ${token.id} on route "${token.route}"`, run);
  const { id } = token;
  return {
    get: () => call("get", () => store.get(id)),
    claim: (claim: string, leaseMs: number) => call("claim", () => store.claim(id, claim, new Date(), leaseMs)),
    release: (claim: string) => call("release", () => store.release(id, claim, new Date())),
    complete: (claim: string, result: string | null, replace: boolean) =>
      call("complete", () => store.complete(id, claim, result, new Date(), { replace })),
    end: (from, to) => call("end", () => store.end(id, from, to, new Date())),
  };
}
