import { describe, expect, it } from "vitest";
import { bucket, ENV, ORIGIN, run } from "./command-fixture.ts";

const lines = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");

const doctor = (...extra: string[]) => ["doctor", "--origin", ORIGIN, ...extra];

describe("the variables the command reads", () => {
  // Measured: `node --env-file=a --env-file=b` sets what both files hold, and b's value where both name a variable.
  it("reads every --env-file, a later file's value replacing an earlier one's, as Node does", async () => {
    const files = {
      ".env": lines({ ...ENV, CLOUDROP_R2_BUCKET: "another-bucket-name" }),
      ".env.local": lines({ CLOUDROP_R2_BUCKET: ENV.CLOUDROP_R2_BUCKET }),
    };
    const fetch = bucket().fetch;
    const [localLast, localFirst] = [
      await run(doctor("--env-file", ".env", "--env-file=.env.local"), { env: {}, files, fetch }),
      await run(doctor("--env-file", ".env.local", "--env-file", ".env"), { env: {}, files, fetch }),
    ];
    expect([localLast.code, localLast.lines[3]]).toEqual([
      0,
      "ok           The bucket answers, and these credentials may list it.",
    ]);
    expect([localFirst.code, localFirst.lines[3]]).toEqual([
      1,
      "PROBLEM      Bucket: The bucket does not exist. Check the bucket name in your configuration.",
    ]);
  });

  // Measured: `A= node --env-file=file` leaves A empty, and the library reads an empty variable as not set.
  it("reads a variable the environment sets to nothing as not set, whatever the file gives it", async () => {
    const result = await run(doctor("--env-file", ".env"), {
      env: { ...ENV, CLOUDROP_SECRET: "" },
      files: { ".env": lines({ CLOUDROP_SECRET: "file-secret-0123456789-0123456789-0123456789" }) },
      fetch: bucket().fetch,
    });
    expect(result.code).toBe(1);
    expect(result.lines).toContain(
      "note         CLOUDROP_SECRET is set to nothing in the environment, which wins over its value in .env, as with Node's --env-file. Unset it there to use the file's value.",
    );
    expect(result.lines).toContain(
      "PROBLEM      CLOUDROP_SECRET is not set. Generate one with `openssl rand -base64 32` and set it, unless your code passes secret to createCloudrop().",
    );
  });

  it("names the file a value came from when the environment sets the variable too", async () => {
    const result = await run(doctor("--env-file", ".env", "--env-file", ".env.local"), {
      files: { ".env": "CLOUDROP_R2_BUCKET=first-bucket-name", ".env.local": "CLOUDROP_R2_BUCKET=second-bucket-name" },
      fetch: bucket().fetch,
    });
    expect(result.lines[1]).toBe(
      "note         CLOUDROP_R2_BUCKET is set in the environment and in .env.local; the environment's value is used.",
    );
  });

  // Every object has these, so a lookup that is not for an own property finds something there.
  it.each(["__proto__", "constructor", "toString"])(
    "reads a setting from a variable named %s as not set when nothing sets it",
    async (name) => {
      const result = await run(doctor("--var", `CLOUDROP_SECRET=${name}`, "--env-file", ".env"), {
        env: { ...ENV, CLOUDROP_SECRET: undefined },
        files: { ".env": "" },
        fetch: bucket().fetch,
      });
      expect(result.lines.filter((line) => line.includes(name))).toEqual([
        `PROBLEM      ${name} is not set. Generate one with \`openssl rand -base64 32\` and set it, unless your code passes secret to createCloudrop().`,
      ]);
    },
  );

  it("says that Node does not set the first variable of a file that starts with a byte order mark", async () => {
    const { CLOUDROP_R2_BUCKET, ...rest } = ENV;
    const result = await run(doctor("--env-file", ".env"), {
      env: rest,
      files: { ".env": `﻿CLOUDROP_R2_BUCKET=${CLOUDROP_R2_BUCKET}\n` },
    });
    expect(result.lines.slice(1, 3)).toEqual([
      "note         .env starts with a byte order mark, so Node's --env-file does not set CLOUDROP_R2_BUCKET, its first variable. Save the file as UTF-8 without a byte order mark.",
      "PROBLEM      CLOUDROP_R2_BUCKET is not set. Set it to the bucket's name.",
    ]);
  });
});
