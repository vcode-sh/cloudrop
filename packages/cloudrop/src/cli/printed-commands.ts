// Reads back the Wrangler and AWS CLI commands the cloudrop command printed, for command-fixture.ts. Each must be plain
// POSIX shell words and, word for word, one of the calls below on this run's bucket, endpoint and jurisdiction. The
// calls are the tools' own, read from `wrangler r2 bucket … --help` (Wrangler 4.166) and accepted by `aws s3api`
// (aws-cli 2.39) on 2026-11-21, and written here apart from instructions.ts and doctor.ts: a wrong flag, file or
// bucket there fails every test that prints the command (M11-R208). Never shipped.

/** What the commands of one run may name. */
export interface Named {
  /** The values of the run's bucket settings. */
  buckets: readonly string[];
  /** The values of the run's S3 endpoint settings. */
  endpoints: readonly string[];
  /** The run's --jurisdiction, which every Wrangler command then carries. */
  jurisdiction?: string;
}

/** After `wrangler r2 bucket`. */
const WRANGLER_CALLS = [
  "cors list <bucket>",
  "cors set <bucket> --file cors.json",
  "lifecycle list <bucket>",
  "lifecycle add <bucket> cloudrop-abort-incomplete --abort-multipart-days 1",
];

/** After `aws s3api`. */
const AWS_CALLS = [
  "get-bucket-cors --bucket <bucket> --endpoint-url <endpoint>",
  "put-bucket-cors --bucket <bucket> --cors-configuration file://cors-s3.json --endpoint-url <endpoint>",
  "get-bucket-lifecycle-configuration --bucket <bucket> --endpoint-url <endpoint>",
  "put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://lifecycle.json --endpoint-url <endpoint>",
];

// A word is plain text, text in single quotes and \' in any order, as commands.ts quotes one. The two placeholders
// stand as words although a shell would not take them: the reader replaces them.
const WORD = /(?:[A-Za-z0-9_@%+=:,./-]+|'[^']*'|\\')+|<bucket>|<endpoint>/y;

/**
 * The words a POSIX shell reads from `text`, quotes removed, or null when `text` holds anything a shell does not read
 * as itself: a `$`, a backtick, a redirect, a `;`, a double quote, a quote left open, or two spaces in a row.
 */
export function shellWords(text: string): string[] | null {
  const words: string[] = [];
  let at = 0;
  while (at < text.length) {
    WORD.lastIndex = at;
    const word = WORD.exec(text)?.[0];
    if (word === undefined) return null;
    // A quoted stretch gives its inside; the only other match is \', which gives the quote.
    words.push(word.replace(/'([^']*)'|\\'/g, (_, inside?: string) => inside ?? "'"));
    at += word.length;
    if (at < text.length && text[at++] !== " ") return null;
  }
  return words;
}

function isCall(words: readonly string[], call: string, { buckets, endpoints }: Named): boolean {
  const wanted = call.split(" ");
  return (
    words.length === wanted.length &&
    wanted.every((want, index) => {
      const word = words[index] as string;
      if (want === "<bucket>") return word === want || buckets.includes(word);
      return want === "<endpoint>" ? word === want || endpoints.includes(word) : word === want;
    })
  );
}

// A Wrangler command starts with the runner; the AWS CLI's is `aws` itself. A heading that only names the call a file
// is for ("… for aws s3api put-bucket-cors:") is no command.
const PRINTED = /\b(?:(?:npx|bunx|pnpm exec) (wrangler r2 bucket)|aws s3api) (?![a-z-]+:$)(.*)$/gm;

/**
 * `output` without the Wrangler and AWS CLI commands it holds, each checked first. Throws for a command that is not
 * shell words, is none of the calls, or names another bucket, endpoint or jurisdiction than `named`.
 */
export function withoutCommands(output: string, named: Named): string {
  return output.replace(PRINTED, (line: string, wrangler: string | undefined, rest: string) => {
    const words = shellWords(rest);
    const tail = wrangler && named.jurisdiction ? ["--jurisdiction", named.jurisdiction] : [];
    const call = words?.slice(0, words.length - tail.length) ?? [];
    const ends = words?.slice(call.length).join(" ") === tail.join(" ");
    if (!ends || !(wrangler ? WRANGLER_CALLS : AWS_CALLS).some((each) => isCall(call, each, named))) {
      throw new Error(`The command printed a ${wrangler ? "Wrangler" : "AWS CLI"} command that would not run: ${line}`);
    }
    return "";
  });
}
