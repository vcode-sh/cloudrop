import { describe, expect, it } from "vitest";
import { shellWords, withoutCommands } from "./printed-commands.ts";

// Contract: M11-R208. The fixture's check of printed Wrangler and AWS CLI commands goes red for a command a person
// could not run as printed. Oracle: the tools' own argument lists (`wrangler r2 bucket … --help`, `aws s3api`).
const named = { buckets: ["acme-uploads"], endpoints: ["https://s3.example.com"] };
const AWS = "aws s3api put-bucket-cors --bucket acme-uploads --cors-configuration file://cors-s3.json";

describe("the words a shell reads from a printed command", () => {
  it.each([
    {
      name: "plain words",
      text: "cors set acme --file cors.json",
      words: ["cors", "set", "acme", "--file", "cors.json"],
    },
    { name: "a quoted word with a space", text: "cors list 'my bucket'", words: ["cors", "list", "my bucket"] },
    { name: "a quote inside a quoted word", text: "list 'it'\\''s'", words: ["list", "it's"] },
    { name: "a placeholder", text: "cors list <bucket>", words: ["cors", "list", "<bucket>"] },
    { name: "a command substitution", text: "cors list $(id)", words: null },
    { name: "a redirect", text: "cors list acme > out", words: null },
    { name: "a second command", text: "cors list acme; id", words: null },
    { name: "a quote left open", text: "cors list 'acme", words: null },
    { name: "a double quote", text: 'cors list "acme"', words: null },
  ])("$name", ({ text, words }) => {
    expect(shellWords(text)).toEqual(words);
  });
});

describe("the printed commands a run may hold", () => {
  it("takes each call the command suggests out of the output, and leaves a heading that names a call", () => {
    const output = [
      "Save it as cors-s3.json for aws s3api put-bucket-cors:",
      "  npx wrangler r2 bucket cors list acme-uploads",
      "  bunx wrangler r2 bucket cors set acme-uploads --file cors.json",
      "By hand: pnpm exec wrangler r2 bucket lifecycle list <bucket>",
      "  npx wrangler r2 bucket lifecycle add acme-uploads cloudrop-abort-incomplete --abort-multipart-days 1",
      "  aws s3api get-bucket-cors --bucket acme-uploads --endpoint-url https://s3.example.com",
      `  ${AWS} --endpoint-url <endpoint>`,
      "  aws s3api get-bucket-lifecycle-configuration --bucket <bucket> --endpoint-url <endpoint>",
      "  aws s3api put-bucket-lifecycle-configuration --bucket acme-uploads --lifecycle-configuration file://lifecycle.json --endpoint-url https://s3.example.com",
    ].join("\n");
    expect(withoutCommands(output, named)).toBe(
      "Save it as cors-s3.json for aws s3api put-bucket-cors:\n  \n  \nBy hand: \n  \n  \n  \n  \n  ",
    );
  });

  it("asks every Wrangler command for the run's jurisdiction, and no AWS CLI command", () => {
    const eu = { ...named, jurisdiction: "eu" };
    expect(withoutCommands("npx wrangler r2 bucket cors list acme-uploads --jurisdiction eu", eu)).toBe("");
    expect(withoutCommands(`${AWS} --endpoint-url https://s3.example.com`, eu)).toBe("");
  });

  it.each([
    { name: "a flag the tool does not have", line: "npx wrangler r2 bucket cors set acme-uploads --path cors.json" },
    { name: "another file", line: "npx wrangler r2 bucket cors set acme-uploads --file cors-s3.json" },
    { name: "another subcommand", line: "npx wrangler r2 bucket cors put acme-uploads --file cors.json" },
    { name: "another bucket", line: "npx wrangler r2 bucket cors list other-bucket" },
    { name: "no bucket", line: "npx wrangler r2 bucket cors list" },
    { name: "a word after the command", line: "npx wrangler r2 bucket cors list acme-uploads s3cr3t" },
    {
      name: "a jurisdiction the run did not name",
      line: "npx wrangler r2 bucket cors list acme-uploads --jurisdiction eu",
    },
    {
      name: "another rule name",
      line: "npx wrangler r2 bucket lifecycle add acme-uploads abort --abort-multipart-days 1",
    },
    { name: "a bucket a shell would expand", line: "npx wrangler r2 bucket cors list $(id)" },
    { name: "no endpoint", line: AWS },
    { name: "another endpoint", line: `${AWS} --endpoint-url https://other.example.com` },
    {
      name: "a call the command never suggests",
      line: "aws s3api delete-bucket --bucket acme-uploads --endpoint-url <endpoint>",
    },
  ])("refuses $name", ({ line }) => {
    expect(() => withoutCommands(`  ${line}`, named)).toThrow("command that would not run");
  });

  it("refuses a Wrangler command without the jurisdiction the run named", () => {
    const eu = { ...named, jurisdiction: "eu" };
    expect(() => withoutCommands("npx wrangler r2 bucket cors list acme-uploads", eu)).toThrow("would not run");
  });
});
