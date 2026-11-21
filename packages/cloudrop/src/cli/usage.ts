// The command's help, printed for --help and after every usage error.

import type { Runner } from "./commands.ts";

export const usage = (runner: Runner): string => `Usage: ${runner} cloudrop <doctor|setup> --origin <origin> [options]

Commands:
  doctor   Check the storage settings, the bucket and its CORS and lifecycle rules.
  setup    Print the bucket's CORS and lifecycle rules and the commands that set them.
           With --apply, add them to the bucket and keep every other rule.

Options:
  --origin <origin>       An origin your pages upload from, such as https://app.example.com.
                          Repeat it for each origin. Required.
  --env-file <path>       Also read settings from this file of NAME=value lines. A variable
                          set in the environment wins over the file. Repeat it for each
                          file: a later file wins over an earlier one.
  --var <SETTING>=<NAME>  Read a setting from a variable of your own, such as
                          --var CLOUDROP_R2_BUCKET=R2_BUCKET. Repeat it for each setting.
  --jurisdiction <eu|fedramp>
                          The R2 bucket's jurisdiction, when it has one. R2 only.
  --apply                 setup: write the rules to the bucket, keeping every other rule.
  --dry-run               setup: show what --apply would write, and write nothing.
  --replace               setup: write even when the current rules cannot be read, which
                          replaces them.
  -h, --help              Show this help.
  -v, --version           Print the version.

Settings come from the environment, as cloudrop reads them, or from the variables --var names:
  R2      CLOUDROP_R2_ACCOUNT_ID, CLOUDROP_R2_BUCKET, CLOUDROP_R2_ACCESS_KEY_ID,
          CLOUDROP_R2_SECRET_ACCESS_KEY
  or S3   CLOUDROP_S3_ENDPOINT, CLOUDROP_S3_REGION, CLOUDROP_S3_BUCKET,
          CLOUDROP_S3_ACCESS_KEY_ID, CLOUDROP_S3_SECRET_ACCESS_KEY
  and     CLOUDROP_SECRET
The command never prints a key or a secret. The commands it suggests name the bucket and,
for S3, the endpoint.

Exit codes: 0 nothing is wrong, 1 a problem was found or a write failed, 2 a usage error.
`;
