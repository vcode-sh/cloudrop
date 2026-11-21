// Copies the user guides into packages/cloudrop/docs, so the published package carries its own documentation: readable
// offline and by tools that look in node_modules (run by the package's `build`). docs/guide/*.md land flat in docs/,
// with an index made from the "Guides" part of docs/README.md. A link between two guides stays relative; any other
// relative link (the decisions, the research, the examples, the repository README) becomes its GitHub URL, since those
// files do not ship. A relative link to a file that does not exist fails the build, so a broken link never ships.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const GUIDES = join(ROOT, "docs/guide");
const OUT = join(ROOT, "packages/cloudrop/docs");
const REPOSITORY = "https://github.com/vcode-sh/cloudrop/blob/main/";
// Inline links only; the guides use no reference-style links. A URL with a scheme or a bare #anchor is left alone.
const LINK = /\]\(([^)\s]+)\)/g;

// testing.md covers cloudrop's own test lanes, for contributors: it stays in the repository, and links to it go there.
const CONTRIBUTOR_ONLY = new Set(["testing.md"]);
const guides = readdirSync(GUIDES).filter((name) => name.endsWith(".md") && !CONTRIBUTOR_ONLY.has(name));
const shipped = new Set(guides.map((name) => join(GUIDES, name)));
const broken: string[] = [];

/** `text` with each relative link, as written in `source`, pointed at where it resolves once shipped flat in docs/. */
function rewrite(text: string, source: string): string {
  return text.replace(LINK, (whole, target: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return whole;
    const [path = "", anchor] = target.split("#", 2);
    const file = resolve(dirname(source), path);
    if (!existsSync(file)) {
      broken.push(`${relative(ROOT, source)}: ${target}`);
      return whole;
    }
    const suffix = anchor === undefined ? "" : `#${anchor}`;
    const local = shipped.has(file) ? file.slice(GUIDES.length + 1) : `${REPOSITORY}${relative(ROOT, file)}`;
    return `](${local}${suffix})`;
  });
}

/** The index: docs/README.md from its "## Guides" heading up to the next "## " heading that is not about the guides. */
function index(): string {
  const source = join(ROOT, "docs/README.md");
  const text = readFileSync(source, "utf8");
  const start = text.indexOf("## Guides");
  if (start === -1) throw new Error('docs/README.md has no "## Guides" section to build the package index from.');
  const end = text.indexOf("\n## ", start + 1);
  const guidesPart = text.slice(start, end === -1 ? undefined : end).trimEnd();
  const intro = `# cloudrop documentation

The guides for this version of cloudrop, as published. The project's history (decisions, research, plans) is in the
repository: ${REPOSITORY}docs/README.md.

`;
  // Resolved from docs/README.md, where it was written: "guide/server.md" is a shipped guide and becomes "server.md".
  return rewrite(`${intro}${guidesPart}\n`, source);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const name of guides) {
  const source = join(GUIDES, name);
  writeFileSync(join(OUT, name), rewrite(readFileSync(source, "utf8"), source));
}
writeFileSync(join(OUT, "README.md"), index());
if (broken.length > 0) {
  rmSync(OUT, { recursive: true, force: true });
  console.error(`Broken relative links in the guides, so no docs were packaged:\n  ${broken.join("\n  ")}`);
  process.exit(1);
}
console.log(`Packaged ${guides.length} guides and an index into packages/cloudrop/docs.`);
