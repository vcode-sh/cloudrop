// `cloudrop setup` without --apply: the rules in the formats Wrangler and the AWS CLI read, and the commands that set
// them, as docs/guide/bucket-setup.md describes. Commands name the bucket through its variable, never by value.

import type { Output } from "./report.ts";
import { ABORT_DAYS, corsRule, LIFECYCLE_RULE_ID } from "./rules.ts";
import type { Service } from "./settings.ts";

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** A wrangler command for the bucket, with the jurisdiction when it has one. */
export function wrangler(args: string, jurisdiction: string | undefined): string {
  return `wrangler r2 bucket ${args.replace("<bucket>", '"$CLOUDROP_R2_BUCKET"')}${jurisdiction ? ` --jurisdiction ${jurisdiction}` : ""}`;
}

/** An AWS CLI call for the bucket at the endpoint CLOUDROP_S3_ENDPOINT names. */
export function aws(call: string, args = ""): string {
  return `aws s3api ${call} --bucket "$CLOUDROP_S3_BUCKET"${args} --endpoint-url "$CLOUDROP_S3_ENDPOINT"`;
}

function r2Commands(jurisdiction: string | undefined): string[] {
  return [
    wrangler("cors list <bucket>", jurisdiction),
    wrangler("cors set <bucket> --file cors.json", jurisdiction),
    wrangler(`lifecycle add <bucket> ${LIFECYCLE_RULE_ID} --abort-multipart-days ${ABORT_DAYS}`, jurisdiction),
  ];
}

const S3_COMMANDS = [
  aws("get-bucket-cors"),
  aws("put-bucket-cors", " --cors-configuration file://cors-s3.json"),
  aws("get-bucket-lifecycle-configuration"),
  aws("put-bucket-lifecycle-configuration", " --lifecycle-configuration file://lifecycle.json"),
];

export function printInstructions(
  out: Output,
  { origins, service, jurisdiction }: { origins: string[]; service: Service | undefined; jurisdiction?: string },
): void {
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
  if (service !== "S3") sections.push(`Commands for R2:\n${indent(r2Commands(jurisdiction))}`);
  if (service !== "R2") sections.push(`Commands for S3-compatible services:\n${indent(S3_COMMANDS)}`);
  sections.push(
    "The commands read the bucket from CLOUDROP_R2_BUCKET or CLOUDROP_S3_BUCKET in your shell. Setting CORS, and setting lifecycle rules with the AWS CLI, replaces every rule the bucket has: list them first and add the ones you keep to the file, or run this command with --apply, which keeps them.",
  );
  out.write(`${sections.join("\n\n")}\n`);
}

const indent = (lines: string[]): string => lines.map((line) => `  ${line}`).join("\n");
