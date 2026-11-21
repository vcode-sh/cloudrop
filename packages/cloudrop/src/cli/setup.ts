// `cloudrop setup --apply` and `--dry-run`: read the bucket's rules, merge cloudrop's in by ID, and write only what
// changed. A write replaces every rule, so nothing is written when the current rules cannot be read, unless --replace
// says that replacing them is intended (M9-C6).

import type { CloudropError, Result } from "../errors.ts";
import type { BucketCorsRule, BucketLifecycleRule } from "../storage/driver.ts";
import type { S3Driver } from "../storage/s3-driver.ts";
import type { CommandOptions } from "./args.ts";
import { reachBucket } from "./bucket-access.ts";
import { cloudropCommand, type Runner } from "./commands.ts";
import { listed, type Service, type Settings } from "./names.ts";
import { count, type Finding, type Output, plural, printFindings, ruleNames } from "./report.ts";
import {
  ABORT_DAYS,
  corsRule,
  LIFECYCLE_RULE,
  type Merged,
  mergeCors,
  mergeLifecycle,
  type Placement,
} from "./rules.ts";
import type { StorageSettings } from "./settings.ts";

/** What setup does to one setting, once its current rules are read and cloudrop's merged in. */
interface Step {
  label: "CORS" | "Lifecycle";
  ruleId: string;
  /** What cloudrop's rule does, for the output. */
  describe: string;
  change: Merged<unknown>["change"];
  kept: { id?: string }[];
  /** True when the current rules could not be read and --replace allowed writing cloudrop's alone. */
  replacing: boolean;
  /** Why nothing changes, when that is the case. */
  reason?: string;
  /** What cloudrop's rule gains, for an update. */
  added?: string;
  /** How many rules carried cloudrop's ID, when there were several: they are written as one. */
  merged?: number;
  /** The rule cloudrop's rule goes before, when another would answer its uploads in its place, and why. */
  placement?: Placement;
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

/** S3's two permissions for reading and changing each setting. */
const S3_PERMISSIONS: Record<Step["label"], string> = {
  CORS: "s3:GetBucketCORS and s3:PutBucketCORS",
  Lifecycle: "s3:GetLifecycleConfiguration and s3:PutLifecycleConfiguration",
};

/**
 * Why nothing is written when the current rules cannot be read. A refused read is offered --replace, since the
 * listing beside it proved the credentials (M9-H102); after any other failure --replace would not act, so it is not.
 */
function unreadable(label: Step["label"], error: CloudropError, replace: boolean, service: Service): string {
  if (error.code === "STORAGE_DENIED") {
    const [rules, admin] =
      service === "R2"
        ? ["rules (R2 object tokens cannot)", ", such as an R2 Admin Read & Write token,"]
        : ["rules", ` (${S3_PERMISSIONS[label]}),`];
    return `${label}: these credentials may not read the bucket's ${label === "CORS" ? "CORS" : "lifecycle"} ${rules}, and a write replaces every rule, so none was written. Use credentials that may read and change bucket settings for this step${admin} or pass --replace to replace every rule with cloudrop's alone.`;
  }
  const failed = `${label}: could not read the current rules: ${error.message} A write replaces every rule, so none was written.`;
  return replace ? `${failed} --replace applies only when the credentials refuse the read.` : failed;
}

/**
 * A step, or the finding that refuses one: the current rules could not be read, or cloudrop's own rule was edited.
 * --replace covers only a read the credentials refuse (403): any other failure says nothing about the rules, and a
 * service that cannot read them (501) cannot write them either (M9-H102), so neither ever replaces them.
 */
function plan<Rule extends { id?: string }>(
  setting: Setting<Rule>,
  replace: boolean,
  service: Service,
): Step | Finding {
  const { label, ours, describe, read } = setting;
  if (read.error && !(replace && read.error.code === "STORAGE_DENIED")) {
    return { status: "problem", text: unreadable(label, read.error, replace, service) };
  }
  const merged: Merged<Rule> = read.error ? { rules: [ours], change: "add", kept: [] } : setting.merge(read.data, ours);
  const { rules, ...result } = merged;
  return {
    label,
    ruleId: ours.id,
    describe,
    ...result,
    replacing: read.error !== null,
    write: () => setting.write(rules),
  };
}

const WOULD = { add: "add", merge: "merge", allow: "allow", move: "move", keep: "keep" };
const DID = { add: "added", merge: "merged", allow: "allowed", move: "moved", keep: "kept" };

/** What a step does, each as the words after "would" or as a past tense: "add rule …", "moved it before …". */
function changes(step: Step, dryRun: boolean): string[] {
  const { ruleId, describe, kept, added, merged, placement } = step;
  const verb = dryRun ? WOULD : DID;
  const before = placement ? ` before ${placement.before}` : "";
  const done = step.change === "update" ? [] : [`${verb.add} rule "${ruleId}" ${describe}${before}`];
  // Once a part has named cloudrop's rule, the next calls it "it".
  const rule = () => (done.length > 0 ? "it" : `rule "${ruleId}"`);
  if (merged) {
    done.push(
      `${verb.merge} the ${merged} rules named "${ruleId}" into one, which allows everything they ${verb.allow}`,
    );
  }
  if (added) done.push(`${verb.add} ${added} to ${rule()}`);
  if (step.change === "update" && before) done.push(`${verb.move} ${rule()}${before}`);
  if (kept.length > 0) done.push(`${verb.keep} ${plural(kept.length, "other rule")} (${ruleNames(kept)})`);
  return done;
}

function describeChange(step: Step, dryRun: boolean): string {
  const { label, ruleId, describe } = step;
  if (step.replacing) {
    const verb = dryRun ? "would replace" : "replaced";
    return `${label}: ${verb} every rule with "${ruleId}" ${describe}, as --replace asks: the current rules could not be read.`;
  }
  const why = step.placement ? ` ${step.placement.why}` : "";
  return `${label}: ${dryRun ? "would " : ""}${listed(changes(step, dryRun))}.${why}`;
}

async function carryOut(step: Step, dryRun: boolean): Promise<Finding> {
  // An edited rule of cloudrop's stops only its own setting: the other is still written.
  if (step.change === "blocked") return { status: "problem", text: `${step.label}: ${step.reason}` };
  if (step.change === "none") {
    return { status: "ok", text: `${step.label}: ${step.reason}; nothing to change.` };
  }
  if (dryRun) return { status: "dry run", text: describeChange(step, true) };
  const written = await step.write();
  if (written.error) return { status: "problem", text: `${step.label}: the write failed. ${written.error.message}` };
  return { status: "ok", text: describeChange(step, false) };
}

async function planBoth(driver: S3Driver, options: CommandOptions, service: Service): Promise<(Step | Finding)[]> {
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
      service,
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
      service,
    ),
  ];
}

const isFinding = (step: Step | Finding): step is Finding => "status" in step;
const isStep = (step: Step | Finding): step is Step => !isFinding(step);

export async function applySetup(
  options: CommandOptions,
  settings: Settings,
  storage: StorageSettings,
  notes: Finding[],
  { out, runner }: { out: Output; runner: Runner },
): Promise<number> {
  const mode = options.dryRun ? "showing what --apply would change" : "adding cloudrop's rules";
  out.write(`cloudrop setup: ${mode} for ${options.origins.join(", ")}.\n`);
  if (!storage.driver || !storage.service) {
    printFindings(out, [...notes, ...storage.findings]);
    out.write("Nothing was written. Fix the settings above, then run the command again.\n");
    return 1;
  }
  // The listing runs beside the reads and counts whenever a read failed, with --replace too: wrong credentials or no
  // network fail the reads as well, and then the bucket is the problem, not its rules (M9-H102, M11-R114).
  const [steps, access] = await Promise.all([
    planBoth(storage.driver, options, storage.service),
    reachBucket(storage.driver, {
      service: storage.service,
      jurisdiction: options.jurisdiction,
      name: settings.name,
    }),
  ]);
  const refused = steps.filter(isFinding);
  const unread = steps.some((step) => isFinding(step) || step.replacing);
  if (refused.length > 0 || (unread && access.status === "problem")) {
    printFindings(out, [...notes, ...(access.status === "problem" ? [access] : refused)]);
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
  if (options.dryRun) {
    const write = cloudropCommand(runner, "setup", options, "--apply", ...(options.replace ? ["--replace"] : []));
    out.write(`Dry run: nothing was written. To write: ${write}\n`);
    return 0;
  }
  const wait = storage.service === "R2" ? " R2 can take up to 30 seconds to apply a change." : "";
  out.write(`Done.${wait} Check the bucket: ${cloudropCommand(runner, "doctor", options)}\n`);
  return 0;
}
