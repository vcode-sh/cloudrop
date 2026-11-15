// cloudrop.handler: Request in, Response out, never a throw. Routing, method, origin, content type and body cap are
// checked here once, before any endpoint runs.

import { CloudropError, type Result } from "../errors.ts";
import type { Endpoint } from "../protocol/types.ts";
import { handleAbort } from "./abort.ts";
import type { EndpointInput, ServerConfig } from "./config.ts";
import {
  checkOrigin,
  errorResponse,
  isJsonRequest,
  jsonResponse,
  originNotAllowed,
  preflight,
  readJson,
} from "./http.ts";
import type { Logger } from "./plugins.ts";
import { handleSign } from "./sign.ts";
import { handleUpload } from "./upload.ts";

type EndpointHandler = (input: EndpointInput) => Promise<Result<unknown>>;

const ENDPOINTS = {
  upload: handleUpload,
  sign: handleSign,
  abort: handleAbort,
} satisfies Partial<Record<Endpoint, EndpointHandler>>;

const serverError = (): CloudropError =>
  new CloudropError("SERVER_ERROR", "The server could not handle the upload. Try again later.");

function endpointOf(request: Request, basePath: string): keyof typeof ENDPOINTS | null {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${basePath}/`)) return null;
  const name = pathname.slice(basePath.length + 1);
  // hasOwn, not `in`: "constructor" and "toString" are not endpoints.
  return Object.hasOwn(ENDPOINTS, name) ? (name as keyof typeof ENDPOINTS) : null;
}

/**
 * The application's logger, unable to break an answer: a logger that throws, or returns a rejected promise, while
 * reporting a failure must not turn the handler's Response into a rejection or an unhandled rejection.
 */
function contained(logger: Logger): Logger {
  const call = (log: () => unknown) => {
    try {
      const result = log();
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // There is nowhere left to report a failing logger.
    }
  };
  return {
    error: (message, error) => call(() => logger.error(message, error)),
    warn: (message) => call(() => logger.warn(message)),
  };
}

async function answer(request: Request, config: ServerConfig): Promise<Response> {
  const endpoint = endpointOf(request, config.basePath);
  if (endpoint === null) {
    return errorResponse(new CloudropError("NOT_FOUND", "There is no cloudrop endpoint at this path. Check basePath."));
  }
  if (request.method === "OPTIONS") return preflight(request, config.trustedOrigins);
  if (request.method !== "POST") {
    return errorResponse(new CloudropError("METHOD_NOT_ALLOWED", "Send this request as POST."), {
      allow: "POST, OPTIONS",
    });
  }
  const origin = checkOrigin(request, config.trustedOrigins);
  if (!origin.allowed) return errorResponse(originNotAllowed());
  if (!isJsonRequest(request)) {
    return errorResponse(
      new CloudropError("UNSUPPORTED_MEDIA_TYPE", "Send the request body as JSON with Content-Type: application/json."),
      origin.cors,
    );
  }
  const body = await readJson(request);
  if (body.error) return errorResponse(body.error, origin.cors);
  try {
    const result = await ENDPOINTS[endpoint]({ request, body: body.data, config });
    return result.error ? errorResponse(result.error, origin.cors) : jsonResponse(result.data, 200, origin.cors);
  } catch (error) {
    // A throw here is a bug in the application's callbacks, a plugin, or cloudrop: the details go to the log only.
    config.logger.error(`cloudrop: /${endpoint} failed on the server.`, error);
    return errorResponse(serverError(), origin.cors);
  }
}

export function createHandler(given: ServerConfig): (request: Request) => Promise<Response> {
  const config = { ...given, logger: contained(given.logger) };
  return async (request) => {
    try {
      return await answer(request, config);
    } catch (error) {
      // The endpoints catch their own failures: what lands here is an input that is not a Request.
      config.logger.error("cloudrop: the handler failed before any endpoint ran. Pass it a Fetch API Request.", error);
      return errorResponse(serverError());
    }
  };
}
