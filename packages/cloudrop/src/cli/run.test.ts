import { describe, expect, it } from "vitest";
import { ENV, ORIGIN, run } from "./command-fixture.ts";

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
        '"https://app.example.com/upload" is not an origin. Use https://app.example.com: an origin is the scheme, host and port, with no path.',
    },
    {
      name: "an origin with a trailing slash, in upper case",
      argv: ["doctor", "--origin", "HTTP://LOCALHOST:3530/"],
      message:
        '"HTTP://LOCALHOST:3530/" is not an origin. Use http://localhost:3530: an origin is the scheme, host and port, with no path.',
    },
    {
      name: "a wildcard origin",
      argv: ["setup", "--origin", "https://*.example.com"],
      message:
        '"https://*.example.com" is a pattern, not an origin. Name each origin your pages upload from, such as https://app.example.com.',
    },
    {
      name: "the opaque origin null",
      argv: ["doctor", "--origin", "null"],
      message:
        '"null" is not an origin. Write it in lowercase as scheme://host[:port] with no path, such as https://app.example.com.',
    },
    {
      name: "something that is not a URL",
      argv: ["doctor", "--origin", "localhost:3530"],
      message:
        '"localhost:3530" is not an origin. Write it in lowercase as scheme://host[:port] with no path, such as https://app.example.com.',
    },
    {
      name: "a scheme no page is loaded over",
      argv: ["doctor", "--origin", "ws://app.example.com"],
      message:
        "\"ws://app.example.com\" is not a page's origin: a page is loaded over http or https, or over an app's own scheme. Name the origin of the page that uploads, such as https://app.example.com.",
    },
    {
      name: "a host no browser loads a page from",
      argv: ["doctor", "--origin", "https://a.example$(id)"],
      message:
        '"https://a.example$(id)" is not an origin: no browser loads a page from this host. A host is an address, or a name of letters, digits, "-" and "_" in parts joined by single dots. Name the origin of the page that uploads, such as https://app.example.com.',
    },
    {
      name: "an unknown option",
      argv: ["doctor", "--origin", ORIGIN, "--force"],
      message: 'Unknown option "--force". The options are listed below.',
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
      name: "a jurisdiction given twice",
      argv: ["setup", "--origin", ORIGIN, "--jurisdiction", "eu", "--jurisdiction=fedramp"],
      message: "--jurisdiction is given twice. A bucket has one jurisdiction: give it once.",
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
    expect(result.stderr).toContain("Usage: npx cloudrop <doctor|setup> --origin <origin> [options]");
  });

  // The server's trustedOrigins takes these (M11-R41), and the command reads an origin with the server's own rule.
  it.each(["capacitor://localhost", "tauri://localhost", "chrome-extension://abcdefghijklmnopabcdefghijklmnop"])(
    "takes %s, an app's own scheme, as an origin",
    async (origin) => {
      const result = await run(["setup", "--origin", origin], { env: {} });
      expect([result.code, result.stderr, result.lines[0]]).toEqual([
        0,
        "",
        `cloudrop setup: the bucket rules for ${origin}.`,
      ]);
    },
  );

  it("prints the usage on stdout and exits 0 for --help", async () => {
    const result = await run(["--help"]);
    expect([result.code, result.stderr, result.lines[0]]).toEqual([
      0,
      "",
      "Usage: npx cloudrop <doctor|setup> --origin <origin> [options]",
    ]);
  });

  it.each([
    { name: "after the command's options", argv: ["doctor", "--origin", ORIGIN, "-h"] },
    { name: "with no command", argv: ["-h"] },
    { name: "after a flag", argv: ["setup", "--apply", "--help"] },
  ])("prints the usage for a help option $name", async ({ argv }) => {
    const result = await run(argv);
    expect([result.code, result.stderr, result.lines[0]]).toEqual([
      0,
      "",
      "Usage: npx cloudrop <doctor|setup> --origin <origin> [options]",
    ]);
  });

  // An option's value is a value: a file may be named -h, and what follows --origin is read as an origin.
  it.each([
    {
      name: "--env-file -h",
      argv: ["doctor", "--origin", ORIGIN, "--env-file", "-h"],
      stderr: "Cannot read the --env-file (ENOENT). Check its path.\n",
    },
    {
      name: "--env-file=--help",
      argv: ["doctor", "--origin", ORIGIN, "--env-file=--help"],
      stderr: "Cannot read the --env-file (ENOENT). Check its path.\n",
    },
    {
      name: "--origin --help",
      argv: ["doctor", "--origin", "--help"],
      stderr:
        '"--help" is not an origin. Write it in lowercase as scheme://host[:port] with no path, such as https://app.example.com.\n\n',
    },
  ])("reads $name as the option's value, not as a call for help", async ({ argv, stderr }) => {
    const result = await run(argv);
    expect([result.code, result.stdout, result.stderr.slice(0, stderr.length)]).toEqual([2, "", stderr]);
  });

  it.each(["--version", "-v"])("prints the package's version and exits 0 for %s", async (flag) => {
    const result = await run([flag]);
    expect([result.code, result.stderr, result.stdout]).toEqual([0, "", "1.2.3\n"]);
  });

  // The path is not repeated: text typed after --env-file by mistake may be a setting's value (M11-R115).
  it.each([
    { code: "ENOENT", message: "Cannot read the --env-file (ENOENT). Check its path.\n" },
    { code: "EISDIR", message: "Cannot read the --env-file (EISDIR). Name a file, not a directory.\n" },
    { code: "EACCES", message: "Cannot read the --env-file (EACCES). Check that you may read it.\n" },
  ])("reports an --env-file it cannot read ($code) by its error code, with exit code 2", async ({ code, message }) => {
    const result = await run(["doctor", "--origin", ORIGIN, "--env-file", ENV.CLOUDROP_SECRET], {
      files: { [ENV.CLOUDROP_SECRET]: { error: code } },
    });
    expect([result.code, result.stderr]).toEqual([2, message]);
  });

  it("says which --env-file it cannot read when there are several", async () => {
    const result = await run(["doctor", "--origin", ORIGIN, "--env-file", ".env", "--env-file", ".env.local"], {
      files: { ".env": "" },
    });
    expect([result.code, result.stderr]).toEqual([2, "Cannot read --env-file number 2 (ENOENT). Check its path.\n"]);
  });

  // Each of these may hold a secret typed in the wrong place; `run` fails when a value of `env` reaches the output.
  it.each([
    {
      name: "a setting given as an argument",
      argv: ["doctor", "--origin", ORIGIN, `CLOUDROP_SECRET=${ENV.CLOUDROP_SECRET}`],
      message:
        'CLOUDROP_SECRET is given as an argument. The command reads settings from the environment or an --env-file, never from its arguments; what follows "=" is not repeated here.',
    },
    {
      name: "an argument that is no option",
      argv: ["doctor", "--origin", ORIGIN, "hunter2"],
      message:
        "Argument 4 is not an option. It is not repeated here, in case it is a setting's value. The options are listed below.",
    },
    {
      name: "a name=value that is no setting",
      argv: ["doctor", "hunter2=hunter2", "--origin", ORIGIN],
      message:
        "Argument 2 is not an option. It is not repeated here, in case it is a setting's value. The options are listed below.",
    },
    {
      name: "an unknown option with a value",
      argv: ["doctor", "--origin", ORIGIN, "--password=hunter2"],
      message: 'Unknown option "--password". The options are listed below.',
    },
    {
      name: "a first argument that is no command's name",
      argv: ["hunter2"],
      message: "The first argument is not a command. Use doctor or setup.",
    },
    {
      name: "an option before the command",
      argv: ["--origin", ORIGIN, "doctor"],
      message: "Name the command first, doctor or setup, then its options.",
    },
    {
      name: "an origin with a user name and password",
      argv: ["doctor", "--origin", "https://AKIDexample:hunter2@app.example.com"],
      message:
        "An origin holds no user name or password, so this one is not repeated here. Use https://app.example.com: an origin is the scheme, host and port, with no path.",
    },
    {
      name: "an origin with a password that is no URL",
      argv: ["doctor", "--origin", "//deploy:hunter2@app.example.com"],
      message:
        "An origin holds no user name or password, so this one is not repeated here. Write it in lowercase as scheme://host[:port] with no path, such as https://app.example.com.",
    },
  ])("does not repeat $name", async ({ argv, message }) => {
    const result = await run(argv, { env: { ...ENV, DB_PASSWORD: "hunter2" } });
    expect([result.code, result.stdout, result.stderr.split("\n")[0]]).toEqual([2, "", message]);
  });

  // Only R2 has jurisdictions: on S3 settings the option changed nothing and said nothing.
  it("refuses --jurisdiction for S3 settings, naming the variables that make them S3", async () => {
    const result = await run(["doctor", "--origin", ORIGIN, "--jurisdiction", "eu"], {
      env: { CLOUDROP_S3_BUCKET: "acme-s3-uploads", CLOUDROP_S3_REGION: "us-east-1" },
    });
    expect([result.code, result.stdout, result.stderr]).toEqual([
      2,
      "",
      "--jurisdiction is for an R2 bucket, and the settings found are for S3 (CLOUDROP_S3_REGION and CLOUDROP_S3_BUCKET). Leave it out.\n",
    ]);
  });

  it("accepts --name=value", async () => {
    const result = await run(["setup", `--origin=${ORIGIN}`, "--env-file=.env", "--jurisdiction=eu"], {
      files: { ".env": "" },
    });
    expect([result.code, result.lines[0]]).toEqual([0, `cloudrop setup: the bucket rules for ${ORIGIN}.`]);
    expect(result.lines).toContain("  npx wrangler r2 bucket cors list acme-uploads-7f3 --jurisdiction eu");
  });
});
