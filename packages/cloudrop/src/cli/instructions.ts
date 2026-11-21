// `cloudrop setup` without --apply: the rules in the formats Wrangler and the AWS CLI read, and the commands that set
// them, as docs/guide/bucket-setup.md describes. Commands name the bucket through its variable, never by value: the
// variable the command itself reads it from, so they work in the shell that ran it (M11-C4).

import type { NameOf, Service } from "./names.ts";
import type { Output } from "./report.ts";
import { ABORT_DAYS, corsRule, LIFECYCLE_RULE_ID } from "./rules.ts";

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** A wrangler command for the bucket, with the jurisdiction when it has one. */
export function wrangler(args: string, jurisdiction: string | undefined, name: NameOf): string {
  const bucket = `"$${name("CLOUDROP_R2_BUCKET")}"`;
  return `wrangler r2 bucket ${args.replace("<bucket>", bucket)}${jurisdiction ? ` --jurisdiction ${jurisdiction}` : ""}`;
}

/** An AWS CLI call for the bucket at the endpoint the S3 endpoint setting names. */
export function aws(call: string, name: NameOf, args = ""): string {
  return `aws s3api ${call} --bucket "$${name("CLOUDROP_S3_BUCKET")}"${args} --endpoint-url "$${name("CLOUDROP_S3_ENDPOINT")}"`;
}

function r2Commands(jurisdiction: string | undefined, name: NameOf): string[] {
  return [
    wrangler("cors list <bucket>", jurisdiction, name),
    wrangler("cors set <bucket> --file cors.json", jurisdiction, name),
    wrangler(`lifecycle add <bucket> ${LIFECYCLE_RULE_ID} --abort-multipart-days ${ABORT_DAYS}`, jurisdiction, name),
  ];
}

const s3Commands = (name: NameOf): string[] => [
  aws("get-bucket-cors", name),
  aws("put-bucket-cors", name, " --cors-configuration file://cors-s3.json"),
  aws("get-bucket-lifecycle-configuration", name),
  aws("put-bucket-lifecycle-configuration", name, " --lifecycle-configuration file://lifecycle.json"),
];

interface Instructions {
  origins: string[];
  service: Service | undefined;
  jurisdiction?: string;
  name: NameOf;
}

export function printInstructions(out: Output, { origins, service, jurisdiction, name }: Instructions): void {
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
  if (service !== "S3") sections.push(`Commands for R2:\n${indent(r2Commands(jurisdiction, name))}`);
  if (service !== "R2") sections.push(`Commands for S3-compatible services:\n${indent(s3Commands(name))}`);
  sections.push(
    `The commands read the bucket from ${name("CLOUDROP_R2_BUCKET")} or ${name("CLOUDROP_S3_BUCKET")} in your shell. Setting CORS, and setting lifecycle rules with the AWS CLI, replaces every rule the bucket has: list them first and add the ones you keep to the file, or run this command with --apply, which keeps them.`,
  );
  out.write(`${sections.join("\n\n")}\n`);
}

const indent = (lines: string[]): string => lines.map((line) => `  ${line}`).join("\n");
