// The XML answers the fake R2 sends, in the shape of S3's documented responses.

import { escapeXml } from "../../storage/xml.ts";

const XML_HEADERS = { "content-type": "application/xml" };

export function xmlResponse(body: string, status = 200): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: XML_HEADERS });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return xmlResponse(`<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`, status);
}

export const noSuchUpload = (): Response =>
  errorResponse(404, "NoSuchUpload", "The specified multipart upload does not exist.");
export const clockSkewed = (): Response =>
  errorResponse(
    403,
    "RequestTimeTooSkewed",
    "The difference between the request time and the server time is too large.",
  );
export const preconditionFailed = (): Response =>
  errorResponse(412, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold.");
