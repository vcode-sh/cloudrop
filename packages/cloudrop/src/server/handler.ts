// cloudrop.handler: Request in, Response out, never a throw. Routing, method, origin, content type and body cap are
// checked here once, before any endpoint runs.

import { fromEnv } from "../env.ts";
import { CloudropError, type Result } from "../errors.ts";
import type { Endpoint } from "../protocol/types.ts";
import { handleAbort } from "./abort.ts";
import { checkBucket } from "./bucket-check.ts";
import { handleComplete } from "./complete.ts";
import type { EndpointInput, ServerConfig } from "./config.ts";
import {
  checkOrigin,
  errorResponse,
  isJsonRequest,
  jsonResponse,
  originNotAllowed,
  preflight,
  readJson,
  serverError,
} from "./http.ts";
import { originHint } from "./origin-hint.ts";
import type { Logger } from "./plugins.ts";
import { handleSign } from "./sign.ts";
import { handleUpload } from "./upload.ts";

type EndpointHandler = (input: EndpointInput) => Promise<Result<unknown>>;

const ENDPOINTS = {
  upload: handleUpload,
  sign: handleSign,
  complete: handleComplete,
  abort: handleAbort,
} satisfies Record<Endpoint, EndpointHandler>;

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
      // Promise.resolve adopts any thenable, so a rejection it forwards is handled too.
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
        Promise.resolve(result).catch(() => {});
      }
    } catch {
      // There is nowhere left to report a failing logger.
    }
  };
  return {
    error: (message, error) => call(() => logger.error(message, error)),
    warn: (message) => call(() => logger.warn(message)),
  };
}

async function answer(request: Request, config: ServerConfig, hint: (request: Request) => void): Promise<Response> {
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
  if (!origin.allowed) {
    hint(request);
    return errorResponse(originNotAllowed());
  }
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

/** In development only, once per handler: report bucket settings that would break browser uploads (spec §4). */
async function warnAboutBucket(config: ServerConfig, pageOrigin: string): Promise<void> {
  const report = await checkBucket(config, [...new Set([pageOrigin, ...config.trustedOrigins])]);
  if (report.error) {
    config.logger.warn(`cloudrop: could not check the bucket settings: ${report.error.message}`);
    return;
  }
  for (const check of Object.values(report.data)) {
    if (check.status === "problem") config.logger.warn(`cloudrop: ${check.message}`);
  }
}

export function createHandler(given: ServerConfig): (request: Request) => Promise<Response> {
  const config = { ...given, logger: contained(given.logger) };
  const hint = originHint(config.logger);
  let bucketChecked = false;
  return async (request) => {
    try {
      if (!bucketChecked && fromEnv("NODE_ENV") === "development") {
        // A same-origin page uploads from the server's own origin, which needs the bucket's CORS rule too. The URL's
        // origin, unlike the Origin header, is always an exact origin, and a cross-origin page must be trusted anyway.
        const pageOrigin = new URL(request.url).origin;
        bucketChecked = true;
        warnAboutBucket(config, pageOrigin).catch((error: unknown) => {
          config.logger.error("cloudrop: the development bucket check failed.", error);
        });
      }
      return await answer(request, config, hint);
    } catch (error) {
      // The endpoints catch their own failures: what lands here is an input that is not a Request.
      config.logger.error("cloudrop: the handler failed before any endpoint ran. Pass it a Fetch API Request.", error);
      return errorResponse(serverError());
    }
  };
}
