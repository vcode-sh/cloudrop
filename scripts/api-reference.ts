// Builds the API reference with TypeDoc from the built .d.ts into docs/reference/ (git-ignored; CI keeps it as an
// artifact): `bun run docs:reference`, after `bun run build`. Run by Node, not Bun, for module.registerHooks.
// TypeDoc 0.28 reads types with the JavaScript compiler of TypeScript 6 at most, and TypeScript 7, the workspace's and
// the floor of the shipped types (M12-P3), has no such API. The package installs TypeScript 6 under the alias
// `typescript-6`, and the hook below hands it to TypeDoc's `import "typescript"`; nothing else in this process loads
// TypeScript, and the workspace's TypeScript stays 7.
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The part of TypeDoc's API used here, described by hand: the scripts compile without TypeDoc's types.
interface Reflection {
  name: string;
  children?: Reflection[];
}
interface TypeDoc {
  Application: {
    bootstrapWithPlugins(options: { options: string }): Promise<{
      logger: { hasErrors(): boolean; hasWarnings(): boolean };
      convert(): Promise<Reflection | undefined>;
      validate(project: Reflection): void;
      generateOutputs(project: Reflection): Promise<void>;
    }>;
  };
}

const fromPackage = createRequire(fileURLToPath(new URL("../packages/cloudrop/package.json", import.meta.url)));
// A path, not a file URL: TypeDoc loads TypeScript through require() as well as import, and require() takes no URL.
const TYPESCRIPT_6 = fromPackage.resolve("typescript-6");
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(specifier === "typescript" ? TYPESCRIPT_6 : specifier, context),
});

const { Application } = (await import(pathToFileURL(fromPackage.resolve("typedoc")).href)) as TypeDoc;
const app = await Application.bootstrapWithPlugins({
  options: fileURLToPath(new URL("../typedoc.json", import.meta.url)),
});
const project = await app.convert();
if (project === undefined || app.logger.hasErrors()) process.exit(1);
// TypeDoc names each entry after its file, `index` and `adapters/sql`; an app imports `cloudrop` and
// `cloudrop/adapters/sql`. The built .d.ts keep no module comment to name them by, since the build rewrites the imports
// such a comment would sit on.
for (const entry of project.children ?? []) entry.name = entry.name === "index" ? "cloudrop" : `cloudrop/${entry.name}`;
app.validate(project);
if (app.logger.hasErrors() || app.logger.hasWarnings()) {
  console.error("TypeDoc warned about the reference; the lines above say where. Fix the doc comment they name.");
  process.exit(1);
}
await app.generateOutputs(project);
if (app.logger.hasErrors()) process.exit(1);
