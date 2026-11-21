import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function runBin(runtime: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      runtime,
      ["src/cli.ts", "doctor", "--origin", "https://app.example.com", "--env-file", "fixtures/cli/short-secret.env"],
      // Only PATH: no CLOUDROP_* setting of the developer's shell may reach the command.
      { cwd: packageRoot, env: { PATH: process.env.PATH } },
      (error, stdout) => resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout }),
    );
  });
}

// Each run starts a runtime (about 100 ms): the only test of the bin's own wiring of argv, env, files and exit code.
describe("the cloudrop bin", () => {
  it.each(["node", "bun"])(
    "runs under %s, reads --env-file through the real file system and sets the exit code",
    async (runtime) => {
      const { code, stdout } = await runBin(runtime);
      expect(code).toBe(1);
      expect(stdout).toContain(
        "PROBLEM      CLOUDROP_SECRET has fewer than 32 characters. Generate one with `openssl rand -base64 32`.",
      );
    },
  );
});
