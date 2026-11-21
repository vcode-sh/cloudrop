import { describe, expect, it } from "vitest";
import { ORIGIN, run } from "./command-fixture.ts";

describe("cloudrop usage", () => {
  it.each([
    { name: "no command", argv: [], message: "Name a command: doctor or setup." },
    { name: "an unknown command", argv: ["check"], message: 'Unknown command "check". Use doctor or setup.' },
    {
      name: "no origin",
      argv: ["doctor"],
      message: "Name at least one origin your pages upload from: --origin https://app.example.com.",
    },
    {
      name: "an origin with a path",
      argv: ["doctor", "--origin", "https://app.example.com/upload"],
      message:
        '"https://app.example.com/upload" is not an origin. Write it as scheme://host[:port] with no path, such as https://app.example.com.',
    },
    {
      name: "an unknown option",
      argv: ["doctor", "--origin", ORIGIN, "--force"],
      message: 'Unknown option "--force". Run cloudrop --help to see the options.',
    },
    { name: "an option without its value", argv: ["setup", "--origin"], message: "--origin needs a value." },
    {
      name: "a setup option given to doctor",
      argv: ["doctor", "--origin", ORIGIN, "--apply"],
      message: "--apply works only with setup.",
    },
    {
      name: "--replace without --apply or --dry-run",
      argv: ["setup", "--origin", ORIGIN, "--replace"],
      message: "--replace works only with --apply or --dry-run.",
    },
    {
      name: "an unknown jurisdiction",
      argv: ["setup", "--origin", ORIGIN, "--jurisdiction", "us"],
      message: '--jurisdiction must be "eu" or "fedramp". Leave it out for a bucket in the default location.',
    },
  ])("rejects $name with exit code 2 and the usage on stderr", async ({ argv, message }) => {
    const result = await run(argv);
    expect([result.code, result.stdout]).toEqual([2, ""]);
    expect(result.stderr.split("\n")[0]).toBe(message);
    expect(result.stderr).toContain("Usage: cloudrop <doctor|setup> --origin <origin> [options]");
  });

  it("prints the usage on stdout and exits 0 for --help", async () => {
    const result = await run(["--help"]);
    expect([result.code, result.stderr, result.lines[0]]).toEqual([
      0,
      "",
      "Usage: cloudrop <doctor|setup> --origin <origin> [options]",
    ]);
  });

  it("reports an --env-file it cannot read by its path and error code, with exit code 2", async () => {
    const result = await run(["doctor", "--origin", ORIGIN, "--env-file", "missing.env"]);
    expect([result.code, result.stderr]).toEqual([2, "Cannot read missing.env (ENOENT). Check the path.\n"]);
  });

  it("accepts --name=value", async () => {
    const result = await run(["setup", `--origin=${ORIGIN}`, "--env-file=.env", "--jurisdiction=eu"], {
      files: { ".env": "" },
    });
    expect([result.code, result.lines[0]]).toEqual([0, `cloudrop setup: the bucket rules for ${ORIGIN}.`]);
    expect(result.lines).toContain('  wrangler r2 bucket cors list "$CLOUDROP_R2_BUCKET" --jurisdiction eu');
  });
});
