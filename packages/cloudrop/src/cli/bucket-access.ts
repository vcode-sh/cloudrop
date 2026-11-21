// Whether the bucket answers these credentials, proven by a listing (M9-C5), and when it does not, which settings to
// check. The storage's message speaks of requests; the command's reader set variables, so it names them (M9-H101).

import type { CloudropError } from "../errors.ts";
import type { S3Driver } from "../storage/s3-driver.ts";
import type { Finding } from "./report.ts";
import type { Service } from "./settings.ts";

// Refusals about the clock or the signature's age, not the credentials: the storage's own advice is the right one.
const NOT_CREDENTIALS = new Set(["RequestTimeTooSkewed", "ExpiredRequest"]);
// AWS's answers to a request signed for, or sent to, another region than the bucket's (its error-code list; unmeasured).
const OTHER_REGION = new Set(["AuthorizationHeaderMalformed", "PermanentRedirect"]);

function credentialsHint(service: Service, jurisdiction: string | undefined): string {
  if (service === "S3") {
    return "Check CLOUDROP_S3_ACCESS_KEY_ID and CLOUDROP_S3_SECRET_ACCESS_KEY, that they may read and write objects in the bucket named by CLOUDROP_S3_BUCKET, and CLOUDROP_S3_REGION.";
  }
  // R2 answers a bucket of another jurisdiction, or of none, as missing or refused.
  const where = jurisdiction
    ? ` in the ${jurisdiction} jurisdiction.`
    : ". A bucket in a jurisdiction also needs --jurisdiction.";
  return `Check CLOUDROP_R2_ACCESS_KEY_ID and CLOUDROP_R2_SECRET_ACCESS_KEY, that the token may read and write objects in the bucket named by CLOUDROP_R2_BUCKET, and that the bucket exists${where}`;
}

function endpointHint(service: Service, jurisdiction: string | undefined): string {
  if (service === "S3") return "The endpoint is CLOUDROP_S3_ENDPOINT.";
  // A wrong account ID names an R2 endpoint that does not exist, which reads as no network.
  return jurisdiction
    ? `The R2 endpoint is built from CLOUDROP_R2_ACCOUNT_ID and --jurisdiction ${jurisdiction}: check that it is your account ID and the bucket's jurisdiction.`
    : "The R2 endpoint is built from CLOUDROP_R2_ACCOUNT_ID: check that it is your account ID.";
}

/** What went wrong reaching the bucket, with the settings to check. */
function bucketProblem(error: CloudropError, service: Service, jurisdiction: string | undefined): string {
  if (error.code === "STORAGE_UNREACHABLE") return `${error.message} ${endpointHint(service, jurisdiction)}`;
  if (service === "S3" && OTHER_REGION.has(error.storageCode ?? "")) {
    return `The bucket is in another region (${error.storageCode}). Check CLOUDROP_S3_REGION, and that CLOUDROP_S3_ENDPOINT serves that region.`;
  }
  const refused = (error.status === 401 || error.status === 403) && !NOT_CREDENTIALS.has(error.storageCode ?? "");
  if (!refused) return error.message;
  return `The storage service refused these credentials (HTTP ${error.status}). ${credentialsHint(service, jurisdiction)}`;
}

/** Lists one key to prove the bucket answers: a listing's error tells a missing bucket from a missing key (M9-C5). */
export async function reachBucket(
  driver: S3Driver,
  service: Service,
  jurisdiction: string | undefined,
): Promise<Finding> {
  const listed = await driver.list("cloudrop-doctor/", { limit: 1 });
  if (!listed.error) return { status: "ok", text: "The bucket answers, and these credentials may list it." };
  return { status: "problem", text: `Bucket: ${bucketProblem(listed.error, service, jurisdiction)}` };
}
