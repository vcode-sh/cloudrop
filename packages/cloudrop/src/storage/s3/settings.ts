import { configError } from "../../errors.ts";
import type { S3DriverConfig } from "../s3-driver.ts";

/**
 * The endpoint and the publicUrl: keys are appended to the path, so a query or fragment would swallow them (and be
 * signed into every request). A path is a prefix: a CDN folder, or Wrangler's /cdn-cgi/local/r2/s3.
 */
export function checkBaseUrl(value: string, setting: string, example: string): URL {
  const url = typeof value === "string" && URL.canParse(value) ? new URL(value) : null;
  if (url?.username || url?.password) {
    throw configError(
      `The ${setting} contains a user name or password. Remove it; cloudrop takes credentials only as accessKeyId and secretAccessKey.`,
    );
  }
  if (!url || !/^https?:$/.test(url.protocol) || url.href !== `${url.origin}${url.pathname}`) {
    throw configError(`The ${setting} must be an http or https URL with no query or fragment, such as ${example}.`);
  }
  // Check the path the way the signer reads it: the URL parser keeps a bad escape as written, and signing it would
  // later throw URIError from a public call.
  try {
    for (const segment of url.pathname.split("/")) decodeURIComponent(segment);
  } catch {
    throw configError(
      `The ${setting}'s path contains a malformed percent escape, or one that is not valid UTF-8 (such as %zz or %FF). Write a literal percent sign as %25.`,
    );
  }
  return url;
}

// Checked once, at construction: a header value with a line break makes fetch throw, and Node quotes the whole
// Authorization header (access key ID and signature) in that error.
const SIGNABLE = /^[\x21-\x7e]+$/;

export function checkSigningSettings({ credentials, region }: S3DriverConfig): void {
  for (const [setting, value] of Object.entries(credentials)) {
    if (typeof value !== "string" || !SIGNABLE.test(value)) {
      throw configError(
        `The ${setting} setting must be printable ASCII text with no whitespace or line break; secret files often end in a newline. Copy the value again without it.`,
      );
    }
  }
  // The region is one segment of the signing scope "<date>/<region>/s3/aws4_request".
  if (typeof region !== "string" || !SIGNABLE.test(region) || region.includes("/")) {
    throw configError(
      "The region setting must be printable ASCII text with no whitespace, line break or slash, such as us-east-1 or auto.",
    );
  }
}
