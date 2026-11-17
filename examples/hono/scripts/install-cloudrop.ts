// Installs the built cloudrop package into this example as a copy: `bun scripts/install-cloudrop.ts`, run by the
// scripts in package.json that load cloudrop. An app that installs cloudrop from npm needs nothing like this.
//
// Why: in this repository `bun install` links the example to packages/cloudrop, and a linked package resolves its own
// imports from its own folder, where the package's tests installed drizzle-orm 0.45. The example runs drizzle-orm
// 1.0.0-rc.5, as app-a does, and drizzle-kit 1.0 cannot read tables built by 0.45 ("Cannot read properties of
// undefined (reading 'getColumnCasing')"). A copy resolves `drizzle-orm` from the example's node_modules, like an
// installed package resolves its peer dependency from the app, so app and adapter share one drizzle-orm.
import { cpSync, existsSync, lstatSync, rmSync, unlinkSync } from "node:fs";

const built = new URL("../../../packages/cloudrop/", import.meta.url);
const installed = new URL("../node_modules/cloudrop", import.meta.url);

if (!existsSync(new URL("dist/index.js", built))) {
  console.error("cloudrop is not built. Run `bun run build` at the repository root, then run this again.");
  process.exit(1);
}
// Removes bun's link itself, never the package it points at.
if (lstatSync(installed, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(installed);
else rmSync(installed, { recursive: true, force: true });
// What the package publishes: its package.json and `files` (dist).
cpSync(new URL("package.json", built), new URL(`${installed.href}/package.json`));
cpSync(new URL("dist", built), new URL(`${installed.href}/dist`), { recursive: true });
