// `cloudrop setup` without --apply: the rules in the formats Wrangler and the AWS CLI read, and the commands that set
// them, as docs/guide/bucket-setup.md describes.

import { aws, type Runner, type Target, wrangler } from "./commands.ts";
import type { Service } from "./names.ts";
import type { Output } from "./report.ts";
import { ABORT_DAYS, corsRule, LIFECYCLE_RULE_ID } from "./rules.ts";

const json = (value: unknown): string => JSON.stringify(value, null, 2);

function r2Commands(runner: Runner, target: Target, jurisdiction: string | undefined): string[] {
  return [
    wrangler(runner, "cors list <bucket>", target, jurisdiction),
    wrangler(runner, "cors set <bucket> --file cors.json", target, jurisdiction),
    wrangler(
      runner,
      `lifecycle add <bucket> ${LIFECYCLE_RULE_ID} --abort-multipart-days ${ABORT_DAYS}`,
      target,
      jurisdiction,
    ),
  ];
}

const s3Commands = (target: Target): string[] => [
  aws("get-bucket-cors", target),
  aws("put-bucket-cors", target, " --cors-configuration file://cors-s3.json"),
  aws("get-bucket-lifecycle-configuration", target),
  aws("put-bucket-lifecycle-configuration", target, " --lifecycle-configuration file://lifecycle.json"),
];

/** What to put in place of the placeholders, for the services whose commands are printed. */
function placeholderNote(service: Service | undefined): string {
  const endpoint = service === "R2" ? "" : " and <endpoint> with the service's S3 endpoint";
  return `Replace <bucket> with the bucket's name${endpoint}: the command prints ${endpoint ? "them" : "it"} only once the storage settings are all set and valid.`;
}

interface Instructions {
  origins: string[];
  service: Service | undefined;
  jurisdiction?: string;
  runner: Runner;
  target: Target;
  /** The cloudrop command that adds the rules and keeps the others. */
  apply: string;
}

export function printInstructions(out: Output, instructions: Instructions): void {
  const { origins, service, jurisdiction, runner, target, apply } = instructions;
  const rule = corsRule(origins);
  const r2Format = {
    rules: [
      {
        id: rule.id,
        allowed: { origins: rule.allowedOrigins, methods: rule.allowedMethods, headers: rule.allowedHeaders },
        exposeHeaders: rule.exposeHeaders,
        maxAgeSeconds: rule.maxAgeSeconds,
      },
    ],
  };
  const s3Format = {
    CORSRules: [
      {
        ID: rule.id,
        AllowedOrigins: rule.allowedOrigins,
        AllowedMethods: rule.allowedMethods,
        AllowedHeaders: rule.allowedHeaders,
        ExposeHeaders: rule.exposeHeaders,
        MaxAgeSeconds: rule.maxAgeSeconds,
      },
    ],
  };
  const lifecycle = {
    Rules: [
      {
        ID: LIFECYCLE_RULE_ID,
        Status: "Enabled",
        Filter: { Prefix: "" },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_DAYS },
      },
    ],
  };
  const sections = [
    `cloudrop setup: the bucket rules for ${origins.join(", ")}.`,
    `CORS rule, R2 format. Save it as cors.json for wrangler r2 bucket cors set:\n${json(r2Format)}`,
    `CORS rule, S3 format. Save it as cors-s3.json for aws s3api put-bucket-cors:\n${json(s3Format)}`,
    `Lifecycle rule. Save it as lifecycle.json for aws s3api put-bucket-lifecycle-configuration:\n${json(lifecycle)}`,
  ];
  // Neither tool reads cloudrop's settings, so a command printed for it runs only once the tool is signed in.
  if (service !== "S3") {
    const signIn = `Wrangler signs in on its own, not with cloudrop's keys (${runner} wrangler login, or CLOUDFLARE_API_TOKEN):`;
    sections.push(`Commands for R2. ${signIn}\n${indent(r2Commands(runner, target, jurisdiction))}`);
  }
  if (service !== "R2") {
    const signIn =
      "The AWS CLI uses its own credentials and region, not cloudrop's settings (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_DEFAULT_REGION, or a profile):";
    sections.push(`Commands for S3-compatible services. ${signIn}\n${indent(s3Commands(target))}`);
  }
  if (target.placeholders) sections.push(placeholderNote(service));
  sections.push(
    // Measured on R2 and documented by S3 (r2-spike-findings.md, "Which CORS rule answers when several match").
    `Where the CORS rule goes: the storage service answers a request with the first rule that matches it, never a later one. Put cloudrop's rule before any rule you keep that also allows PUT from ${origins.join(", ")}, such as a rule for every origin ("*").`,
    `Setting CORS, and setting lifecycle rules with the AWS CLI, replaces every rule the bucket has: list them first and add the ones you keep to the file. Or let cloudrop add its rules, each where it takes effect, and keep the others:\n${indent([apply])}`,
  );
  out.write(`${sections.join("\n\n")}\n`);
}

const indent = (lines: string[]): string => lines.map((line) => `  ${line}`).join("\n");
