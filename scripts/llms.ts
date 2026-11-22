// llms.txt and llms-full.txt for the package root (https://llmstxt.org), written by scripts/package-docs.ts: an index a
// coding agent reads first, and the same with every shipped guide in full, so an agent with the package installed needs
// no network. Links are relative to the package root: the guides are in docs/, the types in dist/.

/** A shipped guide, in reading order. `text` is its Markdown with links relative to the package root. */
export interface LlmsGuide {
  file: string;
  title: string;
  summary: string | null;
  text: string;
}

export interface LlmsInput {
  version: string;
  description: string;
  guides: readonly LlmsGuide[];
  /** The package's export paths, such as "." and "./adapters/sql", with the .d.ts each one's types are in. */
  entries: readonly { path: string; types: string }[];
  /** The examples, as Markdown list items with absolute links. */
  examples: string;
}

// Spec 1.0 §8: the mistakes an agent makes when it wires cloudrop into an app.
const RULES = `## Rules for coding agents

- Import the server into client code with \`import type\` only: \`createUploadHooks<typeof cloudrop>()\` and
  \`createCloudropClient<typeof cloudrop>()\` need only its type, and a value import pulls the server's code and its
  settings into the browser bundle.
- Mount \`cloudrop.handler\` before any body parser (\`express.json()\`, Fastify's parsers, a framework's own): the
  handler reads the raw body, and a parser that read it first leaves nothing to read.
- Never return a secret from \`authorize\`. Its result is signed into an upload token the browser can read; return
  ids, never tokens, passwords or keys.
- Behind a proxy that terminates TLS or rewrites \`Host\`, set \`trustedOrigins\` to the app's public origin. The
  handler trusts no \`X-Forwarded-*\` header, so without it every browser request is refused with
  \`ORIGIN_NOT_ALLOWED\`.
- \`cloudrop.api.*\`, \`client.upload()\` and the other calls that do work answer \`{ data, error }\` instead of
  throwing: check \`error\`, branch on \`error.code\` (never on the message), and keep a \`default\` branch, since a
  minor release may add codes. Only a wrong setting throws, when the server, its routes, its storage or the client
  are built (\`createCloudrop\`, \`route\`, \`r2\`, \`s3\`, \`createCloudropClient\`).
- With a database store, delete an uploaded file with \`api.deleteFile(id)\`. \`api.deleteObject(key)\` removes the
  object only and leaves the row and the quota as they were.
`;

function header({ version, description }: LlmsInput): string {
  return `# cloudrop

> ${description}

This is cloudrop ${version}. The browser uploads straight to the bucket with URLs the server signs, so the bytes never
pass through the server; \`/complete\` checks the stored object before anything is recorded. The package is ESM only
and has no runtime dependencies. It needs Node.js 26 or newer, Bun, Deno or Cloudflare Workers on the server, and
TypeScript 7.0 or newer for its types. On Deno, run with \`--allow-env\` for \`NODE_ENV\` and \`CLOUDROP_*\`:
cloudrop reads them through \`process.env\`.

${RULES}`;
}

function entryName(path: string): string {
  return path === "." ? "cloudrop" : `cloudrop/${path.slice(2)}`;
}

/** The index: the summary, the agent rules, then links to the guides, the types, the examples and llms-full.txt. */
export function llmsTxt(input: LlmsInput): string {
  const guides = input.guides.map(
    ({ file, title, summary }) => `- [${title}](${file})${summary ? `: ${summary}` : ""}`,
  );
  const entries = input.entries.map(({ path, types }) => `- [${entryName(path)}](${types})`);
  return `${header(input)}
## Guides

${guides.join("\n")}

## API reference

The \`.d.ts\` of each entry, with the doc comments your editor shows. The HTML reference is built from them with
TypeDoc (\`bun run docs:reference\` in the repository).

${entries.join("\n")}

## Examples

${input.examples.trim()}

## Optional

- [Changelog](CHANGELOG.md): every change, and the exact before and after of each breaking one.
- [Everything above in one file](llms-full.txt): this index with every guide in full.
`;
}

/** The summary and the agent rules, then every guide in full, in reading order. */
export function llmsFull(input: LlmsInput): string {
  const guides = input.guides.map(({ file, text }) => `<!-- ${file} -->\n\n${text.trim()}\n`);
  return `${header(input)}\n${guides.join("\n")}`;
}
