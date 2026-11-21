// `cloudrop doctor`: the settings, then the bucket, then its rules. Exit 0 when nothing is wrong, 1 when something is.
// A rule the credentials may not read is "not checked", never a failure: an R2 object token, for one, cannot read
// them (M9-C2).

import type { BucketCheck } from "../server/bucket-check.ts";
import { checkBucket } from "../server/bucket-check.ts";
import type { S3Driver } from "../storage/s3-driver.ts";
import type { CommandOptions } from "./args.ts";
import { reachBucket } from "./bucket-access.ts";
import { aws, cloudropCommand, type Runner, type Target, targetOf, wrangler } from "./commands.ts";
import type { Service, Settings } from "./names.ts";
import { count, type Finding, type Output, plural, printFindings } from "./report.ts";
import { type StorageSettings, secretFinding } from "./settings.ts";

/** The bucket being checked, and what a printed command needs to name it. */
interface Checked {
  service: Service;
  target: Target;
  runner: Runner;
}

/** How to read a setting by hand, for a check the credentials could not run: with the tool's own sign-in. */
function byHand({ service, target, runner }: Checked, jurisdiction: string | undefined, setting: "cors" | "lifecycle") {
  if (service === "R2") {
    return ` By hand, with Wrangler's own sign-in: ${wrangler(runner, `${setting} list <bucket>`, target, jurisdiction)}`;
  }
  const call = setting === "cors" ? "get-bucket-cors" : "get-bucket-lifecycle-configuration";
  return ` By hand, with the AWS CLI's own credentials and region: ${aws(call, target)}`;
}

function ruleFinding(label: string, check: BucketCheck, hint: { fix: string; byHand: string }): Finding {
  if (check.status === "ok") return { status: "ok", text: `${label}: ${check.message}` };
  if (check.status === "unknown") return { status: "unknown", text: `${label}: ${check.message}${hint.byHand}` };
  return { status: "problem", text: `${label}: ${check.message}${hint.fix}` };
}

async function bucketFindings(
  driver: S3Driver,
  checked: Checked,
  options: CommandOptions,
  settings: Settings,
): Promise<Finding[]> {
  const { jurisdiction } = options;
  const answered = await reachBucket(driver, { service: checked.service, jurisdiction, name: settings.name });
  if (answered.status === "problem") {
    return [answered, { status: "unknown", text: "CORS and lifecycle rules: the bucket did not answer." }];
  }
  const report = await checkBucket({ storage: driver, routes: new Map(), store: undefined }, options.origins);
  if (report.error) return [answered, { status: "problem", text: `Bucket rules: ${report.error.message}` }];
  const fix = ` Run: ${cloudropCommand(checked.runner, "setup", options, "--apply")}`;
  return [
    answered,
    ruleFinding("CORS", report.data.cors, { fix, byHand: byHand(checked, jurisdiction, "cors") }),
    ruleFinding("Lifecycle", report.data.lifecycle, { fix, byHand: byHand(checked, jurisdiction, "lifecycle") }),
  ];
}

export async function doctor(
  options: CommandOptions,
  settings: Settings,
  storage: StorageSettings,
  notes: Finding[],
  { out, runner }: { out: Output; runner: Runner },
): Promise<number> {
  out.write(
    `cloudrop doctor: checking ${storage.service ?? "storage"} settings, the bucket and its rules for ${options.origins.join(", ")}.\n`,
  );
  const findings = [...notes, ...storage.findings, secretFinding(settings)];
  if (storage.driver && storage.service) {
    const checked = { service: storage.service, target: targetOf(settings, storage), runner };
    findings.push(...(await bucketFindings(storage.driver, checked, options, settings)));
  } else {
    findings.push({ status: "unknown", text: "The bucket and its rules: fix the settings above first." });
  }
  printFindings(out, findings);
  const problems = count(findings, "problem");
  const unknown = count(findings, "unknown");
  if (problems > 0) {
    out.write(`${plural(problems, "problem")} found. Fix ${problems === 1 ? "it" : "them"}, then run doctor again.\n`);
    return 1;
  }
  out.write(
    unknown > 0 ? `No problems found. ${plural(unknown, "check")} could not run; see above.\n` : "No problems found.\n",
  );
  return 0;
}
