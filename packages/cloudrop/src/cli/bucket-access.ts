// Whether the bucket answers these credentials, proven by a listing (M9-C5), and when it does not, which settings to
// check. The storage's message speaks of requests; the command's reader set variables, so it names them (M9-H101).

import type { CloudropError } from "../errors.ts";
import type { S3Driver } from "../storage/s3-driver.ts";
import type { NameOf, Service } from "./names.ts";
import type { Finding } from "./report.ts";

// Refusals about the clock or the signature's age, not the credentials: the storage's own advice is the right one.
const NOT_CREDENTIALS = new Set(["RequestTimeTooSkewed", "ExpiredRequest"]);
// AWS's answers to a request signed for, or sent to, another region than the bucket's (its error-code list; unmeasured).
const OTHER_REGION = new Set(["AuthorizationHeaderMalformed", "PermanentRedirect"]);

function credentialsHint(service: Service, jurisdiction: string | undefined, name: NameOf): string {
  if (service === "S3") {
    return `Check ${name("CLOUDROP_S3_ACCESS_KEY_ID")} and ${name("CLOUDROP_S3_SECRET_ACCESS_KEY")}, that they may read and write objects in the bucket named by ${name("CLOUDROP_S3_BUCKET")}, and ${name("CLOUDROP_S3_REGION")}.`;
  }
  // R2 answers a bucket of another jurisdiction, or of none, as missing or refused.
  const where = jurisdiction
    ? ` in the ${jurisdiction} jurisdiction.`
    : ". A bucket in a jurisdiction also needs --jurisdiction.";
  return `Check ${name("CLOUDROP_R2_ACCESS_KEY_ID")} and ${name("CLOUDROP_R2_SECRET_ACCESS_KEY")}, that the token may read and write objects in the bucket named by ${name("CLOUDROP_R2_BUCKET")}, and that the bucket exists${where}`;
}

function endpointHint(service: Service, jurisdiction: string | undefined, name: NameOf): string {
  if (service === "S3") return `The endpoint is ${name("CLOUDROP_S3_ENDPOINT")}.`;
  // A wrong account ID names an R2 endpoint that does not exist, which reads as no network.
  const account = name("CLOUDROP_R2_ACCOUNT_ID");
  return jurisdiction
    ? `The R2 endpoint is built from ${account} and --jurisdiction ${jurisdiction}: check that it is your account ID and the bucket's jurisdiction.`
    : `The R2 endpoint is built from ${account}: check that it is your account ID.`;
}

/** The bucket a message is about: its service, the jurisdiction asked for, and the variable of each setting. */
export interface BucketSettings {
  service: Service;
  jurisdiction: string | undefined;
  name: NameOf;
}

const isRedirect = (status: number | undefined): boolean => status !== undefined && status >= 300 && status < 400;

/** An answer that is not a storage service's to a listing: a redirect, or a 404 that names no missing bucket. */
function strayAnswer(error: CloudropError, { service, jurisdiction, name }: BucketSettings): string | undefined {
  if (isRedirect(error.status)) {
    // The storage's sentence speaks of a region setting, which R2 has none of.
    return service === "S3"
      ? `${error.message.replace(/\.$/, "")}: ${name("CLOUDROP_S3_ENDPOINT")} and ${name("CLOUDROP_S3_REGION")}.`
      : `The endpoint redirected the request (HTTP ${error.status}), and a signed request is not sent on. ${endpointHint(service, jurisdiction, name)}`;
  }
  // A listing names no object, so the storage's "The object does not exist" would be untrue here.
  return error.code === "NOT_FOUND"
    ? `The endpoint answered the listing with HTTP 404, but not as a storage service does for a bucket that does not exist: something else may be answering there, such as a proxy or an endpoint with a wrong path. ${endpointHint(service, jurisdiction, name)}`
    : undefined;
}

/** What went wrong reaching the bucket, with the settings to check, in words true for the service (M11-R116). */
function bucketProblem(error: CloudropError, bucket: BucketSettings): string {
  const { service, jurisdiction, name } = bucket;
  if (error.code === "STORAGE_UNREACHABLE") return `${error.message} ${endpointHint(service, jurisdiction, name)}`;
  if (service === "S3" && OTHER_REGION.has(error.storageCode ?? "")) {
    return `The bucket is in another region (${error.storageCode}). Check ${name("CLOUDROP_S3_REGION")}, and that ${name("CLOUDROP_S3_ENDPOINT")} serves that region.`;
  }
  const stray = strayAnswer(error, bucket);
  if (stray) return stray;
  const refused = (error.status === 401 || error.status === 403) && !NOT_CREDENTIALS.has(error.storageCode ?? "");
  if (!refused) return error.message;
  return `The storage service refused these credentials (HTTP ${error.status}). ${credentialsHint(service, jurisdiction, name)}`;
}

/** Lists one key to prove the bucket answers: a listing's error tells a missing bucket from a missing key (M9-C5). */
export async function reachBucket(driver: S3Driver, bucket: BucketSettings): Promise<Finding> {
  const listed = await driver.list("cloudrop-doctor/", { limit: 1 });
  if (!listed.error) return { status: "ok", text: "The bucket answers, and these credentials may list it." };
  return { status: "problem", text: `Bucket: ${bucketProblem(listed.error, bucket)}` };
}
