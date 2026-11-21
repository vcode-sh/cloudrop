// `cloudrop doctor`: the settings, then the bucket, then its rules. Exit 0 when nothing is wrong, 1 when something is.
// A rule the credentials may not read is "not checked", never a failure: R2 object tokens cannot read them (M9-C2).

import type { BucketCheck } from "../server/bucket-check.ts";
import { checkBucket } from "../server/bucket-check.ts";
import type { FetchLike } from "../storage/driver.ts";
import type { S3Driver } from "../storage/s3-driver.ts";
import type { CommandOptions } from "./args.ts";
import { reachBucket } from "./bucket-access.ts";
import { aws, wrangler } from "./instructions.ts";
import { count, type Finding, type Output, plural, printFindings } from "./report.ts";
import { readStorage, type Service, secretFinding, serviceOf, type Variables } from "./settings.ts";

/** How to read a setting by hand, for a check the credentials could not run. */
function byHand(service: Service, setting: "cors" | "lifecycle", jurisdiction: string | undefined): string {
  if (service === "R2") return ` By hand: ${wrangler(`${setting} list <bucket>`, jurisdiction)}`;
  return ` By hand: ${aws(setting === "cors" ? "get-bucket-cors" : "get-bucket-lifecycle-configuration")}`;
}

function ruleFinding(label: string, check: BucketCheck, hint: { fix: string; byHand: string }): Finding {
  if (check.status === "ok") return { status: "ok", text: `${label}: ${check.message}` };
  if (check.status === "unknown") return { status: "unknown", text: `${label}: ${check.message}${hint.byHand}` };
  return { status: "problem", text: `${label}: ${check.message}${hint.fix}` };
}

async function bucketFindings(
  driver: S3Driver,
  service: Service,
  { origins, jurisdiction }: CommandOptions,
): Promise<Finding[]> {
  const answered = await reachBucket(driver, service, jurisdiction);
  if (answered.status === "problem") {
    return [answered, { status: "unknown", text: "CORS and lifecycle rules: the bucket did not answer." }];
  }
  const report = await checkBucket({ storage: driver, routes: new Map(), store: undefined }, origins);
  if (report.error) return [answered, { status: "problem", text: `Bucket rules: ${report.error.message}` }];
  const apply = ` Run: cloudrop setup ${origins.map((origin) => `--origin ${origin}`).join(" ")} --apply`;
  return [
    answered,
    ruleFinding("CORS", report.data.cors, { fix: apply, byHand: byHand(service, "cors", jurisdiction) }),
    ruleFinding("Lifecycle", report.data.lifecycle, { fix: apply, byHand: byHand(service, "lifecycle", jurisdiction) }),
  ];
}

export async function doctor(
  options: CommandOptions,
  variables: Variables,
  notes: Finding[],
  { fetch, out }: { fetch: FetchLike; out: Output },
): Promise<number> {
  const service = serviceOf(variables) ?? "storage";
  out.write(
    `cloudrop doctor: checking ${service} settings, the bucket and its rules for ${options.origins.join(", ")}.\n`,
  );
  const storage = readStorage(variables, { jurisdiction: options.jurisdiction, fetch });
  const findings = [...notes, ...storage.findings, secretFinding(variables)];
  if (storage.driver && storage.service) {
    findings.push(...(await bucketFindings(storage.driver, storage.service, options)));
  } else {
    findings.push({ status: "unknown", text: "The bucket and its rules: fix the settings above first." });
  }
  printFindings(out, findings);
  const problems = count(findings, "problem");
  const unknown = count(findings, "unknown");
  if (problems > 0) {
    out.write(
      `${plural(problems, "problem")} found. Fix ${problems === 1 ? "it" : "them"}, then run cloudrop doctor again.\n`,
    );
    return 1;
  }
  out.write(
    unknown > 0 ? `No problems found. ${plural(unknown, "check")} could not run; see above.\n` : "No problems found.\n",
  );
  return 0;
}
