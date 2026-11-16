// One file from start to finish: /upload, the bytes as one PUT or as parts, /complete with up to two repair rounds,
// and an ending without success (a cancel or a failure) that tells the server unless a /complete may have finished
// the file (decisions S13 to S15, ruling S-18).

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import { sizeOfPart } from "../plan.ts";
import type { CompleteResponse, SignedPart, SignedRequest } from "../protocol/types.ts";
import { putObject } from "./bucket.ts";
import type { ClientFetch, Endpoints, Ticket } from "./endpoints.ts";
import { aborted } from "./failures.ts";
import { type PartSender, sendParts } from "./parts.ts";
import { withRetry } from "./retry.ts";

/** /complete may answer PARTS_MISSING this many times before the file fails (S13). */
const REPAIR_ROUNDS = 2;

export interface UploadContext {
  endpoints: Endpoints;
  fetch: ClientFetch;
}

interface Arguments {
  route: string;
  file: File;
  metadata: unknown;
  signal: AbortSignal;
}

function encodesAsJson(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

/** What plain JavaScript can get wrong, refused before any request (S17, ruling S-2). */
function readArguments(route: unknown, file: unknown, options: unknown): Result<Arguments> {
  const refuse = (message: string) => fail(invalidInput(message));
  if (typeof route !== "string" || route === "") {
    return refuse('Name the upload route as text, such as upload("avatar", file).');
  }
  if (!(file instanceof File)) return refuse('Pass the file as a File, such as one from <input type="file">.');
  if (options !== undefined && !isPlainObject(options)) {
    return refuse("Pass the upload options as an object, such as { metadata, signal }.");
  }
  // A signal per call, not one module-level object: the package declares sideEffects: false.
  const { metadata, signal = new AbortController().signal } = options ?? {};
  if (!(signal instanceof AbortSignal)) {
    return refuse("options.signal must be an AbortSignal, such as new AbortController().signal.");
  }
  // Retrying cannot fix a BigInt or a cycle, so it is the caller's mistake, not a network failure.
  if (!encodesAsJson(metadata)) {
    return refuse(
      "options.metadata must be JSON data, such as objects, strings and numbers: it holds a value JSON cannot encode, such as a BigInt or a circular reference.",
    );
  }
  return ok({ route, file, metadata, signal });
}

function bodyOf(ticket: Ticket, file: File, partNumber: number): Blob {
  if (ticket.kind === "single") return file;
  const start = (partNumber - 1) * ticket.partSize;
  return file.slice(start, start + sizeOfPart(file.size, ticket.partSize, partNumber));
}

function senderFor(context: UploadContext, ticket: Ticket, file: File, signal: AbortSignal): PartSender {
  const put = (target: SignedRequest, partNumber: number) =>
    putObject(context.fetch, target, bodyOf(ticket, file, partNumber), signal);
  if (ticket.kind === "multipart") {
    return {
      signal,
      first: ticket.parts,
      put,
      sign: (parts) => context.endpoints.signParts(ticket.token, parts, signal),
    };
  }
  // A single PUT is part 1 of 1, so one routine sends both kinds.
  const sign = async (): Promise<Result<SignedPart[]>> => {
    const renewed = await context.endpoints.signSingle(ticket.token, signal);
    return renewed.error ? renewed : ok([{ partNumber: 1, ...renewed.data }]);
  };
  return { signal, first: [{ partNumber: 1, ...ticket.put }], put, sign };
}

interface Sent {
  result: Result<CompleteResponse<unknown>>;
  /** Some /complete got no answer or a SERVER_ERROR, so the server may have completed the file: a cancel keeps it. */
  mayBeComplete: boolean;
}

async function sendAndComplete(context: UploadContext, ticket: Ticket, file: File, signal: AbortSignal): Promise<Sent> {
  const sender = senderFor(context, ticket, file, signal);
  let parts = Array.from({ length: ticket.kind === "single" ? 1 : ticket.partCount }, (_, index) => index + 1);
  let mayBeComplete = false;
  // Without the signal: the server may finish a /complete (and run onComplete) after the browser stopped waiting (S14).
  const complete = async (): Promise<Result<CompleteResponse<unknown>>> => {
    const done = await context.endpoints.complete(ticket.token);
    const code = done.error?.code;
    // PARTS_MISSING clears the doubt wherever it arrives: the server sends it only while the multipart upload is still
    // open, so no earlier /complete finished the file and /abort deletes nothing recorded (ruling S-9).
    if (code === "PARTS_MISSING") mayBeComplete = false;
    // Otherwise sticky: a later answer does not undo an earlier /complete that may have finished (S14, M3-H16).
    else mayBeComplete ||= code === "NETWORK_ERROR" || code === "SERVER_ERROR";
    return done;
  };
  for (let round = 0; ; round++) {
    const sent = await sendParts(sender, parts);
    if (sent.error) return { result: fail(sent.error), mayBeComplete };
    const done = await withRetry(complete, signal);
    const missing = done.error?.code === "PARTS_MISSING" ? done.error.parts : undefined;
    if (!missing?.length || round === REPAIR_ROUNDS) return { result: done, mayBeComplete };
    parts = [...missing];
  }
}

export async function uploadFile(
  context: UploadContext,
  route: unknown,
  file: unknown,
  options: unknown,
): Promise<Result<CompleteResponse<unknown>>> {
  const args = readArguments(route, file, options);
  if (args.error) return args;
  const { signal } = args.data;
  if (signal.aborted) return fail(aborted());
  const started = await withRetry(
    () => context.endpoints.start(args.data.route, args.data.file, args.data.metadata, signal),
    signal,
  );
  if (started.error) return fail(signal.aborted ? aborted() : started.error);
  const { result, mayBeComplete } = await sendAndComplete(context, started.data, args.data.file, signal);
  // A completed upload stays completed: /abort with a live token would delete it (ruling M2-X1).
  if (!result.error) return result;
  const ending = signal.aborted ? fail(aborted()) : result;
  // A /complete that may have succeeded: keep the file rather than delete a recorded one (M3-H15, M3-H16).
  if (mayBeComplete) return ending;
  // Otherwise /abort frees the parts and deletes this upload's own object, which no lifecycle rule removes (S-18).
  const cleanup = context.endpoints.abort(started.data.token);
  // A failure is answered at once and its /abort finishes in the background: abort() never rejects, so nothing is
  // left unhandled. A cancel waits for it, so the caller knows the server was told.
  if (signal.aborted) await cleanup;
  return ending;
}
