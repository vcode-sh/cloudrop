// `cloudrop setup --apply` and `--dry-run`: read the bucket's rules, merge cloudrop's in by ID, and write only what
// changed. A write replaces every rule, so nothing is written when the current rules cannot be read, unless --replace
// says that replacing them is intended (M9-C6).

import type { Result } from "../errors.ts";
import type { BucketCorsRule, BucketLifecycleRule, FetchLike } from "../storage/driver.ts";
import type { S3Driver } from "../storage/s3-driver.ts";
import type { CommandOptions } from "./args.ts";
import { count, type Finding, type Output, plural, printFindings, ruleNames } from "./report.ts";
import { ABORT_DAYS, corsRule, LIFECYCLE_RULE, type Merged, mergeCors, mergeLifecycle } from "./rules.ts";
import { readStorage, type Variables } from "./settings.ts";

/** What setup does to one setting, once its current rules are read and cloudrop's merged in. */
interface Step {
  label: "CORS" | "Lifecycle";
  ruleId: string;
  /** What cloudrop's rule does, for the output. */
  describe: string;
  change: "add" | "update" | "none";
  kept: { id?: string }[];
  /** True when the current rules could not be read and --replace allowed writing cloudrop's alone. */
  replacing: boolean;
  /** Why nothing changes, when that is the case. */
  reason?: string;
  /** What cloudrop's rule gains, for an update. */
  added?: string;
  write(): Promise<Result<void>>;
}

interface Setting<Rule> {
  label: Step["label"];
  ours: Rule & { id: string };
  describe: string;
  read: Result<Rule[]>;
  merge(current: readonly Rule[], ours: Rule): Merged<Rule>;
  write(rules: Rule[]): Promise<Result<void>>;
}

/**
 * A step, or the finding that refuses one: the current rules could not be read, or cloudrop's own rule was edited.
 * --replace covers only a read the credentials or the service refuse (403, 501); any other failure says nothing about
 * the rules, so it never replaces them.
 */
function plan<Rule extends { id?: string }>(setting: Setting<Rule>, replace: boolean): Step | Finding {
  const { label, ours, describe, read } = setting;
  const refusedRead = read.error?.code === "STORAGE_DENIED" || read.error?.status === 501;
  if (read.error && !(replace && refusedRead)) {
    const next = replace
      ? "--replace applies only when the credentials or the service refuse the read."
      : "Use credentials that may read and change bucket settings, or pass --replace to replace the rules with cloudrop's alone.";
    return {
      status: "problem",
      text: `${label}: could not read the current rules: ${read.error.message} A write replaces every rule, so none was written. ${next}`,
    };
  }
  const merged: Merged<Rule> = read.error ? { rules: [ours], change: "add", kept: [] } : setting.merge(read.data, ours);
  const { change, kept, reason, added } = merged;
  if (change === "blocked") return { status: "problem", text: `${label}: ${reason}` };
  return {
    label,
    ruleId: ours.id,
    describe,
    change,
    kept,
    replacing: read.error !== null,
    reason,
    added,
    write: () => setting.write(merged.rules),
  };
}

function describeChange(step: Step, dryRun: boolean): string {
  const { label, ruleId, describe, kept } = step;
  if (step.replacing) {
    const verb = dryRun ? "would replace" : "replaced";
    return `${label}: ${verb} every rule with "${ruleId}" ${describe} (--replace: the current rules could not be read).`;
  }
  const keeps =
    kept.length > 0 ? ` and ${dryRun ? "keep" : "kept"} ${plural(kept.length, "other rule")} (${ruleNames(kept)})` : "";
  if (step.change === "update") {
    return `${label}: ${dryRun ? "would add" : "added"} ${step.added} to rule "${ruleId}"${keeps}.`;
  }
  return `${label}: ${dryRun ? "would add" : "added"} rule "${ruleId}" ${describe}${keeps}.`;
}

async function carryOut(step: Step, dryRun: boolean): Promise<Finding> {
  if (step.change === "none") {
    return { status: "ok", text: `${step.label}: ${step.reason}; nothing to change.` };
  }
  if (dryRun) return { status: "dry run", text: describeChange(step, true) };
  const written = await step.write();
  if (written.error) return { status: "problem", text: `${step.label}: the write failed. ${written.error.message}` };
  return { status: "ok", text: describeChange(step, false) };
}

async function planBoth(driver: S3Driver, options: CommandOptions): Promise<(Step | Finding)[]> {
  const [cors, lifecycle] = await Promise.all([driver.getBucketCors(), driver.getBucketLifecycle()]);
  const origins = options.origins.join(", ");
  const days = plural(ABORT_DAYS, "day");
  return [
    plan<BucketCorsRule>(
      {
        label: "CORS",
        ours: corsRule(options.origins),
        describe: `for ${origins}`,
        read: cors,
        merge: mergeCors,
        write: driver.putBucketCors,
      },
      options.replace,
    ),
    plan<BucketLifecycleRule>(
      {
        label: "Lifecycle",
        ours: LIFECYCLE_RULE,
        describe: `(aborts incomplete multipart uploads after ${days}, whole bucket)`,
        read: lifecycle,
        merge: mergeLifecycle,
        write: driver.putBucketLifecycle,
      },
      options.replace,
    ),
  ];
}

const isFinding = (step: Step | Finding): step is Finding => "status" in step;
const isStep = (step: Step | Finding): step is Step => !isFinding(step);

export async function applySetup(
  options: CommandOptions,
  variables: Variables,
  notes: Finding[],
  { fetch, out }: { fetch: FetchLike; out: Output },
): Promise<number> {
  const mode = options.dryRun ? "showing what --apply would change" : "adding cloudrop's rules";
  out.write(`cloudrop setup: ${mode} for ${options.origins.join(", ")}.\n`);
  const storage = readStorage(variables, { jurisdiction: options.jurisdiction, fetch });
  if (!storage.driver) {
    printFindings(out, [...notes, ...storage.findings]);
    out.write("Nothing was written. Fix the settings above, then run the command again.\n");
    return 1;
  }
  const steps = await planBoth(storage.driver, options);
  const refused = steps.filter(isFinding);
  if (refused.length > 0) {
    printFindings(out, [...notes, ...refused]);
    out.write("Nothing was written.\n");
    return 1;
  }
  // One write at a time, CORS first, so a failure leaves the output in the order it happened.
  const findings = [...notes];
  for (const step of steps.filter(isStep)) findings.push(await carryOut(step, options.dryRun));
  printFindings(out, findings);
  if (count(findings, "problem") > 0) {
    out.write("Some rules were not written; see above.\n");
    return 1;
  }
  const doctorCommand = `cloudrop doctor ${options.origins.map((origin) => `--origin ${origin}`).join(" ")}`;
  out.write(
    options.dryRun
      ? "Dry run: nothing was written. Run the same command without --dry-run to write.\n"
      : `Done. Check the bucket with ${doctorCommand}; R2 can take up to 30 seconds to apply a change.\n`,
  );
  return 0;
}
