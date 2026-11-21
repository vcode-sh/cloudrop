import { describe, expect, it } from "vitest";
import { ENV, ORIGIN, run } from "./command-fixture.ts";

const doctor = (...pairs: string[]) => ["doctor", "--origin", ORIGIN, ...pairs.flatMap((pair) => ["--var", pair])];

describe("cloudrop --var", () => {
  it.each([
    {
      name: "a pair without =",
      argv: doctor("R2_BUCKET"),
      message:
        "--var takes SETTING=NAME, a setting and the variable to read it from, such as --var CLOUDROP_R2_BUCKET=R2_BUCKET.",
    },
    {
      name: "no setting before =",
      argv: doctor("=R2_BUCKET"),
      message:
        "--var takes SETTING=NAME, a setting and the variable to read it from, such as --var CLOUDROP_R2_BUCKET=R2_BUCKET.",
    },
    { name: "no pair at all", argv: [...doctor(), "--var"], message: "--var needs a value." },
    {
      name: "no variable after =",
      argv: doctor("CLOUDROP_R2_BUCKET="),
      message:
        '--var CLOUDROP_R2_BUCKET needs the name of the variable that holds it after "=": letters, digits and "_", not starting with a digit, such as --var CLOUDROP_R2_BUCKET=R2_BUCKET. Give the variable\'s name, never its value.',
    },
    {
      // The fixture fails the run if this value, the bucket's name, is printed.
      name: "a value where the variable's name belongs",
      argv: doctor(`CLOUDROP_R2_BUCKET=${ENV.CLOUDROP_R2_BUCKET}`),
      message:
        '--var CLOUDROP_R2_BUCKET needs the name of the variable that holds it after "=": letters, digits and "_", not starting with a digit, such as --var CLOUDROP_R2_BUCKET=R2_BUCKET. Give the variable\'s name, never its value.',
    },
    {
      name: "a variable name that starts with a digit",
      argv: doctor("CLOUDROP_SECRET=9LIVES"),
      message:
        '--var CLOUDROP_SECRET needs the name of the variable that holds it after "=": letters, digits and "_", not starting with a digit, such as --var CLOUDROP_SECRET=SECRET. Give the variable\'s name, never its value.',
    },
    {
      name: "a misspelt setting",
      argv: doctor("CLOUDROP_R2_BUCKT=R2_BUCKET"),
      message: '--var: "CLOUDROP_R2_BUCKT" is not a setting the command reads. Did you mean CLOUDROP_R2_BUCKET?',
    },
    {
      name: "a setting in lower case without its prefix",
      argv: doctor("s3_region=AWS_REGION"),
      message: '--var: "s3_region" is not a setting the command reads. Did you mean CLOUDROP_S3_REGION?',
    },
    {
      name: "a setting the command does not read",
      argv: doctor("CLOUDROP_UPLOADS_PATH=UPLOADS_PATH"),
      message: '--var: "CLOUDROP_UPLOADS_PATH" is not a setting the command reads. The settings are listed below.',
    },
    // Shaped like a name, as an access key ID is: only a setting's name, or one misspelt, is repeated (M11-R234).
    {
      name: "a name before = that is no setting's and near none",
      argv: doctor("AKIAIOSFODNN7EXAMPLE=R2_KEY"),
      message: '--var: what stands before "=" is not a setting the command reads. The settings are listed below.',
    },
    {
      name: "something that is no name before =",
      argv: doctor("acme-uploads=R2_BUCKET"),
      message: '--var: what stands before "=" is not a setting the command reads. The settings are listed below.',
    },
    {
      name: "the variable first and the setting second",
      argv: doctor("R2_BUCKET=CLOUDROP_R2_BUCKET"),
      message: "--var takes the setting first, then your variable: --var CLOUDROP_R2_BUCKET=R2_BUCKET.",
    },
    {
      name: "a setting given two variables",
      argv: doctor("CLOUDROP_R2_BUCKET=R2_BUCKET", "CLOUDROP_R2_BUCKET=BUCKET"),
      message: "--var names CLOUDROP_R2_BUCKET twice. Give each setting one variable.",
    },
    {
      name: "two settings read from one variable",
      argv: doctor("CLOUDROP_R2_BUCKET=BUCKET", "CLOUDROP_S3_BUCKET=BUCKET"),
      message:
        "--var reads both CLOUDROP_R2_BUCKET and CLOUDROP_S3_BUCKET from BUCKET. Give each setting its own variable.",
    },
    {
      name: "a setting read from another setting's own name",
      argv: doctor("CLOUDROP_R2_BUCKET=CLOUDROP_S3_BUCKET"),
      message:
        "--var cannot read CLOUDROP_R2_BUCKET from CLOUDROP_S3_BUCKET, which is another setting's own name. Give it a variable of your own, such as --var CLOUDROP_R2_BUCKET=R2_BUCKET.",
    },
  ])("rejects $name with exit code 2", async ({ argv, message }) => {
    const result = await run(argv);
    expect([result.code, result.stdout, result.stderr.split("\n")[0]]).toEqual([2, "", message]);
  });

  it("lists every setting --var can name in the usage that follows a usage error", async () => {
    const { stderr } = await run(doctor("BUCKET=R2_BUCKET"));
    const settings = [
      "CLOUDROP_R2_ACCOUNT_ID",
      "CLOUDROP_R2_BUCKET",
      "CLOUDROP_R2_ACCESS_KEY_ID",
      "CLOUDROP_R2_SECRET_ACCESS_KEY",
      "CLOUDROP_S3_ENDPOINT",
      "CLOUDROP_S3_REGION",
      "CLOUDROP_S3_BUCKET",
      "CLOUDROP_S3_ACCESS_KEY_ID",
      "CLOUDROP_S3_SECRET_ACCESS_KEY",
      "CLOUDROP_SECRET",
    ];
    expect(stderr).toContain("--var <SETTING>=<NAME>");
    expect(settings.filter((setting) => !stderr.includes(setting))).toEqual([]);
  });

  it("accepts --var=SETTING=NAME, for doctor and for setup", async () => {
    const setup = await run(["setup", `--origin=${ORIGIN}`, "--var=CLOUDROP_R2_BUCKET=R2_BUCKET"], {
      env: { ...ENV, CLOUDROP_R2_BUCKET: undefined, R2_BUCKET: "renamed-bucket-name" },
    });
    expect(setup.lines).toContain("  npx wrangler r2 bucket cors list renamed-bucket-name");
    const checked = await run(["doctor", "--origin", ORIGIN, "--var=CLOUDROP_R2_BUCKET=R2_BUCKET"], {
      env: { R2_BUCKET: ENV.CLOUDROP_R2_BUCKET },
    });
    expect(checked.lines[0]).toBe(`cloudrop doctor: checking R2 settings, the bucket and its rules for ${ORIGIN}.`);
  });

  it("accepts a setting given its own name, which changes nothing", async () => {
    const result = await run(doctor("CLOUDROP_SECRET=CLOUDROP_SECRET"), {
      env: { CLOUDROP_SECRET: ENV.CLOUDROP_SECRET },
    });
    expect(result.lines.slice(1, 3)).toEqual([
      "PROBLEM      No storage settings found. Set CLOUDROP_R2_ACCOUNT_ID, CLOUDROP_R2_BUCKET, CLOUDROP_R2_ACCESS_KEY_ID and CLOUDROP_R2_SECRET_ACCESS_KEY for R2, or the CLOUDROP_S3_* settings for another service; --env-file reads them from a file.",
      "ok           CLOUDROP_SECRET is set.",
    ]);
  });
});
