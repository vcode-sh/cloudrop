import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../storage/driver.ts";
import { parseArgs } from "./args.ts";
import { ENV, run } from "./command-fixture.ts";

/** The words a POSIX shell makes of `text`: the oracle for "quoted, and runnable as printed". About 2 ms a call. */
function shellWords(text: string): string[] {
  return execFileSync("sh", ["-c", `printf '%s\\0' ${text}`], { encoding: "utf8" })
    .split("\0")
    .slice(0, -1);
}

/** Every cloudrop command in `lines`, as the arguments a shell would hand it. Each ends its line. */
function printedCommands(lines: readonly string[]): string[][] {
  return lines.flatMap((line) => {
    const command = /(?:npx|bunx|pnpm exec) cloudrop (.*)$/.exec(line)?.[1];
    return command === undefined ? [] : [shellWords(command)];
  });
}

const optionsOf = (argv: readonly string[]) => {
  const parsed = parseArgs(argv);
  if (!("options" in parsed)) throw new Error("These arguments are not a run of the command.");
  return parsed.options;
};

// A bucket that answers the listing, has no rules and accepts writes.
const emptyBucket: FetchLike = (input, init) => {
  const setting = /\?(cors|lifecycle)=$/.exec(String(input))?.[1];
  if (init?.method === "PUT") return Promise.resolve(new Response(""));
  if (setting === undefined) {
    return Promise.resolve(new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"));
  }
  const code = setting === "cors" ? "NoSuchCORSConfiguration" : "NoSuchLifecycleConfiguration";
  return Promise.resolve(new Response(`<Error><Code>${code}</Code></Error>`, { status: 404 }));
};

// Arguments a shell would read as more than text: a command substitution, a quote, spaces, a tilde, a leading "=".
const AWKWARD = [
  "--origin",
  "https://a.example$(id)",
  "--origin",
  "http://localhost:5173",
  "--env-file",
  "my env's file.env",
  "--env-file=~/=second.env",
  "--var",
  "CLOUDROP_R2_BUCKET=R2_BUCKET",
  "--jurisdiction",
  "eu",
];
const files = {
  "my env's file.env": `R2_BUCKET=${ENV.CLOUDROP_R2_BUCKET}`,
  "~/=second.env": "",
};
const env = { ...ENV, CLOUDROP_R2_BUCKET: undefined };

describe("the cloudrop commands the output prints", () => {
  it.each([
    { name: "doctor, for the setup that fixes a rule", argv: ["doctor", ...AWKWARD], next: ["setup", "--apply"] },
    { name: "setup, for the --apply that keeps other rules", argv: ["setup", ...AWKWARD], next: ["setup", "--apply"] },
    {
      name: "setup --dry-run --replace, for the write",
      argv: ["setup", ...AWKWARD, "--dry-run", "--replace"],
      next: ["setup", "--apply", "--replace"],
    },
    { name: "setup --apply, for the doctor that checks it", argv: ["setup", ...AWKWARD, "--apply"], next: ["doctor"] },
  ])("read back as the same run after $name", async ({ argv, next }) => {
    const result = await run(argv, { env, files, fetch: emptyBucket });
    const [command = "", ...flags] = next;
    const expected = optionsOf([command, ...AWKWARD, ...flags]);
    const printed = printedCommands(result.lines);
    expect(printed.length).toBeGreaterThan(0);
    expect(printed.map(optionsOf)).toEqual(printed.map(() => expected));
  });

  it.each([
    { agent: "bun/1.4.4 npm/? node/v26.3.0 linux x64", runner: "bunx" },
    { agent: "pnpm/12.16.1 npm/? node/? linux x64", runner: "pnpm exec" },
    { agent: "npm/11.19.1 node/v24.22.2 linux x64 workspaces/false", runner: "npx" },
    { agent: undefined, runner: "npx" },
  ])("start with $runner when the command was started by $agent", async ({ agent, runner }) => {
    const result = await run(["setup", "--origin", "https://app.example.com", "--apply"], {
      env: { ...ENV, npm_config_user_agent: agent },
      fetch: emptyBucket,
    });
    expect(result.lines.at(-1)).toBe(
      `Done. R2 can take up to 30 seconds to apply a change. Check the bucket: ${runner} cloudrop doctor --origin https://app.example.com`,
    );
  });
});

describe("the Wrangler and AWS CLI commands the output prints", () => {
  it("name the bucket and the endpoint by value, each as one word of a shell", async () => {
    const s3 = {
      CLOUDROP_S3_ENDPOINT: "https://storage.example.com/s3;proxy's",
      CLOUDROP_S3_REGION: "us-east-1",
      CLOUDROP_S3_BUCKET: "acme-s3-uploads",
      CLOUDROP_S3_ACCESS_KEY_ID: "AKIDs3fixture",
      CLOUDROP_S3_SECRET_ACCESS_KEY: "s3-secret-fixture-value",
    };
    const result = await run(["setup", "--origin", "https://app.example.com"], { env: s3 });
    const listing = result.lines.find((line) => line.includes("aws s3api get-bucket-cors")) ?? "";
    expect(shellWords(listing)).toEqual([
      "aws",
      "s3api",
      "get-bucket-cors",
      "--bucket",
      "acme-s3-uploads",
      "--endpoint-url",
      "https://storage.example.com/s3;proxy's",
    ]);
  });

  it("keep placeholders, and say so, while the storage settings are not all set", async () => {
    const result = await run(["setup", "--origin", "https://app.example.com"], {
      env: { ...ENV, CLOUDROP_R2_SECRET_ACCESS_KEY: undefined },
    });
    expect(result.lines).toContain("  npx wrangler r2 bucket cors list <bucket>");
    expect(result.lines).toContain(
      "Replace <bucket> with the bucket's name: the command prints it only once the storage settings are all set and valid.",
    );
  });
});
