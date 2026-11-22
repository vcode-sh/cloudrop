// Copies the user guides into packages/cloudrop/docs, so the published package carries its own documentation: readable
// offline and by tools that look in node_modules (run by the package's `build`). docs/guide/*.md land flat in docs/,
// with an index made from the "Guides" part of docs/README.md. A link between two guides stays relative; any other
// relative link (the decisions, the research, the examples, the repository README) becomes its GitHub URL, since those
// files do not ship. A relative link to a file that does not exist fails the build, so a broken link never ships.
// It also writes llms.txt and llms-full.txt at the package root (scripts/llms.ts), from the same guides in the
// index's reading order.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { type LlmsGuide, llmsFull, llmsTxt } from "./llms.ts";

const ROOT = resolve(import.meta.dirname, "..");
const GUIDES = join(ROOT, "docs/guide");
const PACKAGE = join(ROOT, "packages/cloudrop");
const OUT = join(PACKAGE, "docs");
const REPOSITORY = "https://github.com/vcode-sh/cloudrop/blob/main/";
// Inline links only; the guides use no reference-style links. A URL with a scheme or a bare #anchor is left alone.
const LINK = /\]\(([^)\s]+)\)/g;

// testing.md covers cloudrop's own test lanes, for contributors: it stays in the repository, and links to it go there.
const CONTRIBUTOR_ONLY = new Set(["testing.md"]);
const guides = readdirSync(GUIDES).filter((name) => name.endsWith(".md") && !CONTRIBUTOR_ONLY.has(name));
const shipped = new Set(guides.map((name) => join(GUIDES, name)));
const broken: string[] = [];

/**
 * `text` with each relative link, as written in `source`, pointed at where it resolves once shipped flat in docs/:
 * a guide's link to another guide is `base` and its name, `base` being where the text lands relative to docs/.
 */
function rewrite(text: string, source: string, base = ""): string {
  return text.replace(LINK, (whole, target: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return whole;
    const [path = "", anchor] = target.split("#", 2);
    const file = resolve(dirname(source), path);
    if (!existsSync(file)) {
      broken.push(`${relative(ROOT, source)}: ${target}`);
      return whole;
    }
    const suffix = anchor === undefined ? "" : `#${anchor}`;
    const local = shipped.has(file)
      ? `${base}${file.slice(GUIDES.length + 1)}`
      : `${REPOSITORY}${relative(ROOT, file)}`;
    return `](${local}${suffix})`;
  });
}

const README = join(ROOT, "docs/README.md");

/** A "## " section of docs/README.md, from its heading up to the next one. */
function readmeSection(heading: string): string {
  const text = readFileSync(README, "utf8");
  const start = text.indexOf(`## ${heading}\n`);
  if (start === -1) throw new Error(`docs/README.md has no "## ${heading}" section to build the package docs from.`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end).trimEnd();
}

/** The index: docs/README.md's "## Guides" section. */
function index(): string {
  const guidesPart = readmeSection("Guides");
  const intro = `# cloudrop documentation

The guides for this version of cloudrop, as published. The project's history (decisions, research, plans) is in the
repository: ${REPOSITORY}docs/README.md.

`;
  // Resolved from docs/README.md, where it was written: "guide/server.md" is a shipped guide and becomes "server.md".
  return rewrite(`${intro}${guidesPart}\n`, README);
}

/**
 * The shipped guides in the index's reading order, each with the text of its index line as its summary, then the
 * guides the index does not link, by name.
 */
function readingOrder(): LlmsGuide[] {
  const lines = readmeSection("Guides").split(/\n(?=\s*(?:\d+\.|-) )/);
  const summaries = new Map<string, string>();
  for (const line of lines) {
    const found = /\]\(guide\/([^)#]+\.md)\):\s*([\s\S]*)/.exec(line);
    // The item's text up to the paragraph after it, such as "When something goes wrong:", on one line.
    const summary = found?.[2]?.split("\n\n", 1)[0]?.replace(/\s+/g, " ").trim();
    if (found?.[1] && summary && !summaries.has(found[1])) summaries.set(found[1], summary);
  }
  const listed = [...summaries.keys()].filter((name) => guides.includes(name));
  const order = [...listed, ...guides.filter((name) => !listed.includes(name)).sort()];
  return order.map((name) => {
    const source = join(GUIDES, name);
    const text = rewrite(readFileSync(source, "utf8"), source, "docs/");
    const title = /^# (.+)$/m.exec(text)?.[1] ?? name;
    const summary = summaries.get(name);
    return { file: `docs/${name}`, title, summary: summary ? rewrite(summary, README, "docs/") : null, text };
  });
}

/** llms.txt and llms-full.txt at the package root, after a check that every file they link is in the package. */
function writeLlms(): void {
  const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
    version: string;
    description: string;
    exports: Record<string, { types: string }>;
  };
  const entries = Object.entries(manifest.exports).map(([path, { types }]) => ({ path, types: types.slice(2) }));
  for (const { types } of entries) {
    if (!existsSync(join(PACKAGE, types))) broken.push(`llms.txt: ${types}, which the build did not write`);
  }
  const examples = rewrite(readmeSection("Examples").replace(/^## Examples\n/, ""), README);
  const input = { ...manifest, guides: readingOrder(), entries, examples };
  writeFileSync(join(PACKAGE, "llms.txt"), llmsTxt(input));
  writeFileSync(join(PACKAGE, "llms-full.txt"), llmsFull(input));
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const name of guides) {
  const source = join(GUIDES, name);
  writeFileSync(join(OUT, name), rewrite(readFileSync(source, "utf8"), source));
}
writeFileSync(join(OUT, "README.md"), index());
writeLlms();
if (broken.length > 0) {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(join(PACKAGE, "llms.txt"), { force: true });
  rmSync(join(PACKAGE, "llms-full.txt"), { force: true });
  console.error(`Broken relative links in the guides, so no docs were packaged:\n  ${broken.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `Packaged ${guides.length} guides and an index into packages/cloudrop/docs, and llms.txt and llms-full.txt.`,
);
