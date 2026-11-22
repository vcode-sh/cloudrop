// The freeze guard (M12-P6): api-extractor reads each entry's built .d.ts and writes its public API to
// packages/cloudrop/etc/<entry>.api.md, a reviewed file under git. `bun run api:report` rewrites the reports after an
// intended change; `bun run api:check` (CI's api-report job) fails when the build's API differs from them, so no export,
// signature or type changes without a reviewed diff. Run after `bun run build`. api-extractor reads one entry per run,
// so this loops over the package's exports, writes each report to a scratch folder (api-extractor.json) and compares
// it with etc/ itself. api-extractor bundles its own TypeScript 6 compiler, which reads the .d.ts only (M12-P3).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as ApiExtractor from "@microsoft/api-extractor";

const PACKAGE = fileURLToPath(new URL("../packages/cloudrop/", import.meta.url));
const PACKAGE_JSON = join(PACKAGE, "package.json");
const CONFIG = fileURLToPath(new URL("../api-extractor.json", import.meta.url));
const REPORTS = join(PACKAGE, "etc");
const SCRATCH = join(PACKAGE, "node_modules/.api-extractor/reports");
// api-extractor is a dev dependency of the package, not of the repository root this script sits in.
const { Extractor, ExtractorConfig } = createRequire(PACKAGE_JSON)("@microsoft/api-extractor") as typeof ApiExtractor;
// A warning about a type no entry exports names the line of a built chunk, such as dist/store-DylAfRVk.d.ts:292:3,
// whose hash and line change with any edit to that chunk, a doc comment included. The report keeps the warning
// without the place, so only a change to the API itself makes a difference.
const CHUNK_PLACE = /^\/\/ dist\/\S+ - /gm;

const check = process.argv.includes("--check");
const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { exports: Record<string, { types: string }> };

/** `.` is cloudrop.api.md, `./adapters/sql` cloudrop-adapters-sql.api.md. */
function reportName(entry: string): string {
  return entry === "." ? "cloudrop" : `cloudrop-${entry.slice(2).replaceAll("/", "-")}`;
}

/** The entry's report as api-extractor writes it, without the chunk places; null when api-extractor failed. */
function extract(entry: string, types: string): string | null {
  const configObject = ExtractorConfig.loadFile(CONFIG);
  configObject.mainEntryPointFilePath = `<projectFolder>/${types.slice(2)}`;
  configObject.apiReport = { ...configObject.apiReport, enabled: true, reportFileName: reportName(entry) };
  const config = ExtractorConfig.prepare({
    configObject,
    configObjectFullPath: CONFIG,
    packageJsonFullPath: PACKAGE_JSON,
  });
  if (!existsSync(config.mainEntryPointFilePath)) {
    console.error(`No ${types} in packages/cloudrop. Run bun run build first.`);
    process.exit(1);
  }
  const written = join(SCRATCH, `${reportName(entry)}.api.md`);
  rmSync(written, { force: true });
  const result = Extractor.invoke(config, {
    localBuild: true,
    // The report is compared below, against etc/, so api-extractor's notes about its scratch copy are noise.
    messageCallback: (message) => {
      if (message.messageId.startsWith("console-api-report") || message.messageId === "console-preamble") {
        message.handled = true;
      }
    },
  });
  return result.succeeded ? readFileSync(written, "utf8").replace(CHUNK_PLACE, "// ") : null;
}

mkdirSync(SCRATCH, { recursive: true });
mkdirSync(REPORTS, { recursive: true });
const failed: string[] = [];
const changed: string[] = [];
for (const [entry, { types }] of Object.entries(manifest.exports)) {
  const report = extract(entry, types);
  const file = join(REPORTS, `${reportName(entry)}.api.md`);
  if (report === null) failed.push(entry);
  else if (!existsSync(file) || readFileSync(file, "utf8") !== report) {
    changed.push(`etc/${reportName(entry)}.api.md`);
    if (!check) writeFileSync(file, report);
  }
}
if (failed.length > 0) {
  console.error(`api-extractor could not read ${failed.join(", ")}. The errors above say why.`);
  process.exit(1);
}
if (check && changed.length > 0) {
  console.error(
    `The public API differs from its reviewed report in ${changed.join(", ")}.\n` +
      "If the change is intended, run bun run api:report, review the diff in packages/cloudrop/etc/, and commit it " +
      "with the decision entry and the changelog line it needs.",
  );
  process.exit(1);
}
const entries = Object.keys(manifest.exports).length;
console.log(
  check
    ? `The public API of all ${entries} entries matches its reviewed report in packages/cloudrop/etc/.`
    : `Rewrote ${changed.length} of ${entries} reports in packages/cloudrop/etc/. Review the diff before committing it.`,
);
