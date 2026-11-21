#!/usr/bin/env node
// The `cloudrop` bin (Node 24+ and Bun). No library entry imports it. The library compiles without Node's types, so the
// few members of `process` used here are described by hand, as src/node.ts describes Node's request and response;
// cli.test.ts runs this file under Node and Bun. Files are read through process.getBuiltinModule, which both provide
// (M9-C9).

import manifest from "../package.json" with { type: "json" };
import { runCommand } from "./cli/run.ts";

interface NodeProcess {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  exitCode?: number;
  getBuiltinModule(id: "node:fs"): { readFileSync(path: string, encoding: "utf8"): string };
}

const nodeProcess = (globalThis as unknown as { process: NodeProcess }).process;

nodeProcess.exitCode = await runCommand({
  argv: nodeProcess.argv.slice(2),
  env: nodeProcess.env,
  version: manifest.version,
  readFile: (path) => nodeProcess.getBuiltinModule("node:fs").readFileSync(path, "utf8"),
  fetch: (input, init) => globalThis.fetch(input, init),
  stdout: nodeProcess.stdout,
  stderr: nodeProcess.stderr,
});
